"use strict";
/* The workspace: the label on a canvas with rulers, selection, handles, snapping,
 * zoom and pan, plus the editing state shared with the panels.
 */

const S = {
  doc: null,
  selection: [], // ids, in selection order
  tool: "select",
  view: { zoom: 3, panX: 0, panY: 0, mode: "dots", fitted: false },
  grid: false,
  snap: true,
  rulers: true,
  inches: false,
  alignTo: "auto", // auto (label for one object, selection for more) | label | selection
  raster: null, // last rasterize() result
  rasterCanvas: document.createElement("canvas"),
  rasterDirty: true,
  hover: null,
  drag: null,
  guides: [],
  cursor: null, // pointer position in mm
  space: false,
  pendingSymbol: null, // a symbol waiting for a click on the label
};

const RULER = 22;
const HANDLE = 8;

// ------------------------------------------------------------------ queries
const byId = (id) => S.doc.objects.find((o) => o.id === id);
const selected = () => S.selection.map(byId).filter(Boolean);
const editable = () => selected().filter((o) => !o.locked);

/** Objects grouped with these (Ctrl+G): selecting one selects the group. */
function withGroups(ids) {
  const groups = new Set(ids.map(byId).filter((o) => o?.group).map((o) => o.group));
  if (!groups.size) return ids;
  return [...new Set([...ids, ...S.doc.objects.filter((o) => groups.has(o.group)).map((o) => o.id)])];
}

// ------------------------------------------------------------------ change tracking
const History = {
  past: [], future: [], lastKey: null, lastTime: 0, labels: [],
  snapshot: () => JSON.stringify({ name: S.doc.name, label: S.doc.label, series: S.doc.series, objects: S.doc.objects, data: S.doc.data, assets: S.doc.assets }),
  /** Call before a change. Changes with the same key in quick succession make one step. */
  record(key = null, label = null) {
    const now = Date.now();
    if (key && key === this.lastKey && now - this.lastTime < 1200) { this.lastTime = now; return; }
    this.past.push(this.snapshot());
    this.labels.push(label || key);
    if (this.past.length > 200) { this.past.shift(); this.labels.shift(); }
    this.future = [];
    this.lastKey = key;
    this.lastTime = now;
  },
  restore(json) {
    const data = JSON.parse(json);
    Object.assign(S.doc, { name: data.name, label: data.label, series: data.series, objects: data.objects, data: data.data, assets: data.assets || S.doc.assets });
    S.selection = S.selection.filter((id) => byId(id));
    this.lastKey = null;
    changed({ structure: true });
  },
  undo() { if (this.past.length) { this.future.push(this.snapshot()); this.labels.pop(); this.restore(this.past.pop()); } },
  redo() { if (this.future.length) { this.past.push(this.snapshot()); this.labels.push(null); this.restore(this.future.pop()); } },
  clear() { this.past = []; this.future = []; this.labels = []; this.lastKey = null; },
  lastLabel() { return this.labels[this.labels.length - 1] || null; },
};

const listeners = { change: [], selection: [] };
const emit = (event) => listeners.change.forEach((fn) => fn(event));
let renderQueued = false;
let autosaveTimer = null;
let modified = false;

/** Something in the document changed: redraw, refresh panels, autosave. */
function changed({ structure = false, save = true } = {}) {
  S.rasterDirty = true;
  if (save) {
    modified = true;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => api("autosave", JSON.stringify(cleanDocument())).catch(() => {}), 1200);
  }
  emit({ structure, doc: true });
  invalidate();
}

function select(ids, { add = false } = {}) {
  const list = withGroups(Array.isArray(ids) ? ids : [ids].filter(Boolean));
  S.selection = add ? [...new Set([...S.selection, ...list])] : [...list];
  listeners.selection.forEach((fn) => fn());
  invalidate();
}

function invalidate() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; if (S.doc && stage.isConnected && stage.offsetParent !== null) drawStage(); });
}

/** The document as saved: only the images still in use. */
function cleanDocument() {
  const used = new Set(S.doc.objects.filter((o) => o.type === "image" && o.asset).map((o) => o.asset));
  const assets = Object.fromEntries(Object.entries(S.doc.assets).filter(([k]) => used.has(k)));
  return { ...S.doc, version: FORMAT_VERSION, assets };
}

// ------------------------------------------------------------------ editing operations
function addObject(o, { selectIt = true, label = "add" } = {}) {
  History.record(null, label);
  S.doc.objects.push(o);
  if (!o.name) o.name = defaultName(o);
  changed({ structure: true });
  if (selectIt) select(o.id);
  return o;
}

