"use strict";
/* Drawing the document.
 *
 * drawObject() draws one object on any 2D context whose units are printer dots: the
 * editor's smooth view scales it to the screen, rasterize() draws at 1:1. rasterize()
 * gives every object its own layer, dithers it as the object asks and stacks the
 * layers into the 1-bit label the printer gets: what the dot view shows is what prints.
 */

// ------------------------------------------------------------------ async resources
/** Something finished loading (a code, an image): whoever draws should draw again. */
const Resources = {
  listeners: new Set(),
  loaded() { for (const fn of [...this.listeners]) fn(); },
};

/** Barcode and QR modules, made by the app (python-barcode, segno) and cached. */
const Codes = {
  cache: new Map(),
  pending: new Map(),
  key: (kind, content, opts = {}) => `${kind}|${opts.ecc || ""}|${opts.version || ""}|${content}`,
  get(kind, content, opts = {}) {
    const k = this.key(kind, content, opts);
    if (this.cache.has(k)) return this.cache.get(k);
    if (!this.pending.has(k)) {
      const job = api("codes", kind, content, { ecc: opts.ecc, version: opts.version === "auto" ? null : opts.version })
        .catch((e) => ({ ok: false, detail: String(e?.message || e) }))
        .then((r) => {
          this.cache.set(k, r || { ok: false, detail: "?" });
          this.pending.delete(k);
          if (this.cache.size > 2000) this.cache.delete(this.cache.keys().next().value);
          Resources.loaded();
        });
      this.pending.set(k, job);
    }
    return null;
  },
  /** Wait until every code the given labels need is available. */
  async ensure(doc, plan) {
    for (const item of plan) {
      const env = { vars: item.vars, texts: item.texts, raw: item.raw };
      for (const o of doc.objects) {
        if (o.type === "barcode" || o.type === "qr") this.get(codeKind(o), expandAll(o.content, env), codeOpts(o));
      }
    }
    await Promise.all([...this.pending.values()]);
  },
};
const codeKind = (o) => (o.type === "qr" ? o.kind || "qr" : o.kind);
const codeOpts = (o) => (o.type === "qr" ? { ecc: o.ecc, version: o.version } : {});

/** Images of the document, decoded once, and their adjusted greyscale versions. */
const Images = {
  elements: new Map(),
  processed: new Map(),
  element(id, src) {
    if (!src) return null;
    let entry = this.elements.get(id);
    if (!entry || entry.src !== src) {
      const img = new Image();
      entry = { src, img, ready: false };
      img.onload = () => { entry.ready = true; Resources.loaded(); };
      img.src = src;
      this.elements.set(id, entry);
    }
    return entry.ready ? entry.img : null;
  },
  /** The image as a greyscale canvas with levels, brightness, contrast, gamma and invert applied. */
  adjusted(o, doc) {
    const img = this.element(o.asset, doc.assets?.[o.asset]);
    if (!img) return null;
    const key = [o.asset, o.autoLevels, o.brightness, o.contrast, o.gamma, o.invert].join("|");
    const hit = this.processed.get(key);
    if (hit) return hit;
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
    adjustPixels(data.data, o);
    ctx.putImageData(data, 0, 0);
    this.processed.set(key, canvas);
    if (this.processed.size > 40) this.processed.delete(this.processed.keys().next().value);
    return canvas;
  },
  size(o, doc) {
    const img = this.element(o.asset, doc.assets?.[o.asset]);
    return img ? [img.naturalWidth, img.naturalHeight] : null;
  },
};

