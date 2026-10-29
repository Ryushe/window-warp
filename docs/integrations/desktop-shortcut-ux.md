# Desktop shortcut UX integration dossier

- **Status:** feature and Windows hook experiment, verification incomplete; user requested the current build for local use
- **Owner:** Codex
- **Branch:** `codex/desktop-shortcut-ux`
- **Base commit:** `d9f24c8`
- **Intended integration target:** `main` (remote tip and integration direction still need reconciliation)
- **Last updated:** 2026-10-28
- **Owning feature branch/ref:** `codex/desktop-shortcut-ux`
- **Latest immutable recovery checkpoint:** `11168df`
- **Feature implementation commit(s):** `10f5479`; unverified hook investigations `dd8f56c` and `298fd63`; popup follow-up `11168df`
- **Inspiration / canonical references:** user-requested keyboard-first popup and cross-platform window-name discovery; `desktop/HOOK-HANDOFF.md`

## Intent and implemented contract

Create popup shortcuts with an ordinary key and a configurable default modifier,
without automatically entering the Windows hook's recording mode. Existing
bindings retain their modifiers. Conflicts require a visible replacement choice;
displaced bindings remain disabled with their settings intact. Explicit recording
still uses the existing single Windows hook.

Find open apps adds unambiguous identifiers to an unsaved draft and reports
missing or ambiguous matches. Bindings can hold additional identifiers; KDE
uses those identifiers even when a preserved Windows selector exists, while
Windows keeps the selector authoritative. Discovery only sees currently open
windows and matches names conservatively; it is not a full app inventory.

## Evidence and review

- `npm run check` and `npm test`: 142 JavaScript and simulated KWin/editor
  checks passed.
- `cargo test --manifest-path desktop/src-tauri/Cargo.toml window_match::tests`
  and `radial::tests`: focused Windows Rust tests.
- Full Rust suite with normal process access: 91 passed, six native tests
  ignored. A reassignment fixture was corrected to include the default pause
  shortcut as a third conflict. Firefox Restart Manager and CIM tests pass with
  normal process access. The radial test regression found during development
  was fixed.
- Portafort reachable through Hoster's Tailscale address. Installed
  `/usr/bin/window-warp` is running; KWin reports `window-warp-session` loaded.
  The journal does not establish the cause of launch-time status flicker.
- Windows `node desktop/tests/windows/native.mjs --quick-only` passed using
  isolated settings, owned windows and injected OS keys with AutoHotkey running.
  It verified an immediate key-and-Enter save, conflict replacement, discovery
  persistence and release on exit. Receipt:
  `src-tauri/target/windows-validation/WARP-NATIVE-bd449b09-fe9a-4533-9350-ea78e132c46c/result.json`.
  An intermediate run failed when its test attempted to reopen before the
  first popup closed; the passing run waits for the popup to close first.
- The private KDE compositor `--quick-gui` fixture passed the real popup's
  plain-key/Enter conflict replacement and discovery persistence. Receipt:
  `src-tauri/target/kde-validation/quick-e2e-20261028/quick-result.json`.
- No independent review or physical keyboard acceptance yet. The focused native
  tests inject input and do not replace physical keyboard or broad-suite checks.

## Blockers and deferred work

- Run physical Windows acceptance with AutoHotkey and other shortcuts in the
  intended launch order: open popup, type an ordinary key, save, replace a
  conflict, use the second open-editor chord, and verify other app shortcuts.
  The current automated input fixture is not proof of physical-key coexistence.
- Run the equivalent popup, discovery and app matching checks in the real
  Portafort KDE session. Reproduce startup flicker while observing KWin
  registrations; saving currently disables and re-enables shortcuts, but that
  is not evidence for the launch symptom.
- Reconcile the current remote `main` tip before integration; the earlier fetch
  failed with an `mmap` error.
- The new settings fields are rejected by older versions that deny unknown
  fields. Check upgrade and rollback behavior before installing this build over
  a user's existing configuration.

