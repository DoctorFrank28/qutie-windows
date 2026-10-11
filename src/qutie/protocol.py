"""Qutie command set (the HPRT Q2 speaks the same one).

Worked out, for interoperability, by studying how the official HerePrint app talks to
the printer: 203 dpi, a 96-dot head, 720-byte raster packets, Bluetooth classic SPP
with an optional XOR-key handshake.
"""

from __future__ import annotations

from dataclasses import dataclass

from PIL import Image

from . import lzo

DPI = 203
DOTS_PER_MM = DPI / 25.4
WIDTH_DOTS = 96  # print head: 12 mm
BYTES_PER_ROW = WIDTH_DOTS // 8
PACKET = 720  # uncompressed raster bytes per block (60 rows)
FEED_MM = 14  # feed of the app's "feed" button
EXTRA_MM = 10  # extra feed after the end of a label: with GS f alone the last printed part stays under the cutter

ESC, FS, GS = 0x1B, 0x1C, 0x1D

CMD_STATUS = bytes([ESC, 0x12, ord("s")])  # reply: 17 bytes
CMD_INFO = bytes([ESC, 0x12, ord("d")])  # reply: 143 bytes
CMD_CANCEL = bytes([ESC, 0x12, ord("C")]) * 2


def mm_to_dots(mm: float) -> int:
    return int(mm * DOTS_PER_MM)


def handshake(k1: int, k2: int) -> bytes:
    """ESC FS "set mm" k1 k2. If the printer answers OK, every following write is
    XORed with (k1 + k2) & 0xFF; if it answers NG the link stays in clear.
    The printer also accepts plain data without any handshake."""
    return bytes([ESC, FS]) + b"set mm" + bytes([k1, k2])


def density(value: int) -> bytes:
    if not 0 <= value <= 255:
        raise ValueError("density out of range 0-255")
    return bytes([GS]) + b"setc" + bytes([value])


def speed(value: int) -> bytes:
    if not 1 <= value <= 30:
        raise ValueError("speed out of range 1-30")
    return bytes([GS]) + b"sets" + bytes([value])


AUTO_OFF_CHOICES = (10, 15, 30, 60, 180, 240)  # minutes; the app offers 10/30/60/180/240, the factory value is 15


def auto_off(minutes: int) -> bytes:
    """GS "sett" nL nH: power off after n seconds of inactivity."""
    seconds = minutes * 60
    if not 0 <= seconds <= 0xFFFF:
        raise ValueError("auto-off time out of range")
    return bytes([GS]) + b"sett" + seconds.to_bytes(2, "little")


def alignment(value: int = 1) -> bytes:
    """ESC a n: 0 left, 1 centre, 2 right (the app sends 1)."""
    return bytes([ESC, ord("a"), value])


def end_of_label(length_mm: float) -> bytes:
    """GS f nL nH: finishes a gap label that is n dots long."""
    n = mm_to_dots(length_mm)
    return bytes([GS, ord("f")]) + n.to_bytes(2, "little")


def feed(mm: float) -> bytes:
    """ESC ESC 1 nL nH: feeds the paper by n dots."""
    n = mm_to_dots(mm)
    if not 0 <= n <= 0xFFFF:
        raise ValueError("feed out of range")
    return bytes([ESC, ESC, 1]) + n.to_bytes(2, "little")


def raster(img: Image.Image) -> bytes:
    """1-bit rows, most significant bit on the left, 1 = black dot.

    The image must be WIDTH_DOTS wide. Mode "1" images (e.g. dithered) are used as
    they are; anything else uses the SDK threshold: black if the mean RGB is < 128.
    """
    if img.width != WIDTH_DOTS:
        raise ValueError(f"the image must be {WIDTH_DOTS} dots wide, not {img.width}")
    if img.mode != "1":
        img = img.convert("L").point(lambda v: 255 if v >= 128 else 0, mode="1")
    # In Pillow mode "1" is 1 for white: invert to get 1 = black.
    return bytes(b ^ 0xFF for b in img.tobytes())


def raster_blocks(data: bytes, bytes_per_row: int = BYTES_PER_ROW, packet: int = PACKET) -> list[bytes]:
    """Split the raster into LZO-compressed GS v 0 0 blocks, like the SDK's printBitmap.

    Block: 1D 76 30 30 | width in bytes (2) | rows (2) | LZO length (4) | LZO data
    """
    step = (packet // bytes_per_row) * bytes_per_row
    blocks = []
    for start in range(0, len(data), step):
        chunk = data[start:start + step]
        packed = lzo.compress(chunk)
        rows = len(chunk) // bytes_per_row
        blocks.append(
            bytes([GS, ord("v"), ord("0"), ord("0")])
            + bytes_per_row.to_bytes(2, "little")
            + rows.to_bytes(2, "little")
            + len(packed).to_bytes(4, "little")
            + packed
        )
    return blocks


def job(
    img: Image.Image,
    *,
    length_mm: float | None,
    feed_mm: float = FEED_MM,
    extra_mm: float = EXTRA_MM,
    print_density: int | None = None,
) -> list[bytes]:
    """Writes that print one label.

    length_mm: length of a gap label; None for continuous paper (then the paper is
    fed by feed_mm at the end). extra_mm: extra feed after the end of a gap label.
    """
    writes = []
    if print_density is not None:
        writes.append(density(print_density))
    writes.append(alignment(1))
    writes.extend(raster_blocks(raster(img)))
    if length_mm is not None:
        writes.append(end_of_label(length_mm))
        if extra_mm > 0:
            writes.append(feed(extra_mm))
    else:
        writes.append(feed(feed_mm))
    return writes


@dataclass
class Status:
    code: int
    battery: int
    auto_off_min: int
    density: int
    paper_type: int
    raw: bytes

    @classmethod
    def from_bytes(cls, b: bytes) -> Status:
        if len(b) < 8:
            raise ValueError(f"status reply too short ({len(b)} bytes)")
        return cls(
            # The app concatenates the decimal digits of b[1] and b[0]; same here.
            code=int(f"{b[1]}{b[0]}"),
            battery=b[3],
            auto_off_min=int.from_bytes(b[4:6], "little") // 60,
            density=b[6],
            paper_type=b[7],
            raw=bytes(b),
        )


def _text(b: bytes) -> str:
    return b.rstrip(b"\x00\xff").decode("ascii", "replace").strip()


@dataclass
class Info:
    model: str
    serial: str
    firmware: str
    board: str
    bt_firmware: str
    raw: bytes

    @classmethod
    def from_bytes(cls, b: bytes) -> Info:
        if len(b) < 124:
            raise ValueError(f"info reply too short ({len(b)} bytes)")
        fw = b[88:91]
        bd = b[91:94]
        return cls(
            model="".join(c for c in _text(b[32:56]) if c.isalnum() or c in " -"),
            serial=_text(b[56:88]),
            firmware=f"{fw[0]}.{fw[1]}.{fw[2]}",
            board=f"{bd[0]}.{bd[1]:02d}.{bd[2]:02d}",
            bt_firmware=_text(b[112:124]),
            raw=bytes(b),
        )
