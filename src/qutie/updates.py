"""The project on GitHub: the latest release, and the pages the app links to."""

from __future__ import annotations

import json
import platform
import re
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

from . import __version__

REPOSITORY = "https://github.com/DoctorFrank28/qutie-windows"
LATEST_RELEASE_API = "https://api.github.com/repos/DoctorFrank28/qutie-windows/releases/latest"


def version_key(version: str) -> tuple[int, ...]:
    """'v1.10.2' → (1, 10, 2): versions compare as numbers, not as text."""
    return tuple(int(n) for n in re.findall(r"\d+", version or "")[:3])


def check(timeout: float = 6) -> dict:
    """The latest published release compared with this one.

    {"ok", "current", "latest", "newer", "url"}; {"ok": False, "detail"} when GitHub
    cannot be reached. With no release published yet, latest is None.
    """
    request = urllib.request.Request(LATEST_RELEASE_API, headers={
        "Accept": "application/vnd.github+json", "User-Agent": f"qutie/{__version__}"})
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            release = json.load(response)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return {"ok": True, "current": __version__, "latest": None, "newer": False, "url": f"{REPOSITORY}/releases"}
        return {"ok": False, "detail": str(e)}
    except (OSError, ValueError) as e:
        return {"ok": False, "detail": str(e)}
    latest = str(release.get("tag_name") or "").lstrip("vV")
    return {
        "ok": True, "current": __version__, "latest": latest,
        "newer": version_key(latest) > version_key(__version__),
        "url": release.get("html_url") or f"{REPOSITORY}/releases/latest",
    }


def issue_url() -> str:
    """A new issue with the versions filled in (nothing that identifies the printer or the PC)."""
    body = (f"**Qutie app**: {__version__}\n**Windows**: {platform.version()}\n\n"
            "**What happened**\n\n\n**What you expected**\n\n\n**Steps to reproduce**\n1. \n")
    return f"{REPOSITORY}/issues/new?" + urllib.parse.urlencode({"body": body})


def page_url(name: str) -> str | None:
    """The address of a project page by name; the app never opens an address the page chose."""
    return {
        "repository": REPOSITORY,
        "releases": f"{REPOSITORY}/releases/latest",
        "issues": issue_url(),
    }.get(name)


def open_page(name: str) -> bool:
    url = page_url(name)
    if url:
        webbrowser.open(url)
    return bool(url)
