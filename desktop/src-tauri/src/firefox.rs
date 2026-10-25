//! Firefox session capture. Reads profile files; never changes browser profiles.
use crate::workspaces::{LaunchSpec, WindowInfo, WorkspaceItem};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const MAX_SESSION: usize = 128 * 1024 * 1024;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Browser {
    pub profile_path: String,
    pub profile_name: String,
    pub tabs: Vec<Tab>,
    /// One-based, as in Firefox's session store and the original application.
    pub active_tab: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Tab {
    pub url: String,
    pub title: String,
}
#[derive(Clone, Debug)]
struct Profile {
    path: PathBuf,
    name: String,
}

pub fn is_firefox(window: &WindowInfo) -> bool {
    let name = window
        .path
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    ["firefox", "firefox.exe", "firefox-bin"].contains(&name.as_str())
        || [
            "firefox",
            "firefox-esr",
            "org.mozilla.firefox",
            "firefoxdeveloperedition",
            "navigator",
        ]
        .contains(&window.app_id.to_ascii_lowercase().as_str())
}
fn bounded_read(path: &Path) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_SESSION as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_SESSION {
        return Err("Firefox session exceeds the 128 MiB capture limit.".into());
    }
    Ok(bytes)
}
fn decode(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() < 12 || &bytes[..8] != b"mozLz40\0" {
        return Err("Firefox session is not a supported Mozilla LZ4 file.".into());
    }
    let size = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    if size > MAX_SESSION {
        return Err("Firefox session exceeds the 128 MiB capture limit.".into());
    }
    let json = lz4_flex::block::decompress_size_prepended(&bytes[8..])
        .map_err(|e| format!("Cannot decompress Firefox session: {e}"))?;
    serde_json::from_slice(&json).map_err(|e| format!("Cannot parse Firefox session: {e}"))
}
fn session_windows(session: &Value, profile: &Profile) -> Vec<Browser> {
    session["windows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|window| {
            if window["isPrivate"].as_bool() == Some(true) {
                return None;
            }
            let selected = window["selected"].as_u64().unwrap_or(1).max(1) as usize;
            let mut tabs = Vec::new();
            let mut active_tab = 1;
            for (index, tab) in window["tabs"].as_array()?.iter().enumerate() {
                let Some(entries) = tab["entries"].as_array().filter(|e| !e.is_empty()) else {
                    continue;
                };
                let position = tab["index"].as_u64().unwrap_or(entries.len() as u64) as usize;
                let entry = &entries[position.saturating_sub(1).min(entries.len() - 1)];
                let Some(url) = entry["url"].as_str().filter(|u| !u.is_empty()) else {
                    continue;
                };
                tabs.push(Tab {
                    url: url.into(),
                    title: entry["title"].as_str().unwrap_or("").into(),
                });
                if index + 1 == selected {
                    active_tab = tabs.len();
                }
            }
            if tabs.is_empty() {
                return None;
            }
            Some(Browser {
                profile_path: profile.path.to_string_lossy().into_owned(),
                profile_name: profile.name.clone(),
                tabs,
                active_tab,
            })
        })
        .collect()
}
fn read_session(profile: &Profile) -> Result<Vec<Browser>, String> {
    let mut errors = Vec::new();
    for candidate in [
        "sessionstore-backups/recovery.jsonlz4",
        "sessionstore-backups/recovery.baklz4",
        "sessionstore.jsonlz4",
    ] {
        let path = profile.path.join(candidate);
        if !path.exists() {
            continue;
        }
        match bounded_read(&path).and_then(|bytes| decode(&bytes)) {
            Ok(session) => return Ok(session_windows(&session, profile)),
            Err(error) => errors.push(error),
        }
    }
    Err(errors.into_iter().next().unwrap_or_else(|| {
        "Firefox has not written a readable session yet. Tabs can be entered manually.".into()
    }))
}
fn parse_profiles(text: &str, root: &Path) -> Vec<Profile> {
    let mut sections = Vec::<HashMap<String, String>>::new();
    let mut current = None;
    for line in text.lines().map(str::trim) {
        if line.starts_with([';', '#']) || line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            current = if line[1..].starts_with("Profile") {
                sections.push(HashMap::new());
                Some(sections.len() - 1)
            } else {
                None
            };
        } else if let (Some(index), Some((key, value))) = (current, line.split_once('=')) {
            sections[index].insert(key.trim().into(), value.trim().into());
        }
    }
    sections
        .iter()
        .filter_map(|section| {
            let path = section.get("Path").filter(|p| !p.is_empty())?;
            let path = if section.get("IsRelative").is_some_and(|s| s == "0") {
                PathBuf::from(path)
            } else {
                root.join(path)
            };
            Some(Profile {
                name: section.get("Name").cloned().unwrap_or_default(),
                path,
            })
        })
        .collect()
}
fn roots() -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA")
            .map(|p| vec![PathBuf::from(p).join("Mozilla/Firefox")])
            .unwrap_or_default()
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var_os("HOME")
            .map(|p| {
                let home = PathBuf::from(p);
                [
                    ".mozilla/firefox",
                    "snap/firefox/common/.mozilla/firefox",
                    ".var/app/org.mozilla.firefox/.mozilla/firefox",
                ]
                .iter()
                .map(|p| home.join(p))
                .collect()
            })
            .unwrap_or_default()
    }
}
fn profiles() -> Vec<Profile> {
    let mut result = Vec::new();
    for root in roots() {
        if let Ok(text) = fs::read_to_string(root.join("profiles.ini")) {
            result.extend(parse_profiles(&text, &root));
        }
        let directory = if cfg!(windows) {
            root.join("Profiles")
        } else {
            root
        };
        if let Ok(entries) = fs::read_dir(directory) {
            for path in entries.flatten().map(|e| e.path()).filter(|p| p.is_dir()) {
                if path.join("prefs.js").exists()
                    && !result.iter().any(|p| same_path(&p.path, &path))
                {
                    result.push(Profile {
                        name: path
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy()
                            .into_owned(),
                        path,
                    });
                }
            }
        }
    }
    result.retain(|p| p.path.is_dir());
    result
}
fn same_path(a: &Path, b: &Path) -> bool {
    let a = fs::canonicalize(a).unwrap_or_else(|_| a.to_owned());
    let b = fs::canonicalize(b).unwrap_or_else(|_| b.to_owned());
    if cfg!(windows) {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}
fn profile_from_args(args: &[String], profiles: &[Profile]) -> Option<Profile> {
    for pair in args.windows(2) {
        if ["-profile", "--profile"].contains(&pair[0].as_str()) {
            let path = PathBuf::from(&pair[1]);
            return Some(
                profiles
                    .iter()
                    .find(|p| same_path(&p.path, &path))
                    .cloned()
                    .unwrap_or(Profile {
                        path,
                        name: String::new(),
                    }),
            );
        }
        if pair[0].eq_ignore_ascii_case("-p") {
            return profiles.iter().find(|p| p.name == pair[1]).cloned();
        }
    }
    None
}
fn title(text: &str) -> String {
    let mut text = text.trim();
    for suffix in [
        "Mozilla Firefox",
        "Firefox Developer Edition",
        "Nightly",
        "Firefox",
    ] {
        for separator in [" — ", " – ", " - "] {
            let brand = format!("{separator}{suffix}");
            // KWin decorates otherwise identical captions with " <2>", etc.
            // Only remove that decoration after the Firefox brand; a page's
            // own title may legitimately end in an angle-bracketed number.
            let undecorated = text
                .rsplit_once(" <")
                .and_then(|(caption, ordinal)| {
                    let digits = ordinal.strip_suffix('>')?;
                    (!digits.is_empty()
                        && digits.bytes().all(|b| b.is_ascii_digit())
                        && caption.ends_with(&brand))
                    .then_some(caption)
                })
                .unwrap_or(text);
            if let Some(value) = undecorated.strip_suffix(&brand) {
                text = value;
                break;
            }
        }
    }
    text.trim().to_lowercase()
}
fn score(window: &WindowInfo, browser: &Browser) -> u8 {
    let live = title(&window.title);
    let active = browser.tabs.get(browser.active_tab.saturating_sub(1));
    if live.is_empty() {
        return 0;
    }
    if active.is_some_and(|tab| title(&tab.title) == live) {
        120
    } else if browser
        .tabs
        .iter()
        .any(|tab| !tab.title.is_empty() && title(&tab.title) == live)
    {
        60
    } else {
        0
    }
}

fn same_content(a: &Browser, b: &Browser) -> bool {
    if a.profile_path != b.profile_path || a.tabs.len() != b.tabs.len() {
        return false;
    }
    let active = |browser: &Browser| {
        browser
            .tabs
            .get(browser.active_tab.saturating_sub(1))
            .map(|t| t.url.clone())
    };
    if active(a) != active(b) {
        return false;
    }
    let mut left: Vec<_> = a.tabs.iter().map(|t| (&t.url, &t.title)).collect();
    let mut right: Vec<_> = b.tabs.iter().map(|t| (&t.url, &t.title)).collect();
    left.sort();
    right.sort();
    left == right
}

fn reconcile_selected_tab(browser: &mut Browser, live_title: &str) {
    let live = title(live_title);
    let matching: Vec<_> = browser
        .tabs
        .iter()
        .enumerate()
        .filter(|(_, tab)| !tab.title.is_empty() && title(&tab.title) == live)
        .map(|(i, _)| i + 1)
        .collect();
    if matching.len() == 1 {
        browser.active_tab = matching[0];
    }
}

pub fn enrich(items: &mut [WorkspaceItem]) {
    if !items.iter().any(|i| is_firefox(&i.window)) {
        return;
    }
    let profiles = profiles();
    let mut sessions = HashMap::new();
    let mut process_profiles = HashMap::new();
    let mut used = HashSet::new();
    for item in items.iter_mut().filter(|i| is_firefox(&i.window)) {
        let explicit = process_profiles
            .entry(item.window.pid)
            .or_insert_with(|| {
                crate::process_info::arguments(item.window.pid)
                    .ok()
                    .and_then(|args| profile_from_args(&args, &profiles))
            })
            .clone();
        let candidates = explicit
            .clone()
            .map(|p| vec![p])
            .unwrap_or_else(|| profiles.clone());
        let mut matches = Vec::new();
        let mut error = None;
        for profile in &candidates {
            let session = sessions
                .entry(profile.path.clone())
                .or_insert_with(|| read_session(profile));
            match session {
                Ok(windows) => {
                    for (index, browser) in windows.iter().enumerate() {
                        if !used.contains(&(profile.path.clone(), index)) {
                            matches.push((
                                score(&item.window, browser),
                                profile.path.clone(),
                                index,
                                browser.clone(),
                            ));
                        }
                    }
                }
                Err(message) => {
                    error = Some(message.clone());
                }
            }
        }
        matches.sort_by(|a, b| b.0.cmp(&a.0));
        let unambiguous = matches.len() == 1 && candidates.len() == 1
            || matches.first().is_some_and(|m| {
                m.0 > 0
                    && matches
                        .iter()
                        .skip(1)
                        .all(|second| second.0 < m.0 || same_content(&m.3, &second.3))
            });
        let mut browser = if unambiguous {
            let (_, path, index, browser) = matches.remove(0);
            used.insert((path, index));
            browser
        } else {
            item.capture_note = error.unwrap_or_else(||"Firefox tabs could not be matched unambiguously. Review the profile and enter tabs manually.".into());
            Browser {
                profile_path: explicit
                    .as_ref()
                    .map(|p| p.path.to_string_lossy().into_owned())
                    .unwrap_or_default(),
                profile_name: explicit
                    .as_ref()
                    .map(|p| p.name.clone())
                    .unwrap_or_default(),
                active_tab: 1,
                ..Default::default()
            }
        };
        reconcile_selected_tab(&mut browser, &item.window.title);
        if !browser.tabs.is_empty() && score(&item.window, &browser) < 120 {
            item.capture_note = "Firefox's last saved session does not match the current window title. Review the tab URLs and selected tab.".into();
        }
        item.launch.program = if item.window.path.is_empty() {
            "firefox".into()
        } else {
            item.window.path.clone()
        };
        item.launch.args.clear();
        item.browser = Some(browser);
    }
}

impl Browser {
    pub fn validate(&self) -> Result<(), String> {
        if self.profile_path.contains('\0')
            || self.profile_name.contains('\0')
            || self.tabs.len() > 2000
            || self.active_tab == 0
            || (!self.tabs.is_empty() && self.active_tab > self.tabs.len())
            || self.tabs.iter().any(|t| {
                t.url.is_empty()
                    || t.url.contains(['\0', '\n', '\r'])
                    || t.url.starts_with('-')
                    || t.url.len() > 100_000
            })
        {
            return Err("Check the Firefox profile, tab URLs, and selected tab number.".into());
        }
        Ok(())
    }
    fn profile_args(&self) -> Result<Vec<String>, String> {
        if !self.profile_path.is_empty() {
            if !Path::new(&self.profile_path).is_dir() {
                return Err("The saved Firefox profile folder is missing. Edit the workspace's profile path.".into());
            }
            Ok(vec!["--profile".into(), self.profile_path.clone()])
        } else if !self.profile_name.is_empty() {
            Ok(vec!["-P".into(), self.profile_name.clone()])
        } else {
            Ok(Vec::new())
        }
    }
    /// Same selected-tab-last convention as the original app.
    pub fn launch_commands(&self, base: &LaunchSpec) -> Result<Vec<LaunchSpec>, String> {
        self.validate()?;
        let profile_args = self.profile_args()?;
        let mut urls: Vec<_> = self
            .tabs
            .iter()
            .enumerate()
            .filter(|(i, _)| *i + 1 != self.active_tab)
            .map(|(_, t)| t.url.clone())
            .collect();
        if let Some(active) = self.tabs.get(self.active_tab.saturating_sub(1)) {
            urls.push(active.url.clone());
        }
        if urls.is_empty() {
            urls.push("about:blank".into());
        }
        let mut first = base.clone();
        first.args.extend(profile_args.clone());
        first.args.extend(["--new-window".into(), urls.remove(0)]);
        let mut result = vec![first];
        if !urls.is_empty() {
            let mut tabs = base.clone();
            tabs.args.extend(profile_args);
            for url in urls {
                tabs.args.extend(["--new-tab".into(), url]);
            }
            result.push(tabs);
        }
        Ok(result)
    }
}

/// Resolve once per process during restore; tab polling does not reread sessions.
#[derive(Default)]
pub struct Matcher {
    profiles: Option<Vec<Profile>>,
    processes: HashMap<u32, Option<Profile>>,
}
impl Matcher {
    pub fn matches(&mut self, window: &WindowInfo, saved: &Browser) -> bool {
        if saved.profile_path.is_empty() && saved.profile_name.is_empty() {
            return true;
        }
        let profiles = self.profiles.get_or_insert_with(profiles);
        let current = self.processes.entry(window.pid).or_insert_with(|| {
            crate::process_info::arguments(window.pid)
                .ok()
                .and_then(|a| profile_from_args(&a, profiles))
        });
        if let Some(profile) = current {
            if !saved.profile_path.is_empty() {
                return same_path(&profile.path, Path::new(&saved.profile_path));
            }
            return profile.name == saved.profile_name;
        }
        // Without process evidence, only an exact saved active-tab title can
        // identify a candidate. Never borrow an arbitrary window from another profile.
        score(window, saved) == 120
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn kde_duplicate_caption_suffix_does_not_hide_firefox_tab_identity() {
        assert_eq!(title("Warp Second — Mozilla Firefox <2>"), "warp second");
        assert_eq!(
            title("Warp Second - Firefox Developer Edition <12>"),
            "warp second"
        );
        assert_eq!(title("A page <2> — Mozilla Firefox <3>"), "a page <2>");
        assert_eq!(title("A page <2>"), "a page <2>");
        assert_eq!(
            title("A page — Mozilla Firefox <draft>"),
            "a page — mozilla firefox <draft>"
        );
        let mut browser = Browser {
            tabs: vec![
                Tab {
                    url: "one".into(),
                    title: "First".into(),
                },
                Tab {
                    url: "two".into(),
                    title: "Second".into(),
                },
            ],
            active_tab: 1,
            ..Default::default()
        };
        reconcile_selected_tab(&mut browser, "Second — Mozilla Firefox <2>");
        assert_eq!(browser.active_tab, 2);
    }
    fn profile() -> Profile {
        Profile {
            path: PathBuf::from("/profiles/work"),
            name: "Work".into(),
        }
    }
    fn encoded(json: &Value) -> Vec<u8> {
        let mut bytes = b"mozLz40\0".to_vec();
        bytes.extend(lz4_flex::block::compress_prepend_size(
            &serde_json::to_vec(json).unwrap(),
        ));
        bytes
    }
    fn session() -> Value {
        serde_json::json!({"windows":[{"selected":3,"tabs":[
            {"index":1,"entries":[{"url":"https://example.test/current","title":"Current"},{"url":"https://example.test/forward","title":"Forward"}]},
            {"entries":[]},
            {"index":1,"entries":[{"url":"https://example.test/active?q=雪","title":"Selected 雪"}]}]},
            {"isPrivate":true,"tabs":[{"entries":[{"url":"https://private.test"}]}]}]})
    }
    #[test]
    fn mozilla_size_header_history_and_selected_tab_are_decoded() {
        let windows = session_windows(&decode(&encoded(&session())).unwrap(), &profile());
        assert_eq!(windows.len(), 1);
        assert_eq!(windows[0].tabs.len(), 2);
        assert_eq!(windows[0].tabs[0].url, "https://example.test/current");
        assert_eq!(windows[0].active_tab, 2); // empty tabs do not shift the selection
        assert_eq!(windows[0].tabs[1].title, "Selected 雪");
    }
    #[test]
    fn malformed_compression_and_unbounded_allocation_are_rejected() {
        assert!(decode(b"mozLz40\0").is_err());
        let mut bytes = encoded(&session());
        bytes[8..12].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode(&bytes).unwrap_err().contains("limit"));
        let mut truncated = encoded(&session());
        truncated.truncate(18);
        assert!(decode(&truncated).is_err());
        assert!(decode(b"not a Firefox compressed session").is_err());
    }
    #[test]
    fn profile_ini_keeps_absolute_relative_and_equals_in_paths() {
        let profiles=parse_profiles("[General]\nStartWithLastProfile=1\n[Profile0]\nName=Work\nPath=Profiles/a=b\nIsRelative=1\n[InstallXYZ]\nDefault=ignored\n[Profile1]\nName=Separate\nIsRelative=0\nPath=/profiles/elsewhere\n",Path::new("/mozilla"));
        assert_eq!(profiles.len(), 2);
        assert_eq!(profiles[0].path, Path::new("/mozilla/Profiles/a=b"));
        assert_eq!(profiles[1].path, Path::new("/profiles/elsewhere"));
        assert_eq!(
            profile_from_args(&["firefox".into(), "-P".into(), "Work".into()], &profiles)
                .unwrap()
                .name,
            "Work"
        );
    }
    #[test]
    fn corrupt_recovery_falls_back_without_modifying_profile() {
        let directory = std::env::temp_dir().join(format!("warp-firefox-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(directory.join("sessionstore-backups")).unwrap();
        let bad = directory.join("sessionstore-backups/recovery.jsonlz4");
        fs::write(&bad, b"incomplete live write").unwrap();
        fs::write(
            directory.join("sessionstore-backups/recovery.baklz4"),
            encoded(&session()),
        )
        .unwrap();
        let windows = read_session(&Profile {
            path: directory.clone(),
            name: "Fixture".into(),
        })
        .unwrap();
        assert_eq!(windows[0].tabs.len(), 2);
        assert_eq!(fs::read(&bad).unwrap(), b"incomplete live write");
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn launch_uses_argument_boundaries_and_selected_tab_last() {
        let browser = Browser {
            profile_name: "A profile with spaces".into(),
            profile_path: String::new(),
            tabs: vec![
                Tab {
                    url: "https://a.test/?q=one two".into(),
                    title: "A".into(),
                },
                Tab {
                    url: "https://b.test/$literal".into(),
                    title: "B".into(),
                },
                Tab {
                    url: "https://c.test/".into(),
                    title: "C".into(),
                },
            ],
            active_tab: 1,
        };
        let commands = browser
            .launch_commands(&LaunchSpec {
                program: "firefox".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            commands[0].args,
            [
                "-P",
                "A profile with spaces",
                "--new-window",
                "https://b.test/$literal"
            ]
        );
        assert_eq!(
            commands[1].args,
            [
                "-P",
                "A profile with spaces",
                "--new-tab",
                "https://c.test/",
                "--new-tab",
                "https://a.test/?q=one two"
            ]
        );
        assert!(!commands[0].args.contains(&"--no-remote".into()));
    }
    #[test]
    fn invalid_active_tab_and_option_like_url_are_review_errors() {
        let mut browser = Browser {
            active_tab: 1,
            ..Default::default()
        };
        browser.validate().unwrap();
        browser.tabs.push(Tab {
            url: "--profile".into(),
            title: String::new(),
        });
        assert!(browser.validate().is_err());
        browser.tabs[0].url = "about:blank".into();
        browser.active_tab = 2;
        assert!(browser.validate().is_err());
    }
    #[test]
    fn identical_tab_sets_can_match_twins_but_not_different_profiles() {
        let a = session_windows(&session(), &profile()).remove(0);
        let mut b = a.clone();
        b.tabs.reverse();
        b.active_tab = 1;
        assert!(same_content(&a, &b));
        b.profile_path = "another-profile".into();
        assert!(!same_content(&a, &b));
        b = a.clone();
        b.tabs[0].url = "https://different.test".into();
        assert!(!same_content(&a, &b));
    }
    #[test]
    fn live_title_corrects_stale_selected_tab_without_guessing_duplicate_titles() {
        let mut browser = session_windows(&session(), &profile()).remove(0);
        reconcile_selected_tab(&mut browser, "Current — Mozilla Firefox");
        assert_eq!(browser.active_tab, 1);
        browser.tabs[1].title = "Current".into();
        browser.active_tab = 2;
        reconcile_selected_tab(&mut browser, "Current — Mozilla Firefox");
        assert_eq!(browser.active_tab, 2);
    }
}
