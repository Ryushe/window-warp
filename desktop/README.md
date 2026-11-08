# Window Warp desktop — early preview

A standalone Tauri 2 application for Windows and **KDE Plasma 5.27 and 6**, with no AutoHotkey dependency. The original scripts remain in the repository root.

## Implemented

- Native settings window and tray menu (open, enable/pause, quit).
- Editable global shortcuts with validation, duplicate detection, and reviewed reassignment.
- A pause/resume shortcut retained while paused, plus current-app editor and workspace control shortcuts.
- Push the focused window between monitors, ordered left to right. With only one monitor, Win+X tiles left and Win+C tiles right instead of moving.
- After a push onto another monitor, press **X** or **C** within one second to tile that window. Win+X and Win+C keep moving it. One use, expiry, or pausing clears the follow-up.
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

Normal launches turn shortcuts on. Settings can turn that off. A registered login launch uses `--startup` to enable saved shortcuts and hide the editor. Shortcut fields can be changed while shortcuts are on. A new configuration uses the AutoHotkey keys: Win+X/C move windows, Win+Ctrl+X/C also center the pointer, Win+R pulls the last window, Win+; pauses, Win+Z maximizes, and Win+Q closes. App keys match `window_manager_apps.ini`, including Win+D for Discord and Win+S for Firefox. Every key can be changed. Stop the AutoHotkey script before enabling these keys.

New configurations also include **Win+B** to edit the current app's shortcut, **Win+O** to browse workspaces, and **Win+Y** to capture a workspace for review. The workspace section opens while tab capture finishes. The shortcut offers **New**, **URLs**, and **Update**. Choose the workspace before updating; URLs changes only confidently matched browser tabs, while Update captures the open applications and their positions. If a workspace draft is open, Win+Y and **Capture current** both ask before replacing it. Replacing a saved workspace also requires confirmation. Nothing is saved until the draft is reviewed and saved. The main screen has **Start Window Warp when I sign in**; that launch enables saved shortcuts. Existing configurations can add these actions from the editor. Opening the current-app editor preserves existing drafts. Unsaved edits remain in the full editor.

For a more specific Windows app shortcut, enable **Use Windows matching criteria**. Every entered criterion must match. Title text uses case-sensitive contains matching, and window classes use case-sensitive equality, matching the original AHK configuration. Executable names, full paths and packaged IDs are case-insensitive. Process IDs and window IDs can change after restart. Imported `ahk_exe`, `ahk_class`, `ahk_pid`, `ahk_id`, title and active-window rules retain these criteria, including visible owned or untitled windows. Undefined AHK groups and ambiguous rules remain visible for manual review. On Linux, add a KDE app identifier to use the binding across platforms.

Open **Workspaces → Capture current**, choose which windows to keep, and save a name. Capture creates a review draft; you can return to the workspace list and select workspaces while the draft stays open. Switching to a different editor offers to save or discard changed drafts. Use **Add window** to pick a window on screen or choose several open windows from a list. Each window row has position and detected-monitor selectors. On Windows, **Set position** opens a movable, resizable preview; Apply updates the draft, and Cancel leaves it unchanged. Advanced options retain editable launch arguments and the option to require a new window. **Open workspace** reuses matching windows or launches missing apps, then restores placement.

**App launch settings** supports executable paths, Linux desktop entry IDs, and Windows packaged app IDs (AUMIDs). Capture records the installed desktop entry or actual Windows package identity when available. Desktop entries handle their own arguments and working directory; the editor's argument list supplies documents or URLs, with local file URLs resolved by the desktop launcher. Packaged apps receive activation arguments and choose whether to open a new window. Clear the executable-only Working directory field when selecting either application-ID launch type. Missing or refused activation appears in that window's restore result. Older AHK INIs did not save packaged activation IDs: their executable paths are preserved for review, and Windows resolves a single registered app from the saved package family even when its version changed. Missing or ambiguous registrations remain editable for recapture or an explicit AUMID.

