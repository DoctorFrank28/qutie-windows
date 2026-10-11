"""Drawing a label into the dots the printer gets. A port of the Studio's render.js.

As in the Studio every object gets its own layer: it is drawn, dithered as the object
asks, and stacked onto the label (1 = black). Shapes are drawn at SS× and reduced, which
gives the same soft edges as the browser's canvas; text is shaped with HarfBuzz, as the
browser does, so widths and autofit sizes match the Studio, and drawn with FreeType.

A layer keeps two channels, as premultiplied colour: coverage (alpha) and ink (alpha ×
darkness). The grey the dithering sees is 255 − ink, exactly what the canvas gives.
"""

from __future__ import annotations

import base64
import io
import math
import re
from dataclasses import dataclass, field

import uharfbuzz as hb
from PIL import Image, ImageDraw

from .. import codes
from . import document, fields, fonts
from .document import DPMM, HEAD_DOTS, PT, dots
from .fields import js_round

SS = 4  # supersampling of the drawing
TEXT_SCALE = 1  # text is drawn at its size, hinted, as the browser does


class LabelError(ValueError):
    """The label cannot be printed as it is (a code that does not encode, a missing font…)."""


@dataclass
class Raster:
    """One label: width × 96 dots, bits[y][x] = 1 for black, and the objects drawn."""
    width: int
    height: int
    image: Image.Image  # mode "1"-like "L": 0 black, 255 white
    objects: list = field(default_factory=list)

    def bits(self) -> bytes:
        return bytes(1 if v < 128 else 0 for v in self.image.tobytes())


# --------------------------------------------------------------------------- paints
def grey(ink) -> int:
    """The canvas grey of an ink percentage (0 white … 100 black)."""
    return js_round(255 * (1 - max(0.0, min(100.0, float(ink or 0))) / 100))


def _dark(ink) -> int:
    return 255 - grey(ink)


