use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub label: String,
    pub shortcut: String,
    pub action: String,
    #[serde(default)]
    pub app_match: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub windows_match: Option<crate::window_match::WindowsMatch>,
    #[serde(default = "yes")]
    pub enabled: bool,
    #[serde(default = "burner")]
    pub main_monitor_action: String,
    #[serde(default = "floating")]
    pub burner_layout: String,
}

fn yes() -> bool {
    true
}
fn burner() -> String {
    "burner".into()
}
fn floating() -> String {
    "float".into()
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Settings {
    pub main_monitor: usize,
    pub burner_monitor: usize,
    pub hold_delay_ms: u64,
    pub hold_tile_enabled: bool,
    pub hold_mode: String,
    pub enable_on_launch: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            main_monitor: 0,
            burner_monitor: 2,
            hold_delay_ms: 400,
            hold_tile_enabled: true,
            hold_mode: "tile".into(),
            enable_on_launch: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub version: u32,
    pub bindings: Vec<Binding>,
    #[serde(default)]
    pub settings: Settings,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reassignment {
    pub config: Config,
    pub disabled_indices: Vec<usize>,
}

fn shortcut(
    label: &str,
    keys: &str,
    action: &str,
    app: &str,
    main_monitor_action: &str,
    burner_layout: &str,
) -> Binding {
    Binding {
        label: label.into(),
        shortcut: keys.into(),
        action: action.into(),
        app_match: app.into(),
        windows_match: None,
        enabled: true,
        main_monitor_action: main_monitor_action.into(),
        burner_layout: burner_layout.into(),
    }
}

impl Default for Config {
    fn default() -> Self {
        // Same keys as the AutoHotkey scripts: Win is stored as Super.
        Self {
            version: 1,
            settings: Settings::default(),
            bindings: vec![
                shortcut(
                    "Push window left",
                    "Super+X",
                    "push-left",
                    "",
                    "burner",
                    "float",
                ),
                shortcut(
                    "Push window right",
                    "Super+C",
                    "push-right",
                    "",
                    "burner",
                    "float",
                ),
                shortcut(
                    "Push left and center pointer",
                    "Ctrl+Super+X",
                    "push-left-center",
                    "",
                    "burner",
                    "float",
                ),
                shortcut(
                    "Push right and center pointer",
                    "Ctrl+Super+C",
                    "push-right-center",
                    "",
                    "burner",
                    "float",
                ),
                shortcut(
                    "Pull last window back",
                    "Super+R",
                    "pull",
                    "",
                    "burner",
                    "float",
                ),
                shortcut(
                    "Edit current app shortcut",
                    "Super+B",
                    "open-editor",
                    "",
                    "burner",
                    "float",
                ),
                shortcut(
                    "Browse workspaces",
                    "Super+O",
                    "open-workspaces",
                    "",
                    "burner",
                    "float",
                ),
                shortcut(
                    "Update workspace",
                    "Super+Y",
                    "update-workspace",
                    "",
                    "burner",
                    "float",
                ),
                shortcut(
                    "Pause / resume shortcuts",
                    "Super+Semicolon",
                    "toggle-pause",
                    "",
                    "burner",
                    "float",
                ),
                shortcut(
                    "Maximize / restore",
                    "Super+Z",
                    "toggle-maximize",
                    "",
                    "burner",
                    "float",
                ),
                shortcut(
                    "Close active window",
                    "Super+Q",
                    "close-window",
                    "",
                    "burner",
                    "float",
                ),
                shortcut(
                    "Discord",
                    "Super+D",
                    "pull-app",
                    "Discord.exe",
                    "burner",
                    "tile-left",
                ),
                shortcut(
                    "Caido",
                    "Super+P",
                    "pull-app",
                    "Caido.exe",
                    "focus-last",
                    "float",
                ),
                shortcut(
                    "Claude",
                    "Super+A",
                    "pull-app",
                    "Claude.exe",
                    "burner",
                    "tile-right",
                ),
                shortcut(
                    "Firefox",
                    "Super+S",
                    "pull-app",
                    "firefox.exe",
                    "focus-last",
                    "float",
                ),
                shortcut(
                    "Windows Terminal",
                    "Super+T",
                    "pull-app",
                    "WindowsTerminal.exe",
                    "burner",
                    "float",
                ),
                shortcut(
                    "studio64",
                    "Ctrl+Super+D",
                    "pull-app",
                    "studio64.exe",
                    "burner",
                    "float",
                ),
                shortcut(
                    "Telegram",
                    "Ctrl+Super+T",
                    "pull-app",
                    "Telegram.exe",
                    "focus-last",
                    "float",
                ),
                shortcut(
                    "Explorer",
                    "Super+E",
                    "pull-app",
                    "explorer.exe",
                    "focus-last",
                    "float",
                ),
                shortcut(
                    "Code",
                    "Super+F",
                    "pull-app",
                    "Code.exe",
                    "focus-last",
                    "float",
                ),
                shortcut(
                    "ChatGPT",
                    "Super+W",
                    "pull-app",
                    "ChatGPT.exe",
                    "focus-last",
                    "float",
                ),
            ],
        }
    }
}

impl Config {
    /// Return an editable proposal; persistence and full validation happen on Save.
    pub fn preview_reassignment(mut self, index: usize) -> Result<Reassignment, String> {
        let chosen = self
            .bindings
            .get(index)
            .ok_or("Shortcut no longer exists.")?;
        let shortcut = normalize_shortcut(&chosen.shortcut)?;
        let mut disabled_indices = Vec::new();
        for (other_index, binding) in self.bindings.iter_mut().enumerate() {
            if other_index != index
                && binding.enabled
                && normalize_shortcut(&binding.shortcut).ok().as_ref() == Some(&shortcut)
            {
                binding.enabled = false;
                disabled_indices.push(other_index);
            }
        }
        self.bindings[index].shortcut = shortcut;
        self.bindings[index].enabled = true;
        Ok(Reassignment {
            config: self,
            disabled_indices,
        })
    }

    pub fn validate(&mut self) -> Result<(), String> {
        if self.version != 1 {
            return Err("Unsupported settings version.".into());
        }
        if self.bindings.len() > 100 {
            return Err("Use at most 100 shortcuts.".into());
        }
        if !(100..=5000).contains(&self.settings.hold_delay_ms) {
            return Err("Choose a hold delay between 100 and 5000 milliseconds.".into());
        }
        if !["tile", "radial"].contains(&self.settings.hold_mode.as_str()) {
            return Err(
                "Choose mouse tiling or the radial window picker for holding an app shortcut."
                    .into(),
            );
        }
        if self.settings.main_monitor > 32
            || self.settings.burner_monitor > 32
            || self.settings.burner_monitor == 0
        {
            return Err("Choose a main monitor from 0–32 and a burner monitor from 1–32. Zero selects the primary monitor.".into());
        }
        let mut seen = HashSet::new();
        for binding in &mut self.bindings {
            binding.label = binding.label.trim().to_string();
            binding.app_match = binding.app_match.trim().to_string();
            if binding.label.is_empty() || binding.label.len() > 120 {
                return Err("Each shortcut needs a label of 1–120 characters.".into());
            }
            if ![
                "push-left",
                "push-right",
                "push-left-center",
                "push-right-center",
                "pull",
                "tile-left",
                "tile-right",
                "focus-app",
                "pull-app",
                "tile-up",
                "tile-down",
                "toggle-maximize",
                "close-window",
                "toggle-pause",
                "open-editor",
                "open-workspaces",
                "update-workspace",
            ]
            .contains(&binding.action.as_str())
            {
                return Err(format!("Unknown action: {}", binding.action));
            }
            if ["focus-app", "pull-app"].contains(&binding.action.as_str()) {
                if let Some(selector) = &mut binding.windows_match {
                    selector.validate()?;
                    if !cfg!(windows) && binding.enabled {
                        return Err("Windows window-match rules cannot be enabled on KDE. Turn off Windows matching and enter a KDE app identifier first.".into());
                    }
                }
            }
            if ["focus-app", "pull-app"].contains(&binding.action.as_str())
                && binding.windows_match.is_none()
                && (binding.app_match.is_empty()
                    || binding.app_match.len() > 32768
                    || binding.app_match.contains('\0'))
            {
                return Err("App switching needs an executable name/path or packaged app ID on Windows, or a resource class/desktop ID on KDE.".into());
            }
            if !["burner", "focus-last"].contains(&binding.main_monitor_action.as_str())
                || !["float", "tile-left", "tile-right", "fullscreen"]
                    .contains(&binding.burner_layout.as_str())
            {
                return Err("Choose a valid main monitor action and burner layout.".into());
            }
            binding.shortcut = normalize_shortcut(&binding.shortcut)?;
            if binding.enabled && !seen.insert(binding.shortcut.clone()) {
                return Err(format!("Duplicate shortcut: {}", binding.shortcut));
            }
        }
        Ok(())
    }
}

fn normalize_shortcut(value: &str) -> Result<String, String> {
    let parts: Vec<_> = value.split('+').map(str::trim).collect();
    if parts.len() < 2 {
        return Err("Use a modifier plus a key, such as Ctrl+Alt+J.".into());
    }
    let mut mods = HashSet::new();
    for part in &parts[..parts.len() - 1] {
        let canonical = match part.to_lowercase().as_str() {
            "ctrl" | "control" => "Ctrl",
            "alt" => "Alt",
            "shift" => "Shift",
            "super" | "win" | "meta" => "Super",
            _ => return Err(format!("Unknown modifier: {part}")),
        };
        if !mods.insert(canonical) {
            return Err(format!("Repeated modifier: {part}"));
        }
    }
    let raw = parts.last().unwrap().to_uppercase();
    let key = match raw.as_str() {
        "LEFT" => "Left".into(),
        "RIGHT" => "Right".into(),
        "UP" => "Up".into(),
        "DOWN" => "Down".into(),
        "SPACE" => "Space".into(),
        "TAB" => "Tab".into(),
        "ENTER" | "RETURN" => "Enter".into(),
        "ESC" | "ESCAPE" => "Escape".into(),
        "BACKSPACE" => "Backspace".into(),
        "DELETE" => "Delete".into(),
        "INSERT" => "Insert".into(),
        "HOME" => "Home".into(),
        "END" => "End".into(),
        "PAGEUP" => "PageUp".into(),
        "PAGEDOWN" => "PageDown".into(),
        ";" | "SEMICOLON" => "Semicolon".into(),
        "'" | "QUOTE" => "Quote".into(),
        "`" | "BACKQUOTE" => "Backquote".into(),
        "," | "COMMA" => "Comma".into(),
        "." | "PERIOD" => "Period".into(),
        "/" | "SLASH" => "Slash".into(),
        "\\" | "BACKSLASH" => "Backslash".into(),
        "-" | "MINUS" => "Minus".into(),
        "=" | "EQUAL" => "Equal".into(),
        "[" | "BRACKETLEFT" => "BracketLeft".into(),
        "]" | "BRACKETRIGHT" => "BracketRight".into(),
        _ if raw.len() == 1 && raw.as_bytes()[0].is_ascii_alphanumeric() => raw,
        _ if raw
            .strip_prefix('F')
            .and_then(|s| s.parse::<u8>().ok())
            .is_some_and(|n| (1..=24).contains(&n)) =>
        {
            format!("F{}", raw[1..].parse::<u8>().unwrap())
        }
        _ => return Err("Use a letter, digit, punctuation, navigation key, or F1–F24.".into()),
    };
    let mut result: Vec<_> = ["Ctrl", "Alt", "Shift", "Super"]
        .into_iter()
        .filter(|m| mods.contains(m))
        .collect();
    result.push(&key);
    Ok(result.join("+"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fresh_configuration_uses_the_autohotkey_shortcuts() {
        let mut config = Config::default();
        config.validate().unwrap();
        let shown: Vec<_> = config
            .bindings
            .iter()
            .map(|binding| {
                (
                    binding.shortcut.as_str(),
                    binding.action.as_str(),
                    binding.app_match.as_str(),
                    binding.main_monitor_action.as_str(),
                    binding.burner_layout.as_str(),
                )
            })
            .collect();
        assert_eq!(
            shown,
            vec![
                ("Super+X", "push-left", "", "burner", "float"),
                ("Super+C", "push-right", "", "burner", "float"),
                ("Ctrl+Super+X", "push-left-center", "", "burner", "float"),
                ("Ctrl+Super+C", "push-right-center", "", "burner", "float"),
                ("Super+R", "pull", "", "burner", "float"),
                ("Super+B", "open-editor", "", "burner", "float"),
                ("Super+O", "open-workspaces", "", "burner", "float"),
                ("Super+Y", "update-workspace", "", "burner", "float"),
                ("Super+Semicolon", "toggle-pause", "", "burner", "float"),
                ("Super+Z", "toggle-maximize", "", "burner", "float"),
                ("Super+Q", "close-window", "", "burner", "float"),
                ("Super+D", "pull-app", "Discord.exe", "burner", "tile-left"),
                ("Super+P", "pull-app", "Caido.exe", "focus-last", "float"),
                ("Super+A", "pull-app", "Claude.exe", "burner", "tile-right"),
                ("Super+S", "pull-app", "firefox.exe", "focus-last", "float"),
                (
                    "Super+T",
                    "pull-app",
                    "WindowsTerminal.exe",
                    "burner",
                    "float"
                ),
                (
                    "Ctrl+Super+D",
                    "pull-app",
                    "studio64.exe",
                    "burner",
                    "float"
                ),
                (
                    "Ctrl+Super+T",
                    "pull-app",
                    "Telegram.exe",
                    "focus-last",
                    "float"
                ),
                ("Super+E", "pull-app", "explorer.exe", "focus-last", "float"),
                ("Super+F", "pull-app", "Code.exe", "focus-last", "float"),
                ("Super+W", "pull-app", "ChatGPT.exe", "focus-last", "float"),
            ]
        );
    }
    #[test]
    fn reassignment_disables_only_enabled_alias_conflicts_and_preserves_edits() {
        let mut config = Config::default();
        // Keep this fixture independent of the default pause shortcut.
        config.bindings.truncate(5);
        config.bindings[0].shortcut = "Super+Semicolon".into();
        config.bindings[1].shortcut = "win+;".into();
        config.bindings[1].enabled = false;
        config.bindings[2].shortcut = "Meta+Semicolon".into();
        config.bindings[3].shortcut = "win+;".into();
        config.bindings[3].enabled = false;
        config.bindings[4].label = "Unsaved edit".into();
        let proposal = config.preview_reassignment(1).unwrap();
        assert_eq!(proposal.disabled_indices, [0, 2]);
        assert!(proposal.config.bindings[1].enabled);
        assert_eq!(proposal.config.bindings[1].shortcut, "Super+Semicolon");
        assert!(!proposal.config.bindings[3].enabled);
        assert_eq!(proposal.config.bindings[4].label, "Unsaved edit");
        assert_eq!(proposal.config.bindings[0].shortcut, "Super+Semicolon");
        let mut validated = proposal.config;
        validated.validate().unwrap();
        assert!(validated.preview_reassignment(100).is_err());
    }
    #[test]
    fn aliases_and_order_cannot_hide_conflicts() {
        let mut config = Config::default();
        config.bindings[0].shortcut = "alt+control+left".into();
        config.bindings[1].shortcut = "Ctrl+Alt+Left".into();
        assert!(config.validate().unwrap_err().contains("Duplicate"));
    }
    #[test]
    fn rejects_empty_app_match_and_unsupported_versions() {
        let mut config = Config::default();
        config.bindings[0].action = "focus-app".into();
        assert!(config.validate().is_err());
        config.version = 2;
        assert!(config.validate().is_err());
    }
    #[test]
    fn windows_selectors_survive_disabled_import_and_require_platform_adaptation() {
        let mut config = Config::default();
        let b = &mut config.bindings[0];
        b.action = "pull-app".into();
        b.enabled = false;
        b.windows_match = Some(crate::window_match::WindowsMatch {
            class_name: "ExactClass".into(),
            window_id: Some("0x12345678".into()),
            ..Default::default()
        });
        config.validate().unwrap();
        let serialized = serde_json::to_string(&config).unwrap();
        let mut reread: Config = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            reread.bindings[0]
                .windows_match
                .as_ref()
                .unwrap()
                .window_id
                .as_deref(),
            Some("305419896")
        );
        reread.bindings[0].enabled = true;
        assert_eq!(reread.validate().is_ok(), cfg!(windows));
        reread.bindings[0].windows_match = None;
        reread.bindings[0].app_match = "org.kde.konsole".into();
        assert!(reread.validate().is_ok());
    }
    #[test]
    fn switching_to_a_non_app_action_does_not_validate_hidden_match_fields() {
        let mut config = Config::default();
        config.bindings[0].windows_match = Some(Default::default());
        assert!(config.validate().is_ok());
        config.bindings[0].action = "pull-app".into();
        assert!(config
            .validate()
            .unwrap_err()
            .contains("at least one criterion"));
    }

    #[test]
    fn function_key_aliases_share_one_canonical_binding() {
        assert_eq!(normalize_shortcut("win+f01").unwrap(), "Super+F1");
        assert!(normalize_shortcut("Ctrl+F25").is_err());
    }
    #[test]
    fn preview_settings_migrate_without_losing_bindings() {
        let mut config: Config = serde_json::from_str(r#"{"version":1,"bindings":[{"label":"App","shortcut":"Win+;","action":"focus-app","appMatch":"firefox"}]}"#).unwrap();
        config.validate().unwrap();
        assert!(config.bindings[0].enabled);
        assert_eq!(config.bindings[0].shortcut, "Super+Semicolon");
        assert_eq!(config.settings.burner_monitor, 2);
        assert_eq!(config.settings.hold_delay_ms, 400);
        assert_eq!(config.settings.hold_mode, "tile");
        assert!(config.settings.hold_tile_enabled);
    }
    #[test]
    fn hold_settings_validate_and_round_trip() {
        let mut config = Config::default();
        for delay in [100, 400, 5000] {
            config.settings.hold_delay_ms = delay;
            config.settings.hold_tile_enabled = false;
            config.settings.hold_mode = "radial".into();
            config.validate().unwrap();
            let loaded: Config =
                serde_json::from_str(&serde_json::to_string(&config).unwrap()).unwrap();
            assert_eq!(loaded.settings.hold_delay_ms, delay);
            assert!(!loaded.settings.hold_tile_enabled);
            assert_eq!(loaded.settings.hold_mode, "radial");
        }
        for delay in [0, 99, 5001, u64::MAX] {
            config.settings.hold_delay_ms = delay;
            assert!(config.validate().unwrap_err().contains("hold delay"));
        }
    }
    #[test]
    fn disabled_binding_can_keep_an_assigned_key() {
        let mut config = Config::default();
        config.bindings[1].shortcut = config.bindings[0].shortcut.clone();
        config.bindings[1].enabled = false;
        config.validate().unwrap();
        config.bindings[1].enabled = true;
        assert!(config.validate().is_err());
    }
}
