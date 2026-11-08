#!/usr/bin/env python3
"""Check the extracted Debian package's KDE launcher and icon lookup."""
import configparser
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile

os.environ["QT_QPA_PLATFORM"] = "offscreen"
from PyQt5.QtCore import QSize
from PyQt5.QtGui import QIcon
from PyQt5.QtWidgets import QApplication


root = Path(sys.argv[1]).resolve(strict=True)
applications = root / "usr/share/applications"
launcher = applications / "window-warp.desktop"
legacy = applications / "Window Warp.desktop"
icon = root / "usr/share/icons/hicolor/512x512/apps/com.windowwarp.desktop.png"
source = Path(__file__).resolve().parents[2] / "src-tauri/icons/icon.png"


def entry(path):
    parser = configparser.ConfigParser(interpolation=None)
    if not parser.read(path):
        raise AssertionError(f"Missing desktop entry: {path}")
    return parser["Desktop Entry"]


canonical = entry(launcher)
assert canonical["Name"] == "Window Warp"
assert canonical["Exec"] == "/usr/bin/window-warp"
assert canonical["Icon"] == "com.windowwarp.desktop"
assert canonical.get("NoDisplay", "false").lower() != "true"
assert "org_kde_kwin_fake_input" in canonical["X-KDE-Wayland-Interfaces"]
old = entry(legacy)
assert old.get("NoDisplay", "false").lower() == "true"
assert old["Icon"] == canonical["Icon"]
assert hashlib.sha256(icon.read_bytes()).digest() == hashlib.sha256(source.read_bytes()).digest()

# Recreate the system hicolor index beside the extracted icon. With Breeze,
# the old hyphenated name falls back to its generic "window" icon before
# finding our artwork. The unique name must resolve to the 512px artwork.
app = QApplication([])
with tempfile.TemporaryDirectory(prefix="window-warp-icon-") as temporary:
    theme = Path(temporary) / "hicolor"
    apps = theme / "512x512/apps"
    apps.mkdir(parents=True)
    shutil.copyfile("/usr/share/icons/hicolor/index.theme", theme / "index.theme")
    shutil.copyfile(icon, apps / icon.name)
    QIcon.setThemeSearchPaths([temporary, "/usr/share/icons"])
    QIcon.setThemeName("breeze" if Path("/usr/share/icons/breeze/index.theme").exists() else "hicolor")
    resolved = QIcon.fromTheme(canonical["Icon"])
    assert not resolved.isNull()
    assert QSize(512, 512) in resolved.availableSizes(), "KDE selected a fallback icon"
print("KDE launcher identity and icon resolution: passed")
