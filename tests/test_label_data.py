"""The headless engine against the Studio's: the same documents must plan the same labels.

Node runs the Studio's JavaScript (tests/js/plan_dump.js); Python runs qutie.label. Both
get the same documents, language and clock, and must agree on every label: rows, copies,
counter, field texts, which objects print, where they go and the text they show.
"""

import datetime as dt
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from qutie.label import document, fields, formats

DUMP = Path(__file__).parent / "js" / "plan_dump.js"
NOW = "2026-10-03T09:05:00"
node = pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")


def text(id_, value, **props):
    return {"id": id_, "type": "text", "text": value, "x": 1, "y": 1, "w": 30, "h": 10, **props}


PANTRY = {
    "name": "pantry",
    "label": {"media": "continuous", "auto": True, "margin": 2},
    "series": {"start": 7, "step": 2, "pad": 3, "repeat": 2, "collate": False},
    "data": {
        "columns": [{"name": "Nome", "type": "text"}, {"name": "Data", "type": "date"}, {"name": "Prezzo", "type": "number", "format": "€ 0,00"},
                    {"name": "Piccante", "type": "bool"}, {"name": "Scade il", "type": "date"}, {"name": "Copie", "type": "number"}],
        "rows": [
            ["Ragù", "2026-10-01", "4.9", "no", "", "2"],
            ["Peperoncino", "15/09/2026", "1.234,5", "sì", "2027-03-18", "1"],
            ["Sale", "", "", "", "", "0"],
            ["", "2026-02-28", "abc", "x", "", ""],
        ],
        "formulas": [
            {"name": "Scadenza", "expr": "SE(VUOTO([Scade il]); AGGIUNGIGIORNI([Data]; 90); [Scade il])", "format": "short"},
            {"name": "Mese", "expr": "ADDMONTHS(Data, 1)", "format": "mmm yyyy"},
            {"name": "Codice", "expr": 'MAIUSC(SINISTRA(Nome; 3)) & "-" & LUNGHEZZA(Nome)'},
            {"name": "Totale", "expr": "ARROTONDA(Prezzo * 1,5; 2)", "format": "#.##0,00"},
            {"name": "Giorni", "expr": "Scadenza - Data"},
            {"name": "Etichetta", "expr": 'CONCATENA(MAIUSC.INIZ("pasta di casa"); " "; DESTRA("abcdef"; 2); STRINGA.ESTRAI("abcdef"; 2; 3))'},
            {"name": "Pulito", "expr": 'ANNULLA.SPAZI("  a   b ") & SOSTITUISCI("a-b-c"; "-"; "/")'},
            {"name": "Vero", "expr": "E(Piccante; NON(VUOTO(Nome))) & O(FALSO; 1 > 2)"},
            {"name": "Formato", "expr": 'FORMATO(Prezzo; "0.0 kg") & FORMATODATA(Data; "gg/mm/aa")'},
            {"name": "Numero", "expr": "NUMERO(\"€ 3,5\") + 1/4 - -2"},
        ],
        "copies": "Copie",
        "filter": [{"field": "Nome", "op": "notEmpty"}],
        "sort": {"field": "Prezzo", "desc": True},
    },
    "objects": [
        text("t1", "«Nome» · «Prezzo»", transform="upper"),
        text("t2", "Scade «Scadenza» ({date+30}, {month-1}, {year}, {time})", x=40),
        text("t3", "«Codice» «Totale» «Giorni» «Mese»", x=80, empty="dash"),
        text("t4", "«Etichetta» «Pulito» «Vero» «Formato» «Numero»", x=120, transform="title"),
        text("hot", "PICCANTE", x=160, w=10, closeGap=True, visible={"mode": "if", "join": "and", "rules": [{"field": "Piccante", "op": "true"}]}),
        text("after", "#{n} «Sconosciuto»", x=175, w=10),
        {"id": "q", "type": "qr", "content": "«Nome»|{n}", "x": 190, "y": 1, "w": 10, "h": 10},
    ],
}

COUNTER = {
    "name": "counter",
    "label": {"media": "gap", "length": 50},
    "series": {"start": 98, "step": 1, "count": 4, "pad": 3, "repeat": 1},
    "objects": [text("c", "INV-{n} {n+10} {anno+1} {mese}"), {"id": "b", "type": "barcode", "content": "INV-{n}", "x": 32, "y": 1, "w": 17, "h": 10}],
}

