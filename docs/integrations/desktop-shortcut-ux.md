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

KDE quick-popup E2E for `11168df` is deferred: Portafort's private compositor
harness is available, but the checked host had no matching Linux build, Cargo,
or WebKitWebDriver. The installed app predates this change. Run the isolated
`--quick-gui` harness once those prerequisites are available; no live KDE
session or system packages were changed during this check.

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

## Branding and release preparation, 2026-10-28

- The user selected the ivory and cyan portal logo, requested a wide README
  banner, a Window Warp repository name, and a Windows/KDE release.
- Feature base: `6cd6da003b0896c11f7b7e125686ee5db6733b1e` on
  `codex/desktop-shortcut-ux`. Intended stable target: `origin/main`, observed
  at `bd6f2039e86e7a3cf22394b0d552156b2c38d7e1`. The histories diverge at
  `d9f24c8`; a non-committing merge check reports conflicts in the two Windows
  hook/gesture files, requiring review and retesting.
- Branding changes update the packaged and tray icons, README banner and install
  documentation. Version 0.1.1 is prepared because 0.1.0 is already published.
- The Windows JavaScript checks and tests passed. Windows Rust tests passed 111
  with six ignored outside the sandbox; sandboxed CIM and lock tests failed.
  The 0.1.1 Windows NSIS installer built. A fresh KDE package build and the
  pending native Windows and KDE acceptance checks are not yet release receipts.
- The original checkout has inaccessible OneDrive Git objects. A complete branch
  history was exported using a separate clone's remote objects and this branch's
  local objects, then imported into the separate review clone. The original
  working tree and active app remain intact.
- Next: complete native input and popup verification, reconcile and independently
  review the merge, verify both packages, then publish and verify the requested
  release and repository rename. Do not call the release verified while the red
  tests and KDE acceptance gaps recorded above remain unresolved.

### Merge-candidate checkpoint

- The branding checkpoint is `f170540` on `codex/desktop-shortcut-ux` in the
  isolated review clone. `origin/main` at `bd6f203` is merged into this feature
  candidate for review, not promoted to main. Its hook conflicts retain the
  independently reviewed feature versions, formatted by rustfmt. The default
  pause binding remains covered by the reassignment regression test.
- Merged-tree validation: 160 JavaScript tests pass; Windows Rust has 111 passes
  and six opt-in tests ignored, outside the sandbox; `cargo fmt --check` passes.
  Current Windows fixture receipts: `WARP-NATIVE-bf90d9ec-e99d-452e-bc6e-7c3148da8cef`
  (`--hook-only`, failed: observer misses events and second Win+B times out),
  `WARP-NATIVE-310984dd-2383-4658-9323-185dfe00c302` (`--fast-only`, ten
  single taps pass but four alternating sequences fail with focus denial), and
  `WARP-NATIVE-a1b10b81-cee5-46c0-a03c-04353b2dc713` (`--quick-only`, eight
  pass and a no-mouse click-away case skipped because focus was denied).
- A fresh feature-tree KDE build passes 160 JavaScript tests, 92 Rust tests
  with one ignored, and two private-compositor quick-popup checks. The preview
  Debian package includes the new icon and companion for KWin
  `4:5.27.11-0ubuntu3`; rebuild from the final merged tree before publication.
- The user's live shortcuts were restored to active after the isolated Windows
  tests. Hoster's credentials lack write access; the user's Windows Git credential
  manager was subsequently verified as `Ryushe` with repository admin and push.
  GitHub repository `Ryushe/windows_warp` was renamed to `Ryushe/window-warp`.
- Next: investigate and resolve the two failing Windows fixture suites, rerun
  native verification against the reconciled candidate, rebuild both installers
  from the exact final revision, then complete the requested merge and 0.1.1
  publication using the verified Windows credentials.

### Focus diagnostic follow-up

- Candidate checkpoint: `168bae7` on `codex/desktop-shortcut-ux` in the isolated
  review clone. An opt-in focus diagnostic used a separate source snapshot and
  fixture target, with the regular app paused. In
  `WARP-NATIVE-687700b9-1e51-4735-ab92-b1203e2b0ba7`, Windows denied all 16
  `SetForegroundWindow` calls aimed at the other fixture process, while 30 calls
  aimed at the foreground fixture's process succeeded. This does not establish
  the root cause or justify a foreground workaround.
