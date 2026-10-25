use std::path::Path;

fn executable_text(path: &Path) -> Result<&str, String> {
    let text = path
        .to_str()
        .ok_or("The executable path is not valid UTF-8.")?;
    if text.contains(['\n', '\r', '\0']) {
        return Err("The executable path contains a control character.".into());
    }
    Ok(text)
}

#[cfg(windows)]
fn registry() -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let mut command = std::process::Command::new("reg.exe");
    command.creation_flags(0x08000000);
    command
}

#[cfg(windows)]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";

#[cfg(windows)]
pub fn enabled() -> Result<bool, String> {
    let output = registry()
        .args(["query", RUN_KEY, "/v", "WindowWarp"])
        .output()
        .map_err(|e| e.to_string())?;
    Ok(output.status.success())
}

#[cfg(windows)]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let mut command = registry();
    if enabled {
        let executable = std::env::current_exe().map_err(|e| e.to_string())?;
        let value = format!("\"{}\" --startup", executable_text(&executable)?);
        command.args([
            "add",
            RUN_KEY,
            "/v",
            "WindowWarp",
            "/t",
            "REG_SZ",
            "/d",
            &value,
            "/f",
        ]);
    } else {
        if !self::enabled()? {
            return Ok(());
        }
        command.args(["delete", RUN_KEY, "/v", "WindowWarp", "/f"]);
    }
    let output = command.output().map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Could not update startup: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

#[cfg(target_os = "linux")]
fn path() -> Result<std::path::PathBuf, String> {
    let root = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|p| Path::new(p).is_absolute())
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| Path::new(&p).join(".config")))
        .ok_or("Cannot find the user's configuration directory.")?;
    Ok(root.join("autostart/com.windowwarp.desktop.desktop"))
}

#[cfg(any(target_os = "linux", test))]
fn desktop_entry(executable: &Path) -> Result<String, String> {
    let text = executable_text(executable)?;
    if text.contains('=') {
        return Err("Desktop startup entries cannot use an executable path containing '='.".into());
    }
    // Desktop Entry values and the Exec quoted argument each have escaping rules.
    let quoted = text
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('`', "\\`")
        .replace('$', "\\$")
        .replace('%', "%%");
    let encoded = quoted.replace('\\', "\\\\");
    // TryExec is a filename, not an Exec command: no quotes or field expansion.
    // Keep the preference dormant if the package is later removed.
    let try_exec = text.replace('\\', "\\\\");
    Ok(format!("[Desktop Entry]\nType=Application\nName=Window Warp\nTryExec={try_exec}\nExec=\"{encoded}\" --startup\nTerminal=false\nOnlyShowIn=KDE;\nX-KDE-autostart-after=panel\n"))
}

#[cfg(target_os = "linux")]
pub fn enabled() -> Result<bool, String> {
    match std::fs::read_to_string(path()?) {
        Ok(text) => Ok(!text.lines().any(|line| line.trim() == "Hidden=true")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(target_os = "linux")]
pub fn set_enabled(enabled: bool) -> Result<(), String> {
    let path = path()?;
    if enabled {
        let text = desktop_entry(&std::env::current_exe().map_err(|e| e.to_string())?)?;
        std::fs::create_dir_all(path.parent().ok_or("Invalid startup path")?)
            .map_err(|e| e.to_string())?;
        let temporary = path.with_extension("tmp");
        std::fs::write(&temporary, text).map_err(|e| e.to_string())?;
        std::fs::rename(temporary, path).map_err(|e| e.to_string())?;
    } else if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            return Err(error.to_string());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_entry_preserves_spaces_and_prevents_field_expansion() {
        let entry = desktop_entry(Path::new("/home/person/My Apps/100% Warp")).unwrap();
        assert!(entry.contains("Exec=\"/home/person/My Apps/100%% Warp\" --startup\n"));
        assert!(entry.contains("TryExec=/home/person/My Apps/100% Warp\n"));
        assert!(desktop_entry(Path::new("/tmp/app\nHidden=true")).is_err());
        let escaped = desktop_entry(Path::new("/tmp/$quoted\"app")).unwrap();
        assert!(escaped.contains("\\\\$quoted\\\\\"app"));
    }
}
