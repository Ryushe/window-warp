# Live KDE validation

These tests use the production KWin script. They create only their own fixture windows and unload their test script afterward. Python 3, PyQt5 (including QtDBus), qdbus, and KWin are required.

## Active desktop session

Run from the desktop source directory, in the KDE user's session:

```sh
python3 tests/kde/live.py src-tauri/kwin/warp.js
```

When connecting over SSH, set `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, and `WAYLAND_DISPLAY` to the intended user's existing session, and use `QT_QPA_PLATFORM=wayland`. Do not run as root. The test opens two temporary windows, so it can briefly take focus. No existing application window is moved or resized.

The runner verifies tiling, push/pull, minimized-app focus, cycling, registered action dispatch through KGlobalAccel, maximized/fullscreen tiling, and script unload. On a one-display desktop it reports push and empty pull as no-ops, not as successful multi-display coverage. KGlobalAccel dispatch tests the registered callback; it does not simulate a physical keyboard event.

## Isolated two-display compositor

```sh
dbus-run-session -- bash tests/kde/nested.sh "$PWD"
```

This starts a separate KWin virtual framebuffer with two 1280×720 outputs, a separate D-Bus session, and temporary config/runtime directories. The active desktop's outputs and layout are unaffected. The compositor is stopped automatically; its logs remain in the printed temporary directory for diagnosis.

## Actual desktop application UI

Build the executable on Linux. A matching `WebKitWebDriver` is required; `prepare-driver.sh TEST_DIRECTORY` can download and extract the distribution's `webkit2gtk-driver` package into a test directory without root or a system-wide installation.

```sh
python3 tests/kde/gui.py /absolute/path/to/window-warp \
  /absolute/path/to/WebKitWebDriver ./test-results
```

Run in a KDE Wayland session with `XDG_CURRENT_DESKTOP=KDE` and `QT_QPA_PLATFORM=wayland`. The runner uses the native WebKitGTK automation protocol and real Tauri commands. It checks rendering, settings persistence, enabling, pausing, startup registration, workspace capture/save, two-window reuse, forced new-window launch, per-axis maximization, fullscreen, and the workspace browser. Configuration, data, and cache directories are isolated. It refuses to start if Window Warp or either integration script is already running. It closes its process group, owned Qt fixtures, and both scripts afterward. Launched fixtures also have a 60-second exit timer. It produces screenshots, JSON results, and a log. Only owned fixture metadata is saved, and only owned fixture windows are restored.

The native driver capabilities and automation environment variables match Tauri's [WebDriver implementation](https://github.com/tauri-apps/tauri/tree/dev/crates/tauri-driver/src).

## Reproducible Linux build environment

`Dockerfile` creates an Ubuntu 24.04 builder; `build.sh` runs Node tests, Rust release tests, a Linux executable build, and Debian packaging. Mount only this source directory at `/work`, run as UID/GID 1000, and constrain container resources as appropriate for the build host. No privileged container or Docker socket mount is required.

## Verified environment

On 2026-10-24, the live script tests passed on Plasma 5.27 (KWin 5.27.11, Qt 5.15.13), with native Wayland fixture windows. The isolated two-output session passed all nine checks. This run discovered and fixed the fullscreen capability-flag guard. Plasma 6 compatibility remains covered by simulated-workspace tests, pending a live Plasma 6 environment. Mixed-DPI physical displays and unplugging an actual monitor remain manual checks.

The compiled Linux application also passed all four native UI checks on that session with WebKitGTK 2.52.6: rendering, settings persistence, loading the KWin integration, and unloading it on pause. The Linux build passed five Rust tests and twelve Node tests. A Debian amd64 package was generated on Ubuntu 24.04; the package itself has not been installed during testing. The Windows build passed six Rust tests, including native Win32 positioning, and produced an x64 NSIS installer.

Subsequent full-port work increased coverage to 18 live two-output checks and
11 native application checks. The workspace increment passes 24 Node tests,
13 Linux Rust tests, and 16 Windows Rust tests. See `../../PARITY.md` for the
current evidence and remaining feature scope; the counts above describe the
earlier preview only.
