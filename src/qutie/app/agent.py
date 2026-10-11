"""The Qutie app: tray icon, print preview of every Windows job, settings and Qutie Studio.

The Windows printer writes each job to winsys.SPOOL_FILE. This app watches that file,
shows the labels exactly as they will print and, on confirmation, sends the bytes to
the printer over Bluetooth. Only one instance runs per user; launching the app again
just brings up its settings window, or Qutie Studio when it is installed.
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes
import getpass
import io
import json
import queue
import sys
import threading
import time
from multiprocessing.connection import Client, Listener
from pathlib import Path

import pystray
import webview

from .. import __version__, library, render, spool, winsys
from ..config import Config
from . import device
from .designer import DesignerApi, encode_png
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
        record_windows_job(self._job, copies, result)
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


def record_windows_job(job: spool.Job, copies: int, result: dict) -> None:
    """A print from another app, in the Studio's print history (with its bytes, to reprint it)."""
    copies = max(1, int(copies))
    try:
        thumbs = [encode_png(label.image().rotate(-render.ROTATE, expand=True)) for label in job.labels[:3]]
        tape = sum((label.length_dots or len(label.rows)) + (label.feed_dots or 0) for label in job.labels) / 8
        library.history_add(
            {"name": "", "source": "windows", "count": len(job.labels) * copies,
             "printed": len(job.labels) * copies if result.get("ok") else 0,
             "ok": bool(result.get("ok")), "error": None if result.get("ok") else result.get("detail"),
             "media": "gap" if any(label.length_dots for label in job.labels) else "continuous",
             "tape_mm": round(tape * copies), "thumbs": thumbs, "meta": {"fitted": job.wide}},
            raw=job.data * copies,
        )
    except Exception:  # noqa: BLE001 - the history never blocks a print
        pass


