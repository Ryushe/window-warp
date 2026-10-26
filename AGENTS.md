# Window Warp agent notes

The Windows hook is currently inconsistent. Read `desktop/HOOK-HANDOFF.md`
before editing keyboard, popup, retile, or radial-hold code.

## One keyboard hook

Windows input for this app goes through the single low-level hook in
`desktop/src-tauri/src/windows_reserved.rs`.

Do not install another `SetWindowsHookExW` for shortcuts, recording, retile,
or the radial hold. A second hook runs first and lets Windows see Win chords
before Warp can swallow them.

That hook remembers which keys and modifiers are down from the events it
sees. Do not decide a Win chord with `GetAsyncKeyState` alone. Swallowing a
key makes that API miss it, and the chord then falls through to Windows.

Use the same hook for:

- active shortcuts
- recording a shortcut, including Win chords
- the second Win+B that opens the main window while the popup is up
- the one-second X/C retile (`retile::fire`)
- hold and radial state (`vk_down` / `super_down`)

While a shortcut is being recorded, swallow the whole chord. Do not run the
shortcut's normal action, and do not pass it to Windows. The one exception is
the open-editor chord (Win+B by default): a second press closes the popup and
opens the main window.
