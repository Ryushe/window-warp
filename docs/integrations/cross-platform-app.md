# Cross-platform application integration dossier

- Status: feature, incomplete
- Owner: current Codex chat, user-requested full feature port
- Branch / owning ref: `codex/cross-platform-app`
- Worktree: existing `hotkeyable_windows` checkout
- Base commit: `7b907778f0022d73fb3527b82c0ab7ecedf8124d`
- Intended eventual target: `main`; promotion/merge has not been requested
- Last updated: 2026-10-24
- Latest immutable recovery checkpoint: `b216f0ce0374714e2d398511c328c84b21299596`
- Feature implementation commits: `abfc95e` (desktop/workspace foundation), `ee7bee4` (Firefox profiles/tabs), `c09d79c` (terminal capture/editor/restore), `491a9d8` (KDE Firefox caption correction and complete 15-check native run), `5e6373d` (WSL distribution discovery and native directory restoration), `02d4e02` (reviewed shortcut reassignment and 12-check native KDE run), `b216f0c` (persistent pause and application control hotkeys, 15 native KDE checks)
- Canonical references: original root AHK files; `desktop/PARITY.md`

## Intent and implemented contract

Port all original features into a standalone Windows/KDE application. The user's
explicit branch requirement is satisfied by this existing feature branch.
Original AHK sources remain unchanged. Full parity is not achieved: the checklist
is the completion gate, including remaining browser verification, terminal variants, INI migration,
tap/hold, radial selection, pointer movement, and remaining shortcut/editor paths.

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
  In particular, Windows multi-window launching and the full editor workflow,
  startup login launches, and live Plasma 6 must run before parity is claimed.
- Existing Windows installers predate this checkpoint; rebuild after remaining work.
- Firefox KDE evidence: all 15 `tests/kde/nested.sh --gui ... --firefox` checks
  now pass, including geometry; the editor screenshot was inspected. Windows
  Firefox UI and actual Plasma 6 still require native verification. The current
  Portafort binary is the caption-fix build documented below.
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

Next concrete native gap: an isolated Windows application/UI fixture covering
pause registration and rollback, current-app capture and workspace controls.
The existing native window/terminal tests do not instantiate those app flows.
Then continue hold/radial, pointer/retile and INI migration requirements in PARITY.
No merge, push or user-session activation has been requested.

For the Windows fixture, installed `tauri-codegen-2.7.4/src/lib.rs` confirms that
`TAURI_CONFIG` merges a build-only JSON override. A unique test identifier and
WebView data directory can isolate the app's settings/browser state without
editing the production manifest or borrowing a personal browser profile. No
Windows fixture has been implemented yet; do not count this as native evidence.

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
