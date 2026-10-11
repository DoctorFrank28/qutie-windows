"""The .qutie label document, as the Studio writes it (web/designer/model.js).

Geometry is in millimetres, in reading orientation: x runs along the tape, y across it
(0–12 mm). Objects are dicts with the same keys as in the file; normalize() fills in
what an older or hand-written file leaves out.
"""

from __future__ import annotations

import copy
import datetime as dt
import json
import math
import re
import uuid
from pathlib import Path

from . import formats

DPI = 203
DPMM = DPI / 25.4
HEAD_DOTS = 96
TAPE_MM = HEAD_DOTS / DPMM  # 12.01 mm
PT = DPI / 72  # dots per typographic point
FEED_GAP = 10  # protocol.EXTRA_MM
FEED_CONTINUOUS = 14  # protocol.FEED_MM
FORMAT_VERSION = 2


def mm_to_dots(mm: float) -> int:
    return math.floor(mm * DPMM + 1e-6)


def dots(mm: float) -> float:
    return mm * DPMM


def fill(type_: str = "solid", **more) -> dict:
    return {"type": type_, "ink": 100, "pattern": "diag", "scale": 5, "weight": 1, "from": 100, "to": 0, "angle": 0, **more}


def stroke(width: float = 0, **more) -> dict:
    return {"width": width, "ink": 100, "dash": "solid", **more}


# What the Studio gives every object, then each type. The text font follows the
# Studio's settings there; a file always carries it.
BASE = {
    "name": "", "x": 2, "y": 1, "w": 20, "h": 10, "rotation": 0, "hidden": False, "locked": False, "group": None,
    "dither": {"mode": "auto", "threshold": 128, "cell": 6, "angle": 45},
    "visible": {"mode": "always", "join": "and", "rules": []},
    "empty": "hide", "closeGap": False,
}
KINDS = {
    "text": {
        "w": 30, "h": 10, "text": "", "font": "Segoe UI", "size": 24, "autoFit": True,
        "bold": True, "italic": False, "underline": False, "strike": False,
        "align": "center", "valign": "middle", "spacing": 0, "lineHeight": 1.05, "transform": "none", "wrap": False,
        "fill": fill("solid"), "stroke": stroke(0), "background": fill("none"), "padding": 0, "radius": 0, "symbol": False,
    },
    "rect": {"w": 20, "h": 8, "fill": fill("none"), "stroke": stroke(0.4), "radius": 1},
    "ellipse": {"w": 10, "h": 10, "fill": fill("solid"), "stroke": stroke(0)},
    "line": {"w": 20, "h": 1.5, "stroke": stroke(0.3), "arrowStart": False, "arrowEnd": False},
    "image": {
        "w": 12, "h": 12, "asset": None, "fileName": "", "fit": "contain", "brightness": 0, "contrast": 0, "gamma": 1,
        "invert": False, "autoLevels": True, "whiteEmpty": True, "flipH": False, "flipV": False,
    },
    "barcode": {"w": 30, "h": 10, "kind": "code128", "content": "QUTIE-001", "textPos": "below", "textSize": 6, "font": "Consolas", "moduleDots": 0},
    "qr": {"w": 10, "h": 10, "kind": "qr", "content": "https://", "ecc": "m", "quiet": 0, "version": "auto", "moduleDots": 0,
           "invert": False, "qrType": "link", "qrData": {}},
}


def make_object(type_: str, props: dict | None = None) -> dict:
    """An object of `type_` with the Studio's defaults, merged with `props` (as makeObject)."""
    props = props or {}
    obj = {"id": uuid.uuid4().hex[:12], "type": type_, **copy.deepcopy(BASE), **copy.deepcopy(KINDS.get(type_, {})), **props}
    if isinstance(props.get("dither"), dict):
        obj["dither"] = {**BASE["dither"], **props["dither"]}
    if isinstance(props.get("visible"), dict):
        obj["visible"] = {**BASE["visible"], **props["visible"]}
    if obj["type"] == "barcode" and "showText" in obj:  # version 1 files
        if not obj["showText"]:
            obj["textPos"] = "none"
        del obj["showText"]
    if obj["type"] == "qr" and isinstance(obj.get("quiet"), bool):
        obj["quiet"] = 4 if obj["quiet"] else 0
    return obj