- A separate hook-only diagnostic did not reach its input tests: its WebView did
  not become available within 45 seconds. It produced no hook trace. Both
  diagnostic apps exited, and the user's live shortcuts were restored to active.
  Continue by diagnosing that startup failure and the foreground-policy result;
  do not count either diagnostic as a release pass.

- A no-input retry established the startup timeout was sandbox loopback denial:
  outside the sandbox the diagnostic WebView appeared successfully. The later
  native-access hook trace (`WARP-NATIVE-93ba37c6-cdff-425d-bb1d-f0ee8c054a15`)
  reproduced the failing fixture. The first Win+B reached the hook and opened
  the popup; the second tagged Win/B events did not appear in the hook trace,
  and the popup lost focus and closed. Missing F23 observer events likewise did
  not appear in Warp's hook trace, though the registered F23 hotkey fired. The
  user's paused app retained its pause-only hook, so another consumer cannot be
  ruled out. User shortcuts were restored after cleanup. Diagnose upstream
  delivery/focus with the regular app fully absent before altering the hook;
  physical-input behavior and the root cause remain unresolved.

- The earlier startup-only diagnostic left an owned test process behind, which
  was identified and stopped. Its window overlapped the `93ba37c6` run; it was
  not shown to have registered a hook. A subsequent clean run with the regular
  app and orphan fully absent (`WARP-NATIVE-c1bd8330-9054-4a4c-b2f7-0a73bea94c29`)
  still failed: the first Win+B opened the popup and the second tagged chord was
  not seen before focus loss. The test fixture's unconditional `ShowWindow` and
  focus fallback are a concrete hypothesis for that loss, not a proven cause.
  The user's app was restarted and its shortcuts restored to active.

- Fixture-only popup experiment `WARP-NATIVE-5c8649a6-03bf-48fd-b60d-695062f2c94c`
  removed the second press's focus and window-restoration operations; the
  second tagged chord was still absent from the hook and the popup then blurred.
  This rules out those specific fixture actions, not the entire fixture.
- Separate paired input-queue attachment prototype
  `WARP-NATIVE-7552beee-a8ce-4d2b-b49f-a560afcd930b` improved cross-process
  activation: eight alternating targets activated in order at 80 ms spacing.
  Zero-spacing order also matched, but the latency limit failed at roughly
  930 ms and one focus-denied error remained. No prototype code was promoted.
  Assess the latency, modifier state, hung-window behavior, and Wispr coexistence
  before considering a fix. The user's regular app was restarted and activated.

### October 28 release verification

