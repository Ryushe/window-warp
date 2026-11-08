# Window Warp 0.1.8 integration dossier

- **Status:** review-ready
- **Owner:** Codex
- **Branch:** `codex/release-0.1.8`
- **Base commit:** `a7d45554a8bac37b2fd452b0c3f141e77c26834f`
- **Intended integration target:** `codex/desktop-shortcut-ux`, then `main` for release
- **Last updated:** 2026-11-08
- **Owning feature branch/ref:** `codex/release-0.1.8`
- **Latest immutable recovery checkpoint:** `9ba34d0` on `codex/release-0.1.8`
- **Feature implementation commit(s):** `9ba34d0`
- **Inspiration / canonical references:** user's request to align the desktop release with both 0.1.8 browser extensions; `release.md`.

## Intent and implemented contract

Align desktop, Cargo, Tauri, Debian release naming, and the four-part MSIX
identity version to 0.1.8. Preserve the extension manifests at 0.1.8 and do not
rewrite the already published 0.1.7 tag or replace an existing Store submission.

## Evidence and review

- Windows: JavaScript suite (364 tests), syntax checks, `cargo fmt --check`,
  Rust suite (184 passed, 9 ignored), and Store guard tests passed. Desktop,
  lockfile, Tauri, MSIX, and both extension versions were checked together.
- Independent review found no actionable issues; the reviewer also ran 47
  Firefox-release/extension tests and all nine Store guard tests. The KDE asset
  must be uploaded with the exact distro-qualified name documented in README.
- Package checks: pending.
- The 0.1.7 Store workflow committed the MSIX submission and last reported
  preprocessing. Microsoft flagged `runFullTrust` as requiring approval.

## Blockers and deferred work

- **Missing evidence:** current Partner Center submission state and the 0.1.8
  package's clean-install, upgrade, and startup results. The available browser
  session requires sign-in; do not replace the current submission.
- **Command / fixture / environment needed:** Store read-only inspection and the
  Linux Mint 22.2 isolated release fixtures described in `release.md`.
- **Trigger / next step:** after version changes are tested and integrated, build
  the exact 0.1.8 commit and verify the Store's pending-submission guard before
  publishing. Do not overwrite the current 0.1.7 submission.

## Interruption / resume handoff

- **Latest immutable recovery checkpoint:** `9ba34d0` on the feature branch.
- **Exact resume point:** build and verify the release packages, integrate the
  reviewed version alignment, and reconcile the Store submission state.
- **Working-tree state at handoff:** feature changes in progress.

## Decision gates

- **Integration:** consistent version metadata, focused tests, and review.
- **Promotion / publication:** user requested release; verify packages, actual
  target environment behavior, and Store submission state before publishing.

## Decision record

- 2026-11-08 — created and independently reviewed for 0.1.8 alignment.
