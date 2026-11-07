# Window Warp 0.1.7 candidate integration dossier

- **Status:** candidate build; not published
- **Owner:** Codex
- **Source checkpoint:** `4bb57ee4f033f41f3996ed165cf499e47cce14e7`, with the six candidate version fields updated from 0.1.6 to 0.1.7
- **Working checkout branch:** `codex/desktop-shortcut-ux`
- **Intended integration target:** `refs/heads/main`, last fetched at `16d8b97da718de47cc78749602b89c95095709b7`
- **Owning recovery ref:** `refs/heads/codex/release-0.1.7-candidate` in `desktop/src-tauri/target/window-warp-release-cache.git`
- **Last updated:** 2026-11-07
- **Latest immutable recovery checkpoint:** `66262b104cc37e500f4f288d04e01743ba49b176`
- **Feature implementation commits:** `4ab4db8eb81b52af996106b44d87aa805fb5997c`, `5238df795670ea19bcd8dc9c4de74c1dfd9d1833`
- **References:** `release.md`, `AGENTS.md`, `desktop/RELEASE-NOTES-0.1.7.md`

## Intent and implemented contract

Build a local candidate containing the approved workspace review, saved-browser,
monitor, and shortcut behavior changes. Keep the user's checkout and installed
settings intact. The user chose a separate full preview using copies of existing
settings; its shortcuts start paused and edits remain in the copy. The preview
uses the same candidate source with a debug build and an isolated application
identity, rather than the exact packaged release binary.

The local source snapshot is under
`desktop/src-tauri/target/release-candidate-017-01a1af66/source`. Its six
version-bearing files are reflected in this branch; three LF files are normalized
back to the repository's existing line endings when staged. The preview state is
outside the source tree and must never be staged, packaged, or published.

## Evidence and review

- Windows candidate: 336 JavaScript tests passed; 170 Rust tests passed, nine
  ignored. Syntax and Rust formatting checks passed.
- The Windows full preview loaded all 21 configured shortcuts and was paused;
  the source files were copied without replacing the installed configuration.
- NSIS candidate: `WindowWarp_0.1.7_x64_setup.exe`, SHA-256
  `a8d6a955a16627fb4a52cc4a44b6a27de6b72e0f18a77d2ff9b76821bde3f963`.
  7-Zip successfully extracted its 0.1.7 executable. Differences from the clean
  release executable are the Tauri NSIS bundle marker, PE timestamps, and debug
  identifier. Installation and upgrade have not been exercised for this build.
- Unsigned MSIX candidate: `WindowWarp_0.1.7.0_x64.msix`, SHA-256
  `96d6e9d55d633ad425a33c9a146709ed57e2da60661bb239c3955612eec002b8`.
  ZIP integrity and manifest version were checked; its executable SHA-256
  matches the clean unbundled release executable.
- PortaFort candidate: the isolated `portafort-warp-release-017-01a1af66`
  service passed 336 JavaScript tests, 145 Rust tests (one ignored), and 22
  packaged-app checks in a private KDE session. The launcher and icon lookup
  also passed. The Debian package checksum is
  `fde1767e864336d6cfdd56f5ed045f7cce76ecfe079852e3fa2fbfd45b1a6c34`;
  its local copy has the same checksum.
- The user approved both the workspace icon buttons and the shortcut behavior
  layout in earlier isolated previews.

## Blockers and deferred work

- **KDE install/upgrade:** the version-matched package was tested in a private
  session, but has not been installed or upgraded on the user's live desktop.
- **Windows install/upgrade:** the user's existing installation is preserved;
  run `desktop/tests/windows/installer.ps1 -Execute` on a clean Windows profile or
  machine when available. The MSIX additionally needs Store identity verification
  and signing before installation or submission.
- **Integration and publication:** the preview branch and `main` have twelve
  known conflicting files. Fetch and reconcile both histories, rerun integrated
  checks, and verify the next available version before publishing. No GitHub or
  Store release was requested or created in this build-only task.
- **Platform coverage:** Windows 10, physical monitor reconnect/reordering, and
  some browser/terminal variants remain unverified; see `desktop/TODO.md`.

## Interruption / resume handoff

- **Owning recovery ref:** `refs/heads/codex/release-0.1.7-candidate` in the
  task-owned bare cache.
- **Latest immutable recovery checkpoint:** `66262b104cc37e500f4f288d04e01743ba49b176`.
- **Exact resume point:** retain the preview for the user and reconcile with
  `main` before any published release.
- **Working-tree state:** intentionally uncommitted in the user's checkout;
  the real Git object store has unavailable OneDrive placeholders. Do not reset,
  clean, or use its index to package the candidate.

## Decision gates

- **Integration:** reconcile with `main` and test the resulting tree.
- **Activation:** isolated preview; the installed application is unchanged.
- **Promotion:** explicit publication request, validated packages, and the gates
  in `release.md`.

## Decision record

- 2026-11-07 — user requested a full new build and selected a preview with copied
  settings rather than updating the installed app.
