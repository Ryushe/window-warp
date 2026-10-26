# Window Warp to-do

## Preview video

Record a short preview for the README and the GitHub release. Show a push
across monitors, the one-second X/C tile, the radial picker, and opening a
workspace. Keep it silent or lightly captioned, and do not include private
window titles.

## Settings section

Done: Settings is a button on the left, next to Shortcuts and Workspaces.
Updates still belong at the top of that page once an updater exists.

## Updates

Put an Updates block at the top of that settings section.

- Show the version that is actually running.
- **Check for updates** looks for a newer published installer. It does not
  download until asked.
- **Install and restart** downloads that installer, quits Window Warp, replaces
  the per-user install, and starts it again. Saved settings stay.
- The first build that contains the updater still has to be installed by hand.
  After that, this button is how later versions get on the machine.

There is nothing to check yet. The only Windows installer is
`Window Warp_0.1.0_x64-setup.exe`, and the app does not publish a newer one.

## Keyboard hook

The popup now uses one hook and shows the same Super binding as the list.
Recording, the second Win+B, and hold-to-radial still need a physical
keyboard. SendInput drops the key-up after a swallowed key-down.
Read `desktop/HOOK-HANDOFF.md` before changing hook code. Do not add another
low-level hook.

## Win-key hook is not in the installed app

The hook fix is in the working tree and in the debug build. It is not in the
0.1.0 installer. Reinstalling that setup leaves the old hook in place, so
Windows still takes Win chords. Shipping a new installer comes before the
update button can deliver this fix.
