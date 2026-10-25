# Cross-platform application integration dossier

- Status: feature, incomplete
- Owner: current Codex chat, user-requested full feature port
- Branch / owning ref: `codex/cross-platform-app`
- Worktree: existing `hotkeyable_windows` checkout
- Base commit: `7b907778f0022d73fb3527b82c0ab7ecedf8124d`
- Intended eventual target: `main`; promotion/merge has not been requested
- Last updated: 2026-10-25
- Latest immutable recovery checkpoint: `9ab716dd78ff2b719113155f541c57ebf67ca21c`
- Feature implementation commits: `abfc95e` (desktop/workspace foundation), `ee7bee4` (Firefox profiles/tabs), `c09d79c` (terminal capture/editor/restore), `491a9d8` (KDE Firefox caption correction and complete 15-check native run), `5e6373d` (WSL distribution discovery and native directory restoration), `02d4e02` (reviewed shortcut reassignment and 12-check native KDE run), `b216f0c` (persistent pause and application control hotkeys, 15 native KDE checks), `d49e380` (14 native Windows application checks), `9794b75` (Windows tap/hold, activation deadlock correction, 18 Windows and 15 KDE native checks), `b63cb1d` (KDE native tap/hold, Wayland editor focus, 20 native KDE checks), `41fbc70` (KDE key reservation cleanup, 21 native KDE checks, held-key regression reproduced), `da23019` (held-key cancellation and deferred reassignment, verified script startup, 22 native KDE checks), `61233ff` (shared radial picker, 26 native KDE checks; initial 22 native Windows pass later superseded by rapid Escape regression), `4a92065` (reviewed INI migration and native import receipts), `9ccbaa7` (portable fixture line endings)
- Canonical references: original root AHK files; `desktop/PARITY.md`

## Intent and implemented contract

Port all original features into a standalone Windows/KDE application. The user's
explicit branch requirement is satisfied by this existing feature branch.
Original AHK sources remain unchanged. Full parity is not achieved: the checklist
is the completion gate, including unresolved default-profile matching, terminal
variants, remaining native edge cases, real Plasma6, physical display/login and
final packaging acceptance. Later sections supersede historical receipts below.

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
  explicit-profile Firefox UI is now verified as documented in the latest section.
  Default-profile identity and actual Plasma6 remain open. The current isolated
  Portafort binary is the Firefox polling build documented below.
- Hoster cleanup sidecar inspected two unregistered live scopes, retained both,
  stopped none (`needs-attention`). No action on unrelated workloads is needed.

## Resume and gates

Resume remaining terminal variants, burner/chord cases and unresolved default-
profile matching, then final package/Plasma6/physical-display/login gates. Preserve
all checklist rows and any newly recorded native regression.
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

Recoverable focus-loss implementation checkpoint: `df6b28b772f91d4ea323f76550c269a0d1fd201f`
on `codex/cross-platform-app`. This dossier-only follow-up records its exact SHA.


## Pointer-centering implementation — native Linux checks verified

Added explicit push-left-center/push-right-center actions to the editor, validators
and original shared-hotkey INI conversion. Ordinary push preserves pointer location;
centered push uses the destination work area; history pull centers the primary;
app pull centers main when bringing/focusing an inactive app there. Hold tiling,
burner moves and focus-last retain their original pointer behavior.

Windows uses SetCursorPos. KDE Wayland uses the declared fake-input capability
through generated Rust protocol bindings, a fresh connection per operation and
a two-second response deadline. X11 uses WarpPointer. The Debian/RPM desktop entry
includes an absolute installed path and X-KDE-Wayland-Interfaces. The built Debian
entry was inspected and resolves to /usr/bin/window-warp. No permission bypass is
introduced in the application. Missing/refused access reaches the existing error UI.

Current local checks: 55 Node tests, 50 Windows Rust tests (two existing terminal
opt-ins ignored), formatting and syntax checks pass. Full Windows native receipt
`desktop/src-tauri/target/windows-validation/WARP-NATIVE-91dccd23-8637-4a00-9166-3053af6527b8/`
passes 25 checks. Its new centered push/history test explicitly skips because this
Windows session exposes only one monitor. App-pull centering is verified. Normal
debug build restoration passes. Do not count multi-monitor Windows pointer behavior
as verified; rerun the same fixture when another display is connected.

`hoster-warp-build-20261025-pointer` built successfully with 46 Rust and 55 Node
tests, executable and Debian package. Additional timeout coverage passes in
`hoster-warp-tests-20261025-pointer`: 47 Rust tests, one X11 native opt-in ignored.
Portafort's configured 192.168.0.146 address became unreachable from Hoster before
new tests could be synced. No matching named Tailscale peer was found. A question
is pending with the user; there is no active Portafort pointer-test unit.

A disposable Hoster KDE image now permits testing without the host seat or bus.
The first run could not execute KWin's capability-marked binary under Docker's
normal bounding set; the test image removes that unneeded resource capability
for its virtual backend. No host capability or service setting changed. The next
run reached native workspace restore and exposed an incomplete test desktop:
without a working window decoration, KWin retained maximize state instead of
entering fullscreen. Adding the standard Breeze decoration resolves this native
fixture prerequisite. Linux restoration now also confirms requested minimized/
maximize/fullscreen state rather than reporting success when the compositor
refuses it. The original assertion is preserved, with richer failure diagnostics
and an unambiguous owned window. This supersedes the initial race diagnosis.

Build/47-test verification completed in `hoster-warp-pointer-20261025-statecheck`.
Its Xvfb wrapper stalled as container PID 1 before executing the test. Inspection
confirmed the X socket was ready and the wrapper was in sigsuspend; only that
owned container/unit was stopped. Docker --init fixes the handshake. The native
X11 opt-in then passed in `hoster-warp-native-20261025-pointer`.

The earlier `hoster-warp-gui-20261025-pointer-keys` and `pointer-focus` runs are
terminal failures: rewriting a desktop declaration and rebuilding sycoca did not
revoke pointer access in that already-running compositor. The fixture now uses
separate fresh compositor sessions for authorization and refusal; it does not
weaken permissions or assume runtime capability revocation.

