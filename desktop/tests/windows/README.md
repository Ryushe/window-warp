# Native Windows application validation

Run from the repository root in an interactive Windows desktop session with
Node 22 or newer, Python 3, Rust, the project's dependencies and WebView2 installed:

```powershell
node desktop/tests/windows/native.mjs
# Include real Firefox capture and restore with two temporary profiles:
node desktop/tests/windows/native.mjs --firefox
# Run only the browser acceptance checks while iterating:
node desktop/tests/windows/native.mjs --firefox-only
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
launches, physical monitor removal, or all terminal
profile variants. Those remain separate acceptance checks in `../../PARITY.md`.

`--firefox` additionally requires Firefox at its standard Program Files path, or
`WARP_FIREFOX_BINARY` naming the installed executable. It creates two profiles
and local HTML pages inside the run directory, verifies session capture, reused
and newly launched windows, tab selection, floating placement, identical-title
profile selection and the workspace editor. It retains diagnostics only for
owned HWND/PID pairs after the production capture API returns. The production
capture API itself still enumerates and enriches the desktop normally.

The Firefox helper proves ownership using exact profile arguments, executable
identity and retained process creation handles. Descendants must have been born
within their proven parent's lifetime. Cleanup closes owned windows and, if
necessary, terminates those exact process handles. It does not borrow existing
profiles. These tests cover explicit-profile launches; default-started Firefox
without a resolvable profile argument still uses ambiguous title/app matching.
The fixture records the browser's actual initial selected page and requires the
newly restored window to select that same URL. It does not inject a tab-selection
shortcut to assist restoration. `--firefox-only` explicitly skips the general
shortcut/workspace suite and retains app isolation and cleanup checks.


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
`WARP-NATIVE-6c823d34-8ae8-4c2b-b715-295a376939a3` passes 30 checks; its only skip
is physical multi-monitor geometry. It verifies one-monitor wrapping and the
complete push-to-retile lifecycle. The ordinary debug build was restored.

The focused native hook test can also be run with `WARP_TEST_RETILE=1`:
`cargo test --manifest-path desktop/src-tauri/Cargo.toml native_windows_retile_capture_and_release -- --ignored`.
It captures all four retile chords in an owned edit window, checks that reserved
Windows menus do not open, removes the hook and proves ordinary typing resumes.


Latest Firefox receipt (2026-10-25):
`WARP-NATIVE-2416cf83-8207-43da-b503-dbfeeb21cbbe` passes50 combined checks with
no reported skips. Two Windows displays exercised cross-monitor push/retile;
the single-monitor burner-fallback branch was not applicable. Separate focused
receipt `WARP-NATIVE-7492a848-11d9-45aa-a3ad-ce0b508230a4` passes eight checks.
The editor screenshot was inspected, all28 owned Firefox processes exited
without forced termination, and the ordinary debug executable was restored.
See PARITY.md for the earlier transient radial-focus assertion and remaining
profile/display/installer coverage limits.

## PowerShell and custom Terminal profiles

The ignored Rust test `native_powershell_profile_and_directory_restore` requires
an isolated [portable Windows Terminal installation](https://learn.microsoft.com/windows/terminal/distributions#windows-terminal-portable),
with `.portable` beside `WindowsTerminal.exe` and a fixture profile in
`settings/settings.json`. Use the official unpackaged ZIP, not a copy of the
Store package. The test does not edit the regular Terminal settings.

Set `WARP_TEST_TERMINAL_BINARY` to that absolute executable path and
`WARP_TEST_TERMINAL_PROFILE` to the fixture profile's unique name. Optionally set
`WARP_TEST_PWSH_PATH` to an absolute installed PowerShell 7 executable to test it
alongside Windows PowerShell. Then run:

```powershell
$env:CARGO_INCREMENTAL='0'
$env:CARGO_BUILD_JOBS='1'
cargo test --manifest-path desktop/src-tauri/Cargo.toml --offline native_powershell_profile_and_directory_restore -- --ignored --nocapture --test-threads=1
```

The fixture uses `-NoProfile -NonInteractive`, unique window titles and its own startup commands
to report shell PID, working directory and Terminal profile GUID. Captured
commands must remain empty. Window identity is retained before receipt assertions,
and cleanup closes only the marked HWND; it never terminates a shared Terminal
process. Receipts remain under `src-tauri/target/windows-validation/terminal-*`.
The test checks the launch functions and reuse compatibility directly; it does
not claim full Windows editor acceptance for every Terminal variant or reliable
active-profile discovery across multiple tabs sharing a process.


Verified with Microsoft-signed portable Terminal1.24.12741.0 on2026-10-25:
Windows PowerShell and PowerShell7 both pass actual profile-GUID and directory
restoration. Receipt: `terminal-876c1d4a-fec4-46f2-99db-f6bdefa71666`.
An earlier interactive setup stalled before its receipt command; automated setup
uses `-NonInteractive` and retains startup/timeout diagnostics. The packaged cmd
opt-in regression also passes. Windows Rust suite:68 pass, six opt-in ignored.
