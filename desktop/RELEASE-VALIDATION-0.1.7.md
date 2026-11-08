# Window Warp 0.1.7 candidate validation

Built on 2026-11-07 from checkpoint `4bb57ee4f033f41f3996ed165cf499e47cce14e7`
with the app and package versions updated to 0.1.7. This is a local candidate;
it has not been published or installed over the user's application.

## Windows

- All 336 JavaScript tests passed. The release Rust suite passed 170 tests;
  nine opt-in tests were ignored. Syntax and formatting checks passed.
- The full preview loaded the user's 21 copied shortcut bindings and started
  paused. It uses the candidate source in a separate debug build with an
  isolated application identity and settings copy. Its edits do not update
  the installed application.
- The NSIS installer was extracted successfully; its executable reports
  0.1.7 and matches the clean release executable after normalizing the Tauri
  NSIS marker, PE timestamps, and debug GUID. The installer was not run for
  this candidate, so a clean install and upgrade remain unverified.
- The unsigned MSIX passed ZIP integrity and manifest-version checks. Its
  executable has the same SHA-256 as the unbundled release executable.
  Signing, Partner Center identity, installation, and upgrade remain unverified.

## PortaFort KDE Plasma 5.27.11 on Ubuntu 24.04

- All 336 JavaScript tests and 145 Rust tests passed; one Rust test was ignored.
- The extracted Debian package passed 22 checks in a private KDE session,
  including workspace review, shortcut registration, and hold behavior. The
  user service exited successfully and cleaned up its processes. Receipt:
  `/home/ryushe/.cache/window-warp-release-017-01a1af66/gui/gui-result.json`.
- The launcher identity and KDE icon resolution passed the offscreen package
  test. The package pins `kwin-common` to `4:5.27.11-0ubuntu3`; it was not
  installed or upgraded on the real desktop for this candidate.

## Candidate files

The files and a `SHA256SUMS.txt` are under
`src-tauri/target/release-candidate-017-01a1af66/artifacts`:

- Windows NSIS: `WindowWarp_0.1.7_x64_setup.exe`, SHA-256
  `a8d6a955a16627fb4a52cc4a44b6a27de6b72e0f18a77d2ff9b76821bde3f963`.
- Windows Store MSIX: `WindowWarp_0.1.7.0_x64.msix`, SHA-256
  `96d6e9d55d633ad425a33c9a146709ed57e2da60661bb239c3955612eec002b8`.
- Kubuntu 24.04 Debian package: `WindowWarp_0.1.7_kubuntu24.04_amd64.deb`, SHA-256
  `fde1767e864336d6cfdd56f5ed045f7cce76ecfe079852e3fa2fbfd45b1a6c34`.

## Remaining release work

The candidate has not been merged into `main` or published. Reconcile the known
branch conflicts and rerun checks on the integrated source before publication.
Windows 10, physical monitor reconnect/reordering, real installation and
upgrade of these candidates, and a real Linux browser-extension live-sharing
run remain unverified. Earlier physical Win-key checks and the Windows Firefox
extension live-sharing test passed on earlier builds; they were not repeated
against the packaged 0.1.7 executable. See `TODO.md` and `release.md` for the
remaining platform and Store gates.