function defaultName(o) {
  const base = o.symbol ? T.type_symbol : T[`type_${o.type}`] || o.type;
  let n = S.doc.objects.filter((x) => x.type === o.type && !!x.symbol === !!o.symbol).length;
  const names = new Set(S.doc.objects.map((x) => x.name));
  while (names.has(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

function deleteSelected() {
  const ids = new Set(editable().map((o) => o.id));
  if (!ids.size) return;
  History.record(null, "delete");
  S.doc.objects = S.doc.objects.filter((o) => !ids.has(o.id));
  S.selection = [];
  changed({ structure: true });
  select([]);
}

function duplicateSelected(offset = 1) {
  const groupMap = new Map();
  const copies = selected().map((o) => {
    const c = { ...structuredClone(o), id: newId(), x: o.x + offset, y: o.y + offset, name: "" };
    if (o.group) { if (!groupMap.has(o.group)) groupMap.set(o.group, newId()); c.group = groupMap.get(o.group); }
    return c;
  });
  if (!copies.length) return;
  History.record(null, "duplicate");
  for (const c of copies) { c.name = defaultName(c); S.doc.objects.push(c); }
  changed({ structure: true });
  select(copies.map((o) => o.id));
}

function moveBy(dx, dy, key = "nudge") {
  const list = editable();
  if (!list.length) return;
  History.record(key, "move");
  for (const o of list) { o.x = round3(o.x + dx); o.y = round3(o.y + dy); }
  changed();
}

/** Change properties of the selected objects as one undo step. */
function setProps(changes, key = null, list = editable()) {
  if (!list.length) return;
  History.record(key, "edit");
  for (const o of list) {
    for (const [k, v] of Object.entries(changes)) {
      if (v && typeof v === "object" && !Array.isArray(v) && o[k] && typeof o[k] === "object") o[k] = { ...o[k], ...v };
      else o[k] = v;
    }
  }
  changed();
}

/** Bring the selection forward (+1), backward (−1), to the front (+∞) or to the back (−∞). */
function reorder(step) {
  const ids = new Set(S.selection);
  if (!ids.size) return;
  History.record(null, "order");
  const objs = S.doc.objects;
  if (step === Infinity || step === -Infinity) {
    const moving = objs.filter((o) => ids.has(o.id));
    const rest = objs.filter((o) => !ids.has(o.id));
    S.doc.objects = step > 0 ? [...rest, ...moving] : [...moving, ...rest];
  } else {
    const order = step > 0 ? [...objs.keys()].reverse() : [...objs.keys()];
    for (const i of order) {
      const j = i + step;
      if (!ids.has(objs[i].id) || j < 0 || j >= objs.length || ids.has(objs[j].id)) continue;
      [objs[i], objs[j]] = [objs[j], objs[i]];
    }
  }
  changed({ structure: true });
}

/** Move one object to a position in the stack (layers panel drag), 0 = bottom. */
function moveToIndex(id, index) {
  const objs = S.doc.objects;
  const from = objs.findIndex((o) => o.id === id);
  if (from < 0) return;
  History.record(null, "order");
  const [o] = objs.splice(from, 1);
  objs.splice(Math.max(0, Math.min(objs.length, index)), 0, o);
  changed({ structure: true });
}

/** Align the selection: to the label with one object (or when asked), to the selection otherwise. */
function align(edge) {
  const list = editable();
  if (!list.length) return;
  History.record(null, "align");
  const L = labelLength(S.doc);
  const toLabel = S.alignTo === "label" || (S.alignTo === "auto" && list.length === 1);
  const box = toLabel ? { x0: 0, x1: L, y0: 0, y1: TAPE_MM, cx: L / 2, cy: TAPE_MM / 2 } : bounds(list);
  for (const o of list) {
    const b = bounds([o]);
    let dx = 0, dy = 0;
    if (edge === "left") dx = box.x0 - b.x0;
    if (edge === "hcenter") dx = box.cx - b.cx;
    if (edge === "right") dx = box.x1 - b.x1;
    if (edge === "top") dy = box.y0 - b.y0;
    if (edge === "vcenter") dy = box.cy - b.cy;
    if (edge === "bottom") dy = box.y1 - b.y1;
    o.x = round3(o.x + dx);
    o.y = round3(o.y + dy);
  }
  changed();
}

/** Spread three or more objects evenly (equal gaps), along x ("h") or y ("v"). */
function distribute(axis) {
  const list = editable();
  if (list.length < 3) return;
  History.record(null, "distribute");
  const key = axis === "h" ? ["x0", "x1", "x"] : ["y0", "y1", "y"];
  const items = list.map((o) => ({ o, b: bounds([o]) })).sort((a, b) => a.b[key[0]] - b.b[key[0]]);
  const first = items[0].b[key[0]], last = items[items.length - 1].b[key[1]];
  const total = items.reduce((s, it) => s + (it.b[key[1]] - it.b[key[0]]), 0);
  const gap = (last - first - total) / (items.length - 1);
  let pos = first;
  for (const it of items) {
    it.o[key[2]] = round3(it.o[key[2]] + (pos - it.b[key[0]]));
    pos += it.b[key[1]] - it.b[key[0]] + gap;
  }
  changed();
}

/** Rotate the selection by 90° steps (about each object's centre). */
function rotateBy(deg) {
  const list = editable();
  if (!list.length) return;
  History.record(null, "rotate");
  for (const o of list) {
    let a = ((o.rotation || 0) + deg) % 360;
    if (a > 180) a -= 360;
    if (a <= -180) a += 360;
    o.rotation = a;
  }
  changed();
}

/** Mirror the selection: images flip their pixels, lines swap their arrows, layouts mirror. */
function flip(axis) {
  const list = editable();
  if (!list.length) return;
  History.record(null, "flip");
  const b = bounds(list);
  for (const o of list) {
    if (axis === "h") {
      o.x = round3(b.x0 + b.x1 - o.x - o.w);
      if (o.type === "image") o.flipH = !o.flipH;
      if (o.type === "line") [o.arrowStart, o.arrowEnd] = [o.arrowEnd, o.arrowStart];
      if (o.rotation) o.rotation = -o.rotation;
    } else {
      o.y = round3(b.y0 + b.y1 - o.y - o.h);
      if (o.type === "image") o.flipV = !o.flipV;
      if (o.rotation) o.rotation = -o.rotation;
    }
  }
  changed();
}

function groupSelection() {
  const list = editable();
  if (list.length < 2) return;
  History.record(null, "group");
  const g = newId();
  for (const o of list) o.group = g;
  changed({ structure: true });
}

function ungroupSelection() {
  const list = editable().filter((o) => o.group);
  if (!list.length) return;
  History.record(null, "ungroup");
  for (const o of list) o.group = null;
  changed({ structure: true });
}

const round3 = (v) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------------------ stage
const stage = document.getElementById("stage");
const sctx = stage.getContext("2d");
// A drawing surface that takes its own keys (tools, arrows, Delete): name it, and let screen readers pass the keys on.
stage.setAttribute("role", "application");
stage.setAttribute("aria-label", T.stageLabel);
let colors = {};

function readColors() {
  const css = getComputedStyle(document.documentElement);
  const get = (name) => css.getPropertyValue(name).trim();
  colors = {
    bg: get("--stage"), fg: get("--foreground"), muted: get("--muted-foreground"), border: get("--border"),
    card: get("--card"), accent: get("--select"), guide: get("--guide"), ruler: get("--background"),
  };
}

function resizeStage() {
  const box = stage.parentElement.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const ratio = window.devicePixelRatio || 1;
  stage.width = Math.round(box.width * ratio);
  stage.height = Math.round(box.height * ratio);
  stage.style.width = `${box.width}px`;
  stage.style.height = `${box.height}px`;
  if (!S.view.fitted) fitView();
  invalidate();
}

const stageSize = () => ({ w: stage.width / (window.devicePixelRatio || 1), h: stage.height / (window.devicePixelRatio || 1) });
const rulerSize = () => (S.rulers ? RULER : 0);

/** Zoom so the whole label fits, centred. */
function fitView() {
  const { w, h } = stageSize();
  if (!w || !h || !S.doc) return;
  const L = dots(labelLength(S.doc));
  const R = rulerSize();
  const table = document.getElementById("datatable");
  const below = table && !table.hidden ? table.offsetHeight : 0; // the data table covers the bottom
  const avail = h - below;
  const zoom = Math.max(0.5, Math.min(24, Math.min((w - R - 96) / L, (avail - R - (below ? 60 : 120)) / HEAD_DOTS)));
  S.view.zoom = zoom;
  S.view.panX = (w - R - L * zoom) / 2;
  S.view.panY = (avail - R - HEAD_DOTS * zoom) / 2 - (below ? 0 : 10);
  S.view.fitted = true;
  emit({ view: true });
  invalidate();
}

/** Zoom so one dot is one screen pixel, centred: the real printed size of every dot. */
function actualSize() {
  setZoom(1);
}

function setZoom(zoom) {
  const { w, h } = stageSize();
  const R = rulerSize();
  S.view.zoom = Math.max(0.5, Math.min(40, zoom));
  S.view.panX = (w - R - dots(labelLength(S.doc)) * S.view.zoom) / 2;
  S.view.panY = (h - R - HEAD_DOTS * S.view.zoom) / 2 - 10;
  emit({ view: true });
  invalidate();
}

function zoomAt(factor, sx, sy) {
  const { w, h } = stageSize();
  sx ??= w / 2; sy ??= h / 2;
  const before = screenToMm(sx, sy);
  S.view.zoom = Math.max(0.5, Math.min(40, S.view.zoom * factor));
  const after = mmToScreen(before[0], before[1]);
  S.view.panX += sx - after[0];
  S.view.panY += sy - after[1];
  emit({ view: true });
  invalidate();
}

const originX = () => rulerSize() + S.view.panX;
const originY = () => rulerSize() + S.view.panY;
const pxPerMm = () => S.view.zoom * DPMM;
const mmToScreen = (x, y) => [originX() + x * pxPerMm(), originY() + y * pxPerMm()];
const screenToMm = (sx, sy) => [(sx - originX()) / pxPerMm(), (sy - originY()) / pxPerMm()];

function drawStage() {
  const ratio = window.devicePixelRatio || 1;
  const ctx = sctx;
  const { w: SW, h: SH } = stageSize();
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, SW, SH);

  const env = editEnv(S.doc);
  if (S.rasterDirty) {
    S.raster = rasterize(S.doc, env);
    bitsToCanvas(S.raster, S.rasterCanvas);
    S.rasterDirty = false;
    emit({ raster: true });
  }
  const L = S.raster.width / DPMM;
  const [lx, ly] = mmToScreen(0, 0);
  const lw = S.raster.width * S.view.zoom, lh = TAPE_MM * pxPerMm();

  // The label: a die-cut label with round corners, or a piece of continuous tape.
  const gap = S.doc.label.media !== "continuous";
  const corner = gap ? Math.min(10, pxPerMm() * 1) : 0;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.18)";
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 2;
  ctx.fillStyle = "#fff";
  ctx.beginPath();
  ctx.roundRect(lx, ly, lw, lh, corner);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.roundRect(lx, ly, lw, lh, corner);
  ctx.clip();
  if (S.view.mode === "dots") {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(S.rasterCanvas, lx, ly, S.raster.width * S.view.zoom, S.raster.height * S.view.zoom);
    if (S.view.zoom >= 8) { // the dot grid, when dots are big enough to see
      ctx.strokeStyle = "rgba(127,127,127,0.18)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= S.raster.width; x++) { const X = Math.round(lx + x * S.view.zoom) + 0.5; ctx.moveTo(X, ly); ctx.lineTo(X, ly + lh); }
      for (let y = 0; y <= HEAD_DOTS; y++) { const Y = Math.round(ly + y * S.view.zoom) + 0.5; ctx.moveTo(lx, Y); ctx.lineTo(lx + lw, Y); }
      ctx.stroke();
    }
  } else {
    ctx.translate(lx, ly);
    ctx.scale(S.view.zoom, S.view.zoom);
    ctx.imageSmoothingEnabled = false;
    for (const o of S.raster.objects) drawObject(ctx, o, { ...env, doc: S.doc });
  }
  ctx.restore();

  if (!gap) { // where the tape is torn, and how much comes out after it
    ctx.save();
    ctx.strokeStyle = colors.muted;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(lx + lw + 0.5, ly - 8); ctx.lineTo(lx + lw + 0.5, ly + lh + 8);
    ctx.moveTo(lx - 0.5, ly - 8); ctx.lineTo(lx - 0.5, ly + lh + 8);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = colors.muted;
    ctx.font = '11px "Geist", "Segoe UI", sans-serif';
    ctx.textBaseline = "top";
    ctx.fillText(T.tearHere(fmtNum(labelFeed(S.doc), 0)), lx + lw + 6, ly + lh + 10);
    ctx.restore();
  }

  if (S.grid) drawGrid(ctx, lx, ly, lw, lh);

  // Objects outside the label (or hidden in this row) are not printed: show where they are.
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = colors.muted;
  const printedIds = new Set(S.raster.objects.map((o) => o.id));
  for (const o of S.doc.objects) {
    if (o.hidden) continue;
    const b = bounds([o]);
    if (!printedIds.has(o.id) || b.x0 < -0.01 || b.y0 < -0.01 || b.x1 > L + 0.01 || b.y1 > TAPE_MM + 0.01) outline(ctx, o);
  }
  ctx.restore();

  // Hover, selection, handles.
  if (S.hover && !S.selection.includes(S.hover) && !S.drag) {
    const o = byId(S.hover);
    if (o) { ctx.strokeStyle = colors.accent; ctx.lineWidth = 1; outline(ctx, o); }
  }
  const sel = selected();
  ctx.lineWidth = 1.5;
  for (const o of sel) { ctx.strokeStyle = colors.accent; outline(ctx, o); }
  if (sel.length > 1) {
    const b = bounds(sel);
    const [x0, y0] = mmToScreen(b.x0, b.y0), [x1, y1] = mmToScreen(b.x1, b.y1);
    ctx.save(); ctx.setLineDash([4, 3]); ctx.strokeStyle = colors.accent; ctx.lineWidth = 1;
    ctx.strokeRect(x0 - 3.5, y0 - 3.5, x1 - x0 + 7, y1 - y0 + 7); ctx.restore();
  }
  if (sel.length === 1 && !sel[0].locked && !(S.drag && S.drag.kind === "move")) drawHandles(ctx, sel[0]);

  // Snap guides.
  ctx.save();
  ctx.strokeStyle = colors.guide;
  ctx.lineWidth = 1;
  for (const g of S.guides) {
    ctx.beginPath();
    if (g.axis === "x") { const [X] = mmToScreen(g.at, 0); ctx.moveTo(Math.round(X) + 0.5, rulerSize()); ctx.lineTo(Math.round(X) + 0.5, SH); }
    else { const [, Y] = mmToScreen(0, g.at); ctx.moveTo(rulerSize(), Math.round(Y) + 0.5); ctx.lineTo(SW, Math.round(Y) + 0.5); }
    ctx.stroke();
  }
  ctx.restore();

  if (S.drag?.kind === "marquee" || S.drag?.kind === "create") {
    const [x0, y0] = mmToScreen(Math.min(S.drag.start[0], S.drag.now[0]), Math.min(S.drag.start[1], S.drag.now[1]));
    const [x1, y1] = mmToScreen(Math.max(S.drag.start[0], S.drag.now[0]), Math.max(S.drag.start[1], S.drag.now[1]));
    ctx.fillStyle = withAlpha(colors.accent, 0.12);
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    ctx.strokeStyle = colors.accent;
    ctx.setLineDash(S.drag.kind === "marquee" ? [4, 3] : []);
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
    ctx.setLineDash([]);
  }

  if (S.rulers) drawRulers(ctx, SW, SH);
  S.afterDraw?.();
}

function withAlpha(color, alpha) {
  if (color.startsWith("oklch(")) return color.replace(/\)$/, ` / ${alpha})`);
  if (color.startsWith("#") && color.length === 7) return color + Math.round(alpha * 255).toString(16).padStart(2, "0");
  return color;
}

