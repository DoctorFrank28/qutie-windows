"""Where Qutie Studio keeps things on disk: labels, templates and the print history.

- Labels: .qutie files in Documents\\Qutie (sub-folders are the categories shown in Home).
- Templates: %APPDATA%\\Qutie\\templates, saved with File › Save as template.
- History: %APPDATA%\\Qutie\\history, one entry per print with the labels as they were
  printed, so "Reprint" gives exactly the same result even if the data changed.
"""

from __future__ import annotations

import ctypes
import datetime as dt
import json
import os
import re
import shutil
import uuid
from ctypes import wintypes
from pathlib import Path

APPDATA = Path(os.environ.get("APPDATA", Path.home())) / "Qutie"
TEMPLATES = APPDATA / "templates"
HISTORY = APPDATA / "history"
HISTORY_INDEX = HISTORY / "index.json"
EXTENSION = ".qutie"
MAX_DOC_BYTES = 3_000_000  # larger files are listed without their content (no thumbnail)


def documents_dir() -> Path:
    """The user's Documents folder, also when it is redirected (OneDrive)."""
    try:
        buf = ctypes.create_unicode_buffer(wintypes.MAX_PATH)
        if ctypes.windll.shell32.SHGetFolderPathW(None, 5, None, 0, buf) == 0 and buf.value:
            return Path(buf.value)
    except (AttributeError, OSError):
        pass
    return Path.home() / "Documents"


def library_dir(configured: str | None = None) -> Path:
    return Path(configured) if configured else documents_dir() / "Qutie"


def safe_name(name: str) -> str:
    return re.sub(r'[<>:"/\\|?*\x00-\x1f]', "", name or "").strip().rstrip(".")[:80]