`hoster-warp-gui-20261025-pointer-accepted` is inactive/exit 0, with 31 native
checks using `--hold --pointer --resume-held --reassign-native --radial --import`.
`hoster-warp-gui-20261025-pointer-denied` is inactive/exit 0, with 21 native
checks using `--hold --pointer-denied`. The latter starts with no app capability
declaration and verifies that the app still focuses its target, the pointer stays
unchanged, and the editor reports missing access. Authorized app pulls, both
centered pushes and history pulls verify actual compositor cursor coordinates.
The pointer probe is restricted to the owned nested runtime. No test remains active.

Reports, logs and screenshots were retrieved to
`desktop/src-tauri/target/kde-validation/pointer-accepted/` and `pointer-denied/`.
Radial and import screenshots were inspected. The accepted remote output is
`~/.cache/window-warp-01a16f69/src-tauri/target/kde-container-pointer-accepted/`;
the denied output uses `kde-container-pointer-denied/`. Node tests (55), JavaScript
syntax, Rust formatting and Python syntax pass on the final source. Windows has
12.7 GiB available of 31.6 GiB at this checkpoint, so memory does not block builds.

Next: implement the one-second X/C retile lifecycle, then every other incomplete
PARITY requirement. Windows two-display pointer acceptance and real Plasma 6
remain required; the container checks establish Plasma 5.27 behavior only.
No merge, push, installation or activation. Original AHK remains unchanged.

Recoverable pointer implementation checkpoint: `9f1ab8e09fc59410daa3bcf0de21bed6e2d83b64`
on `codex/cross-platform-app`. This dossier-only follow-up records its immutable SHA.
Resume with timed X/C retiling; all native pointer test units are terminal.

## Timed X/C retiling — implementation and native acceptance

Ported the one-second post-push retile contract from `RememberLastPushAction`,
`HandleRetileHotkey` and `EnableRetileHotkeys`. Exact X/C and Super+X/C select
left/right on the last pushed window's current output, even after focus changes.
Identity is checked by window ID and PID. One use, expiry or pause clears the
selection; a later push replaces the target and refreshes the deadline. Pause
keys retain precedence. Existing shortcuts resume normally after consumption.
There is no idle key polling or permanently reserved plain typing key.

The shared worker owns timing and cancellation. KDE installs a temporary KWin
script for unused keys, cleans its KGlobalAccel reservations, and routes existing
Super+X/C bindings through the pending selection before their normal action.
App-pull gesture bindings also consult retile before starting a hold. The
authenticated bridge passes target identity and original push time so script
startup does not extend the deadline. Startup cleanup reclaims the temporary script.

Windows rejected RegisterHotKey for Super+X and Super+C with error 1409. Its
temporary native keyboard hook handles only these four exact chords while a
retile is pending. A consumed Windows-key chord masks standalone Start-menu
activation; other modifiers pass through. The hook has its own message thread,
is removed on use/expiry/pause, and retains no keyboard history. Process exit
cancels selection without waiting on a worker that may need the UI message loop;
normal pause and tray quit wait for key cleanup.

Source inspection also corrected an earlier parity gap: AHK's
`GetAdjacentMonitor` wraps a single monitor to itself. Both new backends now
preserve that behavior, including history, centering and timed retiling. The
old one-monitor early return/error was removed; the Node regression now checks
unchanged placement plus retile arming rather than treating the push as a no-op.

Validation:
- 57 Node tests, JavaScript syntax, Rust formatting and Python syntax pass.
- Windows Rust: 51 pass, three opt-in native tests ignored in the ordinary run.
  `WARP_TEST_RETILE=1 cargo test --manifest-path desktop/src-tauri/Cargo.toml native_windows_retile_capture_and_release -- --ignored`
  separately passes. It uses an owned edit window, checks all four physical
  chords, prevents reserved Windows menus, removes the hook and verifies typing.
- Full native Windows receipt
  `desktop/src-tauri/target/windows-validation/WARP-NATIVE-0faae945-a181-464b-a6ce-f4fe58958af9/`
  passes 30 checks. Push-to-retile covers changed focus, all chords, one use,
  expiry, consecutive-push renewal, pause/resume and single-monitor wrap/centering.
  Physical multi-monitor geometry is the only explicit skip. The normal debug
  build restored successfully. Earlier 25-check regression receipt `994030f5`
  predates the one-monitor wrap correction; use the full UUID receipt above.
- Linux final build `hoster-warp-build-20261025-retile-wrap` is inactive/exit 0,
  with 48 Rust tests (one X11 opt-in ignored), executable and Debian package.
- Native KDE `hoster-warp-gui-20261025-retile-final` is inactive/exit 0 with 38
  checks using `--hold --pointer --retile --resume-held --reassign-native --radial --import`.
  It adds real Super+X/C, modified-key exclusion, existing-key fallback and pause
  precedence to focus/expiry/renewal/cleanup checks. Reports/logs/screenshots are
  saved locally in `desktop/src-tauri/target/kde-validation/retile/` and remotely
  in `~/.cache/window-warp-01a16f69/src-tauri/target/kde-container-retile-final/`.
  All build and native test units are terminal. Portafort remains untested for
  this increment; KDE runs used the private Hoster container, not the host seat.

Full parity remains incomplete. Next implement/verify packaged Windows and Linux
desktop-entry launch and finish unsupported legacy match migration, then the
remaining platform cases in `desktop/PARITY.md`. Physical displays, live Plasma 6,
Windows Firefox, terminal variants, login launches, tray/installer acceptance and
independent final release review remain required. No merge, push, installation
or user-session activation; original AHK files are unchanged.

### Retile increment review and delayed-reply regression

Independent native reviewer `/root/retile_review` inspected the increment and
native receipts and independently reran 57 Node tests. It found one P2: consumed
KDE typing keys were cleared only after window I/O, so a delayed control reply
could retain X/C reservations until the five-second timeout. This is an increment
review, not final release approval. The parent owns implementation and native tests.

The proposed correction clears native capture before window I/O and then checks
the generation, preserving a newer push's target. The new private KDE fault
fixture keeps the control action registered but withholds its reply; it checks
key reservation release and actual ordinary C input in the owned Qt window while
the request is pending. Its original control script is restored in `finally`.
The standalone KWin regression fixture now records ArmRetile notifications and
passes in `hoster-warp-live-20261025-retile` (inactive/exit 0).

The pre-fix binary reproduces the finding in
`hoster-warp-gui-20261025-retile-delay-before` (failed/exit 1): X remains reserved
as `[88]` after the three-second cleanup deadline while window I/O waits. The
pre-fix checkpoint preserves that implementation and the reproducer so the red
receipt is recoverable from branch history; it is superseded by the verified
cleanup-order correction below. The reviewer
rechecked the correction and test and reported no further findings.

