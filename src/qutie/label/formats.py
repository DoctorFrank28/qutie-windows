"""How each language writes dates, numbers and yes/no on a label.

The Studio asks the browser (Intl); these tables are what Intl gives for the Studio's
locales, so the headless printer writes the same text. tests/test_label_data.py checks
them against Node when it is installed.
"""

from __future__ import annotations

import locale as _locale
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Formats:
    lang: str
    date: str  # day, month, year: "d/m/y" order and separators, see short_date()
    month: str  # month and year ({mn}: the month without a leading zero)
    decimal: str
    months: tuple[str, ...]  # short month names, without the abbreviation dot
    yes: str
    no: str
    us_dates: bool = False  # month first when reading a date written 1/2/2026
    clock12: bool = False  # {time} as 09:05 AM


def _months(names: str) -> tuple[str, ...]:
    return tuple(names.split())


TABLE = {
    "en": Formats("en", "{d}/{m}/{y}", "{m}/{y}", ".", _months("Jan Feb Mar Apr May Jun Jul Aug Sept Oct Nov Dec"), "yes", "no"),
    "it": Formats("it", "{d}/{m}/{y}", "{m}/{y}", ",", _months("gen feb mar apr mag giu lug ago set ott nov dic"), "sì", "no"),
    "es": Formats("es", "{d}/{m}/{y}", "{mn}/{y}", ",", _months("ene feb mar abr may jun jul ago sept oct nov dic"), "sí", "no"),
    "fr": Formats("fr", "{d}/{m}/{y}", "{m}/{y}", ",", _months("janv févr mars avr mai juin juil août sept oct nov déc"), "oui", "non"),
    "de": Formats("de", "{d}.{m}.{y}", "{m}/{y}", ",", _months("Jan Feb Mär Apr Mai Jun Jul Aug Sep Okt Nov Dez"), "ja", "nein"),
    "pt": Formats("pt", "{d}/{m}/{y}", "{m}/{y}", ",", _months("jan fev mar abr mai jun jul ago set out nov dez"), "sim", "não"),
    "ru": Formats("ru", "{d}.{m}.{y}", "{m}.{y}", ",", _months("янв февр март апр май июнь июль авг сент окт нояб дек"), "да", "нет"),
    "zh": Formats("zh", "{y}/{m}/{d}", "{y}年{mn}月", ".", tuple(f"{i}月" for i in range(1, 13)), "是", "否"),
    "ja": Formats("ja", "{y}/{m}/{d}", "{y}/{m}", ".", tuple(f"{i}月" for i in range(1, 13)), "はい", "いいえ"),
    # English in the United States writes the month first, as the Studio does on a US Windows.
    "en-US": Formats("en", "{m}/{d}/{y}", "{m}/{y}", ".", _months("Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec"), "yes", "no", us_dates=True, clock12=True),
}


def system_language() -> str:
    """The locale of the system (QUTIE_LANG, LANG or the Windows locale), such as "it" or "en-US"."""
    for value in (os.environ.get("QUTIE_LANG"), os.environ.get("LANG")):
        if value and value[:2].lower() in TABLE:
            return value.split(".")[0].replace("_", "-")
    try:
        name = _locale.getlocale()[0] or ""
    except ValueError:
        name = ""
    if name[:2].lower() in TABLE:
        return name.replace("_", "-")
    # Windows names its locales in English ("Italian_Italy", "English_United States").
    names = {"italian": "it", "english": "en", "spanish": "es", "french": "fr", "german": "de",
             "portuguese": "pt", "russian": "ru", "chinese": "zh", "japanese": "ja"}
    lang, _, region = name.partition("_")
    code = names.get(lang.lower(), "en")
    return "en-US" if code == "en" and region == "United States" else code


def get(lang: str | None = None) -> Formats:
    """The formats of a language or locale ("it", "en-US"; "auto" or None: the system's)."""
    if not lang or lang == "auto":
        lang = system_language()
    tag = lang.replace("_", "-")
    if tag[:2].lower() == "en" and tag[3:5].upper() == "US":
        return TABLE["en-US"]
    return TABLE.get(tag[:2].lower(), TABLE["en"])
