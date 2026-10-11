"""Text and images → a 96-dot-wide image, ready for protocol.raster().

Text runs along the label: it is drawn on a landscape canvas (length × 96) and then
rotated, because the head prints 96-dot rows.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

from .protocol import WIDTH_DOTS, mm_to_dots

# Content turns 90° clockwise onto the tape (PIL angles are counter-clockwise), like
# the driver's landscape orientation (LANDSCAPE_CC270): the start of the text is
# printed first, so a strip of labels reads in the order it was printed.
ROTATE = 270

FONT_DIR = Path(r"C:\Windows\Fonts")
DEFAULT_FONT = "arialbd.ttf"


def load_font(name: str | None, size: int) -> ImageFont.FreeTypeFont:
    name = name or DEFAULT_FONT
    for path in (Path(name), FONT_DIR / name, FONT_DIR / f"{name}.ttf"):
        if path.is_file():
            return ImageFont.truetype(str(path), size)
    return ImageFont.truetype(name, size)  # let Pillow look it up, or raise


def _measure(content: str, font, spacing: int) -> tuple[int, int, tuple[int, int, int, int]]:
    probe = ImageDraw.Draw(Image.new("L", (1, 1)))
    box = probe.multiline_textbbox((0, 0), content, font=font, spacing=spacing, align="center")
    return box[2] - box[0], box[3] - box[1], box


def text(
    content: str,
    *,
    length_mm: float | None = 40,
    font: str | None = None,
    size: int | None = None,
    margin_mm: float = 2,
    rotate: int = ROTATE,
) -> Image.Image:
    """A text label. With length_mm=None (continuous paper) the length follows the text.

    Without `size` the font is the largest that fits the label. `\\n` breaks the line
    (two lines fit comfortably on 12 mm).
    """
    height = WIDTH_DOTS
    margin = mm_to_dots(margin_mm)
    spacing = 4
    length = mm_to_dots(length_mm) if length_mm else None

    if size is None:
        size = 8
        for s in range(8, 200):
            f = load_font(font, s)
            w, h, _ = _measure(content, f, spacing)
            if h > height - 4 or (length and w > length - 2 * margin):
                break
            size = s
    f = load_font(font, size)
    w, h, box = _measure(content, f, spacing)
    if length is None:
        length = w + 2 * margin

    canvas = Image.new("L", (length, height), 255)
    draw = ImageDraw.Draw(canvas)
    x = (length - w) / 2 - box[0]
    y = (height - h) / 2 - box[1]
    draw.multiline_text((x, y), content, font=f, fill=0, spacing=spacing, align="center")
    return canvas.rotate(rotate, expand=True)


def image(
    path: str | Path,
    *,
    length_mm: float | None = 40,
    rotate: int = ROTATE,
    dither: bool = False,
) -> Image.Image:
    """Fit an image file to the label (landscape images are turned like text)."""
    img = ImageOps.exif_transpose(Image.open(path))
    return fit(to_gray(img), length_mm=length_mm, rotate=rotate, dither=dither)


def to_gray(img: Image.Image) -> Image.Image:
    """Greyscale on a white background (transparency becomes white)."""
    if img.mode in ("RGBA", "LA", "P", "PA"):
        img = img.convert("RGBA")
        background = Image.new("RGBA", img.size, (255, 255, 255, 255))
        img = Image.alpha_composite(background, img)
    return img.convert("L")


def crop(img: Image.Image, threshold: int = 245, border: int = 0) -> Image.Image | None:
    """Remove the white around the content; None if the page is blank."""
    box = img.point(lambda v: 255 if v < threshold else 0).getbbox()
    if box is None:
        return None
    x0, y0, x1, y1 = box
    return img.crop((max(0, x0 - border), max(0, y0 - border), min(img.width, x1 + border), min(img.height, y1 + border)))


def fit(
    img: Image.Image,
    *,
    length_mm: float | None = 40,
    rotate: int = ROTATE,
    dither: bool = False,
    margin_mm: float = 1,
) -> Image.Image:
    """Put a greyscale image on the label: long side along the label, centred, undistorted.

    `dither` uses Floyd-Steinberg (better for photos); otherwise the printer threshold applies.
    """
    img = img.convert("L")
    if img.width > img.height:
        img = img.rotate(rotate, expand=True)

    length = mm_to_dots(length_mm) if length_mm else None
    margin = mm_to_dots(margin_mm) if length else 0
    scale = WIDTH_DOTS / img.width
    if length and img.height * scale > length - 2 * margin:
        scale = (length - 2 * margin) / img.height
    resized = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)

    canvas = Image.new("L", (WIDTH_DOTS, length or resized.height), 255)
    canvas.paste(resized, ((WIDTH_DOTS - resized.width) // 2, (canvas.height - resized.height) // 2))
    return canvas.convert("1") if dither else canvas


def preview(img: Image.Image, rotate: int = ROTATE) -> Image.Image:
    """The label as you read it (landscape), 4× larger, with the printer threshold."""
    if img.mode != "1":
        img = img.convert("L").point(lambda v: 255 if v >= 128 else 0, mode="1")
    readable = img.rotate(-rotate, expand=True).convert("L")
    return readable.resize((readable.width * 4, readable.height * 4), Image.NEAREST)
