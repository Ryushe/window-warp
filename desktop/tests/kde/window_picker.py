"""Exercise KWin's window selector with owned windows in the private compositor."""
import json
import subprocess
from PyQt5.QtCore import QTimer
from PyQt5.QtWidgets import QApplication, QWidget
from wayland_input import Input

app = QApplication([])

class Target(QWidget):
    clicks = 0
    def mousePressEvent(self, event):
        self.clicks += 1
        super().mousePressEvent(event)

window = Target()
window.setWindowTitle("Window Warp owned picker target")
window.showMaximized()
keys = Input()
processes = []
result = {"passed": False, "checks": []}

def query():
    process = subprocess.Popen(["qdbus", "org.kde.KWin", "/KWin", "org.kde.KWin.queryWindowInfo"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    processes.append(process)
    return process

def click():
    keys.pointer(200, 200)
    keys.button(272, True)
    keys.button(272, False)

def selected():
    try:
        out, err = processes[0].communicate(timeout=3)
        if processes[0].returncode or "Window Warp owned picker target" not in out or "uuid" not in out.lower() or window.clicks:
            raise RuntimeError(f"Selection failed: {out!r} {err!r}; clicks={window.clicks}")
        result["checks"].append("selected the owned window without delivering the click")
        query()
        QTimer.singleShot(600, cancel)
        QTimer.singleShot(1200, cancelled)
    except Exception as error:
        result["error"] = str(error)
        app.quit()

def cancel():
    keys.key(1, True)
    keys.key(1, False)

def cancelled():
    try:
        out, err = processes[1].communicate(timeout=3)
        if processes[1].returncode == 0 or "org.kde.KWin.Error.UserCancel" not in (out + err):
            raise RuntimeError(f"Escape did not cancel selection: {out!r} {err!r}")
        result["checks"].append("Escape cancelled selection")
        result["passed"] = True
    except Exception as error:
        result["error"] = str(error)
    app.quit()

QTimer.singleShot(1400, query)
QTimer.singleShot(2100, click)
QTimer.singleShot(2700, selected)
QTimer.singleShot(12000, app.quit)
try:
    app.exec_()
finally:
    for process in processes:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=3)
    keys.close()
    window.close()
print(json.dumps(result, indent=2), flush=True)
if not result["passed"]:
    raise SystemExit(1)
