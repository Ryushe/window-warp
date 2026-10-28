# Desktop shortcut UX integration dossier

- **Status:** feature, verification incomplete
- **Owner:** Codex
- **Branch:** `codex/desktop-shortcut-ux`
- **Base commit:** `d9f24c8`
- **Intended integration target:** `main` (remote tip and integration direction still need reconciliation)
- **Last updated:** 2026-10-28
- **Owning feature branch/ref:** `codex/desktop-shortcut-ux`
- **Latest immutable recovery checkpoint:** `9b10b1d`
- **Feature implementation commit(s):** `10f5479`
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

## Interruption / resume handoff

- **Owning feature branch/ref:** `codex/desktop-shortcut-ux`
- **Latest immutable recovery checkpoint:** `9b10b1d`
- **Feature implementation commit(s):** `10f5479`
- **Exact resume point:** run the physical Windows and live KDE checks above,
  diagnose full-suite failures, and review before integration or activation.
- **Working-tree state at handoff:** intended clean checkpoint

## Decision gates

- **Integration:** passing relevant tests, reconciled target, independent review.
- **Activation:** physical Windows and live KDE acceptance; migration/rollback review.
- **Promotion:** explicit stable promotion after integration and release verification.

## Decision record

- 2026-10-28 — selected key-first popup and conservative open-window discovery.
