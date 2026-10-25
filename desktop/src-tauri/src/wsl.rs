//! WSL distribution discovery for terminal capture. No interactive shell startup files.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Identity {
    pub user: String,
    pub host: String,
}

pub fn prompt_identity(title: &str) -> Option<Identity> {
    let (identity, _) = title.trim().split_once(':')?;
    let (user, host) = identity.split_once('@')?;
    if user.is_empty()
        || host.is_empty()
        || identity.chars().any(char::is_whitespace)
        || host.contains('@')
    {
        return None;
    }
    Some(Identity {
        user: user.into(),
        host: host.into(),
    })
}

pub fn launcher_hint(program: &str) -> Option<String> {
    let name = program.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    let name = name.strip_suffix(".exe")?;
    if let Some(version) = name.strip_prefix("ubuntu") {
        if version.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
            return Some(name.into());
        }
    }
    ["debian", "kali", "arch", "opensuse", "fedora", "alpine"]
        .contains(&name)
        .then(|| name.into())
}

pub fn looks_like_title(title: &str) -> bool {
    prompt_identity(title).is_some()
        || [
            "ubuntu", "debian", "kali", "arch", "opensuse", "fedora", "alpine",
        ]
        .iter()
        .any(|prefix| {
            let title = title.to_lowercase();
            title == *prefix
                || title
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with([' ', '-']))
        })
}

