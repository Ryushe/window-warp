# Full AutoHotkey feature port

The goal is parity with the behavior in the original source, on Windows and KDE.
This checklist is a completion gate, not a reduction of scope. A feature is only
verified when its behavior, persistence, editor, and applicable platform paths
have been exercised. Existing preview installers do not contain ongoing work.

| Requirement / authoritative source | State | Evidence needed |
| --- | --- | --- |
| Monitor push, wrap, relative placement, maximized state, history pull (`window_manager.ahk`) | Partial | Existing tests; maximize/restore and monitor removal live on both OSes |
| Push and center pointer; pull centers primary; 1-second X/C retiling | Pending | Pointer and timeout tests on both OSes, including Wayland |
| Four-way tiling; portrait mouse-aware tile choice | Partial | Four-way implemented; 18 live KDE checks cover vertical tiling; Windows mouse hold tiles natively and portrait/midpoint geometry has regression coverage; KDE native hold verifies key-down pointer choice; physical portrait acceptance remains |
| Maximize/restore toggle (original “fullscreen”); graceful close | Partial | Implemented both OSes; live KDE verified; Windows owned-window action verification pending |
| App pull to primary; active app to burner with float/left/right/maximized layout | Partial | Implemented both OSes; tiled burner round trip live KDE verified; other layouts and Windows live checks pending |
| App focus-last toggle; minimized windows; exact executable/class matching | Partial | Live KDE focus-last and minimized checks pass; Windows native behavior checks pending |
| Tap vs hold, configurable 100–5000 ms delay, disable hold | Partial | Windows OS key events verify release, repeats, modifier-first release, pause/resume cancellation and disabled hold; KDE native key delivery verifies tap, hold, repeats, pause cancellation and disabled hold; resume before key release remains |
| Hold mouse tile; radial picker (stable title order, 8 slots, dead zone, release selection/cancel) | Partial | Windows mouse tile uses the key-down pointer position; KDE hold tile now passes native key delivery; both radial overlays remain pending |
| Editor from current app, shortcut recording, shared/app shortcut browser, edit/delete/per-binding disable, conflict reassignment | Partial | Recording, search, per-binding disable, behavior controls and reviewed reassignment tested; native KDE current-app capture passes; Windows native current-app capture, key recording, reassignment and persistence pass |
| Global pause/resume hotkey stays available while paused; editor/workspace/update hotkeys | Partial | Implemented with separate pause registration; native KDE KGlobalAccel action dispatch passes; Windows OS key delivery, lifecycle and registration-failure recovery pass; KDE native pause/app-pull key delivery passes; editor/workspace key delivery remains direct-dispatch coverage |
| Settings persistence and startup registration | Partial | Windows Run entry and KDE autostart toggles pass; actual login/startup launches remain pending |
| Workspace capture/create/update, best-match update selection, rename/delete/reorder/browser | Partial | Implemented; Rust matching/persistence model and Node editor tests pass; KDE native capture/save/browser pass; Windows capture/review/save and closest-match update draft now pass natively |
| Workspace launch/reuse, exclude already-consumed windows, wait for new windows, restore placement/state | Partial | KDE native two-window reuse, forced new launch, placement, per-axis maximize/fullscreen pass; Windows owned-window placement/maximize/minimize pass; Windows two-window reuse and separate-process launch now pass natively; physical display-change acceptance remains |
| Firefox profile/session capture (Mozilla LZ4), URLs/active tab/title matching, profile-aware restore | Partial | 15 native KDE checks pass on the caption-fix build, including tabs/selection, same-title profile isolation, floating geometry and editor; codec/profile/launch tests pass; live Windows browser path pending |
| Windows Terminal shell/profile/WSL distro detection and restore; Linux terminal equivalent | Partial | Native Windows cmd capture/new-window launch and KDE Konsole named-profile capture/reuse/new-window restoration pass; terminal editor tested; native Ubuntu capture/directory restoration passes; legacy launchers, prompt fallback, and ambiguity have regression coverage; native PowerShell/custom-profile variants still required |
| Packaged Windows apps, ordinary executable launch, Linux desktop app launch | Partial | Ordinary executable launch and argument boundaries pass native Windows/KDE fixtures; packaged Windows and Linux desktop-entry launch remain |
| Import existing apps/shared hotkeys/settings/workspaces INIs with review and migration | Pending | Fixtures including disabled keys, legacy terminal fields, browser tabs |
| Single instance, tray, settings failures, session cleanup, installers | Partial | Windows native single instance, registration failures and process-exit key release pass; final tray/graceful-exit and installer checks remain |

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

## Native Windows application fixture

`node desktop/tests/windows/native.mjs` passed all 14 checks with no skips. This
uses the actual Tauri app, a fresh WebView2 profile, isolated app directories and
owned Win32 windows. It delivers keyboard events through `SendInput`, verifies
pause/resume, native shortcut recording, current-app capture and reviewed alias
reassignment. A helper deliberately holds a key to prove that failed pause-key
changes preserve the previous file/key and failed action registration releases
partial registrations without dropping pause.

