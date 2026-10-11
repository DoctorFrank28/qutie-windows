"use strict";
/* The label document: units, defaults, variables and templates.
 *
 * Geometry is in millimetres, in reading orientation: x runs along the tape, y across
 * it (0–12 mm). The printer draws 96 dots across at 203 dpi; render.js turns the
 * document into those dots and the app turns them onto the tape.
 *
 * The .qutie file is this document as JSON. It does not depend on the Studio's
 * interface, so a headless printer can read it too.
 */

const DPI = 203;
const DPMM = DPI / 25.4;
const HEAD_DOTS = 96;
const TAPE_MM = HEAD_DOTS / DPMM; // 12.01 mm
const PT = DPI / 72; // dots per typographic point
const mmToDots = (mm) => Math.floor(mm * DPMM + 1e-6); // as protocol.mm_to_dots
const dots = (mm) => mm * DPMM;
const toMm = (dotCount) => dotCount / DPMM;

const LENGTHS = [30, 40, 50, 70, 100];
const FEED_GAP = 10; // protocol.EXTRA_MM
const FEED_CONTINUOUS = 14; // protocol.FEED_MM
const FORMAT_VERSION = 2;

let nextId = 1;
const newId = () => `o${Date.now().toString(36)}${(nextId++).toString(36)}`;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`);

const fill = (type = "solid", more = {}) => ({ type, ink: 100, pattern: "diag", scale: 5, weight: 1, from: 100, to: 0, angle: 0, ...more });
const stroke = (width = 0, more = {}) => ({ width, ink: 100, dash: "solid", ...more });

/** A new object of `type` with sensible defaults, merged with `props`. */
function makeObject(type, props = {}) {
  const base = {
    id: newId(), type, name: "", x: 2, y: 1, w: 20, h: 10, rotation: 0,
    hidden: false, locked: false, group: null,
    dither: { mode: "auto", threshold: 128, cell: 6, angle: 45 },
    visible: { mode: "always", join: "and", rules: [] },
    empty: "hide", closeGap: false,
  };
  const kinds = {
    text: {
      w: 30, h: 10, text: "", font: Prefs.font, size: 24, autoFit: true,
      bold: Prefs.bold, italic: false, underline: false, strike: false,
      align: "center", valign: "middle", spacing: 0, lineHeight: 1.05, transform: "none", wrap: false,
      fill: fill("solid"), stroke: stroke(0), background: fill("none"), padding: 0, radius: 0, symbol: false,
    },
    rect: { w: 20, h: 8, fill: fill("none"), stroke: stroke(0.4), radius: 1 },
    ellipse: { w: 10, h: 10, fill: fill("solid"), stroke: stroke(0) },
    line: { w: 20, h: 1.5, stroke: stroke(0.3), arrowStart: false, arrowEnd: false },
    image: {
      w: 12, h: 12, asset: null, fileName: "", fit: "contain", brightness: 0, contrast: 0, gamma: 1,
      invert: false, autoLevels: true, whiteEmpty: true, flipH: false, flipV: false,
    },
    barcode: { w: 30, h: 10, kind: "code128", content: "QUTIE-001", textPos: "below", textSize: 6, font: "Consolas", moduleDots: 0 },
    qr: {
      w: 10, h: 10, kind: "qr", content: "https://", ecc: "m", quiet: 0, version: "auto", moduleDots: 0,
      invert: false, qrType: "link", qrData: {},
    },
  };
  const obj = { ...base, ...structuredClone(kinds[type] || {}), ...props };
  if (props.dither) obj.dither = { ...base.dither, ...props.dither };
  if (props.visible) obj.visible = { ...base.visible, ...props.visible };
  if (obj.type === "barcode" && "showText" in obj) { // version 1 files
    if (!obj.showText) obj.textPos = "none";
    delete obj.showText;
  }
  if (obj.type === "qr" && typeof obj.quiet === "boolean") obj.quiet = obj.quiet ? 4 : 0;
  return obj;
}

/** Defaults the user can change in Settings (font, bold); kept here so templates follow them. */
const Prefs = { font: "Segoe UI", bold: true };

function newDocument(props = {}) {
  return {
    format: "qutie-label", version: FORMAT_VERSION, id: uid(), name: T.untitled,
    label: { media: "gap", length: 40, auto: false, margin: 2, feed: FEED_GAP },
    objects: [], assets: {},
    series: { start: 1, step: 1, count: 10, pad: 0, repeat: 1, collate: true, advance: true },
    data: null,
    ...props,
  };
}

/** An empty data block: a source, its columns and rows, and how they are printed. */
function newData(props = {}) {
  return {
    source: { kind: "table", name: T.dataTableName, path: null, sheet: null, header: true, link: "reread", read: null, modified: null },
    columns: [], rows: [], checked: [], formulas: [], filter: [], sort: null,
    copies: null, current: 0, which: "all", range: { from: 1, to: 1 }, search: "",
    ...props,
  };
}

/** Upgrade a document read from a file: fill in anything missing. */
function normalizeDocument(raw) {
  const doc = newDocument();
  if (!raw || typeof raw !== "object") return doc;
  doc.id = String(raw.id || doc.id);
  doc.name = String(raw.name || doc.name);
  Object.assign(doc.label, raw.label || {});
  Object.assign(doc.series, raw.series || {});
  doc.assets = raw.assets && typeof raw.assets === "object" ? raw.assets : {};
  doc.objects = (Array.isArray(raw.objects) ? raw.objects : [])
    .filter((o) => o && typeof o === "object" && o.type)
    .map((o) => makeObject(o.type, { ...o, id: o.id || newId() }));
  if (raw.data && typeof raw.data === "object" && Array.isArray(raw.data.columns)) {
    doc.data = newData({ ...raw.data, source: { ...newData().source, ...(raw.data.source || {}) } });
  } else if (raw.series?.rows && /\{[1-9]\}/.test(JSON.stringify(raw.objects || []))) {
    // Version 1: a pasted list with {1}, {2}… becomes a table with fields.
    const rows = String(raw.series.rows).split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(/\t|;|,/).map((c) => c.trim()));
    const width = Math.max(1, ...rows.map((r) => r.length));
    const names = Array.from({ length: width }, (_, i) => `${T.column} ${i + 1}`);
    doc.data = newData({ columns: names.map((name) => ({ name, type: "text" })), rows: rows.map((r) => names.map((_, i) => r[i] || "")) });
    for (const o of doc.objects) {
      for (const key of ["text", "content"]) if (typeof o[key] === "string") o[key] = o[key].replace(/\{([1-9])\}/g, (_, i) => `«${names[i - 1] || ""}»`);
    }
  }
  if (raw.template) doc.template = raw.template;
  return doc;
}

// ------------------------------------------------------------------ variables
/** Placeholders in text and codes, filled in for every label of a series. Italian names work too. */
const VAR_RE = /\{(n|date|data|month|mese|time|ora|year|anno|[1-9])([+-]\d+)?\}/g;
const VAR_ALIAS = { data: "date", mese: "month", ora: "time", anno: "year" };

function usesVariable(doc, pattern) {
  return doc.objects.some((o) => pattern.test(`${o.text || ""} ${o.content || ""}`));
}
const usesCounter = (doc) => usesVariable(doc, /\{n([+-]\d+)?\}/);

const pad2 = (v) => String(v).padStart(2, "0");

/** A date as the user's language writes it (11/10/2026 in Italian). */
function shortDate(d) {
  try {
    return new Intl.DateTimeFormat(LOCALE, { day: "2-digit", month: "2-digit", year: "numeric" }).format(d);
  } catch {
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
}

/** A month as the user's language writes it (10/2026 in Italian). */
function monthYear(d) {
  try {
    return new Intl.DateTimeFormat(LOCALE, { month: "2-digit", year: "numeric" }).format(d);
  } catch {
    return `${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
}

