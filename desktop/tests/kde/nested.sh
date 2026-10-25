#!/usr/bin/env bash
# This creates a private session bus, compositor and two outputs.
set -euo pipefail
if [[ "${1:-}" == "--private-bus" ]]; then
    shift
    session_dir="${XDG_RUNTIME_DIR%/runtime}"
    # This branch is entered only by our re-exec below. Keep activation services
    # inside the same temporary root as the compositor and desktop metadata.
    [[ "$session_dir" == /tmp/window-warp-nested.* && -d "$XDG_RUNTIME_DIR" &&
       "$XDG_CONFIG_HOME" == "$session_dir/config" &&
       "$XDG_DATA_HOME" == "$session_dir/data" &&
       "$XDG_CACHE_HOME" == "$session_dir/cache" ]] || exit 1
    export WARP_PRIVATE_DBUS_DATA_HOME="$XDG_DATA_HOME"
else
    test -d "${1:?Pass the desktop source directory}"
    session_dir="$(mktemp -d /tmp/window-warp-nested.XXXXXX)"
    export XDG_RUNTIME_DIR="$session_dir/runtime"
    export XDG_CONFIG_HOME="$session_dir/config"
    export XDG_DATA_HOME="$session_dir/data"
    export XDG_CACHE_HOME="$session_dir/cache"
    mkdir -m 700 "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"
    # dbus-daemon reads its activation search paths at startup. Start it after
    # setting XDG roots so real service autostart cannot use the user's data.
    exec dbus-run-session -- bash "$0" --private-bus "$@"
fi
root="$(cd "${1:?Pass the desktop source directory}" && pwd)"
gui_output="${5:-}"
export QT_QPA_PLATFORM=offscreen KWIN_COMPOSE=Q XDG_CURRENT_DESKTOP=KDE
unset DISPLAY WAYLAND_DISPLAY
permission_checks=0
fixture_python=python3
if [[ " $* " == *" --pointer "* || " $* " == *" --pointer-denied "* ]]; then
    # Match installed-package authorization, within this private XDG data root.
    # The native keyboard fixture gets its own explicit desktop declaration too.
    permission_checks=1
    # KWin takes the first desktop entry matching the canonical executable.
    # A system Python entry can otherwise shadow our capability declaration.
    python_source="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.executable).resolve())')"
    fixture_python="$session_dir/fixture-python"
    cp -- "$python_source" "$fixture_python"
    "$fixture_python" - "$3" "$*" <<'PY'
import os, sys
from pathlib import Path
applications = Path(os.environ["XDG_DATA_HOME"]) / "applications"
applications.mkdir(parents=True)
# Minimal runtime images may have no system applications.menu. KService needs
# a menu to index even our explicit desktop entries for interface permission.
menus = Path(os.environ["XDG_CONFIG_HOME"]) / "menus"
menus.mkdir(parents=True)
menu_name = os.environ.get("XDG_MENU_PREFIX", "") + "applications.menu"
assert Path(menu_name).name == menu_name, "Menu prefix must stay inside the private fixture directory"
(menus / menu_name).write_text('<Menu><Name>Applications</Name><DefaultAppDirs/><Include><All/></Include></Menu>\n')
for name, executable in [("window-warp", sys.argv[1]), ("warp-input-fixture", sys.executable)]:
    if name == "window-warp" and "--pointer-denied" in sys.argv[2].split():
        continue
    path = str(Path(executable).resolve())
    assert not any(c in path for c in '\n\r"\\%$`')
    (applications / (name + ".desktop")).write_text(f'[Desktop Entry]\nType=Application\nName={name}\nExec="{path}"\nX-KDE-Wayland-Interfaces=org_kde_kwin_fake_input\n')
PY
    kbuildsycoca5 --noincremental >"$session_dir/desktop-cache.log" 2>&1
fi
# KWin's documented source-level test switch exposes fake-input to our helper.
# It applies only to this private compositor/bus/runtime, never the user's seat.
KWIN_WAYLAND_NO_PERMISSION_CHECKS=$((1-permission_checks)) kwin_wayland --virtual --output-count 2 --width 1280 --height 720 --socket warp-test --no-lockscreen --no-kactivities >"$session_dir/kwin.log" 2>&1 &
compositor_pid=$!
cleanup() {
    kill "$compositor_pid" 2>/dev/null || true
    wait "$compositor_pid" 2>/dev/null || true
    if [[ -n "$gui_output" ]]; then
        mkdir -p "$gui_output"
        cp "$session_dir/kwin.log" "$gui_output/nested-kwin.log"
    fi
    printf 'Nested session logs: %s\n' "$session_dir"
}
trap cleanup EXIT
for attempt in $(seq 1 60); do
    if test -S "$XDG_RUNTIME_DIR/warp-test" && qdbus org.kde.KWin /Scripting >/dev/null 2>&1; then break; fi
    if ! kill -0 "$compositor_pid" 2>/dev/null; then cat "$session_dir/kwin.log"; exit 1; fi
    sleep 0.2
done
export WAYLAND_DISPLAY=warp-test QT_QPA_PLATFORM=wayland
if [[ "${2:-}" == "--input-probe" ]]; then
    "$fixture_python" "$root/tests/kde/input_probe.py"
elif [[ "${2:-}" == "--gui" ]]; then
    shift 2
    "$fixture_python" "$root/tests/kde/gui.py" "$@"
else
    "$fixture_python" "$root/tests/kde/live.py" "$root/src-tauri/kwin/warp.js"
fi
