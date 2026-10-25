# Cross-platform application integration dossier

- Status: feature, incomplete
- Owner: current Codex chat, user-requested full feature port
- Branch / owning ref: `codex/cross-platform-app`
- Worktree: existing `hotkeyable_windows` checkout
- Base commit: `7b907778f0022d73fb3527b82c0ab7ecedf8124d`
- Intended eventual target: `main`; promotion/merge has not been requested
- Last updated: 2026-10-24
- Latest immutable recovery checkpoint: `5e6373d523f540490e2ce478fd84ae9636a940f6`
- Feature implementation commits: `abfc95e` (desktop/workspace foundation), `ee7bee4` (Firefox profiles/tabs), `c09d79c` (terminal capture/editor/restore), `491a9d8` (KDE Firefox caption correction and complete 15-check native run), `5e6373d` (WSL distribution discovery and native directory restoration)
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
