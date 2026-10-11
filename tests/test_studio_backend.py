"""Qutie Studio back end: data sources, codes, library and history."""

import datetime as dt
import json

import pytest
from PIL import Image

from qutie import codes, datasource, library


# --------------------------------------------------------------------------- data sources
def test_csv_with_semicolons_types_and_dates():
    text = (
        "Nome;Data;Quantità;Piccante;Codice\n"
        "Origano;11/10/2026;2;no;8001234500016\n"
        "Paprika dolce;18/12/2026;3;sì;8001234500030\n"
    )
    table = datasource.parse_text(text)
    assert [c.name for c in table.columns] == ["Nome", "Data", "Quantità", "Piccante", "Codice"]
    assert [c.type for c in table.columns] == ["text", "date", "number", "bool", "ean13"]
    assert table.rows[1] == ["Paprika dolce", "2026-12-18", "3", "sì", "8001234500030"]


def test_pasted_cells_are_tab_separated_and_names_are_unique():
    table = datasource.parse_text("A\tA\t\nx\ty\tz\n\n")
    assert [c.name for c in table.columns] == ["A", "A 2", "C"]
    assert table.rows == [["x", "y", "z"]]


def test_without_header_columns_get_letters():
    table = datasource.parse_text("1,2\n3,4", header=False)
    assert [c.name for c in table.columns] == ["A", "B"]
    assert len(table.rows) == 2


def test_json_list_of_objects():
    table = datasource.parse_json(json.dumps([{"Nome": "Basilico", "Prezzo": 4.9}, {"Nome": "Timo", "Lotto": "B2"}]))
    assert [c.name for c in table.columns] == ["Nome", "Prezzo", "Lotto"]
    assert table.rows[0] == ["Basilico", "4.9", ""]


def test_xlsx_sheet_and_dates(tmp_path):
    openpyxl = pytest.importorskip("openpyxl")
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Spezie"
    ws.append(["Nome", "Data", "Quantità"])
    ws.append(["Origano", dt.datetime(2026, 10, 11), 2])
    ws.append(["Curcuma", dt.datetime(2026, 11, 4), 1.0])
    wb.create_sheet("Altro").append(["x"])
    path = tmp_path / "dispensa.xlsx"
    wb.save(path)
    table = datasource.read_file(path)
    assert table.sheet == "Spezie"
    assert [s["name"] for s in table.sheets] == ["Spezie", "Altro"]
    assert table.rows == [["Origano", "2026-10-11", "2"], ["Curcuma", "2026-11-04", "1"]]
    assert table.columns[1].type == "date"
    assert datasource.read_file(path, sheet="Altro").sheet == "Altro"


def test_describe_missing_file(tmp_path):
    assert datasource.describe(tmp_path / "nope.csv")["exists"] is False


# --------------------------------------------------------------------------- codes
def test_ean13_check_digit_is_added():
    result = codes.barcode_modules("ean13", "800123450003")
    assert result["ok"] and result["check_added"] and result["label"] == "8001234500030"
    assert len(result["bars"]) == 95
    assert not codes.barcode_modules("ean13", "8001234500031")["ok"]


def test_itf14_and_codabar():
    assert codes.barcode_modules("itf14", "1234567890123")["label"] == "12345678901231"
    assert codes.barcode_modules("codabar", "12345")["ok"]


def test_qr_version_capacity_and_options():
    info = codes.qr_modules("WIFI:T:WPA;S:Casa;P:********;;", ecc="m")
    assert info["version"] == 3 and info["modules"] == 29 and info["capacity"] == 42
    options = codes.qr_options("WIFI:T:WPA;S:Casa;P:********;;")
    assert options["ecc"]["m"]["max_dots"] == 3 and options["ecc"]["m"]["legibility"] == "good"
    assert options["ecc"]["l"]["version"] == 2
    micro = codes.qr_modules("INV-007", micro=True, ecc="m")
    assert micro["ok"] and micro["modules"] in (13, 15, 17)


def test_verify_reads_a_qr_back():
    pytest.importorskip("zxingcpp")
    info = codes.qr_modules("QUTIE", ecc="m")
    m = 3
    img = Image.new("L", (200, 96), 255)
    for y, row in enumerate(info["matrix"]):
        for x, v in enumerate(row):
            if v == "1":
                img.paste(0, (20 + x * m, 10 + y * m, 20 + x * m + m, 10 + y * m + m))
    assert codes.verify(img, ["QUTIE"])["ok"] is True
    assert codes.verify(img, ["OTHER"])["ok"] is False


# --------------------------------------------------------------------------- library
def test_library_lists_labels_with_summary(tmp_path):
    doc = {"name": "Barattolo", "label": {"media": "gap", "length": 40},
           "objects": [{"type": "text", "text": "Origano {date}"}],
           "data": {"source": {"name": "dispensa.xlsx", "kind": "file"}, "columns": [{"name": "Nome"}], "rows": [["a"]]}}
    library.write_document(tmp_path / "Cucina" / "Barattolo.qutie", doc)
    (tmp_path / "rotto.qutie").write_text("{", encoding="utf-8")
    labels = library.list_labels(tmp_path)
    by_name = {e["name"]: e for e in labels}
    assert by_name["Barattolo"]["folder"] == "Cucina"
    assert by_name["Barattolo"]["variables"] == ["{date}"]
    assert by_name["Barattolo"]["data"] == "dispensa.xlsx"
    assert by_name["rotto"]["broken"]
    copy = library.duplicate(tmp_path / "Cucina" / "Barattolo.qutie")
    assert copy.name == "Barattolo (2).qutie"
    renamed = library.rename(copy, "Spezie")
    assert library.read_document(renamed)["name"] == "Spezie"


def test_history_add_list_stats_and_prune(tmp_path, monkeypatch):
    monkeypatch.setattr(library, "HISTORY", tmp_path)
    monkeypatch.setattr(library, "HISTORY_INDEX", tmp_path / "index.json")
    a = library.history_add({"name": "Barattolo", "count": 2, "ok": True, "tape_mm": 100}, detail={"labels": ["x"]})
    library.history_add({"name": "Dispensa", "count": 31, "ok": True, "tape_mm": 1550})
    entries = library.history_list()
    assert [e["name"] for e in entries] == ["Dispensa", "Barattolo"]
    assert library.history_detail(a["id"]) == {"labels": ["x"]}
    stats = library.history_stats(entries)
    assert stats["month_labels"] == 33 and stats["weeks"][4] == 33 and stats["top"]["name"] == "Dispensa"
    old = (dt.datetime.now() - dt.timedelta(days=120)).isoformat(timespec="seconds")
    library.history_update(a["id"], time=old)
    assert [e["name"] for e in library.history_list(90)] == ["Dispensa"]
    assert library.history_detail(a["id"]) is None
