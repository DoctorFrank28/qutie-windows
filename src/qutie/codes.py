"""Barcodes and QR codes for labels on 12 mm tape: modules, sizes and a check by reading them back.

Kept apart from any user interface: the Studio, the command line and a future headless
printer all use the same functions.
"""

from __future__ import annotations

import re

import barcode
import segno

# Barcodes the Studio offers, by its own names: python-barcode class names.
BARCODES = {
    "code128": "code128",
    "ean13": "ean13",
    "ean8": "ean8",
    "upca": "upca",
    "code39": "code39",
    "itf14": "itf",
    "codabar": "codabar",
}

HEAD_DOTS = 96

# Byte-mode capacity of QR versions 1-10, for error correction L, M, Q, H.
QR_BYTES = {
    1: (17, 14, 11, 7), 2: (32, 26, 20, 14), 3: (53, 42, 32, 24), 4: (78, 62, 46, 34),
    5: (106, 84, 60, 44), 6: (134, 106, 74, 58), 7: (154, 122, 86, 64), 8: (192, 152, 108, 84),
    9: (230, 180, 130, 98), 10: (271, 213, 151, 119),
}
QR_ALNUM = {
    1: (25, 20, 16, 10), 2: (47, 38, 29, 20), 3: (77, 61, 47, 35), 4: (114, 90, 67, 50),
    5: (154, 122, 87, 64), 6: (195, 154, 108, 84), 7: (224, 178, 125, 93), 8: (279, 221, 157, 122),
    9: (335, 262, 189, 143), 10: (395, 311, 221, 174),
}
QR_NUMERIC = {
    1: (41, 34, 27, 17), 2: (77, 63, 48, 34), 3: (127, 101, 77, 58), 4: (187, 149, 111, 82),
    5: (255, 202, 144, 106), 6: (322, 255, 178, 139), 7: (370, 293, 207, 154), 8: (461, 365, 259, 202),
    9: (552, 432, 312, 235), 10: (652, 513, 364, 288),
}
# Micro QR: (numeric, alphanumeric, byte) per version and error correction.
MICRO = {
    ("M1", None): (5, 0, 0),
    ("M2", "l"): (10, 6, 0), ("M2", "m"): (8, 5, 0),
    ("M3", "l"): (23, 14, 9), ("M3", "m"): (18, 11, 7),
    ("M4", "l"): (35, 21, 15), ("M4", "m"): (30, 18, 13), ("M4", "q"): (21, 13, 9),
}
ECC = "lmqh"
ALNUM = re.compile(r"[0-9A-Z $%*+\-./:]*")


def check_digit(digits: str) -> int:
    """GS1 check digit (EAN-8, EAN-13, UPC-A, ITF-14) of the digits before it."""
    total = sum(int(d) * (3 if i % 2 == 0 else 1) for i, d in enumerate(reversed(digits)))
    return (10 - total % 10) % 10


def valid_gs1(code: str) -> bool:
    return code.isdigit() and len(code) in (8, 12, 13, 14) and check_digit(code[:-1]) == int(code[-1])


def _gs1(kind: str, content: str) -> tuple[str, bool]:
    """The digits to encode, with the check digit added when it is missing; and whether it was added."""
    length = {"ean13": 13, "ean8": 8, "upca": 12, "itf14": 14}[kind]
    digits = re.sub(r"\s", "", content)
    if not digits.isdigit():
        raise ValueError("digits only")
    if len(digits) == length - 1:
        return digits + str(check_digit(digits)), True
    if len(digits) != length:
        raise ValueError(f"{length - 1} or {length} digits")
    if check_digit(digits[:-1]) != int(digits[-1]):
        raise ValueError(f"wrong check digit: {check_digit(digits[:-1])}")
    return digits, False


def barcode_modules(kind: str, content: str) -> dict:
    """The bars of a barcode as a 0/1 string, one character per module."""
    try:
        added = False
        if kind in ("ean13", "ean8", "upca", "itf14"):
            content, added = _gs1(kind, content)
        cls = barcode.get_barcode_class(BARCODES[kind])
        if kind == "code39":
            code = cls(content.upper(), add_checksum=False)
        elif kind == "codabar":
            text = content.upper()
            code = cls(text if text[:1] in "ABCD" else f"A{text}A")
        elif kind in ("ean13", "ean8", "upca"):
            code = cls(content[:-1])
        else:
            code = cls(content)
        bars = "".join(code.build())
        label = code.get_fullcode()
        if kind == "itf14":
            label = content
        return {"ok": True, "bars": bars, "label": label, "check_added": added,
                "check": content[-1] if kind in ("ean13", "ean8", "upca", "itf14") else None}
    except Exception as e:  # noqa: BLE001 - python-barcode raises its own errors for bad input
        return {"ok": False, "detail": str(e) or type(e).__name__}