# --------------------------------------------------------------------------- quick print
class QuickApi(DesignerApi):
    """The small "quick print" window: type, Enter, printed. The Studio's API, plus:"""

    def open_in_studio(self, text: str) -> None:
        if self._agent:
            self._agent.open_studio(text=text)
        self.close(force=True)


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
        self.studio_window: webview.Window | None = None
        self.quick_window: webview.Window | None = None
        self.icon: pystray.Icon | None = None
        self.studio = winsys.studio_enabled()
        self._lock = threading.Lock()
        self._hotkey_thread: int | None = None

    # -- lifecycle
    def run(self, show_settings: bool, section: str | None = None, studio: dict | None = None,
            quick: bool = False) -> None:
        # pywebview needs one window to start; a hidden one keeps the app alive between jobs.
        webview.create_window("Qutie", html="<html></html>", hidden=True)
        threading.Thread(target=self._control_server, daemon=True).start()
        threading.Thread(target=self._watch_spool, daemon=True).start()
        threading.Thread(target=self._process_jobs, daemon=True).start()
        self._start_tray()
        self.config_changed()

        def first() -> None:
            if quick:
                self.open_quick()
            elif studio is not None:
                self.open_studio(**studio)
            elif show_settings:
                self.open_main(section)

        webview.start(first)

    def open_main(self, section: str | None = None) -> None:
        """What the Start menu and a click on the tray icon open: the Studio, or the settings."""
        if self.studio and not section:
            self.open_studio()
        else:
            self.open_settings(section)

    def config_changed(self) -> None:
        """Settings changed in the Studio: the hotkey and the tray menu follow."""
        self._set_hotkey(self.studio and self.config.quick_hotkey)
        if self.icon:
            self.icon.update_menu()

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

    # -- Qutie Studio
    def open_studio(self, path: str | None = None, view: str | None = None, text: str | None = None) -> None:
        start = {k: v for k, v in {"path": path, "view": view, "text": text}.items() if v}
        with self._lock:
            if self.studio_window is not None:
                window = self.studio_window
                window.restore()
                window.show()
                if start:
                    window.evaluate_js(f"window.Studio && Studio.external({json.dumps(start)})")
                return
            api = DesignerApi(self, start)
            window = webview.create_window(
                "Qutie Studio", str(WEB / "designer.html"), js_api=api,
                width=1400, height=880, min_size=(1024, 640),
            )
            api._win = window
            window.events.closing += api.on_closing
            window.events.closed += self._studio_closed
            self.studio_window = window

    def _studio_closed(self) -> None:
        self.studio_window = None

    def open_quick(self) -> None:
        with self._lock:
            if self.quick_window is not None:
                self.quick_window.restore()
                self.quick_window.show()
                return
            api = QuickApi(self)
            window = webview.create_window(
                "Qutie", str(WEB / "quick.html"), js_api=api,
                width=480, height=440, resizable=False, on_top=True,
            )
            api._win = window
            window.events.closed += self._quick_closed
            self.quick_window = window

    def _quick_closed(self) -> None:
        self.quick_window = None

    def _last_print(self) -> dict | None:
        return next((e for e in library.history_list(self.config.history_days) if e.get("ok")), None)

    def reprint_last(self) -> None:
        last = self._last_print()
        if not last:
            return

        def work() -> None:
            result = DesignerApi(self).reprint(last["id"])
            self.notify(t("printed") if result.get("ok") else t("failed"))

        threading.Thread(target=work, daemon=True).start()

    # -- Win+Shift+Q opens quick print
    def _set_hotkey(self, enabled: bool) -> None:
        if self._hotkey_thread:
            ctypes.windll.user32.PostThreadMessageW(self._hotkey_thread, 0x0012, 0, 0)  # WM_QUIT
            self._hotkey_thread = None
        if enabled:
            threading.Thread(target=self._hotkey_loop, daemon=True).start()

    def _hotkey_loop(self) -> None:
        user32 = ctypes.windll.user32
        self._hotkey_thread = ctypes.windll.kernel32.GetCurrentThreadId()
        mod_shift, mod_win, mod_norepeat = 0x0004, 0x0008, 0x4000
        if not user32.RegisterHotKey(None, 1, mod_win | mod_shift | mod_norepeat, ord("Q")):
            return
        try:
            msg = ctypes.wintypes.MSG()
            while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) > 0:
                if msg.message == 0x0312:  # WM_HOTKEY
                    self.open_quick()
        finally:
            user32.UnregisterHotKey(None, 1)

    def close_settings(self) -> None:
        if self.settings_window:
            self.settings_window.destroy()

    def _settings_closed(self) -> None:
        self.settings_window = None

    # -- tray
    def _start_tray(self) -> None:
        def reprint_text(_item) -> str:
            last = self._last_print()
            name = (last.get("name") or t("from_windows")) if last else ""
            return f"{t('reprint_last')}  ·  {name}" if name else t("reprint_last")

        def items():
            preview = pystray.MenuItem(t("preview_windows" if self.studio else "preview"),
                                       lambda: self.set_preview(not self.config.preview),
                                       checked=lambda _item: self.config.preview)
            setup = pystray.MenuItem(t("setup"), lambda: winsys.launch_self("--setup"))
            quit_item = pystray.MenuItem(t("quit"), lambda: self.quit())
            if not self.studio:
                yield pystray.MenuItem(t("settings"), lambda: self.open_settings(), default=True)
                yield preview
                yield setup
            else:
                yield pystray.MenuItem(t("open_studio"), lambda: self.open_studio(), default=True)
                yield pystray.MenuItem(t("quick"), lambda: self.open_quick())
                yield pystray.MenuItem(reprint_text, lambda: self.reprint_last(),
                                       enabled=lambda _item: self._last_print() is not None)
                yield pystray.Menu.SEPARATOR
                yield preview
                yield pystray.MenuItem(t("printer_settings"), lambda: self.open_studio(view="printer"))
                yield setup
            yield pystray.Menu.SEPARATOR
            yield quit_item

        menu = pystray.Menu(items)
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
                    self.open_main(command.partition(":")[2] or None)
                elif isinstance(command, str) and command.startswith("studio:"):
                    try:
                        self.open_studio(**json.loads(command.partition(":")[2] or "{}"))
                    except (ValueError, TypeError):
                        self.open_studio()
                elif command == "quick":
                    self.open_quick()
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
                record_windows_job(job, 1, result)
                if result["ok"]:
                    path.unlink(missing_ok=True)
                    continue
                self.notify(t("failed"))  # fall back to the preview, which can retry
            elif self.studio and self.studio_window is None:
                self.notify(t("waiting"))
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


def main(show_settings: bool = True, section: str | None = None, studio: dict | None = None,
         quick: bool = False) -> int:
    # A second launch only asks the running instance to show a window.
    if quick:
        command = "quick"
    elif studio is not None:
        command = "studio:" + json.dumps(studio)
    else:
        command = f"settings:{section or ''}" if show_settings else "ping"
    if request(command):
        return 0
    Agent().run(show_settings, section, studio, quick)
    return 0


if __name__ == "__main__":
    sys.exit(main("--background" not in sys.argv))
