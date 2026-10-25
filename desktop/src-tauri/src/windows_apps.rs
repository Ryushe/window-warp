//! Packaged Windows application identity and shell activation. Executable paths
//! remain useful for matching, but package versions must not become launch paths.
use std::{collections::HashSet, ptr::null_mut};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::RPC_E_CHANGED_MODE,
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_LOCAL_SERVER,
            COINIT_MULTITHREADED,
        },
        UI::Shell::{ApplicationActivationManager, IApplicationActivationManager, AO_NOERRORUI},
    },
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE, HWND, LPARAM},
    Storage::Packaging::Appx::{GetApplicationUserModelId, GetPackageFullName},
    System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    },
    UI::WindowsAndMessaging::{EnumChildWindows, GetWindowThreadProcessId},
};

struct Process(HANDLE);
impl Drop for Process {
    fn drop(&mut self) {
        unsafe { CloseHandle(self.0) };
    }
}
fn process(pid: u32) -> Option<Process> {
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        None
    } else {
        Some(Process(handle))
    }
}
fn process_identity(process: &Process) -> Option<String> {
    unsafe {
        // An ordinary Win32 app can set an explicit taskbar AppUserModelID.
        // Only a process with package identity is an activation target here.
        let mut package_length = 0;
        if GetPackageFullName(process.0, &mut package_length, null_mut())
            != ERROR_INSUFFICIENT_BUFFER
        {
            return None;
        }
        let mut length = 0;
        if GetApplicationUserModelId(process.0, &mut length, null_mut())
            != ERROR_INSUFFICIENT_BUFFER
            || length == 0
        {
            return None;
        }
        let mut value = vec![0u16; length as usize];
        if GetApplicationUserModelId(process.0, &mut length, value.as_mut_ptr()) != ERROR_SUCCESS {
            return None;
        }
        let end = value.iter().position(|c| *c == 0).unwrap_or(value.len());
        let id = String::from_utf16(&value[..end]).ok()?;
        (!id.is_empty()).then_some(id)
    }
}
fn is_frame_host(process: &Process) -> bool {
    let mut value = vec![0u16; 32768];
    let mut length = value.len() as u32;
    if unsafe { QueryFullProcessImageNameW(process.0, 0, value.as_mut_ptr(), &mut length) } == 0 {
        return false;
    }
    String::from_utf16_lossy(&value[..length as usize])
        .rsplit('\\')
        .next()
        .is_some_and(|name| name.eq_ignore_ascii_case("ApplicationFrameHost.exe"))
}
unsafe extern "system" fn child_pid(hwnd: HWND, data: LPARAM) -> windows_sys::core::BOOL {
    let mut pid = 0;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid != 0 {
        (*(data as *mut HashSet<u32>)).insert(pid);
    }
    1
}

/// Returns the actual package AUMID; inaccessible or ambiguous windows have none.
/// The caller retains the top-level window's PID for window lifetime checks.
pub fn identity(hwnd: HWND) -> String {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    let Some(owner) = process(pid) else {
        return String::new();
    };
    if let Some(id) = process_identity(&owner) {
        return id;
    }
    if !is_frame_host(&owner) {
        return String::new();
    }
    // Hosted UWP windows belong to ApplicationFrameHost, while their content
    // child belongs to the packaged process. Do not guess a manifest's app ID.
    let mut children = HashSet::new();
    unsafe { EnumChildWindows(hwnd, Some(child_pid), &mut children as *mut _ as LPARAM) };
    let identities: HashSet<_> = children
        .into_iter()
        .filter(|child| *child != pid)
        .filter_map(process)
        .filter_map(|child| process_identity(&child))
        .collect();
    if identities.len() == 1 {
        identities.into_iter().next().unwrap_or_default()
    } else {
        String::new()
    }
}

/// Quote argv for the Windows command-line convention, including empty values
/// and trailing backslashes. Activation receives this string directly, no shell.
fn arguments(args: &[String]) -> String {
    args.iter()
        .map(|arg| {
            let mut quoted = String::from("\"");
            let mut slashes = 0;
            for c in arg.chars() {
                if c == '\\' {
                    slashes += 1;
                    continue;
                }
                quoted.extend(std::iter::repeat_n(
                    '\\',
                    slashes * if c == '"' { 2 } else { 1 },
                ));
                if c == '"' {
                    quoted.push('\\');
                }
                quoted.push(c);
                slashes = 0;
            }
            quoted.extend(std::iter::repeat_n('\\', slashes * 2));
            quoted.push('"');
            quoted
        })
        .collect::<Vec<_>>()
        .join(" ")
}
struct Apartment(bool);
impl Drop for Apartment {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

pub fn activate(aumid: &str, args: &[String]) -> Result<(), String> {
    if aumid.trim().is_empty() || aumid.contains('\0') || args.iter().any(|a| a.contains('\0')) {
        return Err("Invalid packaged application identity or arguments.".into());
    }
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_MULTITHREADED);
        // A caller already using an STA can activate there. Only successful
        // initialization calls (including S_FALSE) need balancing.
        let _apartment = if initialized.is_ok() {
            Apartment(true)
        } else if initialized == RPC_E_CHANGED_MODE {
            Apartment(false)
        } else {
            return Err(format!(
                "Cannot initialize packaged application activation: {initialized:?}"
            ));
        };
        let manager: IApplicationActivationManager =
            CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER).map_err(
                |e| format!("Cannot create packaged application activation manager: {e}"),
            )?;
        let id: Vec<u16> = aumid.encode_utf16().chain(Some(0)).collect();
        let command: Vec<u16> = arguments(args).encode_utf16().chain(Some(0)).collect();
        manager
            .ActivateApplication(PCWSTR(id.as_ptr()), PCWSTR(command.as_ptr()), AO_NOERRORUI)
            .map_err(|e| format!("Cannot activate packaged application {aumid}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn activation_arguments_round_trip_through_windows_parser() {
        use windows_sys::Win32::{Foundation::LocalFree, UI::Shell::CommandLineToArgvW};
        let args: Vec<String> = [
            "",
            "plain",
            "two words",
            "\t",
            "quote\"inside",
            "C:\\path with space\\",
            "slashes\\\\\"quote",
            "Unicode \u{2603}",
            "$(literal)&%value%",
        ]
        .into_iter()
        .map(String::from)
        .collect();
        // The first token has distinct executable-name parsing rules.
        let command: Vec<u16> = format!("fixture.exe {}", arguments(&args))
            .encode_utf16()
            .chain(Some(0))
            .collect();
        unsafe {
            let mut count = 0;
            let parsed = CommandLineToArgvW(command.as_ptr(), &mut count);
            assert!(!parsed.is_null());
            let actual: Vec<String> = std::slice::from_raw_parts(parsed, count as usize)
                .iter()
                .skip(1)
                .map(|value| {
                    let mut length = 0;
                    while *value.add(length) != 0 {
                        length += 1;
                    }
                    String::from_utf16(std::slice::from_raw_parts(*value, length)).unwrap()
                })
                .collect();
            LocalFree(parsed as _);
            assert_eq!(actual, args);
        }
        assert_eq!(arguments(&[]), "");
    }
    #[test]
    fn invalid_activation_input_is_rejected_before_com() {
        assert!(activate("", &[]).is_err());
        assert!(activate("package\0id", &[]).is_err());
        assert!(activate("package!app", &["bad\0arg".into()]).is_err());
    }
}
