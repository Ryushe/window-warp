# Full AutoHotkey feature port

The goal is parity with the behavior in the original source, on Windows and KDE.
This checklist is a completion gate, not a reduction of scope. A feature is only
verified when its behavior, persistence, editor, and applicable platform paths
have been exercised. Existing preview installers do not contain ongoing work.

| Requirement / authoritative source | State | Evidence needed |
| --- | --- | --- |
| Monitor push, wrap, relative placement, maximized state, history pull (`window_manager.ahk`) | Partial | Existing tests; maximize/restore and monitor removal live on both OSes |
| Push and center pointer; pull centers primary; 1-second X/C retiling | Partial | Windows native app-pull centering passes; centered Windows push needs a second display; KDE native centered push/pull, permission refusal and X11 movement pass; timed X/C retiling remains unimplemented |
| Four-way tiling; portrait mouse-aware tile choice | Partial | Four-way implemented; 18 live KDE checks cover vertical tiling; Windows mouse hold tiles natively and portrait/midpoint geometry has regression coverage; KDE native hold verifies key-down pointer choice; physical portrait acceptance remains |
| Maximize/restore toggle (original “fullscreen”); graceful close | Partial | Implemented both OSes; live KDE verified; Windows owned-window action verification pending |
| App pull to primary; active app to burner with float/left/right/maximized layout | Partial | Implemented both OSes; tiled burner round trip live KDE verified; other layouts and Windows live checks pending |
| App focus-last toggle; minimized windows; exact executable/class matching | Partial | Live KDE focus-last and minimized checks pass; Windows native behavior checks pending |
| Tap vs hold, configurable 100–5000 ms delay, disable hold | Partial | Windows OS key events verify release, repeats, modifier-first release, pause/resume cancellation and disabled hold; KDE native key delivery verifies tap, hold, repeats, pause cancellation and disabled hold; resume before key release and reassignment while held now pass; overlapping distinct chords and live Plasma 6 remain |
| Hold mouse tile; radial picker (stable title order, 8 slots, dead zone, release selection/cancel) | Partial | Windows and KDE native selection/dead-zone/Escape/pause checks pass; focus loss cancels before release, including Windows Alt+Escape; shared eight-slot layout/order tested; physical portrait/mixed-DPI and Plasma 6 acceptance remain |
| Editor from current app, shortcut recording, shared/app shortcut browser, edit/delete/per-binding disable, conflict reassignment | Partial | Recording, search, per-binding disable, behavior controls and reviewed reassignment tested; native KDE current-app capture and physical-key reassignment pass; Windows native current-app capture, key recording, reassignment and persistence pass |
| Global pause/resume hotkey stays available while paused; editor/workspace/update hotkeys | Partial | Implemented with separate pause registration; native KDE KGlobalAccel action dispatch passes; Windows OS key delivery, lifecycle and registration-failure recovery pass; KDE native pause/app-pull key delivery passes; editor/workspace key delivery remains direct-dispatch coverage |
| Settings persistence and startup registration | Partial | Windows Run entry and KDE autostart toggles pass; actual login/startup launches remain pending |
| Workspace capture/create/update, best-match update selection, rename/delete/reorder/browser | Partial | Implemented; Rust matching/persistence model and Node editor tests pass; KDE native capture/save/browser pass; Windows capture/review/save and closest-match update draft now pass natively |
| Workspace launch/reuse, exclude already-consumed windows, wait for new windows, restore placement/state | Partial | KDE native two-window reuse, forced new launch, placement, per-axis maximize/fullscreen pass; Windows owned-window placement/maximize/minimize pass; Windows two-window reuse and separate-process launch now pass natively; physical display-change acceptance remains |
| Firefox profile/session capture (Mozilla LZ4), URLs/active tab/title matching, profile-aware restore | Partial | 15 native KDE checks pass on the caption-fix build, including tabs/selection, same-title profile isolation, floating geometry and editor; codec/profile/launch tests pass; live Windows browser path pending |
| Windows Terminal shell/profile/WSL distro detection and restore; Linux terminal equivalent | Partial | Native Windows cmd capture/new-window launch and KDE Konsole named-profile capture/reuse/new-window restoration pass; terminal editor tested; native Ubuntu capture/directory restoration passes; legacy launchers, prompt fallback, and ambiguity have regression coverage; native PowerShell/custom-profile variants still required |
| Packaged Windows apps, ordinary executable launch, Linux desktop app launch | Partial | Ordinary executable launch and argument boundaries pass native Windows/KDE fixtures; packaged Windows and Linux desktop-entry launch remain |
| Import existing apps/shared hotkeys/settings/workspaces INIs with review and migration | Partial | Review/import/save verified natively on Windows and KDE; disabled keys, terminal fields, Firefox tabs and geometry retained; packaged launch and unsupported AHK matches still need conversion; both center actions now convert |
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


