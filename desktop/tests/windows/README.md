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
debug build afterward, without the configuration override.

The native Python helper creates two owned Win32 windows. Keyboard input is sent
only after verifying an owned window has foreground focus and no modifier is
already held. It also reserves a test key to exercise registration failures.
The test covers:

- Pause/resume through Windows keyboard input, including pause while paused.
- Failed pause reassignment preserving the settings file and previous key.
- Partial window-action registration rollback while retaining pause.
- Current-app capture, native key recording, and reviewed conflict reassignment.
- Workspace capture/review with only owned windows selected and saved.
- Closest-match workspace update review without automatic persistence.
- Separate placements for reused windows and forced launch of a new process.
- Startup registration/removal, only when no existing `WindowWarp` Run entry exists.
- Single-instance behavior and release of the pause key after process exit.

`result.json` records checks, skips and errors. Screenshots, the isolated build
configuration and build/app logs stay in the run directory. Existing startup
configuration is preserved and reported as skipped. The fixture closes its own
process tree and helper; standalone fixture windows also have a bounded lifetime.
It does not change unrelated windows or terminate unrelated processes.

The test injects OS keyboard events; it does not substitute a direct callback for
keyboard delivery. It does not prove elevated-window control, actual login
launches, physical monitor removal, Firefox-specific restoration, or all terminal
profile variants. Those remain separate acceptance checks in `../../PARITY.md`.