Firefox captures its profile, tab URLs, and selected tab from its last readable session file. Review or edit the URLs in the window, and choose a focused tab under **Advanced**. The connection dot opens browser-extension settings. If the browser has not written its session yet, or the window cannot be matched reliably, the editor shows a note and allows manual entry. A connected, updated extension can focus the selected tab in a confidently matched browser window while preserving URL order. Without one, newly launched browser windows receive the selected URL first, and the restore result warns when focus cannot be confirmed. Existing Firefox windows with the same URLs are reused; a different known set of URLs opens a new window. If current tabs cannot be verified, the app reuses an eligible window and reports the uncertainty. **Require a new window** explicitly requests another window. The session file can lag behind the live browser. When Firefox starts without profile arguments, Window Warp also checks which process holds the profile lock. This helps distinguish profiles with identical window titles; unavailable lock evidence or identical sessions within one profile may still need review. Capture does not modify browser profiles. Windows Terminal and Konsole entries also expose shell, profile, arguments, and working directory. WSL capture recognizes explicit distributions, legacy launchers, and unambiguous user/hostname prompts. Ambiguous terminals show a review note; select their distribution before saving. Capturing a terminal does not replay its running command. Browser-tab and terminal-session restoration use executable launches to supply their application-specific options.

For current Firefox tabs, install the add-on and pair it with the code in Settings; you do not need a workspace first. Until a Firefox Add-ons listing is available, Settings provides a temporary Firefox installation instead. To prepare development copies for Firefox or Chromium, quit Window Warp and launch it with `--developer-extensions`; the developer setup appears under Settings → Browser extensions. In the extension, **Save current tabs** creates a saved browser or a workspace. The **Saved tabs** and **Workspaces** lists can be searched and opened from the extension. **Sync tabs** updates the destination linked to the current window; **Sync elsewhere** updates a chosen saved browser or workspace once after confirmation. The current-destination menu can link a uniquely identified window to another destination. Choose a browser profile in the extension's **Settings** when automatic detection needs help. Saved browsers contain tabs and a profile choice, not passwords or a copy of the browser profile.

In Window Warp, saved browsers also appear under **Workspaces → Saved browsers**, where you can reopen one or add it to a workspace. When adding it, Warp refreshes its tabs from the original open window when it can identify that window. Review the URLs, then add a new browser window or replace or append tabs in an existing one. Appending keeps one copy of each exactly matching URL.

In the browser chooser, use **Ctrl+Shift+R** to replace tabs, **Ctrl+Shift+A** to append, or **Ctrl+Shift+N** to add a new browser window.

Use the extension's **Connect** and **Live updates** controls for each browser profile; live updates are off by default and turning them on also connects that profile. With live updates on, opening, closing, or changing a tab automatically updates the workspace that opened that browser window, or its independently saved browser. Other workspaces stay separate. Closing the whole browser preserves its last saved tabs. When Window Warp cannot confidently match a window, it leaves the saved tabs unchanged. With live updates off, Window Warp asks connected extensions for a snapshot when you capture a workspace, request a URL update, add a saved browser to a workspace, or open a workspace with a saved focused tab. Connection checks carry no tab data, private windows are excluded, and the bridge listens only on this computer. Firefox profiles are detected from the browser process when possible. Without an extension, Firefox uses its last readable saved session, which can lag. Chrome requires Developer mode to load the unpacked extension; Firefox's temporary installation is removed when Firefox exits. Browser-managed installation and updates need a published extension; Firefox also supports signed self-distribution.

On Windows, the workspace list marks the workspace associated with the current virtual desktop. The last opened workspace is tracked separately for each desktop, and the same workspace can be opened on several desktops. If a known window moves, Warp can recognize its workspace on the destination desktop when the match is unambiguous. Opening a workspace reuses matching windows on that desktop; it does not count a window on another desktop as open here. The app checks desktop state on opening, focus, and workspace or browser actions rather than continuously scanning. If Windows cannot identify an empty desktop reliably, focus a window there before opening Warp.

When Firefox matching is ambiguous, open **Firefox profile and tabs**, then **Choose profile or edit tabs** to select a profile or saved browser window. In the extension, choose a current sync destination from the destination menu, or use **Sync elsewhere** for a one-time update.

Browser extensions cannot read their own profile folder. If Window Warp cannot identify a profile from the browser process or an existing workspace, the editor shows that the browser default will be used; choose a specific profile there when needed. This can occur with Chromium profiles.

Once a development extension from Window Warp's prepared folder has been loaded and paired, Window Warp refreshes that folder on startup when it has a newer extension version. The extension reloads itself while connected; if automatic reloading fails, reload it from the browser's extension page. Existing 0.1.0 development copies need one manual reload to receive this update mechanism. Store-installed extensions are updated by the browser instead. Automatic file updates do not install an extension into a browser or make Firefox's temporary installation persistent. When changing extension files for a release, increase the version in both extension manifests so existing development copies can detect the update.

