//! Capture terminal identity without recording or replaying commands typed inside it.
use crate::workspaces::{LaunchSpec, WindowInfo, WorkspaceItem};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    #[default]
    WindowsTerminal,
    Konsole,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Terminal {
    pub kind: Kind,
    pub profile_name: String,
    pub profile_path: String,
    pub shell: String,
    pub shell_args: Vec<String>,
    pub wsl_distro: String,
    pub wsl_user: String,
    pub working_directory: String,
}

impl Terminal {
    pub fn validate(&self) -> Result<(), String> {
        let fields = [
            &self.profile_name,
            &self.profile_path,
            &self.shell,
            &self.wsl_distro,
            &self.wsl_user,
            &self.working_directory,
        ];
        if self.shell_args.len() > 1000
            || fields
                .into_iter()
                .chain(self.shell_args.iter())
                .any(|s| s.contains('\0') || s.len() > 32768)
        {
            return Err("Invalid terminal profile or shell arguments.".into());
        }
        if (!self.wsl_distro.is_empty() || !self.wsl_user.is_empty())
            && (self.kind != Kind::WindowsTerminal || basename(&self.shell) != "wsl.exe")
        {
            return Err("A WSL distribution or user requires the wsl.exe shell.".into());
        }
        if self.shell.is_empty() && !self.shell_args.is_empty() {
            return Err("Choose a shell program before adding shell arguments.".into());
        }
        Ok(())
    }

    pub fn launch_command(&self, base: &LaunchSpec) -> Result<LaunchSpec, String> {
        self.validate()?;
        if base.kind != crate::workspaces::LaunchKind::Executable {
            return Err("Terminal session restoration requires an executable launch. Select Executable or turn off Restore terminal session.".into());
        }
        if self.kind == Kind::Konsole
            && !self.profile_path.is_empty()
            && !std::path::Path::new(&self.profile_path).is_file()
        {
            return Err("The saved Konsole profile file no longer exists. Edit the terminal profile before restoring it.".into());
        }
        let mut args: Vec<String> = match self.kind {
            Kind::WindowsTerminal => vec!["-w".into(), "new".into(), "new-tab".into()],
            Kind::Konsole => vec!["--separate".into()],
        };
        let profile = if self.kind == Kind::Konsole && !self.profile_path.is_empty() {
            &self.profile_path
        } else {
            &self.profile_name
        };
        if !profile.is_empty() {
            args.extend(["--profile".into(), profile.clone()]);
        }
        let wsl = self.kind == Kind::WindowsTerminal && basename(&self.shell) == "wsl.exe";
        if !self.working_directory.is_empty() && !wsl {
            args.extend([
                match self.kind {
                    Kind::WindowsTerminal => "--startingDirectory",
                    Kind::Konsole => "--workdir",
                }
                .into(),
                self.working_directory.clone(),
            ]);
        }
        if !self.shell.is_empty() {
            if self.kind == Kind::Konsole {
                args.push("-e".into());
            }
            args.push(self.shell.clone());
            if wsl {
                for (flag, value) in [
                    ("--distribution", &self.wsl_distro),
                    ("--user", &self.wsl_user),
                    ("--cd", &self.working_directory),
                ] {
                    if !value.is_empty() {
                        args.extend([flag.into(), value.clone()]);
                    }
                }
            }
            args.extend(self.shell_args.clone());
        }
        // Terminal has its own command separator even when no shell is involved.
        // Escape literal semicolons as required by wt's argument parser.
        if self.kind == Kind::WindowsTerminal {
            args = args.into_iter().map(|s| s.replace(';', "\\;")).collect();
        }
        Ok(LaunchSpec {
            kind: crate::workspaces::LaunchKind::Executable,
            program: base.program.clone(),
            args,
            working_directory: base.working_directory.clone(),
            new_window: base.new_window,
        })
    }