## Windows hook investigation, 2026-10-28

### Popup replacement and click-away follow-up

The quick popup now presents a separate in-window conflict dialog with Replace,
Replace and edit old, and Keep existing. Replacing keeps the displaced binding
disabled with its existing settings; when another enabled binding owns its key,
the quick editor displays the displaced key as unassigned. Editing it uses the
validated reassignment proposal so a newly assigned key re-enables the binding.
Unclaimed, deliberately disabled shortcuts retain their displayed key. A
non-app action is edited by its existing binding index without changing its
action or app-related settings. Delayed previews, saves and click-away events
are guarded so they do not apply stale choices or revive an old popup.

The quick window closes on an outside click, including while recording. A
temporary Windows mouse-state watcher handles outside clicks while a preserved
Win-related blur leaves the popup unfocused; it adds no keyboard hook and
records no input. It polls at 10 ms, so a complete click between polls can be
missed. The no-mouse focus transition into this watcher remains unverified in
native E2E because Windows denied the isolated fixture's synthetic focus
change; test it physically before treating all click-away paths as proven.

Validation: `npm test` passed 160 tests, the full normal-access Windows Rust
suite passed 111 with six ignored, and isolated `--quick-only` E2E receipt
`WARP-NATIVE-8d56f259-957d-4e1b-9864-b7b6f16d0e06` passed replacement,
reopening/reassigning the displaced action, Replace and edit old, ordinary
click-away and focused-recording click-away. That run used a temporary
aggregate hook-state diagnostic, removed afterward; it explicitly skipped the
already-unfocused watcher path. The dialog screenshot was visually reviewed.
The existing Win+B and cross-process focus/coexistence limitations below remain
open and are not resolved by this popup work.

For local use, the updated normal Windows build from `11168df` was started
from `desktop/src-tauri/target/popup-runtime/window-warp.exe` with the user's
regular settings; the previous native instance was stopped first. The UI showed
shortcuts active, and only one Warp process was observed. This is a local debug
activation, not a packaged release or evidence that the skipped watcher path
or older Win+B/coexistence issues are fixed.

The pre-experiment build swallows Win while an active Super shortcut
exists and replays unclaimed chords on release. That can disrupt other apps'
hold-to-talk shortcuts. The experimental single-hook change passes unclaimed
keys through immediately and masks the Start menu with a tagged injected event.
It is a candidate, not a proven AutoHotkey-equivalent or release-ready fix.
The popup also has a DOM fallback for its configured open-editor chord, but it
only works when the WebView actually receives that chord.

- `npm test`: 143 passed. `cargo test --manifest-path
  desktop/src-tauri/Cargo.toml platform::reserved::tests`: 4 passed.
- `node desktop/tests/windows/native.mjs --hook-only` with
  `WARP_TEST_CARGO_TARGET_DIR` pointing to an isolated target: unowned Win+F23
  reached a fixture application's registered hotkey while held; the second
  Win+B did not open the editor. This test remains **failing**. The focused
  popup only received Meta, and a temporary hook trace saw the first chord
  finish but no callback for the subsequent chord. The trace does not establish
  the cause, and an experimental focus-loss change was reverted.
- The running user's original app was not replaced; shortcuts were restored to
  active after testing. Wispr coexistence and physical input remain unverified.

### Follow-up: rapid switching and physical acceptance, 2026-10-28

The experimental hook tracks independent app-gesture presses, commits actions
in release/hold order, forwards unowned Win chords without replaying them,
and keeps a single production `SetWindowsHookExW` in `windows_reserved.rs`.
Popup work queues overlapping editor requests and loads the configured editor
chord even for unnamed windows or delayed config responses. A committed hold
cannot silently become a tap while it waits for an earlier action.

