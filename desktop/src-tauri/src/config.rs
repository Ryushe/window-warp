use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub label: String,
    pub shortcut: String,
    pub action: String,
    #[serde(default)]
    pub app_match: String,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Settings {
    pub main_monitor: usize,
    pub burner_monitor: usize,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            main_monitor: 0,
            burner_monitor: 2,
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

impl Default for Config {
    fn default() -> Self {
        let entries = [
            ("Push window left", "Ctrl+Alt+Left", "push-left"),
            ("Push window right", "Ctrl+Alt+Right", "push-right"),
            ("Pull last window back", "Ctrl+Alt+Down", "pull"),
            ("Tile left", "Ctrl+Alt+J", "tile-left"),
            ("Tile right", "Ctrl+Alt+L", "tile-right"),
        ];
        Self {
            version: 1,
            settings: Settings::default(),
            bindings: entries
                .iter()
                .map(|(label, shortcut, action)| Binding {
                    label: label.to_string(),
                    shortcut: shortcut.to_string(),
                    action: action.to_string(),
                    app_match: String::new(),
                    enabled: true,
                    main_monitor_action: burner(),
                    burner_layout: floating(),
                })
                .collect(),
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
                "pull",
                "tile-left",
                "tile-right",
                "focus-app",
                "pull-app",
                "tile-up",
                "tile-down",
                "toggle-maximize",
                "close-window",
            ]
            .contains(&binding.action.as_str())
            {
                return Err(format!("Unknown action: {}", binding.action));
            }
            if ["focus-app", "pull-app"].contains(&binding.action.as_str())
                && (binding.app_match.is_empty() || binding.app_match.len() > 256)
            {
                return Err("App switching needs an executable name on Windows or a resource class on KDE (maximum 256 characters).".into());
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
    fn reassignment_disables_only_enabled_alias_conflicts_and_preserves_edits() {
        let mut config = Config::default();
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