def qr_modules(content: str, micro: bool = False, ecc: str = "m", version: int | str | None = None) -> dict:
    """The modules of a QR or Micro QR code (rows of 0/1) and what it is made of."""
    ecc = (ecc or "m").lower()
    try:
        kwargs = {"micro": micro, "error": None if micro and version == "M1" else ecc, "boost_error": False}
        if version not in (None, "", "auto", 0):
            kwargs["version"] = version
        qr = segno.make(content or " ", **kwargs)
    except (ValueError, segno.DataOverflowError) as e:
        return {"ok": False, "detail": str(e) or type(e).__name__}
    matrix = ["".join("1" if v else "0" for v in row) for row in qr.matrix]
    return {
        "ok": True, "matrix": matrix, "label": qr.designator, "version": qr.version,
        "modules": len(matrix), "mode": qr.mode, "chars": len(content or ""),
        "capacity": capacity(qr.version, ecc, qr.mode, micro),
    }


def capacity(version, ecc: str, mode: str, micro: bool) -> int | None:
    """Characters a version holds in a mode (the "30 of 42" the Studio shows)."""
    col = {"numeric": 0, "alphanumeric": 1}.get(mode, 2)
    if micro:
        entry = MICRO.get((version, None if version == "M1" else ecc))
        return entry[col] if entry else None
    table = {0: QR_NUMERIC, 1: QR_ALNUM}.get(col, QR_BYTES)
    row = table.get(int(version)) if str(version).isdigit() else None
    return row[ECC.index(ecc)] if row else None


def max_module_dots(modules: int, quiet: int = 0) -> int:
    """The largest whole number of dots per module that fits across the tape."""
    return HEAD_DOTS // (modules + 2 * quiet)


def legibility(module_dots: int) -> str:
    """How well a module of this many dots scans: 'no', 'limit' (2 dots), 'good' (3), 'great' (4+)."""
    return "no" if module_dots < 2 else "limit" if module_dots == 2 else "good" if module_dots == 3 else "great"


def qr_options(content: str, micro: bool = False, quiet: int = 0) -> dict:
    """The generator's comparison: for each error correction, version, modules and largest module."""
    out = {"chars": len(content or ""), "alnum": bool(ALNUM.fullmatch(content or "")), "ecc": {}}
    for level in ("lmqh" if not micro else "lmq"):
        info = qr_modules(content, micro=micro, ecc=level)
        if not info["ok"]:
            out["ecc"][level] = {"ok": False}
            continue
        dots = max_module_dots(info["modules"], quiet)
        out["ecc"][level] = {"ok": True, "version": info["version"], "label": info["label"],
                             "modules": info["modules"], "max_dots": dots, "legibility": legibility(dots)}
    upper = (content or "").upper()
    if not out["alnum"] and ALNUM.fullmatch(upper) and upper != content:
        # A link in capitals uses the alphanumeric mode and can drop one version.
        smaller = qr_modules(upper, micro=micro, ecc="m")
        if smaller["ok"]:
            out["upper"] = {"version": smaller["version"], "modules": smaller["modules"]}
    return out


def verify(image, expected: list[str]) -> dict:
    """Read the codes back from a 1-bit label (PIL image, black ink) and compare them.

    Returns {"ok": bool, "found": [...], "missing": [...]}; without zxing-cpp, ok is None.
    """
    try:
        import zxingcpp
    except ImportError:
        return {"ok": None, "found": [], "missing": []}
    from PIL import Image, ImageOps

    grey = image.convert("L")
    # Upscaled with a white margin: whole dots stay sharp and the quiet zone exists even
    # when the code touches the edge of the tape.
    big = ImageOps.expand(grey.resize((grey.width * 4, grey.height * 4), Image.NEAREST), border=48, fill=255)
    found = [r.text for r in zxingcpp.read_barcodes(big)]
    missing = []
    for text in expected:
        if not any(text == f or text in f or f in text for f in found):
            missing.append(text)
    return {"ok": not missing, "found": found, "missing": missing}