- The user tested the isolated candidate with a copy of their settings, while
  their AutoHotkey Warp was stopped and Wispr was already running. They reported
  that repeated Wispr use, rapid switching between their normal shortcuts, and
  Win+B twice all worked. This is one physical session, not proof of all launch
  orders or indefinite reliability. The candidate was shut down, its settings
  copy deleted, and the original AutoHotkey Warp script was restored.
- `npm run check` and `npm test`: 149 JavaScript tests passed. The normal-access
  Rust suite passed 106 tests with six ignored after the owned-modal adjustment.
- `node desktop/tests/windows/ahk-focus.mjs` passed eight alternating
  `WinActivate` / `WinWaitActive` calls in both default and no-delay modes,
  targeting only owned windows. It installs no hook or hotkey and sends no
  keys; it does not compare hotkey responsiveness or Wispr compatibility.
- The native fixture at `desktop/tests/windows/native.mjs --fast-only` now
  alternates two distinct app shortcuts between windows in separate fixture
  processes, at 80 ms and zero spacing, with Win held and released. The last
  run (`WARP-NATIVE-6410cdc9-41f6-4a01-b7b6-e8a15a4ad775`) failed: all
  fixture-tagged chords reached the hook in the preceding trace run, but the
  monitored sequence emitted 16 Windows focus-denied errors. A retry using
  `AttachThreadInput` failed the same tests and was removed. Independent
  `WM_ACTIVATE` callbacks can arrive out of order, so the fixture's exact
  cross-process order and latency measurements need a better observer; the
  focus errors remain separate evidence. Physical and injected input may have
  different foreground-permission contexts; the cause has not been established.
- `--hook-only` remains red: the earlier listener misses the fixture's injected
  Win+F23 events with Warp's editor focused and its hook enabled. A temporary
  tagged-event bypass showed the affected input did not reach Warp's callback;
  the diagnostic and bypass were removed. This is not a physical Wispr test.
- Owned-modal foreground acceptance has a focused unit test, but no native
  modal acceptance yet. The strict repeat guard can miss the next press after
  a swallowed key-up is lost; investigate recovery without mistaking hardware
  repeats or violating the hook-maintained modifier-state rule. Review also
  noted short mutex acquisitions on the hook thread and the late-dispatch hold
  edge; neither should be described as resolved.

On 2026-10-28 the user explicitly requested running this candidate in place of
AutoHotkey. The verified AutoHotkey Warp script was stopped; the later popup
build activation is recorded above. This local activation does not resolve the
test failures or authorize integration. Investigate the focus-denied and
coexistence failures, verify owned-modal and repeat paths, and test Wispr in the
opposite launch order. Use isolated settings for further tests and coordinate
around the active app.

Resume by reproducing the red `--hook-only` test with the live app's shortcuts
paused, using an isolated Cargo target. Investigate missing hook callbacks and
popup focus without introducing another hook; prove configured-chord behavior,
start-menu suppression and recording, then test physical Win+Alt and Wispr in
both launch orders. Restore the user's shortcut state after each session.
Do not integrate or activate the candidate until these checks pass.

## Interruption / resume handoff

- **Owning feature branch/ref:** `codex/desktop-shortcut-ux`
- **Latest immutable recovery checkpoint:** `11168df`
- **Feature implementation commit(s):** `10f5479`; unverified hook investigations `dd8f56c` and `298fd63`; popup follow-up `11168df`
- **Exact resume point:** investigate the failing cross-process focus and
  `--hook-only` coexistence fixtures, then run the remaining physical and native
  acceptance checks above before integration or activation.
- **Working-tree state at handoff:** implementation and test checkpoint committed;
  the subsequent dossier-only commit records its immutable SHA

## Decision gates

- **Integration:** passing relevant tests, reconciled target, independent review.
- **Activation:** physical Windows and live KDE acceptance; migration/rollback review.
- **Promotion:** explicit stable promotion after integration and release verification.

## Decision record

- 2026-10-28 — selected key-first popup and conservative open-window discovery.