## Install, turn on/off, and uninstall

On Windows, install [Window Warp from the Microsoft Store](https://apps.microsoft.com/detail/9NVBS6W8RV54?hl=en-us&gl=US&ocid=pdpshare). On KDE, download the Debian package from the [latest GitHub release](https://github.com/Ryushe/window-warp/releases/latest) and install it with:

```sh
sudo apt install ./window-warp_0.1.8_linuxmint22.2_amd64.deb
```

Run the command from the download directory, using the downloaded filename if a
newer release is available. `apt` installs the package and resolves its
dependencies; `sudo dpkg -i` also works when those dependencies are installed.
The Debian package is for Linux Mint 22.2 amd64 with KDE Plasma 5 on Wayland
and KWin `4:5.27.11-0ubuntu3`. Other KWin versions, including Plasma 6, need a
matching companion and package build.

- **Turn on:** open Window Warp and click **Enable shortcuts**, or choose
  **Enable shortcuts** from its tray menu.
- **Temporarily turn off:** choose **Pause shortcuts** in the app or tray.
  Desktop hotkeys such as Win+; work normally again while paused. Win+; pauses Window Warp only while its shortcuts are on. A pause key Windows or KDE does not use stays available.
- **Completely stop:** choose **Quit** from the tray. Closing the editor hides
  it in the tray; it does not quit.
- **Start at login:** opt in using the app's startup setting. Turn that setting
  off to prevent automatic launches. Opening Window Warp turns shortcuts on unless Settings says otherwise.
- **Uninstall:** quit first. Windows: use **Installed apps → Window Warp →
  Uninstall**. KDE: run `sudo apt remove window-warp`.

On KDE, uninstalling preserves saved settings by default. The startup entry checks
that the executable exists, so a retained startup preference stays inactive while
the package is absent.

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

Use a Plasma 5.27 or 6 Wayland session and Qt's qdbus executable. X11 support is deferred. Supported executable names are `qdbus6`, `qdbus-qt6`, `/usr/lib/qt6/bin/qdbus`, and `qdbus`. The Debian package declares `qdbus-qt6 | qdbus-qt5 | qdbus` as alternatives so the package manager can install the needed tool. For other distributions, package names vary: for example `qdbus-qt5` / `qdbus` for Plasma 5, or `qdbus-qt6` / `qt6-tools` for Plasma 6. The app detects the script-object path and the script adapts to each version's window, desktop, and output APIs.

The application loads session-only KWin scripts via the session D-Bus service. KWin registers the shortcuts and performs window operations, so native Wayland windows do not depend on X11 automation. App-pull tap/hold gestures additionally require the [native companion](kwin-companion/README.md) built for the exact installed KWin version. The app loads that module when needed. It tracks accepted physical key cycles independently, including overlapping chords, and exports only configured shortcut events. Missing or incompatible support produces an activation error. The current companion targets Wayland; X11 gesture support is deferred.

Pause cancels pending gestures and unloads window-action registrations. The companion retains only the release guards needed to prevent an already-held key from restarting after resume or reassignment. The pause/resume binding and workspace command bridge remain available. Quit removes the owned scripts and detaches the companion's app session; startup also reclaims scripts left by a crash. The shared scripts can be manually unloaded with your qdbus executable:

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

The full feature port is in progress; [PARITY.md](PARITY.md) tracks the source-derived requirements and verification gaps. Reviewed INI import, pointer centering and timed X/C retiling are implemented. The radial picker passes native Windows/KDE selection, Escape and focus-loss cancellation checks. Tap/hold tiling is implemented on Windows and KDE; see the checklist for native coverage and remaining gesture cases. Terminal capture and new-window restoration have passed native cmd, WSL, PowerShell, portable custom-profile Windows Terminal, and Konsole fixtures; shared-process/multi-tab identity remains limited. Workspace capture/reuse/launch, per-axis maximization/fullscreen, and Firefox tab restoration have passed native KDE tests. Startup registration passes native Windows and KDE toggle tests; actual login launches still need validation. Explicit-profile Firefox capture, existing-window reuse, and fresh-window tab restore pass in the Windows fixture. Prior KDE Firefox capture/restore tests passed, but the latest browser-extension changes have not yet been tested on a live KDE desktop. Mixed-DPI displays, desktop-imposed minimum sizes, and elevated Windows applications still need coverage.

```sh
npm test
npm run check
cargo test --manifest-path src-tauri/Cargo.toml
```

Node tests execute the actual KWin script against simulated Plasma 5/6 workspaces to check placement, monitor removal, closed windows, app cycling, and tiling. Editor tests run the UI against a simulated native bridge and cover save failures, registration errors, and preserving edits. Rust tests cover configuration validation, placement math, and native Windows positioning on a hidden test window. The opt-in [native Windows fixture](tests/windows/README.md) exercises the actual app with OS keyboard input, conflict recovery, the editor, workspace capture/launch, startup registration and single-instance behavior using isolated app/browser data.

On tested Plasma 5.27 and 6.3.6 Wayland, KGlobalAccel ends the first shortcut's signal when another shortcut activates, even while the first key is physically held. The new companion replaces that signal as the source of physical release. Final native app regressions now pass both overlap orders on Portafort5.27.11 and supplemental6.3.6, including delayed Firefox responses. Separate48-check runs pass held-key reassignment, pause/resume, radial behavior and companion-loss recovery on both. Independent overlapping app chords also pass on Windows. See [PARITY.md](PARITY.md) for the exact evidence.

Live Wayland tests verify the integration on Plasma 5.27, including a separate two-output KWin session for monitor push/pull and maximized/fullscreen tiling. The compiled Linux app also passed native UI checks for rendering, saving settings, enabling, and pausing. Windows x64 and Ubuntu 24.04 amd64 builds produced an NSIS installer and Debian package. See [live KDE validation](tests/kde/README.md) for reproducible commands and coverage limits. A supplemental KWin 6.3.6 / Qt 6.8.2 session passes 35 native script checks and 39 combined app checks, including pointer centering with default and maximum normal screen-edge resistance. Missing pointer permission is also tested. Live Portafort Plasma 5.27 testing passes the same 39 combined app checks through WSL → Hoster → Portafort. Remaining edge cases and physical-session checks are tracked in [PARITY.md](PARITY.md).

Manual acceptance on each OS: enable the app; push a floating window across two monitors; pull it back; tile it on each side; switch between two windows of the same app; unplug the original display and pull; pause and verify shortcuts are released; quit and verify cleanup. Repeat with maximized windows, portrait displays, and mixed scaling.

## Architecture

- `ui/`: local HTML/CSS/JavaScript editor. All settings and actions pass through narrow Tauri commands; no shell or filesystem API is exposed to the webview.
- `src-tauri/src/app_actions.rs`: application control shortcuts and pending editor/workspace requests.
- `src-tauri/src/radial.rs` and `ui/radial.*`: stable window candidates, shared angular selection, and the temporary picker overlay.
- `src-tauri/src/config.rs`: versioned configuration, canonical shortcut syntax, validation.
- `src-tauri/src/windows.rs`: Win32 window enumeration, positioning, and focus; `windows_reserved.rs` owns the shared keyboard hook.
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

For a new shortcut in the popup, press a key and Enter. Settings chooses the
default modifier; the popup buttons can adjust it. If a key is already used,
choose **Replace** to take it, or **Replace and edit old** to assign the
displaced action a new key immediately. Press the popup shortcut again to open
the main editor, or click outside the popup to close it.

Under Shortcuts, **Find open apps** compares open app identifiers with shortcut
names and existing identifiers. Unambiguous matches are added to the draft;
missing or ambiguous apps are listed for review. Open the apps first and save
the reviewed changes. Additional identifiers can also be edited manually, one
per line. Windows-specific matching criteria remain authoritative on Windows;
additional identifiers provide KDE matches for those bindings.

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
cancellation and pause/resume while held. Windows tests also cover rapid Escape
and focus-loss cancellation; see [PARITY.md](PARITY.md) for the evidence and remaining coverage.


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


Terminal restoration checks fresh shell/profile/distribution identity while
waiting for a new window, so a known incompatible concurrent terminal is not
moved into the saved placement. Konsole selected profile files, shell aliases,
and wrappers with an exactly verified launch command are supported. Shared
processes, multiple tabs, and otherwise identical or unknown session identities
can still require manual review; see [parity tracking](PARITY.md).