def _tile_on(name: str, s: int, t: int, x: int, y: int) -> bool:
    half = max(1, s // 2)
    if name == "hlines":
        return y < t
    if name == "vlines":
        return x < t
    if name == "diag":
        return (x + y) % s < t
    if name == "diag2":
        return (x - y + s * 4) % s < t
    if name == "cross":
        return (x + y) % s < t or (x - y + s * 4) % s < t
    if name == "grid":
        return x < t or y < t
    if name == "dots":
        return (x - half) ** 2 + (y - half) ** 2 < (t * 0.6) ** 2 + 0.5
    if name == "checker":
        return (x // half + y // half) % 2 == 0
    if name == "bricks":
        return y % half < t or (x + (0 if y < half else half)) % s < t
    if name == "zigzag":
        return (y - abs(x - half) + s) % s < t
    return False


def _tile(name: str, scale, weight) -> tuple[int, list[list[bool]]]:
    s = max(2, min(32, js_round(float(scale or 0)) or 4))
    t = max(1, min(s - 1, js_round(float(weight or 0)) or 1))
    return s, [[_tile_on(name, s, t, x, y) for x in range(s)] for y in range(s)]


class Frame:
    """Where an object is: its local frame (dots, (0,0) at the top-left of its unrotated box)
    mapped onto a region of the label at SS×."""

    def __init__(self, o: dict, x0: int, y0: int, x1: int, y1: int) -> None:
        self.w, self.h = dots(o["w"]), dots(o["h"])
        self.cx, self.cy = dots(o["x"]) + self.w / 2, dots(o["y"]) + self.h / 2
        a = math.radians(o.get("rotation") or 0)
        self.cos, self.sin = math.cos(a), math.sin(a)
        self.x0, self.y0 = x0, y0  # region in label dots (whole)
        self.size = ((x1 - x0) * SS, (y1 - y0) * SS)

    def to_label(self, lx: float, ly: float) -> tuple[float, float]:
        dx, dy = lx - self.w / 2, ly - self.h / 2
        return self.cx + dx * self.cos - dy * self.sin, self.cy + dx * self.sin + dy * self.cos

    def to_region(self, lx: float, ly: float) -> tuple[float, float]:
        X, Y = self.to_label(lx, ly)
        return (X - self.x0) * SS, (Y - self.y0) * SS

    def to_local(self, X: float, Y: float) -> tuple[float, float]:
        dx, dy = X - self.cx, Y - self.cy
        return dx * self.cos + dy * self.sin + self.w / 2, -dx * self.sin + dy * self.cos + self.h / 2

    def affine_from_local(self, ox: float, oy: float) -> tuple:
        """Image.transform data mapping region pixels (SS×) to pixels of a local image whose
        top-left is local (ox, oy) at SS×."""
        # region pixel (u, v) → label (x0 + u/SS, y0 + v/SS) → local → local image (lx−ox)·SS
        c, s = self.cos, self.sin
        k = 1 / SS
        bx = self.x0 - self.cx
        by = self.y0 - self.cy
        # lx = (bx + u·k)·c + (by + v·k)·s + w/2 ; ly = −(bx + u·k)·s + (by + v·k)·c + h/2
        return (c, s, (bx * c + by * s + self.w / 2 - ox) * SS,
                -s, c, (-bx * s + by * c + self.h / 2 - oy) * SS)


class Mask:
    """Where a shape covers its region, at SS×: a pixel is in when its centre is inside the
    shape (non-zero winding), the rule of the canvas. Pillow's polygon() also fills the
    pixels the edge only touches, which would make every shape a quarter of a dot fatter."""

    def __init__(self, size: tuple[int, int]) -> None:
        self.w, self.h = size
        self.buf = bytearray(self.w * self.h)

    def polygon(self, pts: list[tuple[float, float]], fill: int = 255) -> None:
        if len(pts) < 3:
            return
        w, h, buf, value = self.w, self.h, self.buf, fill
        ys = [p[1] for p in pts]
        row0 = max(0, math.ceil(min(ys) - 0.5))
        row1 = min(h, math.ceil(max(ys) - 0.5))
        if row1 <= row0:
            return
        xs = [p[0] for p in pts]
        if len(pts) == 4 and len(set(xs)) == 2 and len(set(ys)) == 2 and xs[0] in (xs[1], xs[3]):
            self._rect(min(xs), min(ys), max(xs), max(ys), value)
            return
        edges = [(x1, y1, x2, y2) for (x1, y1), (x2, y2) in zip(pts, pts[1:] + pts[:1]) if y1 != y2]
        for y in range(row0, row1):
            yc = y + 0.5
            cross = []
            for x1, y1, x2, y2 in edges:
                if (y1 <= yc < y2) or (y2 <= yc < y1):
                    cross.append((x1 + (yc - y1) * (x2 - x1) / (y2 - y1), 1 if y2 > y1 else -1))
            cross.sort()
            winding = 0
            for i, (x, d) in enumerate(cross):
                before = winding
                winding += d
                if before == 0 and winding != 0:
                    start = x
                elif before != 0 and winding == 0:
                    a = max(0, math.ceil(start - 0.5))
                    b = min(w, math.ceil(x - 0.5))
                    if b > a:
                        buf[y * w + a:y * w + b] = bytes([value]) * (b - a)

    def _rect(self, x0: float, y0: float, x1: float, y1: float, value: int) -> None:
        """An upright rectangle with the exact share of its edge pixels covered (fill 255),
        or cleared (fill 0)."""
        w, h, buf = self.w, self.h, self.buf
        cx = [(x, min(x + 1, x1) - max(x, x0)) for x in range(max(0, math.floor(x0)), min(w, math.ceil(x1)))]
        for y in range(max(0, math.floor(y0)), min(h, math.ceil(y1))):
            fy = min(y + 1, y1) - max(y, y0)
            row = y * w
            for x, fx in cx:
                share = fx * fy
                if value:
                    buf[row + x] = min(255, buf[row + x] + round(255 * share)) if share < 1 else 255
                else:
                    buf[row + x] = max(0, buf[row + x] - round(255 * share)) if share < 1 else 0

    def image(self) -> Image.Image:
        return Image.frombytes("L", (self.w, self.h), bytes(self.buf))


class Layer:
    """An object drawn on its region: coverage and premultiplied ink, at SS×."""

    def __init__(self, frame: Frame) -> None:
        self.f = frame
        self.alpha = Image.new("L", frame.size, 0)
        self.ink = Image.new("L", frame.size, 0)

    def mask(self) -> Mask:
        return Mask(self.f.size)

    def polygon(self, mask: Mask, points: list[tuple[float, float]], fill: int = 255) -> None:
        mask.polygon([self.f.to_region(x, y) for x, y in points], fill)

    def paint(self, mask, spec) -> None:
        """Lay `spec` (a darkness 0–255, or an "L" image of darkness on the region) where `mask` covers."""
        cover = mask.image() if isinstance(mask, Mask) else mask
        source = Image.new("L", self.f.size, spec) if isinstance(spec, int) else spec
        self.ink = Image.composite(source, self.ink, cover)
        self.alpha = Image.composite(Image.new("L", self.f.size, 255), self.alpha, cover)

    def fill_paint(self, f: dict | None, w: float, h: float):
        """A canvas fill style (render.js paint()) as darkness: an int, an image, or None."""
        if not f or f.get("type") == "none":
            return None
        kind = f.get("type")
        if kind not in ("pattern", "gradient"):
            return _dark(f.get("ink", 100))
        # Per label dot, sampled at the dot's centre as the canvas does, then grown to SS×.
        W, H = self.f.size[0] // SS, self.f.size[1] // SS
        img = Image.new("L", (W, H), 0)
        px = img.load()
        if kind == "pattern":
            s, tile = _tile(f.get("pattern") or "diag", f.get("scale"), f.get("weight"))
            on, off = _dark(f.get("ink", 100)), 0
            for v in range(H):
                for u in range(W):
                    lx, ly = self.f.to_local(self.f.x0 + u + 0.5, self.f.y0 + v + 0.5)
                    px[u, v] = on if tile[math.floor(ly) % s][math.floor(lx) % s] else off
        else:
            a = math.radians(f.get("angle") or 0)
            reach = abs((w / 2) * math.cos(a)) + abs((h / 2) * math.sin(a)) or 1
            g0, g1 = grey(f.get("from", 100)), grey(f.get("to", 0))
            for v in range(H):
                for u in range(W):
                    lx, ly = self.f.to_local(self.f.x0 + u + 0.5, self.f.y0 + v + 0.5)
                    t = ((lx - w / 2) * math.cos(a) + (ly - h / 2) * math.sin(a)) / (2 * reach) + 0.5
                    t = max(0.0, min(1.0, t))
                    px[u, v] = 255 - round(g0 + (g1 - g0) * t)
        return img.resize(self.f.size, Image.NEAREST)

    def place(self, local: Image.Image, ox: float, oy: float) -> Image.Image:
        """A local image (SS×, top-left at local (ox, oy)) moved onto the region."""
        return local.transform(self.f.size, Image.AFFINE, self.f.affine_from_local(ox, oy), resample=Image.BILINEAR)

    def reduced(self) -> tuple[Image.Image, Image.Image]:
        return self.alpha.reduce(SS), self.ink.reduce(SS)


# --------------------------------------------------------------------------- paths
def _round_rect(x: float, y: float, w: float, h: float, r: float, n: int = 10) -> list[tuple[float, float]]:
    """A rounded rectangle as a polygon, starting at (x + r, y) and going clockwise (as roundRect)."""
    r = max(0.0, min(r, w / 2, h / 2))
    if r <= 0:
        return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
    pts = []
    for cx, cy, a0 in ((x + w - r, y + r, -90), (x + w - r, y + h - r, 0), (x + r, y + h - r, 90), (x + r, y + r, 180)):
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return pts[-1:] + pts[:-1]  # from (x + r, y), where the canvas starts it (dashes begin there)


def _ellipse(cx: float, cy: float, rx: float, ry: float, n: int = 96) -> list[tuple[float, float]]:
    return [(cx + rx * math.cos(2 * math.pi * i / n), cy + ry * math.sin(2 * math.pi * i / n)) for i in range(n)]


def _dashes(s: dict, width: float) -> list[float]:
    if s.get("dash") == "dashed":
        return [width * 3, width * 2]
    if s.get("dash") == "dotted":
        return [max(1, width), max(1, width) * 1.5]
    return []


def _stroke_path(layer: Layer, mask: Mask, pts: list[tuple[float, float]], width: float, s: dict, closed: bool) -> None:
    """A stroke along a polyline: solid, dashed or dotted (round caps), as canvas stroke()."""
    path = pts + [pts[0]] if closed else pts
    pattern = _dashes(s, width)
    round_cap = s.get("dash") == "dotted"
    segments: list[list[tuple[float, float]]] = []
    if not pattern:
        segments = [path]
    else:
        on, k, left = True, 0, pattern[0]
        current = [path[0]]
        for (ax, ay), (bx, by) in zip(path, path[1:]):
            length = math.hypot(bx - ax, by - ay)
            pos = 0.0
            while length - pos > left:
                pos += left
                p = (ax + (bx - ax) * pos / length, ay + (by - ay) * pos / length)
                if on:
                    segments.append(current + [p])
                current = [p]
                on, k = not on, (k + 1) % len(pattern)
                left = pattern[k]
            left -= length - pos
            current.append((bx, by))
        if on and len(current) > 1:
            segments.append(current)
    half = width / 2
    for seg in segments:
        for (ax, ay), (bx, by) in zip(seg, seg[1:]):
            length = math.hypot(bx - ax, by - ay)
            if length == 0:
                continue
            nx, ny = -(by - ay) / length * half, (bx - ax) / length * half
            layer.polygon(mask, [(ax + nx, ay + ny), (bx + nx, by + ny), (bx - nx, by - ny), (ax - nx, ay - ny)])
        if round_cap or not pattern:  # round caps for dots; joins for solid polylines
            for x, y in (seg if not pattern else [seg[0], seg[-1]]):
                if round_cap or 0 < len(seg) - 2:
                    layer.polygon(mask, _ellipse(x, y, half, half, 16))


def _draw_rect(layer: Layer, o: dict, w: float, h: float) -> None:
    st = o.get("stroke") or {}
    sw = dots(st.get("width") or 0)
    r = max(0.0, min(dots(o.get("radius") or 0), w / 2, h / 2))
    style = layer.fill_paint(o.get("fill"), w, h)
    if style is not None:
        m = layer.mask()
        layer.polygon(m, _round_rect(0, 0, w, h, r))
        layer.paint(m, style)
    if sw > 0:
        m = layer.mask()
        outline = _round_rect(sw / 2, sw / 2, max(0.0, w - sw), max(0.0, h - sw), max(0.0, r - sw / 2))
        if _dashes(st, sw):
            _stroke_path(layer, m, outline, sw, st, closed=True)
        else:  # the band between the outer and the inner edge
            layer.polygon(m, _round_rect(0, 0, w, h, r))
            layer.polygon(m, _round_rect(sw, sw, max(0.0, w - 2 * sw), max(0.0, h - 2 * sw), max(0.0, r - sw)), fill=0)
        layer.paint(m, _dark(st.get("ink", 100)))


def _draw_ellipse(layer: Layer, o: dict, w: float, h: float) -> None:
    st = o.get("stroke") or {}
    sw = dots(st.get("width") or 0)
    style = layer.fill_paint(o.get("fill"), w, h)
    if style is not None:
        m = layer.mask()
        layer.polygon(m, _ellipse(w / 2, h / 2, w / 2, h / 2))
        layer.paint(m, style)
    if sw > 0:
        m = layer.mask()
        rx, ry = max(0.1, w / 2 - sw / 2), max(0.1, h / 2 - sw / 2)
        if _dashes(st, sw):
            _stroke_path(layer, m, _ellipse(w / 2, h / 2, rx, ry), sw, st, closed=True)
        else:
            layer.polygon(m, _ellipse(w / 2, h / 2, rx + sw / 2, ry + sw / 2))
            layer.polygon(m, _ellipse(w / 2, h / 2, max(0.0, rx - sw / 2), max(0.0, ry - sw / 2)), fill=0)
        layer.paint(m, _dark(st.get("ink", 100)))


def _draw_line(layer: Layer, o: dict, w: float, h: float) -> None:
    st = o.get("stroke") or {}
    sw = max(1.0, dots(st.get("width") or 0.1))
    y = h / 2
    head = max(4.0, sw * 3)
    x0 = head * 0.8 if o.get("arrowStart") else 0.0
    x1 = w - head * 0.8 if o.get("arrowEnd") else w
    m = layer.mask()
    _stroke_path(layer, m, [(x0, y), (x1, y)], sw, st, closed=False)
    if o.get("arrowStart"):
        layer.polygon(m, [(0, y), (head, y - head / 2), (head, y + head / 2)])
    if o.get("arrowEnd"):
        layer.polygon(m, [(w, y), (w - head, y - head / 2), (w - head, y + head / 2)])
    layer.paint(m, _dark(st.get("ink", 100)))


# --------------------------------------------------------------------------- text
@dataclass
class Glyph:
    text: str
    x: float  # pen position from the line start, in dots
    y: float  # offset above the baseline (HarfBuzz y_offset)
    face: fonts.Face


@dataclass
class Shaped:
    width: float
    ascent: float
    descent: float
    glyphs: list[Glyph]


_hb_fonts: dict = {}


def _hb(face: fonts.Face):
    key = (face.path, face.index, face.axes)
    if key not in _hb_fonts:
        hb_face = hb.Face(hb.Blob.from_file_path(face.path), face.index)
        font = hb.Font(hb_face)
        if face.axes:
            try:
                axes = {a.tag: v for a, v in zip(hb_face.axis_infos, face.axes)}
                font.set_variations(axes)
            except (AttributeError, KeyError, TypeError):
                pass
        _hb_fonts[key] = (font, hb_face.upem)
    return _hb_fonts[key]


def _runs(text: str, face: fonts.Face) -> list[tuple[str, fonts.Face]]:
    """The text split by font: characters the face lacks go to a fallback font."""
    runs: list[tuple[str, fonts.Face]] = []
    for ch in text:
        use = face
        if not fonts.has_glyph(face.path, face.index, ch):
            alt = fonts.fallback_for(ch)
            if alt:
                use = fonts.Face(alt[0], alt[1], face.weight, face.italic, face.fake_bold, face.fake_italic, None, "fallback")
        if runs and runs[-1][1] == use:
            runs[-1] = (runs[-1][0] + ch, use)
        else:
            runs.append((ch, use))
    return runs


def shape(text: str, face: fonts.Face, px: float, spacing: float = 0.0) -> Shaped:
    """Positions and metrics of a line of text, as canvas measureText() and fillText().

    Widths come from HarfBuzz (the browser's shaper): advances, kerning, letter spacing after
    every character. Ascent and descent are the bounds of the glyphs as drawn at this size,
    hinted, which is how the browser measures them.
    """
    glyphs, x = [], 0.0
    ascent = descent = None
    for run, use in _runs(text, face):
        font, upem = _hb(use)
        buf = hb.Buffer()
        buf.add_str(run)
        buf.guess_segment_properties()
        hb.shape(font, buf, {"liga": False, "clig": False})
        scale = px / upem
        for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
            ch = run[info.cluster] if info.cluster < len(run) else ""
            glyphs.append(Glyph(ch, x + pos.x_offset * scale, pos.y_offset * scale, use))
            x += pos.x_advance * scale + spacing
        if run.strip():
            box = fonts.load(use, px).getbbox(run, anchor="ls")
            if box[3] > box[1]:
                ascent = -box[1] if ascent is None else max(ascent, -box[1])
                descent = box[3] if descent is None else max(descent, box[3])
    return Shaped(x, ascent or 0, descent or 0, glyphs)


@dataclass
class Line:
    text: str
    width: float
    ascent: float
    descent: float
    y: float
    shaped: Shaped
    words: list = field(default_factory=list)  # [(Shaped, width)] for justified lines
    inner: float = 0.0
    last: bool = False
    x: float = 0.0


@dataclass
class TextLayout:
    lines: list[Line]
    width: float
    top: float
    height: float
    px: float
    face: fonts.Face


def layout_text(o: dict, w: float, h: float, content: str) -> TextLayout:
    """Lines, positions and size of a text box (render.js layoutText). With autoFit the size is
    the largest that fits."""
    pad = dots(o.get("padding") or 0)
    inner_w, inner_h = max(1.0, w - 2 * pad), max(1.0, h - 2 * pad)
    face = fonts.face(o.get("font") or "Segoe UI", bool(o.get("bold")), bool(o.get("italic")))

    def measure(px: float) -> TextLayout:
        spacing = px * float(o.get("spacing") or 0) / 100
        texts = []
        for paragraph in content.split("\n"):
            if not o.get("wrap"):
                texts.append(paragraph)
                continue
            current = ""
            for word in re.split(r"(\s+)", paragraph):
                nxt = current + word
                if current.strip() and shape(nxt.rstrip(), face, px, spacing).width > inner_w:
                    texts.append(current.rstrip())
                    current = word.lstrip()
                else:
                    current = nxt
            texts.append(current.rstrip())
        line_h = px * float(o.get("lineHeight") or 1.05)
        lines = []
        for i, t in enumerate(texts):
            sh = shape(t or " ", face, px, spacing)
            words, inner = [], 0.0
            if o.get("align") == "justify":
                for word in t.split():
                    ws = shape(word, face, px, spacing)
                    words.append((ws, ws.width))
                    inner += ws.width
            lines.append(Line(t, sh.width if t else 0.0, sh.ascent, sh.descent, i * line_h, sh, words, inner, i == len(texts) - 1))
        cap = shape("H", face, px, spacing).ascent
        top = min(l.y - max(l.ascent, cap * 0.7) for l in lines)
        bottom = max(l.y + max(0.0, l.descent) for l in lines)
        return TextLayout(lines, max(l.width for l in lines), top, bottom - top, px, face)

    if o.get("autoFit", True):
        lo, hi = 2.0, max(4.0, inner_h * 2.2)
        for _ in range(16):
            mid = (lo + hi) / 2
            m = measure(mid)
            if m.height <= inner_h and m.width <= inner_w + 0.01:
                lo = mid
            else:
                hi = mid
        fit = measure(lo)
    else:
        fit = measure(float(o.get("size") or 24) * PT)
    valign = o.get("valign")
    offset = (pad - fit.top if valign == "top" else h - pad - fit.height - fit.top if valign == "bottom"
              else (h - fit.height) / 2 - fit.top)
    for line in fit.lines:
        line.y += offset
        line.x = w - pad - line.width if o.get("align") == "right" else (w - line.width) / 2 if o.get("align") == "center" else pad
    return fit


def _fake_bold(px: float) -> float:
    """How far a synthetic bold grows each side of a glyph, as Skia does: 1/24 of the size at
    9 px down to 1/32 from 36 px, stroked across the outline (half each side)."""
    t = max(0.0, min(1.0, (px - 9) / 27))
    return px * (1 / 24 + (1 / 32 - 1 / 24) * t) / 2


def _glyph_mask(lay: TextLayout, o: dict, w: float, ox: float, oy: float, size: tuple[int, int], stroke: float = 0.0) -> Image.Image:
    """The text of a layout as a mask, in a local image whose top-left is local (ox, oy), at SS×."""
    full = size
    k = TEXT_SCALE
    size = (max(1, math.ceil(full[0] * k / SS)), max(1, math.ceil(full[1] * k / SS)))
    mask = Image.new("L", size, 0)
    pad = dots(o.get("padding") or 0)
    for line in lay.lines:
        part = Image.new("L", size, 0) if line.shaped.glyphs and line.shaped.glyphs[0].face.fake_italic else mask
        draw = ImageDraw.Draw(part)
        pieces = [(line.shaped, line.x)]
        if o.get("align") == "justify" and not line.last and len(line.words) > 1:
            gap = (w - 2 * pad - line.inner) / (len(line.words) - 1)
            pieces, x = [], line.x
            for ws, width in line.words:
                pieces.append((ws, x))
                x += width + gap
        for shaped, x0 in pieces:
            for g in shaped.glyphs:
                if not g.text or g.text.isspace():
                    continue
                font = fonts.load(g.face, lay.px * k)
                embolden = _fake_bold(lay.px) * k if g.face.fake_bold else 0.0
                width = stroke * k + embolden
                draw.text(((x0 + g.x - ox) * k, (line.y - g.y - oy) * k), g.text, font=font, fill=255, anchor="ls",
                          stroke_width=width, stroke_fill=255)
        if part is not mask:  # synthetic italic: slant about the baseline, as browsers do
            base = (line.y - oy) * k
            slanted = part.transform(size, Image.AFFINE, (1, 0.25, -0.25 * base, 0, 1, 0), resample=Image.BILINEAR)
            mask.paste(255, (0, 0), slanted)
    return mask if k == SS else mask.resize(full, Image.NEAREST, box=(0, 0, full[0] * k / SS, full[1] * k / SS))


def _draw_text(layer: Layer, o: dict, w: float, h: float, env: dict) -> None:
    pad = dots(o.get("padding") or 0)
    bg = layer.fill_paint(o.get("background"), w, h)
    if bg is not None:
        m = layer.mask()
        layer.polygon(m, _round_rect(0, 0, w, h, max(0.0, min(dots(o.get("radius") or 0), w / 2, h / 2))))
        layer.paint(m, bg)
    content = fields.object_text(o, env)
    if not content.strip():
        return
    lay = layout_text(o, w, h, content)
    st = o.get("stroke") or {}
    sw = dots(st.get("width") or 0)
    ox, oy, size = _text_box(o, w, h, lay, sw)
    if sw > 0:  # the outline goes under the fill, so white outlines read as a halo
        outline = _glyph_mask(lay, o, w, ox, oy, size, stroke=sw)
        layer.paint(layer.place(outline, ox, oy), _dark(st.get("ink", 100)))
    style = layer.fill_paint(o.get("fill"), w, h)
    glyphs = _glyph_mask(lay, o, w, ox, oy, size)
    if style is not None:
        layer.paint(layer.place(glyphs, ox, oy), style)
    if o.get("underline") or o.get("strike"):
        thick = max(1.0, lay.px * 0.07)
        m = layer.mask()
        for line in lay.lines:
            words = o.get("align") == "justify" and not line.last and len(line.words) > 1
            lw = w - 2 * pad if words else line.width
            if o.get("underline"):
                y = line.y + lay.px * 0.1
                layer.polygon(m, [(line.x, y), (line.x + lw, y), (line.x + lw, y + thick), (line.x, y + thick)])
            if o.get("strike"):
                y = line.y - lay.px * 0.28
                layer.polygon(m, [(line.x, y), (line.x + lw, y), (line.x + lw, y + thick), (line.x, y + thick)])
        layer.paint(m, style if style is not None else _dark(st.get("ink", 100)))


def _text_box(o: dict, w: float, h: float, lay: TextLayout, sw: float) -> tuple[float, float, tuple[int, int]]:
    """The local area the text covers, with room for outlines and slanted letters."""
    margin = sw + lay.px * 0.4 + 4
    x0 = min([0.0] + [l.x for l in lay.lines]) - margin
    x1 = max([w] + [l.x + l.width for l in lay.lines]) + margin
    y0 = min(0.0, min(l.y - l.ascent for l in lay.lines)) - margin
    y1 = max(h, max(l.y + l.descent for l in lay.lines)) + margin
    x0, y0 = math.floor(x0), math.floor(y0)
    return x0, y0, (max(1, math.ceil((x1 - x0) * SS)), max(1, math.ceil((y1 - y0) * SS)))


def text_extent(o: dict, env: dict) -> tuple[float, float, float, float] | None:
    """Local bounds of what a text object draws (it can overflow its box)."""
    content = fields.object_text(o, env)
    if not content.strip():
        return None
    w, h = dots(o["w"]), dots(o["h"])
    lay = layout_text(o, w, h, content)
    sw = dots((o.get("stroke") or {}).get("width") or 0)
    x0, y0, size = _text_box(o, w, h, lay, sw)
    return x0, y0, x0 + size[0] / SS, y0 + size[1] / SS


# --------------------------------------------------------------------------- codes and images
_code_cache: dict = {}


def code_modules(o: dict, content: str) -> dict:
    """Bars or modules of a code (the Studio asks the app for the same, codes.py)."""
    kind = o.get("kind") or "qr" if o["type"] == "qr" else o.get("kind") or "code128"
    if o["type"] == "qr":
        version = o.get("version")
        key = ("qr", kind, o.get("ecc"), version, content)
        if key not in _code_cache:
            _code_cache[key] = codes.qr_modules(content, micro=kind == "microqr", ecc=o.get("ecc") or "m",
                                                version=None if version in (None, "", "auto") else version)
    else:
        key = ("bar", kind, content)
        if key not in _code_cache:
            _code_cache[key] = codes.barcode_modules(kind, content)
    code = _code_cache[key]
    if not code.get("ok"):
        raise LabelError(f"{o.get('name') or o['type']}: «{content}» cannot be encoded ({code.get('detail')})")
    return code


def _draw_barcode(layer: Layer, o: dict, w: float, h: float, env: dict) -> None:
    content = fields.expand_all(o.get("content"), env)
    code = code_modules(o, content)
    text_px = float(o.get("textSize") or 6) * PT
    text_pos = o.get("textPos") or "below"
    text_h = 0.0 if text_pos == "none" else text_px * 1.1
    bars = code["bars"]
    n = len(bars)
    module = float(o.get("moduleDots") or 0) or w / n
    if module >= 1:
        module = math.floor(module)
    x0 = js_round((w - module * n) / 2)
    top = math.ceil(text_h) if text_pos == "above" else 0
    bars_h = max(1.0, h - text_h)
    m = layer.mask()
    layer.polygon(m, [(0, 0), (w, 0), (w, h), (0, h)])
    layer.paint(m, 0)  # white behind the code
    m = layer.mask()
    i = 0
    while i < n:
        if bars[i] != "1":
            i += 1
            continue
        j = i
        while j < n and bars[j] == "1":
            j += 1
        layer.polygon(m, [(x0 + i * module, top), (x0 + j * module, top), (x0 + j * module, top + bars_h), (x0 + i * module, top + bars_h)])
        i = j
    if text_pos != "none":
        face = fonts.face(o.get("font") or "Consolas", False, False)
        label = code.get("label") or content
        shaped = shape(label, face, text_px)
        hb_font, upem = _hb(face)
        ext = hb_font.get_font_extents("ltr")
        em = (ext.ascender - ext.descender) or upem
        # canvas textBaseline "bottom"/"top": the em box, split as the font's ascender and descender
        baseline = h - (-ext.descender / em) * text_px if text_pos == "below" else (ext.ascender / em) * text_px
        squeeze = min(1.0, w / shaped.width) if shaped.width else 1.0  # fillText's maxWidth
        x = w / 2 - shaped.width * squeeze / 2
        local = Image.new("L", (max(1, math.ceil(w * SS)), max(1, math.ceil(h * SS))), 0)
        draw = ImageDraw.Draw(local)
        font = fonts.load(face, text_px * SS)
        for g in shaped.glyphs:
            if g.text and not g.text.isspace():
                draw.text(((x + g.x * squeeze) * SS, (baseline - g.y) * SS), g.text, font=font, fill=255, anchor="ls")
        layer.paint(layer.place(local, 0, 0), 255)
    layer.paint(m, 255)


def _draw_qr(layer: Layer, o: dict, w: float, h: float, env: dict) -> None:
    content = fields.expand_all(o.get("content"), env)
    code = code_modules(o, content)
    q = fields.to_number(o.get("quiet"))
    quiet = max(0.0, 0.0 if math.isnan(q) else q)
    matrix = code["matrix"]
    n = len(matrix) + quiet * 2  # modules across, with the quiet zone
    m_ = float(o.get("moduleDots") or 0) or min(w, h) / n
    if m_ >= 1:
        m_ = math.floor(m_)
    x0 = js_round((w - m_ * n) / 2) + quiet * m_
    y0 = js_round((h - m_ * n) / 2) + quiet * m_
    dark, light = (0, 255) if o.get("invert") else (255, 0)
    m = layer.mask()
    a, b = x0 - quiet * m_, y0 - quiet * m_
    layer.polygon(m, [(a, b), (a + m_ * n, b), (a + m_ * n, b + m_ * n), (a, b + m_ * n)])
    layer.paint(m, light)
    m = layer.mask()
    for y, row in enumerate(matrix):
        for x, bit in enumerate(row):
            if bit == "1":
                px, py = x0 + x * m_, y0 + y * m_
                layer.polygon(m, [(px, py), (px + m_, py), (px + m_, py + m_), (px, py + m_)])
    layer.paint(m, dark)


def _adjusted(o: dict, src: Image.Image) -> Image.Image:
    """The image in greys with levels, brightness, contrast, gamma and invert (adjustPixels), with its alpha."""
    scale = min(1.0, 1600 / max(src.width, src.height))
    img = src.convert("RGBA")
    if scale < 1:
        img = img.resize((max(1, js_round(src.width * scale)), max(1, js_round(src.height * scale))), Image.LANCZOS)
    alpha = img.getchannel("A")
    rgba = img.tobytes()
    lum = [0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2] for i in range(0, len(rgba), 4)]
    lo, hi = 0, 255
    if o.get("autoLevels", True):
        hist = [0] * 256
        visible = [v for v, a in zip(lum, alpha.tobytes()) if a > 127]
        for v in visible:
            hist[int(v)] += 1
        total = len(visible)
        if total:
            acc, lo = 0, 0
            while lo < 255:
                acc += hist[lo]
                if acc >= total * 0.01:
                    break
                lo += 1
            acc, hi = 0, 255
            while hi > 0:
                acc += hist[hi]
                if acc >= total * 0.01:
                    break
                hi -= 1
            if hi - lo < 16:
                lo, hi = 0, 255
    b = float(o.get("brightness") or 0) * 2.55
    c = float(o.get("contrast") or 0) * 2.55
    factor = (259 * (c + 255)) / (255 * (259 - c))
    gamma = 1 / max(0.1, float(o.get("gamma") or 1))
    lut = []
    for v in range(256):
        x = ((v - lo) * 255) / max(1, hi - lo)
        x = factor * (x + b - 128) + 128
        x = 255 * math.pow(min(1.0, max(0.0, x / 255)), gamma)
        lut.append(max(0, min(255, round(255 - x if o.get("invert") else x))))
    grey_img = Image.new("L", img.size)
    grey_img.putdata([lut[max(0, min(255, js_round(v)))] for v in lum])
    out = Image.merge("LA", (grey_img, alpha))
    return out


_images: dict = {}


def _decode(data_url: str) -> Image.Image:
    if data_url not in _images:
        raw = base64.b64decode(data_url.partition(",")[2])
        _images[data_url] = Image.open(io.BytesIO(raw)).copy()
    return _images[data_url]


def _draw_image(layer: Layer, o: dict, w: float, h: float, env: dict) -> None:
    src = (env.get("doc") or {}).get("assets", {}).get(o.get("asset") or "")
    if not src:
        raise LabelError(f"{o.get('name') or 'image'}: the image is missing from the file")
    img = _adjusted(o, _decode(src))
    ratio = img.width / img.height
    dw, dh = w, h
    if o.get("fit") == "contain":
        if w / h > ratio:
            dw = h * ratio
        else:
            dh = w / ratio
    elif o.get("fit") == "cover":
        if w / h > ratio:
            dh = w / ratio
        else:
            dw = h * ratio
    size = (max(1, math.ceil(w * SS)), max(1, math.ceil(h * SS)))
    scaled = img.resize((max(1, round(dw * SS)), max(1, round(dh * SS))), Image.BICUBIC)
    if o.get("flipH"):
        scaled = scaled.transpose(Image.FLIP_LEFT_RIGHT)
    if o.get("flipV"):
        scaled = scaled.transpose(Image.FLIP_TOP_BOTTOM)
    local = Image.new("LA", size, (255, 0))
    local.paste(scaled, (round((w - dw) / 2 * SS), round((h - dh) / 2 * SS)))
    grey_img, alpha = local.split()
    dark = layer.place(Image.eval(grey_img, lambda v: 255 - v), 0, 0)
    layer.paint(layer.place(alpha, 0, 0), dark)


DRAW = {"rect": _draw_rect, "ellipse": _draw_ellipse, "line": _draw_line}


# --------------------------------------------------------------------------- dithering
DITHERS = ["auto", "threshold", "floyd", "atkinson", "stucki", "bayer4", "bayer8", "halftone", "lines", "noise"]


def dither_mode(o: dict) -> str:
    """The dithering of an object; "auto" is crisp black for flat ink and dots for greys."""
    if o["type"] in ("qr", "barcode"):
        return "threshold"
    mode = (o.get("dither") or {}).get("mode") or "auto"
    if mode != "auto":
        return mode
    if o["type"] == "image":
        return "atkinson"
    if o["type"] == "text" and re.search("emoji", o.get("font") or "", re.I):
        return "atkinson"

    def greyish(f):
        if not f:
            return False
        ink = float(f.get("ink", 100) or 0)
        return f.get("type") == "gradient" or (f.get("type") in ("solid", "grey", "pattern") and 0 < ink < 100)
    st = o.get("stroke") or {}
    if greyish(o.get("fill")) or greyish(o.get("background")) or (st.get("width") and 0 < float(st.get("ink", 100) or 0) < 100):
        return "bayer8"
    return "threshold"


def _bayer(n: int) -> list[list[float]]:
    m = [[0]]
    while len(m) < n:
        s = len(m)
        nxt = [[0] * (s * 2) for _ in range(s * 2)]
        for y in range(s):
            for x in range(s):
                v = m[y][x] * 4
                nxt[y][x], nxt[y][x + s], nxt[y + s][x], nxt[y + s][x + s] = v, v + 2, v + 3, v + 1
        m = nxt
    return [[((v + 0.5) / (n * n)) * 255 for v in row] for row in m]


BAYER4, BAYER8 = _bayer(4), _bayer(8)
KERNELS = {
    "floyd": [(1, 0, 7 / 16), (-1, 1, 3 / 16), (0, 1, 5 / 16), (1, 1, 1 / 16)],
    "atkinson": [(1, 0, 1 / 8), (2, 0, 1 / 8), (-1, 1, 1 / 8), (0, 1, 1 / 8), (1, 1, 1 / 8), (0, 2, 1 / 8)],
    "stucki": [(x, y, v / 42) for x, y, v in [(1, 0, 8), (2, 0, 4), (-2, 1, 2), (-1, 1, 4), (0, 1, 8), (1, 1, 4), (2, 1, 2),
                                              (-2, 2, 1), (-1, 2, 2), (0, 2, 4), (1, 2, 2), (2, 2, 1)]],
}


def _imul(a: int, b: int) -> int:
    """Math.imul: 32-bit signed multiplication."""
    r = (a * b) & 0xFFFFFFFF
    return r - 0x100000000 if r & 0x80000000 else r


def _i32(v: int) -> int:
    v &= 0xFFFFFFFF
    return v - 0x100000000 if v & 0x80000000 else v


def dither(grey_map: list[float], mask: list[int], W: int, H: int, mode: str, opts: dict, X0: int = 0, Y0: int = 0) -> list[int]:
    """Greys (0 black … 255 white) into dots (1 = black) where `mask` is set. Ordered methods are
    anchored to the label (X0, Y0: the region's place on it), so neighbouring objects line up."""
    out = [0] * (W * H)
    bias = float(opts.get("threshold", 128) if opts.get("threshold") is not None else 128) - 128
    if mode in KERNELS:
        g = list(grey_map)
        kernel = KERNELS[mode]
        for y in range(H):
            reverse = mode == "floyd" and (y + Y0) % 2 == 1
            for i in range(W):
                x = W - 1 - i if reverse else i
                p = y * W + x
                if not mask[p]:
                    continue
                black = g[p] < 128 + bias
                out[p] = 1 if black else 0
                err = g[p] - (0 if black else 255)
                for dx, dy, wgt in kernel:
                    nx, ny = x + (-dx if reverse else dx), y + dy
                    if nx < 0 or nx >= W or ny >= H:
                        continue
                    q = ny * W + nx
                    if mask[q]:
                        g[q] += err * wgt
        return out
    cell = max(2.0, float(opts.get("cell") or 6))
    a = math.radians(float(opts.get("angle", 45) if opts.get("angle") is not None else 45))
    ca, sa = math.cos(a), math.sin(a)
    for y in range(H):
        Y = y + Y0
        for x in range(W):
            p = y * W + x
            if not mask[p]:
                continue
            X = x + X0
            if mode == "threshold":
                t = 128 + bias
            elif mode == "bayer4":
                t = BAYER4[Y & 3][X & 3] + bias
            elif mode == "bayer8":
                t = BAYER8[Y & 7][X & 7] + bias
            elif mode == "halftone":
                u, w = (X * ca + Y * sa) / cell, (-X * sa + Y * ca) / cell
                t = (1 - ((math.cos(2 * math.pi * u) + math.cos(2 * math.pi * w)) / 4 + 0.5)) * 255 + bias
            elif mode == "lines":
                w = (-X * sa + Y * ca) / cell
                t = (1 - (math.cos(2 * math.pi * w) + 1) / 2) * 255 + bias
            elif mode == "noise":
                s = _i32(X * 374761393 + Y * 668265263)
                s = _imul(s ^ ((s & 0xFFFFFFFF) >> 13), 1274126177)
                t = (((s ^ ((s & 0xFFFFFFFF) >> 16)) & 0xFFFFFFFF) / 4294967296) * 255 + bias
            else:
                t = 128 + bias
            out[p] = 1 if grey_map[p] < t else 0
    return out


# --------------------------------------------------------------------------- the label
def _local_extent(o: dict, env: dict) -> tuple[float, float, float, float]:
    w, h = dots(o["w"]), dots(o["h"])
    sw = dots((o.get("stroke") or {}).get("width") or 0)
    margin = sw + 2
    x0, y0, x1, y1 = -margin, -margin, w + margin, h + margin
    if o["type"] == "line":
        y0, y1 = min(y0, h / 2 - sw * 3 - 2), max(y1, h / 2 + sw * 3 + 2)
    if o["type"] == "text":
        ext = text_extent(o, env)
        if ext:
            x0, y0, x1, y1 = min(x0, ext[0]), min(y0, ext[1]), max(x1, ext[2]), max(y1, ext[3])
    return x0, y0, x1, y1


def rasterize(doc: dict, env: dict) -> Raster:
    """The label as the printer gets it (render.js rasterize)."""
    env = {**env, "doc": doc}
    objects = fields.layout_for(doc, env)
    W, H = document.mm_to_dots(document.label_length(doc, objects)), HEAD_DOTS
    bits = bytearray(W * H)
    for o in objects:
        w, h = dots(o["w"]), dots(o["h"])
        lx0, ly0, lx1, ly1 = _local_extent(o, env)
        probe = Frame(o, 0, 0, 1, 1)
        pts = [probe.to_label(x, y) for x, y in ((lx0, ly0), (lx1, ly0), (lx1, ly1), (lx0, ly1))]
        x0, y0 = max(0, math.floor(min(p[0] for p in pts))), max(0, math.floor(min(p[1] for p in pts)))
        x1, y1 = min(W, math.ceil(max(p[0] for p in pts))), min(H, math.ceil(max(p[1] for p in pts)))
        if x1 <= x0 or y1 <= y0:
            continue
        layer = Layer(Frame(o, x0, y0, x1, y1))
        if o["type"] == "text":
            _draw_text(layer, o, w, h, env)
        elif o["type"] == "barcode":
            _draw_barcode(layer, o, w, h, env)
        elif o["type"] == "qr":
            _draw_qr(layer, o, w, h, env)
        elif o["type"] == "image":
            _draw_image(layer, o, w, h, env)
        elif o["type"] in DRAW:
            DRAW[o["type"]](layer, o, w, h)
        alpha, ink = layer.reduced()
        rw, rh = alpha.size
        a_data, k_data = alpha.tobytes(), ink.tobytes()
        white_empty = o["type"] == "image" and o.get("whiteEmpty", True)
        grey_map = [255.0] * (rw * rh)
        mask = [0] * (rw * rh)
        soft = [0] * (rw * rh)
        any_ink = False
        for i, a in enumerate(a_data):
            if not a:
                continue
            g = 255 - k_data[i]
            if white_empty and g >= 245:
                continue
            any_ink = True
            soft[i], mask[i], grey_map[i] = a, 1, float(g)
        if not any_ink:
            continue
        layer_bits = dither(grey_map, mask, rw, rh, dither_mode(o), o.get("dither") or {}, x0, y0)
        for y in range(rh):
            row = (y0 + y) * W + x0
            for x in range(rw):
                i = y * rw + x
                s = soft[i]
                if s >= 128:
                    bits[row + x] = layer_bits[i]
                elif s and layer_bits[i]:
                    bits[row + x] = 1
    img = Image.frombytes("L", (W, H), bytes(0 if b else 255 for b in bits))
    return Raster(W, H, img, objects)
