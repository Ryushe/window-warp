![Window Warp](src/banner-window-warp.png)

# Window Warp

Put every window in its place. Window Warp is a Windows and KDE Plasma app for moving windows between monitors, tiling them, pulling an app forward, and restoring a whole workspace.

> [!WARNING]
> Window Warp is in early beta, so bugs are likely.

## Install

- **Windows:** install [Window Warp from the Microsoft Store](https://apps.microsoft.com/detail/9NVBS6W8RV54?hl=en-us&gl=US&ocid=pdpshare).
- **KDE Plasma:** download the Debian package from the [latest GitHub release](https://github.com/Ryushe/window-warp/releases/latest). It targets Ubuntu/Kubuntu 24.04 amd64 with Plasma 5.27.11 on Wayland:

```sh
sudo apt install ./window-warp_0.1.1_kubuntu24.04_amd64.deb
```

Run the command from the download directory, using the downloaded filename if a newer release is available. `apt` installs the package and resolves its dependencies; `sudo dpkg -i` also works if the dependencies are already installed. This package requires `kwin-common` version `4:5.27.11-0ubuntu3`. Other KWin versions, including Plasma 6, need a matching companion and package build. See the [KDE setup notes](desktop/README.md#kde-setup) for details.

## What it does

- Push the focused window to the next monitor. On one monitor, Win+X tiles left and Win+C tiles right.
- After a push, press X or C within one second to tile that window.
- Pull the last pushed window back.
- Tile left, right, top, or bottom, or maximize and restore.
- Bring an app to the main monitor. If it is already there, switch back to the previous app or move it to the second monitor.
- Hold an app shortcut to tile from the pointer, or to open a radial window picker.
- Save workspaces, including window positions, Firefox tabs, and terminal sessions, then open them again.
- Edit shortcuts and resolve duplicate assignments. Record a key and adjust Super, Ctrl, Alt, and Shift with the modifier buttons.
- Find identifiers for open apps, review missing or ambiguous matches, and save multiple identifiers for different systems.
- Pause from the app, the tray, or a shortcut. Closing the window keeps Warp in the tray.

## Using it

Open Window Warp and turn shortcuts on, or use the tray menu. The editor has three pages:

- **Shortcuts.** One row per chord. Open a row to change it.
- **Workspaces.** Capture what is open, then open that layout later.
- **Settings.** Theme, monitors, hold behavior, sign-in startup, and AutoHotkey import.

Themes are Warp, Dracula, Ink, Light, or a custom palette. Custom CSS is under Appearance.

Win+B opens a small editor for the app you are in. Press a key and Enter to assign it using the default modifier from Settings; use the popup's buttons to change modifiers. If the key is already assigned, choose **Replace** to take it, or **Replace and edit old** to immediately give the displaced action a new key. Press Win+B again to open the full editor, or click outside the popup to close it.

To adapt shortcuts between Windows and KDE, open the apps you want to match and choose **Find open apps** on the Shortcuts page. Review the results and save the draft. You can also enter additional app identifiers manually.

## Default shortcuts

| Shortcut | Action |
| --- | --- |
| Win+X / Win+C | Move the focused window left or right |
| Win+Ctrl+X / Win+Ctrl+C | Move it, and center the pointer |
| Win+R | Pull the last window back |
| Win+B | Edit this app's shortcut |
| Win+O | Browse workspaces |
| Win+Y | Capture a workspace update |
| Win+; | Pause or resume |
| Win+Z | Maximize or restore |
| Win+Q | Close the window |

New installs also include app shortcuts from the old AutoHotkey setup, such as Win+D for Discord and Win+S for Firefox. Every key can be changed; desktop and other application shortcuts may need to be reassigned if they conflict.

## AutoHotkey

The original scripts are in [`autohotkey/`](autohotkey/) for reference. Run `autohotkey/Windows Warp.ahk` with AutoHotkey v2. Stop that script before enabling the same keys in the desktop app.

Imported settings come from `window_manager_apps.ini`, `hotkey_registry.ini`, and `windows_warp_settings.ini` in that folder. The import panel in Settings reads them. Nothing is saved until you save the draft.
