# Cross-platform application integration dossier

- Status: feature, incomplete
- Owner: current Codex chat, user-requested full feature port
- Branch / owning ref: `codex/cross-platform-app`
- Worktree: existing `hotkeyable_windows` checkout
- Base commit: `7b907778f0022d73fb3527b82c0ab7ecedf8124d`
- Intended eventual target: `main`; promotion/merge has not been requested
- Last updated: 2026-10-24
- Latest immutable recovery checkpoint: `9ccbaa77dd0fe475e995ae382a7b18abaecb54d8`
- Feature implementation commits: `abfc95e` (desktop/workspace foundation), `ee7bee4` (Firefox profiles/tabs), `c09d79c` (terminal capture/editor/restore), `491a9d8` (KDE Firefox caption correction and complete 15-check native run), `5e6373d` (WSL distribution discovery and native directory restoration), `02d4e02` (reviewed shortcut reassignment and 12-check native KDE run), `b216f0c` (persistent pause and application control hotkeys, 15 native KDE checks), `d49e380` (14 native Windows application checks), `9794b75` (Windows tap/hold, activation deadlock correction, 18 Windows and 15 KDE native checks), `b63cb1d` (KDE native tap/hold, Wayland editor focus, 20 native KDE checks), `41fbc70` (KDE key reservation cleanup, 21 native KDE checks, held-key regression reproduced), `da23019` (held-key cancellation and deferred reassignment, verified script startup, 22 native KDE checks), `61233ff` (shared radial picker, 26 native KDE checks; initial 22 native Windows pass later superseded by rapid Escape regression), `4a92065` (reviewed INI migration and native import receipts), `9ccbaa7` (portable fixture line endings)
- Canonical references: original root AHK files; `desktop/PARITY.md`

## Intent and implemented contract

Port all original features into a standalone Windows/KDE application. The user's
explicit branch requirement is satisfied by this existing feature branch.
Original AHK sources remain unchanged. Full parity is not achieved: the checklist
is the completion gate, including remaining browser verification, terminal variants, INI migration,
KDE gesture edge cases, radial selection, pointer movement, and remaining shortcut/editor paths.

The current implementation includes the Tauri editor/tray, native Windows/KWin
window actions, startup registration, and workspace capture/review/edit/restore.
Workspace launch uses separate program/argument values, matches each saved entry
to a distinct window, and reports individual restore failures. KDE workspace
commands use a persistent session-bus service and an unassigned KWin action.

Firefox capture now reads size-prefixed Mozilla LZ4 sessions with fallback to the
backup session, respects current history entries, retains selected-tab identity,
and records an editable profile/tab specification. A unique live title corrects
stale selected-tab metadata; unresolved/stale captures show a review note. Restore
uses profile arguments, reuses matching windows, or opens a new window before
adding remaining tabs. Windows process arguments use CIM plus the native argv
parser; Linux uses `/proc`. Neither path invokes a shell for app launch.

## Evidence and review

