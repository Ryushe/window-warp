# Live KDE validation

These tests use the production KWin script. They create only their own fixture windows and unload their test script afterward. Python 3, PyQt5 (including QtDBus), qdbus, and KWin are required.

## Active desktop session

Run from the desktop source directory, in the KDE user's session:

```sh
python3 tests/kde/live.py src-tauri/kwin/warp.js
```

When connecting over SSH, set `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS`, and `WAYLAND_DISPLAY` to the intended user's existing session, and use `QT_QPA_PLATFORM=wayland`. Do not run as root. The test opens two temporary windows, so it can briefly take focus. No existing application window is moved or resized.

The runner verifies tiling, push/pull, minimized-app focus, cycling, registered action dispatch through KGlobalAccel, maximized/fullscreen tiling, and script unload. On a one-display desktop it reports push and empty pull as no-ops, not as successful multi-display coverage. KGlobalAccel dispatch tests the registered callback; it does not simulate a physical keyboard event.

## Isolated two-display compositor

```sh
dbus-run-session -- bash tests/kde/nested.sh "$PWD"
```

This starts a separate KWin virtual framebuffer with two 1280×720 outputs, a separate D-Bus session, and temporary config/runtime directories. The active desktop's outputs and layout are unaffected. The compositor is stopped automatically; its logs remain in the printed temporary directory for diagnosis.

## Actual desktop application UI

Build the executable on Linux. A matching `WebKitWebDriver` is required; `prepare-driver.sh TEST_DIRECTORY` can download and extract the distribution's `webkit2gtk-driver` package into a test directory without root or a system-wide installation.

```sh
python3 tests/kde/gui.py /absolute/path/to/window-warp \
  /absolute/path/to/WebKitWebDriver ./test-results
```

Run in a KDE Wayland session with `XDG_CURRENT_DESKTOP=KDE` and `QT_QPA_PLATFORM=wayland`. The runner uses the native WebKitGTK automation protocol and real Tauri commands. It checks rendering, settings persistence, enabling, pausing, startup registration, workspace capture/save, two-window reuse, forced new-window launch, per-axis maximization, fullscreen, and the workspace browser. Configuration, data, and cache directories are isolated. It refuses to start if Window Warp or either integration script is already running. It closes its process group, owned Qt fixtures, and both scripts afterward. Launched fixtures also have a 60-second exit timer. It produces screenshots, JSON results, and a log. Only owned fixture metadata is saved, and only owned fixture windows are restored.

The native driver capabilities and automation environment variables match Tauri's [WebDriver implementation](https://github.com/tauri-apps/tauri/tree/dev/crates/tauri-driver/src).

### Firefox profiles and tabs

With Firefox installed, run the native UI test inside the separate compositor:

```sh
dbus-run-session -- bash tests/kde/nested.sh "$PWD" --gui \
  /absolute/path/to/window-warp /absolute/path/to/WebKitWebDriver \
  ./firefox-test-results --firefox
```

This creates temporary Firefox profiles and local HTML pages, captures real
compressed session files, verifies existing-window reuse, and restores a new
window with both URLs and the selected tab. A second profile with identical page
titles checks profile isolation. Only the fixture browser process groups are
terminated afterward; existing browser profiles are not changed.

Add `--firefox-tiles` to exercise four-way tiling from maximized/fullscreen
windows, held mouse tiling, all burner layouts, and one-shot
post-push retiling. This option requires `--firefox` and the isolated compositor.
It delays Firefox's window acknowledgments by stopping only its newly created
private-profile process group for 300 ms, always resuming it in `finally`.
Each tile must retain its requested geometry and floating state after settling.
Workspace fullscreen restoration and fullscreen-to-maximized transitions are
also checked against their requested state.
Floating burner round trips preserve geometry and maximization on both outputs.

Add `--overlap` with `--firefox --firefox-tiles` to hold one app chord while
tapping a distinct chord with the same modifiers. The owned Firefox process
group pauses for 1.4 seconds so the first hold must wait for its window update.
The second chord releases before its hold deadline and must not become a tile.
Both key orders run in the same controller; `firefox-overlap.json` records the
injected timing and observed geometry. Firefox resumes and keys release on exit.