fn compact(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Exact installed names win; a family/version shorthand must have one candidate.
pub fn named_distribution(hint: &str, installed: &[String]) -> Option<String> {
    let normalized = compact(hint);
    if normalized.is_empty() {
        return None;
    }
    if let Some(name) = installed
        .iter()
        .find(|name| name.eq_ignore_ascii_case(hint))
    {
        return Some(name.clone());
    }
    let exact: Vec<_> = installed
        .iter()
        .filter(|name| compact(name) == normalized)
        .collect();
    if exact.len() == 1 {
        return Some(exact[0].clone());
    }
    if !exact.is_empty() {
        return None;
    }
    let candidates: Vec<_> = installed
        .iter()
        .filter(|name| compact(name).starts_with(&normalized))
        .collect();
    (candidates.len() == 1).then(|| candidates[0].clone())
}

pub fn title_distribution(title: &str, installed: &[String]) -> Option<String> {
    if let Some(name) = named_distribution(title, installed) {
        return Some(name);
    }
    let lower = title.to_lowercase();
    let mut candidates: Vec<_> = installed
        .iter()
        .filter(|name| {
            lower
                .strip_prefix(&name.to_lowercase())
                .is_some_and(|rest| rest.starts_with([' ', '-']))
        })
        .collect();
    candidates.sort_by_key(|name| std::cmp::Reverse(name.len()));
    if let Some(name) = candidates.first() {
        return Some((*name).clone());
    }
    let first = title.split_whitespace().next()?;
    looks_like_title(first)
        .then(|| named_distribution(first, installed))
        .flatten()
}

pub fn decode_output(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.contains(&0) {
        let bytes = bytes.strip_prefix(&[0xff, 0xfe]).unwrap_or(bytes);
        if bytes.len() % 2 != 0 {
            return Err("WSL returned incomplete Unicode output.".into());
        }
        let words: Vec<_> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16(&words).map_err(|_| "WSL returned invalid Unicode output.".into())
    } else {
        String::from_utf8(bytes.to_vec()).map_err(|_| "WSL returned invalid UTF-8 output.".into())
    }
}

#[cfg(windows)]
#[derive(Default)]
pub struct Discovery {
    installed: std::sync::OnceLock<Result<Vec<String>, String>>,
    identities: std::cell::RefCell<std::collections::HashMap<String, Result<Identity, String>>>,
    spent: std::cell::Cell<std::time::Duration>,
}

#[cfg(windows)]
impl Discovery {
    fn query(&self, args: &[&str]) -> Result<String, String> {
        use std::time::{Duration, Instant};
        let remaining = Duration::from_secs(20).saturating_sub(self.spent.get());
        if remaining.is_zero() {
            return Err(
                "WSL discovery timed out. Choose the distribution in terminal settings.".into(),
            );
        }
        let start = Instant::now();
        let output = crate::process_info::metadata_output(
            "wsl.exe",
            args,
            remaining.min(Duration::from_secs(5)),
        );
        self.spent
            .set(self.spent.get().saturating_add(start.elapsed()));
        decode_output(&output?)
    }

    pub fn installed(&self) -> Result<&[String], String> {
        self.installed
            .get_or_init(|| {
                self.query(&["--list", "--quiet"]).map(|output| {
                    output
                        .lines()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect()
                })
            })
            .as_ref()
            .map(Vec::as_slice)
            .map_err(Clone::clone)
    }

    pub fn resolve_name(&self, hint: &str) -> Result<Option<String>, String> {
        Ok(named_distribution(hint, self.installed()?))
    }

    pub fn resolve_title(&self, title: &str) -> Result<Option<String>, String> {
        Ok(title_distribution(title, self.installed()?))
    }

    pub fn identity(&self, distro: &str) -> Result<Identity, String> {
        if let Some(cached) = self.identities.borrow().get(distro) {
            return cached.clone();
        }
        // Static command, no interpolated title or distribution text, no login shell.
        let result = self.query(&["--distribution", distro, "--exec", "/bin/sh", "-c", "id -un; hostname"])
            .and_then(|output| {
                let parts: Vec<_> = output.lines().map(str::trim).filter(|s| !s.is_empty()).collect();
                if parts.len() != 2 { return Err("WSL did not return its user and hostname. Choose the distribution manually.".into()); }
                Ok(Identity { user: parts[0].into(), host: parts[1].into() })
            });
        self.identities
            .borrow_mut()
            .insert(distro.into(), result.clone());
        result
    }

    pub fn resolve_prompt(
        &self,
        title: &str,
        candidates: &[String],
    ) -> Result<Option<String>, String> {
        let Some(wanted) = prompt_identity(title) else {
            return Ok(None);
        };
        let distros = if candidates.is_empty() {
            self.installed()?
        } else {
            candidates
        };
        let mut matches = Vec::new();
        for distro in distros {
            let actual = self.identity(distro)?;
            if actual.user.eq_ignore_ascii_case(&wanted.user)
                && actual.host.eq_ignore_ascii_case(&wanted.host)
            {
                matches.push(distro.clone());
            }
        }
        match matches.len() {
            0 => Ok(None),
            1 => Ok(matches.pop()),
            _ => Err("More than one WSL distribution has this user and hostname. Choose the distribution in terminal settings.".into()),
        }
    }

    #[cfg(test)]
    pub fn fixture(entries: &[(&str, &str, &str)]) -> Self {
        Self {
            installed: std::sync::OnceLock::from(Ok(entries
                .iter()
                .map(|(d, _, _)| (*d).into())
                .collect())),
            identities: std::cell::RefCell::new(
                entries
                    .iter()
                    .map(|(d, u, h)| {
                        (
                            (*d).into(),
                            Ok(Identity {
                                user: (*u).into(),
                                host: (*h).into(),
                            }),
                        )
                    })
                    .collect(),
            ),
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_unicode_distribution_output_keeps_names_intact() {
        let text = "Ubuntu\r\nLinux 雪\r\n";
        let bytes: Vec<_> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
        assert_eq!(decode_output(&bytes).unwrap(), text);
        assert_eq!(decode_output(text.as_bytes()).unwrap(), text);
        assert!(decode_output(&[b'U', 0, b'x']).is_err());
    }
    #[test]
    fn launcher_versions_resolve_only_to_installed_unambiguous_names() {
        let names = ["Ubuntu", "Ubuntu-22.04", "kali-linux"].map(String::from);
        assert_eq!(
            launcher_hint("C:\\Apps\\ubuntu2204.exe"),
            Some("ubuntu2204".into())
        );
        assert_eq!(
            named_distribution("ubuntu2204", &names),
            Some("Ubuntu-22.04".into())
        );
        assert_eq!(
            named_distribution("kali", &names),
            Some("kali-linux".into())
        );
        assert_eq!(named_distribution("Ubuntu", &names), Some("Ubuntu".into()));
        assert!(
            named_distribution("Ubuntu", &["Ubuntu-22.04".into(), "Ubuntu-24.04".into()]).is_none()
        );
        assert!(launcher_hint("ubuntu-helper.exe").is_none());
        assert_eq!(
            title_distribution("Ubuntu-22.04 - project", &names),
            Some("Ubuntu-22.04".into())
        );
        assert_eq!(
            title_distribution("Ubuntu - project", &names),
            Some("Ubuntu".into())
        );
    }
    #[test]
    fn prompt_identity_requires_a_user_host_pair() {
        assert_eq!(
            prompt_identity("alice@dev:~/work"),
            Some(Identity {
                user: "alice".into(),
                host: "dev".into()
            })
        );
        for title in ["PowerShell", "alice@:~", "@dev:~", "a b@dev:~"] {
            assert!(prompt_identity(title).is_none());
        }
    }
    #[cfg(windows)]
    #[test]
    fn prompt_resolution_rejects_ambiguous_and_foreign_hosts() {
        let discovery =
            Discovery::fixture(&[("Ubuntu", "alice", "dev"), ("Debian", "bob", "other")]);
        assert_eq!(
            discovery.resolve_prompt("alice@dev:~", &[]).unwrap(),
            Some("Ubuntu".into())
        );
        assert_eq!(
            discovery.resolve_prompt("alice@remote:~", &[]).unwrap(),
            None
        );
        let duplicate =
            Discovery::fixture(&[("Ubuntu", "alice", "dev"), ("Debian", "alice", "dev")]);
        assert!(duplicate.resolve_prompt("alice@dev:~", &[]).is_err());
    }
}
