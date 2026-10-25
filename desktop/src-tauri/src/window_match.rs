//! One window predicate for app actions and the radial candidate list.
use crate::{config::Binding, workspaces::WindowInfo};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct WindowsMatch {
    pub title_contains: String,
    pub class_name: String,
    pub executable: String,
    pub packaged_app_id: String,
    pub process_id: Option<u32>,
    pub window_id: Option<String>,
    pub active_only: bool,
}

impl WindowsMatch {
    pub fn validate(&mut self) -> Result<(), String> {
        if self.title_contains.is_empty()
            && self.class_name.is_empty()
            && self.executable.is_empty()
            && self.packaged_app_id.is_empty()
            && self.process_id.is_none()
            && self.window_id.is_none()
            && !self.active_only
        {
            return Err("Windows window matching needs at least one criterion. Enter a title, class, executable or window identity, or turn it off to use an app identifier.".into());
        }
        for (value, maximum) in [
            (&self.title_contains, 16000),
            (&self.class_name, 1024),
            (&self.executable, 32768),
            (&self.packaged_app_id, 32768),
        ] {
            if value.contains('\0') || value.len() > maximum {
                return Err("A Windows window-match criterion is invalid or too long.".into());
            }
        }
        if let Some(id) = &mut self.window_id {
            let value = id.strip_prefix("0x").or_else(|| id.strip_prefix("0X"));
            let parsed = if let Some(hex) = value {
                u64::from_str_radix(hex, 16)
            } else {
                id.parse::<u64>()
            }
            .map_err(|_| {
                "Window ID must be an unsigned decimal or hexadecimal integer.".to_string()
            })?;
            *id = parsed.to_string();
        }
        Ok(())
    }

    pub fn matches(&self, window: &WindowInfo) -> bool {
        window.title.contains(&self.title_contains)
            && (self.class_name.is_empty() || self.class_name == window.class_name)
            && (self.executable.is_empty() || executable_matches(&self.executable, window))
            && (self.packaged_app_id.is_empty()
                || self
                    .packaged_app_id
                    .eq_ignore_ascii_case(&window.desktop_id))
            && self.process_id.is_none_or(|pid| pid == window.pid)
            && self.window_id.as_ref().is_none_or(|id| id == &window.id)
            && (!self.active_only || window.active)
    }
}

fn executable_matches(value: &str, window: &WindowInfo) -> bool {
    if value.contains(['\\', '/']) {
        value.replace('/', "\\").to_lowercase() == window.path.replace('/', "\\").to_lowercase()
    } else {
        value.to_lowercase() == window.app_id.to_lowercase()
    }
}

pub fn matches(binding: &Binding, window: &WindowInfo) -> bool {
    if let Some(selector) = &binding.windows_match {
        return cfg!(windows) && selector.matches(window);
    }
    window.app_id.eq_ignore_ascii_case(&binding.app_match)
        || (!window.desktop_id.is_empty()
            && window.desktop_id.eq_ignore_ascii_case(&binding.app_match))
        || (cfg!(windows) && executable_matches(&binding.app_match, window))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> WindowInfo {
        serde_json::from_value(serde_json::json!({"id":"12345","pid":42,"title":"Work — Editor","className":"EditorWindow","appId":"editor.exe","desktopId":"Contoso!Editor","path":"C:\\Apps\\Work\\editor.exe","rect":{"x":0,"y":0,"width":500,"height":400},"workArea":{"x":0,"y":0,"width":1920,"height":1080},"monitor":1,"monitorName":"main","maximizedHorizontal":false,"maximizedVertical":false,"fullscreen":false,"minimized":false,"active":true})).unwrap()
    }
    #[test]
    fn criteria_are_conjoined_and_title_and_class_keep_case_and_spaces() {
        let mut selector = WindowsMatch {
            title_contains: "Work — ".into(),
            class_name: "EditorWindow".into(),
            executable: "EDITOR.EXE".into(),
            packaged_app_id: String::new(),
            process_id: Some(42),
            window_id: Some("12345".into()),
            active_only: true,
        };
        selector.validate().unwrap();
        let window = fixture();
        assert!(selector.matches(&window));
        for changed in [
            WindowInfo {
                title: "work — Editor".into(),
                ..window.clone()
            },
            WindowInfo {
                class_name: "editorwindow".into(),
                ..window.clone()
            },
            WindowInfo {
                pid: 43,
                ..window.clone()
            },
            WindowInfo {
                id: "12346".into(),
                ..window.clone()
            },
            WindowInfo {
                active: false,
                ..window.clone()
            },
        ] {
            assert!(!selector.matches(&changed));
        }
        selector.title_contains.push(' ');
        assert!(!selector.matches(&window));
    }
    #[test]
    fn full_paths_distinguish_same_name_programs_and_app_ids_remain_compatible() {
        let window = fixture();
        let selector = WindowsMatch {
            executable: "c:\\APPS\\work\\EDITOR.exe".into(),
            ..Default::default()
        };
        assert!(selector.matches(&window));
        assert!(!selector.matches(&WindowInfo {
            path: "C:\\Apps\\Personal\\editor.exe".into(),
            ..window.clone()
        }));
        let binding = |id: &str| {
            serde_json::from_value::<Binding>(serde_json::json!({"label":"Editor","shortcut":"Ctrl+Alt+E","action":"pull-app","appMatch":id})).unwrap()
        };
        assert!(matches(&binding("editor.exe"), &window));
        assert!(matches(&binding("Contoso!Editor"), &window));
        let package = WindowsMatch {
            packaged_app_id: "Contoso!Editor".into(),
            title_contains: "Work".into(),
            ..Default::default()
        };
        assert!(package.matches(&window));
        assert!(!package.matches(&WindowInfo {
            desktop_id: "OtherFamily!Editor".into(),
            ..window.clone()
        }));
        assert_eq!(
            matches(&binding("C:\\Apps\\Work\\editor.exe"), &window),
            cfg!(windows)
        );
    }
    #[test]
    fn empty_predicate_is_rejected_and_numeric_handle_is_normalized_without_precision_loss() {
        assert!(WindowsMatch::default().validate().is_err());
        let mut selector = WindowsMatch {
            window_id: Some("0x20000000000001".into()),
            ..Default::default()
        };
        selector.validate().unwrap();
        assert_eq!(selector.window_id.as_deref(), Some("9007199254740993"));
        selector.window_id = Some("-1".into());
        assert!(selector.validate().is_err());
    }
}
