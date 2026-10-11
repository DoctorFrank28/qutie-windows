"""Reads the byte stream produced by the Windows driver, for the print preview.

The driver (QUTIE.GPD) emits: optional job/document setup (ESC a, GS setc, GS sett),
then for each page the raster blocks (GS v 0 0), and the end of the page: GS f for
gap labels and/or ESC ESC 1 for the tape feed. A label ends at GS f, or at the feed
when there is no GS f (continuous tape).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from PIL import Image

from . import lzo
from .protocol import BYTES_PER_ROW, ESC, GS, WIDTH_DOTS, mm_to_dots, raster, raster_blocks


@dataclass
class Label:
    rows: list[bytes] = field(default_factory=list)
    length_dots: int | None = None  # from GS f; None on continuous tape
    feed_dots: int = 0

    def image(self) -> Image.Image:
        """The label as printed: WIDTH_DOTS wide, one image row per printed row."""
        width = max((len(r) for r in self.rows), default=WIDTH_DOTS // 8) * 8
        img = Image.new("1", (width, max(1, len(self.rows))), 1)
        px = img.load()
        for y, row in enumerate(self.rows):
            for x in range(len(row) * 8):
                if row[x // 8] & (0x80 >> (x % 8)):
                    px[x, y] = 0
        return img


    def trimmed(self, margin_dots: int) -> Label:
        """The label without the blank rows before and after the content (continuous tape)."""
        inked = [i for i, row in enumerate(self.rows) if any(row)]
        if not inked:
            return Label([], self.length_dots, self.feed_dots)
        start = max(0, inked[0] - margin_dots)
        end = min(len(self.rows), inked[-1] + 1 + margin_dots)
        return Label(self.rows[start:end], self.length_dots, self.feed_dots)


@dataclass
class Job:
    setup: bytes = b""  # commands before the first raster block (alignment, density, auto off)
    labels: list[Label] = field(default_factory=list)
    data: bytes = b""

    @property
    def blank(self) -> bool:
        return not any(any(row) for label in self.labels for row in label.rows)


    @property
    def continuous(self) -> bool:
        return bool(self.labels) and all(label.length_dots is None for label in self.labels)

    @property
    def wide(self) -> bool:
        """Pages wider than the tape: the "Fit to tape" paper size of the driver."""
        return any(len(row) > BYTES_PER_ROW for label in self.labels for row in label.rows)

    def fit_to_content(self, margin_mm: float = 2, same_height: bool = True) -> Job:
        """Make the labels fit the tape and, on continuous tape, as long as their content.

        - "Fit to tape" pages (wider than the tape): the content is cropped and scaled
          to the 12 mm tape, and the label is as long as it needs to be. With
          `same_height` every page of the job gets the same scale, so text of one size
          in the app has one size on every label; otherwise each page fills the tape.
        - Continuous tape: apps print on a fixed page size, so the white space after
          the content would be wasted tape; it is cut down to `margin_mm`.
        Gap labels printed at their own size are left untouched.
        """
        if self.blank or not (self.continuous or self.wide):
            return self  # a blank page stays as it is, so the preview can say so
        margin = mm_to_dots(margin_mm)
        labels = _shrink(self.labels, same_height) if self.wide else self.labels
        labels = [label.trimmed(margin) for label in labels]
        labels = [label for label in labels if label.rows]
        data = self.setup + b"".join(_encode(label) for label in labels)
        return Job(setup=self.setup, labels=labels, data=data)


def _shrink(labels: list[Label], same_height: bool) -> list[Label]:
    """Crop wide pages to their content and scale them to the tape (continuous labels).

    With `same_height` every page is cropped to the same band across the tape (from
    the highest to the lowest content of the whole job) and scaled alike, so a row
    of a spreadsheet split over two pages stays at the same place on both labels.
    """
    from . import render

    pages = []
    for label in labels:
        page = _without_row_padding(label.image().convert("L"))
        box = page.point(lambda v: 255 if v < 200 else 0).getbbox()
        if box is not None:
            pages.append((label, page, box))
    if not pages:
        return []
    # One direction for the whole job: content laid out along the page width runs
    # along the tape, like text in landscape.
    turn = sum(b[2] - b[0] for _, _, b in pages) > sum(b[3] - b[1] for _, _, b in pages)
    if same_height:
        # The axis across the tape is y when the page is turned, x otherwise.
        lo, hi = (1, 3) if turn else (0, 2)
        start, end = min(b[lo] for _, _, b in pages), max(b[hi] for _, _, b in pages)
        boxes = [(b[0], start, b[2], end) if turn else (start, b[1], end, b[3]) for _, _, b in pages]
    else:
        boxes = [b for _, _, b in pages]
    crops = [(label, page.crop(box)) for (label, page, _), box in zip(pages, boxes)]
    if turn:
        crops = [(label, crop.rotate(render.ROTATE, expand=True)) for label, crop in crops]
    widest = max(crop.width for _, crop in crops)
    result = []
    for label, crop in crops:
        # Same height: one scale for every page (all crops share the band across the tape).
        scale = WIDTH_DOTS / (widest if same_height else crop.width)
        size = (max(1, min(WIDTH_DOTS, round(crop.width * scale))), max(1, round(crop.height * scale)))
        canvas = Image.new("L", (WIDTH_DOTS, size[1]), 255)
        canvas.paste(crop.resize(size, Image.LANCZOS), ((WIDTH_DOTS - size[0]) // 2, 0))
        raw = raster(canvas)
        rows = [raw[i:i + BYTES_PER_ROW] for i in range(0, len(raw), BYTES_PER_ROW)]
        result.append(Label(rows, None, label.feed_dots))
    return result


def _without_row_padding(page: Image.Image) -> Image.Image:
    """Whiten the padding at the right edge of every row.

    Unidrv rounds each row up to whole bytes and fills the spare bits with 1 (black):
    on a page 1183 dots wide that is a black line down the right edge, which would
    otherwise count as content. Only the last 7 columns can be padding, and only
    columns that are black from top to bottom are cleared.
    """
    width, height = page.size
    px = page.load()
    for x in range(width - 1, max(-1, width - 8), -1):
        if any(px[x, y] >= 128 for y in range(height)):
            break
        for y in range(height):
            px[x, y] = 255
    return page


def _encode(label: Label) -> bytes:
    """Raster blocks and end-of-label commands of one label, as the driver sends them."""
    out = b"".join(raster_blocks(b"".join(label.rows), bytes_per_row=len(label.rows[0])))
    if label.length_dots is not None:
        out += bytes([GS, ord("f")]) + label.length_dots.to_bytes(2, "little")
    if label.feed_dots:
        out += bytes([ESC, ESC, 1]) + label.feed_dots.to_bytes(2, "little")
    return out


def parse(data: bytes) -> Job:
    job = Job(data=data)
    current = Label()
    i, n = 0, len(data)
    seen_raster = False
    while i < n:
        if data[i:i + 4] == bytes([GS, ord("v"), ord("0"), ord("0")]) and i + 12 <= n:
            width = int.from_bytes(data[i + 4:i + 6], "little")
            height = int.from_bytes(data[i + 6:i + 8], "little")
            size = int.from_bytes(data[i + 8:i + 12], "little")
            raw = lzo.decompress(data[i + 12:i + 12 + size])
            current.rows.extend(raw[r * width:(r + 1) * width] for r in range(height))
            seen_raster = True
            i += 12 + size
        elif data[i:i + 2] == bytes([GS, ord("f")]) and i + 4 <= n:
            current.length_dots = int.from_bytes(data[i + 2:i + 4], "little")
            i += 4
            # A feed may follow (TapeFeed): attach it to this label before closing it.
            if data[i:i + 3] == bytes([ESC, ESC, 1]) and i + 5 <= n:
                current.feed_dots = int.from_bytes(data[i + 3:i + 5], "little")
                i += 5
            job.labels.append(current)
            current = Label()
        elif data[i:i + 3] == bytes([ESC, ESC, 1]) and i + 5 <= n:
            current.feed_dots = int.from_bytes(data[i + 3:i + 5], "little")
            i += 5
            if current.rows:  # continuous tape: the feed closes the label
                job.labels.append(current)
                current = Label()
        else:
            step = _command_length(data, i)
            if not seen_raster:
                job.setup += data[i:i + step]
            i += step
    if current.rows:
        job.labels.append(current)
    return job


def _command_length(data: bytes, i: int) -> int:
    """Length of the known non-raster command at i (1 for anything unknown)."""
    if data[i:i + 2] == bytes([ESC, ord("a")]):
        return 3
    if data[i:i + 5] == bytes([GS]) + b"setc":
        return 6
    if data[i:i + 5] == bytes([GS]) + b"sett":
        return 7
    return 1