Pre-fix recovery commit: `316ad5d0ddb544bdaa6679801c3521f81b942dd1` on
`codex/cross-platform-app`. The corrective commit below clears capture before window I/O.

Corrected Windows native run
`WARP-NATIVE-6c823d34-8ae8-4c2b-b715-295a376939a3` passes all 30 checks with the same
physical second-display skip, and the ordinary debug build restored successfully.
The corrected Linux build `hoster-warp-build-20261025-retile-cleanup` is inactive/
exit 0, with 48 Rust tests and the executable/Debian package rebuilt. Native
`hoster-warp-gui-20261025-retile-cleanup` is inactive/exit 0 with all 39 checks,
including ordinary C typing while the retile window request awaits its timeout.
The earlier failure is therefore reproduced and corrected against the same
fixture, with the earlier source reachable at `316ad5d0ddb544bdaa6679801c3521f81b942dd1`.
Final artifacts: `desktop/src-tauri/target/kde-validation/retile-cleanup/`;
pre-fix journal: `desktop/src-tauri/target/kde-validation/retile-delay-before/journal.log`.
The independent reviewer reported no further findings on the correction/test.
All retile build/test units are terminal. The release-wide independent review is
still outstanding; this review covered only this increment. Next: packaged app/
desktop-entry launch and unsupported legacy match migration, then all PARITY gaps.


Verified retile recovery checkpoint: `85cdb941e49edbec30d96109f461419ec51400fd`
on `codex/cross-platform-app`, following implementation/reproducer commit
`316ad5d0ddb544bdaa6679801c3521f81b942dd1`. The dossier-only follow-up records the
immutable SHA. The working tree is ready to continue with launch/migration work;
no native test is left running and no user-session runtime was activated.


## Packaged application and desktop-entry launch (2026-10-25)

Implementation and passing test fixtures are recoverable at
`4827d302eebad18ebdecbc3acb21f6db3630095d` on `codex/cross-platform-app`.
The following dossier-only checkpoint updates this pointer without changing the
verified source. Resume at legacy packaged-app target resolution and unsupported
AHK match migration, then continue remaining native acceptance in `desktop/PARITY.md`.
All build/native-test processes for this increment have exited; the ordinary
Windows debug build was restored. Portafort remains unreachable on its recorded
address; do not substitute another Tailscale peer without verified identity.

Launch settings now distinguish executable, Linux desktop entry, and Windows
packaged application targets. Existing JSON defaults to executable. Windows
capture records actual package AUMIDs, including unambiguous hosted child-process
identity, and uses COM activation without guessing a manifest's `!App` suffix.
Desktop entries use GIO for entry lookup, argument field codes, working directory
and activation. A missing entry/failed activation becomes an individual restore
error. Saved desktop/package identity prevents a shared executable host from
matching a different application. Browser-tab and terminal-session enrichment
retain executable launches and their specialized argument handling.

The editor exposes launch type and the corresponding target/argument labels.
Non-executable launches reject an explicit working directory instead of silently
ignoring it. New-window restoration still requires a new window to appear; apps
that reuse an existing window can refuse this behavior. INI package migration
preserves its source executable path and requests an AUMID or recapture; automatic
resolution of old versioned WindowsApps paths remains pending.

Verification:

- 59 Node tests and JavaScript syntax checks pass.
- Windows Rust suite: 56 pass, 3 opt-in tests ignored; Windows activation argument
  quoting round-trips through the native parser (spaces, empty values, quotes,
  trailing backslashes and Unicode).
- Linux Rust suite: 51 pass, 1 X11 opt-in test ignored. Release executable and
  Debian bundle built successfully in `hoster-warp-build-20261025-launch-types`
  (inactive, exit 0).
- Windows native application suite: 32 checks pass, one physical second-display
  skip. Includes nonexistent-package error, real Calculator activation, captured
  AUMID, placement, reuse, and checked cleanup of only the new fixture window.
  Receipt: `desktop/src-tauri/target/windows-validation/WARP-NATIVE-69494d6e-177e-4bda-969f-f65f1c45e208/result.json`.
  Command: `node desktop/tests/windows/native.mjs`. Ordinary debug build restored.
- KDE native suite: 20 checks pass in a private two-output Plasma 5.27 compositor.
  Captured desktop entry launches an owned Qt window with a remote URL and local
  file URI, respects entry Path with spaces, restores geometry, reuses its window,
  and reports a nonexistent entry. GIO resolves the local file URI to a native
  path; the fixture asserts the observed argument boundaries. Unit
  `hoster-warp-gui-20261025-desktop-launch` finished inactive/exit 0; command flags
  `--desktop-entry --import`. Local report/screenshots:
  `desktop/src-tauri/target/kde-validation/desktop-launch/`. Remote report directory:
  `~/.cache/window-warp-01a16f69/src-tauri/target/kde-container-desktop-launch/`.
- The earlier `launch-types-files` KDE run reached and passed desktop-entry checks
  but then lacked optional `konsole`; no new native Konsole acceptance is claimed.
  Browser/terminal command-model tests pass; fresh native variants remain in the
  checklist. Initial Calculator fixture requested height 600, below its observed
  DPI-scaled minimum 674. Final test uses available work-area dimensions. Acceptance
  for saved geometry below app minimum sizes remains open.
- Independent scoped review: `/root/retile_review` reviewed shared/Linux/UI/model
  changes; `/root/packaged_native` reviewed Windows identity/COM implementation.
  Both found no actionable issues. They did not independently accept their own
  implementations. This does not replace the final release-wide review.

Remaining coverage: hosted UWP and packaged Win32 variants, packaged argument
receipt in an owned packaged fixture, D-Bus-activated desktop entries, real Plasma
6/Portafort, legacy package-target resolution, and the rest of this checklist.
No merge, push, installer activation, or user-session startup change was performed.


## Legacy package migration (2026-10-25)

Verified implementation checkpoint: `7727de3a2472b358d970f6af1c49e4d3be2fd538`
on `codex/cross-platform-app`. The subsequent dossier-only commit records this
pointer. Resume with the AHK window-match fidelity work below; all tests/builds
for this increment are terminal and the checkout is clean after checkpointing.
Final independent review inspected the corrected fixture and passing 33-check
Windows receipt and found no remaining actionable issues in this increment.

