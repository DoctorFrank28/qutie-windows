"""The Qutie app: tray icon, print preview of every Windows job, and the settings panel.

The Windows printer writes each job to winsys.SPOOL_FILE. This app watches that file,
shows the labels exactly as they will print and, on confirmation, sends the bytes to
the printer over Bluetooth. Only one instance runs per user; launching the app again
just brings up its settings window.
"""

from __future__ import annotations

import base64
import getpass
import io
import queue
import sys
import threading
import time
from multiprocessing.connection import Client, Listener
from pathlib import Path

import pystray
import webview

from .. import __version__, spool, winsys
from ..config import Config
from . import device
from .icon import draw as draw_icon
from .strings import t

WEB = Path(__file__).with_name("web")
CONTROL = rf"\\.\pipe\qutie-app-{getpass.getuser()}"
AUTHKEY = b"qutie"


# --------------------------------------------------------------------------- preview
class PreviewApi:
    """JavaScript API of one preview window."""

    def __init__(self, agent: Agent, path: Path, original: spool.Job) -> None:
        self._agent = agent
        self._path = path
        self._original = original  # as the driver sent it: options can re-fit it
        self._job = self._fit()
        self._done = threading.Event()
        self._window: webview.Window | None = None

    def _fit(self) -> spool.Job:
        config = self._agent.config
        return self._original.fit_to_content(config.margin_mm, config.same_height)

    def set_same_height(self, enabled: bool) -> dict:
        """Change the "same height" option and return the job fitted again."""
        self._agent.config.same_height = bool(enabled)
        self._agent.config.save()
        self._job = self._fit()
        return self.job()

    def job(self) -> dict:
        labels = []
        for label in self._job.labels:
            buffer = io.BytesIO()
            label.image().convert("L").save(buffer, "PNG")
            labels.append({
                "png": "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode(),
                "rows": len(label.rows),
                "length_mm": round((label.length_dots or len(label.rows)) / 8),
                "gap": label.length_dots is not None,
                "feed": label.feed_dots,
            })
        config = self._agent.config
        return {
            "labels": labels,
            "preview": config.preview,
            "strip": config.preview_strip,
            "blank": self._job.blank,
            "fitted": self._original.wide,  # "Fit to tape": the same-height option applies
            "same_height": config.same_height,
        }

    def set_strip(self, enabled: bool) -> None:
        self._agent.config.preview_strip = bool(enabled)
        self._agent.config.save()

    def print(self, copies: int) -> dict:
        result = device.send(self._job.data, copies)
        if result["ok"]:
            self._path.unlink(missing_ok=True)
            self._finish()
        return result

    def cancel(self) -> None:
        if self._done.is_set():
            return
        self._path.unlink(missing_ok=True)
        self._finish()

    def set_preview(self, enabled: bool) -> None:
        self._agent.set_preview(enabled)

    def _finish(self) -> None:
        self._done.set()
        if self._window:
            self._window.destroy()


# --------------------------------------------------------------------------- settings
class SettingsApi:
    """JavaScript API of the settings window."""

    def __init__(self, agent: Agent, section: str | None = None) -> None:
        self._agent = agent
        self._section = section

    def overview(self) -> dict:
        return {
            "section": self._section,
            "version": __version__,
            "printer": winsys.installed_printer(),
            "defaults": winsys.driver_defaults(),
            "preview": self._agent.config.preview,
            "autostart": winsys.autostart_enabled(),
            "margin_mm": self._agent.config.margin_mm,
            "same_height": self._agent.config.same_height,
        }

    def set_same_height(self, enabled: bool) -> None:
        self._agent.config.same_height = bool(enabled)
        self._agent.config.save()

    def set_margin(self, mm: float) -> None:
        self._agent.config.margin_mm = max(0.0, min(20.0, float(mm)))
        self._agent.config.save()

    def read_device(self) -> dict:
        return device.read()

    def apply_device(self, density: int | None, auto_off_min: int | None) -> dict:
        return device.apply(density, auto_off_min)

    def set_defaults(self, changes: dict) -> dict:
        try:
            return {"ok": True, "defaults": winsys.set_driver_defaults(changes)}
        except Exception as e:  # noqa: BLE001 - shown to the user
            return {"ok": False, "detail": str(e)}

    def feed(self) -> dict:
        return device.feed()

    def test_label(self) -> dict:
        return device.test_label()

    def test_windows(self) -> dict:
        try:
            winsys.test_page()
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "detail": str(e)}

    def set_preview(self, enabled: bool) -> None:
        self._agent.set_preview(enabled)

    def set_autostart(self, enabled: bool) -> None:
        winsys.set_autostart(enabled)

    def open_windows(self, kind: str) -> None:
        winsys.open_printer_dialog(kind)

    def open_setup(self, mode: str = "install") -> None:
        winsys.launch_self("--uninstall" if mode == "uninstall" else "--setup")

    def close(self) -> None:
        self._agent.close_settings()