    fn compatible(&self, other: &Self) -> bool {
        self.kind == other.kind
            && (self.profile_name.is_empty() || self.profile_name == other.profile_name)
            && (self.shell.is_empty() || basename(&self.shell) == basename(&other.shell))
            && (self.wsl_distro.is_empty() || self.wsl_distro == other.wsl_distro)
            && (self.wsl_user.is_empty() || self.wsl_user == other.wsl_user)
    }
}

fn basename(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .unwrap_or(path)
        .to_lowercase()
}

pub fn kind(window: &WindowInfo) -> Option<Kind> {
    if basename(&window.path) == "windowsterminal.exe"
        || window.app_id.eq_ignore_ascii_case("windowsterminal.exe")
    {
        Some(Kind::WindowsTerminal)
    } else if basename(&window.path) == "konsole"
        || window.desktop_id == "org.kde.konsole"
        || window.app_id == "org.kde.konsole"
    {
        Some(Kind::Konsole)
    } else {
        None
    }
}

/// A snapshot is scoped to one capture/restore pass; it must not outlive process identities.
pub struct Capture {
    #[cfg(windows)]
    processes: Result<Vec<crate::process_info::Process>, String>,
    #[cfg(windows)]
    wsl: crate::wsl::Discovery,
    #[cfg(target_os = "linux")]
    connection: Result<zbus::blocking::Connection, String>,
}

impl Capture {
    pub fn new() -> Self {
        Self {
            #[cfg(windows)]
            processes: crate::process_info::snapshot(),
            #[cfg(windows)]
            wsl: crate::wsl::Discovery::default(),
            #[cfg(target_os = "linux")]
            connection: zbus::blocking::connection::Builder::session()
                .and_then(|b| b.method_timeout(std::time::Duration::from_secs(2)).build())
                .map_err(|e| e.to_string()),
        }
    }

    fn read(&self, window: &WindowInfo, windows: &[WindowInfo]) -> Result<Terminal, String> {
        #[cfg(windows)]
        {
            self.windows_terminal(window, windows)
        }
        #[cfg(target_os = "linux")]
        {
            self.konsole(window, windows)
        }
    }

    pub fn matches(&self, window: &WindowInfo, windows: &[WindowInfo], saved: &Terminal) -> bool {
        self.read(window, windows)
            .is_ok_and(|current| saved.compatible(&current))
    }
}

pub fn enrich(items: &mut [WorkspaceItem]) {
    if !items.iter().any(|i| kind(&i.window).is_some()) {
        return;
    }
    let capture = Capture::new();
    let windows: Vec<_> = items.iter().map(|i| i.window.clone()).collect();
    for item in items {
        let Some(kind) = kind(&item.window) else {
            continue;
        };
        item.launch.kind = crate::workspaces::LaunchKind::Executable;
        item.launch.program = match kind {
            Kind::WindowsTerminal => {
                // Packaged Terminal uses a stable alias across Store updates.
                // Unpackaged/portable Terminal owns a different settings store.
                if item.window.desktop_id.is_empty() && !item.window.path.is_empty() {
                    item.window.path.clone()
                } else {
                    "wt.exe".into()
                }
            }
            Kind::Konsole => {
                if item.window.path.is_empty() {
                    "konsole".into()
                } else {
                    item.window.path.clone()
                }
            }
        };
        item.launch.args.clear();
        match capture.read(&item.window, &windows) {
            Ok(terminal) => {
                if terminal.kind == Kind::WindowsTerminal
                    && terminal.shell == "wsl.exe"
                    && terminal.wsl_distro.is_empty()
                {
                    item.capture_note = "Review terminal launch settings: the WSL distribution was not identified. Select it to avoid relying on the current default distribution.".into();
                }
                if terminal.kind == Kind::Konsole
                    && !terminal.profile_name.is_empty()
                    && terminal.profile_path.is_empty()
                {
                    item.capture_note = "Review terminal launch settings: the Konsole profile file was not found. Select its profile file or check the profile name.".into();
                }
                item.terminal = Some(terminal);
            }
            Err(error) => {
                item.terminal = Some(Terminal {
                    kind,
                    ..Default::default()
                });
                item.capture_note = format!("Review terminal launch settings: {error}");
            }
        }
    }
}

