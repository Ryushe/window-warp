#!/usr/bin/env bash
# Run with dbus-run-session. This creates a separate compositor and two outputs.
set -euo pipefail
root="$(cd "${1:?Pass the desktop source directory}" && pwd)"
session_dir="$(mktemp -d /tmp/window-warp-nested.XXXXXX)"
export XDG_RUNTIME_DIR="$session_dir/runtime"
export XDG_CONFIG_HOME="$session_dir/config"
export XDG_DATA_HOME="$session_dir/data"
export XDG_CACHE_HOME="$session_dir/cache"
mkdir -m 700 "$XDG_RUNTIME_DIR"
export QT_QPA_PLATFORM=offscreen KWIN_COMPOSE=Q XDG_CURRENT_DESKTOP=KDE
unset DISPLAY WAYLAND_DISPLAY
kwin_wayland --virtual --output-count 2 --width 1280 --height 720 --socket warp-test --no-lockscreen --no-kactivities >"$session_dir/kwin.log" 2>&1 &
compositor_pid=$!
cleanup() {
    kill "$compositor_pid" 2>/dev/null || true
    wait "$compositor_pid" 2>/dev/null || true
    printf 'Nested session logs: %s\n' "$session_dir"
}
trap cleanup EXIT
for attempt in $(seq 1 60); do
    if test -S "$XDG_RUNTIME_DIR/warp-test" && qdbus org.kde.KWin /Scripting >/dev/null 2>&1; then break; fi
    if ! kill -0 "$compositor_pid" 2>/dev/null; then cat "$session_dir/kwin.log"; exit 1; fi
    sleep 0.2
done
export WAYLAND_DISPLAY=warp-test QT_QPA_PLATFORM=wayland
python3 "$root/tests/kde/live.py" "$root/src-tauri/kwin/warp.js"