- Candidate revision `425056611373bcb16db7ca2d25737078d148a95b` produced a Windows NSIS installer and a KDE Debian package; neither was published. The Debian artifact has SHA-256 `658eeda311a4669f9e15849b6f6ebbaa441782613dcb807a6e86c13f9513568d` and requires Ubuntu/Kubuntu 24.04 amd64 with KWin `4:5.27.11-0ubuntu3`. Against its exact packaged companion, 31 native protocol checks passed. Two KDE quick-popup tests also passed; the GUI lifecycle result is recorded below.
- A corrected single foreground observer confirmed actual focus-denied responses in the rapid synthetic Windows test, while exposing invalid latency pairing in the old per-window activation observer. An independently run minimal AutoHotkey comparison also missed completions under the same burst-style injected input. Neither observation establishes physical-key behavior. The user's earlier hands-on test reported Win+B, rapid switching and Wispr working.
- Normal-desktop hook diagnostic `WARP-NATIVE-bbcd16a3-6dba-47b0-86dd-df84baccc761` showed the focused-editor injected-key observation failing when a test observer was older than Warp's hook, but passing when the observer was installed after Warp's hook; both surrounding non-editor controls passed. Warp's callback was not entered for missing events, and recording was off at sampled boundaries. The root cause is unresolved. Never add a second production hook to work around this test.
- The regular user application was restored with shortcuts active. Promotion remains blocked on credible Windows rapid-switch/coexistence E2E results; do not treat synthetic observation gaps as proof of product failure or silently waive those checks.
- Corrected candidate test `WARP-NATIVE-cdda5c86-2b54-4df6-b438-ce81d6e07693` passed its single-tap/hold/minimize/pause checks but failed all four alternating-switch sequences with 16 explicit focus-denied errors and only 4–5 observed transitions per sequence. The corrected observer leaves latency unattributed for incomplete or reordered sequences and preserves the 500 ms and ordering requirements. It was independently reviewed; `npm test` passed 161/161. This does not establish a physical-input failure.
- KDE follow-up: 22 full-app private-compositor checks passed against candidate `4250566` with the packaged KWin 5.27.11 companion, including current-app F12/Enter quick-popup persistence, shortcut hold/reassignment, companion loss and recovery, and workspace checks. Receipt on Hoster: `target/kde-validation/companion-final-4250566/gui-result.json`, unit `hoster-warp-kde-companion-final-4250566-20261028`. The shipped module also passed 31 native protocol checks. The subsequent GUI changes update test automation only.
- Further review of `cdda5c86` identifies an unresolved injector/ownership confound: the SendInput process owns the source and target A, while target B is a separate process. At 80 ms intervals, observed foreground events alternate A and source; B is never observed. This does not prove the injector caused the 16 focus denials. Next discriminating run should record each action's target HWND/PID, foreground HWND/PID, input time and focus return while comparing synthetic and physical chords. Retain the exact ordering, focus-error and 500 ms gates.

### Foreground permission investigation

- Independent Astra review identified that the earlier minimal AutoHotkey comparison was not a fair control: its default per-hotkey thread limit and long, nested activation handlers can drop repeated inputs. Its failure must not be used as evidence that the Warp synthetic burst should fail.
- In `WARP-NATIVE-ae8eeac0-f0c9-4c47-a8ad-fd4dfce09484`, reversing fixture injector ownership and swapping target keys produced 32/32 successful focus calls to the foreground source process and 32/32 denied calls to the other process. `WARP-NATIVE-6ee99dfe-5cf4-4991-a669-8e97da913ace` decoupled injection from source via a windowless third process and reproduced the same foreground-owner pattern.
- Causal control `WARP-NATIVE-ffb2ee85-8d67-455d-ac18-c9c2bed8a79b`: after the same fully injected shortcut, hold the isolated action worker; without a foreground grant Windows denied the target; after the test source granted the exact Warp process permission, the same target succeeded and became foreground. This proves missing foreground permission caused the controlled test denial, but does not establish a production fix or physical-key failure. The diagnostic includes a deliberate worker delay and is not a responsiveness result. No grant from unrelated apps may be assumed in production.
- The earlier hook delivery gap remains separate. Astra recommends a bounded heartbeat on the existing hook message loop during the missing-event observation; do not install another hook or alter chord decisions without evidence. The user's Warp was restored active after all tests.

### Hook-delivery and timing follow-up

- Test-only hook pump receipt `WARP-NATIVE-43cf7140-977a-44d8-9889-db7bc07f7f2d` reproduced missing injected editor events while all 45 active-hook-thread heartbeat samples were acknowledged; in failing rows, acknowledgements were about 1–1.5 ms and callback entry counts remained unchanged. This argues against sustained hook message-loop blockage, but does not explain the delivery gap.
- Conditional direct-QPC timing receipt `WARP-NATIVE-2285cbdd-394d-49fd-a657-a39d0323fc45` recorded eight target foreground observations in order for each of four cases without errors. At 80 ms spacing, explicit per-press foreground grants yielded conservative 22.8–62.2 ms release-to-observation bounds. Zero-spacing grant continuity was not verified. This does not establish behavior without cooperative grants; the ungranted test remains red.
- `WARP-NATIVE-68c0b13e-df22-4155-98af-2dbea34daa5f` reproduced the editor gap using three injection transports, including a separate windowless process and a path with redundant focus calls removed. Disabled controls and a later test-only pass-through listener saw the events. No production hook change is justified by these synthetic results; further distinguish a same-process native window from WebView focus.