fn option(args: &[String], names: &[&str]) -> String {
    for (index, arg) in args.iter().enumerate() {
        if ["--", "--exec", "-e"].contains(&arg.as_str()) {
            break;
        }
        for name in names {
            if arg == name {
                return args.get(index + 1).cloned().unwrap_or_default();
            }
            if let Some(value) = arg.strip_prefix(&format!("{name}=")) {
                return value.into();
            }
        }
    }
    String::new()
}

#[cfg(any(windows, test))]
fn from_shell(program: &str, args: &[String]) -> Option<Terminal> {
    let name = basename(program);
    if let Some(hint) = crate::wsl::launcher_hint(program) {
        return Some(Terminal {
            shell: "wsl.exe".into(),
            wsl_distro: hint,
            ..Default::default()
        });
    }
    if ![
        "wsl.exe",
        "pwsh.exe",
        "powershell.exe",
        "cmd.exe",
        "bash.exe",
    ]
    .contains(&name.as_str())
    {
        return None;
    }
    let shell = if ["powershell.exe", "pwsh.exe"].contains(&name.as_str()) {
        args.first()
            .filter(|arg| std::path::Path::new(arg).is_absolute() && basename(arg) == name)
            .cloned()
            .unwrap_or_else(|| name.clone())
    } else {
        name.clone()
    };
    let mut result = Terminal {
        shell,
        ..Default::default()
    };
    if name == "wsl.exe" {
        result.wsl_distro = option(args, &["-d", "--distribution"]);
        result.wsl_user = option(args, &["-u", "--user"]);
        result.working_directory = option(args, &["--cd"]);
    }
    Some(result)
}

