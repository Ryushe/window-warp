# Window Warp desktop — early preview

A standalone Tauri 2 application for Windows and **KDE Plasma 5.27 and 6**, with no AutoHotkey dependency. The original scripts remain in the repository root.

## Implemented

- Native settings window and tray menu (open, pause, quit).
- Editable global shortcuts with validation, duplicate detection, and reviewed reassignment.
- A pause/resume shortcut retained while paused, plus current-app editor and workspace control shortcuts.
- Push the focused window between monitors, ordered left to right, wrapping at the ends.
- After a push, press **X** to tile left or **C** to tile right within one second.
  **Super/Win+X/C** also works. This targets the pushed window even if focus changes;
  one use, expiry or pausing clears it. A single monitor wraps in place.
- Pull a pushed window back using a bounded in-memory history.
- Left/right half tiling using monitor work areas.
- Focus/cycle app windows by executable name/path or packaged app ID (Windows), or resource class/desktop ID (KDE).
- Optional Windows rules combining title text, window class, executable, packaged ID, process/window identity and active-window state; imported AHK rules use the same matcher as tap and radial selection.
- Per-app pull to the main monitor, send to a burner display, and focus the previous app.
- App-pull tap on release or hold to tile, with a configurable delay and disable switch.
- Top/bottom tiling, maximize/restore, and graceful close actions.
- Shortcut recording, search, and individual shortcut enable switches.
- Startup registration controls (Windows user Run entry or KDE autostart).
- Workspace capture with review, selection, rename, delete, reorder, and update suggestions.
- Workspace restore with separate window matching, launch commands, placement/state restoration, cancellation, and per-app results.
- Firefox profile and compressed-session capture, editable tab URLs/selection, and profile-specific restore.
- Local versioned JSON settings, written through a temporary file.
- Single-instance behavior. Closing the editor hides it to the tray.

Normal launches start **paused**. Save changes, then click **Enable shortcuts**. A registered login launch uses `--startup` to enable saved shortcuts and hide the editor. Editing shortcuts requires pausing first. Default keys use Ctrl+Alt; every key can be changed, including to Super/Win/Meta combinations when the desktop allows them. Stop or pause conflicting AutoHotkey bindings before reusing their keys.

New configurations include **Ctrl+Alt+P** to pause/resume, **Ctrl+Alt+B** to edit the current app's shortcut, **Ctrl+Alt+O** to browse workspaces, and **Ctrl+Alt+U** to capture a workspace update for review. Existing configurations can add these actions from the editor. Opening the current-app editor pauses window shortcuts and preserves existing drafts. Resume uses saved settings; unsaved edits remain in the editor.

For a more specific Windows app shortcut, enable **Use Windows matching criteria**. Every entered criterion must match. Title text uses case-sensitive contains matching, and window classes use case-sensitive equality, matching the original AHK configuration. Executable names, full paths and packaged IDs are case-insensitive. Process IDs and window IDs can change after restart. Imported `ahk_exe`, `ahk_class`, `ahk_pid`, `ahk_id`, title and active-window rules retain these criteria, including visible owned or untitled windows. Undefined AHK groups and ambiguous rules remain visible for manual review. Windows rules stay disabled on Linux until you turn off Windows matching and enter a KDE app identifier.

Open **Workspaces → Capture current**, choose which windows to keep, and save a name. Capture creates a review draft. Each app has editable launch arguments and an option to require a new window. **Open workspace** reuses matching windows or launches missing apps, then restores placement.

**App launch settings** supports executable paths, Linux desktop entry IDs, and Windows packaged app IDs (AUMIDs). Capture records the installed desktop entry or actual Windows package identity when available. Desktop entries handle their own arguments and working directory; the editor's argument list supplies documents or URLs, with local file URLs resolved by the desktop launcher. Packaged apps receive activation arguments and choose whether to open a new window. Clear the executable-only Working directory field when selecting either application-ID launch type. Missing or refused activation appears in that window's restore result. Older AHK INIs did not save packaged activation IDs: their executable paths are preserved for review, and Windows resolves a single registered app from the saved package family even when its version changed. Missing or ambiguous registrations remain editable for recapture or an explicit AUMID.

Firefox captures its profile, tab URLs, and selected tab from its last readable session file. Review them under **Firefox profile and tabs**. If the browser has not written its session yet, or the window cannot be matched reliably, the editor shows a note and allows manual entry. Restore opens the selected tab last, matching the original app's behavior. Existing profile windows are reused unless **Require a new window** is checked. When Firefox starts without profile arguments, Window Warp also checks which process holds the profile lock. This helps distinguish profiles with identical window titles; unavailable lock evidence or identical sessions within one profile may still need review. Capture does not modify browser profiles. Windows Terminal and Konsole entries also expose shell, profile, arguments, and working directory. WSL capture recognizes explicit distributions, legacy launchers, and unambiguous user/hostname prompts. Ambiguous terminals show a review note; select their distribution before saving. Capturing a terminal does not replay its running command. Browser-tab and terminal-session restoration use executable launches to supply their application-specific options.

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

