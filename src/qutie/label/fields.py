"""Linked data: values, formula fields, conditional visibility and the plan of the labels
to print. A port of the Studio's web/designer/data.js, kept as close to it as the two
languages allow, so a .qutie file prints the same labels from either.

Values are str, float, bool or datetime.date (a JavaScript Date in the Studio).
"""

from __future__ import annotations

import datetime as dt
import math
import re
from decimal import ROUND_HALF_UP, Decimal

from . import document, formats

FIELD_RE = re.compile(r"«([^«»]+)»")
ISO_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})")
NAN = float("nan")


# --------------------------------------------------------------------------- values
def js_round(x: float) -> float:
    """Math.round: halves go up."""
    return math.floor(x + 0.5) if math.isfinite(x) else x


def _or(x: float, default: float) -> float:
    """`Number(x) || default`: NaN and 0 take the default."""
    return default if not x or math.isnan(x) else x


def js_int(x: float) -> int:
    """ToIntegerOrInfinity, for slice() and friends: NaN is 0, fractions go toward 0."""
    return 0 if not math.isfinite(x) else int(x)


def js_string(v) -> str:
    """String(v) as JavaScript writes it."""
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        if isinstance(v, float) and math.isnan(v):
            return "NaN"
        if isinstance(v, float) and math.isinf(v):
            return "Infinity" if v > 0 else "-Infinity"
        return document.js_number(v)
    return str(v)


def to_date(v) -> dt.date | None:
    """A cell or formula value as a date, when it is one (ISO or day-first text)."""
    if isinstance(v, dt.datetime):
        return v.date()
    if isinstance(v, dt.date):
        return v
    s = js_string(v).strip()
    m = ISO_DATE.match(s)
    try:
        if m:
            return _js_date(int(m[1]), int(m[2]) - 1, int(m[3]))
        m = re.fullmatch(r"(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})", s)
        if m:
            year = 2000 + int(m[3]) if int(m[3]) < 100 else int(m[3])
            day_first = not FMT.us_dates or int(m[2]) > 12
            d, mo = (int(m[1]), int(m[2])) if day_first else (int(m[2]), int(m[1]))
            return dt.date(year, mo, d)
    except (ValueError, OverflowError):
        return None
    return None


def _js_date(year: int, month0: int, day: int) -> dt.date:
    """new Date(year, month0, day): months and days roll over as in JavaScript."""
    year += month0 // 12
    month0 %= 12
    return dt.date(year, month0 + 1, 1) + dt.timedelta(days=day - 1)


def to_number(v) -> float:
    """A value as a number: accepts "4,90", "1.234,5", "€ 3"."""
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float)):
        return float(v)
    s = re.sub(r"[^\d,.\-+]", "", js_string(v))
    if not s:
        return NAN
    if "," in s and "." in s:
        s = s.replace(".", "").replace(",", ".", 1) if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        s = s.replace(",", ".", 1)
    try:
        return float(s)
    except ValueError:
        return NAN


YES = {"sì", "si", "yes", "y", "true", "vero", "x", "1", "ja", "oui", "sí", "sim", "да", "是", "はい"}


def truthy(v) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0 and not math.isnan(v)
    return js_string(v).strip().lower() in YES


def is_empty(v) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def format_date(d: dt.date | None, fmt: str = "short") -> str:
    """"short" (the language's numeric date), "month" (mm/yyyy), "long" (18 mar 2027), or a
    pattern with dd/gg, mm, mmm, yyyy/aaaa, yy/aa."""
    if not d:
        return ""
    if fmt == "short":
        return document.short_date(d, FMT)
    if fmt == "month":
        return f"{d.month:02d}/{d.year}"
    if fmt == "long":
        return f"{d.day} {FMT.months[d.month - 1]} {d.year}"
    out = re.sub(r"aaaa|yyyy", str(d.year), str(fmt), flags=re.I)
    out = re.sub(r"aa|yy", str(d.year)[2:], out, flags=re.I)
    out = re.sub(r"mmm", lambda _: FMT.months[d.month - 1], out, flags=re.I)
    out = re.sub(r"mm", f"{d.month:02d}", out, flags=re.I)
    return re.sub(r"gg|dd", f"{d.day:02d}", out, flags=re.I)