function adjustPixels(px, o) {
  const n = px.length / 4;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
  let lo = 0, hi = 255;
  if (o.autoLevels) { // stretch the 1st–99th percentile of the visible pixels to full range
    const hist = new Uint32Array(256);
    let total = 0;
    for (let i = 0; i < n; i++) if (px[i * 4 + 3] > 127) { hist[lum[i] | 0]++; total++; }
    if (total) {
      let acc = 0;
      for (lo = 0; lo < 255 && (acc += hist[lo]) < total * 0.01; lo++);
      acc = 0;
      for (hi = 255; hi > 0 && (acc += hist[hi]) < total * 0.01; hi--);
      if (hi - lo < 16) { lo = 0; hi = 255; }
    }
  }
  const b = (Number(o.brightness) || 0) * 2.55;
  const c = (Number(o.contrast) || 0) * 2.55;
  const factor = (259 * (c + 255)) / (255 * (259 - c));
  const gamma = 1 / Math.max(0.1, Number(o.gamma) || 1);
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let x = ((v - lo) * 255) / Math.max(1, hi - lo);
    x = factor * (x + b - 128) + 128;
    x = 255 * Math.pow(Math.min(1, Math.max(0, x / 255)), gamma);
    lut[v] = o.invert ? 255 - x : x;
  }
  for (let i = 0; i < n; i++) {
    const v = lut[Math.max(0, Math.min(255, Math.round(lum[i])))];
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
  }
}

// ------------------------------------------------------------------ paints
const grey = (ink) => { const v = Math.round(255 * (1 - Math.max(0, Math.min(100, ink)) / 100)); return `rgb(${v},${v},${v})`; };

const PATTERNS = ["diag", "diag2", "cross", "hlines", "vlines", "grid", "dots", "checker", "bricks", "zigzag"];

const tiles = new Map();
/** A repeating tile, in dots: `scale` is its size, `weight` the line thickness. */
function patternTile(name, scale, weight, ink) {
  const s = Math.max(2, Math.min(32, Math.round(scale) || 4));
  const t = Math.max(1, Math.min(s - 1, Math.round(weight) || 1));
  const key = `${name}|${s}|${t}|${ink}`;
  if (tiles.has(key)) return tiles.get(key);
  const canvas = document.createElement("canvas");
  canvas.width = s; canvas.height = s;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = grey(ink);
  const half = Math.max(1, Math.floor(s / 2));
  const on = (x, y) => {
    switch (name) {
      case "hlines": return y < t;
      case "vlines": return x < t;
      case "diag": return (x + y) % s < t;
      case "diag2": return (x - y + s * 4) % s < t;
      case "cross": return (x + y) % s < t || (x - y + s * 4) % s < t;
      case "grid": return x < t || y < t;
      case "dots": return (x - half) ** 2 + (y - half) ** 2 < (t * 0.6) ** 2 + 0.5;
      case "checker": return (Math.floor(x / half) + Math.floor(y / half)) % 2 === 0;
      case "bricks": return y % half < t || (x + (y < half ? 0 : half)) % s < t;
      case "zigzag": return (y - Math.abs(x - half) + s) % s < t;
      default: return false;
    }
  };
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) if (on(x, y)) ctx.fillRect(x, y, 1, 1);
  tiles.set(key, canvas);
  return canvas;
}

/** A canvas fill style for a fill spec over a w×h box, or null for none. */
function paint(ctx, f, w, h) {
  if (!f || f.type === "none") return null;
  if (f.type === "pattern") return ctx.createPattern(patternTile(f.pattern, f.scale, f.weight, f.ink), "repeat");
  if (f.type === "gradient") {
    const a = rad(f.angle || 0);
    const cx = w / 2, cy = h / 2;
    const reach = Math.abs((w / 2) * Math.cos(a)) + Math.abs((h / 2) * Math.sin(a));
    const g = ctx.createLinearGradient(cx - Math.cos(a) * reach, cy - Math.sin(a) * reach, cx + Math.cos(a) * reach, cy + Math.sin(a) * reach);
    g.addColorStop(0, grey(f.from));
    g.addColorStop(1, grey(f.to));
    return g;
  }
  if (f.type === "grey") return grey(f.ink);
  return grey(f.ink);
}

function dashFor(s, width) {
  if (s.dash === "dashed") return [width * 3, width * 2];
  if (s.dash === "dotted") return [Math.max(1, width), Math.max(1, width) * 1.5];
  return [];
}

