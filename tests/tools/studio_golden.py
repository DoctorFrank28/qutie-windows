"""Draw the reference labels with the Studio itself, for tests/test_label_raster.py.

The Studio's engine needs a browser (canvas, fonts), so the references are made once and
kept in tests/fixtures/label/golden.json; run this again when render.js changes:

    uv run python -m qutie.app.designer          # the Studio at http://127.0.0.1:4180
    uv run python tests/tools/studio_golden.py   # needs playwright-cli (npm i -g @playwright/cli)

Every built-in template (in English) and every document of features.json is drawn as the
Studio prints it, at a fixed date, and saved with the document as the Studio read it.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "tests" / "fixtures" / "label"
NOW = "2026-10-03T09:05:00"

PAGE = """async (input) => {
  for (let i = 0; i < 100 && (typeof templates !== "function" || typeof LANG === "undefined"); i++) await new Promise((r) => setTimeout(r, 100));
  if (LANG !== "en") throw new Error("the Studio is not in English: " + LANG);
  const now = new Date(input.now);
  const cases = [...templates().map((t) => ({ ...t.doc, name: "template-" + t.id })), ...input.docs];
  const out = [];
  for (const raw of cases) {
    const doc = normalizeDocument(JSON.parse(JSON.stringify(raw)));
    const plan = labelPlan(doc).slice(0, 2);
    for (const item of plan) item.vars.now = now;
    const rendered = await renderPlan(doc, plan);
    rendered.forEach(({ raster }, k) => out.push({ name: raw.name, index: k, width: raster.width, png: toPng(raster),
      doc: k === 0 ? JSON.parse(JSON.stringify(doc)) : undefined }));
  }
  return out;
}"""


def main(url: str = "http://127.0.0.1:4180/designer.html?lang=en") -> int:
    docs = json.loads((FIXTURES / "features.json").read_text(encoding="utf-8"))
    script = f"async page => {{ await page.goto({json.dumps(url)}); return await page.evaluate({PAGE}, {json.dumps({'now': NOW, 'docs': docs})}); }}"
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "golden.js"
        path.write_text(script, encoding="utf-8")
        subprocess.run("playwright-cli open", shell=True, check=True, capture_output=True)
        try:
            r = subprocess.run(f'playwright-cli --raw run-code --filename="{path}"', shell=True, capture_output=True, text=True, encoding="utf-8")
        finally:
            subprocess.run("playwright-cli close", shell=True, capture_output=True)
    if r.returncode:
        print(r.stdout, r.stderr, file=sys.stderr)
        return 1
    labels = json.loads(r.stdout)
    (FIXTURES / "golden.json").write_text(json.dumps({"now": NOW, "lang": "en", "labels": labels}, ensure_ascii=False), encoding="utf-8")
    print(f"{len(labels)} labels -> {FIXTURES / 'golden.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main(*sys.argv[1:]))