Import review now resolves a saved WindowsApps package full name to its family,
queries current-user registered versions, and selects one distinct actual AUMID.
The old executable/version need not exist. Missing/ambiguous registrations and
API failures remain per-item review notes with the original path intact; explicit
launch targets are preserved. The native preparation command validates the draft
and never writes it. Linux preserves Windows imports for platform adaptation.

Evidence: 60 Node tests/syntax checks; Windows Rust 59 pass/4 opt-in ignored;
Linux Rust 52 pass/1 ignored. The opt-in read-only stale Calculator registration
query also passed. Windows native suite passed 33 checks, with the existing
physical second-display skip. Receipt:
`desktop/src-tauri/target/windows-validation/WARP-NATIVE-0b034f91-827f-4470-87fc-eb737437d386/result.json`.
The editor resolved a stale Calculator version, did not auto-save, then persisted
its AUMID and original path on explicit Save. The initial fixture wrongly assumed
the current owner path was WindowsApps; its observed ApplicationFrameHost path
confirmed hosted Calculator capture/reuse and prompted an explicit historical
package-path fixture. No runtime correction was needed.

Linux builder `hoster-warp-build-20261025-legacy-package` finished inactive/exit 0
with release executable and Debian package. KDE unit
`hoster-warp-gui-20261025-legacy-package` passed 20 checks, including Windows import
review through the new preparation command; flags `--desktop-entry --import`.
Local receipt directory: `desktop/src-tauri/target/kde-validation/legacy-package/`.
All test processes have exited and the normal Windows debug binary is restored.
No installation, user-session activation, merge or push occurred.

Independent reviewer `/root/packaged_native` found no runtime defect in native
registration buffers/lifetimes, RAII cleanup, ambiguity handling or unsaved review.
It independently passed 21 import/editor tests and identified the same hosted
Calculator fixture assumption, corrected before the final native run.

### Next: AHK window-match fidelity

Source audit: all six original AHK files omit SetTitleMatchMode, DetectHiddenWindows
and GroupAdd. `window_manager.ahk` FindConfiguredWindows and the hotkey module pass
saved matches directly to WinGetList/WinActive. Current INI fixtures use basename
ahk_exe matches, but the importer also accepts full paths; Windows pull/focus and
shared radial currently compare only basename, so full-path imports cannot work.
This is a concrete remaining port defect, not just missing test coverage.

Official v2 documentation confirms default case-sensitive title **contains**
matching (mode 2), exact case-sensitive class, case-insensitive executable basename
or full path, and conjunction of specified criteria. Plain `A` means the active
window; PID/HWND criteria are session-specific. Keyword parsing allows no space
after a keyword and consumes only one separator space/tab before the next criterion,
so broad whitespace trimming changes literals. The original repository defines no
portable groups; ahk_group cannot recover missing group definitions.

Next implementation should retain existing native app IDs for old JSON and add
an explicit optional Windows selector for title/class/executable/PID/HWND/active.
Apply one coherent predicate to native pull, focus and radial selection, and keep
Windows selectors disabled on Linux until adapted. Cover same-name executables in
different paths, title/class conjunction and case, no-space syntax, PID/HWND
mismatch, active-only, visible untitled/owned windows, and picker/action consistency.
Do not add title modes absent from the original configuration.

Primary sources: https://www.autohotkey.com/docs/v2/misc/WinTitle.htm and
https://www.autohotkey.com/docs/v2/lib/SetTitleMatchMode.htm. Safe-fetch receipts
under `desktop/src-tauri/target/research/ahk-wintitle-result.json` and
`ahk-titlematch-result.json`; fetched content treated solely as source evidence.
The full-parity goal remains active; the original checklist remains the gate.


## Windows window-match parity (2026-10-25)

Verified implementation checkpoint: `48adbe37aa24ea483b602605e530564b91d47184`
on `codex/cross-platform-app`. The following dossier-only commit records this
immutable pointer. Resume at remaining native Windows maximize/close,
focus-last/minimized and burner behavior. No native or remote build workload is
still active; test outputs and normal Windows debug binary are retained locally.

Added optional typed Windows criteria to bindings: title contains, exact class,
executable basename/full path, packaged app ID, PID, HWND and active-only. Criteria
are conjoined. Title/class preserve case and meaningful whitespace; executable
and package identity compare case-insensitively. HWND uses a decimal string to
avoid JavaScript integer precision loss. Old JSON appMatch bindings remain valid;
full executable paths and packaged IDs now work in native focus/pull as well as
the radial picker. One Rust predicate owns Windows action and picker matching.

AHK imports retain typed criteria, including simple executable rules so original
WinGetList eligibility survives migration. Original FindConfiguredWindows calls
WinGetList/WinExist without workspace filtering; explicit selectors therefore
include visible owned/untitled/tool/own-process/cloaked windows. Ordinary workspace
capture and existing native-ID bindings retain their normal-window filters.
Current HWND/PID is rechecked before action; active-only radial release uses the
pre-picker active identity. Unsupported/duplicate criteria and undefined groups
retain their original import text for review. Linux saves these imports disabled
and refuses to enable or dispatch Windows criteria until the user adapts them.

The editor exposes searchable, editable criteria and preserves existing draft
and pause rules. Switching to a non-app action ignores dormant hidden criteria.
Edit-current-app reuses an equivalent imported executable-only selector without
reusing a narrower rule. Enabling advanced matching on an AUMID preserves it as
a packaged-ID criterion rather than misinterpreting it as an executable.

Verification:

- 71 Node tests and JavaScript syntax checks pass.
- Final Windows Rust suite: 64 pass, 5 opt-in ignored. Separate
  `WARP_TEST_WINDOWS_MATCH=1 cargo test --manifest-path desktop/src-tauri/Cargo.toml --offline native_window_selectors_capture_class_and_widen_explicit_scope -- --ignored`
  passes owned native class/title/path/PID/HWND selection, active identity,
  visible untitled/owned tool inclusion and hidden-window exclusion. It also
  asserts that explicit matching can select its own process's visible fixture.
- Final Windows application suite: 36 checks pass, one physical second-display
  skip. Imported title/class/path/PID conjunction selects the same owned window
  by tap and radial; wrong title case refuses focus; a full-path native ID works.
  Receipt/screenshots:
  `desktop/src-tauri/target/windows-validation/WARP-NATIVE-a7ac84e6-bbd1-44cb-9c97-29ef4564dfcc/`.
  The earlier one-candidate run exposed a fixture helper hardcoded to two radial
  entries; parameterizing that helper fixed the test without changing runtime.