def _to_fixed(x: float, decimals: int) -> str:
    """Number.prototype.toFixed: the exact value rounded, halves up."""
    q = Decimal(1).scaleb(-decimals)
    return str(Decimal(x).quantize(q, rounding=ROUND_HALF_UP))


def format_number(n: float, pattern: str) -> str:
    """A number with a pattern such as "€ 0,00", "0.0 kg" or "#.##0"."""
    if not math.isfinite(n):
        return ""
    m = re.search(r"([#0][#0.,\s']*)", pattern or "")
    if not m:
        return js_string(n)
    core = m[1].strip()
    last = max(core.rfind(","), core.rfind("."))
    tail = core[last + 1:] if last >= 0 else ""
    decimal = core[last] if last >= 0 and re.fullmatch(r"0+", tail) else None
    decimals = len(tail) if decimal else 0
    int_part = core[:last] if decimal else core
    group = re.search(r"[.,\s']", re.sub(r"^[#0]+", "", int_part))
    fixed = _to_fixed(abs(n), decimals)
    i, _, f = fixed.partition(".")
    if group:
        i = re.sub(r"\B(?=(\d{3})+(?!\d))", group[0], i)
    out = ("-" if n < 0 else "") + i + (decimal + f if decimals else "")
    return pattern.replace(m[1], out + (" " if m[1].endswith(" ") else ""), 1)