function outline(ctx, o) {
  const pts = corners(o).map(([x, y]) => mmToScreen(x, y));
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.stroke();
}

/** Handles of an object in screen coordinates: 8 for resizing, 1 for rotating. */
function handlesOf(o) {
  const list = [];
  const sides = o.type === "line" ? [[-1, 0], [1, 0]]
    : [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  for (const [hx, hy] of sides) {
    const [x, y] = fromLocal(o, ((hx + 1) / 2) * o.w, ((hy + 1) / 2) * o.h);
    list.push({ kind: "resize", hx, hy, at: mmToScreen(x, y) });
  }
  // Rotation handle: beyond the top edge, at a fixed distance on screen.
  const [tx, ty] = fromLocal(o, o.w / 2, 0);
  const [sx, sy] = mmToScreen(tx, ty);
  const a = rad(o.rotation || 0);
  list.push({ kind: "rotate", at: [sx + Math.sin(a) * 22, sy - Math.cos(a) * 22], base: [sx, sy] });
  return list;
}

function drawHandles(ctx, o) {
  for (const h of handlesOf(o)) {
    const [x, y] = h.at;
    ctx.fillStyle = "#fff";
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 1.5;
    if (h.kind === "rotate") {
      ctx.beginPath(); ctx.moveTo(...h.base); ctx.lineTo(x, y); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, HANDLE / 2 + 1, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else {
      ctx.fillRect(x - HANDLE / 2, y - HANDLE / 2, HANDLE, HANDLE);
      ctx.strokeRect(x - HANDLE / 2 + 0.5, y - HANDLE / 2 + 0.5, HANDLE - 1, HANDLE - 1);
    }
  }
}

function drawGrid(ctx, lx, ly, lw, lh) {
  const step = pxPerMm();
  if (step < 4) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(lx, ly, lw, lh);
  ctx.clip();
  for (let i = 0, x = lx; x <= lx + lw + 0.5; i++, x += step) {
    ctx.strokeStyle = i % 5 === 0 ? "rgba(59,130,246,0.35)" : "rgba(59,130,246,0.15)";
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, ly); ctx.lineTo(Math.round(x) + 0.5, ly + lh); ctx.stroke();
  }
  for (let i = 0, y = ly; y <= ly + lh + 0.5; i++, y += step) {
    ctx.strokeStyle = i % 5 === 0 ? "rgba(59,130,246,0.35)" : "rgba(59,130,246,0.15)";
    ctx.beginPath(); ctx.moveTo(lx, Math.round(y) + 0.5); ctx.lineTo(lx + lw, Math.round(y) + 0.5); ctx.stroke();
  }
  ctx.restore();
}

function drawRulers(ctx, SW, SH) {
  ctx.save();
  ctx.fillStyle = colors.ruler;
  ctx.fillRect(0, 0, SW, RULER);
  ctx.fillRect(0, 0, RULER, SH);
  ctx.strokeStyle = colors.border;
  ctx.beginPath();
  ctx.moveTo(0, RULER - 0.5); ctx.lineTo(SW, RULER - 0.5);
  ctx.moveTo(RULER - 0.5, 0); ctx.lineTo(RULER - 0.5, SH);
  ctx.stroke();

  // Selection extent on the rulers.
  const sel = selected();
  if (sel.length) {
    const b = bounds(sel);
    const [x0, y0] = mmToScreen(b.x0, b.y0), [x1, y1] = mmToScreen(b.x1, b.y1);
    ctx.fillStyle = withAlpha(colors.accent, 0.18);
    ctx.fillRect(Math.max(RULER, x0), 0, Math.max(0, x1 - Math.max(RULER, x0)), RULER - 1);
    ctx.fillRect(0, Math.max(RULER, y0), RULER - 1, Math.max(0, y1 - Math.max(RULER, y0)));
  }

  // Units: millimetres, or inches (tenths) with "Rulers in inches".
  const unit = S.inches ? 25.4 / 10 : 1; // mm per tick unit
  const step = pxPerMm() * unit;
  const every = step >= 6 ? 1 : step >= 2 ? 5 : 10;
  const labelEvery = S.inches ? 10 : step >= 14 ? 5 : step >= 4 ? 10 : step >= 1.5 ? 20 : 50;
  const label = (v) => (S.inches ? String(v / 10) : String(v));
  ctx.fillStyle = colors.muted;
  ctx.strokeStyle = colors.muted;
  ctx.font = '10px "Geist Mono", Consolas, monospace';
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.beginPath();
  const [startMm] = screenToMm(RULER, 0), [endMm] = screenToMm(SW, 0);
  for (let v = Math.ceil(startMm / unit / every) * every; v * unit <= endMm; v += every) {
    const [x] = mmToScreen(v * unit, 0);
    const X = Math.round(x) + 0.5;
    const long = v % labelEvery === 0;
    ctx.moveTo(X, RULER); ctx.lineTo(X, RULER - (long ? 10 : v % 5 === 0 ? 6 : 3));
    if (long) ctx.fillText(label(v), X + 3, 3);
  }
  ctx.stroke();

  ctx.beginPath();
  const [, startY] = screenToMm(0, RULER), [, endY] = screenToMm(0, SH);
  const vEvery = step >= 6 ? 1 : 2;
  for (let v = Math.ceil(startY / unit / vEvery) * vEvery; v * unit <= endY; v += vEvery) {
    const [, y] = mmToScreen(0, v * unit);
    const Y = Math.round(y) + 0.5;
    const long = v % (S.inches ? 10 : step >= 10 ? 2 : 4) === 0;
    ctx.moveTo(RULER, Y); ctx.lineTo(RULER - (long ? 10 : 4), Y);
    if (long) {
      ctx.save(); ctx.translate(3, Y + 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "right"; ctx.fillText(label(v), 0, 0); ctx.restore();
    }
  }
  ctx.stroke();

  // The pointer on the rulers.
  if (S.cursor) {
    const [x, y] = mmToScreen(S.cursor[0], S.cursor[1]);
    ctx.strokeStyle = colors.accent;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, 0); ctx.lineTo(Math.round(x) + 0.5, RULER);
    ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(RULER, Math.round(y) + 0.5);
    ctx.stroke();
  }
  ctx.fillStyle = colors.ruler;
  ctx.fillRect(0, 0, RULER - 1, RULER - 1);
  ctx.fillStyle = colors.muted;
  ctx.font = '9px "Geist Mono", Consolas, monospace';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(S.inches ? "in" : "mm", RULER / 2, RULER / 2);
  ctx.restore();
}

// ------------------------------------------------------------------ hit testing
function hitObject(x, y, { includeLocked = false } = {}) {
  const tol = 4 / pxPerMm(); // a few screen pixels, for thin lines
  for (let i = S.doc.objects.length - 1; i >= 0; i--) {
    const o = S.doc.objects[i];
    if (o.hidden || (o.locked && !includeLocked)) continue;
    const [lx, ly] = toLocal(o, x, y);
    const extraY = o.type === "line" ? Math.max(tol, 1 - o.h / 2) : tol;
    if (lx >= -tol && lx <= o.w + tol && ly >= -extraY && ly <= o.h + extraY) return o;
  }
  return null;
}

function hitHandle(sx, sy) {
  const sel = selected();
  if (sel.length !== 1 || sel[0].locked) return null;
  for (const h of handlesOf(sel[0])) {
    if (Math.abs(h.at[0] - sx) <= HANDLE && Math.abs(h.at[1] - sy) <= HANDLE) return h;
  }
  return null;
}

function handleCursor(h, o) {
  if (h.kind === "rotate") return "grab";
  // Turn the cursor with the object, in 45° steps.
  const names = ["ew-resize", "nwse-resize", "ns-resize", "nesw-resize"];
  const angle = (Math.atan2(h.hy, h.hx) * 180) / Math.PI + (o.rotation || 0);
  return names[((Math.round(angle / 45) % 4) + 4) % 4];
}

// ------------------------------------------------------------------ snapping
function snapTargets(exclude) {
  const L = labelLength(S.doc);
  const xs = [0, L / 2, L], ys = [0, TAPE_MM / 2, TAPE_MM];
  for (const o of S.doc.objects) {
    if (o.hidden || exclude.has(o.id)) continue;
    const b = bounds([o]);
    xs.push(b.x0, b.cx, b.x1);
    ys.push(b.y0, b.cy, b.y1);
  }
  return { xs, ys };
}

/** The shift that brings one of `values` onto a target, within tolerance; and the guide. */
function snapAxis(values, targets, tol) {
  let best = null;
  for (const v of values) for (const t of targets) {
    const d = t - v;
    if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: t };
  }
  return best;
}