// ------------------------------------------------------------------ objects
function drawObject(ctx, o, env) {
  const w = dots(o.w), h = dots(o.h);
  ctx.save();
  ctx.translate(dots(o.x) + w / 2, dots(o.y) + h / 2);
  if (o.rotation) ctx.rotate(rad(o.rotation));
  ctx.translate(-w / 2, -h / 2);
  try {
    DRAW[o.type]?.(ctx, o, w, h, env);
  } finally {
    ctx.restore();
  }
}

/** The text an object shows on this label (variables, fields, case, empty field). */
function objectText(o, env) {
  let content = expandAll(o.type === "text" ? o.text : o.content, env);
  if (o.empty === "dash" && env.texts && fieldsIn(o.text ?? o.content).length && !content.trim()) content = "—";
  if (o.transform === "upper") content = content.toLocaleUpperCase(LOCALE);
  if (o.transform === "lower") content = content.toLocaleLowerCase(LOCALE);
  if (o.transform === "title") content = content.toLocaleLowerCase(LOCALE).replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toLocaleUpperCase(LOCALE));
  return content;
}

const DRAW = {
  rect(ctx, o, w, h) {
    const sw = dots(o.stroke?.width || 0);
    const r = Math.max(0, Math.min(dots(o.radius || 0), w / 2, h / 2));
    const style = paint(ctx, o.fill, w, h);
    if (style) {
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, r);
      ctx.fillStyle = style;
      ctx.fill();
    }
    if (sw > 0) {
      ctx.beginPath();
      ctx.roundRect(sw / 2, sw / 2, Math.max(0, w - sw), Math.max(0, h - sw), Math.max(0, r - sw / 2));
      strokeWith(ctx, o.stroke, sw);
    }
  },
  ellipse(ctx, o, w, h) {
    const sw = dots(o.stroke?.width || 0);
    const style = paint(ctx, o.fill, w, h);
    if (style) {
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fillStyle = style;
      ctx.fill();
    }
    if (sw > 0) {
      ctx.beginPath();
      ctx.ellipse(w / 2, h / 2, Math.max(0.1, w / 2 - sw / 2), Math.max(0.1, h / 2 - sw / 2), 0, 0, Math.PI * 2);
      strokeWith(ctx, o.stroke, sw);
    }
  },
  line(ctx, o, w, h) {
    const sw = Math.max(1, dots(o.stroke?.width || 0.1));
    const y = h / 2;
    const head = Math.max(4, sw * 3);
    const x0 = o.arrowStart ? head * 0.8 : 0, x1 = o.arrowEnd ? w - head * 0.8 : w;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    strokeWith(ctx, o.stroke, sw);
    ctx.fillStyle = grey(o.stroke?.ink ?? 100);
    const arrow = (tip, dir) => {
      ctx.beginPath();
      ctx.moveTo(tip, y);
      ctx.lineTo(tip - dir * head, y - head / 2);
      ctx.lineTo(tip - dir * head, y + head / 2);
      ctx.closePath();
      ctx.fill();
    };
    if (o.arrowStart) arrow(0, -1);
    if (o.arrowEnd) arrow(w, 1);
  },
  text(ctx, o, w, h, env) {
    const pad = dots(o.padding || 0);
    const bg = paint(ctx, o.background, w, h);
    if (bg) {
      ctx.beginPath();
      ctx.roundRect(0, 0, w, h, Math.max(0, Math.min(dots(o.radius || 0), w / 2, h / 2)));
      ctx.fillStyle = bg;
      ctx.fill();
    }
    const content = objectText(o, env);
    if (!content.trim()) return;
    const layout = layoutText(ctx, o, w, h, content);
    const style = paint(ctx, o.fill, w, h);
    const sw = dots(o.stroke?.width || 0);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    for (const line of layout.lines) {
      const words = o.align === "justify" && !line.last && line.words.length > 1 ? line.words : null;
      const draw = (fn) => {
        if (!words) return fn(line.text, line.x, line.y);
        const gap = (w - 2 * pad - line.inner) / (words.length - 1);
        let x = line.x;
        for (const word of words) { fn(word.text, x, line.y); x += word.width + gap; }
      };
      if (sw > 0) { // the outline goes under the fill, so white outlines read as a halo
        ctx.lineWidth = sw * 2;
        ctx.lineJoin = "round";
        ctx.strokeStyle = grey(o.stroke.ink ?? 100);
        ctx.setLineDash(dashFor(o.stroke, sw));
        draw((t, x, y) => ctx.strokeText(t, x, y));
        ctx.setLineDash([]);
      }
      if (style) { ctx.fillStyle = style; draw((t, x, y) => ctx.fillText(t, x, y)); }
      const thick = Math.max(1, layout.px * 0.07);
      const lineW = words ? w - 2 * pad : line.width;
      ctx.fillStyle = style || grey(o.stroke?.ink ?? 100);
      if (o.underline) ctx.fillRect(line.x, line.y + layout.px * 0.1, lineW, thick);
      if (o.strike) ctx.fillRect(line.x, line.y - layout.px * 0.28, lineW, thick);
    }
  },
  image(ctx, o, w, h, env) {
    const src = Images.adjusted(o, env.doc);
    if (!src) { placeholder(ctx, w, h, !o.asset ? "+" : "…"); return; }
    let dw = w, dh = h;
    const ratio = src.width / src.height;
    if (o.fit === "contain") { if (w / h > ratio) dw = h * ratio; else dh = w / ratio; }
    if (o.fit === "cover") { if (w / h > ratio) dh = w / ratio; else dw = h * ratio; }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w, h);
    ctx.clip();
    ctx.translate(w / 2, h / 2);
    ctx.scale(o.flipH ? -1 : 1, o.flipV ? -1 : 1);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(src, -dw / 2, -dh / 2, dw, dh);
    ctx.restore();
  },
  barcode(ctx, o, w, h, env) {
    const content = expandAll(o.content, env);
    const code = Codes.get(o.kind, content);
    if (!code) { placeholder(ctx, w, h, "…"); return; }
    if (!code.ok) { placeholder(ctx, w, h, "!"); return; }
    const info = barcodeLayout(o, code, w, h);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#000";
    const bars = code.bars;
    for (let i = 0; i < bars.length;) {
      if (bars[i] !== "1") { i++; continue; }
      let j = i;
      while (bars[j] === "1") j++;
      ctx.fillRect(info.x0 + i * info.module, info.barsTop, (j - i) * info.module, info.barsHeight);
      i = j;
    }
    if (o.textPos !== "none") {
      ctx.font = `400 ${info.textPx}px ${fontFamily(o.font)}`;
      ctx.letterSpacing = "0px";
      ctx.textAlign = "center";
      ctx.textBaseline = o.textPos === "above" ? "top" : "bottom";
      ctx.fillText(code.label || content, w / 2, o.textPos === "above" ? 0 : h, w);
    }
  },
  qr(ctx, o, w, h, env) {
    const content = expandAll(o.content, env);
    const code = Codes.get(codeKind(o), content, codeOpts(o));
    if (!code) { placeholder(ctx, w, h, "…"); return; }
    if (!code.ok) { placeholder(ctx, w, h, "!"); return; }
    const q = qrLayout(o, code, w, h);
    const dark = o.invert ? "#fff" : "#000", light = o.invert ? "#000" : "#fff";
    ctx.fillStyle = light;
    ctx.fillRect(q.x0 - q.quiet * q.m, q.y0 - q.quiet * q.m, q.m * q.n, q.m * q.n);
    ctx.fillStyle = dark;
    code.matrix.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === "1") ctx.fillRect(q.x0 + x * q.m, q.y0 + y * q.m, q.m, q.m);
    });
  },
};

