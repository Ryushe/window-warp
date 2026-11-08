# Window Warp to-do

## Release verification gaps

- Workspace associations still need a general identity check when a saved app,
  terminal, or browser profile changes. Firefox windows are now excluded when
  a Windows explicit profile path or an owned lock proves a different directory, but an
  unavailable identity remains eligible; Chromium and terminal changes are
  not covered by that check. Do not assume unrelated windows can never move.
- Browser-extension snapshots with missing profile identity can still be
  matched from window titles and geometry. Test identical windows in multiple
  profiles, including an unconfigured extension, and preserve saved URLs when
  the source cannot be established.
- Validate the Store MSIX on clean Windows 10 and 11, including WebView2
  availability, actual sign-in startup, and upgrade. The existing Run entry
  uses the executable path, which may change between MSIX versions.
- The current CI workflow does not publish the requested packages. The
  checkout passes `cargo fmt --check` after release formatting.
- A combined Firefox, hold, radial, and Konsole KDE run once failed to capture
  its owned Konsole shell. A separate Konsole run and a later combined run of
  the final package passed; monitor for a repeat of the intermittent failure.
- The Firefox release tool `web-ext` 10.8.0 currently pulls `deepmerge` with a
  low-severity development-dependency advisory (GHSA-gcqx-w48m-w2h4). Recheck
  for an upstream fix when updating the publishing tool; it is not shipped in
  the extension or desktop app.

## Browser tab and workspace sync

- Give repeated copies of the same saved browser distinct stable workspace
  identities so live sync can identify each one without guessing. Until then,
  use Sync elsewhere to choose the intended window for a one-time update.
- Explore optional shared sync between a saved browser tab set and its copy in
  a workspace, so tab changes can update both. Decide how the two are linked,
  how conflicting edits are resolved, and how live updates and unlinking work
  before implementing it.

## Browser extension scale

- Measure popup loading, search, and opening large saved libraries. Consider
  paging or virtualized rows if needed, while preserving keyboard navigation,
  useful progress, and the existing tab-sharing privacy behavior.

## More than two monitors

- Extend the main/burner two-monitor workflow to support three or more displays
  on Windows and KDE. Let users choose destinations and workspace display
  mappings, and preserve sensible placement when displays are disconnected or
  rearranged. Verify mixed-DPI and different monitor layouts without breaking
  existing one- and two-monitor setups.

## Terminal and WSL workspaces

- Identify the running terminal application and shell automatically when the
  evidence is reliable, including standalone PowerShell, Windows Terminal,
  Konsole, and WSL. Preserve the terminal profile, WSL distribution and user,
  and directory when known; let the user correct uncertain details. Test
  multiple tabs, nested shells, and directories changed after launch.
- Reuse a matching terminal window when it is still running. Explore an
  optional way to reconnect SSH and reattach an existing remote tmux or screen
  session, with normal authentication and host verification. A closed session
  cannot generally be reconstructed from its title; do not silently replay
  commands or capture secrets.

## Workspaces across Windows and Linux

- Explore portable workspaces with per-machine mappings for applications,
  terminal and browser profiles, paths, desktops, and displays. Show missing or
  ambiguous mappings so the user can resolve them. Windows, WSL, and remote
  Linux paths are not interchangeable.
- Allow a portable workspace to choose each system's default terminal or a
  reviewed per-system terminal mapping. The user deferred the transfer method
  (such as export/import or a shared folder) for a later design.
- On Windows, investigate current-desktop detection when a window reported on
  the current desktop has an ID missing from Explorer's stored desktop list.
  This can prevent bringing Warp to the current desktop. Account for pinned
  windows before trusting an unlisted ID, and add a native regression test.
  The live desktop-manager path and a cross-desktop native test passed on
  Windows 11 25H2; the fallback case remains unverified.

## Preview video

Record a short preview for the README and the GitHub release. Show a push
across monitors, the one-second X/C tile, the radial picker, and opening a
workspace. Keep it silent or lightly captioned, and do not include private
window titles.

## Radial picker styles and live preview

Optional: a short warp animation when a window is pushed, pulled, or tiled.

The radial picker should have more than one look, and the look should follow
the theme that is on. Settings gets a radial style choice so the user can
pick which selector they want.

While a slice is highlighted, and before the key is released, make every
other window transparent and leave the highlighted window visible. The user
can see which window that slice is without guessing. Releasing the key brings
that window over and restores the others. Moving to another slice, or
canceling, restores transparency immediately.

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

The popup uses one hook and shows the same Super binding as the list. On
2026-11-06, a physical-keyboard test in an isolated Windows 11 preview passed
four successive Win+B presses, Win+Y, recording Win+X, and a radial hold.
An earlier attempt intermittently fell through to Windows while multiple Warp
instances were running; this short successful retry does not establish the
cause or rule out an intermittent failure. SendInput drops the key-up after a
swallowed key-down. Read `desktop/HOOK-HANDOFF.md` before changing hook code;
do not add another low-level hook.

- Continue testing shortcuts with Warp and other applications focused,
  especially rapid presses, pause/resume, saved bindings, and normal typing.

## Win-key hook is not in the installed app

The hook fix is in the working tree and in the debug build. It is not in the
0.1.0 installer. Reinstalling that setup leaves the old hook in place, so
Windows still takes Win chords. Shipping a new installer comes before the
update button can deliver this fix.