# --------------------------------------------------------------------------- agent
class Agent:
    def __init__(self) -> None:
        self.config = Config.load()
        self.jobs: queue.Queue[Path] = queue.Queue()
        self.settings_window: webview.Window | None = None
        self.icon: pystray.Icon | None = None
        self._lock = threading.Lock()

    # -- lifecycle
    def run(self, show_settings: bool, section: str | None = None) -> None:
        # pywebview needs one window to start; a hidden one keeps the app alive between jobs.
        webview.create_window("Qutie", html="<html></html>", hidden=True)
        threading.Thread(target=self._control_server, daemon=True).start()
        threading.Thread(target=self._watch_spool, daemon=True).start()
        threading.Thread(target=self._process_jobs, daemon=True).start()
        self._start_tray()
        webview.start((lambda: self.open_settings(section)) if show_settings else None)

    def quit(self) -> None:
        if self.icon:
            self.icon.stop()
        for window in list(webview.windows):
            window.destroy()

    # -- settings
    def set_preview(self, enabled: bool) -> None:
        self.config.preview = bool(enabled)
        self.config.save()
        if self.icon:
            self.icon.update_menu()

    def open_settings(self, section: str | None = None) -> None:
        if section and not section.isalpha():
            section = None
        with self._lock:
            if self.settings_window is not None:
                self.settings_window.restore()
                self.settings_window.show()
                if section:
                    self.settings_window.evaluate_js(f"go('{section}')")
                return
            window = webview.create_window(
                "Qutie", str(WEB / "settings.html"), js_api=SettingsApi(self, section),
                width=880, height=640, min_size=(720, 520), on_top=bool(section),
            )
            window.events.closed += self._settings_closed
            self.settings_window = window

    def close_settings(self) -> None:
        if self.settings_window:
            self.settings_window.destroy()

    def _settings_closed(self) -> None:
        self.settings_window = None

    # -- tray
    def _start_tray(self) -> None:
        menu = pystray.Menu(
            pystray.MenuItem(t("settings"), lambda: self.open_settings(), default=True),
            pystray.MenuItem(t("preview"), lambda: self.set_preview(not self.config.preview),
                             checked=lambda _item: self.config.preview),
            pystray.MenuItem(t("setup"), lambda: winsys.launch_self("--setup")),
            pystray.Menu.SEPARATOR,
            pystray.MenuItem(t("quit"), lambda: self.quit()),
        )
        self.icon = pystray.Icon("qutie", draw_icon(64), "Qutie", menu)
        self.icon.run_detached()

    def notify(self, message: str) -> None:
        if self.icon:
            try:
                self.icon.notify(message, "Qutie")
            except Exception:  # noqa: BLE001 - notifications are best effort
                pass

    # -- second launches ask this instance to show the settings
    def _control_server(self) -> None:
        with Listener(CONTROL, family="AF_PIPE", authkey=AUTHKEY) as listener:
            while True:
                try:
                    with listener.accept() as conn:
                        command = conn.recv()
                except (OSError, EOFError):
                    continue
                if isinstance(command, str) and command.startswith("settings"):
                    self.open_settings(command.partition(":")[2] or None)
                elif command == "quit":
                    self.quit()
                    return

    # -- jobs from the Windows printer
    def _watch_spool(self) -> None:
        """Move each finished job out of the spool file, so the next one cannot overwrite it."""
        work = winsys.SPOOL_DIR / "jobs"
        while True:
            time.sleep(0.5)
            try:
                if not winsys.SPOOL_FILE.exists() or winsys.SPOOL_FILE.stat().st_size == 0:
                    continue
                work.mkdir(parents=True, exist_ok=True)
                target = work / f"{time.strftime('%Y%m%d-%H%M%S')}-{time.monotonic_ns()}.prn"
                winsys.SPOOL_FILE.replace(target)  # fails while the spooler is still writing
            except OSError:
                continue
            self.jobs.put(target)

    def _process_jobs(self) -> None:
        # Jobs left by an earlier session (app closed while printing) come first.
        for old in sorted((winsys.SPOOL_DIR / "jobs").glob("*.prn")):
            self.jobs.put(old)
        while True:
            path = self.jobs.get()
            try:
                original = spool.parse(path.read_bytes())
                # "Fit to tape" scaling and continuous tape trimming, as configured.
                job = original.fit_to_content(self.config.margin_mm, self.config.same_height)
            except (OSError, ValueError):
                path.unlink(missing_ok=True)
                continue
            # A blank page (e.g. Excel with its default margins, larger than the label)
            # still opens the preview, which explains how to fix it.
            if not self.config.preview and not job.blank:
                result = device.send(job.data)
                if result["ok"]:
                    path.unlink(missing_ok=True)
                    continue
                self.notify(t("failed"))  # fall back to the preview, which can retry
            api = PreviewApi(self, path, original)
            window = webview.create_window(
                "Qutie", str(WEB / "preview.html"), js_api=api,
                width=760, height=560, min_size=(560, 420), on_top=True,
            )
            api._window = window
            window.events.closed += api.cancel  # closing the window discards the job
            api._done.wait()


def request(command: str) -> bool:
    """Send a command ("settings", "quit") to the running app; False if it is not running."""
    try:
        with Client(CONTROL, family="AF_PIPE", authkey=AUTHKEY) as conn:
            conn.send(command)
        return True
    except OSError:
        return False


def main(show_settings: bool = True, section: str | None = None) -> int:
    # A second launch only asks the running instance to show its settings.
    if request(f"settings:{section or ''}" if show_settings else "ping"):
        return 0
    Agent().run(show_settings, section)
    return 0


if __name__ == "__main__":
    sys.exit(main("--background" not in sys.argv))