RANGE = {
    "name": "range",
    "data": {"columns": [{"name": "A", "type": "text"}, {"name": "B", "type": "number"}],
             "rows": [["x", "3"], ["y", "1"], ["z", "2"], ["w", "10"]], "which": "range", "range": {"from": 2, "to": 3},
             "filter": [{"field": "B", "op": "lt", "value": "5"}], "sort": {"field": "B"}},
    "objects": [text("a", "«A» «B»", empty="hide"), text("e", "«A»", x=40, visible={"mode": "if", "join": "or", "rules": [
        {"field": "A", "op": "eq", "value": "Y"}, {"field": "B", "op": "gt", "value": "2"}, {"field": "A", "op": "contains", "value": "z"}]})],
}

CHECKED = {
    "name": "checked",
    "data": {"columns": [{"name": "A", "type": "text"}], "rows": [["1"], ["2"], ["3"]], "which": "checked", "checked": [2, 0]},
    "series": {"repeat": 2, "collate": True},
    "objects": [text("a", "«A»")],
}


def run_js(lang: str, docs: list[dict], templates: bool) -> list[dict]:
    payload = json.dumps({"lang": lang[:2], "locale": lang, "now": NOW, "templates": templates, "docs": docs})
    r = subprocess.run(["node", str(DUMP)], input=payload, capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout)


def run_py(lang: str, raw: dict) -> list[dict]:
    fields.set_language(lang)
    doc = document.normalize(raw)
    now = dt.datetime.fromisoformat(NOW)
    out = []
    for item in fields.label_plan(doc, now=now):
        item["vars"]["now"] = now
        env = {"vars": item["vars"], "texts": item["texts"], "raw": item["raw"], "doc": doc}
        objects = fields.layout_for(doc, env)
        out.append({
            "row": item["row"], "copy": item["copy"], "repeat": item["repeat"], "n": item["vars"]["n"], "texts": item["texts"],
            "shown": [o["id"] for o in objects], "x": [round(o["x"] * 1000) / 1000 for o in objects],
            "text": {o["id"]: fields.object_text(o, env) for o in objects if o["type"] in ("text", "barcode", "qr")},
            "length": document.label_length(doc, objects),
        })
    return out


@node
@pytest.mark.parametrize("lang", ["it", "en-GB", "en-US", "de", "zh"])
def test_plans_match_the_studio(lang):
    for case in run_js(lang, [PANTRY, COUNTER, RANGE, CHECKED], templates=True):
        expected = case["labels"]
        got = run_py(lang, case["doc"])
        assert len(got) == len(expected), case["name"]
        for i, (g, e) in enumerate(zip(got, expected)):
            for key in e:
                if key == "length" or key == "n":
                    assert g[key] == pytest.approx(e[key]), (case["name"], i, key)
                elif key == "x":
                    assert g[key] == pytest.approx(e[key], abs=1e-3), (case["name"], i, key)
                else:
                    assert g[key] == e[key], (case["name"], i, key, g[key], e[key])


@node
def test_formats_are_what_intl_gives():
    script = """
const LOCALES = { en: "en-GB", it: "it-IT", es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-PT", ru: "ru-RU", zh: "zh-CN", ja: "ja-JP" };
const d = new Date(2026, 8, 3, 9, 5);
const out = {};
for (const [lang, loc] of Object.entries(LOCALES)) {
  const f = (o) => new Intl.DateTimeFormat(loc, o).format(d);
  out[lang] = { date: f({ day: "2-digit", month: "2-digit", year: "numeric" }), month: f({ month: "2-digit", year: "numeric" }),
    decimal: (1.5).toLocaleString(loc).charAt(1),
    months: Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat(loc, { month: "short" }).format(new Date(2026, i, 1)).replace(".", "")) };
}
console.log(JSON.stringify(out));"""
    r = subprocess.run(["node", "-e", script], capture_output=True, text=True, encoding="utf-8", timeout=30)
    intl = json.loads(r.stdout)
    day = dt.date(2026, 9, 3)  # September: one digit, to see which formats pad it
    for lang, want in intl.items():
        f = formats.TABLE[lang]
        assert document.short_date(day, f) == want["date"], lang
        assert document.month_year(day, f) == want["month"], lang
        assert f.decimal == want["decimal"], lang
        assert list(f.months) == want["months"], lang


def test_numbers_round_as_javascript():
    fields.set_language("it")
    assert fields.format_number(2.5, "0") == "3"  # toFixed rounds halves up, Python's format would give 2
    assert fields.format_number(1234567.891, "#.##0,00 €") == "1.234.567,89 €"
    assert fields.format_number(-0.5, "0.0") == "-0.5"
    assert fields.display(1 / 3) == "0,333333"
    assert fields.to_number("1.234,5") == 1234.5 and fields.to_number("€ 3") == 3
    assert fields.to_date("31/04/2026") is None and fields.to_date("29/02/2028") == dt.date(2028, 2, 29)