- Linux builder `hoster-warp-build-20261025-window-matching-review` completed
  inactive/exit 0: 57 Rust pass/1 ignored, 71 Node pass, release executable and
  Debian bundle. The final Windows-only eligibility correction does not affect
  the Linux compilation path.
- Native KDE: 30 checks pass, including Windows compound-rule review/save,
  refusal to enable that rule on KDE, unchanged native hold/radial behavior,
  desktop-entry launch and workspace import. Unit
  `hoster-warp-gui-20261025-window-matching` inactive/exit 0; flags
  `--desktop-entry --import --hold --radial`. Local receipts:
  `desktop/src-tauri/target/kde-validation/window-matching/`.
- Independent review: `/root/packaged_native` identified current-app reuse,
  dormant-field validation and packaged-ID prefill issues; all corrected with
  focused regressions and reviewed again with no remaining actionable findings.
  `/root/retile_review` reviewed shared matching/Linux guards and final native
  eligibility correction. Windows screenshot shows readable criteria without
  clipping. The normal Windows debug binary is restored; test workloads exited.

Next: remaining native Windows maximize/close, focus-last/minimized and burner
behavior, then Firefox/terminal variants and overlapping physical global chords.
Retain the full checklist, real Plasma 6/physical display/login/installer gates,
and independent final release review. No merge, push or installation occurred.

## Windows action acceptance — 2026-10-25

Verified checkpoint: `5f0a9aca470cbaf785a52fd359e7f830f645c6d3` on
`codex/cross-platform-app`. This following dossier-only commit records its pointer.
Resume at the compound maximize restore gap below; no test workload remains active.

The owned Win32 helper now preserves maximized windows during shortcut delivery.
Normal-window activation retains its existing behavior. The helper can minimize
its own targets and create a disposable window that counts WM_CLOSE requests,
vetoes the first request, then accepts the second without terminating siblings.

The application fixture now verifies simple maximize/restore floating geometry,
maximized push and history pull, focus-last toggling, minimized pull/focus recovery,
all four single-monitor burner fallbacks, and graceful close. Push completion is
observed through its pointer-centering transition before re-reading maximization;
the no-op burner checks first prove that binding can pull the target, allow the
second tap to settle, and reject error events. No production code changed.

Final exact-source command: `node desktop/tests/windows/native.mjs`, 42 pass,
one physical second-display skip. Receipt:
`desktop/src-tauri/target/windows-validation/WARP-NATIVE-8c15db1d-5a19-48c9-a944-ed3edb336cb6/result.json`.
JavaScript and Python syntax checks and `git diff --check` pass. The first run
`c344db4e-cbb9-462a-8d8e-d507f9669ab9` timed out at the existing editor shortcut
before new assertions. Retaining normal-window ShowWindow activation while
skipping restoration for maximized targets produced subsequent complete passing
runs. Final cleanup exited the fixture processes and restored the normal debug
binary. Shared/Linux source is unchanged; no redundant Linux build was run.

Independent review: `/root/packaged_native` identified initially weak asynchronous
push/no-op assertions, reviewed the corrections, and returned no remaining test
or safety finding. Parent implemented the tests and reconciled this dossier and
the canonical `desktop/PARITY.md`. The child is terminal and can be resumed by
that task path; evidence and review are summarized here.

Next concrete port gap: `fullscreen.ahk` lines 26–47 stores a floating rectangle
independently of subsequent maximized moves. Windows currently uses SW_RESTORE
and KDE slotWindowMaximize, so the simple toggle receipt does not prove compound
restore parity. Add a regression for toggle-maximize → push/move → toggle-restore
and implement the saved-rectangle contract on both backends. Also verify KDE
push/history restores maximization after an intervening tile: `warp.js` history
currently stores geometry/output but no explicit maximization state. Continue
with remaining burner, Firefox/terminal, overlapping-chord, real Plasma 6,
physical-display, login and installer gates. Full parity remains incomplete.
No merge, push, installation or user-session activation occurred.

## Compound maximize restoration — verified (2026-10-25)

Verified implementation checkpoint: `db8a32f85086136750f6cfd38e737c76cafc03fc`
on `codex/cross-platform-app`. The following dossier-only commit records this
immutable pointer. Native/build/test jobs are terminal; resume at the state
retention and persistent KDE dispatch work described at the end of this section.

This defect belongs to `codex/cross-platform-app`: `git ls-tree main desktop`
is empty, so the unchanged AHK-only main branch has no native backend to repair.
The previous turn made verified progress (42 native Windows checks and checkpoint
`5f0a9ac`); this increment fixes the compound restore gap identified there.

Windows now saves the pre-maximize rectangle independently of OS placement.
A process-scoped window property marks the HWND lifetime, paired with PID,
so a recycled HWND cannot inherit stale geometry; the literal sentinel owns no
allocated payload. Closed entries are pruned on toggle, and graceful shutdown
removes surviving markers. Marker refusal returns the native error, including
Windows integrity restrictions, instead of silently weakening identity checks.
The cache survives shortcut pause. The native regression first reproduced a
1920x1080 restore instead of 500x320 on the old implementation, then passed with
explicit saved geometry. Final Windows source receipt: 43 checks pass / one
physical second-display skip, in
`desktop/src-tauri/target/windows-validation/WARP-NATIVE-0df0e17c-cf6a-44f6-b8fd-b26bd13fedc2/`.
Windows Rust: 64 pass / 5 opt-in ignored, including cached-rectangle and missing
window-lifetime-marker regression, `target/maximize-windows-rust.log`.

KDE now has explicit saved rectangle/output and history maximize axes,
bounded compositor state/geometry acknowledgment, queued same-script geometry
actions, delayed control replies with actual error propagation, and diagnostics
without titles or identities. Numeric Plasma 5 flags are normalized (horizontal
2 / vertical 1 observed natively). A 1.8-second budget begins at enqueue; stale
requests expire before mutation, late replies are ignored, and the timer stops
while idle. Known restore-size hints followed by post-acknowledgment placement
resolved the native Qt same-size unmaximize stall and preserve the existing
Firefox resize-race protection. Retile time now starts after push acknowledgment.

