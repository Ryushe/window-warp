//! Delegate desktop-entry parsing, field codes and D-Bus activation to GIO.
use gio::prelude::*;

fn desktop_id(id: &str) -> String {
    if id.ends_with(".desktop") {
        id.to_owned()
    } else {
        format!("{id}.desktop")
    }
}

pub fn installed(id: &str) -> bool {
    gio::DesktopAppInfo::new(&desktop_id(id)).is_some()
}

pub fn launch(id: &str, uris: &[String]) -> Result<(), String> {
    let entry = gio::DesktopAppInfo::new(&desktop_id(id)).ok_or_else(|| {
        format!("Desktop entry {id} is not installed or its executable is unavailable. Review the desktop entry ID in app launch settings.")
    })?;
    // Desktop launch arguments are documents/URLs, not raw executable flags.
    // GIO owns substitution of %u/%U/%f/%F and the entry's own argument quoting.
    if !uris.is_empty() && !entry.supports_uris() && !entry.supports_files() {
        return Err(format!("Desktop entry {id} does not accept documents or URLs. Clear its arguments or select an executable launch."));
    }
    entry
        .launch_uris(
            &uris.iter().map(String::as_str).collect::<Vec<_>>(),
            None::<&gio::AppLaunchContext>,
        )
        .map_err(|e| format!("Cannot launch desktop entry {id}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_entry_reports_activation_error() {
        assert!(launch("org.windowwarp.nonexistent-test-entry", &[])
            .unwrap_err()
            .contains("not installed"));
        assert_eq!(desktop_id("org.kde.konsole"), "org.kde.konsole.desktop");
        assert_eq!(
            desktop_id("org.kde.konsole.desktop"),
            "org.kde.konsole.desktop"
        );
    }
}
