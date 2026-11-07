# Shortcut behavior layout integration dossier

- **Status:** feature; live preview open for user review
- **Owner:** Codex
- **Checkout branch:** `codex/desktop-shortcut-ux`
- **Base checkpoint:** `c869de7771cad31a217c9aa9052b3d8dbd5eb768` (workspace UX handoff)
- **Intended integration target:** `refs/heads/main`, after the workspace UX dependency is reconciled
- **Owning recovery ref:** `refs/heads/codex/shortcut-behavior-layout` in `desktop/src-tauri/target/window-warp-release-cache.git`
- **Last updated:** 2026-11-07
- **Latest immutable recovery checkpoint:** `5238df795670ea19bcd8dc9c4de74c1dfd9d1833`
- **Feature implementation commit:** `5238df795670ea19bcd8dc9c4de74c1dfd9d1833`
- **References:** user-supplied screenshot, `AGENTS.md`, `desktop/HOOK-HANDOFF.md`

## Intent and implemented contract

Put the shortcut's existing main-monitor behavior and second-monitor placement
side by side beneath the Behavior heading. Hide the second-monitor placement
when the chosen behavior switches back to the previous app; retain its value
so it returns unchanged when the user selects the second-monitor behavior again.
Apply the same conditional visibility to the inline and separate quick editors.
At narrower widths the existing layout stacks the fields. No shortcut execution
or Windows hook behavior changes.

## Evidence and review

- `node --test --test-reporter=dot tests/editor.test.js tests/quick.test.js`:
  61 tests passed, including visibility and preserved-value cases for all three
  editors.
- `npm run check` passed.
- The isolated `behavior-layout-preview-01a1af66` Windows preview starts with
  sample data and shortcuts paused. Its expanded example was visually inspected;
  keyboard arrow selection hid and restored the second-monitor field.
- User review of the preview is pending.

## Blockers and deferred work

- **Integration:** this checkpoint depends on the workspace UX checkpoint. The
  release preview and `main` have twelve known conflicting files; reconcile both
  histories and rerun integrated checks before a new release.
- **KDE:** the current change has focused frontend tests but no new native KDE
  preview; run it when validating the integrated release candidate.

## Interruption / resume handoff

- **Owning recovery ref:** `refs/heads/codex/shortcut-behavior-layout` in the
  task-owned bare release cache.
- **Latest immutable recovery checkpoint:** `5238df795670ea19bcd8dc9c4de74c1dfd9d1833`.
- **Feature implementation commit:** `5238df795670ea19bcd8dc9c4de74c1dfd9d1833`.
- **Exact resume point:** collect user feedback on the preview and make any
  requested adjustment; then reconcile the dependent workspace work with `main`.
- **Working-tree state:** intentionally uncommitted in the user's checkout; the
  real Git object store has unavailable OneDrive placeholders. Only the isolated
  cache index is used for the recovery checkpoint.

## Decision gates

- **Integration:** user review and deliberate reconciliation with `main`.
- **Activation:** isolated preview only; installed app is unchanged.
- **Promotion:** new release requires the user's direction and `release.md`.

## Decision record

- 2026-11-07 — adopted the user's two-column layout and conditional placement
  control, preserving its setting while hidden.
