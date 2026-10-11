"""The Studio's label engine (JavaScript): formulas, data plan, visibility, translations."""

import shutil
import subprocess
from pathlib import Path

import pytest

TEST = Path(__file__).parent / "js" / "engine.test.js"


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")
def test_engine_js():
    r = subprocess.run(["node", str(TEST)], capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert r.returncode == 0, r.stdout + r.stderr