/** A time as the user's language writes it (10:42 in Italian). */
function shortTime(d) {
  try {
    return new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" }).format(d);
  } catch {
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
}

function expand(text, vars) {
  if (!text || !text.includes("{")) return text || "";
  const now = vars.now || new Date();
  return text.replace(VAR_RE, (match, key, delta) => {
    const k = Number(delta || 0);
    switch (VAR_ALIAS[key] || key) {
      case "n": return String((vars.n ?? 1) + k).padStart(vars.pad || 0, "0");
      case "date": return shortDate(new Date(now.getTime() + k * 86400000));
      case "month": return monthYear(new Date(now.getFullYear(), now.getMonth() + k, 1));
      case "year": return String(now.getFullYear() + k);
      case "time": return shortTime(now);
      default: return vars.row?.[Number(key) - 1] ?? "";
    }
  });
}

// ------------------------------------------------------------------ geometry
const rad = (deg) => (deg * Math.PI) / 180;

/** Corners of an object (mm), rotated about its centre. */
function corners(o) {
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const c = Math.cos(rad(o.rotation || 0)), s = Math.sin(rad(o.rotation || 0));
  return [[-o.w / 2, -o.h / 2], [o.w / 2, -o.h / 2], [o.w / 2, o.h / 2], [-o.w / 2, o.h / 2]]
    .map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}

/** Axis-aligned bounds (mm) of objects. */
function bounds(objects) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const o of objects) {
    for (const [x, y] of corners(o)) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

/** A point (mm) in the object's own frame: (0,0) top-left of the unrotated box. */
function toLocal(o, x, y) {
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const c = Math.cos(-rad(o.rotation || 0)), s = Math.sin(-rad(o.rotation || 0));
  const dx = x - cx, dy = y - cy;
  return [dx * c - dy * s + o.w / 2, dx * s + dy * c + o.h / 2];
}

function fromLocal(o, lx, ly) {
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const c = Math.cos(rad(o.rotation || 0)), s = Math.sin(rad(o.rotation || 0));
  const dx = lx - o.w / 2, dy = ly - o.h / 2;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

/** Label length (mm). Continuous tape with "auto" follows the content. */
function labelLength(doc, objects = doc.objects) {
  const l = doc.label;
  if (l.media === "continuous" && l.auto) {
    const visible = objects.filter((o) => !o.hidden);
    const end = visible.length ? bounds(visible).x1 : 20;
    return Math.max(5, Math.min(1000, end + (Number(l.margin) || 0)));
  }
  return Math.max(5, Math.min(1000, Number(l.length) || 40));
}

const labelFeed = (doc) => Number(doc.label.feed ?? (doc.label.media === "continuous" ? FEED_CONTINUOUS : FEED_GAP));

/** Media for the printer: {type, length_mm, feed_mm}. */
function mediaOf(doc, length = labelLength(doc)) {
  const continuous = doc.label.media === "continuous";
  return { type: continuous ? "continuous" : "gap", length_mm: continuous ? null : length, feed_mm: labelFeed(doc) };
}

/** The label quick print makes: one text, the last length or as long as the text. */
function quickDocument(text, length = "40") {
  const auto = length === "auto";
  const doc = newDocument({
    name: text.slice(0, 40),
    label: auto ? { media: "continuous", length: 40, auto: true, margin: 2, feed: FEED_CONTINUOUS } : { media: "gap", length: Number(length) || 40, auto: false, margin: 2, feed: FEED_GAP },
  });
  const lines = text.split(/\s*\n\s*|\s{2,}/).filter(Boolean);
  const w = auto ? Math.max(12, Math.min(200, text.length * 4.2)) : (Number(length) || 40) - 2;
  doc.objects.push(makeObject("text", { name: T.type_text, text: lines.join("\n"), x: 1, y: 0.6, w, h: TAPE_MM - 1.2 }));
  return doc;
}

// ------------------------------------------------------------------ templates
/** Ready-made labels for 12 mm tape. Built on demand so the strings follow the language.
 * Categories: kitchen, home (home and office), data (with linked data). */
function templates() {
  const H = TAPE_MM;
  const text = (props) => makeObject("text", { font: "Segoe UI", bold: true, ...props });
  const gap = (length) => ({ media: "gap", length, auto: false, margin: 2, feed: FEED_GAP });
  const doc = (props) => newDocument(props);
  return [
    { id: "blank", name: T.tplBlank, cats: [], note: T.tplBlankNote, doc: doc({ name: T.untitled }) },
    {
      id: "jar", name: T.tplJar, cats: ["kitchen"], note: T.tplJarNote,
      doc: doc({
        name: T.tplJar,
        objects: [
          text({ name: T.tplName_title, x: 1.5, y: 0.6, w: 37, h: 7.4, text: T.tplJarText, font: "Georgia" }),
          makeObject("line", { name: T.tplName_rule, x: 8, y: 7.9, w: 24, h: 0.6, stroke: stroke(0.25, { dash: "dotted" }) }),
          text({ name: T.tplName_date, x: 1.5, y: 8.4, w: 37, h: 3, text: "{date}", bold: false }),
        ],
      }),
    },
    {
      id: "freezer", name: T.tplFreezer, cats: ["kitchen"], note: T.tplFreezerNote,
      doc: doc({
        name: T.tplFreezer, label: gap(50),
        objects: [
          text({ name: T.tplName_symbol, x: 1, y: 1, w: 10, h: 10, text: "❄", font: "Segoe UI Symbol", bold: false, symbol: true }),
          text({ name: T.tplName_title, x: 12, y: 0.6, w: 37, h: 6.4, text: T.tplFreezerText, align: "left" }),
          text({ name: T.tplName_date, x: 12, y: 7.4, w: 37, h: 3.8, text: `${T.tplExpires} {date+90}`, align: "left", bold: false }),
        ],
      }),
    },
    {
      id: "warning", name: T.tplWarning, cats: ["home"], note: T.tplWarningNote,
      doc: doc({
        name: T.tplWarning, label: gap(50),
        objects: [
          makeObject("rect", { name: T.tplName_back, x: 0.5, y: 0.5, w: 49, h: H - 1, radius: 1.5, fill: fill("solid"), stroke: stroke(0) }),
          text({ name: T.tplName_symbol, x: 1.5, y: 1.2, w: 10, h: 9.6, text: "⚠", font: "Segoe UI Symbol", bold: false, symbol: true, fill: fill("solid", { ink: 0 }) }),
          text({ name: T.tplName_title, x: 11.5, y: 1.4, w: 37, h: 9.2, text: T.tplWarningText, font: "Arial Black", fill: fill("solid", { ink: 0 }), spacing: 6 }),
        ],
      }),
    },
    {
      id: "cable", name: T.tplCable, cats: ["home"], note: T.tplCableNote,
      doc: doc({
        name: T.tplCable, label: { media: "continuous", length: 70, auto: false, margin: 2, feed: FEED_CONTINUOUS },
        objects: [
          text({ name: `${T.tplName_title} 1`, x: 1, y: 1, w: 22, h: 10, text: "HDMI · TV" }),
          makeObject("line", { name: T.tplName_rule, x: 25, y: 5.25, w: 20, h: 1.5, stroke: stroke(0.2, { dash: "dashed" }) }),
          text({ name: `${T.tplName_title} 2`, x: 47, y: 1, w: 22, h: 10, text: "HDMI · TV" }),
        ],
      }),
    },
    {
      id: "price", name: T.tplPrice, cats: ["kitchen"], note: T.tplPriceNote,
      doc: doc({
        name: T.tplPrice,
        objects: [
          text({ name: T.tplName_price, x: 1, y: 0.5, w: 27, h: 11, text: "€ 4,90", font: "Bahnschrift", align: "left" }),
          makeObject("rect", { name: T.tplName_box, x: 28.5, y: 1.5, w: 10.5, h: 9, radius: 1, fill: fill("pattern", { pattern: "diag", scale: 5 }), stroke: stroke(0.25) }),
          text({ name: T.tplName_unit, x: 29.5, y: 3.5, w: 8.5, h: 5, text: T.tplPerKg, background: fill("solid"), fill: fill("solid", { ink: 0 }), padding: 0.4, radius: 0.6 }),
        ],
      }),
    },
    {
      id: "wifi", name: T.tplWifi, cats: ["home"], note: T.tplWifiNote,
      doc: doc({
        name: T.tplWifi,
        objects: [
          makeObject("qr", { name: "QR Wi-Fi", x: 0.4, y: 0.4, w: 11.2, h: 11.2, content: "WIFI:T:WPA;S:Casa;P:password;;", qrType: "wifi", qrData: { ssid: "Casa", password: "password", security: "WPA", hidden: false } }),
          text({ name: T.tplName_title, x: 13, y: 0.8, w: 26, h: 6, text: "Wi-Fi", align: "left" }),
          text({ name: T.tplName_detail, x: 13, y: 7, w: 26, h: 4, text: "Casa · password", align: "left", bold: false, font: "Consolas" }),
        ],
      }),
    },
    {
      id: "inventory", name: T.tplInventory, cats: ["home"], badge: "{n}", note: T.tplInventoryNote,
      doc: doc({
        name: T.tplInventory, label: gap(50),
        series: { start: 1, step: 1, count: 10, pad: 3, repeat: 1, collate: true, advance: true },
        objects: [
          makeObject("barcode", { name: T.tplName_code, x: 1, y: 0.6, w: 30, h: 10.8, content: "INV-{n}" }),
          text({ name: T.tplName_number, x: 32, y: 1, w: 17, h: 10, text: "#{n}", font: "Bahnschrift" }),
        ],
      }),
    },
    {
      id: "boxes", name: T.tplBoxes, cats: ["data"], badge: T.badgeData, note: T.tplBoxesNote,
      doc: doc({
        name: T.tplBoxes,
        data: newData({
          columns: [{ name: T.tplBoxCol1, type: "text" }, { name: T.tplBoxCol2, type: "text" }],
          rows: T.tplBoxesRows.map((r) => [...r]),
        }),
        objects: [
          text({ name: T.tplName_title, x: 1, y: 0.6, w: 38, h: 7, text: `«${T.tplBoxCol1}»` }),
          text({ name: T.tplName_detail, x: 1, y: 7.8, w: 38, h: 3.6, text: `«${T.tplBoxCol2}»`, bold: false }),
        ],
      }),
    },
    {
      id: "name", name: T.tplName, cats: ["home"], note: T.tplNameNote,
      doc: doc({
        name: T.tplName, label: { media: "continuous", length: 40, auto: true, margin: 2, feed: FEED_CONTINUOUS },
        objects: [
          makeObject("ellipse", { name: T.tplName_back, x: 1, y: 1, w: 10, h: 10, fill: fill("solid", { ink: 35 }), dither: { mode: "bayer8" } }),
          text({ name: T.tplName_initials, x: 1, y: 1, w: 10, h: 10, text: "AB", fill: fill("solid", { ink: 0 }), stroke: stroke(0.35) }),
          text({ name: T.tplName_title, x: 13, y: 0.8, w: 34, h: 10.4, text: T.tplNameText, align: "left" }),
        ],
      }),
    },
    {
      id: "halftone", name: T.tplHalftone, cats: ["home"], note: T.tplHalftoneNote,
      doc: doc({
        name: T.tplHalftone, label: gap(50),
        objects: [
          makeObject("rect", {
            name: T.tplName_back, x: 0, y: 0, w: 50, h: H, radius: 0, stroke: stroke(0),
            fill: fill("gradient", { from: 90, to: 0, angle: 0 }), dither: { mode: "halftone", cell: 6, angle: 45 },
          }),
          text({ name: T.tplName_title, x: 4, y: 1, w: 42, h: 10, text: "Qutie", font: "Segoe Print", fill: fill("solid"), stroke: stroke(0.5, { ink: 0 }) }),
        ],
      }),
    },
    {
      id: "pantry", name: T.tplPantry, cats: ["kitchen", "data"], badge: T.badgeData, note: T.tplPantryNote,
      doc: doc({
        name: T.tplPantry,
        data: newData({
          source: { ...newData().source, name: T.tplPantryTable },
          columns: [
            { name: T.colName, type: "text" }, { name: T.colDate, type: "date" }, { name: T.colQty, type: "number" },
            { name: T.colHot, type: "bool" }, { name: T.colExpires, type: "date" },
          ],
          rows: T.tplPantryRows.map((r) => [...r]),
          formulas: [{ name: T.colExpiry, expr: `${T.fnIF}(${T.fnEMPTY}([${T.colExpires}]); ${T.fnADDDAYS}([${T.colDate}]; 90); [${T.colExpires}])`, format: "short" }],
          copies: T.colQty,
        }),
        objects: [
          text({ name: T.tplName_title, x: 1.5, y: 0.6, w: 28, h: 6.6, text: `«${T.colName}»`, font: "Georgia" }),
          makeObject("line", { name: T.tplName_rule, x: 6, y: 7.5, w: 18, h: 0.6, stroke: stroke(0.25, { dash: "dotted" }) }),
          text({ name: T.tplName_date, x: 1.5, y: 8.1, w: 28, h: 3.3, text: `${T.tplExpires} «${T.colExpiry}»`, bold: false }),
          text({
            name: T.tplName_badge, x: 30.5, y: 3.4, w: 8.5, h: 5, text: T.tplHotBadge, fill: fill("solid", { ink: 0 }),
            background: fill("solid"), radius: 0.8, padding: 0.4,
            visible: { mode: "if", join: "and", rules: [{ field: T.colHot, op: "true", value: "" }] },
          }),
        ],
      }),
    },
  ];
}
