//! Select the shell interface that matches the installed Windows release.

use std::{collections::HashMap, sync::LazyLock};
use windows::core::GUID;

#[path = "windows10_desktops.rs"]
mod windows10;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Backend {
    Windows10,
    Windows11Early,
    Windows11Mid,
    Windows11Late,
    Windows11Current,
    Unsupported,
}

// The Windows shell has changed these private COM vtables, sometimes while
// keeping the same interface ID. Do not treat unknown builds as compatible.
fn for_build(build: u32, revision: u32) -> Backend {
    match (build, revision) {
        (17763 | 18362 | 18363 | 19041..=19045, _) => Backend::Windows10,
        (22621, 1105..=2214) => Backend::Windows11Early,
        (22621, 2215..=3084) | (22631, 2506..=3084) => Backend::Windows11Mid,
        (22621 | 22631, 3085..) => Backend::Windows11Late,
        (26100, 2605..) | (26200, _) => Backend::Windows11Current,
        _ => Backend::Unsupported,
    }
}

fn backend() -> Backend {
    static BACKEND: LazyLock<Backend> = LazyLock::new(|| {
        use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
        let Ok(key) = RegKey::predef(HKEY_LOCAL_MACHINE)
            .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
        else {
            return Backend::Unsupported;
        };
        let build = key
            .get_value::<String, _>("CurrentBuildNumber")
            .ok()
            .and_then(|value| value.parse::<u32>().ok())
            .unwrap_or(0);
        let revision = key.get_value::<u32, _>("UBR").unwrap_or(0);
        for_build(build, revision)
    });
    *BACKEND
}

pub fn supported() -> bool {
    backend() != Backend::Unsupported
}

fn parse_id(id: &str) -> Result<GUID, String> {
    let value = uuid::Uuid::parse_str(id).map_err(|_| "The desktop is no longer available.")?;
    Ok(GUID::from_u128(value.as_u128()))
}

const UNSUPPORTED: &str = "Window Warp can't move or switch desktops on this Windows version yet. Use Windows Task View instead.";

macro_rules! current_for {
    ($lib:ident) => {
        $lib::get_current_desktop()
            .and_then(|desktop| desktop.get_id())
            .map(|id| GUID::from_u128(id.to_u128()))
            .map_err(|error| format!("Live Windows desktop query failed: {error:?}"))
    };
}

pub fn current_id() -> Result<GUID, String> {
    match backend() {
        Backend::Windows10 => windows10::current_id(),
        Backend::Windows11Early => current_for!(winvd_early),
        Backend::Windows11Mid => current_for!(winvd_mid),
        Backend::Windows11Late => current_for!(winvd_late),
        Backend::Windows11Current => current_for!(winvd),
        Backend::Unsupported => Err(UNSUPPORTED.into()),
    }
}

macro_rules! names_for {
    ($lib:ident) => {
        $lib::get_desktops().map(|desktops| {
            desktops
                .into_iter()
                .enumerate()
                .filter_map(|(index, desktop)| {
                    let id = desktop.get_id().ok()?;
                    let name = desktop
                        .get_name()
                        .ok()
                        .filter(|name| !name.trim().is_empty())
                        .unwrap_or_else(|| format!("Desktop {}", index + 1));
                    Some((format!("{:?}", GUID::from_u128(id.to_u128())), name))
                })
                .collect()
        })
    };
}

pub fn names() -> Option<HashMap<String, String>> {
    let names = match backend() {
        // Windows 10 desktop names are already read from Explorer's registry.
        Backend::Windows10 | Backend::Unsupported => return None,
        Backend::Windows11Early => names_for!(winvd_early).ok(),
        Backend::Windows11Mid => names_for!(winvd_mid).ok(),
        Backend::Windows11Late => names_for!(winvd_late).ok(),
        Backend::Windows11Current => names_for!(winvd).ok(),
    };
    names.filter(|names: &HashMap<String, String>| !names.is_empty())
}

macro_rules! switch_for {
    ($lib:ident, $bindings:ident, $id:expr) => {
        $lib::switch_desktop($bindings::core::GUID::from_u128($id.to_u128()))
            .map_err(|error| format!("Windows could not switch to that desktop: {error:?}"))
    };
}

