# Windows still takes priority

Noted from the installed app, before any Settings tab or updater work.

When Window Warp shortcuts are enabled, Windows still handles the Win chords.
The emoji picker, Explorer, and the other shell shortcuts keep firing. Warp does
not override them. Pausing is supposed to give those keys back to Windows, but
the override while Warp is on is not happening.

The hook was installed, and it did see Win+E (`GetAsyncKeyState` reported the
Windows key down on the letter). It then called `SendInput` to mask the Start
menu while still holding `SESSION`. `SendInput` runs the low-level hook again
on that same thread before it returns. `SESSION` is not reentrant, so the nested
call never returned. Windows stopped using the hook and handled the chord.

A same-thread probe on this PC showed the nested call with the lock still held,
and that delayed hook opened Explorer. Returning from the letter immediately,
without taking the lock again, did not.

The hook now treats nested `SendInput` as pass-through and drops `SESSION`
before the Start-menu mask. A debug build on this PC swallowed Win+E and Win+X
before the next hook, and pausing let Win+E through again. Checked after the reinstall on this PC, with AutoHotkey not running. Start
Menu **Window Warp** points at `AppData\Local\Window Warp\window-warp.exe`,
file version 0.1.0, last written 2026-10-25 16:14:52. That is the same 0.1.0
setup built at 16:14, before the hook fix. There is no newer installer. The
separate Startup shortcut **Windows Warp** launches `Windows Warp.ahk`, not
this app.

On that installed exe, Win+E stalled the hook for about three seconds and the
key still reached the next hook. Pause then never returned, because it waits
on the same lock the stuck hook is holding. That is why the button does
nothing until the process is killed. The debug build with the fix paused in
one click.
