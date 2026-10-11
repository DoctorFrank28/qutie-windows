import random
import re
from pathlib import Path

import pytest
from PIL import Image

from qutie import lzo, protocol, render

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("n", [0, 1, 3, 4, 17, 238, 239, 240, 272, 273, 527, 528, 720, 5000])
def test_lzo_round_trip(n):
    data = bytes(random.Random(n).randrange(256) for _ in range(n))
    assert lzo.decompress(lzo.compress(data)) == data


def test_lzo_decompresses_matches():
    # Hand-made stream: 4 literals "abcd", then an M2 match copying 3 bytes from
    # distance 4, then the end. M2: t >= 64, length (t>>5)+1 = 3 -> t>>5 = 2;
    # distance 1 + ((t>>2)&7) + (b<<3) = 4 -> (t>>2)&7 = 3.
    t = (2 << 5) | (3 << 2)
    stream = bytes([17 + 4]) + b"abcd" + bytes([t, 0]) + lzo.END_OF_STREAM
    assert lzo.decompress(stream) == b"abcdabc"


def test_commands():
    assert protocol.handshake(5, 7) == b"\x1b\x1cset mm\x05\x07"
    assert protocol.density(75) == b"\x1dsetc\x4b"
    assert protocol.end_of_label(40) == b"\x1df" + (319).to_bytes(2, "little")
    assert protocol.feed(14) == b"\x1b\x1b\x01" + (111).to_bytes(2, "little")


def test_raster_bits_and_threshold():
    img = Image.new("L", (96, 2), 255)
    img.putpixel((0, 0), 0)  # first dot of the first row
    img.putpixel((95, 1), 127)  # last dot of the second row, below threshold = black
    img.putpixel((50, 1), 128)  # above threshold = white
    r = protocol.raster(img)
    assert len(r) == 24
    assert r[0] == 0x80 and r[11] == 0
    assert r[12:23] == bytes(11) and r[23] == 0x01


def test_raster_blocks():
    rows = 130  # 60 + 60 + 10
    data = bytes(random.Random(1).randrange(256) for _ in range(12 * rows))
    blocks = protocol.raster_blocks(data)
    assert len(blocks) == 3
    rebuilt = b""
    for b, expected in zip(blocks, (60, 60, 10)):
        assert b[:4] == b"\x1dv00"
        assert int.from_bytes(b[4:6], "little") == 12
        assert int.from_bytes(b[6:8], "little") == expected
        assert int.from_bytes(b[8:12], "little") == len(b) - 12
        rebuilt += lzo.decompress(b[12:])
    assert rebuilt == data


def test_job_gap_label_and_continuous():
    img = render.text("Test", length_mm=30)
    assert img.size == (96, protocol.mm_to_dots(30))
    w = protocol.job(img, length_mm=30)
    assert w[0] == b"\x1ba\x01" and w[-2].startswith(b"\x1df") and w[-1] == protocol.feed(protocol.EXTRA_MM)
    w = protocol.job(img, length_mm=30, extra_mm=0)
    assert w[-1].startswith(b"\x1df")
    w = protocol.job(render.text("Test", length_mm=None), length_mm=None, print_density=3)
    assert w[0] == b"\x1dsetc\x03" and w[-1].startswith(b"\x1b\x1b\x01")


def test_text_is_not_blank():
    assert any(protocol.raster(render.text("Hello", length_mm=40)))


def test_status_and_info():
    s = protocol.Status.from_bytes(bytes([0, 0, 0, 80, 0x2C, 0x01, 3, 1]) + bytes(9))
    assert (s.code, s.battery, s.auto_off_min, s.density, s.paper_type) == (0, 80, 5, 3, 1)
    info = bytearray(143)
    info[32:38] = b"Qutie\x00"
    info[56:62] = b"SN1234"
    info[88:91] = bytes([1, 2, 3])
    info[91:94] = bytes([1, 5, 12])
    i = protocol.Info.from_bytes(bytes(info))
    assert (i.model, i.serial, i.firmware, i.board) == ("Qutie", "SN1234", "1.2.3", "1.05.12")


def _gpd_block_header(row_bytes: int) -> bytes:
    """What the GPD's CmdSendBlockData emits for one row, as Unidrv would expand it."""
    gpd = (ROOT / "driver" / "QUTIE.GPD").read_text(encoding="ascii")
    cmd = re.search(r"CmdSendBlockData\s*\{\s*\*Cmd\s*:\s*(.+)", gpd).group(1)
    out = b""
    for literal, fmt, expr in re.findall(r'"<([0-9A-F]+)>"|%([lc])\{([^}]+)\}', cmd):
        if literal:
            out += bytes.fromhex(literal)
            continue
        value = eval(expr, {}, {"RasterDataWidthInBytes": row_bytes, "NumOfDataBytes": row_bytes})  # noqa: S307
        out += value.to_bytes(2 if fmt == "l" else 1, "little")
    return out


def _gpd_options(feature: str) -> dict[str, bytes]:
    """Option name -> bytes of its CmdSelect, for a GPD feature made of fixed commands."""
    gpd = (ROOT / "driver" / "QUTIE.GPD").read_text(encoding="ascii")
    body = gpd[gpd.index(f"*Feature: {feature}"):]
    body = body[:body.index("\n}\n")]
    options = {}
    for name, block in re.findall(r"\*Option: (\w+)\s*\{(.*?)\n    \}", body, re.S):
        cmd = re.search(r'\*Cmd : "(?:<([0-9A-F]*)>)?"', block)
        options[name] = bytes.fromhex(cmd.group(1) or "")
    return options


def test_gpd_tape_feed_options():
    for name, data in _gpd_options("TapeFeed").items():
        mm = int(name[1:])
        if mm == 0:
            assert data == b""
            continue
        assert data[:3] == b"\x1b\x1b\x01"
        assert abs(int.from_bytes(data[3:], "little") - protocol.mm_to_dots(mm)) <= 1


def test_gpd_density_options():
    for name, data in _gpd_options("PrintDensity").items():
        expected = b"" if name == "KEEP" else protocol.density(int(name[1:]))
        assert data == expected


def test_gpd_auto_power_off_options():
    for name, data in _gpd_options("AutoPowerOff").items():
        expected = b"" if name == "KEEP" else protocol.auto_off(int(name[1:]))
        assert data == expected


def test_gpd_block_matches_protocol():
    row = bytes(range(12))
    gpd = (ROOT / "driver" / "QUTIE.GPD").read_text(encoding="ascii")
    end = bytes.fromhex(re.search(r'CmdEndBlockData\s*\{\s*\*Cmd\s*:\s*"<([0-9A-F]+)>"', gpd).group(1))
    assert _gpd_block_header(12) + row + end == protocol.raster_blocks(row)[0]