#[cfg(windows)]
impl Capture {
    fn windows_terminal(
        &self,
        window: &WindowInfo,
        windows: &[WindowInfo],
    ) -> Result<Terminal, String> {
        // Keep the original title fallback when process metadata is unavailable.
        let processes = self
            .processes
            .as_ref()
            .map(Vec::as_slice)
            .unwrap_or_default();
        let mut descendants = std::collections::HashSet::from([window.pid]);
        loop {
            let count = descendants.len();
            for p in processes {
                if descendants.contains(&p.parent) {
                    descendants.insert(p.pid);
                }
            }
            if count == descendants.len() {
                break;
            }
        }
        let title = window
            .title
            .trim()
            .trim_start_matches("Administrator: ")
            .to_lowercase();
        let title_shell = match title.as_str() {
            "windows powershell" => Some("powershell.exe"),
            "powershell" | "powershell 7" | "pwsh" => Some("pwsh.exe"),
            "command prompt" | "cmd" | "cmd.exe" => Some("cmd.exe"),
            _ => None,
        };
        let mut choices: Vec<Terminal> = Vec::new();
        for p in processes
            .iter()
            .filter(|p| p.pid != window.pid && descendants.contains(&p.pid))
        {
            if let Some(mut spec) = from_shell(&p.name, &p.args) {
                if title_shell.is_some_and(|shell| basename(&spec.shell) != shell) {
                    continue;
                }
                if let Some(hint) = crate::wsl::launcher_hint(&p.name) {
                    spec.wsl_distro = self.wsl.resolve_name(&hint)?.ok_or("The distribution launcher does not identify one installed WSL distribution. Review its distribution setting.")?;
                }
                if !choices.contains(&spec) {
                    choices.push(spec);
                }
            }
        }
        if let Some(shell) = title_shell {
            choices.retain(|s| basename(&s.shell) == shell);
            if choices.is_empty() {
                return Ok(Terminal {
                    shell: shell.into(),
                    ..Default::default()
                });
            }
        }
        if title_shell.is_none()
            && (choices.iter().any(|s| s.shell == "wsl.exe")
                || (choices.is_empty() && crate::wsl::looks_like_title(&title)))
        {
            let hint = crate::wsl::looks_like_title(&title);
            if hint {
                choices.retain(|s| s.shell == "wsl.exe");
            }
            // One explicit process distribution is stronger evidence than a
            // prompt changed by SSH or a custom title.
            let known = choices.len() == 1 && !choices[0].wsl_distro.is_empty();
            if !known {
                let mut distro = self.wsl.resolve_title(&title)?;
                if distro.is_none() && crate::wsl::prompt_identity(&title).is_some() {
                    let candidates: Vec<_> = if choices.iter().any(|s| s.wsl_distro.is_empty()) {
                        vec![]
                    } else {
                        choices
                            .iter()
                            .filter(|s| s.shell == "wsl.exe")
                            .map(|s| s.wsl_distro.clone())
                            .collect::<std::collections::HashSet<_>>()
                            .into_iter()
                            .collect()
                    };
                    distro = self.wsl.resolve_prompt(&title, &candidates)?;
                }
                if let Some(distro) = distro {
                    choices.retain(|s| {
                        s.shell == "wsl.exe"
                            && (s.wsl_distro.is_empty()
                                || s.wsl_distro.eq_ignore_ascii_case(&distro))
                    });
                    for spec in &mut choices {
                        spec.wsl_distro = distro.clone();
                    }
                    if choices.is_empty() {
                        choices.push(Terminal {
                            shell: "wsl.exe".into(),
                            wsl_distro: distro,
                            ..Default::default()
                        });
                    }
                } else if choices.is_empty() && hint {
                    choices.push(Terminal {
                        shell: "wsl.exe".into(),
                        ..Default::default()
                    });
                }
                let mut unique = Vec::new();
                for spec in choices {
                    if !unique.contains(&spec) {
                        unique.push(spec);
                    }
                }
                choices = unique;
            }
        }
        if choices.len() != 1 {
            return Err("The active shell could not be uniquely identified. Choose its shell or profile before saving.".into());
        }
        let mut result = choices.remove(0);
        // A shared Terminal process can own multiple windows with different profiles.
        if windows.iter().filter(|w| w.pid == window.pid).count() == 1 {
            if let Some(process) = processes.iter().find(|p| p.pid == window.pid) {
                result.profile_name = option(&process.args, &["-p", "--profile"]);
                if result.working_directory.is_empty() && result.shell != "wsl.exe" {
                    result.working_directory =
                        option(&process.args, &["-d", "--startingDirectory"]);
                }
            }
        }
        Ok(result)
    }
}

