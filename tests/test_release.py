"""What a release needs: one version everywhere, and the update check reading GitHub right."""

import io
import json
import re
import tomllib
import urllib.error
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from qutie import __version__, updates

ROOT = Path(__file__).resolve().parents[1]


def test_version_is_the_same_everywhere():
    project = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
    installed = re.search(r"DisplayVersion\s*=\s*'([^']+)'", (ROOT / "driver/install.ps1").read_text(encoding="utf-8")).group(1)
    driver = re.search(r"DriverVer=[^,]+,([\d.]+)", (ROOT / "driver/qutie.inf").read_text(encoding="utf-8")).group(1)
    assert project == __version__ == installed
    assert driver == f"{__version__}.0"


@pytest.mark.parametrize(("latest", "newer"), [("v1.2.0", False), ("1.2.1", True), ("v1.10.0", True), ("1.1.9", False), ("v2.0", True)])
def test_versions_compare_as_numbers(latest, newer):
    assert (updates.version_key(latest) > updates.version_key("1.2.0")) is newer


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_check_reports_a_newer_release(monkeypatch):
    release = {"tag_name": "v99.0.0", "html_url": f"{updates.REPOSITORY}/releases/tag/v99.0.0"}
    monkeypatch.setattr(updates.urllib.request, "urlopen", lambda req, timeout: _Response(json.dumps(release).encode()))
    r = updates.check()
    assert r == {"ok": True, "current": __version__, "latest": "99.0.0", "newer": True, "url": release["html_url"]}


def test_check_without_any_release(monkeypatch):
    def not_found(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 404, "Not Found", None, None)
    monkeypatch.setattr(updates.urllib.request, "urlopen", not_found)
    assert updates.check()["newer"] is False


def test_check_offline(monkeypatch):
    def offline(req, timeout):
        raise urllib.error.URLError("no network")
    monkeypatch.setattr(updates.urllib.request, "urlopen", offline)
    assert updates.check()["ok"] is False


def test_pages_are_fixed_and_the_issue_names_no_device():
    assert updates.page_url("https://example.com") is None
    assert updates.page_url("repository") == updates.REPOSITORY
    issue = urlparse(updates.page_url("issues"))
    body = parse_qs(issue.query)["body"][0]
    assert issue.path.endswith("/issues/new") and __version__ in body
    assert not re.search(r"([0-9A-F]{2}:){5}[0-9A-F]{2}", body)