def display(v, type_: str | None = None, fmt: str | None = None) -> str:
    """The text a value shows on the label."""
    if v is None:
        return ""
    if isinstance(v, dt.date):
        return format_date(to_date(v), fmt or "short")
    if isinstance(v, bool):
        return FMT.yes if v else FMT.no
    if isinstance(v, (int, float)):
        if fmt:
            return format_number(float(v), fmt)
        return js_string(js_round(v * 1e6) / 1e6 if math.isfinite(v) else v).replace(".", FMT.decimal)
    if type_ == "date" or (type_ != "text" and isinstance(v, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", v)):
        d = to_date(v)
        return format_date(d, fmt or "short") if d else str(v)
    if type_ == "number" and fmt:
        return format_number(to_number(v), fmt)
    return str(v)


# --------------------------------------------------------------------------- formulas
class FormulaError(ValueError):
    pass


def _utf16_len(s: str) -> int:
    return len(s.encode("utf-16-le")) // 2


def _proper(v) -> str:
    return re.sub(r"(^|\s)([^\W\d_])", lambda m: m[1] + m[2].upper(), js_string(v).lower())


def _right(v, n=1) -> str:
    s = js_string(v)
    k = to_number(n)
    return s if math.isnan(k) else s[max(0, len(s) - js_int(k)):]


def _mid(v, a, n) -> str:
    s, start, count = js_string(v), js_int(to_number(a) - 1), js_int(to_number(n))
    if start < 0:
        start = max(0, len(s) + start)
    return s[start:start + max(0, count)]


def _substitute(v, a, b) -> str:
    s, a, b = js_string(v), js_string(a), js_string(b)
    return b.join(s) if a == "" else s.replace(a, b)


def _add_days(d, n):
    x, k = to_date(d), to_number(n)
    if not x or math.isnan(k):
        return ""
    return x + dt.timedelta(days=js_int(k))


def _add_months(d, n):
    x, k = to_date(d), to_number(n)
    if not x or math.isnan(k):
        return ""
    return _js_date(x.year, x.month - 1 + js_int(k), x.day)


def _round(v, n=0):
    k = 10 ** to_number(n)
    return js_round(to_number(v) * k) / k


def _format(v, f):
    return format_date(v, js_string(f)) if isinstance(v, dt.date) else format_number(to_number(v), js_string(f))


FUNCTIONS = {
    "IF": ("SE", (), (2, 3), None),
    "ISBLANK": ("VUOTO", ("EMPTY",), (1, 1), lambda v: is_empty(v)),
    "AND": ("E", (), (1, 30), lambda *v: all(truthy(x) for x in v)),
    "OR": ("O", (), (1, 30), lambda *v: any(truthy(x) for x in v)),
    "NOT": ("NON", (), (1, 1), lambda v: not truthy(v)),
    "TODAY": ("OGGI", (), (0, 0), lambda: dt.date.today()),
    "ADDDAYS": ("AGGIUNGIGIORNI", (), (2, 2), _add_days),
    "ADDMONTHS": ("AGGIUNGIMESI", (), (2, 2), _add_months),
    "DATEFORMAT": ("FORMATODATA", (), (2, 2), lambda d, f: format_date(to_date(d), js_string(f))),
    "UPPER": ("MAIUSC", (), (1, 1), lambda v: js_string(v).upper()),
    "LOWER": ("MINUSC", (), (1, 1), lambda v: js_string(v).lower()),
    "PROPER": ("MAIUSC.INIZ", (), (1, 1), _proper),
    "CONCAT": ("CONCATENA", (), (1, 30), lambda *v: "".join(display(x) for x in v)),
    "LEFT": ("SINISTRA", (), (1, 2), lambda v, n=1: js_string(v)[:js_int(to_number(n))] if js_int(to_number(n)) else ""),
    "RIGHT": ("DESTRA", (), (1, 2), _right),
    "MID": ("STRINGA.ESTRAI", (), (3, 3), _mid),
    "LEN": ("LUNGHEZZA", (), (1, 1), lambda v: float(_utf16_len(js_string(v)))),
    "TRIM": ("ANNULLA.SPAZI", (), (1, 1), lambda v: re.sub(r"\s+", " ", js_string(v).strip())),
    "SUBSTITUTE": ("SOSTITUISCI", ("REPLACE",), (3, 3), _substitute),
    "FORMAT": ("FORMATO", ("TEXT", "TESTO"), (2, 2), _format),
    "ROUND": ("ARROTONDA", (), (1, 2), _round),
    "VALUE": ("NUMERO", ("VALORE",), (1, 1), lambda v: to_number(v)),
}
FN_INDEX = {}
for _name, (_it, _aliases, _n, _fn) in FUNCTIONS.items():
    for _key in (_name, _it, *_aliases):
        FN_INDEX[_key] = _name

_WORD = re.compile(r"[^\W\d][\w.]*")


def tokenize(src: str, fields: list[str]) -> list[dict]:
    """Tokens of an expression. Known field names are matched first (longest)."""
    ordered = sorted(fields, key=len, reverse=True)
    out, i = [], 0
    while i < len(src):
        c = src[i]
        if c.isspace():
            i += 1
            continue
        if c == '"':
            j, s = i + 1, ""
            while j < len(src) and not (src[j] == '"' and (src[j + 1] if j + 1 < len(src) else "") != '"'):
                if src[j] == '"':
                    j += 1
                s += src[j]
                j += 1
            if j >= len(src):
                raise FormulaError("unclosed text")
            out.append({"t": "str", "v": s})
            i = j + 1
            continue
        if c in "[«":
            close = "]" if c == "[" else "»"
            j = src.find(close, i + 1)
            if j < 0:
                raise FormulaError("unclosed field")
            out.append({"t": "field", "v": src[i + 1:j].strip()})
            i = j + 1
            continue
        if c.isdigit() and c.isascii() or (c == "." and src[i + 1:i + 2].isdigit()):
            m = re.match(r"\d+([.,]\d+)?", src[i:])
            text = m[0].split(",")[0] if m and "," in m[0] and ";" not in src else (m[0] if m else c)
            out.append({"t": "num", "v": float(text.replace(",", ".")) if m else 0.0})
            i += len(text)
            continue
        two = src[i:i + 2]
        if two in ("<=", ">=", "<>", "!="):
            out.append({"t": "op", "v": "<>" if two == "!=" else two})
            i += 2
            continue
        if c in "+-*/&=<>":
            out.append({"t": "op", "v": c})
            i += 1
            continue
        if c in "()":
            out.append({"t": c})
            i += 1
            continue
        if c in ";,":
            out.append({"t": "sep"})
            i += 1
            continue
        rest = src[i:]
        field = next((f for f in ordered if rest.lower().startswith(f.lower())
                      and not re.match(r"[\w.]", rest[len(f):len(f) + 1] or " ")), None)
        m = _WORD.match(rest)
        word = m[0] if m else None
        if word and word.upper() in FN_INDEX and re.match(r"\s*\(", rest[len(word):]):
            out.append({"t": "fn", "v": FN_INDEX[word.upper()]})
            i += len(word)
            continue
        if field:
            out.append({"t": "field", "v": field})
            i += len(field)
            continue
        if word and word.upper() in ("TRUE", "VERO", "FALSE", "FALSO"):
            out.append({"t": "bool", "v": word.upper() in ("TRUE", "VERO")})
            i += len(word)
            continue
        raise FormulaError(f"unknown name: {word}" if word else f"unexpected: {c}")
    return out


PREC = {"=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4}


def parse_formula(src: str, fields: list[str]):
    """An expression as a tree; raises FormulaError."""
    tokens = tokenize(str(src or ""), fields)
    pos = 0

    def peek():
        return tokens[pos] if pos < len(tokens) else None

    def take(t=None):
        nonlocal pos
        tok = peek()
        if not tok or (t and tok["t"] != t):
            raise FormulaError("incomplete" if not tok else "unexpected token")
        pos += 1
        return tok

    def primary():
        nonlocal pos
        tok = peek()
        if not tok:
            raise FormulaError("incomplete")
        if tok["t"] == "op" and tok["v"] in "-+":
            pos += 1
            v = primary()
            return ("neg", v) if tok["v"] == "-" else v
        if tok["t"] in ("num", "str", "bool"):
            pos += 1
            return ("lit", tok["v"])
        if tok["t"] == "field":
            pos += 1
            name = next((f for f in fields if f.lower() == tok["v"].lower()), None)
            if name is None:
                raise FormulaError(f"no field {tok['v']}")
            return ("field", name)
        if tok["t"] == "fn":
            pos += 1
            take("(")
            args = []
            if (peek() or {}).get("t") != ")":
                args.append(expr(0))
                while (peek() or {}).get("t") == "sep":
                    pos += 1
                    args.append(expr(0))
            take(")")
            lo, hi = FUNCTIONS[tok["v"]][2]
            if not lo <= len(args) <= hi:
                raise FormulaError(f"wrong number of arguments for {tok['v']}")
            return ("call", tok["v"], args)
        if tok["t"] == "(":
            pos += 1
            v = expr(0)
            take(")")
            return v
        raise FormulaError("unexpected token")

    def expr(min_prec):
        left = primary()
        while (peek() or {}).get("t") == "op" and PREC[peek()["v"]] > min_prec:
            op = take()["v"]
            left = ("bin", op, left, expr(PREC[op]))
        return left

    tree = expr(0)
    if pos < len(tokens):
        raise FormulaError("unexpected token")
    return tree


def evaluate(node, values: dict):
    kind = node[0]
    if kind == "lit":
        return node[1]
    if kind == "field":
        v = values.get(node[1])
        return "" if v is None else v
    if kind == "neg":
        return -to_number(evaluate(node[1], values))
    if kind == "call":
        name, args = node[1], node[2]
        if name == "IF":  # only the branch taken is evaluated
            if truthy(evaluate(args[0], values)):
                return evaluate(args[1], values)
            return evaluate(args[2], values) if len(args) > 2 else ""
        return FUNCTIONS[name][3](*(evaluate(a, values) for a in args))
    a, b = evaluate(node[2], values), evaluate(node[3], values)
    op = node[1]
    da = a if isinstance(a, dt.date) else None
    if op == "&":
        return display(a) + display(b)
    if op == "+":
        if da or (isinstance(a, str) and ISO_DATE.match(a) and to_date(a)):
            k = to_number(b)
            return (da or to_date(a)) + dt.timedelta(days=js_int(k)) if not math.isnan(k) else ""
        return to_number(a) + to_number(b)
    if op == "-":
        db = b if isinstance(b, dt.date) else to_date(b)
        if da and db:
            return float((da - db).days)
        if da:
            k = to_number(b)
            return da - dt.timedelta(days=js_int(k)) if not math.isnan(k) else ""
        return to_number(a) - to_number(b)
    if op == "*":
        return to_number(a) * to_number(b)
    if op == "/":
        return "" if to_number(b) == 0 else to_number(a) / to_number(b)
    return compare(a, b, op)


def compare(a, b, op: str) -> bool:
    na, nb = to_number(a), to_number(b)
    da, db = to_date(a), to_date(b)
    if da and db:
        x, y = da.toordinal(), db.toordinal()
    elif not math.isnan(na) and not math.isnan(nb) and js_string(a).strip() and js_string(b).strip():
        x, y = na, nb
    else:
        x, y = js_string(a).lower(), js_string(b).lower()
    return {"=": x == y, "<>": x != y, "<": x < y, ">": x > y, "<=": x <= y, ">=": x >= y}.get(op, False)


_compiled: dict = {}


def compiled(expr: str, fields: list[str]):
    key = ("\x01".join(fields), expr)
    if key not in _compiled:
        try:
            _compiled[key] = (parse_formula(expr, fields), None)
        except FormulaError as e:
            _compiled[key] = (None, str(e))
        if len(_compiled) > 500:
            _compiled.pop(next(iter(_compiled)))
    return _compiled[key]


# --------------------------------------------------------------------------- fields and rows
def column_names(data: dict | None) -> list[str]:
    return [c["name"] for c in (data or {}).get("columns") or []]


def field_names(data: dict | None) -> list[str]:
    return column_names(data) + [f["name"] for f in (data or {}).get("formulas") or []]


def row_values(data: dict | None, index: int) -> dict:
    """The raw values of a row: columns, then formula fields in order."""
    values: dict = {}
    if not data:
        return values
    rows = data.get("rows") or []
    row = rows[index] if 0 <= index < len(rows) else []
    for i, c in enumerate(data["columns"]):
        v = row[i] if i < len(row) else None
        values[c["name"]] = "" if v is None else v
    known = column_names(data)
    for f in data.get("formulas") or []:
        tree, error = compiled(f.get("expr") or "", known)
        v = ""
        if not error:
            try:
                v = evaluate(tree, values)
            except (ArithmeticError, ValueError, TypeError, OverflowError):
                v = ""
        values[f["name"]] = v
        known = [*known, f["name"]]
    return values


def row_texts(data: dict | None, index: int) -> tuple[dict, dict]:
    """The text of every field for a row, and the raw values."""
    raw = row_values(data, index)
    if not data:
        return {}, raw
    texts = {c["name"]: display(raw.get(c["name"]), c.get("type"), c.get("format")) for c in data["columns"]}
    for f in data.get("formulas") or []:
        texts[f["name"]] = display(raw.get(f["name"]), None, f.get("format"))
    return texts, raw


def expand_fields(text: str, texts: dict | None) -> str:
    """«Field» → its text; unknown fields stay visible so the mistake shows."""
    if not text or "«" not in text:
        return text or ""
    return FIELD_RE.sub(lambda m: texts[m[1]] if texts and m[1] in texts else m[0], text)


def expand_all(text: str, env: dict) -> str:
    """Variables then fields: the final text of an object for one label."""
    return expand_fields(document.expand(text, env.get("vars") or {}, FMT), env.get("texts"))


def fields_in(text) -> list[str]:
    return FIELD_RE.findall(str(text or ""))


def object_shows(o: dict, env: dict) -> bool:
    """Whether an object prints on a label: conditional visibility, then empty fields."""
    if o.get("hidden"):
        return False
    vis = o.get("visible") or {"mode": "always"}
    if vis.get("mode") == "never":
        return False
    raw = env.get("raw") or {}
    if vis.get("mode") == "if" and vis.get("rules"):
        results = [rule_matches(r, raw.get(r.get("field"))) for r in vis["rules"]]
        if not (any(results) if vis.get("join") == "or" else all(results)):
            return False
    texts = env.get("texts")
    if o.get("empty") == "hide" and texts is not None:
        used = fields_in(o.get("text") if o.get("text") is not None else o.get("content"))
        if used and all(f in texts and is_empty(texts[f]) for f in used):
            return False
    return True


def rule_matches(rule: dict, value) -> bool:
    op, target = rule.get("op"), rule.get("value")
    if op == "eq":
        return compare(value, target, "=")
    if op == "ne":
        return compare(value, target, "<>")
    if op == "contains":
        return js_string(target).lower() in js_string(value).lower()
    if op == "empty":
        return is_empty(value)
    if op == "notEmpty":
        return not is_empty(value)
    if op == "true":
        return truthy(value)
    if op == "false":
        return not truthy(value)
    if op == "gt":
        return compare(value, target, ">")
    if op == "lt":
        return compare(value, target, "<")
    return True


def visible_rows(data: dict | None) -> list[int]:
    """Row indexes after filter and sort."""
    if not data:
        return []
    rows = list(range(len(data.get("rows") or [])))
    for f in data.get("filter") or []:
        rows = [i for i in rows if rule_matches(f, row_values(data, i).get(f.get("field")))]
    sort = data.get("sort") or {}
    if sort.get("field"):
        import functools

        def order(a, b):
            ka, kb = row_values(data, a).get(sort["field"]), row_values(data, b).get(sort["field"])
            r = -1 if compare(ka, kb, "<") else 1 if compare(ka, kb, ">") else 0
            return -r if sort.get("desc") else r
        rows.sort(key=functools.cmp_to_key(order))
    return rows


def printed_rows(data: dict | None, which: str | None = None) -> list[int]:
    """The rows that print, in order: all, the checked ones or a range."""
    which = which or (data or {}).get("which") or "all"
    rows = visible_rows(data)
    if which == "checked":
        checked = set((data or {}).get("checked") or [])
        return [i for i in rows if i in checked]
    if which == "range":
        r = (data or {}).get("range") or {}
        start = max(1.0, _or(to_number(r.get("from")), 1.0))
        end = max(start, _or(to_number(r.get("to")), start))
        return [i for k, i in enumerate(rows) if start <= k + 1 <= end]
    return rows


def row_copies(data: dict | None, index: int) -> int:
    """Copies of a row from the copies column (1 when the cell is empty or not a number)."""
    if not data or not data.get("copies"):
        return 1
    v = to_number(row_values(data, index).get(data["copies"]))
    return max(0, min(999, int(js_round(v)))) if math.isfinite(v) else 1


def label_plan(doc: dict, start: float | None = None, repeat: int | None = None, collate: bool | None = None,
               rows: list[int] | None = None, which: str | None = None, count: int | None = None,
               now: dt.datetime | None = None) -> list[dict]:
    """Every label to print, in order: [{vars, row, copy, copies, texts, raw, repeat}].

    Rows × copies × repeat; with "collate" the whole series repeats (1,2,3 · 1,2,3),
    otherwise each label repeats in place (1,1 · 2,2 · 3,3). {n} goes up one step per label.
    """
    s = doc["series"]
    now = now or dt.datetime.now()
    pad = int(max(0.0, min(8.0, _or(to_number(s.get("pad")), 0.0))))
    step = _or(to_number(s.get("step")), 1.0)
    n = _or(to_number(s.get("start") if start is None else start), 0.0)
    # As the Studio's loop k < repeat: 2.5 repeats print three times.
    reps = math.ceil(max(1.0, min(999.0, _or(to_number(s.get("repeat") if repeat is None else repeat), 1.0))))
    collate = s.get("collate", True) if collate is None else collate
    collate = True if collate is None else collate
    data = doc.get("data") if doc.get("data") and doc["data"].get("columns") else None
    if data:
        base = []
        for r in rows if rows is not None else printed_rows(data, which):
            copies = row_copies(data, r)
            texts, raw = row_texts(data, r)
            base += [{"row": r, "copy": c + 1, "copies": copies, "texts": texts, "raw": raw} for c in range(copies)]
    else:
        total = int(max(1.0, min(9999.0, _or(to_number(s.get("count") if count is None else count), 1.0)))) if document.uses_counter(doc) else 1
        base = [{"row": None, "copy": 1, "copies": 1, "texts": None, "raw": {}} for _ in range(total)]
    plan = []
    if collate:
        for k in range(reps):
            plan += [{**b, "repeat": k + 1} for b in base]
    else:
        for b in base:
            plan += [{**b, "repeat": k + 1} for k in range(reps)]
    for item in plan:
        item["vars"] = {"n": n, "pad": pad, "now": now}
        n += step
    return plan


def _title(s: str) -> str:
    return re.sub(r"(^|\s)([^\W\d_])", lambda m: m[1] + m[2].upper(), s.lower())


def object_text(o: dict, env: dict) -> str:
    """The text an object shows on this label (variables, fields, case, empty field)."""
    content = expand_all(o.get("text") if o.get("type") == "text" else o.get("content"), env)
    source = o.get("text") if o.get("text") is not None else o.get("content")
    if o.get("empty") == "dash" and env.get("texts") is not None and fields_in(source) and not content.strip():
        content = "—"
    transform = o.get("transform")
    if transform == "upper":
        content = content.upper()
    elif transform == "lower":
        content = content.lower()
    elif transform == "title":
        content = _title(content)
    return content


def layout_for(doc: dict, env: dict) -> list[dict]:
    """The objects that print on one label, in order. With "close the gap" the objects to the
    right of a hidden one move left by the space it took."""
    shown = [o for o in doc["objects"] if object_shows(o, env)]
    gaps = [o for o in doc["objects"] if not o.get("hidden") and o.get("closeGap") and o not in shown]
    if not gaps:
        return shown
    out = []
    for o in shown:
        b = document.bounds([o])
        dx = 0.0
        for g in gaps:
            gb = document.bounds([g])
            if b["y0"] < gb["y1"] and b["y1"] > gb["y0"] and b["x0"] >= gb["x1"] - 0.01:
                starts = [document.bounds([s])["x0"] for s in shown
                          if document.bounds([s])["x0"] >= gb["x1"] - 0.01
                          and document.bounds([s])["y0"] < gb["y1"] and document.bounds([s])["y1"] > gb["y0"]]
                dx += min(starts) - gb["x0"] if starts else gb["w"]
        out.append({**o, "x": o["x"] - dx} if dx else o)
    return out


# The language of the formats (dates, decimals, yes/no). set_language() changes it.
FMT = formats.get("en")


def set_language(lang: str | None) -> formats.Formats:
    global FMT
    FMT = formats.get(lang)
    return FMT