pub fn switch(desktop: &str) -> Result<(), String> {
    let id = parse_id(desktop)?;
    match backend() {
        Backend::Windows10 => windows10::switch(&id),
        Backend::Windows11Early => switch_for!(winvd_early, windows_vd_early, id),
        Backend::Windows11Mid => switch_for!(winvd_mid, windows_vd_mid, id),
        Backend::Windows11Late => switch_for!(winvd_late, windows_vd_late, id),
        Backend::Windows11Current => switch_for!(winvd, windows_vd, id),
        Backend::Unsupported => Err(UNSUPPORTED.into()),
    }
}

macro_rules! move_for {
    ($lib:ident, $bindings:ident, $id:expr, $hwnd:expr) => {{
        let id = $bindings::core::GUID::from_u128($id.to_u128());
        let hwnd = $hwnd;
        if $lib::is_pinned_window(hwnd).unwrap_or(false)
            || $lib::is_pinned_app(hwnd).unwrap_or(false)
        {
            return Ok(());
        }
        $lib::move_window_to_desktop(id, &hwnd)
            .map_err(|error| format!("Windows could not move a workspace window: {error:?}"))?;
        if !$lib::is_window_on_desktop(id, hwnd).unwrap_or(false) {
            return Err("Windows did not move a workspace window to the requested desktop.".into());
        }
        Ok(())
    }};
}

pub fn move_window(handle: usize, desktop: &str) -> Result<(), String> {
    let id = parse_id(desktop)?;
    match backend() {
        Backend::Windows10 => windows10::move_window(handle, &id),
        Backend::Windows11Early => move_for!(
            winvd_early,
            windows_vd_early,
            id,
            windows_vd_early::Win32::Foundation::HWND(handle as isize)
        ),
        Backend::Windows11Mid => move_for!(
            winvd_mid,
            windows_vd_mid,
            id,
            windows_vd_mid::Win32::Foundation::HWND(handle as isize)
        ),
        Backend::Windows11Late => move_for!(
            winvd_late,
            windows_vd_late,
            id,
            windows_vd_late::Win32::Foundation::HWND(handle as isize)
        ),
        Backend::Windows11Current => move_for!(
            winvd,
            windows_vd,
            id,
            windows_vd::Win32::Foundation::HWND(handle as *mut std::ffi::c_void)
        ),
        Backend::Unsupported => Err(UNSUPPORTED.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selects_only_known_windows_shell_interfaces() {
        for build in [17763, 18362, 18363, 19041, 19042, 19043, 19044, 19045] {
            assert_eq!(for_build(build, 0), Backend::Windows10);
        }
        for (build, revision, expected) in [
            (17134, 0, Backend::Unsupported),
            (19046, 0, Backend::Unsupported),
            (22000, 1, Backend::Unsupported),
            (22621, 1104, Backend::Unsupported),
            (22621, 1105, Backend::Windows11Early),
            (22621, 2214, Backend::Windows11Early),
            (22621, 2215, Backend::Windows11Mid),
            (22621, 3084, Backend::Windows11Mid),
            (22621, 3085, Backend::Windows11Late),
            (22631, 2505, Backend::Unsupported),
            (22631, 2506, Backend::Windows11Mid),
            (22631, 3084, Backend::Windows11Mid),
            (22631, 3085, Backend::Windows11Late),
            (26100, 2604, Backend::Unsupported),
            (26100, 2605, Backend::Windows11Current),
            (26200, 9711, Backend::Windows11Current),
            (26300, 0, Backend::Unsupported),
        ] {
            assert_eq!(for_build(build, revision), expected, "{build}.{revision}");
        }
    }
    #[test]
    fn desktop_identity_accepts_guid_text_and_rejects_invalid_input() {
        assert_eq!(
            parse_id("{aabbccdd-0123-4567-89ab-cdef01234567}")
                .unwrap()
                .to_u128(),
            0xaabbccdd_0123_4567_89ab_cdef01234567
        );
        assert!(parse_id("not a desktop").is_err());
    }
}
