# Window Warp 0.1.7

Workspaces are easier to inspect and update. Expand a workspace or saved browser
to review its contents, open or edit it from its row, and select multiple items
for deletion. Workspace editing keeps drafts available, groups window controls,
and lets you review uncertain matches before replacing saved data.

The Firefox and Chromium extensions now provide searchable lists of saved
tabs and workspaces. Open saved tabs in a new browser window or alongside the
current tabs, rename a saved browser, and open a workspace from the extension.
**Sync tabs** updates the current destination, **Save current tabs** creates a
new saved browser or workspace, and **Sync elsewhere** updates a chosen target
once after confirmation. Live updates continue to track tab changes when enabled.
The extensions use version 0.1.8 so previously prepared copies can update.
If the same saved browser is added to a workspace twice, live sync may not be
able to distinguish the copies; use **Sync elsewhere** to select one explicitly.

Monitor directions are shown relative to the configured main monitor. The
shortcut editor groups monitor behavior controls and hides the second-monitor
placement when the selected behavior does not use it.

Workspaces remain specific to the platform on which they were captured.
Transferring them between Windows and KDE is planned for later. The Debian
package targets Ubuntu/Kubuntu 24.04 amd64 with Plasma 5.27.11 on Wayland and
its matching KWin companion; it is not a universal Linux package. The Windows
installer is unsigned. Microsoft Store availability follows certification.
