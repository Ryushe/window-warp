//! The picker owns one captured list for the entire physical key press.
use crate::{
    config::{Binding, Settings},
    geometry::Rect,
    workspaces::WindowInfo,
};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Serialize)]
pub struct View {
    id: String,
    labels: Vec<String>,
    selected: Option<usize>,
    cancelled: bool,
}
static VIEW: Mutex<Option<View>> = Mutex::new(None);

#[tauri::command]
pub fn radial_view() -> Result<Option<View>, String> {
    Ok(VIEW.lock().map_err(|e| e.to_string())?.clone())
}
#[tauri::command]
pub fn cancel_radial(id: String) -> Result<(), String> {
    if let Some(view) = VIEW.lock().map_err(|e| e.to_string())?.as_mut() {
        if view.id == id {
            view.cancelled = true;
        }
    }
    Ok(())
}
pub fn cancel_visible() {
    if let Ok(mut view) = VIEW.lock() {
        if let Some(view) = view.as_mut() {
            view.cancelled = true;
        }
    }
}

fn candidates(mut windows: Vec<WindowInfo>, binding: &Binding) -> Vec<WindowInfo> {
    windows.retain(|w| crate::window_match::matches(binding, w));
    windows.sort_by(|a, b| {
        label(a, binding)
            .to_lowercase()
            .cmp(&label(b, binding).to_lowercase())
            .then_with(|| match (a.id.parse::<u64>(), b.id.parse::<u64>()) {
                (Ok(a), Ok(b)) => a.cmp(&b),
                _ => a.id.cmp(&b.id),
            })
    });
    windows.truncate(8);
    windows
}
fn label(window: &WindowInfo, binding: &Binding) -> String {
    let title = window.title.trim();
    if title.is_empty() {
        binding.label.clone()
    } else {
        title.into()
    }
}
fn labels(windows: &[WindowInfo], binding: &Binding) -> Vec<String> {
    let mut counts = std::collections::HashMap::new();
    windows
        .iter()
        .map(|w| {
            let title = label(w, binding);
            let count = counts.entry(title.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                title
            } else {
                format!("{title} ({count})")
            }
        })
        .collect()
}
fn bounds(point: Point, area: Rect) -> Rect {
    Rect {
        x: (point.x - 130).clamp(area.x, area.x + (area.width - 260).max(0)),
        y: (point.y - 130).clamp(area.y, area.y + (area.height - 260).max(0)),
        width: 260,
        height: 260,
    }
}
fn selection(point: Point, bounds: Rect, count: usize) -> Option<usize> {
    let dx = f64::from(point.x) - f64::from(bounds.x) - 130.0;
    let dy = f64::from(point.y) - f64::from(bounds.y) - 130.0;
    if count == 0 || dx.hypot(dy) < 10.0 {
        return None;
    }
    let step = 360.0 / count as f64;
    let angle = (dy.atan2(dx).to_degrees() + 450.0 + step / 2.0).rem_euclid(360.0);
    Some((angle / step).floor() as usize % count)
}