/** Where the bars go: whole dots per module when they fit, so bars stay crisp and scan. */
function barcodeLayout(o, code, w, h) {
  const textPx = (o.textSize || 6) * PT;
  const textH = o.textPos === "none" ? 0 : textPx * 1.1;
  const n = code.bars.length;
  let module = o.moduleDots > 0 ? o.moduleDots : w / n;
  if (module >= 1) module = Math.floor(module);
  const x0 = Math.round((w - module * n) / 2);
  const barsTop = o.textPos === "above" ? Math.ceil(textH) : 0;
  return { module, x0, barsTop, barsHeight: Math.max(1, h - textH), textPx, fits: module * n <= w + 0.5 };
}

/** Module size in whole dots, quiet zone and position of a QR code in its box. */
function qrLayout(o, code, w, h) {
  const quiet = Math.max(0, Number(o.quiet) || 0);
  const n = code.matrix.length + quiet * 2;
  let m = o.moduleDots > 0 ? o.moduleDots : Math.min(w, h) / n;
  if (m >= 1) m = Math.floor(m);
  const x0 = Math.round((w - m * n) / 2) + quiet * m, y0 = Math.round((h - m * n) / 2) + quiet * m;
  return { m, n, quiet, x0, y0, size: m * n };
}

/** Legibility of a code as printed: module in dots → "no" | "limit" | "good" | "great". */
function legibility(moduleDots) {
  return moduleDots < 2 ? "no" : moduleDots < 3 ? "limit" : moduleDots < 4 ? "good" : "great";
}

