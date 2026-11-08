# Window Warp 0.1.6 preview

This preview pairs with the Window Warp Firefox extension. In Settings → Browser
extensions, get a pairing code and paste it into the extension. Browser tabs are
shared only when requested or when live sharing is enabled in the extension.

- Monitor settings show connected display names. Where Windows and KDE Plasma 6
  supply stable display IDs, selections follow a display when its position changes.
  On Plasma 5 or when a stable ID is unavailable, reconnecting
  or rearranging displays can change their order; refresh the list and check
  your choices. A missing display falls back to an available monitor.
- Saved browsers can be opened on their own or added to a workspace, with
  replace and append choices for existing browser windows.
- Error messages close after six seconds, and the KDE launcher includes the app
  icon.

The Windows download is an unsigned NSIS installer, so Windows may show a
publisher warning. The Debian package targets Ubuntu
24.04 with KDE Plasma 5.27.11 and its matching KWin companion; it is not a
universal Linux package. These are preview builds: see the project documentation
for current platform limitations and testing details.

If you select a named monitor on Windows or Plasma 6, older Window Warp builds
cannot read those new monitor preferences. Back up your settings before
downgrading. Existing settings upgrade without migration.
