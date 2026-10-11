"""Per-user settings of the Qutie app, in %APPDATA%\\Qutie\\config.json."""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field, fields
from pathlib import Path

PATH = Path(os.environ.get("APPDATA", Path.home())) / "Qutie" / "config.json"


@dataclass
class Config:
    preview: bool = True  # show the preview before every job from the Windows printer
    mac: str | None = None  # printer address; None = the paired device named Qutie
    margin_mm: float = 2  # continuous tape: blank tape kept before and after the content
    same_height: bool = True  # "Fit to tape": one scale for all the pages of a job
    preview_strip: bool = False  # preview the job as one strip of tape instead of separate labels

    # Qutie Studio
    language: str = "auto"  # "auto" (as Windows) or en, it, es, fr, de, pt, ru, zh, ja
    theme: str = "system"  # system | light | dark
    open_on: str = "home"  # home | last: what the Studio shows when it opens
    quick_hotkey: bool = False  # Win+Shift+Q opens "quick print"
    default_view: str = "dots"  # dots | smooth
    units: str = "mm"  # mm | in | dots
    nudge: str = "dot"  # arrows move by one dot or 0.5 mm
    default_font: str = "Segoe UI"
    default_bold: bool = True
    confirm_series: bool = True  # ask before printing more than 50 labels
    confirm_limit: int = 50
    check_codes: bool = True  # read QR codes and barcodes back from the bitmap before printing
    reread: str = "print"  # print | open | manual: when linked files are read again
    history_days: int = 90
    library_dir: str | None = None  # None = Documents\Qutie
    autosave: bool = True
    recent: list[str] = field(default_factory=list)  # .qutie files opened lately, newest first
    recent_fonts: list[str] = field(default_factory=list)
    quick_length: str = "40"  # quick print: 30 | 40 | 50 | auto
    last_document: str | None = None
    welcomed: bool = False

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
        tmp = PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(asdict(self), indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(PATH)

    def as_dict(self) -> dict:
        return asdict(self)
