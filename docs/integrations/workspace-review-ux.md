# Workspace review UX integration dossier

- **Status:** feature; local platform checks complete, integration pending
- **Owner:** Codex
- **Checkout branch:** `codex/desktop-shortcut-ux`
- **Base commit:** `e20dd653ca63cfcc59295aea3b9e712c5086f201` (published 0.1.6 preview)
- **Intended integration target:** `refs/heads/main`, last fetched at `16d8b97da718de47cc78749602b89c95095709b7`
- **Owning recovery ref:** `refs/heads/codex/workspace-review-ux` in `desktop/src-tauri/target/window-warp-release-cache.git`
- **Last updated:** 2026-11-06
- **Latest immutable recovery checkpoint:** not yet created
- **Feature implementation commits:** not yet created
- **Inspiration / references:** user feedback, `AGENTS.md`, `desktop/TODO.md`, and `desktop/HOOK-HANDOFF.md`

## Intent and implemented contract

Simplify the Workspaces section while preserving capture, update, browser, and
placement functionality. Saved workspaces and browsers expand to show their
contents; rows expose Open, Edit, and Delete, with bordered icon buttons and
confirmation before deletion. Selection mode supports deleting both kinds of
saved item. The editor supports removing and restoring captured windows, and a
recapture review highlights new, changed, or uncertain matches without guessing
which saved browser to overwrite. A draft remains recoverable while navigating
back to the library.

Saved browsers can be edited; the native save checks the expected record under
the workspace lock to avoid overwriting a live update. Display labels describe
position relative to the configured main display. Chosen Windows stable IDs or
KWin output names are retained across layout changes when the platform supplies
them; Plasma 5 numeric output names can change on reconnect. The picker updates
as displays change. Per-system terminal mapping and workspace transfer are
explicitly deferred, as requested. Generic application arguments remain manually
editable; the terminal capture does not replay commands that were running.

## Evidence and review

- Windows JavaScript: `npm test`, 333 passed on 2026-11-06; the subsequent
  change to this source was CSS button styling only. `npm run check` passes.
- Windows Rust: `cargo test --offline --manifest-path src-tauri/Cargo.toml -j 1`,
  170 passed, nine ignored. Formatting check passes.
- Windows WSL: with `WARP_TEST_WSL_DISTRO=Ubuntu`, the opt-in
  `native_wsl_capture_and_directory_restore` test passed. It identified the
  distribution and restored an owned new terminal in the manually specified
  `/tmp` directory; it does not prove capture of an interactive shell's current
  directory or reattachment to running commands.
- PortaFort: the isolated `portafort-warp-workspace-ux-v3-01a1af66` unit passed
  332 JavaScript and 145 Rust tests (one Rust test ignored), built the app, and
  passed all 16 checks in the private KDE GUI fixture. The unit exited cleanly.
  Receipt: `/home/ryushe/.cache/window-warp-workspace-ux-01a1af66/gui-v3/gui-result.json`.
- Independent user-requested UI review: `/root/workspace_ux_review` reviewed the
  complete workspace flow, monitor identity and deletion races, and the final
  button styling. Reported blockers were fixed; the final check found none.
- The Windows preview `workspace-buttons-preview-01a1af66` uses isolated sample
  data and starts with shortcuts paused. Its workspace and saved-browser rows
  were visually inspected after the button styling change.

## Blockers and deferred work

- **Integration:** the published preview branch and `main` have twelve known
  conflicting files. Fetch and reconcile both histories deliberately, then rerun
  integration checks. Do not reset or overwrite the user's dirty checkout.
- **Cross-platform workspaces:** design transfer and per-system terminal mapping
  later, as recorded in `desktop/TODO.md`.
- **Unverified:** physical monitor reconnect/reordering on all supported
  configurations, Windows 10, and WSL GUI application restoration. The existing
  WSL test covers Windows Terminal and a new shell, not arbitrary running apps.

## Interruption / resume handoff

- **Owning recovery ref:** `refs/heads/codex/workspace-review-ux` in the bare
  release cache; preserve the real checkout and its unrelated uncommitted files.
- **Latest immutable recovery checkpoint:** pending creation.
- **Exact resume point:** review the preview with the user, then reconcile the
  release branch with `main` and run integrated checks before any new release.
- **Working-tree state:** intentionally uncommitted in the user's checkout;
  its real `.git` object store has unavailable OneDrive placeholders. A separate
  index in the task-owned bare cache is used for recovery, not the real index.

## Decision gates

- **Integration:** reconcile with `main` and run checks on the resulting tree.
- **Activation:** a live preview with isolated sample data; no installed app was
  replaced for this change.
- **Promotion:** a new release requires the user's direction and `release.md`.

## Decision record

- 2026-11-06 — user deferred cross-platform workspace transfer and asked for
  direct, bordered icon actions and clearer monitor directions.
