#!/usr/bin/env bash
set -u
ulimit -c 0
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export QT_QPA_PLATFORM=offscreen
hostname
id
cat /etc/os-release
command -v plasmashell qdbus6 qdbus-qt6 qdbus cargo rustc node npm cmake gcc python3 kdialog konsole spectacle
plasmashell --version
loginctl list-sessions
ps -eo pid,comm | grep -Ei 'kwin|plasma|wayland|Xorg|vnc|xrdp'
ls /run/user/"$(id -u)"
pkg-config --modversion webkit2gtk-4.1 gtk+-3.0 ayatana-appindicator3-0.1 2>/dev/null || true
ls -l "$HOME/.cargo/bin/cargo" /usr/lib/qt6/bin/qdbus 2>/dev/null || true
qdbus org.kde.KWin /KWin org.kde.KWin.supportInformation | head -45
qdbus org.kde.KWin /Scripting
dpkg-query -W -f='${Package} ${Version}\n' libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev python3-pyqt5 rustc cargo 2>/dev/null || true
free -h
df -h "$HOME"
sudo -n true && echo 'sudo: available without prompting' || true
