"use strict";
/* Linked data: rows, fields, formula fields, filters, conditional visibility and the
 * plan of the labels to print (rows × copies × repeats, with the counter).
 *
 * A field appears in text, barcodes and QR codes as «Name». Formulas use the names of
 * spreadsheet functions in Italian or English (SE / IF, AGGIUNGIGIORNI / ADDDAYS, …),
 * with ";" or "," between arguments; fields are written [Name], «Name» or just Name.
 * The same grammar is meant for the headless Python printer, so keep it small.
 */

const FIELD_RE = /«([^«»]+)»/g;

// ------------------------------------------------------------------ values
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

/** A cell or formula value as a Date, when it is one (ISO or day-first text). */
function toDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v ?? "").trim();
  let m = ISO_DATE.exec(s);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(s);
  if (m) {
    const year = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
    const dayFirst = !/^en-US/.test(LOCALE) || Number(m[2]) > 12;
    const [d, mo] = dayFirst ? [Number(m[1]), Number(m[2])] : [Number(m[2]), Number(m[1])];
    const date = new Date(year, mo - 1, d);
    return date.getMonth() === mo - 1 ? date : null;
  }
  return null;
}

/** A value as a number: accepts "4,90", "1.234,5", "€ 3". */
function toNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  let s = String(v ?? "").replace(/[^\d,.\-+]/g, "");
  if (!s) return NaN;
  if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  else if (s.includes(",")) s = s.replace(",", ".");
  return Number(s);
}

const YES = new Set(["sì", "si", "yes", "y", "true", "vero", "x", "1", "ja", "oui", "sí", "sim", "да", "是", "はい"]);
const truthy = (v) => (typeof v === "boolean" ? v : typeof v === "number" ? v !== 0 : YES.has(String(v ?? "").trim().toLowerCase()));
const isEmpty = (v) => v === null || v === undefined || (typeof v === "string" && v.trim() === "");

const MONTHS = () => {
  try {
    const f = new Intl.DateTimeFormat(LOCALE, { month: "short" });
    return Array.from({ length: 12 }, (_, i) => f.format(new Date(2026, i, 1)).replace(".", ""));
  } catch {
    return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  }
};

/** Format a date: "short" (the language's numeric date), "month" (mm/yyyy), "long" (18 mar 2027),
 * or a pattern with dd/gg, mm, mmm, yyyy/aaaa, yy/aa. */