- `npm test` (desktop): 24 pass; `npm run check`: pass.
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml --offline`: 16 pass,
  including owned native Windows capture, placement, maximize/minimize and stale PID.
- Linux `tests/kde/build.sh`: 24 Node + 13 Rust release tests pass; executable and
  Debian package built by `hoster-warp-build-20261024-workspaces` (exit 0).
- Native `tests/kde/gui.py`: 11 checks pass in Plasma 5.27 / WebKitGTK 2.52.6,
  via `hoster-warp-gui-20261024-states` (exit 0). Test restores only owned fixtures.
- Report/screenshot: Portafort `~/.cache/window-warp-01a16f69/gui-workspaces-states/`,
  copied locally under `desktop/src-tauri/target/kde-validation/workspaces/`.
- Screenshot inspected: workspace cards and controls render without clipping.
- Earlier two-output KWin test passed 18 checks; see parity checklist for receipt.
- Firefox increment: 25 Node tests and 26 Windows Rust tests pass. The own-process
  CIM test requires ordinary Windows CIM access; sandbox execution denied it,
  and the same test passed outside the sandbox. The complete suite then passed.
- Initial native Firefox 158 test passed capture, reuse, and new-window restoration
  of two URLs and the selected tab in an isolated KDE session. A subsequent run
  exposed stale selected-tab metadata; a regression test and title reconciliation
  fix were added. Two-profile testing then exposed Firefox's asynchronous
  unmaximize response replacing the requested size. KDE floating-window restore
  now verifies placement and retries within a bounded operation, reporting a
  refused size rather than claiming success. The caption correction below later
  passed the complete native run, including floating placement.
- Earlier Linux build: `hoster-warp-build-20261024-firefox-resize` completed with
  25 Node tests, 21 Rust tests, executable and Debian package. The last native run,
  `hoster-warp-gui-20261024-firefox-sequential`, failed creating the WebDriver session
  before any app assertions. Portafort load was 46.27 with unrelated Steam/browser
  processes active; no task-owned process remained. Do not restart or kill those
  unrelated workloads. Later native evidence supersedes this verification gap.
- Independent release review: pending. No merge, push, installation, or activation.

## Blockers and deferred work

- Remote refresh: `git fetch origin` failed with SSH host-key verification.
  Verify the configured GitHub SSH host key before refreshing refs for integration.
  This does not block implementing/testing this existing feature branch.
- Full feature scope and missing native evidence remain in `desktop/PARITY.md`.
  In particular, remaining Windows action/browser/terminal variants, startup
  login launches, gesture edge cases, and live Plasma 6 must run before parity is claimed.
- Existing Windows installers predate this checkpoint; rebuild after remaining work.
- Firefox KDE evidence: all 15 `tests/kde/nested.sh --gui ... --firefox` checks
  now pass, including geometry; the editor screenshot was inspected. Windows
  Firefox UI and actual Plasma 6 still require native verification. The current
  Portafort binary is the KDE hold build documented in the latest section.
- Hoster cleanup sidecar inspected two unregistered live scopes, retained both,
  stopped none (`needs-attention`). No action on unrelated workloads is needed.

## Resume and gates

Resume terminal variant coverage and INI migration, plus Windows Firefox native
verification. Then gesture/radial,
pointer, and outstanding editor/global-hotkey behavior. Preserve all checklist rows.
Native KDE fixture tests and local Node/Rust tests are ready for reuse.
The implementation checkpoint is reachable from the owning branch; the subsequent
dossier-only commit records its identity. The working tree was clean after the
implementation checkpoint. `main` remains at the base commit and no AHK file differs.

Integration requires completed parity evidence, independent review, verified
remote state, and explicit selection/authorization of the integration target.
Runtime activation requires rebuilding and verifying actual launch/install paths.
Stable promotion remains a separate user decision. This checkpoint is partial
feature work, not a release candidate.

## Decision record

- 2026-10-24: Workspace core is implemented and exercised on KDE; Windows native
  capture/placement/state checks pass. Save a recoverable feature checkpoint and
  continue the full port.
- 2026-10-24: Firefox capture/restore and editor implemented; live testing found
  and prompted a correction for asynchronous session selected-tab metadata.

## Terminal increment

- Added terminal capture, editable session fields, identity-aware reuse, and native
  Windows Terminal/Konsole launch commands. Windows metadata is one bounded CIM
  snapshot; KDE uses Konsole's active session API and reads that shell's `/proc`
  executable/directory. Ambiguous capture prompts review instead of selecting a
  different shell silently. The model preserves separate program/argument values.
- 27 Node tests and 34 Windows Rust tests pass. Native opt-in
  `cargo test --manifest-path desktop/src-tauri/Cargo.toml --offline
  native_terminal_capture_and_new_window_launch -- --ignored --nocapture` passed:
  captures an owned cmd Terminal, launches another window, closes only those two.
- Linux build `hoster-warp-build-20261024-terminal-checkpoint` has passed 27 Node
  and 28 Rust tests and produced the executable and Debian package (exit 0).
- Native `hoster-warp-gui-20261024-terminal-checkpoint` passed 14 checks, including
  Konsole shell/profile/directory capture, reuse, and new-window restoration.
  The profile display name differs from its file name. This is the current binary
  on Portafort. Its nested logs are `/tmp/window-warp-nested.j8ZpJB`.
  `src-tauri/target/kde-validation/terminal/window-warp-terminal-kde.png` was
  inspected: controls and saved values render without clipping.
- Konsole's session API returned an unnamed runtime profile with `-e`, even
  when a named profile was explicitly selected. The fallback reads the explicit
  profile launch argument only when the process owns one window. Captured
  profile files take priority over display names, as required by Konsole's CLI.
- Remaining terminal gaps: native WSL/Powershell/custom-profile verification,
  legacy distribution launcher detection and prompt-identity fallback, and
  ambiguous multi-window/profile cases. Keep the parity row partial.
- Firefox retry on the recovered host ended with status 1 at the restored-tab
  URL assertion (`gui.py`), unit `hoster-warp-gui-20261024-firefox-recovered`;
  nested logs `/tmp/window-warp-nested.ZUjbKP`. It did not reach the geometry
  assertion. Add owned-window/session diagnostics before changing production
  behavior; a two-tab count alone may precede navigation/session persistence.
- Disk-space interruption is resolved: the user-approved incremental cache was
  removed; afterward C: regained roughly 14.5 GiB externally. The larger cache
  cleanup was not performed. No unrelated files were deleted.

## Firefox duplicate-caption correction

The owned-window diagnostic run `hoster-warp-gui-20261024-firefox-observe`
showed a restored caption ending in `Mozilla Firefox <2>` and empty tab capture
for the full readiness window. KWin's duplicate-caption decoration prevented the
existing Firefox title matcher from identifying its session. The correction
removes numeric duplicate markers only after a recognized Firefox brand; a
page's own angle-bracketed number remains intact. This normalization is shared
by session scoring and selected-tab reconciliation.

The owning/lowest applicable branch is `codex/cross-platform-app`. The Firefox
implementation commit is contained only in that local branch; no other local
descendant needs propagation, and the original AHK branches are unchanged. No
public identifiers, configuration keys, or paths changed. The diagnostic fixture
now waits for expected URLs and the selected tab, not merely a two-tab count,
and writes its last ten distinct owned-window observations on completion.

35 Windows Rust tests pass (the separate native Terminal test is opt-in).
`hoster-warp-build-20261024-firefox-caption` passed 27 Node and 29 Linux Rust tests,
and built the executable and Debian package. The native unit
`hoster-warp-gui-20261024-firefox-caption` exited 0 with all 15 checks passing:
capture, profile reuse, both restored URLs and selected tab, identical-title
profile isolation and floating geometry. No further geometry change was needed.
Its report, observations and inspected editor screenshot are retained under
`src-tauri/target/kde-validation/firefox/`; before-fix evidence is under
`src-tauri/target/kde-validation/firefox-caption-before/`. The screenshot includes
a review note from a temporary nonresponsive fixture caption; the saved tab data
and restoration assertions passed. Both service handles are terminal.

No Windows Firefox or Plasma 6 native claim is made. The full parity checklist
remains the completion gate; this correction closes the observed KDE failure.

## WSL capture and restoration

The Windows terminal path now resolves installed distribution names from legacy
launchers and window titles and can compare prompt user/hostname against bounded
noninteractive WSL probes. UTF-16 list output is decoded before matching; shared
identities produce an explicit review error. CIM failure retains known-shell
title fallback. Explicit WSL commands are captured as shell identity only, never
as commands to replay. Known cmd/PowerShell titles bypass other tabs' launchers.

40 Windows Rust tests, 27 Node tests and JavaScript syntax checks pass. Native
`native_terminal_capture_and_new_window_launch` passed again after the metadata
helper extraction. `WARP_TEST_WSL_DISTRO=Ubuntu cargo test --manifest-path
desktop/src-tauri/Cargo.toml --offline native_wsl_capture_and_directory_restore
-- --ignored --nocapture` passed installed-name/identity discovery, capture and a
new-window launch whose shell reports its restored `/tmp` directory. Fixtures
close only their owned HWNDs after checking PIDs. These tests require ordinary
Windows process/WSL access and ran outside the restricted sandbox.

Linux build `hoster-warp-build-20261024-wsl` passed 32 Rust tests and 27 Node tests,
then built the executable and Debian package (service inactive, exit 0). The
Portafort native binary remains the Firefox caption checkpoint.
The user-approved incremental build cache was removed again; no source or
unrelated files were deleted. Builds run with `CARGO_INCREMENTAL=0`.
Next: remaining terminal profile variants and the other open PARITY requirements.
No merge, push, installation or activation was performed.

## Reviewed shortcut reassignment

The native configuration normalizer computes a proposal to assign a key to the
chosen binding and disable only enabled conflicts. Existing settings are retained.
The UI names affected bindings, offers confirmation/cancel, invalidates stale
proposals after edits, and persists only when Save is clicked. The command does
not mutate runtime registrations or files. This supports sequential correction
of a draft with multiple conflicts without discarding unrelated invalid edits.

41 Windows Rust tests, 29 Node tests, JavaScript syntax and Python fixture syntax
checks pass. The KDE fixture now exercises review, cancel, draft-only application
and explicit persistence through the native bridge. Native service
`hoster-warp-gui-20261024-reassignment` passed all 12 checks (inactive, exit 0),
including the existing workspace regression suite. Its nested session logs are
`/tmp/window-warp-nested.WXfkDs`; local report and inspected screenshot are under
`desktop/src-tauri/target/kde-validation/reassignment/`. The review text and
buttons fit without clipping. Linux build `hoster-warp-build-20261024-reassignment`
passed 33 Rust and 29 Node tests and produced the executable and Debian package;
this is now the test binary on Portafort. The full Windows UI path remains open.

Next concrete work: persistent pause/resume and editor/workspace control hotkeys,
including current-app capture, then the remaining gesture and INI migration
requirements. Preserve the open terminal/profile and browser native checks in
PARITY.md. No merge/push or user-session installation/activation was requested.

## Application control shortcuts and current-app editing

Implemented separate persistent pause registrations on Windows and KDE. Window
action disable/registration rollback does not remove the pause key. Config save
prepares its temporary file, updates pause registration, and restores the prior
registration if applying or saving fails. Windows tracks registrations that
failed to unregister so a subsequent cleanup can retry them. KDE uses a separate
pause script and the authenticated, fixed-action control endpoint.

Application actions capture before taking editor focus. Current-app editing
pauses window actions and creates/reuses an app binding without discarding edits.
Workspace update captures a review draft and selects the closest existing profile.
Pending requests survive UI initialization; existing workspace drafts are kept.
Pause is independent of the workspace capture busy flag. New configurations get
Ctrl+Alt+P/B/O/U defaults; existing saved bindings are not silently expanded.

41 Windows Rust tests, 34 Node tests and JS/Python syntax checks pass. The first
native service `hoster-warp-gui-20261024-controls` passed all 15 checks, including
registered KGlobalAccel action dispatch for pause/resume, owned current-app
capture and workspace controls. It exited 0; nested logs are
`/tmp/window-warp-nested.C2Zt3X`. This does not establish physical keyboard event
delivery. Final native service
`hoster-warp-gui-20261024-controls-focus` passed all 15 checks (inactive, exit 0),
including the responsiveness change and a screenshot-discovered focus correction:
the update hotkey now scrolls directly to the review draft and focuses its name.
The final report/current-app/update screenshots are under
`desktop/src-tauri/target/kde-validation/controls/`; both editor views were
inspected and the review fields fit without clipping. Nested logs:
`/tmp/window-warp-nested.JXuBXo`. Linux build
`hoster-warp-build-20261024-controls-focus` passed 33 Rust and 34 Node tests and
produced the executable and Debian package (inactive, exit 0). This is now the
test binary on Portafort.

At this checkpoint the next native gap was a Windows application/UI fixture covering
pause registration and rollback, current-app capture and workspace controls.
The existing native window/terminal tests do not instantiate those app flows.
Then continue hold/radial, pointer/retile and INI migration requirements in PARITY.
No merge, push or user-session activation has been requested.

For the Windows fixture, installed `tauri-codegen-2.7.4/src/lib.rs` confirms that
`TAURI_CONFIG` merges a build-only JSON override. A unique test identifier and
WebView data directory can isolate the app's settings/browser state without
editing the production manifest or borrowing a personal browser profile. No
Windows fixture had been implemented at that checkpoint; the completed fixture
and its native evidence are recorded below.

## Native Windows control/editor/workspace verification

Added `desktop/tests/windows/native.mjs` and a standard-library Python Win32
fixture. The harness builds the production app with a unique identity and
`appDirectoriesOverride` under its ignored validation directory. WebView2 has
fresh task-owned data and a loopback debugging endpoint; no personal browser
profile is attached. The production manifest is unchanged. After copying the
fixture binary, the harness restores the ordinary debug build without the
configuration override. The final restore-build log confirms success.

`node desktop/tests/windows/native.mjs` passed all 14 checks, with no skips, in
`desktop/src-tauri/target/windows-validation/WARP-NATIVE-515ce6ab-3676-4ca7-9506-cb310df92747/`.
Its report and both current-app/workspace screenshots were inspected. The UI fits
without clipping. Earlier attempts found two harness issues (a duplicate lexical
declaration in the CDP evaluator, and inclusion of small auxiliary windows);
these are fixed in the committed fixture. No production change was needed.

Native evidence covers Windows keyboard delivery and recording, pause retention,
failed pause reassignment preserving the file and prior key, partial action-hook
rollback preserving pause, current-app capture, conflict reassignment, selected
workspace capture, closest-match review without persistence, two-window reuse,
separate-process launch/placement, startup registration/removal, single instance,
and release of the pause key after process termination. Only owned fixture windows
are saved/restored; the helper refuses key injection into unowned windows or while
a modifier is already held. Existing startup entries cause a recorded skip rather
than replacement. This run began with no entry and removed its own entry; a
subsequent check confirmed the entry absent and no fixture app process remaining.

The fixture terminates its own process tree; this does not prove graceful tray
quit. Actual login, Firefox-specific Windows restoration, terminal variants, KDE
OS keyboard delivery and physical display changes still need their stated checks.
Next implementation: press/release and hold state, mouse-driven portrait tiling,
radial selection, pointer centering and retile timeout, then complete INI migration
and remaining platform acceptance. Keep every PARITY row in scope. No merge/push
or user-session activation has been requested.

## Windows tap/hold and activation concurrency

App-pull shortcuts now tap on release or tile once after the configured hold
delay. The pointer is captured at key-down; portrait work areas select top/bottom
and other work areas select left/right. Settings persist `holdDelayMs` (100–5000,
default 400) and `holdTileEnabled` (default true), with defaults for existing
settings. The editor locks these settings while active. KDE explicitly shows
them as unavailable until its native gesture adapter is ported.

`gesture.rs` owns timing behavior; `windows_gestures.rs` owns native key/modifier
observation and active-session cancellation. Polling runs only while an app-pull
shortcut is held. Pause invalidates sessions before unregistering action keys;
old workers cannot act on a subsequent session with the same shortcut.

The native regression found a pre-existing UI-thread deadlock during pause and
concurrent `get_status`: the UI waited for `Runtime.enabled` while registration
needed the UI thread. Blocking status, save, activation, and tray pause/quit work
now runs on background workers. Public command names/results are unchanged.
Internal synchronous activation calls were audited and updated in `main.rs` and
`app_actions.rs`; setup is the only synchronous UI-thread activation, before the
event loop starts processing callbacks. `codex/cross-platform-app` is the lowest
owning branch and the only local branch containing the application control
checkpoint `b216f0c`; no ancestor or descendant propagation is needed.

48 Windows Rust tests and 36 Node tests pass, with JS/Python syntax checks. The
initial sandbox Rust run could not access CIM; the complete suite passes with
ordinary native access. The two pre-existing opt-in terminal tests remain ignored
in this run and retain their earlier native receipts.

`node desktop/tests/windows/native.mjs` passes all 18 checks with no skips.
Receipt: `desktop/src-tauri/target/windows-validation/WARP-NATIVE-4ed7da75-26b3-488d-9fd3-40483709eb3d/`.
New checks cover modifier-first release, key-down pointer preservation, repeat
suppression, no tap after hold, pause/resume before release, and saved disabled
hold. The hold-settings screenshot was inspected and fits without clipping.
The helper refuses app-wide tests when a matching executable has an unowned
window, uses per-monitor DPI awareness, releases its own held keys, and restores
its pointer movement if the user has not subsequently moved the pointer. The
normal debug build is restored after each run.

Pre-fix receipt `WARP-NATIVE-e306ced7-61e6-4ca4-aa3e-ffa29c38ca96` passes tap/hold
but times out reading status during pause/resume, reproducing the activation
deadlock. An earlier run (`WARP-NATIVE-1e8a7166-4bc2-42db-9c1f-ad67597e099e`) found
the helper's 125% DPI coordinate mismatch; that fixture problem is also corrected.

Linux build `hoster-warp-build-20261024-hold` is inactive with exit 0: 39 Rust
tests and 36 Node tests pass, and the executable and Debian package are built.
The executable is copied to the existing task-owned Portafort path. Native KDE
regression `hoster-warp-gui-20261024-hold-shared` is inactive with exit 0 and all
15 checks passing. Report and screenshots are under
`desktop/src-tauri/target/kde-validation/hold-shared/`; the update screenshot was
inspected. Nested logs: `/tmp/window-warp-nested.pG64nW`. This run verifies shared
activation/UI changes, not KDE hold gestures. It uses KGlobalAccel action dispatch;
actual KDE OS keyboard delivery remains an explicit gap. No remote build or GUI
job remains active. The Windows fixture process and temporary Run value are absent.

Resume with the KDE press/release adapter and both radial overlays. The verified
Plasma 5.27 KGlobalAccel pressed/released signals remain the starting point;
keep actual keyboard delivery, modifier-first release, pause cancellation and
overlay rendering as explicit native acceptance criteria. Pointer centering,
retile timing, INI migration and every remaining `desktop/PARITY.md` row remain
in scope. No merge, push or user-session activation is authorized by this checkpoint.


## KDE native tap/hold and editor activation

Added `linux_gestures.rs`: KGlobalAccel signals provide native press/release,
the authenticated KWin callback supplies the original pointer, and shared
`gesture::Press` decides tap/hold. No gesture polling occurs while idle. Pause
cancels and joins the listener/worker before unloading window actions. Repeated
presses retain the original timer/pointer; a hold cannot fire a later tap.
KDE settings now support the same delay and disable switch as Windows.

The first native focus test exposed Wayland self-activation denial. `show` now
asks KWin to focus only this process's normal window, with bounded mapping
retries. The native regression and a Node control-command test cover that path.
The initial hold test also needed a separate fixture application identity:
multiple existing workspace fixtures correctly matched the same app pull.

A subsequent native run showed no press signal after pause/resume. The private
compositor's registration file confirmed that a fresh UUID action ID had lost
its key to the previous inactive ID. Native IDs now remain stable by binding
index/key; callback UUIDs remain per activation, and the listener maps only the
current native IDs. A Node regression checks stable registration with changing
callback IDs. The previously failing disabled-hold step now passes natively.

Validation: `npm test --prefix desktop` has 40 passing tests;
`npm run check --prefix desktop`, Python compilation, Rust formatting, and
`git diff --check` pass. Linux build `hoster-warp-build-20261024-kde-hold-stable`
is inactive with exit 0, 39 Rust tests and 40 Node tests, executable and Debian
package. Windows production behavior is unchanged in this increment and retains
the previous 48 Rust / 18 native checks. Incremental Windows cache contents were
removed with user authorization; the empty directory left by later checks is
removed as well. Further Rust work uses `CARGO_INCREMENTAL=0`.

Native run `hoster-warp-gui-20261024-kde-hold-stable` is inactive with exit 0 and
all 20 checks passing. Receipt on Portafort:
`~/.cache/window-warp-01a16f69/gui-kde-hold-stable/`; copied report, signal log and
inspected hold-settings screenshot:
`desktop/src-tauri/target/kde-validation/hold-native/`.
Nested logs: `/tmp/window-warp-nested.yfjyU6`. Settings and labels fit without
clipping. The earlier signal probe `hoster-warp-input-20261024-probe-final` also
exited 0, proving native autorepeat and modifier-first release.

The helper uses the fake-input protocol only in a guarded private nested
compositor, separate bus, runtime and config. Its test-only permission switch
never applies to the user's compositor or the product. All injected keys and
owned child processes are cleaned up. The test source and invocation are
recorded in `desktop/tests/kde/README.md`; the app does not depend on this helper.

Resume with explicit native regressions for pause/resume before the original
key is released and key reassignment between different binding IDs. The latter
is especially relevant because KDE retains inactive key assignments; existing
reassignment UI/direct-dispatch tests do not prove physical key ownership.
Then continue radial selection on both OSes, pointer centering/timed retiling,
INI migration and remaining platform acceptance. Physical portrait displays,
Plasma 6, final installers and independent release review remain required.
All `desktop/PARITY.md` rows stay in scope. No build or GUI unit from this
increment remains active. No merge, push or user-session activation was made.


## KDE native key reassignment

Native regression `--hold --reassign-native` reproduced an inactive app-pull
reservation blocking a new tile action on the same key. The old direct-dispatch
UI test could not detect this. `linux.rs::unload_script` now forgets the unloaded
script's own action family via KGlobalAccel `unregister(component, action)`.
Window actions, persistent pause, and command transport have separate ownership
predicates. Unknown/foreign action names are excluded; no whole-component cleanup
or user shortcut file editing occurs. This feature branch owns all affected code;
there is no ancestor implementation to patch or descendant to propagate to.

The supported two-string `unregister` contract is verified against KDE's v5.115
runtime source and current D-Bus XML. Avoid the deprecated `unRegister` variant,
which expects a four-element action-ID array. Source records are in the ignored
research quarantine: `20261025T033939Z-28363e9099` (runtime) and
`20261025T033953Z-3b4ad2b845` (current XML). The actual implementation uses only
the supported method. Native callback IDs/generation cancellation are unchanged.

Linux build `hoster-warp-build-20261024-kde-unregister` is inactive, exit 0:
41 Rust tests, 40 Node tests, release executable and Debian package. Two new Rust
checks verify cleanup ownership boundaries. Rust formatting, Python syntax and
`git diff --check` pass. No Windows production code changed.
Native `hoster-warp-gui-20261024-kde-unregister` is inactive, exit 0, all 21 checks
passing. It verifies the reassigned key performs its new action, old hold IDs are
removed on pause, and pause/control/foreign IDs survive. Report, signal trace and
screenshot: `desktop/src-tauri/target/kde-validation/reassign-native/`; remote
`~/.cache/window-warp-01a16f69/gui-kde-unregister/`. Nested logs:
`/tmp/window-warp-nested.NbMnIx`.

A separate explicit regression now reproduces the remaining held-key bug:
`nested.sh ... --gui BINARY DRIVER OUTPUT --hold --resume-held` pauses and resumes
before releasing the original chord. Autorepeat revives a cancelled gesture.
`hoster-warp-gui-20261024-kde-resume-red` failed on the prior checkpoint;
`hoster-warp-gui-20261024-kde-resume-cleanup` fails the same assertion on this
build (terminal exit 1). The regression is intentionally retained, optional and
clearly documented as failing. Ordinary pause cancellation and later resume
still pass. All jobs from this increment are terminal.

Next: fix the native held-key release lifecycle and make `--resume-held` pass
without time-based suppression. KGlobalAccel's unload signal cannot alone prove
physical key release; preserve observation of an already-held chord through
pause/resume, while ensuring unrelated paused keys are released. Then continue
both radial pickers, pointer/retile behavior, INI migration and remaining platform
checks. These requirements remain in `desktop/PARITY.md`; this checkpoint is
partial feature work. No merge, push, user-session activation or final installer
release is claimed.


## KDE held-key guard lifecycle and acknowledged script startup

The current native cancellation bug is fixed. `linux_gestures.rs` now owns a
persistent worker and per-chord KWin hooks. A cancelled held hook stays registered
only to observe release; unheld hooks and ordinary window actions are removed on
pause. Resume preserves cancellation. A config edit is reconciled after release;
if the old chord becomes a normal action or pause key, its registration is
refreshed at that boundary. Hook IDs derive from canonical shortcut bytes, while
callback tickets identify a particular loaded hook. No time-based suppression is
used. Script ownership cleanup excludes other chord hooks, pause and control.
Startup reclaims owned per-chord scripts left by a prior crash, and shutdown
joins the worker and removes its hooks.

The expanded fixture first passed cancellation but exposed a KWin 5 loader bug:
`loadScript` chooses `scripts.size()` as its ID. Removing an earlier script can
reuse an existing D-Bus endpoint; calling `run` then starts the wrong object and
leaves the new script loaded but unstarted. The implementation was verified in
KDE v5.27.11 `src/scripting/scripting.cpp` and `.h`, safe-fetch records
`20261025T040206Z-6f467128cf` and `20261025T040454Z-71622246b2`.

`linux.rs::load_script` now snapshots exported paths before loading, detects an
occupied ID and uses KWin's supported `Scripting.start` entry point in that case.
That API also reconciles configured KWin plugins; the README documents this.
Every new script sends a unique one-use readiness ticket through the existing
local endpoint. Activation waits for that acknowledgement, and failed/timed-out
loads are unloaded. The ticket grants no action/config authority and is removed
on completion or error. Normal per-object startup remains used for unused IDs.
This corrects a concrete native failure, rather than assuming a successful
`loadScript` or `run` response means the new script executed.

Validation: Linux build `hoster-warp-build-20261024-kde-ready` is inactive with
exit 0, 43 Rust / 40 Node tests, executable and Debian package. A subsequent
unit-test-only source update adds readiness-ticket and hook-isolation assertions;
`hoster-warp-tests-20261024-kde-ready` exits 0 with all 44 Linux Rust tests. Runtime
sources match the tested binary; only Rust test code changed after packaging.
`cargo test --manifest-path desktop/src-tauri/Cargo.toml --offline` with normal CIM
access and `CARGO_INCREMENTAL=0` passes 48 Windows tests, two existing opt-in
terminal tests ignored. Node tests pass 40; JS/Python syntax, Rust formatting and
whitespace checks pass. No root AHK file changed.

Native `hoster-warp-gui-20261024-kde-ready` exits 0 with all 22 checks for
`--hold --resume-held --reassign-native`. The fixture adds a second unheld app
chord to prove pause retains only the held guard. It tests a fresh press after
release, then edits a held chord and proves neither old nor new action runs
until a subsequent press. It waits for the replacement's actual KGlobalAccel key
reservation using gdbus. Report, signal log and inspected paused-editor screenshot
are under `desktop/src-tauri/target/kde-validation/held-cancellation/`; remote
`~/.cache/window-warp-01a16f69/gui-kde-ready/`. Nested logs:
`/tmp/window-warp-nested.v4ck3M`. The screenshot shows the paused editor with the
fixture's eleven bindings; no UI layout change was needed.

Earlier failures are terminal evidence: `kde-guards` reached reassignment after
passing cancellation but had a fixture index error, corrected by tracking the
original binding index. `kde-guards-combined`, `kde-guards-diagnostic` and
`kde-guards-state` exposed the unstarted-script/key-handoff issue fixed above.
All task build/test/GUI units from this increment are terminal.

Next substantial feature work: both radial selectors, pointer centering and
retile timeout, complete INI migration and remaining app-launch/platform checks.
Also add a native check for two distinct overlapping physical global chords;
current cancellation invokes the app command while holding a native chord, with
pause-key delivery verified separately. Do not generalize that to every keyboard
interaction. Plasma 6, physical display coverage, final installers and independent
release review remain pending. Keep every PARITY row in scope. No merge, push or
user-session installation/activation occurred.


## Radial picker checkpoint — KDE verified; Windows retest pending

Implemented shared radial candidates, selection/dead-zone math and a local Tauri
overlay; both native hold adapters use it. The picker remembers pre-overlay
focus and validates the selected identity before applying ordinary app-pull
behavior. KDE owns overlay position/focus on Wayland. Settings retain mouse
tiling by default and expose radial selection with explicit Save. The expanded
native fixtures cover release, Escape, center cancellation and pause/resume.

Current evidence: 43 Node tests; 46 Linux Rust tests in the radial builds;
50 Windows Rust tests before the final focus correction. Native KDE radial and
layout runs each pass 26 checks; final focus-order build/run also passes 46 Rust, 43 Node and 26 native checks.
Screenshots and receipts are under `desktop/src-tauri/target/kde-validation/radial/`.
The first 8-slot screenshot had overlap, corrected with compact slots and
centered instructions; no final Windows native success is claimed.

Windows native selection failed to activate the selected window after hiding
the picker. The code now activates before hiding. The exact reproduction report
is `desktop/src-tauri/target/windows-validation/WARP-NATIVE-5d25ec84-29f8-46cd-abe9-3697850c580d/result.json`.
This used the already-built fixture from `WARP-NATIVE-84a75699-a9e2-4700-9e6b-1bb6ff931f68`
after fresh compilation became impossible from system commit pressure. The
no-rebuild runner is a local diagnostic artifact, not a replacement test path.
The committed Windows fixture is the authoritative retest:
`node desktop/tests/windows/native.mjs`.

Windows rebuilds (including the normal debug build restoration) failed from low
available commit, even with incremental caching off, one compiler job and
final-crate debug symbols disabled. Stop repeating local builds until sufficient
memory is available; then run the complete Windows fixture and verify the normal
build is restored. It also tests a verified click confined to the fixture's own
title bar if Windows refuses foreground focus. No unrelated processes/settings
were changed. Both webviews require identical debug arguments in the fixture.

No merge, push, installation or user-session activation. Main and root AHK remain
unchanged. Resume with the Windows radial correction verification, then all
remaining rows in `desktop/PARITY.md`; do not narrow the full-port goal. Known
remaining requirements include pointer/retile, INI migration, launch variants,
physical/Plasma 6 acceptance and final review/installer checks.

Final exact-source Linux receipt: `hoster-warp-build-20261024-radial-focus` exits 0
with 46 Rust tests, 43 Node tests, executable and Debian package.
`hoster-warp-gui-20261024-radial-focus` exits 0 with all 26 native checks, using
`--hold --resume-held --reassign-native --radial`. Nested session logs:
`/tmp/window-warp-nested.27oNxI` on Portafort. The final screenshot was inspected:
all eight slots and both centered instructions are separate and readable. The
local final report/screenshot is under `desktop/src-tauri/target/kde-validation/radial/`.
This validates the current Linux focus-before-hide behavior as well as the final
layout; Windows correction verification remains pending for the reason above.


## Windows radial retest complete

Memory recovered; the authoritative full fixture passed all 22 checks with no
skips on current implementation `61233ff2e8e10eb7c5df8e8906aaf45e982817d8`.
Receipt: `desktop/src-tauri/target/windows-validation/WARP-NATIVE-42666202-5045-4fed-9580-d4fe8bcd9dcf/result.json`.
Selection, dead-zone cancellation, native Escape and pause/resume are verified.
The picker screenshot was inspected. The normal debug build restored successfully
in the same run, superseding the prior memory blocker. Current Windows Rust:
50 pass, two opt-in terminal tests ignored. No runtime edits were needed.

Resume with reviewed INI migration, then the remaining PARITY requirements.
Branch remains `codex/cross-platform-app`; no merge, push or installation.


## Reviewed INI migration checkpoint

Added pure INI decoding/conversion and a native file/review UI. The original
files remain untouched; imported shortcuts append to unsaved edits and settings
merge only specified fields. Each workspace opens separately for explicit Save.
Disabled hotkeys, app behavior, terminal fields/known shell titles, Firefox tabs
and geometry survive conversion. Unsupported entries retain their raw fields.
Windows IDs remain disabled on Linux pending adaptation; workspace platform, app
matching, geometry/reference work areas and terminal kind are editable.

Validation: 53 Node tests, 50 Windows Rust tests (two opt-in terminal tests
ignored), JS/Python syntax, Rust formatting and whitespace checks pass. Linux
build `hoster-warp-build-20261024-import` is inactive/exit 0: 46 Rust, 52 Node,
executable and Debian package. Native `hoster-warp-gui-20261024-import` is
inactive/exit 0 with 17 checks. Inspected screenshot/report are under
`desktop/src-tauri/target/kde-validation/import/`; nested logs
`/tmp/window-warp-nested.Q6JAxp`. Windows `--skip-escape` diagnostic passes 23
checks with one explicit skip in `WARP-NATIVE-0f28c784-4d06-4f64-b58e-ee75d3bfab14`.
It verifies file selection, review, shortcut/settings save and terminal/Firefox
workspace save; screenshots inspected and normal debug build restored.

Three focused refinements after native runs have Node coverage: known terminal
title inference, suppressing the packaged warning for wt.exe restoration, and
keeping saved WSL fields reachable while changing terminal kind. Rebuild native
binaries for those source refinements; do not imply installed artifact equality.

**Blocking completion issue:** rapid native Escape is intermittent on Windows.
It failed repeatedly despite the earlier passing 22-check run. The default
fixture now repeats immediate Escape five times. Latest failure:
`desktop/src-tauri/target/windows-validation/WARP-NATIVE-3c6bd49d-01ac-4a29-9a99-359cadb4f35f/result.json`.
A temporary low-level Escape hook experiment (PeekMessage/GetMessage loops,
explicit module handle, no key consumption) did not reliably observe injected
events and was removed completely. Current production remains the previously
committed radial adapter. Do not repeat that unproven change or lengthen the
fixture's key press to mask the bug. AutoHotkey processes were present but not
changed; their causal role is unproven. The owning branch is this feature branch,
where radial behavior first appeared; main has no affected implementation.

Exact resume: diagnose/fix Windows rapid Escape and pass the full native fixture
without `--skip-escape`; then pointer centering/timed retile and the remaining
PARITY requirements. Migration still reports center actions/unsupported matches
and packaged launch as unresolved. No merge, push or user-session installation.
All Hoster task build/GUI units are terminal. Memory is no longer a blocker.

Fixture text line endings were normalized after the migration commit; conversion
behavior is unchanged. The focused importer tests and staged whitespace check
pass on the normalized fixtures.

Recoverable implementation checkpoint: `9ccbaa77dd0fe475e995ae382a7b18abaecb54d8`
on `codex/cross-platform-app`, including migration commit `4a92065`. A following
dossier-only commit records this SHA. Resume at the Windows rapid Escape issue
above; the full feature-port goal remains active and incomplete.

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