Use a Plasma 5.27 or 6 session (Wayland or X11) and Qt's qdbus executable. Supported executable names are `qdbus6`, `qdbus-qt6`, `/usr/lib/qt6/bin/qdbus`, and `qdbus`. The Debian package declares `qdbus-qt6 | qdbus-qt5 | qdbus` as alternatives so the package manager can install the needed tool. For other distributions, package names vary: for example `qdbus-qt5` / `qdbus` for Plasma 5, or `qdbus-qt6` / `qt6-tools` for Plasma 6. The app detects the script-object path and the script adapts to each version's window, desktop, and output APIs.

The application loads session-only KWin scripts via the session D-Bus service. KWin registers the shortcuts and performs window operations, so native Wayland windows do not depend on X11 automation. Pause unloads window actions and unheld app-gesture hooks. A cancelled held hook stays installed solely until release, so resuming cannot restart it from autorepeat. The pause/resume binding and workspace command bridge remain available. Quit removes the owned hooks; startup also reclaims hooks left by a crash. The shared scripts can be manually unloaded with your qdbus executable:

```sh
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript window-warp-session
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript window-warp-pause-session
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript window-warp-control-session
qdbus6 org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript window-warp-retile-session
```

When KWin reuses a script D-Bus ID, the app uses the scripting startup entry point, which also reconciles configured KWin plugins. Each new script must acknowledge startup before activation succeeds.

Window Warp removes its own inactive key reservations when pausing or reconfiguring, so saved key reassignments can take effect. Configure its keys in the app. Other desktop shortcuts can still conflict; inspect **System Settings → Keyboard → Shortcuts → KWin** if a key does not fire. Loading the script alone does not prove every key is available. Runtime KWin messages can be found in the user journal (`journalctl --user -b`, search for `Window Warp`). The app requires access to the session bus and is not currently packaged as a sandboxed Flatpak.

For app identifiers, use the exact resource class or desktop file ID. KWin's window properties inspector can show these. Example: `firefox` or `org.kde.konsole`. On Windows use an executable filename such as `firefox.exe` or `WindowsTerminal.exe`.

## Scope and verification

The full feature port is in progress; [PARITY.md](PARITY.md) tracks the source-derived requirements and verification gaps. Reviewed INI import, pointer centering and timed X/C retiling are implemented. The radial picker passes native Windows/KDE selection, Escape and focus-loss cancellation checks. Tap/hold tiling is implemented on Windows and KDE; see the checklist for native coverage and remaining gesture cases. Terminal capture and new-window restoration have passed native cmd, WSL, PowerShell, portable custom-profile Windows Terminal, and Konsole fixtures; shared-process/multi-tab identity remains limited. Workspace capture/reuse/launch, per-axis maximization/fullscreen, and Firefox tab restoration have passed native KDE tests. Startup registration passes native Windows and KDE toggle tests; actual login launches still need validation. Explicit-profile Windows and KDE Firefox capture/restore pass. Mixed-DPI displays, desktop-imposed minimum sizes, and elevated Windows applications still need coverage.

```sh
npm test
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
```

Node tests execute the actual KWin script against simulated Plasma 5/6 workspaces to check placement, monitor removal, closed windows, app cycling, and tiling. Editor tests run the UI against a simulated native bridge and cover save failures, registration errors, and preserving edits. Rust tests cover configuration validation, placement math, and native Windows positioning on a hidden test window. The opt-in [native Windows fixture](tests/windows/README.md) exercises the actual app with OS keyboard input, conflict recovery, the editor, workspace capture/launch, startup registration and single-instance behavior using isolated app/browser data.

On tested Plasma 5.27 Wayland, pressing another app shortcut ends the first shortcut’s hold tracking early. Independent overlapping app chords pass on Windows but remain a KDE parity gap; the opt-in native regression and signal evidence are recorded in [PARITY.md](PARITY.md).

Live Wayland tests verify the integration on Plasma 5.27, including a separate two-output KWin session for monitor push/pull and maximized/fullscreen tiling. The compiled Linux app also passed native UI checks for rendering, saving settings, enabling, and pausing. Windows x64 and Ubuntu 24.04 amd64 builds produced an NSIS installer and Debian package. See [live KDE validation](tests/kde/README.md) for reproducible commands and coverage limits. A supplemental KWin 6.3.6 / Qt 6.8.2 session passes 35 native script checks and 39 combined app checks, including pointer centering with default and maximum normal screen-edge resistance. Missing pointer permission is also tested. Live Portafort Plasma 5.27 testing passes the same 39 combined app checks through WSL → Hoster → Portafort. Remaining edge cases and physical-session checks are tracked in [PARITY.md](PARITY.md).

Manual acceptance on each OS: enable the app; push a floating window across two monitors; pull it back; tile it on each side; switch between two windows of the same app; unplug the original display and pull; pause and verify shortcuts are released; quit and verify cleanup. Repeat with maximized windows, portrait displays, and mixed scaling.