## KDE key reservation cleanup

Pausing/unloading now unregisters only the unloaded script's Window Warp action
family through KGlobalAccel. This releases inactive reservations that otherwise
prevent a different binding from taking the saved key. Pause/control registrations
and unrelated KWin action IDs remain separate. Configured app keys are authoritative;
edit them in Window Warp rather than relying on a KWin override to persist.

`hoster-warp-build-20261024-kde-unregister` exits 0 with 41 Linux Rust tests and
40 Node tests, executable and Debian package. Native
`hoster-warp-gui-20261024-kde-unregister` exits 0 with 21 checks using
`--hold --reassign-native`. It verifies real reassigned key delivery and preservation
of other action IDs. Evidence is under `src-tauri/target/kde-validation/reassign-native/`;
nested logs are `/tmp/window-warp-nested.NbMnIx` on Portafort.

The separate `--hold --resume-held` regression fails both before and after this
fix: pause/resume while the original chord remains held can restart the gesture
from autorepeat. Latest receipt: `hoster-warp-gui-20261024-kde-resume-cleanup`
(exit 1, expected cancellation assertion). This is a known incomplete behavior,
not merely missing coverage. Preserve the assertion and fix the native release
lifecycle before claiming gesture parity. Do not use a delay heuristic to mask it.


## KDE held-key cancellation and script readiness

The cancellation regression above is resolved. Each app chord has an independent
hook; pause removes unheld hooks and retains only the cancelled held hook until
its release signal. The worker survives pause/resume, ignores cancelled repeats,
and applies an edited binding after the old chord releases. Ordinary window
shortcuts still unload on pause. A fresh press after cancellation is verified.

Native testing also exposed Plasma 5 reusing a numeric script ID already occupied
by another script. The loader detects an occupied endpoint, uses KWin's scripting
startup method, and requires an acknowledgement from its own new script. Loading
metadata alone can no longer report successful activation of an unstarted script.

`hoster-warp-build-20261024-kde-ready` builds the executable and Debian package
(exit 0; 43 Rust and 40 Node tests). Added readiness/ownership assertions then pass
all 44 Linux Rust tests in `hoster-warp-tests-20261024-kde-ready` (exit 0), without
changing production code. Windows Rust tests pass 48, with the same two opt-in
terminal tests ignored. Local Node tests pass 40; formatting and syntax checks pass.

`hoster-warp-gui-20261024-kde-ready` passes all 22 native checks with
`--hold --resume-held --reassign-native` (exit 0). Receipt and inspected paused
editor screenshot: `src-tauri/target/kde-validation/held-cancellation/`.
Nested logs: `/tmp/window-warp-nested.v4ck3M` on Portafort. The new assertions cover
pause via the app command while a native key remains down, removal of another
unheld gesture hook, fresh input after release, and reassignment while held.
The separate pause hotkey's native delivery is also covered; two overlapping
physical global chords still need their own check. Live Plasma 6, physical
portrait/mixed-DPI outputs, radial selection, pointer/retile behavior, migration,
and all other unfinished rows remain required.


## Radial picker increment

Settings now select mouse tiling (the compatible default) or a radial picker.
The shared model captures up to eight windows, sorts case-insensitive titles with
native identity as the tie-breaker, and numbers duplicate labels. The 260px
picker is clamped to the pointer work area, has a 10px dead zone and clockwise
selection from the top. More than four labels use compact, non-overlapping slots.
A release chooses the captured native window; Escape, close, pause and superseded
sessions cancel. Native identity is checked again before applying the binding's
existing main/burner/focus-last behavior. Only visible held pickers poll the pointer.

