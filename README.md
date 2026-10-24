# Windows Warp

The replacement for Alt+Tab that you've been looking for. Switch to apps immediately, push apps away and pull them back. But best of all, be in control of your workflow. 

## Standalone desktop app

A new Windows and KDE Plasma 5.27/6 application is being developed in [`desktop/`](desktop/README.md). It runs without AutoHotkey and includes a settings editor, tray controls, configurable shortcuts, monitor push/pull, tiling, and switching between open app windows. This is an early preview; the existing AutoHotkey version below still has additional features.

## Setup

1. Install AutoHotkey v2.
2. Clone or download this folder to your machine.
3. Run `Windows Warp.ahk`.
4. Optional: add `Windows Warp.ahk` to Startup if you want it to launch with Windows.
5. Use `Win+B` to open the editor and adjust app hotkeys or workspace openers.

## Features

- Push the focused window left or right across monitors while preserving relative placement.
- Pull the most recently pushed window back to the main monitor.
- Create app-specific hotkeys from a popup editor.
- Use tap vs hold behavior on app hotkeys, including mouse-aware tiling on the main monitor.
- Save and relaunch workspace opener profiles for commonly used app layouts.
- Browse existing hotkeys from a dedicated hotkey browser.
- Reassign shared hotkeys and create custom app hotkeys without hand-editing the script.
- Toggle all Windows Warp hotkeys on or off.
- Support main-monitor and burner-monitor app behaviors.

## Default Hotkeys

| Hotkey | Action |
| --- | --- |
| `Win+X` | Move focused window left |
| `Win+C` | Move focused window right |
| `Win+Ctrl+X` | Move focused window left and center mouse |
| `Win+Ctrl+C` | Move focused window right and center mouse |
| `Win+R` | Pull most recent window |
| `Win+B` | Open hotkey editor |
| `Win+O` | Open workspace openers |
| `Win+;` | Toggle hotkeys |
| `Win+Z` | Toggle fullscreen |
| `Win+Q` | Close active window |
| `Win+D` | Discord |
| `Win+A` | Claude |
| `Win+T` | Windows Terminal |
| `Win+P` | Caido |
| `Win+S` | Firefox |

## Notes

- Scripts are written for AutoHotkey v2.
- `Windows Warp.ahk` is the single entry point and tray icon.
- App hotkeys are stored in `window_manager_apps.ini`.
- Shared hotkeys are stored in `hotkey_registry.ini`.
- Workspace opener profiles are stored locally in `workspace_openers.ini`.

## Future Ideas

- Add a hold-mode selector in Settings so hold behavior can switch between the current mouse-aware tiling flow and a radial app picker for multi-instance apps.
- Explore a consistent dock/radial layout so app positions stay stable between opens, with room for paging or grouped slots when an app has multiple instances.
