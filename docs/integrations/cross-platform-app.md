# Cross-platform application integration dossier

- Status: feature, incomplete
- Owner: current Codex chat, user-requested full feature port
- Branch / owning ref: `codex/cross-platform-app`
- Worktree: existing `hotkeyable_windows` checkout
- Base commit: `7b907778f0022d73fb3527b82c0ab7ecedf8124d`
- Intended eventual target: `main`; promotion/merge has not been requested
- Last updated: 2026-10-24
- Latest immutable recovery checkpoint: none yet; this dossier accompanies the first application checkpoint
- Feature implementation commits: pending checkpoint
- Canonical references: original root AHK files; `desktop/PARITY.md`

## Intent and implemented contract

Port all original features into a standalone Windows/KDE application. The user's
explicit branch requirement is satisfied by this existing feature branch.
Original AHK sources remain unchanged. Full parity is not achieved: the checklist
is the completion gate, including browser/terminal capture, INI migration,
tap/hold, radial selection, pointer movement, and remaining shortcut/editor paths.

The current implementation includes the Tauri editor/tray, native Windows/KWin
window actions, startup registration, and workspace capture/review/edit/restore.
Workspace launch uses separate program/argument values, matches each saved entry
to a distinct window, and reports individual restore failures. KDE workspace
commands use a persistent session-bus service and an unassigned KWin action.

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
- Independent release review: pending. No merge, push, installation, or activation.

## Blockers and deferred work

- Remote refresh: `git fetch origin` failed with SSH host-key verification.
  Verify the configured GitHub SSH host key before refreshing refs for integration.
  This does not block implementing/testing this existing feature branch.
- Full feature scope and missing native evidence remain in `desktop/PARITY.md`.
  In particular, Windows multi-window launching and the full editor workflow,
  startup login launches, and live Plasma 6 must run before parity is claimed.
- Existing Windows installers predate this checkpoint; rebuild after remaining work.
- Hoster cleanup sidecar inspected two unregistered live scopes, retained both,
  stopped none (`needs-attention`). No action on unrelated workloads is needed.

## Resume and gates

Resume browser/terminal specialization and INI migration; then gesture/radial,
pointer, and outstanding editor/global-hotkey behavior. Preserve all checklist rows.
Native KDE fixture tests and local Node/Rust tests are ready for reuse.

Integration requires completed parity evidence, independent review, verified
remote state, and explicit selection/authorization of the integration target.
Runtime activation requires rebuilding and verifying actual launch/install paths.
Stable promotion remains a separate user decision. This checkpoint is partial
feature work, not a release candidate.

## Decision record

- 2026-10-24: Workspace core is implemented and exercised on KDE; Windows native
  capture/placement/state checks pass. Save a recoverable feature checkpoint and
  continue the full port.