The native UI captures and saves only selected fixture windows. Two existing
windows restore to separate placements; a forced launch creates a new process
and restores its placement. Workspace update opens a closest-match draft without
auto-saving. Startup creates/removes a temporary Run entry when none already
exists, a second instance exits, and the pause key becomes free after test-app
termination. The fixture restores the ordinary debug build after testing.

Passing receipt and inspected screenshots:
`src-tauri/target/windows-validation/WARP-NATIVE-515ce6ab-3676-4ca7-9506-cb310df92747/`.
The first harness run stopped on a duplicate CDP JavaScript declaration; a later
recording attempt stopped on an auxiliary-window lookup. Both harness issues are
fixed. The final run passed, its startup entry was absent afterward, and no test
app remained running. This is not evidence of actual login launch, graceful tray
quit, Firefox/profile variants, KDE keyboard delivery or physical display removal.
Those checks and the remaining feature requirements above stay in scope.

## Windows app-pull tap and hold

App-pull shortcuts now wait for release before tapping. With hold tiling enabled,
holding for the saved delay tiles once on the main monitor, using the pointer
position at key-down. Portrait work areas choose top/bottom halves; landscape
and square work areas choose left/right. Settings default to 400 ms with hold
enabled, accept 100–5000 ms, and migrate existing configurations without changing
their bindings. Disabling hold retains tap-on-release even after a long press.

The Windows adapter checks the main key and every required modifier while a
gesture is active. Repeated presses cannot restart its timer. Pause clears the
pending session; re-enabling before release cannot revive it. Shared timing and
geometry tests cover delayed timer ticks, single firing, disabled hold, negative
monitor origins and odd-size midpoint selection.

The native run exposed a pre-existing activation deadlock: a synchronous status
request could wait for the activation mutex on the UI thread while the shortcut
worker needed that thread to unregister keys. Status, configuration save,
activation commands and tray pause/quit now do their blocking work off the UI
thread. Their command names and results are unchanged.

48 Windows Rust tests, 36 Node tests and JS/Python syntax checks pass.
`node desktop/tests/windows/native.mjs` passes all 18 checks with no skips in
`src-tauri/target/windows-validation/WARP-NATIVE-4ed7da75-26b3-488d-9fd3-40483709eb3d/`.
This adds modifier-first tap, held-key repeat suppression, pointer-origin tiling,
pause/resume cancellation before key release, and persisted disable-hold to the
existing native UI/workspace coverage. The hold settings screenshot was inspected.
The helper is now per-monitor DPI-aware; it releases its injected keys and restores
its pointer movement during cleanup. The ordinary debug build was restored.

KDE hold controls explicitly remain unavailable in this increment. The KDE native
hold adapter and both radial pickers are next; all other unfinished rows above
remain required. Linux build `hoster-warp-build-20261024-hold` passes 39 Rust and
36 Node tests and builds the executable and Debian package (exit 0). Native KDE
regression `hoster-warp-gui-20261024-hold-shared` passes all 15 existing checks
(exit 0); report and inspected update screenshot are under
`src-tauri/target/kde-validation/hold-shared/`. This validates shared activation
and UI behavior through KGlobalAccel action dispatch, not KDE hold or OS key input.


## KDE tap/hold increment

The KDE adapter listens to KGlobalAccel press/release signals and uses the
KWin shortcut callback to capture the pointer. It shares the timing state with
Windows, ignores repeats, and cancels pending work before pause completes.
Native registration IDs remain stable across resume because KDE retains inactive
key ownership; callback IDs remain unique per activation to reject stale callbacks.
The editor exposes the same delay/disable settings on both platforms.

KWin now focuses the app's own normal editor window after showing it. Native
Wayland testing reproduced direct client activation being denied; the compositor
focus path fixes current-app/workspace editor activation.

`hoster-warp-build-20261024-kde-hold-stable` exits 0 with 39 Rust tests and
40 Node tests, executable and Debian package. Local Node tests (40), syntax and
Rust formatting checks pass. Windows retains the previous 48 Rust and 18 native
checks; this increment changes the Linux adapter, shared KWin code and editor.

`hoster-warp-gui-20261024-kde-hold-stable` exits 0 with all 20 native checks in
Plasma 5.27. The five new checks use Wayland key events, not direct shortcut
invocation: modifier-first tap, hold with original pointer and repeat suppression,
pause cancellation, disabled long-press tap, and persistent pause/resume keys.
Report, inspected settings screenshot and signal log are under
`src-tauri/target/kde-validation/hold-native/`. Nested logs:
`/tmp/window-warp-nested.yfjyU6` on Portafort.

Still required: pause and resume before releasing the original held key;
actual key delivery after reassigning a key between different binding IDs
(KDE's retained inactive assignments warrant a regression); physical portrait
outputs and Plasma 6. Both radial pickers and every other unfinished row remain
in scope. The existing Windows installers are unchanged.
