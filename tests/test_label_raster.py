"""The headless rasterizer against the Studio: the same labels, dot for dot (almost).

tests/fixtures/label/golden.json holds labels drawn by the Studio itself (the built-in
templates and features.json), made with tests/tools/studio_golden.py. Fonts are drawn by
a different engine (FreeType here, DirectWrite in the Studio), so edges can move by a dot
and dithering can take another path through the same greys; what must not happen is a dot
far from where the Studio put one.
"""

import base64
import datetime as dt
import io
import json
import sys
from pathlib import Path

import pytest
from PIL import Image, ImageChops, ImageFilter

from qutie.label import document, fields, raster

GOLDEN = Path(__file__).parent / "fixtures" / "label" / "golden.json"
pytestmark = pytest.mark.skipif(sys.platform != "win32", reason="the references use the fonts of Windows")


def _cases():
    data = json.loads(GOLDEN.read_text(encoding="utf-8"))
    docs = {}
    for lab in data["labels"]:
        if lab.get("doc"):
            docs[lab["name"]] = lab["doc"]
        yield pytest.param(data, lab, docs[lab["name"]], id=f"{lab['name']}-{lab['index']}")


def _black(img: Image.Image) -> Image.Image:
    return img.point(lambda v: 255 if v < 128 else 0)


@pytest.mark.parametrize(("data", "label", "raw"), list(_cases()))
def test_labels_match_the_studio(data, label, raw):
    fields.set_language(data["lang"])
    now = dt.datetime.fromisoformat(data["now"])
    doc = document.normalize(raw)
    item = fields.label_plan(doc, now=now)[label["index"]]
    item["vars"]["now"] = now
    mine = raster.rasterize(doc, {"vars": item["vars"], "texts": item["texts"], "raw": item["raw"]}).image
    ref = Image.open(io.BytesIO(base64.b64decode(label["png"].partition(",")[2]))).convert("L")
    assert mine.size == ref.size
    a, b = _black(ref), _black(mine)
    ink = max(1, sum(1 for v in a.tobytes() if v))
    near_a, near_b = a.filter(ImageFilter.MaxFilter(3)), b.filter(ImageFilter.MaxFilter(3))
    # a black dot with no black dot of the other image next to it, either way
    far = ImageChops.lighter(ImageChops.subtract(b, near_a), ImageChops.subtract(a, near_b))
    far_dots = sum(1 for v in far.tobytes() if v)
    diff_dots = sum(1 for v in ImageChops.difference(a, b).tobytes() if v)
    assert far_dots / ink < 0.015, f"{far_dots} dots out of place ({100 * far_dots / ink:.1f}% of the ink)"
    assert diff_dots / ink < 0.5, f"{diff_dots} dots differ ({100 * diff_dots / ink:.1f}% of the ink)"
