# Window Warp desktop — early preview

A standalone Tauri 2 application for Windows and **KDE Plasma 5.27 and 6**, with no AutoHotkey dependency. The original scripts remain in the repository root.

## Implemented

- Native settings window and tray menu (open, pause, quit).
- Editable global shortcuts with validation and duplicate detection.
- Push the focused window between monitors, ordered left to right, wrapping at the ends.
- Pull a pushed window back using a bounded in-memory history.
- Left/right half tiling using monitor work areas.
- Focus/cycle existing app windows by executable name (Windows) or resource class/desktop ID (KDE).
- Per-app pull to the main monitor, send to a burner display, and focus the previous app.
- Top/bottom tiling, maximize/restore, and graceful close actions.
- Shortcut recording, search, and individual shortcut enable switches.
- Startup registration controls (Windows user Run entry or KDE autostart).
- Workspace capture with review, selection, rename, delete, reorder, and update suggestions.
- Workspace restore with separate window matching, launch commands, placement/state restoration, cancellation, and per-app results.
- Firefox profile and compressed-session capture, editable tab URLs/selection, and profile-specific restore.
- Local versioned JSON settings, written through a temporary file.
- Single-instance behavior. Closing the editor hides it to the tray.

Normal launches start **paused**. Save changes, then click **Enable shortcuts**. A registered login launch uses `--startup` to enable saved shortcuts and hide the editor. Editing shortcuts requires pausing first. Default keys use Ctrl+Alt; every key can be changed, including to Super/Win/Meta combinations when the desktop allows them. Stop or pause conflicting AutoHotkey bindings before reusing their keys.

Open **Workspaces → Capture current**, choose which windows to keep, and save a name. Capture creates a review draft. Each app has editable launch arguments and an option to always open a new window. **Open workspace** reuses matching windows or launches missing apps, then restores placement.

Firefox captures its profile, tab URLs, and selected tab from its last readable session file. Review them under **Firefox profile and tabs**. If the browser has not written its session yet, or the window cannot be matched reliably, the editor shows a note and allows manual entry. Restore opens the selected tab last, matching the original app's behavior. Existing profile windows are reused unless **Always open a new window** is checked. Capture does not modify browser profiles. Terminal shell specialization remains in progress.

## Development

Install Node.js, Rust 1.90 or newer, and the [Tauri platform prerequisites](https://tauri.app/start/prerequisites/). Windows requires the Visual Studio C++ build tools and WebView2. Linux requires the WebKitGTK 4.1 and tray development packages described by Tauri.

```sh
cd desktop
npm ci
npm run dev
```

Build on each target operating system:

```sh
npm run build
```

Build outputs are under `src-tauri/target/release/`; installers are under its `bundle/` directory. Unsigned preview installers may show Windows reputation prompts.

## KDE setup

Use a Plasma 5.27 or 6 session (Wayland or X11) and Qt's qdbus executable. Supported executable names are `qdbus6`, `qdbus-qt6`, `/usr/lib/qt6/bin/qdbus`, and `qdbus`. Package names differ by distribution; for example `qdbus` for Plasma 5, or `qdbus-qt6` / `qt6-tools` for Plasma 6. The app detects the script-object path and the script adapts to each version's window, desktop, and output APIs.

The application loads session-only KWin scripts via the session D-Bus service. KWin registers the shortcuts and performs window operations, so native Wayland windows do not depend on X11 automation. Pause unloads the shortcut script; the workspace command bridge remains available while paused. Quit unloads both. After a crash, the app replaces the corresponding script on next use. If needed, manually unload them with your qdbus executable:

```sh
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript window-warp-session
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript window-warp-control-session
```

KDE may retain or override shortcut assignments in **System Settings → Keyboard → Shortcuts → KWin**. Resolve conflicts there if a shortcut does not fire; loading the script does not prove every key is available. Runtime KWin messages can be found in the user journal (`journalctl --user -b`, search for `Window Warp`). The app requires access to the session bus and is not currently packaged as a sandboxed Flatpak.

For app identifiers, use the exact resource class or desktop file ID. KWin's window properties inspector can show these. Example: `firefox` or `org.kde.konsole`. On Windows use an executable filename such as `firefox.exe` or `WindowsTerminal.exe`.

## Scope and verification

The full feature port is in progress; [PARITY.md](PARITY.md) tracks the source-derived requirements and verification gaps. INI import, tap/hold gestures, radial selection, and terminal specialization remain pending. Workspace capture/reuse/launch, per-axis maximization/fullscreen, and Firefox tab restoration have passed native KDE tests. Startup registration passes a KDE toggle test; actual login launches and Windows registration still need validation. Live Windows Firefox, mixed-DPI displays, desktop-imposed minimum sizes, and elevated Windows applications also need coverage. Existing Windows preview installers predate these ongoing changes.

```sh
npm test
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
```

Node tests execute the actual KWin script against simulated Plasma 5/6 workspaces to check placement, monitor removal, closed windows, app cycling, and tiling. Editor tests run the UI against a simulated native bridge and cover save failures, registration errors, and preserving edits. Rust tests cover configuration validation, placement math, and native Windows positioning on a hidden test window.

Live Wayland tests verify the integration on Plasma 5.27, including a separate two-output KWin session for monitor push/pull and maximized/fullscreen tiling. The compiled Linux app also passed native UI checks for rendering, saving settings, enabling, and pausing. Windows x64 and Ubuntu 24.04 amd64 builds produced an NSIS installer and Debian package. See [live KDE validation](tests/kde/README.md) for reproducible commands and coverage limits. Live Plasma 6 testing is still pending.

Manual acceptance on each OS: enable the app; push a floating window across two monitors; pull it back; tile it on each side; switch between two windows of the same app; unplug the original display and pull; pause and verify shortcuts are released; quit and verify cleanup. Repeat with maximized windows, portrait displays, and mixed scaling.

## Architecture

- `ui/`: local HTML/CSS/JavaScript editor. All settings and actions pass through narrow Tauri commands; no shell or filesystem API is exposed to the webview.
- `src-tauri/src/config.rs`: versioned configuration, canonical shortcut syntax, validation.
- `src-tauri/src/windows.rs`: Win32 window enumeration, positioning, focus, and global shortcut registration.
- `src-tauri/src/linux.rs`: KWin session integration via qdbus, with arguments passed directly without a shell.
- `src-tauri/src/linux_control.rs`: session-bus command bridge for workspace capture and restore.
- `src-tauri/src/workspaces.rs`: workspace storage, matching, launch, restore, and cancellation.
- `src-tauri/src/firefox.rs`: profile discovery and Mozilla LZ4 session capture, tab selection, and profile launch commands.
- `src-tauri/src/process_info.rs`: argument boundaries from `/proc` or Windows CIM and `CommandLineToArgvW`.
- `src-tauri/kwin/warp.js`: compositor-side window management and shortcuts.

Settings live in Tauri's per-user configuration directory under `com.windowwarp.desktop/settings.json`; workspaces use `workspaces.json` beside it. The editor displays the settings path. Existing AHK INI files are not imported or modified.