KDE native receipts live in `desktop/src-tauri/target/kde-validation/maximize/`.
The `hint` run passed 32 checks in the isolated two-output Plasma 5.27 Wayland
compositor. The subsequent `direct` run exposed a history-pull stall when
pulling a maximized window without first tiling it; `direct-result.json` and
`direct-kwin.log` retain that evidence. Fully maximized/nonfullscreen history
now preserves maximization and changes output directly, avoiding the redundant
floating transition. Other states retain the staged geometry path.

Final verification:

- 103 Node tests pass locally and in the Linux builder; JavaScript syntax,
  Python AST, Rust formatting and diff checks pass. The 58 KWin cases cover
  delayed state/geometry commits, numeric flags, timeout/late replies, closed
  targets, stale queued actions, control error propagation and fresh retile time.
- `hoster-warp-native-20261025-maximize-preserve`: inactive/exit 0, 35 native
  checks pass in two virtual outputs; `preserve-result.json` and journal retained.
- `hoster-warp-build-20261025-maximize`: inactive/exit 0, 57 Linux Rust tests
  pass / one opt-in ignored, release executable and Debian bundle rebuilt;
  `build-journal.log`. The pre-existing Linux dead-code warning for `relative`
  remains unrelated to this Windows-used helper.
- `hoster-warp-gui-20261025-maximize`: inactive/exit 0, 33 full application
  checks pass with `--hold --radial --retile`, including existing gesture,
  registration and delayed-window-operation cleanup cases. Local receipt and
  screenshots are in `maximize/gui/`; the built binary is the new maximize build.
- `portafort-warp-native-20261025-maximize`: inactive/exit 0, all 35 native
  checks pass on the real Plasma 5.27.11 Wayland desktop with one physical
  display. `portafort-result.json` and journal retained; temporary script unload
  and owned-window cleanup succeeded. The one-output assertions explicitly
  validate fallback behavior rather than claiming a second physical display.

`/root/retile_review` implemented the three KWin source/test files and returned
terminal. `/root/packaged_native` independently reviewed Windows and KDE source,
identified stale queue replay, asked for direct maximized history acceptance,
and reviewed the corrections with no remaining actionable findings. Parent
implemented Windows and native fixtures and reconciled the canonical evidence.
All related native/build/application workloads are terminal; the normal Windows
debug binary is restored. No installer was installed or normal user app activated.

Portafort is reachable again through Hoster (2026-10-25 inspection): Plasma
5.27.11, Wayland, one 1920x1080 eDP output, Python/PyQt5 available; WebKitWebDriver
is absent. No test script or matching fixture process was active before testing.
The real-desktop fixture subsequently passed as recorded above. Live fixtures
now restrict discovery and action dispatch to their exact PIDs, use a unique
app ID, bound the helper lifetime, show without stealing initial focus, and
recheck original-focus identity on cleanup.
Hoster cleanup sidecar: two live/unregistered scopes retained, none stopped.

Remaining full-parity work includes state retention across pause/reload and
ordering across separate native-shortcut/control KWin script instances. AHK's
`SetWindowWarpHotkeysEnabled` only clears pending retile; the current Windows
disable path clears history/previous-focus, and KWin script reload drops caches.
Immediate unmaximize-then-tile behavior for delayed browser clients also needs
acceptance. Keep the existing physical display, real Plasma 6, browser/terminal,
overlapping-chord, login, installer and independent final release gates.

Resume at preserving window history, previous-focus and saved maximize state
across pause/configuration reload, then reconcile geometry dispatch through the
persistent KDE control instance so cross-script actions share one state owner.
The user-requested full port remains active; this is a verified feature checkpoint,
not full parity, a merge, publication or installation.


## Pause persistence and shared KDE state — verified (2026-10-25)

Owning branch remains `codex/cross-platform-app`, based on the verified
`db8a32f85086136750f6cfd38e737c76cafc03fc` implementation and `18796dc`
handoff. Main has no native desktop application; these defects belong to this
feature branch. No merge, push, installation or normal-session activation.

Contract: pausing and re-registering settings cancel held input and temporary
retile reservations but preserve process-local movement history, previous-focus
targets and maximize restore rectangles, matching the original AHK behavior.
KDE will keep one persistent Warp state owner in the control script. Registration
scripts forward the captured window identity, previous focus and input generation;
a FIFO Rust dispatcher correlates replies without blocking the endpoint on its
own callbacks. Geometry work shares the persistent queue. Session changes cancel
stale queued/continuing input while preserving caches; workspace restoration uses
the same geometry owner. Five-second command lifetimes and the existing 1.8-second
geometry deadline remain bounded, with no idle polling.

Parent owns Windows implementation, application fixtures, native validation and
integration. `/root/retile_review` owns KDE sources, focused tests and the minimal
radial captured-focus API; `/root/packaged_native` independently reviews that
contract. Reopen these named native children for their existing packets.

Windows red receipt: `desktop/src-tauri/target/windows-validation/
WARP-NATIVE-be4792a3-c13b-47f8-952e-b54c829e3dcf/` timed out restoring maximized
history after pause/configuration reload. Removing cache clearing from disable
passes all 45 native application checks, including retained previous focus and
saved maximize geometry, in `WARP-NATIVE-ee3aa729-f76f-4a37-b4e1-db663d4e33dd/`.
One physical second-display check remains skipped. Normal Windows binary restored.

KDE red receipt: `hoster-warp-gui-20261025-persistence-red` failed at the
new history-retention assertion: after pause/configuration reload, history pull
left the owned window floating at 550x360 instead of restoring maximization.
The exact failure journal and artifacts are retained under
`desktop/src-tauri/target/kde-validation/persistence/red-journal.log` and `red/`.

Final verification for this increment:

- 115 Node tests pass, including 70 KWin tests for persistent state, captured
  identity, shared ordering, cancellation, late bootstrap/replies and deadlines;
  JavaScript syntax, Python AST, Rust formatting and diff checks pass.
  Local Node receipt: `desktop/src-tauri/target/persistence-node.log`.
- 64 Windows Rust tests pass / five opt-in ignored on final shared source:
  `desktop/src-tauri/target/persistence-windows-rust.log`. The Windows native
  45-check receipt above remains applicable; subsequent changes are Linux-only
  cleanup and a conditional radial wrapper preserving Windows behavior.
- `hoster-warp-build-20261025-persistence-final`: inactive/exit 0, 60 Linux
  Rust tests pass / one opt-in ignored, 115 Node pass, executable and Debian
  package rebuilt. `build-final-journal.log`; only the pre-existing Linux
  unused `geometry::relative` warning remains.