#[cfg(target_os = "linux")]
impl Capture {
    fn konsole(&self, window: &WindowInfo, windows: &[WindowInfo]) -> Result<Terminal, String> {
        use zbus::blocking::Proxy;
        let connection = self.connection.as_ref().map_err(Clone::clone)?;
        let service = format!("org.kde.konsole-{}", window.pid);
        let root = Proxy::new(
            connection,
            service.as_str(),
            "/Windows",
            "org.freedesktop.DBus.Introspectable",
        )
        .map_err(|e| format!("Konsole sessions unavailable: {e}"))?;
        let xml: String = root
            .call("Introspect", &())
            .map_err(|e| format!("Konsole sessions unavailable: {e}"))?;
        let mut candidates = Vec::new();
        for node in xml.split("<node name=\"").skip(1) {
            let id = node.split('"').next().unwrap_or_default();
            if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
                continue;
            }
            let path = format!("/Windows/{id}");
            let view = Proxy::new(
                connection,
                service.as_str(),
                path.as_str(),
                "org.kde.konsole.Window",
            )
            .map_err(|e| e.to_string())?;
            let session: i32 = view
                .call("currentSession", &())
                .map_err(|e| e.to_string())?;
            let path = format!("/Sessions/{session}");
            let session = Proxy::new(
                connection,
                service.as_str(),
                path.as_str(),
                "org.kde.konsole.Session",
            )
            .map_err(|e| e.to_string())?;
            let title: String = session.call("title", &(1i32,)).map_err(|e| e.to_string())?;
            let pid: i32 = session.call("processId", &()).map_err(|e| e.to_string())?;
            let profile: String = session.call("profile", &()).map_err(|e| e.to_string())?;
            candidates.push((title, pid, profile));
        }
        if windows.iter().filter(|w| w.pid == window.pid).count() > 1 || candidates.len() > 1 {
            candidates.retain(|(title, _, _)| {
                !title.is_empty()
                    && [
                        title.clone(),
                        format!("{title} — Konsole"),
                        format!("{title} - Konsole"),
                    ]
                    .contains(&window.title)
            });
        }
        if candidates.len() != 1 {
            return Err("The active Konsole session could not be uniquely identified. Review its shell, profile, and directory.".into());
        }
        let (_, pid, mut profile_name) = candidates.remove(0);
        if pid <= 0 {
            return Err("The Konsole shell has exited.".into());
        }
        let shell = std::fs::read_link(format!("/proc/{pid}/exe"))
            .map_err(|e| format!("Cannot read the Konsole shell: {e}"))?
            .to_string_lossy()
            .into_owned();
        let working_directory = std::fs::read_link(format!("/proc/{pid}/cwd"))
            .map_err(|e| format!("Cannot read the Konsole directory: {e}"))?
            .to_string_lossy()
            .into_owned();
        let mut profile_path = konsole_profile_path(&profile_name).unwrap_or_default();
        // Some Konsole versions expose an unnamed runtime profile after -e.
        // Its original explicit profile is still available in the launch argv.
        if profile_name.is_empty() && windows.iter().filter(|w| w.pid == window.pid).count() == 1 {
            let args = crate::process_info::arguments(window.pid)?;
            let reference = option(&args, &["--profile"]);
            if let Some(path) = konsole_profile_reference(&reference, window.pid) {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    profile_name = profile_display_name(&text).unwrap_or_default().into();
                    profile_path = path.to_string_lossy().into_owned();
                }
            }
        }
        Ok(Terminal {
            kind: Kind::Konsole,
            profile_path,
            profile_name,
            shell,
            working_directory,
            ..Default::default()
        })
    }
}

#[cfg(target_os = "linux")]
fn konsole_profile_path(name: &str) -> Option<String> {
    if name.is_empty() {
        return None;
    }
    let mut matches = Vec::new();
    for root in konsole_profile_roots() {
        let Ok(entries) = std::fs::read_dir(root.join("konsole")) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|ext| ext != "profile") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if profile_display_name(&text) == Some(name) {
                matches.push(path);
            }
        }
    }
    (matches.len() == 1).then(|| matches[0].to_string_lossy().into_owned())
}

#[cfg(target_os = "linux")]
fn konsole_profile_roots() -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let mut roots: Vec<PathBuf> = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
        .into_iter()
        .collect();
    roots.extend(std::env::split_paths(
        &std::env::var_os("XDG_DATA_DIRS").unwrap_or_else(|| "/usr/local/share:/usr/share".into()),
    ));
    roots
}

#[cfg(target_os = "linux")]
fn konsole_profile_reference(reference: &str, pid: u32) -> Option<std::path::PathBuf> {
    use std::path::PathBuf;
    if reference.is_empty() {
        return None;
    }
    let mut path = PathBuf::from(reference);
    if path.extension().is_none_or(|ext| ext != "profile") {
        path = PathBuf::from(format!("{reference}.profile"));
    }
    if path.is_absolute() {
        return path.is_file().then_some(path);
    }
    if path.components().count() > 1 {
        path = std::fs::read_link(format!("/proc/{pid}/cwd"))
            .ok()?
            .join(path);
        return path.is_file().then_some(path);
    }
    konsole_profile_roots()
        .into_iter()
        .map(|root| root.join("konsole").join(&path))
        .find(|path| path.is_file())
}

