# Full AutoHotkey feature port

The goal is parity with the behavior in the original source, on Windows and KDE.
This checklist is a completion gate, not a reduction of scope. A feature is only
verified when its behavior, persistence, editor, and applicable platform paths
have been exercised. Existing preview installers do not contain ongoing work.

| Requirement / authoritative source | State | Evidence needed |
| --- | --- | --- |
| Monitor push, wrap, relative placement, maximized state, history pull (`window_manager.ahk`) | Partial | Existing tests; maximize/restore and monitor removal live on both OSes |
| Push and center pointer; pull centers primary; 1-second X/C retiling | Pending | Pointer and timeout tests on both OSes, including Wayland |
| Four-way tiling; portrait mouse-aware tile choice | Partial | Four-way implemented; 18 live KDE checks cover vertical tiling; mouse choice pending |
| Maximize/restore toggle (original “fullscreen”); graceful close | Partial | Implemented both OSes; live KDE verified; Windows owned-window action verification pending |
| App pull to primary; active app to burner with float/left/right/maximized layout | Partial | Implemented both OSes; tiled burner round trip live KDE verified; other layouts and Windows live checks pending |
| App focus-last toggle; minimized windows; exact executable/class matching | Partial | Live KDE focus-last and minimized checks pass; Windows native behavior checks pending |
| Tap vs hold, configurable 100–5000 ms delay, disable hold | Pending | Actual press/release path, repeats, modifier-first release, pause cancellation |
| Hold mouse tile; radial picker (stable title order, 8 slots, dead zone, release selection/cancel) | Pending | Both native desktop paths and rendered overlay |
| Editor from current app, shortcut recording, shared/app shortcut browser, edit/delete/per-binding disable, conflict reassignment | Partial | Recording, search, per-binding disable and behavior controls implemented and Node-tested; current-app capture/conflict reassignment pending |
| Global pause/resume hotkey stays available while paused; editor/workspace/update hotkeys | Pending | Lifecycle and registration tests, including conflicts |
| Settings persistence and startup registration | Partial | KDE native toggle creates/removes isolated autostart entry; Windows toggle and actual login/startup launch pending |
| Workspace capture/create/update, best-match update selection, rename/delete/reorder/browser | Partial | Implemented; Rust matching/persistence model and Node editor tests pass; KDE native capture/save/browser pass; full Windows editor workflow pending |
| Workspace launch/reuse, exclude already-consumed windows, wait for new windows, restore placement/state | Partial | KDE native two-window reuse, forced new launch, placement, per-axis maximize/fullscreen pass; Windows owned-window placement/maximize/minimize pass; Windows multi-window launch workflow pending |
| Firefox profile/session capture (Mozilla LZ4), URLs/active tab/title matching, profile-aware restore | Pending | Synthetic profiles plus real fixture browser windows |
| Windows Terminal shell/profile/WSL distro detection and restore; Linux terminal equivalent | Pending | Shell/profile fixtures and native launch checks |
| Packaged Windows apps, ordinary executable launch, Linux desktop app launch | Pending | Argument-safe launch tests and native fixtures |
| Import existing apps/shared hotkeys/settings/workspaces INIs with review and migration | Pending | Fixtures including disabled keys, legacy terminal fields, browser tabs |
| Single instance, tray, settings failures, session cleanup, installers | Partial | Preview verified; repeat for final implementation |

## Platform investigation

Portafort's Plasma 5.27 KGlobalAccel component exposes both
`globalShortcutPressed` and `globalShortcutReleased` on the session bus (verified
by live introspection). This provides an event-driven basis for hold detection;
the JavaScript shortcut callback alone is insufficient. KDE's workspace exposes
read-only cursor position, so pointer warping requires a compositor-supported
integration beyond assigning `workspace.cursorPos`.

## Validation recorded before the full port

Preview: 12 Node tests; 6 Windows Rust tests; 5 Linux Rust tests; 9 live KWin
checks in an isolated two-output Wayland session; 4 native Linux UI checks.
These results do not prove completion of the pending requirements above.

## First full-port increment

20 Node tests and 11 Windows Rust tests pass. The isolated two-output KWin run passes 18 checks, adding
vertical tiles, maximize/restore geometry, main/burner round trip, previous-app
focus, and graceful close of a separate owned fixture. Logs:
`/tmp/window-warp-nested.gmHk6n` on Portafort. Source contains startup registration,
which has not yet been exercised through the native editor or login sequence.
The shipped preview installers have not been rebuilt for this increment.

## Workspace increment

24 Node tests, 16 Windows Rust tests, and 13 Linux Rust tests pass. The Windows
native fixture exercises capture, placement, maximize/minimize, own-process
exclusion, and stale PID rejection. `tests/kde/gui.py` passes 11 native checks on
Plasma 5.27, including startup registration, two same-app windows restored to
separate placements, forced new-window launch, per-axis maximization, fullscreen,
and the saved-workspace browser. Only owned fixture windows are restored.
The KDE command bridge has no idle polling or keyboard assignment.

Native report and screenshot: `src-tauri/target/kde-validation/workspaces/`.
Remote receipt: Portafort `~/.cache/window-warp-01a16f69/gui-workspaces-states/`;
Hoster service `hoster-warp-gui-20261024-states` exited successfully. The latest
Linux executable and Debian package were built by
`hoster-warp-build-20261024-workspaces`; existing Windows installers remain old.

Next substantial work: browser/terminal specialization and INI migration;
press/release events, shared gesture state machine, native hold tile/radial,
pointer centering, and remaining editor/global-hotkey behavior. Keep all rows
above in scope, including unverified Windows and Plasma 6 paths.