// ------------------------------------------------------------------ pointer
function pointerPos(e) {
  const r = stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

stage.addEventListener("pointerdown", (e) => {
  stage.focus({ preventScroll: true });
  const [sx, sy] = pointerPos(e);
  const p = screenToMm(sx, sy);
  if (e.button === 2) { // right click: select what is under the pointer, the menu comes on contextmenu
    const hit = hitObject(p[0], p[1], { includeLocked: true });
    if (hit && !S.selection.includes(hit.id)) select(hit.id);
    return;
  }
  try { stage.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
  if (e.button === 1 || S.space || (e.button === 0 && S.tool === "hand")) {
    S.drag = { kind: "pan", sx, sy, panX: S.view.panX, panY: S.view.panY };
    stage.style.cursor = "grabbing";
    return;
  }
  if (e.button !== 0) return;
  if (S.pendingSymbol) { // a symbol chosen in the picker: one click places it
    emit({ placeSymbol: { at: p } });
    return;
  }
  if (S.tool !== "select") {
    S.drag = { kind: "create", start: p, now: p, tool: S.tool };
    return;
  }
  const h = hitHandle(sx, sy);
  if (h) {
    const o = selected()[0];
    History.record(null, h.kind);
    S.drag = { kind: h.kind, handle: h, origin: structuredClone(o), id: o.id, moved: false };
    return;
  }
  const hit = hitObject(p[0], p[1]);
  if (hit) {
    if (e.shiftKey || e.ctrlKey) {
      const ids = withGroups([hit.id]);
      select(S.selection.includes(hit.id) ? S.selection.filter((id) => !ids.includes(id)) : [...S.selection, ...ids]);
    } else if (!S.selection.includes(hit.id)) select(hit.id);
    const moving = editable();
    if (!moving.length) return;
    S.drag = {
      kind: "move", start: p, moved: false, alt: e.altKey,
      origins: moving.map((o) => ({ id: o.id, x: o.x, y: o.y })), box: bounds(moving),
    };
    return;
  }
  if (!e.shiftKey && !e.ctrlKey) select([]);
  S.drag = { kind: "marquee", start: p, now: p, base: e.shiftKey || e.ctrlKey ? [...S.selection] : [] };
});

stage.addEventListener("pointermove", (e) => {
  const [sx, sy] = pointerPos(e);
  const p = screenToMm(sx, sy);
  S.cursor = p;
  emit({ cursor: true });
  const d = S.drag;
  if (!d) {
    const h = hitHandle(sx, sy);
    const hit = h ? null : hitObject(p[0], p[1]);
    S.hover = hit?.id || null;
    stage.style.cursor = S.space || S.tool === "hand" ? "grab"
      : S.pendingSymbol ? "copy"
      : h ? handleCursor(h, selected()[0])
      : S.tool !== "select" ? "crosshair"
      : hit ? "move" : "default";
    invalidate();
    return;
  }
  if (d.kind === "pan") {
    S.view.panX = d.panX + sx - d.sx;
    S.view.panY = d.panY + sy - d.sy;
    invalidate();
    return;
  }
  if (d.kind === "marquee" || d.kind === "create") {
    d.now = p;
    if (d.kind === "marquee") {
      const x0 = Math.min(d.start[0], p[0]), x1 = Math.max(d.start[0], p[0]);
      const y0 = Math.min(d.start[1], p[1]), y1 = Math.max(d.start[1], p[1]);
      const inside = S.doc.objects.filter((o) => {
        if (o.hidden || o.locked) return false;
        const b = bounds([o]);
        return b.x0 < x1 && b.x1 > x0 && b.y0 < y1 && b.y1 > y0;
      }).map((o) => o.id);
      S.selection = withGroups([...new Set([...d.base, ...inside])]);
      listeners.selection.forEach((fn) => fn());
    }
    invalidate();
    return;
  }
  const tol = 6 / pxPerMm();
  if (d.kind === "move") {
    let dx = p[0] - d.start[0], dy = p[1] - d.start[1];
    if (!d.moved && Math.hypot(dx, dy) * pxPerMm() < 3) return;
    if (!d.moved) {
      History.record(null, d.alt ? "duplicate" : "move");
      d.moved = true;
      if (d.alt) { // Alt-drag: leave a copy behind
        const copies = d.origins.map((og) => { const c = { ...structuredClone(byId(og.id)), id: newId(), name: "" }; c.name = defaultName(c); return c; });
        const at = Math.min(...d.origins.map((og) => S.doc.objects.findIndex((o) => o.id === og.id)));
        S.doc.objects.splice(at, 0, ...copies);
        changed({ structure: true });
      }
    }
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; } // keep to one axis
    S.guides = [];
    if (S.snap && !e.ctrlKey) {
      const { xs, ys } = snapTargets(new Set(d.origins.map((og) => og.id)));
      const b = d.box;
      const sxr = snapAxis([b.x0 + dx, b.cx + dx, b.x1 + dx], xs, tol);
      const syr = snapAxis([b.y0 + dy, b.cy + dy, b.y1 + dy], ys, tol);
      if (sxr) { dx += sxr.d; S.guides.push({ axis: "x", at: sxr.at }); }
      if (syr) { dy += syr.d; S.guides.push({ axis: "y", at: syr.at }); }
      if (S.grid && !sxr) dx = Math.round(b.x0 + dx) - b.x0;
      if (S.grid && !syr) dy = Math.round(b.y0 + dy) - b.y0;
    } else if (S.grid) {
      dx = Math.round(d.box.x0 + dx) - d.box.x0;
      dy = Math.round(d.box.y0 + dy) - d.box.y0;
    }
    for (const og of d.origins) {
      const o = byId(og.id);
      if (o) { o.x = round3(og.x + dx); o.y = round3(og.y + dy); }
    }
    changed();
    return;
  }
  const o = byId(d.id);
  if (!o) return;
  d.moved = true;
  if (d.kind === "rotate") {
    const cx = d.origin.x + d.origin.w / 2, cy = d.origin.y + d.origin.h / 2;
    let angle = (Math.atan2(p[1] - cy, p[0] - cx) * 180) / Math.PI + 90;
    if (e.shiftKey) angle = Math.round(angle / 15) * 15;
    else for (const a of [0, 90, 180, 270, 360, -90]) if (Math.abs(angle - a) < 3) angle = a;
    angle = ((Math.round(angle * 10) / 10) % 360 + 360) % 360;
    o.rotation = angle > 180 ? angle - 360 : angle;
    changed();
    return;
  }
  if (d.kind === "resize") resizeTo(o, d, p, e.shiftKey, tol);
});

function resizeTo(o, d, p, keepRatio, tol) {
  const o0 = d.origin;
  const { hx, hy } = d.handle;
  const [lx, ly] = toLocal(o0, p[0], p[1]);
  const min = 0.5;
  let left = 0, right = o0.w, top = 0, bottom = o0.h;
  if (hx < 0) left = Math.min(lx, o0.w - min);
  if (hx > 0) right = Math.max(lx, min);
  if (hy < 0) top = Math.min(ly, o0.h - min);
  if (hy > 0) bottom = Math.max(ly, min);
  S.guides = [];
  if (S.snap && !(o0.rotation % 360)) { // snap the moving edges
    const { xs, ys } = snapTargets(new Set([o0.id]));
    if (hx < 0) { const s = snapAxis([o0.x + left], xs, tol); if (s) { left += s.d; S.guides.push({ axis: "x", at: s.at }); } }
    if (hx > 0) { const s = snapAxis([o0.x + right], xs, tol); if (s) { right += s.d; S.guides.push({ axis: "x", at: s.at }); } }
    if (hy < 0) { const s = snapAxis([o0.y + top], ys, tol); if (s) { top += s.d; S.guides.push({ axis: "y", at: s.at }); } }
    if (hy > 0) { const s = snapAxis([o0.y + bottom], ys, tol); if (s) { bottom += s.d; S.guides.push({ axis: "y", at: s.at }); } }
  }
  let w = right - left, h = bottom - top;
  const ratioLocked = keepRatio || o0.type === "qr" || (o0.type === "image" && o0.fit !== "stretch");
  if (ratioLocked && hx && hy) {
    const k = Math.max(w / o0.w, h / o0.h);
    w = o0.w * k; h = o0.h * k;
    if (hx < 0) left = o0.w - w;
    if (hy < 0) top = o0.h - h;
  }
  const [cx, cy] = fromLocal(o0, left + w / 2, top + h / 2);
  o.w = round3(Math.max(min, w));
  o.h = round3(o0.type === "line" ? o0.h : Math.max(min, h));
  o.x = round3(cx - o.w / 2);
  o.y = round3(cy - o.h / 2);
  changed();
}

stage.addEventListener("pointerup", (e) => {
  const d = S.drag;
  S.drag = null;
  S.guides = [];
  if (!d) return;
  if (d.kind === "pan") { stage.style.cursor = S.space ? "grab" : "default"; invalidate(); return; }
  if (d.kind === "create") { finishCreate(d, e); return; }
  if ((d.kind === "resize" || d.kind === "rotate") && !d.moved) { History.past.pop(); History.labels.pop(); }
  invalidate();
  listeners.selection.forEach((fn) => fn());
});

stage.addEventListener("pointerleave", () => {
  S.cursor = null;
  S.hover = null;
  emit({ cursor: true });
  invalidate();
});

stage.addEventListener("dblclick", (e) => {
  const [sx, sy] = pointerPos(e);
  const p = screenToMm(sx, sy);
  const hit = hitObject(p[0], p[1]);
  if (hit) emit({ edit: hit.id, at: [e.clientX, e.clientY] });
});

stage.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const sel = e.button !== 2 ? selected() : []; // from the keyboard (Menu key, Shift+F10): the menu opens on the selection
  if (sel.length) {
    const b = bounds(sel);
    const r = stage.getBoundingClientRect();
    const [sx, sy] = mmToScreen(b.cx, b.cy);
    emit({ contextmenu: { x: r.left + sx, y: r.top + sy, object: sel[0].id, at: [b.cx, b.cy] } });
    return;
  }
  const [sx, sy] = pointerPos(e);
  const p = screenToMm(sx, sy);
  const hit = hitObject(p[0], p[1], { includeLocked: true });
  emit({ contextmenu: { x: e.clientX, y: e.clientY, object: hit?.id || null, at: p } });
});

