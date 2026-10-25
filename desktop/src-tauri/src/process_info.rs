//! Read argument boundaries rather than guessing from a window's title.
#[cfg(target_os = "linux")]
pub fn arguments(pid: u32) -> Result<Vec<String>, String> {
    let bytes = std::fs::read(format!("/proc/{pid}/cmdline")).map_err(|e| e.to_string())?;
    Ok(split_linux_command_line(&bytes))
}

#[cfg(any(target_os = "linux", test))]
fn split_linux_command_line(bytes: &[u8]) -> Vec<String> {
    if bytes.is_empty() {
        return Vec::new();
    }
    // Only the final NUL terminates the vector; every earlier NUL separates
    // arguments, including explicitly empty arguments supplied by the user.
    bytes
        .strip_suffix(&[0])
        .unwrap_or(bytes)
        .split(|b| *b == 0)
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect()
}

#[cfg(windows)]
pub fn arguments(pid: u32) -> Result<Vec<String>, String> {
    // PID is an integer obtained from Win32, never interpolated user text.
    let script = format!(
        "(Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}' -ErrorAction Stop).CommandLine"
    );
    split_windows_command_line(cim_query(&script)?.trim())
}

#[cfg(windows)]
pub struct Process {
    pub pid: u32,
    pub parent: u32,
    pub name: String,
    pub args: Vec<String>,
}

/// One bounded query per capture, shared by all Terminal windows.
#[cfg(windows)]
pub fn snapshot() -> Result<Vec<Process>, String> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct Row {
        process_id: u32,
        parent_process_id: u32,
        name: String,
        command_line: Option<String>,
    }
    let output = cim_query("ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId,Name,CommandLine)")?;
    let rows: Vec<Row> = serde_json::from_str(output.trim())
        .map_err(|e| format!("Cannot read terminal process metadata: {e}"))?;
    rows.into_iter()
        .map(|row| {
            Ok(Process {
                pid: row.process_id,
                parent: row.parent_process_id,
                name: row.name,
                args: split_windows_command_line(row.command_line.as_deref().unwrap_or(""))?,
            })
        })
        .collect()
}

#[cfg(windows)]
fn cim_query(query: &str) -> Result<String, String> {
    let script = format!("[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); {query}");
    metadata_output(
        "powershell.exe",
        &["-NoProfile", "-NonInteractive", "-Command", &script],
        std::time::Duration::from_secs(5),
    )
    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// Bounded, noninteractive metadata queries used by CIM and WSL discovery.
#[cfg(windows)]
pub fn metadata_output(
    program: &str,
    args: &[&str],
    timeout: std::time::Duration,
) -> Result<Vec<u8>, String> {
    use std::os::windows::process::CommandExt;
    let mut child = std::process::Command::new(program)
        .args(args)
        .creation_flags(0x08000000)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("Cannot read process metadata output.")?;
    let reader = std::thread::spawn(move || {
        use std::io::Read;
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).map(|_| bytes)
    });
    let deadline = std::time::Instant::now() + timeout;
    while child.try_wait().map_err(|e| e.to_string())?.is_none() {
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Timed out reading metadata from {program}."));
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let output = reader
        .join()
        .map_err(|_| "Cannot read process metadata.")?
        .map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("Cannot read metadata from {program}."));
    }
    Ok(output)
}

#[cfg(windows)]
fn split_windows_command_line(command: &str) -> Result<Vec<String>, String> {
    if command.is_empty() {
        return Ok(Vec::new());
    }
    let text: Vec<u16> = command.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let mut count = 0;
        let args = windows_sys::Win32::UI::Shell::CommandLineToArgvW(text.as_ptr(), &mut count);
        if args.is_null() {
            return Err("Cannot parse application arguments.".into());
        }
        let result = std::slice::from_raw_parts(args, count as usize)
            .iter()
            .map(|arg| {
                let mut length = 0;
                while *(*arg).add(length) != 0 {
                    length += 1;
                }
                String::from_utf16_lossy(std::slice::from_raw_parts(*arg, length))
            })
            .collect();
        windows_sys::Win32::Foundation::LocalFree(args as *mut _);
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn linux_command_line_preserves_empty_argument_boundaries() {
        assert_eq!(
            super::split_linux_command_line(b"konsole\0-e\0wrapper\0"),
            ["konsole", "-e", "wrapper"]
        );
        assert_eq!(
            super::split_linux_command_line(b"wrapper\0\0bash\0"),
            ["wrapper", "", "bash"]
        );
        assert_eq!(
            super::split_linux_command_line(b"wrapper\0\0"),
            ["wrapper", ""]
        );
        assert_eq!(
            super::split_linux_command_line(b"wrapper\0\0\0"),
            ["wrapper", "", ""]
        );
        assert_eq!(super::split_linux_command_line(b"wrapper"), ["wrapper"]);
        assert!(super::split_linux_command_line(b"").is_empty());
    }
    #[cfg(windows)]
    #[test]
    fn current_process_arguments_are_read_through_cim() {
        let args = super::arguments(std::process::id()).unwrap();
        assert_eq!(
            std::path::Path::new(&args[0]).file_name(),
            std::env::current_exe().unwrap().file_name()
        );
    }
    #[cfg(windows)]
    #[test]
    fn quoted_profile_paths_and_empty_arguments_keep_boundaries() {
        assert_eq!(
            super::split_windows_command_line(
                r#""C:\Program Files\Firefox\firefox.exe" -profile "C:\My Profiles\one" """#
            )
            .unwrap(),
            [
                r"C:\Program Files\Firefox\firefox.exe",
                "-profile",
                r"C:\My Profiles\one",
                ""
            ]
        );
    }
}
