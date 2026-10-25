# Native Windows application validation

Run from the repository root in an interactive Windows desktop session with
Node 22 or newer, Python 3, Rust, the project's dependencies and WebView2 installed:

```powershell
node desktop/tests/windows/native.mjs
```

This opt-in fixture builds the production app with a unique application identity
and a Tauri `appDirectoriesOverride` pointing into
`desktop/src-tauri/target/windows-validation/WARP-NATIVE-<uuid>/state`. The
production manifest and user settings are unchanged. Its WebView debugging port
listens on loopback and uses only that task's fresh browser data. The script
copies its test executable into the run directory and restores the ordinary
debug build afterward, without the configuration override. Both builds use one compiler job and omit final-crate debug symbols to reduce memory use. Both webviews receive identical debug options because WebView2 shares their browser environment.

The native Python helper creates two owned Win32 windows. Keyboard input is sent
only after verifying an owned window has foreground focus and no modifier is
already held. If Windows denies programmatic focus, it can temporarily raise and click the verified title bar of its own window, then restore the pointer and topmost flag. It sends no keys if focus still fails. It also reserves a test key to exercise registration failures.
The test covers:

- Pause/resume through Windows keyboard input, including pause while paused.
- Failed pause reassignment preserving the settings file and previous key.
- Partial window-action registration rollback while retaining pause.
- Current-app capture, native key recording, and reviewed conflict reassignment.
- App-pull tap on release, including release of a modifier before the main key.
- Hold tiling from the initial pointer position, repeat suppression, and no tap
  after hold; pausing and resuming before release cancels the pending gesture.
- Radial window order, pointer selection on release, dead-zone cancellation, Escape, and pause/resume while held (four checks).
- Saved delay and disable-hold settings; a disabled hold still taps on release.
- Workspace capture/review with only owned windows selected and saved.
- Closest-match workspace update review without automatic persistence.
- Separate placements for reused windows and forced launch of a new process.
- Startup registration/removal, only when no existing `WindowWarp` Run entry exists.
- Single-instance behavior and release of the pause key after process exit.
- Push then X/C or Super+X/C retiling, including changed focus, one-use consumption,
  expiry, deadline renewal and pause/resume cancellation. A single-monitor run
  verifies wrap-in-place; cross-monitor geometry is explicitly skipped without
  another connected display.

`result.json` records checks, skips and errors. Screenshots, the isolated build
configuration and build/app logs stay in the run directory. Existing startup
configuration is preserved and reported as skipped. The fixture closes its own
process tree and helper; standalone fixture windows also have a bounded lifetime.
It does not change unrelated windows or terminate unrelated processes.
The helper uses per-monitor DPI awareness, releases only its own injected held
keys, and restores its pointer position if the pointer has not moved since the
last fixture movement. Hold tests require every matching executable window to
belong to the fixture process. The settings screenshot is `hold-settings.png`.

The test injects OS keyboard events; it does not substitute a direct callback for
keyboard delivery. It does not prove elevated-window control, actual login
launches, physical monitor removal, Firefox-specific restoration, or all terminal
profile variants. Those remain separate acceptance checks in `../../PARITY.md`.


Current receipt: all 22 checks pass with no skips in
`src-tauri/target/windows-validation/WARP-NATIVE-42666202-5045-4fed-9580-d4fe8bcd9dcf/`.
The radial selection is applied before hiding the overlay, preserving Windows
foreground eligibility. Its screenshot was inspected and the ordinary debug
build was successfully restored. Earlier memory and release-focus failures are
superseded by this fresh build and native run. Existing preview installers are
unchanged and do not contain this work.


INI coverage selects actual UTF-16 files through the native WebView file input,
checks that review does not save, preserves a disabled key and an unsupported
match, then explicitly saves shortcuts and a two-window terminal/Firefox
workspace. The latest import run has 23 passing checks and one explicit skip:
`WARP-NATIVE-0f28c784-4d06-4f64-b58e-ee75d3bfab14`.

Rapid Escape and native focus-loss cancellation now pass, including five immediate
Escape taps. The diagnostic skip option was removed. The current full run
`WARP-NATIVE-0faae945-a181-464b-a6ce-f4fe58958af9` passes 30 checks; its only skip
is physical multi-monitor geometry. It verifies one-monitor wrapping and the
complete push-to-retile lifecycle. The ordinary debug build was restored.

The focused native hook test can also be run with `WARP_TEST_RETILE=1`:
`cargo test --manifest-path desktop/src-tauri/Cargo.toml native_windows_retile_capture_and_release -- --ignored`.
It captures all four retile chords in an owned edit window, checks that reserved
Windows menus do not open, removes the hook and proves ordinary typing resumes.