The initial Linux radial build passed 46 Rust tests. Native
`hoster-warp-gui-20261024-radial` and `...-radial-layout` each passed 26 checks,
including eight of nine owned windows, pointer selection on release, dead-zone
cancellation, native Escape, and pause/resume before release. The first screenshot
exposed overlapping labels; compact slots and centered instructions fix that.
Node coverage now has 43 tests, including all 1–8 slot layouts and the original
active-window semantics while a picker temporarily owns focus.

Windows unit tests passed 50 (two opt-in terminal tests ignored) before the final
focus-order correction. The first native run failed because the two fixture
webviews had different WebView2 debug options; both now use the same options.
Subsequent runs could not programmatically focus the owned input fixture. Its
helper now permits a verified title-bar click on its own window, restores the
pointer/topmost flag and still refuses to send keys without verified owned focus.

A no-rebuild run of the existing Windows radial executable reached real pointer
selection but failed to focus the selected window on release. Its report is
`src-tauri/target/windows-validation/WARP-NATIVE-5d25ec84-29f8-46cd-abe9-3697850c580d/result.json`.
The implementation now applies the selected window before hiding the picker;
hiding first can relinquish this process's foreground eligibility. **This fix
still requires a fresh Windows native run**; the failed selection is not counted
as passing. Rerun `node desktop/tests/windows/native.mjs` when Windows memory is
available. The fixture has four added radial assertions and uses one build job
without final-crate debug symbols.

Local compilation ran out of system commit even with those reduced build options.
Latest failed build: `WARP-NATIVE-8d525638-69c1-4dec-abec-999cc5d3bfaa/build.log`.
No task-owned WebView processes remained; unrelated processes were left alone.
The ordinary debug build was not restored after the earlier failure in
`WARP-NATIVE-84a75699-a9e2-4700-9e6b-1bb6ff931f68/restore-build.log`.
Rebuild before using that debug executable. Incremental caching remains disabled
and the cleared incremental directory is empty. Existing Windows installers
remain old; this is an incomplete feature checkpoint, not a release.

Full parity remains open: the Windows radial retest, overlapping distinct held
chords, pointer centering/timed retile, INI migration, packaged and desktop-entry
launch, remaining Windows browser/terminal/action cases, physical displays,
Plasma 6, login/startup, graceful tray quit and installer/release review.

Final exact-source Linux receipt: `hoster-warp-build-20261024-radial-focus` exits 0
with 46 Rust tests, 43 Node tests, executable and Debian package.
`hoster-warp-gui-20261024-radial-focus` exits 0 with all 26 native checks, using
`--hold --resume-held --reassign-native --radial`. Nested session logs:
`/tmp/window-warp-nested.27oNxI` on Portafort. The final screenshot was inspected:
all eight slots and both centered instructions are separate and readable. The
local final report/screenshot is under `src-tauri/target/kde-validation/radial/`.
This validates the current Linux focus-before-hide behavior as well as the final
layout; Windows correction verification remains pending for the reason above.


## Windows radial verification after memory recovery

`node desktop/tests/windows/native.mjs` now passes all 22 checks with no skips.
Fresh receipt: `src-tauri/target/windows-validation/WARP-NATIVE-42666202-5045-4fed-9580-d4fe8bcd9dcf/`.
This supersedes the Windows radial failure and memory blocker above. Selection
focuses the chosen second window on release; dead-zone, native Escape and
pause/resume cancellation all pass. The inspected picker screenshot has readable,
separate labels and instructions. The ordinary debug build was restored
successfully (`restore-build.log`, exit 0).

The current Windows Rust suite passes 50 tests, with the two existing opt-in
terminal tests ignored. No runtime code changed after the verified Linux radial
receipt. INI migration and all other unfinished rows remain in scope.


## Reviewed INI migration and newly reproduced Escape regression