## Architecture

- `ui/`: local HTML/CSS/JavaScript editor. All settings and actions pass through narrow Tauri commands; no shell or filesystem API is exposed to the webview.
- `src-tauri/src/app_actions.rs`: application control shortcuts and pending editor/workspace requests.
- `src-tauri/src/radial.rs` and `ui/radial.*`: stable window candidates, shared angular selection, and the temporary picker overlay.
- `src-tauri/src/config.rs`: versioned configuration, canonical shortcut syntax, validation.
- `src-tauri/src/windows.rs`: Win32 window enumeration, positioning, focus, and global shortcut registration.
- `src-tauri/src/linux.rs`: KWin session integration via qdbus, with arguments passed directly without a shell.
- `src-tauri/src/linux_control.rs`: authenticated session-bus command queue with correlated replies and input cancellation.
- `src-tauri/src/workspaces.rs`: workspace storage, matching, launch, restore, and cancellation.
- `src-tauri/src/firefox.rs`: profile discovery and Mozilla LZ4 session capture, tab selection, and profile launch commands.
- `src-tauri/src/terminal.rs` and `wsl.rs`: terminal identity, profile/directory restoration, bounded WSL discovery.
- `src-tauri/src/process_info.rs`: argument boundaries from `/proc` or Windows CIM and `CommandLineToArgvW`.
- `src-tauri/kwin/warp.js`: persistent compositor-side window management, movement history and restore geometry.
- `src-tauri/kwin/shortcuts.js`: shortcut registration and captured input forwarding to the persistent owner.
- `src-tauri/kwin/control.js`: command dispatch between the application and the persistent window manager.

Settings live in Tauri's per-user configuration directory under `com.windowwarp.desktop/settings.json`; workspaces use `workspaces.json` beside it. The editor displays the settings path. Use **Import AutoHotkey settings** to select existing INI files. The originals are never modified.

## Radial window picker

In **Settings → Hold action**, select **Radial window picker**, then save and
activate shortcuts. Hold an app-pull key, move toward a window label and release
the key or a required modifier. The picker shows the first eight matching windows
in case-insensitive title order, with native identity breaking ties. Duplicate
labels are numbered. Releasing within the 10-pixel center zone, pressing Escape,
closing the picker, or pausing cancels selection. A selected window follows that
binding's existing main/burner and focus-last behavior. Holding is optional and
existing settings continue to use mouse tiling.

The overlay is clamped to the work area containing the original pointer. Native
pointer updates run only while a picker is visible. On KDE, KWin positions and
focuses the overlay, including on Wayland. More than four labels use a compact
layout to keep all eight readable without overlap. Native Windows and KDE fixtures verify selection on release, dead-zone
cancellation and pause/resume while held. Rapid Escape cancellation on Windows
has a known intermittent failure; see PARITY.md.


## Importing the original INIs

Select `window_manager_apps.ini`, `hotkey_registry.ini`,
`windows_warp_settings.ini`, and/or `workspace_openers.ini` in the import panel.
UTF-8 and BOM-marked UTF-16 are detected; older ANSI files use Windows-1252.
Review each entry, then add selected shortcuts/settings to the existing draft
and use **Save changes**. Existing shortcuts remain; conflicting keys can be
reassigned through the editor. Disabled keys retain their assignments.

Each workspace opens separately for review and requires **Save workspace**.
Legacy shell fields, Firefox profiles/tabs and saved placement are retained.
Old INIs omit monitor work areas, so the importer uses current work areas with
an explicit review note. The editor exposes reference areas, app identifiers,
platform, terminal kind and launch fields for adaptation. On Linux, imported
Windows app shortcuts start disabled and workspaces remain Windows-scoped.

Unsupported shared actions (including move-and-center), compound AHK match
expressions and unrecognized key syntax remain visible with the original
settings and an explanation. They are not silently converted. Full migration
parity still depends on the remaining action and packaged-launch features.


## Current preview artifacts (2026-10-25)

The current feature-branch builds are available locally after validation:

- Windows x64 NSIS: `src-tauri/target/release/bundle/nsis/Window Warp_0.1.0_x64-setup.exe`
- Ubuntu24.04-compatible amd64 Debian package: `src-tauri/target/release/bundle/deb/Window Warp_0.1.0_amd64.deb`

Their embedded executables and package metadata were inspected without installing
them. The preview includes the recent terminal, Firefox, tiling and gesture
changes. Tray handlers and graceful shutdown pass on Windows and Plasma5.27. Full parity,
installer behavior and full Plasma6 application behavior remain under validation; see PARITY.md,
especially the KDE overlapping-shortcut limit.


Terminal restoration checks fresh shell/profile/distribution identity while
waiting for a new window, so a known incompatible concurrent terminal is not
moved into the saved placement. Konsole selected profile files, shell aliases,
and wrappers with an exactly verified launch command are supported. Shared
processes, multiple tabs, and otherwise identical or unknown session identities
can still require manual review; see [parity tracking](PARITY.md).