function strokeWith(ctx, s, sw) {
  ctx.lineWidth = sw;
  ctx.strokeStyle = grey(s.ink ?? 100);
  ctx.setLineDash(dashFor(s, sw));
  ctx.lineCap = s.dash === "dotted" ? "round" : "butt";
  ctx.stroke();
  ctx.setLineDash([]);
}

/** A box for content that is loading ("…"), missing ("+") or invalid ("!"). */
function placeholder(ctx, w, h, mark) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 2]);
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);
  ctx.setLineDash([]);
  ctx.fillStyle = "#000";
  ctx.font = `700 ${Math.max(6, Math.min(h * 0.6, 40))}px "Segoe UI", sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(mark, w / 2, h / 2);
}

const fontFamily = (name) => `"${String(name || "Segoe UI").replace(/["\\]/g, "")}", "Segoe UI", sans-serif`;
const fontCss = (o, px) => `${o.italic ? "italic " : ""}${o.bold ? 700 : 400} ${px}px ${fontFamily(o.font)}`;

/** Lines, positions and size of a text box. With autoFit the size is the largest that fits. */
function layoutText(ctx, o, w, h, content) {
  const pad = dots(o.padding || 0);
  const innerW = Math.max(1, w - 2 * pad), innerH = Math.max(1, h - 2 * pad);
  const measure = (px) => {
    ctx.font = fontCss(o, px);
    ctx.letterSpacing = `${(px * (o.spacing || 0)) / 100}px`; // spacing: % of the size
    const lines = [];
    for (const paragraph of content.split("\n")) {
      if (!o.wrap) { lines.push(paragraph); continue; }
      let current = "";
      for (const word of paragraph.split(/(\s+)/)) {
        const next = current + word;
        if (current.trim() && ctx.measureText(next.trimEnd()).width > innerW) {
          lines.push(current.trimEnd());
          current = word.trimStart();
        } else current = next;
      }
      lines.push(current.trimEnd());
    }
    const lineH = px * (o.lineHeight || 1.05);
    const out = lines.map((text, i) => {
      const m = ctx.measureText(text || " ");
      const words = [];
      let inner = 0;
      if (o.align === "justify") {
        for (const word of text.split(/\s+/).filter(Boolean)) {
          const width = ctx.measureText(word).width;
          words.push({ text: word, width });
          inner += width;
        }
      }
      return {
        text, width: text ? m.width : 0, ascent: m.actualBoundingBoxAscent, descent: m.actualBoundingBoxDescent,
        y: i * lineH, words, inner, last: i === lines.length - 1,
      };
    });
    const capAscent = ctx.measureText("H").actualBoundingBoxAscent;
    const top = Math.min(...out.map((l) => l.y - Math.max(l.ascent, capAscent * 0.7)));
    const bottom = Math.max(...out.map((l) => l.y + Math.max(0, l.descent)));
    return { lines: out, width: Math.max(...out.map((l) => l.width)), top, height: bottom - top, px };
  };

  let fit;
  if (o.autoFit) {
    let lo = 2, hi = Math.max(4, innerH * 2.2);
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      const m = measure(mid);
      if (m.height <= innerH && m.width <= innerW + 0.01) lo = mid; else hi = mid;
    }
    fit = measure(lo); // leave the context set to the chosen size
  } else {
    fit = measure((o.size || 24) * PT);
  }
  const offsetY = o.valign === "top" ? pad - fit.top
    : o.valign === "bottom" ? h - pad - fit.height - fit.top
    : (h - fit.height) / 2 - fit.top;
  for (const line of fit.lines) {
    line.y += offsetY;
    line.x = o.align === "right" ? w - pad - line.width
      : o.align === "center" ? (w - line.width) / 2
      : pad;
  }
  return fit;
}

