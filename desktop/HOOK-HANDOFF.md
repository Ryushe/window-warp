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
that key can turn shortcuts back on. Every other Windows hotkey is
returned.

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