- `hoster-warp-gui-20261025-persistence-final`: inactive/exit 0, all 37 native
  app checks pass with `--hold --radial --retile --resume-held --reassign-native`.
  This tests real separate registration/control scripts, retained history and
  previous focus, mixed shortcut/workspace geometry, and held-key generations.
  `gui-final-result.json`, `gui-final-journal.log`, and `gui-final/` artifacts.
  Earlier initial build passed 35 app checks before the final cleanup correction.
- `hoster-warp-native-20261025-persistence`: inactive/exit 0, 35 native geometry
  checks pass on two virtual outputs; `native-result.json`, `native-journal.log`.
- `portafort-warp-native-20261025-persistence`: inactive/exit 0, 35 native checks
  pass on the real one-output Plasma 5.27.11 Wayland desktop; scriptUnloaded true.
  `portafort-result.json` and `portafort-journal.log`. Standalone fixture uses
  local forwarding into the single Warp owner; full transport is covered by GUI.

The paths above without prefixes are under
`desktop/src-tauri/target/kde-validation/persistence/`. All task build/native
units are terminal and temporary scripts/owned windows cleaned up. The normal
Windows debug executable was restored by its fixture. No installer was installed,
no user app session activated, and no branch merged or pushed.

Independent `/root/packaged_native` review found and verified fixes for missing
focus completion, cancellation queued behind blocking worker requests, and
cleanup skipped after cancellation transport failure. Final review has no
remaining actionable findings; independent focused Node run passed 70/70.
`/root/retile_review` implemented KDE source/test changes and returned terminal.
Parent implemented Windows and native application regressions, verified red/green,
updated documentation and reconciled acceptance. Both native child names remain
reopenable via follow-up. Hoster cleanup sidecar inspected two unregistered live
scopes, retained both and stopped none; no unrelated workloads were terminated.

Reference audit: registration consumers now include `shortcuts.js`; package check,
Linux generation, Node fixtures, standalone live fixture and README agree. The
live.py CLI intentionally still accepts the warp.js path and loads sibling
shortcuts.js. `reset-app-pulls` has no remaining runtime/test references.

Remaining full-parity work includes delayed-browser direct tile/retile acceptance,
overlapping distinct chords, Windows Firefox and PowerShell/custom-terminal paths,
packaged-app/desktop-entry variants, physical mixed-DPI/portrait/disconnect cases,
real Plasma 6, login/tray/installer validation and final independent release audit.
Next: test direct unmaximize-and-tile with a delayed Wayland client, then continue
the remaining PARITY.md gates. The full feature-port goal remains active.

Verified implementation checkpoint: `346a4a02b7ec81f9f1c8803a5066dfde87649352`
on `codex/cross-platform-app`. This follow-up changes only the dossier pointer.
Resume from this checkpoint at delayed-client tile/retile acceptance, keeping
the remaining full-port PARITY.md requirements active.


## Delayed KDE tiling - verified (2026-10-25)

Previous goal turn made verified progress at `346a4a0` / dossier `fc0c8df`.
The same feature branch owns this continuation; no main desktop code exists.
Contract: direct four-way tiles, post-push retile, held mouse tiles and tiled
burner layouts retain the requested geometry after a delayed Wayland restore.
Reuse the persistent owner's timer, queue, identity checks and enqueue deadline:
known tile hint, unmaximize/fullscreen-exit acknowledgment, authoritative tile,
then placement acknowledgment. No new polling service or independent state owner.

Child `/root/retile_review` owns warp.js and KWin regressions; parent owns native
Firefox fixture and integration; `/root/packaged_native` independently reviews.
Four delayed-state regressions failed on baseline source; initial corrected
source passes 125 Node tests including 80 focused KWin tests. Native Firefox158
runs in Portafort's separate virtual compositor with temporary profiles. Only
its own process group is stopped for300ms to delay acknowledgment, always resumed
in finally; the real desktop seat and existing browser profiles are unaffected.

The old-build native run `portafort-warp-gui-20261025-tile-red` is terminal/failed.
It reached the fullscreen preparation and exposed a related restore expectation
bug: expected fullscreenfalse was computed immediately after requesting true;
Firefox later reached true and the owner timed out. Receipt:
`desktop/src-tauri/target/kde-validation/tiles/browser-red-journal.log` and
`browser-red/nested-kwin.log`. This is a real workspace restoration regression,
not proof of a real-browser tile failure. The requested-state expectation is now
corrected and the complete browser routes pass, as recorded below.
The first staged-tile build `hoster-warp-build-20261025-tiles` is terminal/exit0;
it predates the requested fullscreen expectation correction.


Final delayed-client verification:

- `hoster-warp-build-20261025-tiles-fullscreen`: inactive/exit0, 129 Node tests,
  60 Linux Rust tests / one ignored, executable and Debian bundle rebuilt.
  Only existing Linux unused geometry::relative warning remains.
- `hoster-warp-gui-20261025-tiles`: inactive/exit0, 37 native application checks
  pass with hold/radial/retile/resume-held/reassign-native. This uses the final
  corrected binary with the shared persistent owner and staged tile operation.
- `portafort-warp-gui-20261025-tiles-fullscreen`: terminal/exit1 after completing
  all window operations, at an outdated fixture-only editor assertion requiring
  five bindings. Browser path now captures actual config count before testing.
- `portafort-warp-gui-20261025-tiles-final`: inactive/exit0, 25 native Firefox158
  checks pass with --firefox --firefox-tiles. Private two-output compositor on
  Portafort, cached native WebKitWebDriver, same corrected Linux binary. All
  eight direct max/fullscreen tile combinations, held mouse tile, tiled burner
  left/right, maximized burner, maximize toggle and one-shot X retile pass after
  delaying the owned browser process group's acknowledgment for300ms. Existing
  session/profile/tab reuse/new-window/duplicate-title acceptance also passes.
- Parent reran129 local Node tests, syntax checks, Python AST and diff checks.
  Local log: `desktop/src-tauri/target/tiles-node.log`. No Windows production
  source changed, so the preceding64-Rust/45-native Windows receipt remains
  applicable; no redundant Windows run was needed for this KDE-only change.

