"""Per-user settings of the Qutie app, in %APPDATA%\\Qutie\\config.json."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, fields
from pathlib import Path

PATH = Path(os.environ.get("APPDATA", Path.home())) / "Qutie" / "config.json"


@dataclass
class Config:
    preview: bool = True  # show the preview before every job from the Windows printer
    mac: str | None = None  # printer address; None = the paired device named Qutie
    margin_mm: float = 2  # continuous tape: blank tape kept before and after the content
    same_height: bool = True  # "Fit to tape": one scale for all the pages of a job
    preview_strip: bool = False  # preview the job as one strip of tape instead of separate labels

    @classmethod
    def load(cls) -> Config:
        try:
            data = json.loads(PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return cls()
        known = {f.name for f in fields(cls)}
        return cls(**{k: v for k, v in data.items() if k in known})

    def save(self) -> None:
        PATH.parent.mkdir(parents=True, exist_ok=True)
        PATH.write_text(json.dumps(asdict(self), indent=2), encoding="utf-8")