stage.addEventListener("wheel", (e) => {
  e.preventDefault();
  const [sx, sy] = pointerPos(e);
  if (e.ctrlKey || e.metaKey) {
    zoomAt(Math.exp(-e.deltaY * 0.0015), sx, sy);
    return;
  }
  // The label is long and thin: the wheel scrolls along it.
  if (e.shiftKey) S.view.panY -= e.deltaY;
  else S.view.panX -= e.deltaY + e.deltaX;
  invalidate();
}, { passive: false });

/** A new object drawn (or clicked) with a creation tool. */
function finishCreate(d) {
  const tool = d.tool;
  const [x0, y0] = [Math.min(d.start[0], d.now[0]), Math.min(d.start[1], d.now[1])];
  const w = Math.abs(d.now[0] - d.start[0]), h = Math.abs(d.now[1] - d.start[1]);
  const dragged = w * pxPerMm() > 6 && (h * pxPerMm() > 6 || tool === "line");
  const props = {};
  if (dragged) Object.assign(props, { x: round3(x0), y: round3(y0), w: round3(w), h: round3(tool === "line" ? 1.5 : h) });
  if (tool === "image" || tool === "symbol") {
    emit({ request: tool, at: dragged ? props : { x: round3(d.start[0]), y: 0.5 } });
    setTool("select");
    return;
  }
  const o = makeObject(tool, props);
  if (tool === "text") o.text = T.sampleText;
  if (!dragged) { // a click: default size, at the pointer, kept on the tape
    o.x = round3(d.start[0] - (tool === "text" ? 0 : o.w / 2));
    o.y = round3(Math.max(0, Math.min(TAPE_MM - o.h, d.start[1] - o.h / 2)));
    if (tool === "text") { o.y = 1; o.h = round3(TAPE_MM - 2); }
  }
  addObject(o);
  setTool("select");
  if (tool === "text" || tool === "barcode" || tool === "qr") emit({ focusContent: o.id, selectAll: true });
}

function setTool(tool) {
  S.tool = tool;
  if (tool !== "symbol") S.pendingSymbol = null;
  stage.style.cursor = tool === "select" ? "default" : tool === "hand" ? "grab" : "crosshair";
  emit({ tool: true });
}

window.addEventListener("resize", resizeStage);
new ResizeObserver(resizeStage).observe(stage.parentElement);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColors(); invalidate(); });
