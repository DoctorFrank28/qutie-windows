"""The JavaScript library (web/qutie.js) against the Python side it mirrors.

Codes must come out as the Studio's (python-barcode, segno), and the bytes of a label as
the driver's (label_job). Node runs the library (tests/js/library_dump.mjs).
"""

import base64
import json
import random
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import segno
from PIL import Image

from qutie import codes
from qutie.app.designer import label_job

ROOT = Path(__file__).resolve().parents[1]
DUMP = Path(__file__).parent / "js" / "library_dump.mjs"
node = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")


def run(cases: dict) -> dict:
    r = subprocess.run(["node", str(DUMP)], input=json.dumps(cases), capture_output=True, text=True, encoding="utf-8", timeout=120)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def test_bundle_is_up_to_date():
    r = subprocess.run([sys.executable, str(ROOT / "tools" / "build_js.py"), "--check"], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr


@node
@pytest.mark.parametrize("page", ["index.html", "serial-test.html"])
def test_page_scripts_parse(page, tmp_path):
    """A syntax error stops a page's whole script, and nothing else would notice."""
    html = (ROOT / "web" / page).read_text(encoding="utf-8")
    scripts = re.findall(r"<script(?:\s+type=\"module\")?>(.*?)</script>", html, re.S)
    assert scripts, page
    for i, script in enumerate(scripts):
        path = tmp_path / f"{i}.mjs"
        path.write_text(script, encoding="utf-8")
        r = subprocess.run(["node", "--check", str(path)], capture_output=True, text=True)
        assert r.returncode == 0, (page, r.stderr)


BARCODES = [
    ("code128", "QUTIE-001"), ("code128", "123456789012"), ("code128", "AB12345678CD"), ("code128", "1"), ("code128", "12"),
    ("code128", "123"), ("code128", "a1b2c3d4"), ("code128", "INV-0042"), ("code128", "x\ty"), ("code128", "Prezzo € 3"),
    ("code128", "00012345678905"), ("code128", "ab 12345 cd 9"),
    ("ean13", "590123412345"), ("ean13", "5901234123457"), ("ean13", "5901234123458"), ("ean13", "12345"),
    ("ean8", "9638507"), ("ean8", "96385074"), ("upca", "03600029145"), ("upca", "036000291452"),
    ("itf14", "1540014128876"), ("itf14", "15400141288763"),
    ("code39", "qutie-39"), ("code39", "HELLO WORLD"), ("code39", "ä"),
    ("codabar", "40156"), ("codabar", "A40156B"), ("codabar", "12x"),
]


@node
def test_barcodes_are_the_studios():
    got = run({"barcodes": BARCODES})["barcodes"]
    for (kind, content), js in zip(BARCODES, got):
        py = codes.barcode_modules(kind, content)
        assert js["ok"] == py["ok"], (kind, content, js, py)
        if py["ok"]:
            assert js["bars"] == py["bars"], (kind, content)
            assert js["label"] == py["label"], (kind, content)


QR_TEXTS = ["https://example.com/qutie", "12345", "HELLO WORLD 42", "WIFI:T:WPA;S:Casa;P:password;;", "Città più bella", "€ ☃ 雪",
            "x" * 120, "0123456789" * 30]


@node
def test_qr_codes_match_the_reference_encoder():
    """Module for module as Nayuki's reference encoder (qrcodegen), with the version and mode
    segno picks. segno itself fills the data differently: both are valid and read back."""
    from qrcodegen import QrCode, QrSegment

    levels = {"l": QrCode.Ecc.LOW, "m": QrCode.Ecc.MEDIUM, "q": QrCode.Ecc.QUARTILE, "h": QrCode.Ecc.HIGH}
    cases = [(t, ecc, None, mask) for t in QR_TEXTS for ecc in "lmqh" for mask in (0, 3, 7, None)]
    cases += [("https://example.com/qutie", "m", 5, 2), ("12345", "l", 2, 4)]
    got = run({"qr": cases})["qr"]
    for (text, ecc, version, mask), js in zip(cases, got):
        assert js["ok"], (text, js)
        q = segno.make(text, error=ecc, version=version, boost_error=False, micro=False)
        assert js["version"] == q.version and js["mode"] == q.mode, (text, ecc, js["version"], q.version, js["mode"], q.mode)
        if q.mode == "byte":
            data = text.encode("latin-1") if all(ord(c) <= 0xFF for c in text) else text.encode("utf-8")
            segment = QrSegment.make_bytes(data)
        else:
            segment = QrSegment.make_segments(text)[0]
        ref = QrCode.encode_segments([segment], levels[ecc], js["version"], js["version"], -1 if mask is None else mask, False)
        expected = ["".join("1" if ref.get_module(x, y) else "0" for x in range(ref.get_size())) for y in range(ref.get_size())]
        assert js["matrix"] == expected, (text, ecc, mask)


@node
def test_qr_codes_read_back():
    cases = [(t, ecc, None, None) for t in QR_TEXTS for ecc in "lmqh"]
    got = run({"qr": cases})["qr"]
    for (text, ecc, _, _), js in zip(cases, got):
        n, quiet, scale = len(js["matrix"]), 4, 4
        img = Image.new("L", ((n + 2 * quiet) * scale,) * 2, 255)
        for y, row in enumerate(js["matrix"]):
            for x, bit in enumerate(row):
                if bit == "1":
                    img.paste(0, ((x + quiet) * scale, (y + quiet) * scale, (x + quiet + 1) * scale, (y + quiet + 1) * scale))
        assert codes.verify(img, [text])["ok"], (text, ecc)


@node
def test_label_bytes_are_the_drivers():
    rng = random.Random(7)
    jobs, images = [], []
    for width, media in [(239, {"type": "gap", "length_mm": 30, "feed_mm": 10}), (319, {"type": "gap", "length_mm": 40, "feed_mm": 0}),
                         (575, {"type": "continuous", "length_mm": None, "feed_mm": 14}), (61, {"type": "continuous", "length_mm": None, "feed_mm": 5})]:
        bits = bytes(1 if rng.random() < 0.3 else 0 for _ in range(width * 96))
        jobs.append({"width": width, "bits": base64.b64encode(bits).decode(), "media": media})
        images.append((Image.frombytes("L", (width, 96), bytes(0 if b else 255 for b in bits)), media))
    got = run({"jobs": jobs})["jobs"]
    for (img, media), js in zip(images, got):
        assert js == label_job(img, media).hex()
