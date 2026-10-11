"""Fonts by family name, on Windows and Linux.

The Studio names fonts as the browser does ("Segoe UI", "Arial Black"), bold and italic
apart. This finds the file for a family and style, and when the family is missing it
falls back the way the Studio does (the font, then Segoe UI, then a sans-serif), with
the usual Linux equivalents of the Windows fonts in between. Every substitution is
recorded in `substitutions`, so the command line can say which fonts it replaced.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from PIL import ImageFont

# Linux (and macOS) stand-ins for the fonts of Windows that the Studio offers.
SANS = ["Segoe UI", "DejaVu Sans", "Liberation Sans", "Noto Sans", "Arial", "Helvetica", "FreeSans"]
EQUIVALENTS = {
    "segoe ui": SANS,
    "arial": ["Arial", "Liberation Sans", "Arimo", "Helvetica", *SANS],
    "arial black": ["Arial Black", "DejaVu Sans", *SANS],
    "verdana": ["Verdana", "DejaVu Sans", *SANS],
    "tahoma": ["Tahoma", "DejaVu Sans", *SANS],
    "bahnschrift": ["Bahnschrift", "DejaVu Sans Condensed", "Liberation Sans Narrow", *SANS],
    "franklin gothic medium": ["Franklin Gothic Medium", "Liberation Sans", *SANS],
    "impact": ["Impact", "DejaVu Sans Condensed", "Liberation Sans Narrow", *SANS],
    "consolas": ["Consolas", "DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono", "Courier New"],
    "cascadia mono": ["Cascadia Mono", "Consolas", "DejaVu Sans Mono", "Liberation Mono"],
    "courier new": ["Courier New", "Liberation Mono", "DejaVu Sans Mono"],
    "georgia": ["Georgia", "DejaVu Serif", "Liberation Serif", "Noto Serif", "Times New Roman"],
    "times new roman": ["Times New Roman", "Liberation Serif", "DejaVu Serif", "Noto Serif"],
    "segoe print": ["Segoe Print", "Comic Neue", "DejaVu Sans", *SANS],
    "ink free": ["Ink Free", "Comic Neue", "DejaVu Sans", *SANS],
    "segoe ui symbol": ["Segoe UI Symbol", "DejaVu Sans", "Noto Sans Symbols2", "Noto Sans Symbols", "Symbola"],
    "segoe ui emoji": ["Segoe UI Emoji", "Noto Emoji", "Noto Color Emoji", "Segoe UI Symbol", "DejaVu Sans"],
}
# Characters a font lacks are drawn with the first of these that has them (as a browser does).
GLYPH_FALLBACK = ["Segoe UI", "Segoe UI Symbol", "Segoe UI Emoji", "Arial", "DejaVu Sans", "Noto Sans",
                  "Noto Sans Symbols2", "Noto Sans CJK SC", "Microsoft YaHei", "Yu Gothic", "Symbola"]

PLAIN_STYLES = {"regular", "normal", "book", "roman", "bold", "italic", "oblique", "bold italic", "bold oblique"}

substitutions: dict[str, str] = {}  # family asked → family used, filled as fonts are looked up


def font_dirs() -> list[Path]:
    dirs = [Path(p) for p in os.environ.get("QUTIE_FONT_DIRS", "").split(os.pathsep) if p]
    if sys.platform == "win32":
        dirs += [Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts",
                 Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts"]
    else:
        home = Path.home()
        dirs += [Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), home / ".local/share/fonts", home / ".fonts",
                 Path("/Library/Fonts"), home / "Library/Fonts", Path("/System/Library/Fonts")]
    return [d for d in dirs if d.is_dir()]


def _files() -> list[Path]:
    out = []
    for d in font_dirs():
        for p in d.rglob("*"):
            if p.suffix.lower() in (".ttf", ".otf", ".ttc"):
                out.append(p)
    return sorted(set(out))


def _cache_path() -> Path:
    base = os.environ.get("APPDATA") if sys.platform == "win32" else os.environ.get("XDG_CACHE_HOME") or str(Path.home() / ".cache")
    return Path(base or Path.home()) / "Qutie" / "font-index.json"


@lru_cache(maxsize=1)
def index() -> dict[str, list[dict]]:
    """family (lower case) → faces [{"style", "path", "face"}], read once and cached on disk."""
    files = _files()
    stamp = f"2:{len(files)}:{max((f.stat().st_mtime for f in files), default=0)}"
    cache = _cache_path()
    try:
        data = json.loads(cache.read_text(encoding="utf-8"))
        if data.get("stamp") == stamp:
            return data["families"]
    except (OSError, ValueError, KeyError):
        pass
    families: dict[str, list[dict]] = {}
    for path in files:
        for face in range(8):  # a .ttc holds several faces
            try:
                font = ImageFont.truetype(str(path), 20, index=face)
            except OSError:
                break
            family, style = font.getname()
            if family:
                entry = {"style": style or "Regular", "path": str(path), "face": face}
                families.setdefault(family.lower(), []).append(entry)
                # "Arial" + "Black" is also the family "Arial Black", as browsers name it.
                if style and style.lower() not in PLAIN_STYLES:
                    base = style.lower().replace("italic", "").replace("oblique", "").strip()
                    extra = {**entry, "style": "Italic" if "italic" in style.lower() else "Regular", "weight": weight_of(style)}
                    families.setdefault(f"{family.lower()} {base}", []).append(extra)
            if path.suffix.lower() != ".ttc":
                break
    try:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps({"stamp": stamp, "families": families}), encoding="utf-8")
    except OSError:
        pass
    return families


WEIGHTS = [("thin", 100), ("extralight", 200), ("ultralight", 200), ("semilight", 350), ("light", 300),
           ("semibold", 600), ("demibold", 600), ("demi", 600), ("extrabold", 800), ("ultrabold", 800),
           ("bold", 700), ("black", 900), ("heavy", 900), ("medium", 500)]


def weight_of(style: str) -> int:
    s = style.lower().replace(" ", "").replace("-", "")
    return next((w for name, w in WEIGHTS if name in s), 400)


@dataclass(frozen=True)
class Face:
    path: str
    index: int
    weight: int  # 400 regular, 700 bold, 900 black…
    italic: bool
    fake_bold: bool  # bold asked of a lighter face: drawn thicker, as browsers do
    fake_italic: bool  # italic asked of an upright face: drawn slanted
    axes: tuple | None  # variable font: the axis values of the instance used
    family: str


def _variable_axes(path: str, index_: int, bold: bool) -> tuple | None:
    """For a variable font, its axes set to the weight asked (wght 700 or the default)."""
    try:
        font = ImageFont.truetype(path, 20, index=index_)
        axes = font.get_variation_axes()
    except (OSError, AttributeError):
        return None
    if not axes:
        return None
    values = []
    for axis in axes:
        name = axis["name"].decode() if isinstance(axis["name"], bytes) else str(axis["name"])
        value = axis["default"]
        if name.lower() == "weight" and bold:
            value = max(axis["minimum"], min(axis["maximum"], 700))
        values.append(value)
    return tuple(values)


@lru_cache(maxsize=256)
def face(family: str, bold: bool = False, italic: bool = False) -> Face:
    """The face for a family and style, falling back as the Studio does when it is missing.

    CSS matching: bold wants the heaviest face from 600 up (Arial Black stays Black),
    regular the one closest to 400; a variable font gets the weight from its axis.
    """
    asked = (family or "Segoe UI").strip()
    chain = [asked, *EQUIVALENTS.get(asked.lower(), []), *SANS]
    families = index()
    want = 700 if bold else 400
    for name in chain:
        faces = families.get(name.lower())
        if not faces:
            continue

        def rank(f, want=want):
            w, it = weight_of(f["style"]), "italic" in f["style"].lower() or "oblique" in f["style"].lower()
            heavy_enough = (w >= 600) == (want >= 600)
            return (it == italic, heavy_enough, -abs(w - want))
        best = max(faces, key=rank)
        style = best["style"].lower()
        weight = best.get("weight") or weight_of(best["style"])
        has_italic = "italic" in style or "oblique" in style
        axes = _variable_axes(best["path"], best["face"], bold)
        if axes and bold:
            weight = 700
        if name.lower() != asked.lower():
            substitutions[asked] = name
        return Face(best["path"], best["face"], weight, has_italic, bold and weight < 600, italic and not has_italic, axes, name)
    raise LookupError(f"no font found for {asked!r}: install DejaVu Sans or set QUTIE_FONT_DIRS")


@lru_cache(maxsize=1024)
def _load(path: str, index_: int, size: float, axes: tuple | None) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(path, size, index=index_)
    if axes:
        try:
            font.set_variation_by_axes(list(axes))
        except (OSError, AttributeError):
            pass
    return font


def load(f: Face, size: float) -> ImageFont.FreeTypeFont:
    """The face at a size in pixels (fractional sizes too)."""
    return _load(f.path, f.index, round(size, 3), f.axes)


@lru_cache(maxsize=64)
def _missing_mask(path: str, index_: int) -> bytes:
    font = _load(path, index_, 40, None)
    return bytes(font.getmask("\U0010fffd"))


@lru_cache(maxsize=8192)
def has_glyph(path: str, index_: int, char: str) -> bool:
    """Whether the font draws `char` (and not its "missing glyph" box)."""
    if char.isspace():
        return True
    font = _load(path, index_, 40, None)
    return bytes(font.getmask(char)) != _missing_mask(path, index_)


@lru_cache(maxsize=4096)
def fallback_for(char: str) -> tuple[str, int] | None:
    """A font that has `char`, for characters the chosen font lacks."""
    families = index()
    for name in GLYPH_FALLBACK:
        for f in families.get(name.lower(), []):
            if has_glyph(f["path"], f["face"], char):
                return f["path"], f["face"]
    return None