#[cfg(any(target_os = "linux", test))]
fn profile_display_name(text: &str) -> Option<&str> {
    let mut general = false;
    for line in text.lines().map(str::trim) {
        if line.starts_with('[') {
            general = line == "[General]";
        } else if general {
            if let Some(name) = line.strip_prefix("Name=") {
                return Some(name.trim());
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_options_are_not_mistaken_for_wsl_distribution() {
        let args = ["wsl.exe", "--exec", "something", "-d", "not-a-distro"].map(String::from);
        assert!(from_shell("wsl.exe", &args).unwrap().wsl_distro.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn portable_terminal_keeps_its_executable_but_packaged_terminal_keeps_stable_alias() {
        let window: WindowInfo = serde_json::from_value(serde_json::json!({
            "id":"1", "pid":u32::MAX, "title":"Windows PowerShell", "appId":"WindowsTerminal.exe", "desktopId":"", "path":"C:\\portable\\WindowsTerminal.exe",
            "rect":{"x":0,"y":0,"width":800,"height":600}, "workArea":{"x":0,"y":0,"width":1920,"height":1080},
            "monitor":1,"monitorName":"main","maximizedHorizontal":false,"maximizedVertical":false,"fullscreen":false,"minimized":false,"active":true
        })).unwrap();
        let mut packaged = window.clone();
        packaged.id = "2".into();
        packaged.path =
            "C:\\Program Files\\WindowsApps\\Terminal_version\\WindowsTerminal.exe".into();
        packaged.desktop_id = "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App".into();
        let mut unknown = window.clone();
        unknown.id = "3".into();
        unknown.path.clear();
        let mut workspace =
            crate::workspaces::capture(vec![window.clone(), packaged, unknown], "Fixture".into());
        enrich(&mut workspace.items);
        assert_eq!(workspace.items[0].launch.program, window.path);
        assert_eq!(workspace.items[1].launch.program, "wt.exe");
        assert_eq!(workspace.items[2].launch.program, "wt.exe");
    }
    #[cfg(windows)]
    #[test]
    fn normal_powershell_titles_preserve_explicit_shell_paths_without_commands() {
        use crate::process_info::Process;
        for (name, caption) in [
            ("pwsh.exe", "PowerShell 7"),
            ("powershell.exe", "Windows PowerShell"),
        ] {
            let shell = format!("C:\\a custom shell directory\\{name}");
            let window: WindowInfo = serde_json::from_value(serde_json::json!({
                "id":"1", "pid":10, "title":caption, "appId":"WindowsTerminal.exe", "desktopId":"", "path":"WindowsTerminal.exe",
                "rect":{"x":0,"y":0,"width":800,"height":600}, "workArea":{"x":0,"y":0,"width":1920,"height":1080},
                "monitor":1,"monitorName":"main","maximizedHorizontal":false,"maximizedVertical":false,"fullscreen":false,"minimized":false,"active":true
            })).unwrap();
            let capture = Capture {
                wsl: crate::wsl::Discovery::fixture(&[]),
                processes: Ok(vec![Process {
                    pid: 11,
                    parent: 10,
                    name: name.into(),
                    args: vec![
                        shell.clone(),
                        "-Command".into(),
                        "Write-Output captured-command".into(),
                    ],
                }]),
            };
            let saved = capture
                .read(&window, std::slice::from_ref(&window))
                .unwrap();
            assert_eq!(saved.shell, shell);
            assert!(saved.shell_args.is_empty());
            assert!(saved.compatible(&Terminal {
                shell: name.into(),
                ..Default::default()
            }));
        }
    }
    #[cfg(windows)]
    #[test]
    fn ambiguous_terminal_children_require_review_but_a_known_shell_title_resolves_them() {
        use crate::process_info::Process;
        let window: WindowInfo = serde_json::from_value(serde_json::json!({
            "id":"1", "pid":10, "title":"user@host: ~", "appId":"windowsterminal.exe", "desktopId":"", "path":"WindowsTerminal.exe",
            "rect":{"x":0,"y":0,"width":800,"height":600}, "workArea":{"x":0,"y":0,"width":1920,"height":1080},
            "monitor":1,"monitorName":"main","maximizedHorizontal":false,"maximizedVertical":false,"fullscreen":false,"minimized":false,"active":true
        })).unwrap();
        let capture = Capture {
            wsl: crate::wsl::Discovery::fixture(&[
                ("Ubuntu", "user", "host"),
                ("Debian", "user", "host"),
            ]),
            processes: Ok(vec![
                Process {
                    pid: 10,
                    parent: 1,
                    name: "WindowsTerminal.exe".into(),
                    args: vec![],
                },
                Process {
                    pid: 11,
                    parent: 10,
                    name: "wsl.exe".into(),
                    args: ["wsl.exe", "-d", "Ubuntu"].map(String::from).to_vec(),
                },
                Process {
                    pid: 12,
                    parent: 10,
                    name: "wsl.exe".into(),
                    args: ["wsl.exe", "-d", "Debian"].map(String::from).to_vec(),
                },
                Process {
                    pid: 13,
                    parent: 10,
                    name: "pwsh.exe".into(),
                    args: vec![],
                },
            ]),
        };
        assert!(capture
            .read(&window, std::slice::from_ref(&window))
            .is_err());
        let mut powershell = window.clone();
        powershell.title = "PowerShell 7".into();
        assert_eq!(
            capture
                .read(&powershell, std::slice::from_ref(&powershell))
                .unwrap()
                .shell,
            "pwsh.exe"
        );
    }
    #[cfg(windows)]
    #[test]
    fn title_fallback_and_legacy_launchers_use_installed_distribution_names() {
        use crate::process_info::Process;
        let mut window: WindowInfo = serde_json::from_value(serde_json::json!({
            "id":"1", "pid":10, "title":"Ubuntu-22.04 - project", "appId":"windowsterminal.exe", "desktopId":"", "path":"WindowsTerminal.exe",
            "rect":{"x":0,"y":0,"width":800,"height":600}, "workArea":{"x":0,"y":0,"width":1920,"height":1080},
            "monitor":1,"monitorName":"main","maximizedHorizontal":false,"maximizedVertical":false,"fullscreen":false,"minimized":false,"active":true
        })).unwrap();
        let mut capture = Capture {
            processes: Err("CIM unavailable".into()),
            wsl: crate::wsl::Discovery::fixture(&[
                ("Ubuntu", "alice", "dev"),
                ("Ubuntu-22.04", "bob", "dev"),
            ]),
        };
        let read = |capture: &Capture, window: &WindowInfo| {
            capture.read(window, std::slice::from_ref(window))
        };
        assert_eq!(read(&capture, &window).unwrap().wsl_distro, "Ubuntu-22.04");
        window.title = "PowerShell 7".into();
        assert_eq!(read(&capture, &window).unwrap().shell, "pwsh.exe");
        capture.processes = Ok(vec![Process {
            pid: 11,
            parent: 10,
            name: "ubuntu2204.exe".into(),
            args: vec![],
        }]);
        window.title = "alice@remote:~".into();
        assert_eq!(read(&capture, &window).unwrap().wsl_distro, "Ubuntu-22.04");
        capture.processes = Ok(vec![
            Process {
                pid: 11,
                parent: 10,
                name: "wsl.exe".into(),
                args: ["wsl.exe", "-d", "Ubuntu"].map(String::from).to_vec(),
            },
            Process {
                pid: 12,
                parent: 10,
                name: "wsl.exe".into(),
                args: ["wsl.exe", "-d", "Ubuntu-22.04"].map(String::from).to_vec(),
            },
        ]);
        window.title = "bob@dev:~/work".into();
        assert_eq!(read(&capture, &window).unwrap().wsl_distro, "Ubuntu-22.04");
        window.title = "alice@remote:~".into();
        assert!(read(&capture, &window).is_err());
        // Known shell titles must not attempt discovery for another tab's launcher.
        capture.wsl = crate::wsl::Discovery::fixture(&[]);
        capture.processes = Ok(vec![Process {
            pid: 11,
            parent: 10,
            name: "ubuntu2204.exe".into(),
            args: vec![],
        }]);
        window.title = "Command Prompt".into();
        assert_eq!(read(&capture, &window).unwrap().shell, "cmd.exe");
    }

    #[test]
    fn wsl_capture_keeps_distribution_user_and_linux_directory_without_replaying_command() {
        let args = [
            "wsl.exe",
            "--distribution=Ubuntu-24.04",
            "--user",
            "alice",
            "--cd",
            "/home/alice/my work",
            "--exec",
            "rm",
            "example",
        ]
        .map(String::from);
        let terminal = from_shell("wsl.exe", &args).unwrap();
        let command = terminal
            .launch_command(&LaunchSpec {
                program: "wt.exe".into(),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            command.args,
            [
                "-w",
                "new",
                "new-tab",
                "wsl.exe",
                "--distribution",
                "Ubuntu-24.04",
                "--user",
                "alice",
                "--cd",
                "/home/alice/my work"
            ]
        );
        assert!(command.working_directory.is_empty());
    }
    #[test]
    fn konsole_launch_preserves_argument_boundaries_and_opens_separate_window() {
        struct ProfileFile(std::path::PathBuf);
        impl Drop for ProfileFile {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let file = ProfileFile(
            std::env::temp_dir().join(format!("warp-terminal-{}.profile", uuid::Uuid::new_v4())),
        );
        std::fs::write(&file.0, "[General]\nName=Development profile\n").unwrap();
        let profile_path = file.0.to_string_lossy().into_owned();
        let terminal = Terminal {
            kind: Kind::Konsole,
            profile_name: "Development profile".into(),
            profile_path: profile_path.clone(),
            shell: "/bin/bash".into(),
            shell_args: vec!["--noprofile".into()],
            working_directory: "/tmp/my work".into(),
            ..Default::default()
        };
        assert_eq!(
            terminal
                .launch_command(&LaunchSpec::default())
                .unwrap()
                .args,
            [
                "--separate",
                "--profile",
                &profile_path,
                "--workdir",
                "/tmp/my work",
                "-e",
                "/bin/bash",
                "--noprofile"
            ]
        );
    }

    #[test]
    fn missing_konsole_profile_is_reported_instead_of_opening_the_default() {
        let terminal = Terminal {
            kind: Kind::Konsole,
            profile_path: std::env::temp_dir()
                .join(format!("warp-missing-{}.profile", uuid::Uuid::new_v4()))
                .to_string_lossy()
                .into_owned(),
            ..Default::default()
        };
        assert!(terminal
            .launch_command(&LaunchSpec::default())
            .unwrap_err()
            .contains("no longer exists"));
    }

    #[test]
    fn konsole_profile_display_name_is_read_only_from_the_general_section() {
        assert_eq!(
            profile_display_name("[Other]\nName=Wrong\n[General]\nName=Development profile\n"),
            Some("Development profile")
        );
        assert_eq!(profile_display_name("[Other]\nName=Wrong\n"), None);
    }
    #[test]
    fn reuse_requires_the_saved_shell_profile_and_distribution() {
        let saved = Terminal {
            shell: "wsl.exe".into(),
            wsl_distro: "Ubuntu".into(),
            ..Default::default()
        };
        let mut other = saved.clone();
        assert!(saved.compatible(&other));
        other.wsl_distro = "Debian".into();
        assert!(!saved.compatible(&other));
        other = saved.clone();
        other.shell = "pwsh.exe".into();
        assert!(!saved.compatible(&other));
    }
    #[test]
    fn incompatible_wsl_fields_are_rejected_and_terminal_semicolons_are_literal() {
        let mut t = Terminal {
            shell: "pwsh.exe".into(),
            wsl_distro: "Ubuntu".into(),
            ..Default::default()
        };
        assert!(t.validate().is_err());
        t.wsl_distro.clear();
        t.profile_name = "One;Two".into();
        assert_eq!(
            t.launch_command(&LaunchSpec::default()).unwrap().args[4],
            "One\\;Two"
        );
    }
}
