//! While Warp is on, move conflicting KDE shortcuts aside and put them back
//! when it pauses. Recording blocks global shortcuts so the editor receives
//! Meta chords, the same way System Settings does.

use crate::config::Config;
use std::sync::Mutex;

struct Borrowed {
    action: Vec<String>,
    keys: Vec<i32>,
    pause: bool,
}

static BORROWED: Mutex<Vec<Borrowed>> = Mutex::new(Vec::new());
static RECORDING: Mutex<bool> = Mutex::new(false);

pub fn borrowing() -> bool {
    BORROWED.lock().map(|items| !items.is_empty()).unwrap_or(false)
}

pub fn begin(config: &Config) -> Result<(), String> {
    restore()?;
    let mut borrowed = Vec::new();
    for binding in config.bindings.iter().filter(|binding| binding.enabled) {
        let Some(key) = qt_key(&binding.shortcut) else {
            continue;
        };
        let owner = action_for(key)?;
        if owner.is_empty() || owner.iter().any(|part| part.contains("window-warp")) {
            continue;
        }
        let keys = shortcut_keys(&owner)?;
        set_foreign(&owner, &[])?;
        borrowed.push(Borrowed {
            pause: binding.action == "toggle-pause",
            action: owner,
            keys,
        });
    }
    *BORROWED.lock().map_err(|error| error.to_string())? = borrowed;
    Ok(())
}

pub fn takes_pause() -> bool {
    BORROWED
        .lock()
        .map(|items| items.iter().any(|item| item.pause))
        .unwrap_or(false)
}

pub fn others_own(shortcuts: &[String]) -> Result<bool, String> {
    for shortcut in shortcuts {
        let Some(key) = qt_key(shortcut) else {
            continue;
        };
        let owner = action_for(key)?;
        if !owner.is_empty() && owner.iter().all(|part| !part.contains("window-warp")) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub fn restore() -> Result<(), String> {
    let items = std::mem::take(&mut *BORROWED.lock().map_err(|error| error.to_string())?);
    let mut errors = Vec::new();
    for item in items {
        if let Err(error) = set_foreign(&item.action, &item.keys) {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

pub fn set_recording(blocked: bool) -> Result<(), String> {
    let mut recording = RECORDING.lock().map_err(|error| error.to_string())?;
    if *recording == blocked {
        return Ok(());
    }
    let _: () = with_registry(|registry| {
        registry.call("blockGlobalShortcuts", &blocked).map_err(|error| {
            format!("Cannot reach KDE shortcut recording: {error}")
        })
    })?;
    *recording = blocked;
    Ok(())
}

fn with_registry<T>(
    use_registry: impl FnOnce(&zbus::blocking::Proxy) -> Result<T, String>,
) -> Result<T, String> {
    let connection = zbus::blocking::connection::Builder::session()
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    let registry = zbus::blocking::Proxy::new(
        &connection,
        "org.kde.kglobalaccel",
        "/kglobalaccel",
        "org.kde.KGlobalAccel",
    )
    .map_err(|error| error.to_string())?;
    use_registry(&registry)
}

fn action_for(key: i32) -> Result<Vec<String>, String> {
    with_registry(|registry| {
        registry.call("action", &key).map_err(|error| {
            format!("Cannot inspect the KDE shortcut for this key: {error}")
        })
    })
}

fn shortcut_keys(action: &[String]) -> Result<Vec<i32>, String> {
    let action = action.to_vec();
    with_registry(|registry| {
        registry.call("shortcut", &(action,)).map_err(|error| {
            format!("Cannot read the previous KDE shortcut: {error}")
        })
    })
}

fn set_foreign(action: &[String], keys: &[i32]) -> Result<(), String> {
    let action = action.to_vec();
    let keys = keys.to_vec();
    with_registry(|registry| {
        let _: () = registry
            .call("setForeignShortcut", &(action, keys))
            .map_err(|error| format!("Cannot move the previous KDE shortcut aside: {error}"))?;
        Ok(())
    })
}

pub fn qt_key(shortcut: &str) -> Option<i32> {
    let mut parts: Vec<_> = shortcut.split('+').collect();
    let key = parts.pop()?;
    let code = match key {
        "Left" => 0x01000012,
        "Right" => 0x01000014,
        "Up" => 0x01000013,
        "Down" => 0x01000015,
        "Space" => 0x20,
        "Tab" => 0x01000001,
        "Enter" => 0x01000004,
        "Escape" => 0x01000000,
        "Backspace" => 0x01000003,
        "Delete" => 0x01000007,
        "Insert" => 0x01000006,
        "Home" => 0x01000010,
        "End" => 0x01000011,
        "PageUp" => 0x01000016,
        "PageDown" => 0x01000017,
        "Semicolon" => 0x3b,
        "Quote" => 0x27,
        "Backquote" => 0x60,
        "Comma" => 0x2c,
        "Period" => 0x2e,
        "Slash" => 0x2f,
        "Backslash" => 0x5c,
        "Minus" => 0x2d,
        "Equal" => 0x3d,
        "BracketLeft" => 0x5b,
        "BracketRight" => 0x5d,
        other if other.len() == 1 => other.as_bytes()[0] as i32,
        other => {
            let number = other.strip_prefix('F')?.parse::<i32>().ok()?;
            if (1..=24).contains(&number) {
                0x0100002f + number
            } else {
                return None;
            }
        }
    };
    let mut value = code;
    if parts.contains(&"Shift") {
        value |= 0x0200_0000;
    }
    if parts.contains(&"Ctrl") {
        value |= 0x0400_0000;
    }
    if parts.contains(&"Alt") {
        value |= 0x0800_0000;
    }
    if parts.contains(&"Super") {
        value |= 0x1000_0000;
    }
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kde_key_codes_match_meta_and_modified_chords() {
        assert_eq!(qt_key("Super+Semicolon"), Some(0x1000_003b));
        assert_eq!(qt_key("Ctrl+Super+D"), Some(0x1400_0044));
        assert_eq!(qt_key("Super+F1"), Some(0x1100_0030));
        assert_eq!(qt_key(""), None);
    }
}
