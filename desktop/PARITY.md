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
| Editor from current app, shortcut recording, shared/app shortcut browser, edit/delete/per-binding disable, conflict reassignment | Partial | Recording, search, per-binding disable, behavior controls and reviewed reassignment tested; native KDE current-app capture passes; native Windows editor workflow pending |
| Global pause/resume hotkey stays available while paused; editor/workspace/update hotkeys | Partial | Implemented with separate pause registration; native KDE KGlobalAccel action dispatch passes; physical key delivery, Windows native lifecycle and registration-failure scenarios remain |
| Settings persistence and startup registration | Partial | KDE native toggle creates/removes isolated autostart entry; Windows toggle and actual login/startup launch pending |
| Workspace capture/create/update, best-match update selection, rename/delete/reorder/browser | Partial | Implemented; Rust matching/persistence model and Node editor tests pass; KDE native capture/save/browser pass; full Windows editor workflow pending |
| Workspace launch/reuse, exclude already-consumed windows, wait for new windows, restore placement/state | Partial | KDE native two-window reuse, forced new launch, placement, per-axis maximize/fullscreen pass; Windows owned-window placement/maximize/minimize pass; Windows multi-window launch workflow pending |
| Firefox profile/session capture (Mozilla LZ4), URLs/active tab/title matching, profile-aware restore | Partial | 15 native KDE checks pass on the caption-fix build, including tabs/selection, same-title profile isolation, floating geometry and editor; codec/profile/launch tests pass; live Windows browser path pending |
| Windows Terminal shell/profile/WSL distro detection and restore; Linux terminal equivalent | Partial | Native Windows cmd capture/new-window launch and KDE Konsole named-profile capture/reuse/new-window restoration pass; terminal editor tested; native Ubuntu capture/directory restoration passes; legacy launchers, prompt fallback, and ambiguity have regression coverage; native PowerShell/custom-profile variants still required |
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

## Firefox increment — earlier verification

25 Node tests, 26 Windows Rust tests (with ordinary CIM access), and 21 Linux
Rust tests pass. The Firefox codec/profile/editor/launch paths are implemented.
An initial 14-check native run passed real Firefox 158 session capture, window
reuse, two-tab launch, and selected-tab restoration. Follow-up runs found stale
session selection and a Firefox Wayland unmaximize/resize race; source now
reconciles selection with a unique live title and verifies/retries floating size.

At that checkpoint, the final two-profile/geometry/editor run had not passed.
The last run stopped at WebDriver session creation while Portafort was under
high unrelated workload. Its process is terminal; do not treat it as still running.
Resume `tests/kde/nested.sh --gui ... --firefox` when load permits. The current
binary is on Portafort at `~/.cache/window-warp-01a16f69/window-warp`; the build
receipt is Hoster `hoster-warp-build-20261024-firefox-resize` (exit 0).
The later caption correction below completes the KDE run. Live Windows Firefox
remains unverified.

## Terminal increment

Terminal workspace entries now have editable profile, shell, shell arguments,
working directory, and WSL distribution/user fields. Windows capture reads one
bounded process snapshot; ambiguous descendants require review. Konsole capture
reads the active session, profile, shell PID and directory through D-Bus and
`/proc`. Restore compares terminal identity before reusing a window and launches
a separate native window when needed. Commands running inside a captured shell
are not automatically replayed. Literal semicolons are escaped for wt's parser.

27 JavaScript tests and 34 Windows Rust tests pass. The opt-in native Windows
Terminal test separately passed capture and new-window launch and closed its two
owned windows. Linux has 28 passing Rust tests. The `--terminal` GUI fixture
passed 14 native checks in `hoster-warp-gui-20261024-terminal-checkpoint`, including
shell/profile/directory capture, reuse and new-window restoration. The profile
display name deliberately differs from its filename. The editor screenshot was
inspected and is under `src-tauri/target/kde-validation/terminal/`.
Konsole's unnamed runtime profile uses an explicit launch-profile fallback when
one process owns one window. A missing saved profile file reports an error.
Native WSL/Powershell/custom-profile cases, legacy distro launchers and prompt
identity fallback remain required before the terminal row is complete.