function formatDate(d, format = "short") {
  if (!d) return "";
  if (format === "short") return shortDate(d);
  if (format === "month") return `${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  if (format === "long") return `${d.getDate()} ${MONTHS()[d.getMonth()]} ${d.getFullYear()}`;
  return String(format)
    .replace(/aaaa|yyyy/gi, String(d.getFullYear()))
    .replace(/aa|yy/gi, String(d.getFullYear()).slice(2))
    .replace(/mmm/gi, MONTHS()[d.getMonth()])
    .replace(/mm/gi, pad2(d.getMonth() + 1))
    .replace(/gg|dd/gi, pad2(d.getDate()));
}

/** Format a number with a pattern such as "€ 0,00", "0.0 kg" or "#.##0": the decimals
 * and separators come from the pattern. */
function formatNumber(n, pattern) {
  if (!Number.isFinite(n)) return "";
  const m = /([#0][#0.,\s']*)/.exec(pattern || "");
  if (!m) return String(n);
  const core = m[1].trim();
  const lastSep = Math.max(core.lastIndexOf(","), core.lastIndexOf("."));
  const tail = lastSep >= 0 ? core.slice(lastSep + 1) : "";
  const decimal = lastSep >= 0 && /^0+$/.test(tail) ? core[lastSep] : null;
  const decimals = decimal ? tail.length : 0;
  const intPart = decimal ? core.slice(0, lastSep) : core;
  const group = /[.,\s']/.exec(intPart.replace(/^[#0]+/, ""))?.[0] || null;
  const fixed = Math.abs(n).toFixed(decimals);
  let [i, f] = fixed.split(".");
  if (group) i = i.replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const out = (n < 0 ? "-" : "") + i + (decimals ? decimal + f : "");
  return pattern.replace(m[1], out + (m[1].endsWith(" ") ? " " : ""));
}

/** The text a value shows on the label. */
function display(v, type, format) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return formatDate(v, format || "short");
  if (typeof v === "boolean") return v ? T.yes : T.no;
  if (typeof v === "number") return format ? formatNumber(v, format) : String(Math.round(v * 1e6) / 1e6).replace(".", LOCALE_DECIMAL);
  if (type === "date" || (type !== "text" && typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v))) {
    const d = toDate(v);
    return d ? formatDate(d, format || "short") : String(v);
  }
  if (type === "number" && format) return formatNumber(toNumber(v), format);
  return String(v);
}

// ------------------------------------------------------------------ formulas
const FUNCTIONS = {
  IF: { it: "SE", n: [2, 3], fn: (c, a, b) => (truthy(c) ? a : b ?? "") },
  ISBLANK: { it: "VUOTO", alias: ["EMPTY"], n: [1, 1], fn: (v) => isEmpty(v) },
  AND: { it: "E", n: [1, 30], fn: (...v) => v.every(truthy) },
  OR: { it: "O", n: [1, 30], fn: (...v) => v.some(truthy) },
  NOT: { it: "NON", n: [1, 1], fn: (v) => !truthy(v) },
  TODAY: { it: "OGGI", n: [0, 0], fn: () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); } },
  ADDDAYS: { it: "AGGIUNGIGIORNI", n: [2, 2], fn: (d, n) => { const x = toDate(d); return x ? new Date(x.getFullYear(), x.getMonth(), x.getDate() + toNumber(n)) : ""; } },
  ADDMONTHS: { it: "AGGIUNGIMESI", n: [2, 2], fn: (d, n) => { const x = toDate(d); return x ? new Date(x.getFullYear(), x.getMonth() + toNumber(n), x.getDate()) : ""; } },
  DATEFORMAT: { it: "FORMATODATA", n: [2, 2], fn: (d, f) => formatDate(toDate(d), String(f)) },
  UPPER: { it: "MAIUSC", n: [1, 1], fn: (v) => String(v ?? "").toLocaleUpperCase(LOCALE) },
  LOWER: { it: "MINUSC", n: [1, 1], fn: (v) => String(v ?? "").toLocaleLowerCase(LOCALE) },
  PROPER: { it: "MAIUSC.INIZ", n: [1, 1], fn: (v) => String(v ?? "").toLocaleLowerCase(LOCALE).replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase(LOCALE)) },
  CONCAT: { it: "CONCATENA", n: [1, 30], fn: (...v) => v.map((x) => display(x)).join("") },
  LEFT: { it: "SINISTRA", n: [1, 2], fn: (v, n = 1) => String(v ?? "").slice(0, toNumber(n)) },
  RIGHT: { it: "DESTRA", n: [1, 2], fn: (v, n = 1) => { const s = String(v ?? ""); return s.slice(Math.max(0, s.length - toNumber(n))); } },
  MID: { it: "STRINGA.ESTRAI", n: [3, 3], fn: (v, a, n) => String(v ?? "").substr(toNumber(a) - 1, toNumber(n)) },
  LEN: { it: "LUNGHEZZA", n: [1, 1], fn: (v) => String(v ?? "").length },
  TRIM: { it: "ANNULLA.SPAZI", n: [1, 1], fn: (v) => String(v ?? "").trim().replace(/\s+/g, " ") },
  SUBSTITUTE: { it: "SOSTITUISCI", alias: ["REPLACE"], n: [3, 3], fn: (v, a, b) => String(v ?? "").split(String(a)).join(String(b)) },
  FORMAT: { it: "FORMATO", alias: ["TEXT", "TESTO"], n: [2, 2], fn: (v, f) => { const d = v instanceof Date ? v : null; return d ? formatDate(d, String(f)) : formatNumber(toNumber(v), String(f)); } },
  ROUND: { it: "ARROTONDA", n: [1, 2], fn: (v, n = 0) => { const k = 10 ** toNumber(n); return Math.round(toNumber(v) * k) / k; } },
  VALUE: { it: "NUMERO", alias: ["VALORE"], n: [1, 1], fn: (v) => toNumber(v) },
};
const FN_INDEX = (() => {
  const map = {};
  for (const [name, f] of Object.entries(FUNCTIONS)) {
    map[name] = name;
    map[f.it] = name;
    for (const a of f.alias || []) map[a] = name;
  }
  return map;
})();

/** The function names to show, in the user's language. */
const functionList = () => Object.entries(FUNCTIONS).map(([en, f]) => (LANG === "it" ? f.it : en));

class FormulaError extends Error {}

/** Tokens of an expression. Known field names are matched first (longest), so "Scade il"
 * is one field even without brackets. */
function tokenize(src, fields) {
  const sorted = [...fields].sort((a, b) => b.length - a.length);
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"') {
      let j = i + 1, s = "";
      while (j < src.length && !(src[j] === '"' && src[j + 1] !== '"')) { s += src[j] === '"' ? (j++, '"') : src[j]; j++; }
      if (j >= src.length) throw new FormulaError(T.fxUnclosedText);
      out.push({ t: "str", v: s, at: i });
      i = j + 1;
      continue;
    }
    if (c === "[" || c === "«") {
      const close = c === "[" ? "]" : "»";
      const j = src.indexOf(close, i + 1);
      if (j < 0) throw new FormulaError(T.fxUnclosedField);
      out.push({ t: "field", v: src.slice(i + 1, j).trim(), at: i });
      i = j + 1;
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] || ""))) {
      const m = /^\d+([.,]\d+)?/.exec(src.slice(i));
      // "1,5" is a number only when "," is not separating arguments: arguments use ";" then.
      const text = m[0].includes(",") && !src.includes(";") ? m[0].split(",")[0] : m[0];
      out.push({ t: "num", v: Number(text.replace(",", ".")), at: i });
      i += text.length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "<>", "!="].includes(two)) { out.push({ t: "op", v: two === "!=" ? "<>" : two, at: i }); i += 2; continue; }
    if ("+-*/&=<>".includes(c)) { out.push({ t: "op", v: c, at: i }); i++; continue; }
    if (c === "(" || c === ")") { out.push({ t: c, at: i }); i++; continue; }
    if (c === ";" || c === ",") { out.push({ t: "sep", at: i }); i++; continue; }
    const rest = src.slice(i);
    const field = sorted.find((f) => rest.toLowerCase().startsWith(f.toLowerCase()) && !/[\p{L}\p{N}_.]/u.test(rest[f.length] || ""));
    const word = /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(rest)?.[0];
    if (word && FN_INDEX[word.toUpperCase()] && /^\s*\(/.test(rest.slice(word.length))) {
      out.push({ t: "fn", v: FN_INDEX[word.toUpperCase()], at: i, len: word.length });
      i += word.length;
      continue;
    }
    if (field) { out.push({ t: "field", v: field, at: i, len: field.length }); i += field.length; continue; }
    if (word && /^(TRUE|VERO|FALSE|FALSO)$/i.test(word)) { out.push({ t: "bool", v: /^(TRUE|VERO)$/i.test(word), at: i }); i += word.length; continue; }
    if (word) throw new FormulaError(T.fxUnknown(word));
    throw new FormulaError(T.fxUnexpected(c));
  }
  return out;
}

const PREC = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4 };

/** Parse an expression into a tree; throws FormulaError with a readable message. */
function parseFormula(src, fields) {
  const tokens = tokenize(String(src || ""), fields);
  let p = 0;
  const peek = () => tokens[p];
  const take = (t) => {
    const tok = tokens[p];
    if (!tok || (t && tok.t !== t)) throw new FormulaError(tok ? T.fxUnexpected(src.slice(tok.at, tok.at + 1)) : T.fxIncomplete);
    p++;
    return tok;
  };
  const primary = () => {
    const tok = peek();
    if (!tok) throw new FormulaError(T.fxIncomplete);
    if (tok.t === "op" && (tok.v === "-" || tok.v === "+")) { p++; const v = primary(); return tok.v === "-" ? { k: "neg", v } : v; }
    if (tok.t === "num" || tok.t === "str" || tok.t === "bool") { p++; return { k: "lit", v: tok.v }; }
    if (tok.t === "field") {
      p++;
      if (!fields.some((f) => f.toLowerCase() === tok.v.toLowerCase())) throw new FormulaError(T.fxNoField(tok.v));
      return { k: "field", v: fields.find((f) => f.toLowerCase() === tok.v.toLowerCase()) };
    }
    if (tok.t === "fn") {
      p++;
      take("(");
      const args = [];
      if (peek()?.t !== ")") {
        args.push(expr(0));
        while (peek()?.t === "sep") { p++; args.push(expr(0)); }
      }
      take(")");
      const [lo, hi] = FUNCTIONS[tok.v].n;
      if (args.length < lo || args.length > hi) throw new FormulaError(T.fxArgs(LANG === "it" ? FUNCTIONS[tok.v].it : tok.v));
      return { k: "call", f: tok.v, args };
    }
    if (tok.t === "(") { p++; const v = expr(0); take(")"); return v; }
    throw new FormulaError(T.fxUnexpected(src.slice(tok.at, tok.at + 1)));
  };
  const expr = (min) => {
    let left = primary();
    while (peek()?.t === "op" && PREC[peek().v] > min) {
      const op = take().v;
      left = { k: "bin", op, a: left, b: expr(PREC[op]) };
    }
    return left;
  };
  const tree = expr(0);
  if (p < tokens.length) throw new FormulaError(T.fxUnexpected(src.slice(tokens[p].at, tokens[p].at + 1)));
  return tree;
}

function evalTree(n, values) {
  switch (n.k) {
    case "lit": return n.v;
    case "field": return values[n.v] ?? "";
    case "neg": return -toNumber(evalTree(n.v, values));
    case "call": {
      const f = FUNCTIONS[n.f];
      if (n.f === "IF") { // only the branch taken is evaluated
        return truthy(evalTree(n.args[0], values)) ? evalTree(n.args[1], values) : n.args[2] ? evalTree(n.args[2], values) : "";
      }
      return f.fn(...n.args.map((a) => evalTree(a, values)));
    }
    case "bin": {
      const a = evalTree(n.a, values), b = evalTree(n.b, values);
      const da = a instanceof Date ? a : null;
      switch (n.op) {
        case "&": return display(a) + display(b);
        case "+": {
          if (da || (toDate(a) && typeof a === "string" && ISO_DATE.test(a))) {
            const d = da || toDate(a);
            return new Date(d.getFullYear(), d.getMonth(), d.getDate() + toNumber(b));
          }
          return toNumber(a) + toNumber(b);
        }
        case "-": {
          const db = b instanceof Date ? b : toDate(b);
          if (da && db) return Math.round((da - db) / 86400000);
          if (da) return new Date(da.getFullYear(), da.getMonth(), da.getDate() - toNumber(b));
          return toNumber(a) - toNumber(b);
        }
        case "*": return toNumber(a) * toNumber(b);
        case "/": return toNumber(b) === 0 ? "" : toNumber(a) / toNumber(b);
        default: return compare(a, b, n.op);
      }
    }
    default: return "";
  }
}

function compare(a, b, op) {
  let x = a, y = b;
  const na = toNumber(a), nb = toNumber(b);
  const da = toDate(a), db = toDate(b);
  if (da && db) { x = da.getTime(); y = db.getTime(); }
  else if (!Number.isNaN(na) && !Number.isNaN(nb) && String(a).trim() !== "" && String(b).trim() !== "") { x = na; y = nb; }
  else { x = String(a ?? "").toLowerCase(); y = String(b ?? "").toLowerCase(); }
  switch (op) {
    case "=": return x === y;
    case "<>": return x !== y;
    case "<": return x < y;
    case ">": return x > y;
    case "<=": return x <= y;
    case ">=": return x >= y;
    default: return false;
  }
}

// Parsed formulas, by text and field list.
const formulaCache = new Map();
function compiled(expr, fields) {
  const key = `${fields.join("\u0001")}\u0002${expr}`;
  if (!formulaCache.has(key)) {
    try { formulaCache.set(key, { tree: parseFormula(expr, fields) }); } catch (e) { formulaCache.set(key, { error: e.message }); }
    if (formulaCache.size > 500) formulaCache.delete(formulaCache.keys().next().value);
  }
  return formulaCache.get(key);
}

// ------------------------------------------------------------------ fields and rows
const columnNames = (data) => (data?.columns || []).map((c) => c.name);
const fieldNames = (data) => [...columnNames(data), ...(data?.formulas || []).map((f) => f.name)];
const fieldType = (data, name) => data?.columns.find((c) => c.name === name)?.type || (data?.formulas.some((f) => f.name === name) ? "formula" : "text");

/** The raw values of a row: columns, then formula fields in order (each may use the ones before). */
function rowValues(data, index) {
  const values = {};
  if (!data) return values;
  const row = data.rows[index] || [];
  data.columns.forEach((c, i) => { values[c.name] = row[i] ?? ""; });
  const known = columnNames(data);
  for (const f of data.formulas || []) {
    const c = compiled(f.expr, known);
    let v = "";
    if (!c.error) {
      try { v = evalTree(c.tree, values); } catch { v = ""; }
    }
    values[f.name] = v;
    known.push(f.name);
  }
  return values;
}

/** The text of every field for a row, as it shows on the label. */
function rowTexts(data, index) {
  const raw = rowValues(data, index);
  const out = {};
  if (!data) return out;
  for (const c of data.columns) out[c.name] = display(raw[c.name], c.type, c.format);
  for (const f of data.formulas || []) out[f.name] = display(raw[f.name], null, f.format);
  return { texts: out, raw };
}

/** Replace «Field» with its text; unknown fields stay visible so the mistake shows. */
function expandFields(text, texts) {
  if (!text || !text.includes("«")) return text || "";
  return text.replace(FIELD_RE, (m, name) => (texts && name in texts ? texts[name] : m));
}

/** Variables then fields: the final text of an object for one label. */
function expandAll(text, env) {
  return expandFields(expand(text, env.vars || {}), env.texts);
}

const fieldsIn = (text) => [...String(text || "").matchAll(FIELD_RE)].map((m) => m[1]);

/** Whether an object prints on a label: conditional visibility, then empty fields. */
function objectShows(o, env) {
  if (o.hidden) return false;
  const vis = o.visible || { mode: "always" };
  if (vis.mode === "never") return false;
  const raw = env.raw || {};
  if (vis.mode === "if" && vis.rules?.length) {
    const results = vis.rules.map((r) => ruleMatches(r, raw[r.field]));
    if (!(vis.join === "or" ? results.some(Boolean) : results.every(Boolean))) return false;
  }
  if (o.empty === "hide" && env.texts) {
    const used = fieldsIn(o.text ?? o.content);
    if (used.length && used.every((f) => f in env.texts && isEmpty(env.texts[f]))) return false;
  }
  return true;
}

const RULE_OPS = ["eq", "ne", "contains", "empty", "notEmpty", "true", "false", "gt", "lt"];
function ruleMatches(rule, value) {
  switch (rule.op) {
    case "eq": return compare(value, rule.value, "=");
    case "ne": return compare(value, rule.value, "<>");
    case "contains": return String(value ?? "").toLowerCase().includes(String(rule.value ?? "").toLowerCase());
    case "empty": return isEmpty(value);
    case "notEmpty": return !isEmpty(value);
    case "true": return truthy(value);
    case "false": return !truthy(value);
    case "gt": return compare(value, rule.value, ">");
    case "lt": return compare(value, rule.value, "<");
    default: return true;
  }
}

/** Row indexes after filter and sort, before choosing all / checked / a range. */
function visibleRows(data) {
  if (!data) return [];
  let rows = data.rows.map((_, i) => i);
  for (const f of data.filter || []) {
    rows = rows.filter((i) => ruleMatches(f, rowValues(data, i)[f.field]));
  }
  if (data.sort?.field) {
    const key = (i) => rowValues(data, i)[data.sort.field];
    rows.sort((a, b) => (compare(key(a), key(b), "<") ? -1 : compare(key(a), key(b), ">") ? 1 : 0) * (data.sort.desc ? -1 : 1));
  }
  return rows;
}

/** The rows that print, in order. */
function printedRows(data, which = data?.which || "all") {
  const rows = visibleRows(data);
  if (which === "checked") {
    const checked = new Set(data.checked || []);
    return rows.filter((i) => checked.has(i));
  }
  if (which === "range") {
    const from = Math.max(1, Number(data.range?.from) || 1), to = Math.max(from, Number(data.range?.to) || from);
    return rows.filter((_, k) => k + 1 >= from && k + 1 <= to);
  }
  return rows;
}

/** Copies of a row from the copies column (at least 1 when the cell is empty or not a number). */
function rowCopies(data, index) {
  if (!data?.copies) return 1;
  const v = toNumber(rowValues(data, index)[data.copies]);
  return Number.isFinite(v) ? Math.max(0, Math.min(999, Math.round(v))) : 1;
}

/**
 * Every label to print, in order: [{vars, row, copy, copies, texts, raw}].
 * Rows × copies × repeat; with "collate" the whole series repeats (1,2,3 · 1,2,3),
 * otherwise each label repeats in place (1,1 · 2,2 · 3,3). The counter {n} goes up
 * by one step per label.
 */
function labelPlan(doc, options = {}) {
  const s = doc.series;
  const now = new Date();
  const pad = Math.max(0, Math.min(8, Number(s.pad) || 0));
  const step = Number(s.step) || 1;
  let n = Number(options.start ?? s.start) || 0;
  const repeat = Math.max(1, Math.min(999, Number(options.repeat ?? s.repeat) || 1));
  const collate = options.collate ?? s.collate ?? true;
  const data = doc.data && doc.data.columns.length ? doc.data : null;
  let base;
  if (data) {
    const rows = options.rows || printedRows(data, options.which);
    base = [];
    for (const r of rows) {
      const copies = rowCopies(data, r);
      const { texts, raw } = rowTexts(data, r);
      for (let c = 0; c < copies; c++) base.push({ row: r, copy: c + 1, copies, texts, raw });
    }
  } else {
    const count = usesCounter(doc) ? Math.max(1, Math.min(9999, Number(options.count ?? s.count) || 1)) : 1;
    base = Array.from({ length: count }, () => ({ row: null, copy: 1, copies: 1 }));
  }
  const out = [];
  if (collate) {
    for (let k = 0; k < repeat; k++) for (const b of base) out.push({ ...b, repeat: k + 1 });
  } else {
    for (const b of base) for (let k = 0; k < repeat; k++) out.push({ ...b, repeat: k + 1 });
  }
  for (const item of out) {
    item.vars = { n, pad, now };
    n += step;
  }
  return out;
}

/** The variables and field texts shown while editing: the current row. */
function editEnv(doc) {
  const s = doc.series;
  const vars = { n: Number(s.start) || 0, pad: Number(s.pad) || 0, now: new Date() };
  const data = doc.data && doc.data.columns.length ? doc.data : null;
  if (!data || !data.rows.length) return { vars, doc, texts: data ? Object.fromEntries(fieldNames(data).map((f) => [f, ""])) : null, raw: {} };
  const row = Math.max(0, Math.min(data.rows.length - 1, data.current || 0));
  const { texts, raw } = rowTexts(data, row);
  return { vars, doc, texts, raw, row };
}

/** Detect a column type from its cells (same rules as the Python reader). */
function detectType(values) {
  const cells = values.map((v) => String(v ?? "").trim()).filter(Boolean);
  if (!cells.length) return "text";
  const gs1 = (c) => /^\d+$/.test(c) && [8, 12, 13, 14].includes(c.length) && gs1Check(c.slice(0, -1)) === Number(c.at(-1));
  if (cells.every((c) => gs1(c) && c.length === 13)) return "ean13";
  if (cells.every((c) => gs1(c) && c.length === 8)) return "ean8";
  if (cells.every((c) => ISO_DATE.test(c) || /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}$/.test(c))) return "date";
  const bools = new Set([...YES, "no", "n", "false", "falso", "0", "nein", "non", "não", "нет", "否", "いいえ"]);
  if (cells.every((c) => bools.has(c.toLowerCase())) && cells.some((c) => !/^\d+$/.test(c))) return "bool";
  if (cells.every((c) => !Number.isNaN(toNumber(c)) && /^[+-]?[\d.,\s']+$/.test(c))) return "number";
  return "text";
}

function gs1Check(digits) {
  let total = 0;
  [...digits].reverse().forEach((d, i) => { total += Number(d) * (i % 2 === 0 ? 3 : 1); });
  return (10 - (total % 10)) % 10;
}

/** What changed in a linked file since the copy in the document. */
function diffTables(oldData, table) {
  const oldNames = columnNames(oldData), newNames = table.columns.map((c) => c.name);
  const removed = oldNames.filter((n) => !newNames.includes(n));
  const added = newNames.filter((n) => !oldNames.includes(n));
  const renamed = [];
  for (const r of removed) { // same position, new name: probably renamed
    const i = oldNames.indexOf(r);
    if (added.includes(newNames[i])) renamed.push({ from: r, to: newNames[i] });
  }
  const key = (row) => JSON.stringify(row);
  const before = new Set(oldData.rows.map(key));
  const after = new Set(table.rows.map(key));
  const newRows = table.rows.filter((r) => !before.has(key(r))).length;
  const goneRows = oldData.rows.filter((r) => !after.has(key(r))).length;
  const changed = Math.min(newRows, goneRows);
  return { added: newRows - changed, removed: goneRows - changed, changed, renamed, columnsAdded: added, columnsRemoved: removed };
}

/** Rename a field everywhere in the document (text, codes, formulas, conditions). */
function renameField(doc, from, to) {
  const re = new RegExp(`«${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}»`, "g");
  for (const o of doc.objects) {
    if (typeof o.text === "string") o.text = o.text.replace(re, `«${to}»`);
    if (typeof o.content === "string") o.content = o.content.replace(re, `«${to}»`);
    for (const r of o.visible?.rules || []) if (r.field === from) r.field = to;
  }
  for (const f of doc.data?.formulas || []) f.expr = f.expr.split(`[${from}]`).join(`[${to}]`).split(`«${from}»`).join(`«${to}»`);
  if (doc.data?.copies === from) doc.data.copies = to;
  for (const r of doc.data?.filter || []) if (r.field === from) r.field = to;
}

/** Fields used by the document that the data does not have. */
function missingFields(doc) {
  const names = new Set(fieldNames(doc.data));
  const used = new Set();
  for (const o of doc.objects) for (const f of fieldsIn(`${o.text || ""} ${o.content || ""}`)) used.add(f);
  return [...used].filter((f) => !names.has(f));
}
