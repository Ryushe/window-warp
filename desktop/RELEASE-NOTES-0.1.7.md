# Window Warp 0.1.7 candidate

This candidate makes workspaces easier to inspect and update:

- Expand a workspace to see its windows and saved browser tabs, or expand a
  saved browser to see its tabs.
- Open, edit, or delete saved workspaces and browsers from their rows. Select
  several items to delete them together, with a confirmation first.
- Remove or restore windows while editing a draft. When updating a workspace,
  review new, changed, and uncertain matches and keep previously saved windows.
- See monitor directions relative to the configured main monitor. The shortcut
  editor groups its monitor behavior controls and hides the second-monitor
  placement when the shortcut switches back to the previous app.

Workspaces remain specific to the platform on which they were captured.
Transferring them between Windows and KDE is planned for later.

The Windows installer is an unsigned preview. The separate Microsoft Store MSIX
is unsigned and requires the correct Store identity and signing before
submission or installation. The Debian package targets Ubuntu 24.04 with KDE
Plasma 5.27.11 and its matching KWin companion; it is not a universal Linux
package. See the release validation record for tested and unverified behavior.