/** The size in points that "fit" picked for a text object (shown greyed in the panel). */
function fittedSize(o, env) {
  const ctx = scratchContext(8, 8);
  const content = objectText(o, env);
  if (!content.trim()) return null;
  return layoutText(ctx, o, dots(o.w), dots(o.h), content).px / PT;
}

// ------------------------------------------------------------------ dithering
const DITHERS = ["auto", "threshold", "floyd", "atkinson", "stucki", "bayer4", "bayer8", "halftone", "lines", "noise"];

/** The dithering an object gets with "auto": crisp black for flat ink, dots for greys. */
function ditherMode(o) {
  if (o.type === "qr" || o.type === "barcode") return "threshold"; // modules are never dithered
  const mode = o.dither?.mode || "auto";
  if (mode !== "auto") return mode;
  if (o.type === "image") return "atkinson";
  if (o.type === "text" && /emoji/i.test(o.font || "")) return "atkinson";
  const greyish = (f) => f && (f.type === "gradient" || ((f.type === "solid" || f.type === "grey") && f.ink > 0 && f.ink < 100) || (f.type === "pattern" && f.ink > 0 && f.ink < 100));
  if (greyish(o.fill) || greyish(o.background) || (o.stroke?.width && o.stroke.ink > 0 && o.stroke.ink < 100)) return "bayer8";
  return "threshold";
}

const bayerCache = {};
function bayer(n) {
  if (bayerCache[n]) return bayerCache[n];
  let m = [[0]];
  while (m.length < n) {
    const s = m.length;
    const next = Array.from({ length: s * 2 }, () => new Array(s * 2));
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const v = m[y][x] * 4;
      next[y][x] = v; next[y][x + s] = v + 2; next[y + s][x] = v + 3; next[y + s][x + s] = v + 1;
    }
    m = next;
  }
  return (bayerCache[n] = m.map((row) => row.map((v) => ((v + 0.5) / (n * n)) * 255)));
}

const KERNELS = {
  floyd: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
  atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
  stucki: [[1, 0, 8], [2, 0, 4], [-2, 1, 2], [-1, 1, 4], [0, 1, 8], [1, 1, 4], [2, 1, 2], [-2, 2, 1], [-1, 2, 2], [0, 2, 4], [1, 2, 2], [2, 2, 1]]
    .map(([x, y, v]) => [x, y, v / 42]),
};

/**
 * Turn greys (0 black … 255 white) into dots (1 = black) where `mask` is set.
 * Ordered methods are anchored to the label, so neighbouring objects line up.
 */
