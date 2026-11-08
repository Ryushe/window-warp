# Keyboard hook

One low-level hook, in `desktop/src-tauri/src/windows_reserved.rs`.
Do not add another `SetWindowsHookExW`. Retile calls `retile::fire` from
that hook. `windows_retile.rs` does not install one.

The hook remembers key-down and key-up. Hold, radial, and "is Win down"
read that state. `GetAsyncKeyState` misses a key after it has been
swallowed, so it must not decide a Win chord.

Recording swallows the chord, including Win, and does not run the
shortcut's normal action. That includes a chord this app already uses:
the box gets the key, and the old action does not run. The open-editor
chord is the exception only while the popup itself is open: a second
press closes it and shows the main window. Do not uninstall and reinstall
the hook to get in front of PowerToys. That drops the key-up, and the
next press is ignored. Pausing leaves only the pause chord installed, so
that key can turn shortcuts back on. Every other Windows hotkey is returned.

Opening the quick popup does not start global recording. Its focused picker
accepts ordinary keys and uses the configured default modifier for a new
shortcut. Explicit recording requests still use the hook and keep the
recording rules above. Verify the popup and second open-editor press with a
physical keyboard before treating this behavior as accepted.

The popup is the `quick` window. It has to stay in
`desktop/src-tauri/capabilities/default.json` with `main` and `radial`.
Without that, the page cannot read the binding or hear `quick-edit`,
and the shortcut box stays empty. The binding it shows is
`app_binding_index` in `app_actions.rs`, the same `window_match` the
shortcut uses. The label is the app name. The word in the box is Super,
not Win.

Clicking outside, Cancel, and Escape close the popup only. A focus loss
while recording, with no mouse button down, is Win releasing — keep the
popup and keep recording.

## Checked from this machine

SendInput can open the popup on Discord and the box shows `Super+D`.
It does not prove recording, the second Win+B, or hold-to-radial.
Injected key-ups are dropped after a swallowed key-down, so a later
chord looks like it never happened. Those three still need a physical
keyboard: Discord focused, Win+X fills the box and does not open the
Win+X menu, Win+B again focuses the main window, and holding an app
shortcut opens the radial picker.

The debug build is `desktop/src-tauri/target/debug/window-warp.exe`.
The installed 0.1.0 app does not contain this hook.

## 0.1.2 shortcut investigation

The hook now stays active while shortcuts are enabled even if no binding uses
Super, since registered app holds and X/C retile also need its state. Registered
app holds finish when any required modifier or the main key is released. The
isolated desktop run `WARP-NATIVE-a768e585-8c51-4367-a362-168e99164869` passed
modifier-first and key-first taps, a timed hold, and cancellation across pause.

When the editor is focused, injected input can reach a registered non-Super
shortcut without its key-down reaching the hook. The non-Super registered path
now falls back to Windows key state only when the hook did not observe that
chord; it never uses that state for a Super chord. The editor-focused hold,
both release orders, and pause cancellation passed in
`WARP-NATIVE-755740ed-d8c8-49c8-9f38-54f9aab93698`. The complete desktop
acceptance passed in `WARP-NATIVE-0ec53244-d3f0-41c2-b061-d2dc071e5674`.
Escape now dismisses the non-focusable Windows radial through the shared hook.

Physical-keyboard verification remains necessary for the Win-key coexistence
and second Win+B cases: the injected-input test
`WARP-NATIVE-d22d1f00-268c-44f2-bb1a-25dafcbdfe12` still failed when the
editor was focused. Its trace showed that unowned chords reached the hook and
were passed onward in other focus cases. Do not replace Win-key tracking with
`GetAsyncKeyState` or add a second application hook.

Rapid alternating shortcuts also failed with Windows rejecting foreground
changes in `WARP-NATIVE-1389d2b2-24f2-40ed-8913-c45270027fa5`; an input-queue
attachment retry was tested and reverted after it did not fix the failure.

## Chooser shortcut conflict

A temporary attempt to capture chooser keys with the shared hook did not stop
AMD Software from opening on the user's physical Alt+R press. In an isolated
fixture, a competing registered Alt+A also fired when injected input targeted
the editor, and the hook did not receive that input. The experimental capture
was removed. The result does not establish how AMD handles its shortcut; do
not assume reordering hooks will safely solve the conflict.
