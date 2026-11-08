# Browser extension library integration dossier

- **Status:** release-blocking sync and compatibility fix; propagation pending
- **Owner:** Codex
- **Owning ref:** `codex/fix-sync-owner` in the isolated fix checkout
- **Base checkpoint:** `63532416cf61a7d6e734f4528d3317167132f166`
- **Intended integration target:** `refs/heads/main`, as recorded by the existing workspace and release dossiers
- **Last updated:** 2026-11-07
- **Implementation checkpoint:** pending this commit
- **References:** user-approved extension mockup, `AGENTS.md`, and `desktop/TODO.md`

## Intent and implemented contract

An independent release review found that an ownership change could leave a
stale destination label and that a newer extension could connect to an older
desktop lacking the library actions. Invalidate cached labels when ownership
changes, require a sync to match the destination displayed when clicked, and
show an actionable desktop-update message when the library protocol is absent.

Implement the shared Firefox and Chromium extension library without redesigning
the Windows Workspaces page. The popup provides searchable saved-browser and
workspace lists, visible open actions, saved-browser renaming, profile settings,
connection and live-update controls, and a current-destination chooser.

Sync updates the current window's identified owner. Saving creates a new saved
browser or workspace and can link that destination. Sync elsewhere replaces a
chosen target once, after confirmation, without changing the current owner.
Revision checks prevent stale chooser actions from overwriting newer data. Tab
snapshots remain on demand unless live updates are enabled; private windows are
excluded. Opening saved tabs in the current browser leaves existing tabs open.
The TODO covers large libraries and optional shared sync between two destinations.

## Evidence and review

- Windows JavaScript: `npm test` in `desktop` passed 349 tests, including the
  extension and local mock service; `npm run check` passed.
- Focused fix checks: 35 extension tests and 40 browser-bridge tests passed; the
  existing loopback-origin test was excluded from the latter sandbox run.
- Windows Rust: `cargo test --offline --manifest-path src-tauri/Cargo.toml
  browser_bridge::tests -j 1` passed 40 tests with loopback access; `cargo fmt
  --manifest-path src-tauri/Cargo.toml -- --check` passed.
- The implementation was developed in an isolated source copy; all nine changed
  checkout files were hash-checked against their pre-task versions before copy.
- An independent review and live Firefox/Chromium acceptance were not run.

## Blockers and deferred work

- The shared checkout's Git worktree creation failed with `fatal: mmap failed:
  Invalid argument`. Its current extension changes were copied into an isolated
  checkout based on the matching `4bb57ee` recovery checkpoint; preserve the
  shared checkout and do not reset its existing changes.
- Merge the later `d7cd97a` release candidate, the Store automation branch, and
  fetched `main` without losing any existing behavior; verify the integrated tree.
- Before release or integration, run the disposable browser fixtures described
  in `desktop/tests/windows/README.md`: `node desktop/tests/windows/native.mjs
  --firefox-extension-only` and `--chromium-only` with a compatible Chromium
  executable. Verify the updated popup, keyboard flows, and actual open/sync
  behavior. These checks require an isolated native fixture build and loopback.
- Large-library performance and linking a saved browser to a workspace for
  simultaneous updates remain design follow-ups in `desktop/TODO.md`.

## Resume and activation

Commit the fix on this owner branch and merge it into the release integration;
rerun the full checks and browser acceptance against the merged result. The
installed app and extensions have not been updated; activation requires a new
app build and re-preparing or reloading the development extensions.