The recovered-host Firefox run (`hoster-warp-gui-20261024-firefox-recovered`)
failed the restored-tab URL assertion before reaching the two-profile/geometry
checks. The caption correction below resolves the failure; it was not solely a
high-load or session-save timing issue.

## Firefox caption correction

KWin appends numeric markers such as `<2>` to duplicate captions. Firefox session
matching now ignores that decoration after the browser brand while preserving
numbers in the page's own title. The native fixture waits for the expected URLs
and selected tab and records the last ten distinct owned-window observations.

35 Windows Rust tests, 29 Linux Rust tests, and 27 Node tests pass. Native
`hoster-warp-gui-20261024-firefox-caption` passed all 15 checks, including the
previously pending same-title profile isolation and floating size restoration.
The editor screenshot was inspected; the saved URLs, selected tab, profile and
review note render without clipping. Native receipt and screenshot are under
`src-tauri/target/kde-validation/firefox/`; pre-fix evidence is under
`src-tauri/target/kde-validation/firefox-caption-before/`. The Linux binary and
Debian package come from `hoster-warp-build-20261024-firefox-caption` (exit 0).
This verifies the Plasma 5.27 path; Windows Firefox and live Plasma 6 remain open.

## WSL distribution discovery

Capture decodes WSL's UTF-16 distribution output, resolves legacy launcher
versions to installed names, and uses an unambiguous user/hostname prompt when
process metadata is inconclusive. Conflicting identities remain a review error.
An explicit process distribution survives changed SSH/custom titles. Discovery
uses bounded noninteractive queries shared across one capture/restore operation.
Known cmd/PowerShell titles avoid querying other tabs' WSL launchers.

40 Windows Rust tests and 27 Node tests pass. Both opt-in native tests pass:
`native_terminal_capture_and_new_window_launch` and, with
`WARP_TEST_WSL_DISTRO=Ubuntu`, `native_wsl_capture_and_directory_restore`. The latter
checks installed distribution/identity discovery, owned-window capture, and a
new terminal whose shell reports `/tmp` after directory restoration. Both close
only their owned windows. Additional PowerShell/custom-profile variants remain.
Linux build `hoster-warp-build-20261024-wsl` passed 32 Rust tests and built the
executable and Debian package (exit 0). The existing Portafort native binary
remains the Firefox caption checkpoint; no new KDE GUI behavior changed.

## Shortcut reassignment

The editor previews which enabled bindings use the chosen shortcut, including
modifier and punctuation aliases. Confirming disables those bindings in the
draft and preserves their settings. Cancel or any subsequent edit discards the
proposal; Save is still required to persist it. 41 Windows Rust tests, 29 Node
tests and JavaScript syntax checks pass. Linux has 33 passing Rust tests.
Native `hoster-warp-gui-20261024-reassignment` passed all 12 checks, including
conflict review/cancel/save and workspace regressions. The inspected screenshot
and report are under `src-tauri/target/kde-validation/reassignment/`.

## Application control shortcuts

Pause/resume uses a separate registration from window actions, retained while
paused and removed on exit. New configurations include pause, current-app editor,
workspace browser and workspace update keys. Existing configurations can add
them through the action selector. The editor captures the active app before
taking focus and pauses shortcuts; workspace updates select the closest profile
in a review draft. Existing unsaved edits are preserved. Pause dispatch bypasses
the busy state used by slower workspace capture.

41 Windows Rust tests, 34 Node tests and syntax checks pass. The first native KDE
control run passed 15 checks through KGlobalAccel's registered action dispatch.
This is native lifecycle/bridge evidence, not physical keyboard injection. The final build
`hoster-warp-build-20261024-controls-focus` passed 33 Linux Rust and 34 Node tests.
`hoster-warp-gui-20261024-controls-focus` passed all 15 checks (exit 0). Reports
and inspected screenshots are under `src-tauri/target/kde-validation/controls/`.
The update shortcut scrolls to its draft and focuses the name field. Windows
native control/UI testing and physical key delivery on both platforms remain
required.