The Firefox option records `firefox-restore-observations.json` with the last ten
distinct capture states for its owned browser window. It waits for URL and active
tab identity rather than assuming a two-tab count means navigation has finished.
The duplicate-caption regression uses two windows with identical tab titles and
a second Firefox profile to exercise KWin's numeric caption decorations.

The codec follows Mozilla's [IOUtils implementation](https://github.com/mozilla-firefox/firefox/blob/main/xpcom/ioutils/IOUtils.cpp),
including the eight-byte magic and four-byte size prefix. Launch flags follow
Mozilla's [command-line reference](https://github.com/mozilla-firefox/firefox/blob/main/browser/docs/CommandLineParameters.md).

## Reproducible Linux build environment

`Dockerfile` creates an Ubuntu 24.04 builder; `build.sh` runs Node tests, Rust release tests, a Linux executable build, and Debian packaging. Mount only this source directory at `/work`, run as UID/GID 1000, and constrain container resources as appropriate for the build host. No privileged container or Docker socket mount is required.

## Verified environment

On 2026-10-24, the live script tests passed on Plasma 5.27 (KWin 5.27.11, Qt 5.15.13), with native Wayland fixture windows. The isolated two-output session passed all nine checks. This run discovered and fixed the fullscreen capability-flag guard. Plasma 6 compatibility remains covered by simulated-workspace tests, pending a live Plasma 6 environment. Mixed-DPI physical displays and unplugging an actual monitor remain manual checks.

The compiled Linux application also passed all four native UI checks on that session with WebKitGTK 2.52.6: rendering, settings persistence, loading the KWin integration, and unloading it on pause. The Linux build passed five Rust tests and twelve Node tests. A Debian amd64 package was generated on Ubuntu 24.04; the package itself has not been installed during testing. The Windows build passed six Rust tests, including native Win32 positioning, and produced an x64 NSIS installer.

Subsequent full-port work increased coverage to 18 live two-output checks and
11 native application checks. The workspace increment passes 24 Node tests,
13 Linux Rust tests, and 16 Windows Rust tests. See `../../PARITY.md` for the
current evidence and remaining feature scope; the counts above describe the
earlier preview only.

## Terminal workspace verification

Append `--terminal` to the existing isolated `nested.sh --gui BINARY DRIVER OUTPUT`
invocation. The fixture creates its own Konsole process and a temporary working
directory, checks shell/profile/directory capture, reuses that window, launches a
new one and verifies the saved identity. It cleans up only its owned terminals.
The editor screenshot is `OUTPUT/window-warp-terminal-kde.png`.

On Windows, explicitly run the opt-in Rust test
`cargo test --manifest-path desktop/src-tauri/Cargo.toml --offline native_terminal_capture_and_new_window_launch -- --ignored --nocapture`.
It opens and closes two test Terminal windows; ordinary unit-test runs skip it.