The app now reads the four original INI formats into review entries. Shortcuts
append to existing unsaved edits; settings merge only fields present in the INI;
workspaces open as new drafts. Persistence remains in the existing explicit Save
flows. Unsupported entries retain their original fields in the review. Linux
imports preserve Windows identity, disable app shortcuts for adaptation and keep
workspaces Windows-scoped until edited. Reference work areas and window matching
fields are editable because legacy files omit the original display work areas.

53 Node tests and 50 Windows Rust tests pass (two opt-in terminal tests ignored).
`hoster-warp-build-20261024-import` exits 0 with 46 Linux Rust tests, 52 Node tests,
executable and Debian package. `hoster-warp-gui-20261024-import` exits 0 with 17
native KDE checks, including UTF-16 review, explicit Save and Windows-platform
preservation. Report and inspected screenshot: `src-tauri/target/kde-validation/import/`.
Nested logs: `/tmp/window-warp-nested.Q6JAxp` on Portafort.

The Windows diagnostic run `node desktop/tests/windows/native.mjs --skip-escape`
passes 23 checks with one explicit skip. Receipt:
`src-tauri/target/windows-validation/WARP-NATIVE-0f28c784-4d06-4f64-b58e-ee75d3bfab14/`.
It verifies actual UTF-16 file selection, disabled-key persistence, unsupported
match review, workspace terminal/browser fields and edited geometry. Both import
screenshots were inspected; the normal debug build restored successfully.
This is not a complete native acceptance result.

Repeated default runs exposed intermittent Windows cancellation failure for an
immediate Escape down/up while modifiers stay held. The earlier 22-check pass
did not establish reliability. Latest failed receipt:
`WARP-NATIVE-3c6bd49d-01ac-4a29-9a99-359cadb4f35f/result.json`.
The default fixture retains the assertion and now repeats it five times. A
temporary low-level hook experiment did not reliably receive injected events
and was removed; no experimental hook remains in production. Fix this before
claiming radial completion. Do not increase the test key duration to hide it.

After native receipts, focused Node coverage added known terminal-title shell
inference, removed an inapplicable packaged-launch note for Windows Terminal,
and kept WSL fields reachable while adapting to Konsole. Those refinements pass
53 Node tests; native binaries above predate them. Existing Windows installers
remain old. Resume with reliable Windows Escape cancellation, then pointer/retile,
remaining migration/launch cases, platform acceptance and all unfinished rows.

## Radial focus-loss cancellation verified

Native focus loss now cancels the visible picker. The Windows failure above was
Alt+Escape cycling windows while the app chord still held Alt: the webview lost
focus without receiving Escape. This supersedes the missed-poll diagnosis; no
keyboard hook or longer test key press is needed. Cancellation happens before
chord release, and release must preserve the foreground and window positions
left by the OS shortcut rather than asserting which window the OS should focus.

The full Windows native fixture passes all 24 checks with no skips, including
five immediate Escape taps. Receipt:
`desktop/src-tauri/target/windows-validation/WARP-NATIVE-c09b5d09-8aa8-4f9c-9ea7-fa457955e8fd/`.
The ordinary debug build restored successfully. The diagnostic skip option is
removed. Current Windows Rust tests: 50 pass, two opt-in terminal tests ignored;
Node tests: 53 pass. Both native binaries include the final import refinements.

Linux build `hoster-warp-build-20261024-focusloss` is inactive/exit 0 with 46 Rust
tests, executable and Debian package. Combined native KDE run
`hoster-warp-gui-20261024-focusloss` is inactive/exit 0 with 29 checks using
`--hold --resume-held --reassign-native --radial --import`. It verifies native
Escape and focus-loss cancellation without later selection, plus migration and
held-key lifecycle. Report and inspected radial/import screenshots:
`desktop/src-tauri/target/kde-validation/focusloss/`. Nested logs:
`/tmp/window-warp-nested.0d0Hbi` on Portafort.

WSL reported a networking startup error. A temporary task-owned Windows TCP
stdio transport lets WSL SSH retain its existing key and host verification while
reaching Hoster's Tailscale IP. No networking/service settings or SSH keys changed.
Both task units are terminal; no persistent transport or listener was started.

Resume with pointer centering and the one-second X/C retile behavior, then every
remaining PARITY requirement. Existing Windows installers are old. No merge,
push, installation or user-session activation; this remains an incomplete port.