pub struct Picker {
    app: AppHandle,
    id: String,
    windows: Vec<WindowInfo>,
    previous: Option<WindowInfo>,
    bounds: Rect,
}
impl Picker {
    #[cfg(target_os = "windows")]
    pub fn open(app: &AppHandle, binding: &Binding, point: Point) -> Result<Option<Self>, String> {
        Self::open_captured(app, binding, point, None)
    }
    #[cfg(target_os = "linux")]
    pub fn open_for_window(
        app: &AppHandle,
        binding: &Binding,
        point: Point,
        previous: Option<&crate::retile::Target>,
    ) -> Result<Option<Self>, String> {
        Self::open_captured(app, binding, point, Some(previous))
    }
    fn open_captured(
        app: &AppHandle,
        binding: &Binding,
        point: Point,
        captured: Option<Option<&crate::retile::Target>>,
    ) -> Result<Option<Self>, String> {
        let windows = crate::platform::snapshot_for_binding(app, binding)?;
        let previous = match captured {
            Some(identity) => identity
                .and_then(|target| {
                    windows
                        .iter()
                        .find(|w| w.id == target.id && w.pid == target.pid)
                })
                .cloned(),
            None => windows.iter().find(|w| w.active).cloned(),
        };
        let windows = candidates(windows, binding);
        if windows.is_empty() {
            return Ok(None);
        }
        let bounds = bounds(point, crate::platform::pointer_area(app, point)?);
        let id = uuid::Uuid::new_v4().to_string();
        let view = View {
            id: id.clone(),
            labels: labels(&windows, binding),
            selected: None,
            cancelled: false,
        };
        *VIEW.lock().map_err(|e| e.to_string())? = Some(view.clone());
        let picker = Self {
            app: app.clone(),
            id,
            windows,
            previous,
            bounds,
        };
        let window = app
            .get_webview_window("radial")
            .ok_or("The window picker is unavailable.")?;
        window
            .emit("radial-view", &view)
            .map_err(|e| e.to_string())?;
        crate::platform::show_radial(app, bounds)?;
        Ok(Some(picker))
    }
    /// Called only while a held radial gesture exists; there is no idle polling.
    pub fn update(&self) -> Result<bool, String> {
        if !self.live()? {
            return Ok(false);
        }
        let point = crate::platform::pointer(&self.app)?;
        let selected = selection(point, self.bounds, self.windows.len());
        let update = {
            let mut view = VIEW.lock().map_err(|e| e.to_string())?;
            let Some(view) = view.as_mut().filter(|v| v.id == self.id && !v.cancelled) else {
                return Ok(false);
            };
            if view.selected == selected {
                None
            } else {
                view.selected = selected;
                Some(view.clone())
            }
        };
        if let Some(view) = update {
            self.app
                .emit_to("radial", "radial-view", view)
                .map_err(|e| e.to_string())?;
        }
        Ok(true)
    }
    fn live(&self) -> Result<bool, String> {
        Ok(VIEW
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .is_some_and(|v| v.id == self.id && !v.cancelled))
    }
    pub fn release(self, binding: &Binding, settings: &Settings) -> Result<(), String> {
        // A failed refresh must not skip the choice or leave the menu up.
        // Drop still hides the window.
        let _ = self.update();
        let selected = VIEW
            .lock()
            .map_err(|e| e.to_string())?
            .as_ref()
            .filter(|v| v.id == self.id && !v.cancelled)
            .and_then(|v| v.selected);
        // Focus the chosen window while this process still owns the foreground.
        // Hiding first can return focus to another process and make Windows deny
        // the subsequent activation. Drop closes the picker on success or error.
        if let Some(index) = selected {
            crate::platform::pull_selected(
                &self.app,
                binding,
                settings,
                &self.windows[index],
                self.previous.as_ref(),
            )?;
        }
        Ok(())
    }
    fn hide(&self) {
        let owned = if let Ok(mut view) = VIEW.lock() {
            if view.as_ref().is_some_and(|v| v.id == self.id) {
                *view = None;
                true
            } else {
                false
            }
        } else {
            false
        };
        if owned {
            if let Some(window) = self.app.get_webview_window("radial") {
                let _ = window.hide();
            }
        }
    }
}
impl Drop for Picker {
    fn drop(&mut self) {
        self.hide();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dead_zone_and_clockwise_sectors_use_clamped_center() {
        let b = bounds(
            Point { x: -1999, y: 40 },
            Rect {
                x: -2000,
                y: 30,
                width: 1920,
                height: 1080,
            },
        );
        assert_eq!((b.x, b.y), (-2000, 30));
        let p = |dx, dy| Point {
            x: b.x + 130 + dx,
            y: b.y + 130 + dy,
        };
        assert_eq!(selection(p(0, 0), b, 8), None);
        assert_eq!(selection(p(9, 0), b, 8), None);
        assert_eq!(selection(p(0, -10), b, 8), Some(0));
        assert_eq!(selection(p(30, -30), b, 8), Some(1));
        assert_eq!(selection(p(100, 0), b, 8), Some(2));
        assert_eq!(selection(p(0, 100), b, 8), Some(4));
        assert_eq!(selection(p(-100, 0), b, 8), Some(6));
        assert_eq!(selection(p(-1000, 0), b, 1), Some(0));
    }
    #[test]
    fn title_order_numeric_identity_duplicates_and_limit() {
        let mut binding = crate::config::Config::default().bindings[0].clone();
        binding.app_match = "fixture".into();
        let make = |id: &str, title: &str| -> WindowInfo {
            serde_json::from_value(serde_json::json!({"id":id,"pid":1,"title":title,"appId":"fixture","desktopId":"","path":"", "rect":{"x":0,"y":0,"width":10,"height":10},"workArea":{"x":0,"y":0,"width":100,"height":100},"monitor":1,"monitorName":"a","maximizedHorizontal":false,"maximizedVertical":false,"fullscreen":false,"minimized":false,"active":false})).unwrap()
        };
        let mut input = vec![make("10", "same"), make("2", "same"), make("1", "Alpha")];
        input.extend((11..22).map(|i| make(&i.to_string(), "zeta")));
        let sorted = candidates(input, &binding);
        assert_eq!(sorted.len(), 8);
        assert_eq!(
            (
                sorted[0].id.as_str(),
                sorted[1].id.as_str(),
                sorted[2].id.as_str()
            ),
            ("1", "2", "10")
        );
        assert_eq!(
            &labels(&sorted, &binding)[..3],
            &["Alpha", "same", "same (2)"]
        );
    }
}