Artifacts under `desktop/src-tauri/target/kde-validation/tiles/`:
`build-journal.log`, `gui-result.json`, `gui-journal.log`, `gui/`,
`browser-final-result.json`, `browser-final-journal.log`, `browser-final/`.
Earlier failing fixtures remain in `browser-red/`, `browser-fullscreen/` and their
journals. All named build/test units are terminal; fixture scripts, app processes
and private browser groups cleaned up. No normal user session was activated,
installer installed, branch merged or pushed. Cached Portafort test binary is
isolated at `~/.cache/window-warp-01a16f69/tile-browser/window-warp`.

`/root/retile_review` implemented shared staged tiling and the requested fullscreen
state correction, with32 delayed route/state/API combinations plus cancellation,
deadline/no-op and asynchronous fullscreen regressions. `/root/packaged_native`
independently passed84 focused tests and found no remaining production issue;
its final-state settling assertion improvement is included. Parent implemented
native browser acceptance, diagnosed the native fullscreen expectation failure,
corrected the stale Firefox fixture binding-count assertion, and integrated.
All child packets are terminal and reopenable by these names. Cleanup sidecar
retained two unregistered live scopes, stopped none.

Reference audit found no external Warp.tile callers; all direct/hold/burner
routes use the one shared completion-aware tile helper. README documents the
new --firefox-tiles flag and owned delayed-client boundary. A similar hard-coded
five-binding assertion remains in the independent terminal fixture path; recorded
in PARITY.md for correction when that path is exercised, without unrelated edits.

Next: Windows Firefox native capture/restore with owned temporary profiles,
followed by remaining terminal variants, burner/chord cases and final package/
Plasma6/physical-display/login gates. Keep the full feature-port goal active.

Verified delayed-client implementation checkpoint:
`99418f684119389c71825f58a292ce8bc429d5e7` on `codex/cross-platform-app`.
This follow-up only records the immutable checkpoint. Resume Windows Firefox
native acceptance using owned temporary profiles; preserve all PARITY.md gates.


## Windows Firefox native acceptance and launch profile filtering (2026-10-25)

Owning/lowest applicable branch remains `codex/cross-platform-app`; `main` has
no desktop implementation. No descendant propagation is needed. Parent owns
production code/docs/integration; `/root/packaged_native` implemented the three
Windows fixture files; `/root/retile_review` independently reviewed production
and fixture changes. No remaining actionable findings in the final scoped review.

The restore loop previously filtered profiles only when reusing an existing
window. A concurrently opened new window from a resolved different profile could
win post-launch matching and be focused/repositioned. Firefox Matcher now shares
an optional profile comparison between reuse and launch polling. Known mismatches
are rejected; the full unfiltered pre-launch ID snapshot remains intact. Default
launches lacking process-profile evidence retain existing title/app heuristics,
so unknown-profile identity remains an explicit limitation, not a new rejection.
A known path with an unresolved name is also unknown for name-only matching.
Two tests cover known match/mismatch before the selected tab opens, missing
process evidence, and unresolved names. No new configuration or metadata fields.

Windows opt-in --firefox / --firefox-only acceptance uses two fresh profiles and
local pages. Proven-owned process handles and creation times govern interaction
and cleanup; descendants must fall within their parent's verified lifetime.
Only owned HWND/PID diagnostics are retained after production capture returns.
Production capture still enumerates/enriches the desktop normally. The final
fixture captures the actual selected page, then requires unassisted new-window
restore to preserve both URLs and the selected URL. It also verifies existing
reuse, floating placement, an active competing explicit profile with identical
title, and browser editor review/save. Geometry compares fields, not serialized
object key order. Synthetic Ctrl+digit setup was removed after it failed to
change the live selection; no production failure is inferred from those attempts.

Evidence:
- Windows Rust:66 passed, five opt-in ignored;
  `desktop/src-tauri/target/firefox-windows-rust.log`.
- Node:129 passed; `desktop/src-tauri/target/firefox-node.log`.
- Windows focused native:8 checks pass, general suite explicitly skipped;
  `WARP-NATIVE-7492a848-11d9-45aa-a3ad-ce0b508230a4`.
- Final combined Windows native:50 checks pass, no reported skips;
  `WARP-NATIVE-2416cf83-8207-43da-b503-dbfeeb21cbbe`. Two displays were available
  for push/centering/maximized history/retile. Conditional single-monitor burner
  fallback was not applicable and retains earlier acceptance. Firefox cleanup
  tracked28 processes, all exited gracefully, errors0. Editor screenshot inspected;
  normal debug binary rebuilt/restored. No unsupported portrait/mixed-DPI claim.
- One intermediate general fixture observed null foreground during Alt+Escape,
  then an owned window after release. Final unchanged assertion passes. Receipt
  `WARP-NATIVE-00b3aaee-a6e0-4697-b080-6a97d0ccab83` remains; repeatable diagnosis
  should resume if it recurs in later chord/display tests (recorded in PARITY).
- Linux builder `hoster-warp-build-20261025-firefox-windows`: inactive/exit0,
  62 Rust pass / one ignored,129 Node pass; executable and Debian bundle rebuilt.
- Native KDE `portafort-warp-gui-20261025-firefox-windows`: inactive/exit0,
  25 Firefox checks, including existing delayed-client tiles/fullscreen routes,
  in a separate two-output Plasma5.27 compositor on Portafort. User seat untouched.
  Local receipts: `desktop/src-tauri/target/kde-validation/firefox-windows/`
  (`build-journal.log`, `browser-journal.log`, `browser-result.json`, `browser/`).
- Syntax and diff checks pass. Reaper sidecar inspected two unregistered live
  scopes, retained both, stopped0; no manual cleanup. All child packets terminal.

Both Windows native runs use source from this worktree. Linux test binary at
`~/.cache/window-warp-01a16f69/tile-browser/window-warp` contains the shared change.
No installer installed, normal app activated, branch merged or pushed. Existing
Windows preview installers remain old. Remote Git refresh remains an integration
gate; no integration was attempted.

Next: remaining terminal variants (PowerShell/custom Windows Terminal and KDE
terminal editor binding-count refresh), burner/chord cases, default-profile
identity, D-Bus/packaged variants, and final package/Plasma6/physical-display/login
acceptance in PARITY.md. A concurrent wrong-profile native launch is not covered
by this fixture; unit evidence covers its matcher behavior. Keep full goal active.

Verified Firefox implementation checkpoint:
`9ab716dd78ff2b719113155f541c57ebf67ca21c` on `codex/cross-platform-app`.
This follow-up records the immutable implementation SHA. Resume remaining terminal
variants and PARITY.md gates; the feature remains incomplete and unmerged.
