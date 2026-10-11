"""The Qutie icon: a white tag on a dark rounded square, in shadcn's neutral style."""

from __future__ import annotations

from PIL import Image, ImageDraw


def draw(side: int = 256) -> Image.Image:
    s = side / 256
    img = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((8 * s, 8 * s, side - 8 * s, side - 8 * s), radius=56 * s, fill=(23, 23, 23, 255))
    d.rounded_rectangle((48 * s, 92 * s, 208 * s, 164 * s), radius=14 * s, fill=(250, 250, 250, 255))
    d.ellipse((62 * s, 120 * s, 78 * s, 136 * s), fill=(23, 23, 23, 255))
    for i, width in enumerate((92, 64)):
        y = (112 + i * 22) * s
        d.rounded_rectangle((96 * s, y, (96 + width) * s, y + 10 * s), radius=5 * s, fill=(23, 23, 23, 255))
    return img
