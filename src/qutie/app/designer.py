"""Qutie Studio: the window to design and print labels, and its Home.

The page (web/designer.html) does all the drawing: it lays the objects out at the
printer's resolution, dithers each one as chosen and hands over the finished 1-bit
labels, as you read them (length × 96 dots). This module supplies what a web page
cannot do on its own: system fonts, barcodes and QR codes, files and folders, linked
data files, the print history and the printer.
"""

from __future__ import annotations

import base64
import binascii
import ctypes
import datetime as dt
import io
import json
import os
import threading
import time
import winreg
from ctypes import wintypes
from pathlib import Path

import webview
from PIL import Image, ImageFont

from .. import __version__, codes, datasource, library, protocol, render, winsys
from ..config import Config
from ..transport import Printer, PrinterError, find_mac
from . import device

DATA_DIR = Path(os.environ.get("APPDATA", Path.home())) / "Qutie" / "designs"
RECOVERY = DATA_DIR / "recovery"
RECOVERY_DAYS = 7
EXTENSION = "qutie"

FONT_DIR = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
FONT_CACHE = DATA_DIR / "fonts.json"


# --------------------------------------------------------------------------- fonts
def _font_files() -> list[Path]:
    """The font files Windows lists for all users and for this user."""
    files = []
    for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            key = winreg.OpenKey(root, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts")
        except OSError:
            continue
        with key:
            i = 0
            while True:
                try:
                    value = winreg.EnumValue(key, i)[1]
                except OSError:
                    break
                i += 1
                path = Path(str(value))
                if not path.is_absolute():
                    path = FONT_DIR / path
                if path.suffix.lower() in (".ttf", ".otf", ".ttc"):
                    files.append(path)
    return files


def font_families() -> list[dict]:
    """Installed font families by their real name (the registry names are translated),
    and whether they are monospaced.

    Reading every file takes a couple of seconds, so the list is cached until the set
    of installed fonts changes.
    """
    files = _font_files()
    stamp = f"2:{len(files)}:{max((f.stat().st_mtime for f in files if f.exists()), default=0)}"
    try:
        cached = json.loads(FONT_CACHE.read_text(encoding="utf-8"))
        if cached.get("stamp") == stamp:
            return cached["families"]
    except (OSError, ValueError, KeyError):
        pass
    names: dict[str, bool] = {}
    for path in files:
        try:
            font = ImageFont.truetype(str(path), 20)
            family = font.getname()[0]
        except (OSError, ValueError):
            continue
        if family and family[0] != "@" and family not in names:
            try:
                mono = abs(font.getlength("iiii") - font.getlength("WWWW")) < 0.5
            except (OSError, ValueError):
                mono = False
            names[family] = mono
    families = [{"name": n, "mono": names[n]} for n in sorted(names, key=str.casefold)]
    try:
        FONT_CACHE.parent.mkdir(parents=True, exist_ok=True)
        FONT_CACHE.write_text(json.dumps({"stamp": stamp, "families": families}), encoding="utf-8")
    except OSError:
        pass
    return families


# --------------------------------------------------------------------------- labels
def decode_png(data_url: str) -> Image.Image:
    """A label from the page: a PNG data URL, black = ink."""
    raw = base64.b64decode(data_url.partition(",")[2])
    return Image.open(io.BytesIO(raw)).convert("L")


def encode_png(img: Image.Image) -> str:
    buffer = io.BytesIO()
    img.convert("1").save(buffer, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def label_job(img: Image.Image, media: dict) -> bytes:
    """Printer bytes for one label drawn as read (length × 96): turned onto the tape."""
    if img.height != protocol.WIDTH_DOTS:
        raise ValueError(f"the label must be {protocol.WIDTH_DOTS} dots high, not {img.height}")
    bits = img.point(lambda v: 255 if v >= 128 else 0, mode="1")
    printed = bits.rotate(render.ROTATE, expand=True)
    gap = media.get("type") != "continuous"
    length_mm = float(media.get("length_mm") or 0) if gap else None
    feed_mm = float(media.get("feed_mm", protocol.EXTRA_MM if gap else protocol.FEED_MM))
    writes = protocol.job(printed, length_mm=length_mm, feed_mm=feed_mm, extra_mm=feed_mm)
    return b"".join(writes)


def clipboard_text() -> str:
    """The text on the Windows clipboard (cells copied from Excel arrive tab separated)."""
    user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32
    user32.GetClipboardData.restype = wintypes.HANDLE
    kernel32.GlobalLock.restype = ctypes.c_void_p
    kernel32.GlobalLock.argtypes = [wintypes.HANDLE]
    kernel32.GlobalUnlock.argtypes = [wintypes.HANDLE]
    if not user32.OpenClipboard(None):
        return ""
    try:
        handle = user32.GetClipboardData(13)  # CF_UNICODETEXT
        if not handle:
            return ""
        pointer = kernel32.GlobalLock(handle)
        try:
            return ctypes.wstring_at(pointer) if pointer else ""
        finally:
            kernel32.GlobalUnlock(handle)
    finally:
        user32.CloseClipboard()


class PrintRun:
    """One print in progress: its labels go out one at a time, so it can stop and resume."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.state = {"running": False, "done": 0, "total": 0, "error": None}
        self.stop = threading.Event()

    def snapshot(self) -> dict:
        with self.lock:
            return dict(self.state)

    def update(self, **changes) -> None:
        with self.lock:
            self.state.update(changes)


def send_labels(images: list[Image.Image], media: dict, run: PrintRun | None = None) -> dict:
    """Print labels in order, waiting for each one to come out ("dithering_finish").

    Returns {"ok", "printed", "detail"}. Stops after the current label when asked.
    """
    run = run or PrintRun()
    run.stop.clear()
    run.update(running=True, done=0, total=len(images), error=None)
    printed = 0
    try:
        jobs = [label_job(img, media) for img in images]
        config = Config.load()
        with Printer(find_mac(config.mac)) as printer:
            for data in jobs:
                printer.write(data)
                printer.wait_printed(1)
                printed += 1
                run.update(done=printed)
                if run.stop.is_set():
                    break
    except (PrinterError, OSError, ValueError) as e:
        run.update(running=False, error=str(e))
        return {"ok": False, "printed": printed, "detail": str(e)}
    run.update(running=False)
    return {"ok": True, "printed": printed, "stopped": printed < len(images)}


# --------------------------------------------------------------------------- the API
class DesignerApi:
    """JavaScript API of the Qutie Studio window (window.pywebview.api)."""

    def __init__(self, agent=None, start: dict | None = None) -> None:
        self._agent = agent
        self._start = start or {}
        self._win: webview.Window | None = None  # private: pywebview exposes public attributes to the page
        self._path: Path | None = None
        self._dirty = False
        self._closing_ok = False
        self._run = PrintRun()

    def _config(self) -> Config:
        return self._agent.config if self._agent else Config.load()

    def _save_config(self, config: Config) -> None:
        config.save()
        if self._agent:
            self._agent.config = config
            self._agent.config_changed()

    # -- start and settings
    def state(self) -> dict:
        config = self._config()
        start, self._start = self._start, {}
        return {
            "version": __version__,
            "config": config.as_dict(),
            "studio": winsys.studio_enabled(),
            "library": str(library.library_dir(config.library_dir)),
            "autostart": winsys.autostart_enabled(),
            "start": start,
            "printer_installed": bool(_safe(winsys.installed_printer)),
            "mac": config.mac,
        }

    def set_config(self, changes: dict) -> dict:
        config = self._config()
        for key, value in (changes or {}).items():
            if hasattr(config, key) and key not in ("mac", "recent"):
                setattr(config, key, value)
        self._save_config(config)
        return config.as_dict()

    def set_autostart(self, enabled: bool) -> bool:
        winsys.set_autostart(bool(enabled))
        return winsys.autostart_enabled()

    # -- resources
    def fonts(self) -> list[dict]:
        return font_families()

    def codes(self, kind: str, content: str, options: dict | None = None) -> dict:
        options = options or {}
        if kind in ("qr", "microqr"):
            return codes.qr_modules(content, micro=kind == "microqr", ecc=options.get("ecc") or "m",
                                    version=options.get("version"))
        return codes.barcode_modules(kind, content)

    def qr_options(self, content: str, micro: bool = False, quiet: int = 0) -> dict:
        return codes.qr_options(content, micro, int(quiet or 0))

    def verify_codes(self, png: str, expected: list[str]) -> dict:
        try:
            return codes.verify(decode_png(png), expected)
        except (ValueError, OSError, binascii.Error) as e:
            return {"ok": None, "detail": str(e), "found": [], "missing": []}

    # -- printer
    def printer(self) -> dict:
        """Battery, paper and firmware, read over Bluetooth (takes a few seconds)."""
        result = device.read()
        if not result.get("ok"):
            return result
        status, info = result["status"], result["info"]
        return {
            "ok": True,
            "model": info.get("model"), "serial": info.get("serial"),
            "firmware": info.get("firmware"), "bt": info.get("bt_firmware"),
            "mac": result.get("mac"), "port": result.get("com_port"),
            "battery": status.get("battery"),
            "paper": "continuous" if status.get("paper_type") == 0 else "gap",
            "density": status.get("density"), "auto_off": status.get("auto_off_min"),
            "density_range": result.get("density_range"), "auto_off_choices": result.get("auto_off_choices"),
        }

    def apply_printer(self, density: int | None = None, auto_off_min: int | None = None) -> dict:
        return device.apply(density, auto_off_min)

    def feed(self) -> dict:
        return device.feed()

    def test_label(self) -> dict:
        return device.test_label()

    def print_labels(self, labels: list[str], media: dict, job: dict | None = None) -> dict:
        """Print the labels the page drew, in order, one at a time; record it in the history.

        job: {"name", "source", "history_id" (to update when resuming), "doc", "data",
        "tape_mm", "meta"}. The page follows the progress with print_status().
        """
        job = job or {}
        if self._run.snapshot()["running"]:
            return {"ok": False, "detail": "busy"}
        try:
            images = [decode_png(png) for png in labels]
        except (ValueError, OSError, binascii.Error) as e:
            return {"ok": False, "detail": str(e)}
        if not images:
            return {"ok": False, "detail": "nothing to print"}
        result = send_labels(images, media, self._run)
        self._record(job, labels, media, result)
        return result

    def print_status(self) -> dict:
        return self._run.snapshot()

    def stop_print(self) -> None:
        self._run.stop.set()

    def _record(self, job: dict, labels: list[str], media: dict, result: dict) -> None:
        if job.get("no_history"):
            return
        try:
            history_id = job.get("history_id")
            if history_id:
                entry = next((e for e in library.history_list(0) if e["id"] == history_id), None)
                if entry:
                    done = int(entry.get("printed") or 0) + result.get("printed", 0)
                    library.history_update(history_id, printed=done, ok=result["ok"] and done >= entry.get("count", 0),
                                           error=None if result["ok"] else result.get("detail"))
                    result["history_id"] = history_id
                    return
            entry = library.history_add(
                {
                    "name": job.get("name") or "", "source": job.get("source") or "studio",
                    "count": len(labels), "printed": result.get("printed", 0), "ok": bool(result["ok"]) and not result.get("stopped"),
                    "error": None if result["ok"] else result.get("detail"),
                    "media": media.get("type"), "length_mm": media.get("length_mm"),
                    "tape_mm": job.get("tape_mm") or 0, "thumbs": labels[:3], "meta": job.get("meta") or {},
                    "path": str(self._path) if self._path and job.get("source", "studio") == "studio" else None,
                },
                detail={"labels": labels, "media": media, "doc": job.get("doc")},
            )
            result["history_id"] = entry["id"]
        except OSError:
            pass

    # -- history
    def history(self) -> dict:
        entries = library.history_list(int(self._config().history_days or 0))
        return {"entries": entries, "stats": library.history_stats(entries)}

    def history_detail(self, entry_id: str) -> dict | None:
        return library.history_detail(entry_id)

    def history_remove(self, entry_id: str) -> None:
        library.history_remove(entry_id)

    def history_clear(self) -> None:
        library.history_clear()

    def reprint(self, entry_id: str) -> dict:
        """Print a history entry again, exactly as it was (also prints from Windows)."""
        raw = library.history_raw(entry_id)
        if raw is not None:
            result = device.send(raw)
            if result["ok"]:
                entry = next((e for e in library.history_list(0) if e["id"] == entry_id), {})
                library.history_add({**{k: v for k, v in entry.items() if k not in ("id", "time")}, "ok": True},
                                    raw=raw)
            return result
        detail = library.history_detail(entry_id)
        if not detail:
            return {"ok": False, "detail": "not found"}
        entry = next((e for e in library.history_list(0) if e["id"] == entry_id), {})
        job = {"name": entry.get("name"), "source": entry.get("source"), "doc": detail.get("doc"),
               "tape_mm": entry.get("tape_mm"), "meta": entry.get("meta")}
        return self.print_labels(detail["labels"], detail["media"], job)

    # -- documents
    def autosave(self, document: str) -> None:
        if not self._config().autosave:
            return
        try:
            doc_id = str(json.loads(document).get("id") or "untitled")
        except ValueError:
            return
        RECOVERY.mkdir(parents=True, exist_ok=True)
        library.write_document(RECOVERY / f"{library.safe_name(doc_id)}.{EXTENSION}", document)

    def restore(self) -> dict | None:
        """The most recent autosaved document, if it is newer than its file."""
        if not RECOVERY.exists():
            return None
        limit = time.time() - RECOVERY_DAYS * 86400
        newest = None
        for f in RECOVERY.glob(f"*.{EXTENSION}"):
            if f.stat().st_mtime < limit:
                f.unlink(missing_ok=True)
            elif newest is None or f.stat().st_mtime > newest.stat().st_mtime:
                newest = f
        if newest is None:
            return None
        return {"document": newest.read_text(encoding="utf-8"),
                "time": dt.datetime.fromtimestamp(newest.stat().st_mtime).isoformat(timespec="seconds")}

    def discard_recovery(self, doc_id: str) -> None:
        (RECOVERY / f"{library.safe_name(str(doc_id))}.{EXTENSION}").unlink(missing_ok=True)

    def set_dirty(self, dirty: bool, name: str = "") -> None:
        """The page reports unsaved changes, so closing the window can ask first."""
        self._dirty = bool(dirty)
        if self._win:
            self._win.set_title(f"{name + ' · ' if name else ''}Qutie Studio")

    def save(self, document: str, name: str = "", save_as: bool = False) -> dict:
        path = self._path
        if save_as or path is None:
            folder = library.library_dir(self._config().library_dir)
            folder.mkdir(parents=True, exist_ok=True)
            chosen = self._dialog(webview.FileDialog.SAVE, f"{library.safe_name(name) or 'label'}.{EXTENSION}",
                                  (f"Qutie label (*.{EXTENSION})",), folder)
            if not chosen:
                return {"ok": False, "cancelled": True}
            path = Path(chosen)
            if path.suffix.lower() != f".{EXTENSION}":
                path = path.with_suffix(f".{EXTENSION}")
        try:
            library.write_document(path, document)
        except (OSError, ValueError) as e:
            return {"ok": False, "detail": str(e)}
        self._path = path
        self._remember(path)
        return {"ok": True, "path": str(path), "name": path.stem}

    def open(self, path: str | None = None) -> dict:
        if not path:
            chosen = self._dialog(webview.FileDialog.OPEN, "", (f"Qutie label (*.{EXTENSION})", "All files (*.*)"),
                                  library.library_dir(self._config().library_dir))
            if not chosen:
                return {"ok": False, "cancelled": True}
            path = chosen
        p = Path(path)
        try:
            document = p.read_text(encoding="utf-8")
            library.read_document(p)
        except (OSError, ValueError) as e:
            return {"ok": False, "detail": str(e)}
        self._path = p
        self._remember(p)
        return {"ok": True, "document": document, "path": str(p), "name": p.stem}

    def forget_path(self) -> None:
        """A new document: the next save asks where."""
        self._path = None

    def current_path(self) -> str | None:
        return str(self._path) if self._path else None

    def _remember(self, path: Path) -> None:
        config = self._config()
        key = str(path)
        config.recent = [key] + [p for p in config.recent if p.lower() != key.lower()][:11]
        config.last_document = key
        self._save_config(config)

    def clear_recent(self) -> None:
        config = self._config()
        config.recent = []
        self._save_config(config)

    def recent(self) -> list[dict]:
        out = []
        for p in self._config().recent:
            path = Path(p)
            if not path.exists():
                continue
            entry = {"path": p, "name": path.stem,
                     "modified": dt.datetime.fromtimestamp(path.stat().st_mtime).isoformat(timespec="seconds")}
            try:
                doc = library.read_document(path) if path.stat().st_size <= library.MAX_DOC_BYTES else None
                entry["doc"] = doc
                if doc:
                    entry.update(library.summary(doc))
            except (OSError, ValueError):
                continue
            out.append(entry)
        return out

    # -- export
    def export_png(self, data_url: str, name: str = "") -> dict:
        chosen = self._dialog(webview.FileDialog.SAVE, f"{library.safe_name(name) or 'label'}.png", ("PNG image (*.png)",))
        if not chosen:
            return {"ok": False, "cancelled": True}
        try:
            decode_png(data_url).save(chosen, "PNG")
        except (OSError, ValueError, binascii.Error) as e:
            return {"ok": False, "detail": str(e)}
        return {"ok": True, "path": chosen}

    def choose_folder(self, start: str | None = None) -> str | None:
        window = self._window()
        if window is None:
            return None
        result = window.create_file_dialog(webview.FileDialog.FOLDER, directory=start or str(library.documents_dir()))
        return (result if isinstance(result, str) else result[0]) if result else None

    def export_files(self, files: list[dict], folder: str, kind: str = "png") -> dict:
        """Save labels as PNG files ([{"name", "png"}]) or as one PDF, in a folder."""
        try:
            target = Path(folder)
            target.mkdir(parents=True, exist_ok=True)
            if kind == "pdf":
                images = [decode_png(f["png"]).convert("RGB") for f in files]
                name = library.safe_name(files[0].get("name") or "labels") if files else "labels"
                path = target / f"{name}.pdf"
                images[0].save(path, "PDF", resolution=protocol.DPI, save_all=True, append_images=images[1:])
                return {"ok": True, "path": str(path), "count": 1}
            used: set[str] = set()
            for f in files:
                base = library.safe_name(f.get("name") or "label") or "label"
                name, n = base, 2
                while name.lower() in used:
                    name = f"{base}-{n}"
                    n += 1
                used.add(name.lower())
                decode_png(f["png"]).save(target / f"{name}.png", "PNG")
            return {"ok": True, "path": str(target), "count": len(files)}
        except (OSError, ValueError, binascii.Error, IndexError) as e:
            return {"ok": False, "detail": str(e)}

    def export_qutie(self, document: str, name: str = "") -> dict:
        chosen = self._dialog(webview.FileDialog.SAVE, f"{library.safe_name(name) or 'label'}.{EXTENSION}",
                              (f"Qutie label (*.{EXTENSION})",))
        if not chosen:
            return {"ok": False, "cancelled": True}
        try:
            library.write_document(chosen, document)
        except (OSError, ValueError) as e:
            return {"ok": False, "detail": str(e)}
        return {"ok": True, "path": chosen}

    # -- library (Home › My labels)
    def library(self) -> dict:
        root = library.library_dir(self._config().library_dir)
        return {"root": str(root), "labels": library.list_labels(root, self._config().recent),
                "folders": library.folders(root)}

    def file_action(self, action: str, path: str, value: str = "") -> dict:
        root = library.library_dir(self._config().library_dir)
        try:
            if action == "duplicate":
                return {"ok": True, "path": str(library.duplicate(path))}
            if action == "rename":
                return {"ok": True, "path": str(library.rename(path, value))}
            if action == "move":
                return {"ok": True, "path": str(library.move_to_folder(path, root, value))}
            if action == "recycle":
                return {"ok": library.recycle(path)}
            if action == "reveal":
                winsys.reveal(path)
                return {"ok": True}
            if action == "open_with":
                winsys.open_file(path)
                return {"ok": True}
            if action == "write":  # undo a move to the Recycle Bin, or relink a data source
                return {"ok": True, "path": str(library.write_document(path, value))}
            if action == "new_folder":
                (root / library.safe_name(value)).mkdir(parents=True, exist_ok=True)
                return {"ok": True}
        except (OSError, ValueError) as e:
            return {"ok": False, "detail": str(e)}
        return {"ok": False, "detail": f"unknown action {action}"}

    # -- templates
    def templates(self) -> list[dict]:
        return library.list_templates()

    def save_template(self, document: str, name: str, category: str = "", description: str = "",
                      keep_link: bool = True, ask_source: bool = False) -> dict:
        try:
            path = library.save_template(json.loads(document), name, category, description, keep_link, ask_source)
        except (OSError, ValueError) as e:
            return {"ok": False, "detail": str(e)}
        return {"ok": True, "path": str(path)}

    def delete_template(self, path: str) -> None:
        library.delete_template(path)

    def import_template(self) -> dict:
        chosen = self._dialog(webview.FileDialog.OPEN, "", (f"Qutie label (*.{EXTENSION})",))
        if not chosen:
            return {"ok": False, "cancelled": True}
        try:
            doc = library.read_document(chosen)
            name = (doc.get("template") or {}).get("name") or Path(chosen).stem
            meta = doc.get("template") or {}
            library.save_template(doc, name, meta.get("category", ""), meta.get("description", ""))
        except (OSError, ValueError) as e:
            return {"ok": False, "detail": str(e)}
        return {"ok": True}

    # -- data sources
    def pick_data_file(self) -> str | None:
        return self._dialog(webview.FileDialog.OPEN, "",
                            ("Data (*.xlsx;*.xlsm;*.csv;*.tsv;*.txt;*.json)", "All files (*.*)"),
                            library.documents_dir())

    def read_data(self, path: str, sheet: str | None = None, header: bool = True) -> dict:
        try:
            table = datasource.read_file(path, sheet, header)
        except Exception as e:  # noqa: BLE001 - a damaged or locked file: shown to the user
            return {"ok": False, "detail": str(e) or type(e).__name__, "file": datasource.describe(path)}
        return {"ok": True, **table.as_dict(), "file": datasource.describe(path)}

    def parse_table(self, text: str | None = None, header: bool = True) -> dict:
        """A table pasted from the clipboard (or given), e.g. cells copied from Excel."""
        if text is None:
            text = clipboard_text()
        table = datasource.parse_text(text or "", header)
        return {"ok": bool(table.columns), **table.as_dict()}

    def read_data_bytes(self, name: str, data: str, sheet: str | None = None, header: bool = True) -> dict:
        """A data file dropped in the page without its path (development in a browser): a copy."""
        import tempfile

        suffix = Path(name).suffix.lower() or ".csv"
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / f"data{suffix}"
            path.write_bytes(base64.b64decode(data.partition(",")[2] or data))
            result = self.read_data(str(path), sheet, header)
        result["file"] = {"exists": False, "name": name, "path": None}
        return result

    def data_status(self, path: str) -> dict:
        return datasource.describe(path)

    def watch_drops(self) -> None:
        """Files dropped on the window: the page gets their full paths (to link a workbook)."""
        window = self._window()
        if window is None or getattr(self, "_watching_drops", False):
            return
        from webview.dom import DOMEventHandler

        def on_drop(event) -> None:
            files = (event.get("dataTransfer") or {}).get("files") or []
            paths = [f["pywebviewFullPath"] for f in files if f.get("pywebviewFullPath")]
            if paths:
                window.evaluate_js(f"window.Studio && Studio.droppedPaths({json.dumps(paths)})")

        window.dom.document.events.drop += DOMEventHandler(on_drop, prevent_default=True)
        self._watching_drops = True

    def sources(self) -> list[dict]:
        """Every data source used by the labels in the library (Home › Data sources)."""
        root = library.library_dir(self._config().library_dir)
        found: dict[str, dict] = {}
        for entry in library.list_labels(root, self._config().recent):
            doc = entry.get("doc") or {}
            data = doc.get("data") or {}
            source = data.get("source") or {}
            if not data.get("columns"):
                continue
            key = (source.get("path") or f"table:{entry['path']}").lower()
            item = found.setdefault(key, {
                "kind": source.get("kind") or "table", "name": source.get("name") or entry["name"],
                "path": source.get("path"), "sheet": source.get("sheet"), "link": source.get("link", "reread"),
                "columns": data.get("columns"), "rows": data.get("rows", [])[:6], "count": len(data.get("rows") or []),
                "copied": source.get("read"), "labels": [],
            })
            item["labels"].append({"name": entry["name"], "path": entry["path"]})
        out = []
        for item in found.values():
            if item["path"]:
                item["file"] = datasource.describe(item["path"])
            out.append(item)
        return out

    # -- Windows printer (Home › Printer)
    def windows_printer(self) -> dict:
        return {
            "printer": _safe(winsys.installed_printer),
            "defaults": _safe(winsys.driver_defaults) or {},
            "preview": self._config().preview,
        }

    def set_windows_defaults(self, changes: dict) -> dict:
        try:
            return {"ok": True, "defaults": winsys.set_driver_defaults(changes)}
        except Exception as e:  # noqa: BLE001 - shown to the user
            return {"ok": False, "detail": str(e)}

    def set_preview(self, enabled: bool) -> None:
        config = self._config()
        config.preview = bool(enabled)
        self._save_config(config)

    def test_windows(self) -> dict:
        try:
            winsys.test_page()
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "detail": str(e)}

    def open_windows(self, kind: str) -> None:
        winsys.open_printer_dialog(kind)

    def open_setup(self, mode: str = "install") -> None:
        winsys.launch_self("--uninstall" if mode == "uninstall" else "--setup")

    def open_settings(self, section: str | None = None) -> None:
        if self._agent:
            self._agent.open_settings(section)
        else:
            winsys.launch_self("--app", *(["--section", section] if section else []))

    # -- window
    def close(self, force: bool = False) -> None:
        """Close the Studio; force skips the unsaved-changes question (the page asked it)."""
        self._closing_ok = bool(force)
        window = self._window()
        if window:
            window.destroy()

    def minimize(self) -> None:
        window = self._window()
        if window:
            window.minimize()

    def on_closing(self) -> bool:
        """pywebview closing event: with unsaved changes the page asks first."""
        if self._closing_ok or not self._dirty:
            return True
        window = self._window()
        if window:
            threading.Thread(target=lambda: window.evaluate_js("window.Studio && Studio.askClose()"), daemon=True).start()
        return False

    def _window(self):
        return self._win or (webview.windows[0] if webview.windows else None)

    def _dialog(self, kind, filename: str, types: tuple[str, ...], directory: Path | None = None):
        window = self._window()
        if window is None:
            return None
        result = window.create_file_dialog(kind, directory=str(directory or library.documents_dir()),
                                           save_filename=filename, file_types=types)
        if not result:
            return None
        return result if isinstance(result, str) else result[0]


def _safe(fn):
    try:
        return fn()
    except Exception:  # noqa: BLE001 - PowerShell missing or slow: the page shows "unknown"
        return None


# --------------------------------------------------------------------------- dev server
def serve(port: int = int(os.environ.get("PORT") or 4180)) -> None:
    """The Studio in a normal browser, for development: the page calls POST /api/<name>.

    uv run python -m qutie.app.designer   →   http://127.0.0.1:4180/designer.html
    """
    from functools import partial
    from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

    api = DesignerApi()
    web = Path(__file__).with_name("web")
    browser_only = {"save", "open", "export_png", "export_qutie", "choose_folder", "pick_data_file", "import_template",
                    "close", "minimize", "on_closing", "watch_drops"}

    class Handler(SimpleHTTPRequestHandler):
        def do_POST(self):  # noqa: N802 - http.server naming
            name = self.path.removeprefix("/api/")
            length = int(self.headers.get("Content-Length") or 0)
            args = json.loads(self.rfile.read(length) or b"[]")
            method = getattr(api, name, None)
            if name.startswith("_") or not callable(method) or name in browser_only:
                self.send_error(404)
                return
            body = json.dumps(method(*args)).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def log_message(self, *args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, directory=str(web)))
    print(f"http://127.0.0.1:{port}/designer.html")
    server.serve_forever()


if __name__ == "__main__":
    serve()