function dither(greyMap, mask, W, H, mode, opts = {}) {
  const out = new Uint8Array(W * H);
  const bias = (opts.threshold ?? 128) - 128;
  if (KERNELS[mode]) {
    const g = Float32Array.from(greyMap);
    const kernel = KERNELS[mode];
    for (let y = 0; y < H; y++) {
      const reverse = mode === "floyd" && y % 2 === 1; // serpentine: no diagonal drift
      for (let i = 0; i < W; i++) {
        const x = reverse ? W - 1 - i : i;
        const p = y * W + x;
        if (!mask[p]) continue;
        const black = g[p] < 128 + bias;
        out[p] = black ? 1 : 0;
        const err = g[p] - (black ? 0 : 255);
        for (const [dx, dy, wgt] of kernel) {
          const nx = x + (reverse ? -dx : dx), ny = y + dy;
          if (nx < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (mask[q]) g[q] += err * wgt;
        }
      }
    }
    return out;
  }
  const cell = Math.max(2, Number(opts.cell) || 6);
  const a = rad(Number(opts.angle ?? 45));
  const ca = Math.cos(a), sa = Math.sin(a);
  const m4 = bayer(4), m8 = bayer(8);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (!mask[p]) continue;
      const v = greyMap[p];
      let t;
      switch (mode) {
        case "bayer4": t = m4[y & 3][x & 3] + bias; break;
        case "bayer8": t = m8[y & 7][x & 7] + bias; break;
        case "halftone": { // round dots that grow with the ink
          const u = (x * ca + y * sa) / cell, w = (-x * sa + y * ca) / cell;
          t = (1 - ((Math.cos(2 * Math.PI * u) + Math.cos(2 * Math.PI * w)) / 4 + 0.5)) * 255 + bias;
          break;
        }
        case "lines": { // engraving: lines that thicken with the ink
          const w = (-x * sa + y * ca) / cell;
          t = (1 - (Math.cos(2 * Math.PI * w) + 1) / 2) * 255 + bias;
          break;
        }
        case "noise": { // a fixed hash, so the preview does not flicker
          let s = (x * 374761393 + y * 668265263) | 0;
          s = Math.imul(s ^ (s >>> 13), 1274126177);
          t = (((s ^ (s >>> 16)) >>> 0) / 4294967296) * 255 + bias;
          break;
        }
        default: t = 128 + bias;
      }
      out[p] = v < t ? 1 : 0;
    }
  }
  return out;
}

// ------------------------------------------------------------------ the label
let scratch = null;
function scratchContext(W, H) {
  if (!scratch) scratch = document.createElement("canvas");
  if (scratch.width !== W || scratch.height !== H) { scratch.width = W; scratch.height = H; }
  return scratch.getContext("2d", { willReadFrequently: true });
}

/**
 * The objects that print on one label, in order: conditional visibility and empty
 * fields applied; with "close the gap" the objects to the right of a hidden one move
 * left by the space it took.
 */
function layoutFor(doc, env) {
  const shown = doc.objects.filter((o) => objectShows(o, env));
  const gaps = doc.objects.filter((o) => !o.hidden && o.closeGap && !shown.includes(o));
  if (!gaps.length) return shown;
  return shown.map((o) => {
    const b = bounds([o]);
    let dx = 0;
    for (const g of gaps) {
      const gb = bounds([g]);
      const overlapsY = b.y0 < gb.y1 && b.y1 > gb.y0;
      if (overlapsY && b.x0 >= gb.x1 - 0.01) {
        const next = shown.filter((s) => { const sb = bounds([s]); return sb.x0 >= gb.x1 - 0.01 && sb.y0 < gb.y1 && sb.y1 > gb.y0; })
          .reduce((m, s) => Math.min(m, bounds([s]).x0), Infinity);
        dx += Number.isFinite(next) ? next - gb.x0 : gb.w;
      }
    }
    return dx ? { ...o, x: o.x - dx } : o;
  });
}

