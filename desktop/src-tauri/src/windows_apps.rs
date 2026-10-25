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
    Storage::Packaging::Appx::{
        ClosePackageInfo, GetApplicationUserModelId, GetPackageApplicationIds, GetPackageFullName,
        GetPackagesByPackageFamily, OpenPackageInfoByFullName, PackageFamilyNameFromFullName,
        _PACKAGE_INFO_REFERENCE,
    },
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

fn legacy_package_name(path: &str) -> Result<String, String> {
    use std::path::{Component, Path, Prefix};
    let invalid = || {
        "The saved path must name a file inside an absolute WindowsApps package folder. Recapture the app or enter its activation ID.".to_string()
    };
    if path.contains('\0') {
        return Err(invalid());
    }
    let mut components = Path::new(path).components();
    if !matches!(components.next(), Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        || components.next() != Some(Component::RootDir)
    {
        return Err(invalid());
    }
    let parts: Vec<_> = components
        .map(|part| match part {
            Component::Normal(value) => value.to_str().ok_or_else(invalid),
            _ => Err(invalid()),
        })
        .collect::<Result<_, _>>()?;
    let roots: Vec<_> = parts
        .iter()
        .enumerate()
        .filter(|(_, value)| value.eq_ignore_ascii_case("WindowsApps"))
        .map(|(index, _)| index)
        .collect();
    match roots.as_slice() {
        [root] if root + 2 < parts.len() => Ok(parts[root + 1].to_owned()),
        _ => Err(invalid()),
    }
}

fn package_error(operation: &str, status: u32) -> String {
    format!(
        "{operation}: {} (Windows error {status}).",
        std::io::Error::from_raw_os_error(status as i32)
    )
}

fn package_family(full_name: &str) -> Result<Vec<u16>, String> {
    let name: Vec<u16> = full_name.encode_utf16().chain(Some(0)).collect();
    let mut length = 0;
    let status = unsafe { PackageFamilyNameFromFullName(name.as_ptr(), &mut length, null_mut()) };
    if status != ERROR_INSUFFICIENT_BUFFER {
        return Err(package_error("Cannot read the saved package name", status));
    }
    let mut family = vec![0; length as usize];
    let status =
        unsafe { PackageFamilyNameFromFullName(name.as_ptr(), &mut length, family.as_mut_ptr()) };
    if status != ERROR_SUCCESS {
        return Err(package_error(
            "Cannot read the saved package family",
            status,
        ));
    }
    Ok(family)
}

// API-returned strings live in their corresponding output buffer. Copy them
// before that buffer is dropped; malformed UTF-16 remains a diagnostic error.
unsafe fn package_string(value: *const u16) -> Result<String, String> {
    let mut length = 0;
    while *value.add(length) != 0 {
        length += 1;
    }
    String::from_utf16(std::slice::from_raw_parts(value, length))
        .map_err(|e| format!("Windows returned an invalid package identity: {e}"))
}

struct PackageInfo(*mut _PACKAGE_INFO_REFERENCE);
impl Drop for PackageInfo {
    fn drop(&mut self) {
        unsafe { ClosePackageInfo(self.0) };
    }
}

fn package_applications(name: &str) -> Result<Vec<String>, String> {
    let name_wide: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
    let mut reference = null_mut();
    let status = unsafe { OpenPackageInfoByFullName(name_wide.as_ptr(), 0, &mut reference) };
    if status != ERROR_SUCCESS {
        return Err(package_error(
            &format!("Cannot inspect registered package {name}"),
            status,
        ));
    }
    let reference = PackageInfo(reference);
    let mut bytes = 0;
    let mut count = 0;
    let status =
        unsafe { GetPackageApplicationIds(reference.0, &mut bytes, null_mut(), &mut count) };
    if status == ERROR_SUCCESS && count == 0 {
        return Ok(Vec::new());
    }
    if status != ERROR_INSUFFICIENT_BUFFER {
        return Err(package_error(
            "Cannot list registered package applications",
            status,
        ));
    }
    // The byte buffer begins with an array of pointers, followed by UTF-16
    // strings. Allocate pointer-aligned storage rather than casting Vec<u8>.
    let mut storage = vec![0usize; (bytes as usize).div_ceil(std::mem::size_of::<usize>())];
    let status = unsafe {
        GetPackageApplicationIds(
            reference.0,
            &mut bytes,
            storage.as_mut_ptr().cast(),
            &mut count,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(package_error(
            "Cannot read registered package applications",
            status,
        ));
    }
    unsafe {
        std::slice::from_raw_parts(storage.as_ptr().cast::<*const u16>(), count as usize)
            .iter()
            .map(|value| package_string(*value))
            .collect()
    }
}

fn unique_application(ids: impl IntoIterator<Item = String>) -> Result<String, String> {
    let mut ids: HashSet<_> = ids.into_iter().collect();
    match ids.len() {
        0 => Err("The saved package has no registered application for this user. Install the app or recapture it after registration.".into()),
        1 => Ok(ids.drain().next().unwrap()),
        _ => Err("The saved package contains multiple registered applications. Recapture the intended app or enter its activation ID; the old path does not identify one unambiguously.".into()),
    }
}

/// Resolve a legacy versioned WindowsApps path against this user's current
/// registrations. Neither the old version nor its executable needs to exist.
pub fn resolve_legacy_path(path: &str) -> Result<String, String> {
    let family = package_family(&legacy_package_name(path)?)?;
    let mut count = 0;
    let mut length = 0;
    let status = unsafe {
        GetPackagesByPackageFamily(
            family.as_ptr(),
            &mut count,
            null_mut(),
            &mut length,
            null_mut(),
        )
    };
    if status == ERROR_SUCCESS && count == 0 {
        return unique_application(Vec::new());
    }
    if status != ERROR_INSUFFICIENT_BUFFER {
        return Err(package_error(
            "Cannot find registered versions of the saved package",
            status,
        ));
    }
    let mut names = vec![null_mut(); count as usize];
    let mut storage = vec![0u16; length as usize];
    let status = unsafe {
        GetPackagesByPackageFamily(
            family.as_ptr(),
            &mut count,
            names.as_mut_ptr(),
            &mut length,
            storage.as_mut_ptr(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(package_error(
            "Cannot read registered versions of the saved package",
            status,
        ));
    }
    let mut applications = Vec::new();
    for name in names.into_iter().take(count as usize) {
        let name = unsafe { package_string(name) }?;
        applications.extend(package_applications(&name)?);
    }
    unique_application(applications)
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
    fn legacy_paths_use_windows_package_parsing_without_requiring_old_files() {
        let full = "Microsoft.WindowsCalculator_0.0.0.1_x64__8wekyb3d8bbwe";
        for path in [
            format!("C:\\Program Files\\WindowsApps\\{full}\\CalculatorApp.exe"),
            format!("D:\\WindowsApps\\{full}\\bin\\CalculatorApp.exe"),
            format!("\\\\?\\C:\\Program Files\\WindowsApps\\{full}\\CalculatorApp.exe"),
        ] {
            let name = legacy_package_name(&path).unwrap();
            assert_eq!(name, full);
            let family = package_family(&name).unwrap();
            assert_eq!(
                unsafe { package_string(family.as_ptr()) }.unwrap(),
                "Microsoft.WindowsCalculator_8wekyb3d8bbwe"
            );
        }
        for path in [
            "C:\\Apps\\thing.exe",
            "WindowsApps\\package\\app.exe",
            "C:WindowsApps\\package\\app.exe",
            "C:\\WindowsApps\\package",
            "C:\\WindowsApps\\package\\..\\app.exe",
            "C:\\WindowsApps\\bad\0name\\app.exe",
        ] {
            assert!(legacy_package_name(path).is_err(), "{path:?}");
        }
        assert!(package_family("not-a-package-full-name").is_err());
    }
    #[test]
    fn legacy_resolution_requires_one_distinct_registered_application() {
        assert_eq!(
            unique_application(["Family!Other".into(), "Family!Other".into()]).unwrap(),
            "Family!Other"
        );
        assert!(unique_application(Vec::new())
            .unwrap_err()
            .contains("no registered application"));
        assert!(
            unique_application(["Family!One".into(), "Family!Two".into()])
                .unwrap_err()
                .contains("multiple registered applications")
        );
        let missing = resolve_legacy_path("C:\\Program Files\\WindowsApps\\WindowWarp.NonexistentLegacyFixture_1.0.0.0_x64__8wekyb3d8bbwe\\fixture.exe").unwrap_err();
        assert!(missing.contains("no registered application"), "{missing}");
    }
    #[test]
    #[ignore = "read-only query of the current user's installed Calculator registration; requires WARP_TEST_LEGACY_PACKAGED=1"]
    fn native_legacy_calculator_resolves_a_stale_version_without_launching() {
        assert_eq!(
            std::env::var("WARP_TEST_LEGACY_PACKAGED").as_deref(),
            Ok("1")
        );
        assert_eq!(resolve_legacy_path("C:\\Program Files\\WindowsApps\\Microsoft.WindowsCalculator_0.0.0.1_x64__8wekyb3d8bbwe\\CalculatorApp.exe").unwrap(), "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App");
    }
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