def new_data(**props) -> dict:
    data = {
        "source": {"kind": "table", "name": "", "path": None, "sheet": None, "header": True, "link": "reread", "read": None, "modified": None},
        "columns": [], "rows": [], "checked": [], "formulas": [], "filter": [], "sort": None,
        "copies": None, "current": 0, "which": "all", "range": {"from": 1, "to": 1}, "search": "",
    }
    data.update(props)
    return data


def new_document() -> dict:
    return {
        "format": "qutie-label", "version": FORMAT_VERSION, "id": uuid.uuid4().hex, "name": "",
        "label": {"media": "gap", "length": 40, "auto": False, "margin": 2, "feed": FEED_GAP},
        "objects": [], "assets": {},
        "series": {"start": 1, "step": 1, "count": 10, "pad": 0, "repeat": 1, "collate": True, "advance": True},
        "data": None,
    }


def normalize(raw: dict) -> dict:
    """A document read from a file, with everything missing filled in (as normalizeDocument)."""
    doc = new_document()
    if not isinstance(raw, dict):
        return doc
    doc["id"] = str(raw.get("id") or doc["id"])
    doc["name"] = str(raw.get("name") or "")
    doc["label"].update(raw.get("label") or {})
    doc["series"].update(raw.get("series") or {})
    doc["assets"] = raw.get("assets") if isinstance(raw.get("assets"), dict) else {}
    doc["objects"] = [make_object(o["type"], o) for o in raw.get("objects") or [] if isinstance(o, dict) and o.get("type")]
    data = raw.get("data")
    if isinstance(data, dict) and isinstance(data.get("columns"), list):
        doc["data"] = new_data(**{**data, "source": {**new_data()["source"], **(data.get("source") or {})}})
    elif (raw.get("series") or {}).get("rows") and re.search(r"\{[1-9]\}", json.dumps(raw.get("objects") or [])):
        # Version 1: a pasted list with {1}, {2}… becomes a table with fields.
        rows = [[c.strip() for c in re.split(r"\t|;|,", line)] for line in str(raw["series"]["rows"]).splitlines() if line.strip()]
        width = max([1, *(len(r) for r in rows)])
        names = [f"Column {i + 1}" for i in range(width)]
        doc["data"] = new_data(columns=[{"name": n, "type": "text"} for n in names],
                               rows=[[r[i] if i < len(r) else "" for i in range(width)] for r in rows])
        for o in doc["objects"]:
            for key in ("text", "content"):
                if isinstance(o.get(key), str):
                    o[key] = re.sub(r"\{([1-9])\}", lambda m: f"«{names[int(m[1]) - 1]}»" if int(m[1]) <= width else "«»", o[key])
    return doc


def load(path: str | Path) -> dict:
    """A .qutie file, normalized."""
    return normalize(json.loads(Path(path).read_text(encoding="utf-8")))


# --------------------------------------------------------------------------- variables
VAR_RE = re.compile(r"\{(n|date|data|month|mese|time|ora|year|anno|[1-9])([+-]\d+)?\}")
VAR_ALIAS = {"data": "date", "mese": "month", "ora": "time", "anno": "year"}


def js_number(n: float) -> str:
    """A number as JavaScript's String(n) writes it: 3, not 3.0."""
    if isinstance(n, float) and n.is_integer():
        n = int(n)
    return str(n)


def uses_counter(doc: dict) -> bool:
    return any(re.search(r"\{n([+-]\d+)?\}", f"{o.get('text') or ''} {o.get('content') or ''}") for o in doc["objects"])


def short_date(d: dt.date, fmt: formats.Formats) -> str:
    return fmt.date.format(d=f"{d.day:02d}", m=f"{d.month:02d}", y=f"{d.year}")