API sources: [Konsole session](https://github.com/KDE/konsole/blob/master/src/session/Session.h),
[Konsole window](https://github.com/KDE/konsole/blob/master/src/ViewManager.h),
[Konsole profile resolution](https://github.com/KDE/konsole/blob/master/src/profile/ProfileManager.cpp),
[Windows Terminal parser](https://github.com/microsoft/terminal/blob/main/src/cascadia/TerminalApp/Commandline.cpp).

### Application control shortcuts

The default native GUI fixture also invokes registered KGlobalAccel actions for
pause/resume, current-app editing, workspace browsing and closest-match update
review. It verifies the pause script remains installed while window actions are
paused, and only owned test windows are used for app capture. These checks cover
the real app/KWin bridge; they do not inject physical keyboard events. The test
unloads window, pause and control scripts afterward. Screenshots include
`window-warp-current-app-kde.png` and `window-warp-update-kde.png`.


### Native tap/hold input

Append `--hold` to `nested.sh --gui BINARY DRIVER OUTPUT` to exercise native
Wayland key delivery, modifier-first release, pointer-at-press tiling, automatic
key repeat, pause cancellation, disabled hold, and persistent pause registration.
This option requires `libwayland-client.so.0` and `dbus-monitor`. Its distinct
owned app identity prevents earlier workspace fixtures from satisfying a pull.
The report is `gui-result.json`, the settings screenshot is
`window-warp-hold-kde.png`, and `shortcut-signals.log` records the private
compositor's KGlobalAccel signals for failure diagnosis.

`wayland_input.py` refuses any display other than `warp-test` in a temporary
`/tmp/window-warp-nested.*/runtime` directory. It injects evdev key events through
KDE's fake-input protocol and releases its own keys on exit. Only the nested
KWin process receives `KWIN_WAYLAND_NO_PERMISSION_CHECKS=1`; the user's compositor
and input permissions are unaffected. The protocol is a fixture dependency,
not part of the application. The application uses KGlobalAccel pressed/released
signals and the authenticated KWin callback to capture the pointer.

For an isolated signal-contract probe, run:

```sh
dbus-run-session -- bash tests/kde/nested.sh "$PWD" --input-probe
```

Unlike direct `invokeShortcut` dispatch, this exercises real compositor key
press, autorepeat and modifier release. It still uses virtual outputs rather
than physical devices. Plasma 6 and overlapping distinct global chords need separate acceptance
checks. Pause/resume while held is covered by the regression below.

Implementation references: [KGlobalAccel signals](https://github.com/KDE/kglobalaccel/blob/v5.115.0/src/runtime/component.cpp),
[KDE fake-input protocol](https://github.com/KDE/plasma-wayland-protocols/blob/master/src/protocols/fake-input.xml),
and [KWin's test permission switch](https://github.com/KDE/kwin/blob/v5.27.11/src/wayland_server.cpp).


Add `--reassign-native` alongside `--hold` to verify that moving a key from an
app-pull binding to a tiling binding delivers the new native action. It also
checks that pause removes old hold reservations while preserving the pause,
control, and unrelated KDE action IDs. This is stronger evidence than invoking
an action by ID through D-Bus.

`--hold --resume-held` is the explicit cancellation regression: pause and resume
before releasing the original chord, then assert neither tap nor hold runs.
It now passes with per-chord hooks: only the cancelled held hook remains during
pause, unrelated hooks are removed, resume cannot revive the gesture, and a new
press works after release. `--reassign-native` also edits the held chord before
resuming, checks that neither old nor replacement action fires early, and waits
for the new action's real key reservation before testing its next press. It uses
`gdbus` (GLib tools) for the reservation query.


The combined command `--hold --resume-held --reassign-native` passes 22 native
checks on Plasma 5.27. The loader acknowledges each script using a one-use ticket.
This catches Plasma 5's reused numeric D-Bus IDs when scripts unload out of order;
on an observed occupied ID it uses the supported scripting startup entry point.
See [KWin 5 loader implementation](https://github.com/KDE/kwin/blob/v5.27.11/src/scripting/scripting.cpp).
Physical displays, Plasma 6, and overlapping distinct held global chords remain
separate coverage gaps. A cancellation guard has no timer-based suppression.


Add `--radial` to `--hold --resume-held --reassign-native` to exercise a separate
nine-window fixture. It verifies the eight-slot limit and stable title order,
real pointer selection followed by native key release, dead-zone cancellation,
Escape and pause/resume cancellation while held. The combined fixture has 26
checks. `window-warp-radial-kde.png` captures the actual overlay through its
WebKit window. The fixture uses its own app identity and terminates all nine
owned windows during cleanup. Its pointer and key injection remains restricted
to the private nested compositor.


Add `--import` to test legacy INI review through WebKit's File/DataTransfer API.
It decodes UTF-16, retains Windows app matches as disabled Linux drafts, proves
review never saves, then explicitly saves a Windows-scoped terminal workspace.
The baseline plus import passes 17 checks in `hoster-warp-gui-20261024-import`.
Its screenshot is `window-warp-import-kde.png`. Windows separately verifies
native selection of actual files from disk.


### Pointer capability and isolated Linux test desktop

Add `--pointer` with `--hold` to the native GUI invocation. The nested runner then
uses normal KWin permission checks. It creates desktop capability declarations
for the tested executable and keyboard fixture only inside the temporary XDG
data directory. It checks app-pull centering, both centered push actions and history
pull. Run a separate session with `--hold --pointer-denied` to check refusal with
no app capability declaration from startup, including an unchanged pointer and
the editor's error message. Do not test refusal by editing a declaration in an
already-running compositor: the tested KWin session continued to authorize it.
`pointer_probe.py` reads
the private compositor's cursor through a temporary KWin script. It does not
attach to the user's session. The combined pointer/hold/radial/reassignment/import
run passes 31 native checks on Plasma 5.27; the separate refusal run passes 21.
Reports: `src-tauri/target/kde-validation/pointer-{accepted,denied}/`.

A disposable test image can run without an existing KDE desktop:

```sh
docker build -t window-warp-build:local -f tests/kde/Dockerfile .
docker build -t window-warp-gui:local -f tests/kde/Dockerfile.gui .
docker run --rm --init --network=none --cpus=2 --memory=3g --shm-size=256m \
  --mount type=bind,source="$PWD",target=/work window-warp-gui:local
```

Build the application first using the builder. The GUI image uses its matching
WebKit driver; it does not mount the host display socket or session bus. Its
optional X11 test runs against a separate Xvfb server:

```sh
xvfb-run -a env WARP_TEST_X11=1 cargo test --release --locked \
  --manifest-path src-tauri/Cargo.toml native_x11_pointer_round_trip -- --ignored
```

The installed Debian/RPM desktop entry declares
`X-KDE-Wayland-Interfaces=org_kde_kwin_fake_input` and an absolute executable path.
A standalone development executable needs a matching desktop entry to center the
pointer on Wayland. Never disable KWin's permission checks on the user's desktop.

### Timed retile acceptance

Add `--retile` with `--hold` to verify native X/C and Super+X/C delivery after a
push. The fixture checks changed focus, one-use consumption, an existing Super+C
binding, Ctrl+X exclusion, expiry, consecutive-push renewal, pause/resume and an
explicitly configured pause key taking precedence. It checks actual KGlobalAccel
reservation cleanup after use and expiry. All targets belong to the fixture.

The combined `--hold --pointer --retile --resume-held --reassign-native --radial --import`
run passes 39 checks on Plasma 5.27, including a withheld control reply proving
that ordinary typing resumes before window I/O finishes. The fault injection
replaces and restores only the private compositor's control script. Receipt:
`src-tauri/target/kde-validation/retile-cleanup/`, remote service
`hoster-warp-gui-20261025-retile-cleanup` (exit 0). Plasma 6 remains a native acceptance gap.


### Tray lifecycle acceptance

Add `--tray` to a private `nested.sh --gui` run. It requires the distro's
`python3-gi` package. `tray_host.py` supplies a minimal StatusNotifierWatcher on
that private session bus because a standalone compositor has no Plasma panel.
The app still exports its real tray item and menu. Discovery verifies the
service PID, executable and ancestry to the fixture WebDriver process.

The test invokes the exported Open/Pause/Quit menu items, closes the focused
editor using Alt+F4, checks second-instance reopening, then verifies app/bus
disappearance and KWin script removal before fallback teardown. It does not
claim physical panel rendering or a reaped application exit code.

Portafort's `portafort-warp-gui-20261025-tray-host` passes 21 checks, including
six lifecycle checks. Local receipts: `src-tauri/target/kde-validation/tray-host/`.
The Plasma5 GUI Dockerfile now declares python3-gi; rebuild that image before
using this option if it predates the dependency addition.

### Plasma 6 runtime

`Dockerfile.plasma6` uses Debian trixie's native Qt6/KWin packages and the same
Ubuntu24.04-built application. Build it with a Dockerfile-only context:

```sh
docker build -t window-warp-plasma6:local - < tests/kde/Dockerfile.plasma6
docker run --rm --init --network=none --cpus=2 --memory=3g --shm-size=256m \
  --mount type=bind,source="$PWD",target=/work window-warp-plasma6:local
```

This image has private compositor/bus/runtime paths and no host display access.
Its qdbus and kbuildsycoca aliases adapt the test scripts to Qt6 tools; they do
not change the application's platform detection. An image build is not a native
Plasma6 acceptance result. See PARITY.md for the current runtime evidence.
