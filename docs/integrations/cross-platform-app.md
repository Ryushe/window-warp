# Cross-platform application integration dossier

- Status: feature, incomplete
- Owner: current Codex chat, user-requested full feature port
- Branch / owning ref: `codex/cross-platform-app`
- Worktree: existing `hotkeyable_windows` checkout
- Base commit: `7b907778f0022d73fb3527b82c0ab7ecedf8124d`
- Intended eventual target: `main`; promotion/merge has not been requested
- Last updated: 2026-10-24
- Latest immutable recovery checkpoint: `ee7bee4471b0032907f4649ae475825111329860`
- Feature implementation commits: `abfc95e` (desktop/workspace foundation), `ee7bee4` (Firefox profiles/tabs and pending KDE resize verification)
- Canonical references: original root AHK files; `desktop/PARITY.md`

## Intent and implemented contract

Port all original features into a standalone Windows/KDE application. The user's
explicit branch requirement is satisfied by this existing feature branch.
Original AHK sources remain unchanged. Full parity is not achieved: the checklist
is the completion gate, including remaining browser verification, terminal capture, INI migration,
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
  refused size rather than claiming success. Final live revalidation is pending.
- Current Linux build: `hoster-warp-build-20261024-firefox-resize` completed with
  25 Node tests, 21 Rust tests, executable and Debian package. The last native run,
  `hoster-warp-gui-20261024-firefox-sequential`, failed creating the WebDriver session
  before any app assertions. Portafort load was 46.27 with unrelated Steam/browser
  processes active; no task-owned process remained. Do not restart or kill those
  unrelated workloads. The resize retry remains explicitly unverified live.
- Independent release review: pending. No merge, push, installation, or activation.

## Blockers and deferred work

- Remote refresh: `git fetch origin` failed with SSH host-key verification.
  Verify the configured GitHub SSH host key before refreshing refs for integration.
  This does not block implementing/testing this existing feature branch.
- Full feature scope and missing native evidence remain in `desktop/PARITY.md`.
  In particular, Windows multi-window launching and the full editor workflow,
  startup login launches, and live Plasma 6 must run before parity is claimed.
- Existing Windows installers predate this checkpoint; rebuild after remaining work.
- Next Firefox evidence: rerun the current `tests/kde/nested.sh --gui ... --firefox`
  on Portafort when its load is suitable. Use the already-built
  `~/.cache/window-warp-01a16f69/window-warp` and the extracted WebKitWebDriver.
  Require all 15 checks and inspect `window-warp-firefox-kde.png`. If geometry
  still fails, inspect the captured owned-window diagnostics before changing
  compositor timing or minimum-size handling. Windows Firefox UI remains pending.
- Hoster cleanup sidecar inspected two unregistered live scopes, retained both,
  stopped none (`needs-attention`). No action on unrelated workloads is needed.

## Resume and gates

Resume final Firefox revalidation when the host load permits; terminal specialization
and INI migration can progress locally meanwhile. Then gesture/radial,
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