/** The label as the printer gets it: { width, height, bits } with bits[y*width+x] = 1 for black. */
function rasterize(doc, env) {
  env = { ...env, doc };
  const objects = layoutFor(doc, env);
  const W = mmToDots(labelLength(doc, objects)), H = HEAD_DOTS;
  const bits = new Uint8Array(W * H);
  const ctx = scratchContext(W, H);
  const greyMap = new Float32Array(W * H);
  const mask = new Uint8Array(W * H);
  const soft = new Uint8Array(W * H);
  for (const o of objects) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    drawObject(ctx, o, env);
    const px = ctx.getImageData(0, 0, W, H).data;
    const whiteEmpty = o.type === "image" && o.whiteEmpty;
    let any = false;
    for (let i = 0; i < W * H; i++) {
      const a = px[i * 4 + 3];
      if (!a) { soft[i] = 0; mask[i] = 0; greyMap[i] = 255; continue; }
      const lum = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
      const g = 255 - (a * (255 - lum)) / 255; // over white
      if (whiteEmpty && g >= 245) { soft[i] = 0; mask[i] = 0; greyMap[i] = 255; continue; } // white leaves what is under
      any = true;
      soft[i] = a;
      mask[i] = 1;
      greyMap[i] = g;
    }
    if (!any) continue;
    const layer = dither(greyMap, mask, W, H, ditherMode(o), o.dither);
    for (let i = 0; i < W * H; i++) {
      if (soft[i] >= 128) bits[i] = layer[i]; // covered: this layer decides (white knocks out)
      else if (soft[i] && layer[i]) bits[i] = 1; // soft edge: only adds ink
    }
  }
  return { width: W, height: H, bits, objects };
}

/** A canvas with the label's dots (black on white). */
function bitsToCanvas(r, canvas = document.createElement("canvas")) {
  canvas.width = r.width;
  canvas.height = r.height;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(r.width, r.height);
  for (let i = 0; i < r.bits.length; i++) {
    const v = r.bits[i] ? 0 : 255;
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

const toPng = (r) => bitsToCanvas(r).toDataURL("image/png");

/** Every label of a print, ready: [{item, raster}], codes and images loaded first. */
async function renderPlan(doc, plan) {
  await Codes.ensure(doc, plan);
  await waitForImages(doc);
  return plan.map((item) => ({ item, raster: rasterize(doc, { vars: item.vars, texts: item.texts, raw: item.raw }) }));
}

function waitForImages(doc) {
  const waits = doc.objects.filter((o) => o.type === "image" && o.asset).map((o) => new Promise((resolve) => {
    if (Images.element(o.asset, doc.assets[o.asset])) return resolve();
    const entry = Images.elements.get(o.asset);
    if (!entry) return resolve();
    entry.img.addEventListener("load", resolve, { once: true });
    entry.img.addEventListener("error", resolve, { once: true });
  }));
  return Promise.all(waits);
}

/**
 * A thumbnail of a document in a canvas element (Home, templates): the printed dots of
 * its first label (or of row `row`). Drawn again when its codes and images arrive.
 */
function drawThumb(canvas, doc, { row = null } = {}) {
  const env = editEnv(doc);
  if (row !== null && doc.data?.rows.length) {
    const r = rowTexts(doc.data, row);
    env.texts = r.texts; env.raw = r.raw;
  }
  const draw = () => {
    if (!canvas.isConnected && canvas.dataset.drawn) { Resources.listeners.delete(draw); return; }
    const r = rasterize(doc, env);
    bitsToCanvas(r, canvas);
    canvas.dataset.drawn = "1";
    const pending = doc.objects.some((o) => (o.type === "barcode" || o.type === "qr") && !Codes.cache.has(Codes.key(codeKind(o), expandAll(o.content, env), codeOpts(o))))
      || doc.objects.some((o) => o.type === "image" && o.asset && !Images.element(o.asset, doc.assets?.[o.asset]));
    if (!pending) Resources.listeners.delete(draw);
  };
  Resources.listeners.add(draw);
  draw();
  return canvas;
}

/** A thumbnail canvas for a document, ready to insert. */
function thumbCanvas(doc, className = "thumb-canvas", options = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = className;
  try {
    drawThumb(canvas, normalizeDocument(doc), options);
  } catch {
    canvas.width = 1; canvas.height = 1;
  }
  return canvas;
}
