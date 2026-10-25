#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Use the pointer position at key-down, even if it lies on another monitor.
#[cfg(any(windows, test))]
pub fn mouse_tile_direction(area: Rect, x: i32, y: i32) -> &'static str {
    if area.height > area.width {
        if i64::from(y) * 2 < i64::from(area.y) * 2 + i64::from(area.height) {
            "tile-up"
        } else {
            "tile-down"
        }
    } else if i64::from(x) * 2 < i64::from(area.x) * 2 + i64::from(area.width) {
        "tile-left"
    } else {
        "tile-right"
    }
}

pub fn relative(rect: Rect, source: Rect, target: Rect) -> Rect {
    let width = ((rect.width as f64 / source.width.max(1) as f64 * target.width as f64).round()
        as i32)
        .clamp(1, target.width.max(1));
    let height = ((rect.height as f64 / source.height.max(1) as f64 * target.height as f64).round()
        as i32)
        .clamp(1, target.height.max(1));
    let x = target.x
        + ((rect.x - source.x) as f64 / source.width.max(1) as f64 * target.width as f64).round()
            as i32;
    let y = target.y
        + ((rect.y - source.y) as f64 / source.height.max(1) as f64 * target.height as f64).round()
            as i32;
    Rect {
        x: x.clamp(target.x, target.x + target.width - width),
        y: y.clamp(target.y, target.y + target.height - height),
        width,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pointer_tiling_uses_work_area_orientation_origin_and_midpoint() {
        let landscape = Rect {
            x: -1200,
            y: 40,
            width: 1201,
            height: 800,
        };
        assert_eq!(mouse_tile_direction(landscape, -601, 10000), "tile-left");
        assert_eq!(mouse_tile_direction(landscape, -600, -10000), "tile-left");
        assert_eq!(mouse_tile_direction(landscape, -599, -10000), "tile-right");
        let portrait = Rect {
            x: 50,
            y: -1000,
            width: 800,
            height: 1201,
        };
        assert_eq!(mouse_tile_direction(portrait, 10000, -401), "tile-up");
        assert_eq!(mouse_tile_direction(portrait, -10000, -400), "tile-up");
        assert_eq!(mouse_tile_direction(portrait, -10000, -399), "tile-down");
        let square = Rect {
            x: 0,
            y: 0,
            width: 800,
            height: 800,
        };
        assert_eq!(mouse_tile_direction(square, 0, 799), "tile-left");
    }
    #[test]
    fn scales_between_negative_origin_and_portrait_monitor() {
        let source = Rect {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1080,
        };
        let target = Rect {
            x: 0,
            y: 40,
            width: 1080,
            height: 1920,
        };
        let rect = Rect {
            x: -960,
            y: 0,
            width: 960,
            height: 1080,
        };
        assert_eq!(
            relative(rect, source, target),
            Rect {
                x: 540,
                y: 40,
                width: 540,
                height: 1920
            }
        );
    }
    #[test]
    fn clamps_oversized_offscreen_window() {
        let area = Rect {
            x: 0,
            y: 40,
            width: 1280,
            height: 680,
        };
        let rect = Rect {
            x: -100,
            y: -100,
            width: 2000,
            height: 1200,
        };
        assert_eq!(relative(rect, area, area), area);
    }
}