def month_year(d: dt.date, fmt: formats.Formats) -> str:
    return fmt.month.format(m=f"{d.month:02d}", mn=str(d.month), y=f"{d.year}")


def short_time(t: dt.datetime, fmt: formats.Formats) -> str:
    if fmt.clock12:
        return f"{(t.hour % 12) or 12:02d}:{t.minute:02d} {'AM' if t.hour < 12 else 'PM'}"
    return f"{t.hour:02d}:{t.minute:02d}"


def add_months(d: dt.date, months: int) -> dt.date:
    """The first of the month `months` after d's (as new Date(y, m + k, 1))."""
    index = d.year * 12 + d.month - 1 + months
    return dt.date(index // 12, index % 12 + 1, 1)


def expand(text: str, vars_: dict, fmt: formats.Formats) -> str:
    """Fill in {n}, {date+30}, {month}, {time}, {year} (Italian names too)."""
    if not text or "{" not in text:
        return text or ""
    now: dt.datetime = vars_.get("now") or dt.datetime.now()

    def value(m: re.Match) -> str:
        key, k = VAR_ALIAS.get(m[1], m[1]), int(m[2] or 0)
        if key == "n":  # String(n + k).padStart(pad, "0"), as the Studio
            return js_number(vars_.get("n", 1) + k).rjust(int(vars_.get("pad") or 0), "0")
        if key == "date":
            return short_date((now + dt.timedelta(days=k)).date(), fmt)
        if key == "month":
            return month_year(add_months(now.date(), k), fmt)
        if key == "year":
            return str(now.year + k)
        if key == "time":
            return short_time(now, fmt)
        row = vars_.get("row") or []
        i = int(key) - 1
        return str(row[i]) if i < len(row) and row[i] is not None else ""

    return VAR_RE.sub(value, text)


# --------------------------------------------------------------------------- geometry
def corners(o: dict) -> list[tuple[float, float]]:
    cx, cy = o["x"] + o["w"] / 2, o["y"] + o["h"] / 2
    a = math.radians(o.get("rotation") or 0)
    c, s = math.cos(a), math.sin(a)
    return [(cx + x * c - y * s, cy + x * s + y * c)
            for x, y in ((-o["w"] / 2, -o["h"] / 2), (o["w"] / 2, -o["h"] / 2), (o["w"] / 2, o["h"] / 2), (-o["w"] / 2, o["h"] / 2))]


def bounds(objects: list[dict]) -> dict:
    pts = [p for o in objects for p in corners(o)]
    x0, y0 = min(p[0] for p in pts), min(p[1] for p in pts)
    x1, y1 = max(p[0] for p in pts), max(p[1] for p in pts)
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "w": x1 - x0, "h": y1 - y0}


def _number(v, default: float) -> float:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    return n if math.isfinite(n) and n else default


def label_length(doc: dict, objects: list[dict] | None = None) -> float:
    """Label length (mm). Continuous tape with "auto" follows the content."""
    objects = doc["objects"] if objects is None else objects
    label = doc["label"]
    if label.get("media") == "continuous" and label.get("auto"):
        visible = [o for o in objects if not o.get("hidden")]
        end = bounds(visible)["x1"] if visible else 20
        return max(5.0, min(1000.0, end + (_number(label.get("margin"), 0))))
    return max(5.0, min(1000.0, _number(label.get("length"), 40)))


def label_feed(doc: dict) -> float:
    feed = doc["label"].get("feed")
    if feed is None:
        return FEED_CONTINUOUS if doc["label"].get("media") == "continuous" else FEED_GAP
    return float(feed)


def media_of(doc: dict, length: float | None = None) -> dict:
    """Media for the printer: {type, length_mm, feed_mm}."""
    continuous = doc["label"].get("media") == "continuous"
    length = label_length(doc) if length is None else length
    return {"type": "continuous" if continuous else "gap", "length_mm": None if continuous else length, "feed_mm": label_feed(doc)}