# --------------------------------------------------------------------------- documents
def read_document(path: str | Path) -> dict:
    """A .qutie file: JSON. Raises ValueError when it is not one."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("objects", []), list):
        raise ValueError("not a Qutie label")
    return data


def write_document(path: str | Path, document: dict | str) -> Path:
    path = Path(path)
    text = document if isinstance(document, str) else json.dumps(document, ensure_ascii=False)
    json.loads(text)  # never write a broken file
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)
    return path


def summary(doc: dict) -> dict:
    """What Home shows about a label without drawing it."""
    label = doc.get("label") or {}
    objects = doc.get("objects") or []
    texts = " ".join(str(o.get("text") or o.get("content") or "") for o in objects)
    variables = sorted(set(re.findall(r"\{(?:n|date|data|month|mese|time|ora|year)[+-]?\d*\}", texts)))
    data = doc.get("data") or {}
    source = data.get("source") or {}
    return {
        "media": label.get("media", "gap"),
        "length": label.get("length", 40),
        "auto": bool(label.get("auto")),
        "objects": len(objects),
        "types": sorted({o.get("type") for o in objects if o.get("type")}),
        "variables": variables,
        "data": source.get("name") if data.get("columns") else None,
        "data_kind": source.get("kind") if data.get("columns") else None,
        "rows": len(data.get("rows") or []),
        "text": texts[:400],
    }


def list_labels(root: Path, recent: list[str] | None = None) -> list[dict]:
    """The labels in the library folder plus the recent ones kept elsewhere."""
    seen: set[str] = set()
    out = []
    paths = sorted(root.rglob(f"*{EXTENSION}")) if root.exists() else []
    for extra in recent or []:
        if Path(extra).exists():
            paths.append(Path(extra))
    for path in paths:
        key = str(path.resolve()).lower()
        if key in seen:
            continue
        seen.add(key)
        try:
            st = path.stat()
        except OSError:
            continue
        entry = {
            "path": str(path), "name": path.stem,
            "folder": path.parent.relative_to(root).as_posix() if path.is_relative_to(root) and path.parent != root else "",
            "inside": path.is_relative_to(root),
            "modified": dt.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
            "doc": None,
        }
        if st.st_size <= MAX_DOC_BYTES:
            try:
                doc = read_document(path)
                entry["doc"] = doc
                entry.update(summary(doc))
            except (OSError, ValueError):
                entry["broken"] = True
        out.append(entry)
    out.sort(key=lambda e: e["modified"], reverse=True)
    return out


def folders(root: Path) -> list[str]:
    if not root.exists():
        return []
    return sorted(p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_dir())


def unique_path(folder: Path, name: str) -> Path:
    base = safe_name(name) or "Label"
    path = folder / f"{base}{EXTENSION}"
    n = 2
    while path.exists():
        path = folder / f"{base} ({n}){EXTENSION}"
        n += 1
    return path


def duplicate(path: str | Path) -> Path:
    src = Path(path)
    target = unique_path(src.parent, src.stem)
    shutil.copy2(src, target)
    return target


def rename(path: str | Path, name: str) -> Path:
    src = Path(path)
    target = src.with_name(f"{safe_name(name)}{EXTENSION}")
    if target.exists() and target.resolve() != src.resolve():
        raise FileExistsError(target.name)
    src.rename(target)
    try:
        doc = read_document(target)
        doc["name"] = target.stem
        write_document(target, doc)
    except (OSError, ValueError):
        pass
    return target


def move_to_folder(path: str | Path, root: Path, folder: str) -> Path:
    src = Path(path)
    dest_dir = root / folder if folder else root
    dest_dir.mkdir(parents=True, exist_ok=True)
    target = unique_path(dest_dir, src.stem) if (dest_dir / src.name).exists() else dest_dir / src.name
    shutil.move(src, target)
    return target


def recycle(path: str | Path) -> bool:
    """Move a file to the Recycle Bin (it can be restored from there)."""
    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [("hwnd", wintypes.HWND), ("wFunc", wintypes.UINT), ("pFrom", wintypes.LPCWSTR),
                    ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_uint16), ("fAnyOperationsAborted", wintypes.BOOL),
                    ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]

    FO_DELETE, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_SILENT, FOF_NOERRORUI = 3, 0x40, 0x10, 0x4, 0x400
    op = SHFILEOPSTRUCTW(None, FO_DELETE, str(Path(path).resolve()) + "\0", None,
                         FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI, False, None, None)
    return ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op)) == 0


# --------------------------------------------------------------------------- templates
def list_templates() -> list[dict]:
    out = []
    for path in sorted(TEMPLATES.glob(f"*{EXTENSION}")) if TEMPLATES.exists() else []:
        try:
            doc = read_document(path)
        except (OSError, ValueError):
            continue
        meta = doc.get("template") or {}
        out.append({"path": str(path), "id": "user:" + path.stem, "name": meta.get("name") or path.stem,
                    "category": meta.get("category") or "", "description": meta.get("description") or "",
                    "doc": doc, **summary(doc)})
    return out


def save_template(doc: dict, name: str, category: str = "", description: str = "",
                  keep_link: bool = True, ask_source: bool = False) -> Path:
    doc = json.loads(json.dumps(doc))
    doc["name"] = name
    doc["template"] = {"name": name, "category": category, "description": description, "ask_source": ask_source}
    if not keep_link and doc.get("data"):
        source = doc["data"].get("source") or {}
        source.pop("path", None)
        source["kind"] = "table"
    path = TEMPLATES / f"{safe_name(name) or 'Template'}{EXTENSION}"
    return write_document(path, doc)


def delete_template(path: str | Path) -> None:
    p = Path(path)
    if p.parent.resolve() == TEMPLATES.resolve():
        p.unlink(missing_ok=True)


# --------------------------------------------------------------------------- history
def _load_index() -> list[dict]:
    try:
        data = json.loads(HISTORY_INDEX.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save_index(entries: list[dict]) -> None:
    HISTORY.mkdir(parents=True, exist_ok=True)
    tmp = HISTORY_INDEX.with_suffix(".tmp")
    tmp.write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
    tmp.replace(HISTORY_INDEX)


def history_add(entry: dict, detail: dict | None = None, raw: bytes | None = None) -> dict:
    """Record a print. `detail` (labels, document) and `raw` (printer bytes) are kept apart."""
    entry = {"id": uuid.uuid4().hex[:12], "time": dt.datetime.now().isoformat(timespec="seconds"), **entry}
    HISTORY.mkdir(parents=True, exist_ok=True)
    if detail is not None:
        (HISTORY / f"{entry['id']}.json").write_text(json.dumps(detail, ensure_ascii=False), encoding="utf-8")
    if raw is not None:
        (HISTORY / f"{entry['id']}.prn").write_bytes(raw)
    entries = _load_index()
    entries.insert(0, entry)
    _save_index(entries)
    return entry


def history_update(entry_id: str, **changes) -> dict | None:
    entries = _load_index()
    for e in entries:
        if e["id"] == entry_id:
            e.update(changes)
            _save_index(entries)
            return e
    return None


def history_list(days: int = 90) -> list[dict]:
    history_prune(days)
    return _load_index()


def history_detail(entry_id: str) -> dict | None:
    try:
        return json.loads((HISTORY / f"{entry_id}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def history_raw(entry_id: str) -> bytes | None:
    try:
        return (HISTORY / f"{entry_id}.prn").read_bytes()
    except OSError:
        return None


def history_remove(entry_id: str) -> None:
    _save_index([e for e in _load_index() if e["id"] != entry_id])
    for suffix in (".json", ".prn"):
        (HISTORY / f"{entry_id}{suffix}").unlink(missing_ok=True)


def history_clear() -> None:
    for e in _load_index():
        history_remove(e["id"])
    _save_index([])


def history_prune(days: int) -> None:
    if days <= 0:
        return
    limit = (dt.datetime.now() - dt.timedelta(days=days)).isoformat()
    entries = _load_index()
    keep = [e for e in entries if e.get("time", "") >= limit]
    if len(keep) != len(entries):
        for e in entries:
            if e not in keep:
                for suffix in (".json", ".prn"):
                    (HISTORY / f"{e['id']}{suffix}").unlink(missing_ok=True)
        _save_index(keep)


def history_stats(entries: list[dict]) -> dict:
    """This month's labels and tape, labels per week (last 5 weeks), the most printed label."""
    now = dt.datetime.now()
    month = [e for e in entries if e.get("ok") and e.get("time", "")[:7] == now.strftime("%Y-%m")]
    weeks = [0] * 5
    start_of_week = (now - dt.timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    totals: dict[str, list[int]] = {}
    for e in entries:
        if not e.get("ok"):
            continue
        try:
            t = dt.datetime.fromisoformat(e["time"])
        except (KeyError, ValueError):
            continue
        back = (start_of_week - t.replace(hour=0, minute=0, second=0)).days
        idx = 4 if t >= start_of_week else 4 - (back // 7 + 1)
        if 0 <= idx < 5:
            weeks[idx] += int(e.get("count") or 0)
        acc = totals.setdefault(e.get("name") or "", [0, 0])
        acc[0] += int(e.get("count") or 0)
        acc[1] += 1
    top = max(totals.items(), key=lambda kv: kv[1][0], default=None)
    return {
        "month_labels": sum(int(e.get("count") or 0) for e in month),
        "month_mm": sum(float(e.get("tape_mm") or 0) for e in month),
        "month_prints": len(month),
        "weeks": weeks,
        "top": {"name": top[0], "labels": top[1][0], "prints": top[1][1]} if top else None,
    }
