// Barcodes and QR codes in the browser. The Studio gets them from Python (python-barcode,
// segno, src/qutie/codes.py); these give the same modules: the barcode logic is
// python-barcode's, on its own tables (barcode-tables.js, generated), and the QR encoder
// follows the standard (as Nayuki's reference encoder), picking the mask by penalty.
// Results have the shape of codes.py: {ok, bars, label} or {ok, matrix, label, version}.

// ------------------------------------------------------------------ barcodes
const isDigits = (s) => /^\d+$/.test(s);

function gs1Check(digits) {
  let total = 0;
  [...digits].reverse().forEach((d, i) => { total += Number(d) * (i % 2 === 0 ? 3 : 1); });
  return (10 - (total % 10)) % 10;
}

/** The digits to encode, with the check digit added when it is missing (codes.py _gs1). */
function gs1Digits(kind, content) {
  const length = { ean13: 13, ean8: 8, upca: 12, itf14: 14 }[kind];
  const digits = content.replace(/\s/g, "");
  if (!isDigits(digits)) throw new Error("digits only");
  if (digits.length === length - 1) return [digits + gs1Check(digits), true];
  if (digits.length !== length) throw new Error(`${length - 1} or ${length} digits`);
  if (gs1Check(digits.slice(0, -1)) !== Number(digits.at(-1))) throw new Error(`wrong check digit: ${gs1Check(digits.slice(0, -1))}`);
  return [digits, false];
}

/** python-barcode's Code 128: starts in C, switches set as it does, checksum, stop. */
function code128Bars(code) {
  const t = BARCODE_TABLES.code128;
  for (const ch of code) if (!t.ALL.includes(ch)) throw new Error(`Code 128 cannot encode ${JSON.stringify(ch)}`);
  let charset = "C", buffer = "";
  const convert = (ch) => {
    if (charset === "A") return t.A[ch];
    if (charset === "B") return t.B[ch];
    if (ch in t.C) return t.C[ch];
    if (/\d/.test(ch)) {
      buffer += ch;
      if (buffer.length === 2) { const v = Number(buffer); buffer = ""; return v; }
      return null;
    }
    throw new Error(`${ch} cannot be converted in charset ${charset}`);
  };
  const newCharset = (which) => {
    const code_ = convert(`TO_${which}`);
    charset = which;
    return [code_];
  };
  const maybeSwitch = (pos) => {
    const ch = code[pos];
    const next = code.slice(pos, pos + 10);
    const lookNext = () => { let digits = 0; for (const c of next) { if (/\d/.test(c)) digits++; else break; } return digits > 3; };
    let codes = [];
    if (charset === "C" && !/\d/.test(ch)) {
      if (ch in t.B) codes = newCharset("B");
      else if (ch in t.A) codes = newCharset("A");
      if (buffer.length === 1) { codes.push(convert(buffer[0])); buffer = ""; }
    } else if (charset === "B") {
      if (lookNext()) codes = newCharset("C");
      else if (!(ch in t.B) && ch in t.A) codes = newCharset("A");
    } else if (charset === "A") {
      if (lookNext()) codes = newCharset("C");
      else if (!(ch in t.A) && ch in t.B) codes = newCharset("B");
    }
    return codes;
  };
  let encoded = [t.START.C];
  [...code].forEach((ch, i) => {
    encoded.push(...maybeSwitch(i));
    const n = convert(ch);
    if (n !== null && n !== undefined) encoded.push(n);
  });
  if (buffer.length === 1) {
    encoded.push(...newCharset("B"));
    encoded.push(convert(buffer[0]));
    buffer = "";
  }
  if (String(encoded[1]) in t.TO) encoded = [t.TO[String(encoded[1])], ...encoded.slice(2)];
  const checksum = (encoded[0] + encoded.slice(1).reduce((s, v, i) => s + (i + 1) * v, 0)) % 103;
  return encoded.concat(checksum).map((n) => t.CODES[n]).join("") + t.STOP + "11";
}

function code39Bars(code) {
  const t = BARCODE_TABLES.code39;
  for (const ch of code) if (!(ch in t.MAP)) throw new Error(`Code 39 cannot encode ${JSON.stringify(ch)}`);
  return [t.EDGE, ...[...code].map((ch) => t.MAP[ch][1]), t.EDGE].join(t.MIDDLE);
}

function eanBars(ean) {
  const t = BARCODE_TABLES.ean;
  if (ean.length === 8) {
    return t.EDGE + [...ean.slice(0, 4)].map((d) => t.CODES.A[d]).join("") + t.MIDDLE + [...ean.slice(4)].map((d) => t.CODES.C[d]).join("") + t.EDGE;
  }
  const pattern = t.LEFT_PATTERN[Number(ean[0])];
  return t.EDGE + [...ean.slice(1, 7)].map((d, i) => t.CODES[pattern[i]][d]).join("") + t.MIDDLE + [...ean.slice(7)].map((d) => t.CODES.C[d]).join("") + t.EDGE;
}

function upcBars(upc) {
  const t = BARCODE_TABLES.upc;
  return t.EDGE + [...upc.slice(0, 6)].map((d) => t.CODES.L[d]).join("") + t.MIDDLE + [...upc.slice(6)].map((d) => t.CODES.R[d]).join("") + t.EDGE;
}

/** Narrow and wide elements (N n W w) into modules: 2 and 5, python-barcode's defaults. */
const nwModules = (data) => [...data].map((e) => ({ W: "11111", w: "00000", N: "11", n: "00" })[e] || "").join("");

function itfBars(code) {
  const t = BARCODE_TABLES.itf;
  if (!isDigits(code)) throw new Error("ITF code can only contain numbers");
  if (code.length % 2) code = `0${code}`;
  let data = t.START;
  for (let i = 0; i < code.length; i += 2) {
    const bars = t.CODES[Number(code[i])], spaces = t.CODES[Number(code[i + 1])];
    for (let j = 0; j < 5; j++) data += bars[j].toUpperCase() + spaces[j].toLowerCase();
  }
  return nwModules(data + t.STOP);
}

function codabarBars(code) {
  const t = BARCODE_TABLES.codabar;
  if (!(code[0] in t.STARTSTOP) || !(code.at(-1) in t.STARTSTOP)) throw new Error("Codabar should start and end with A, B, C or D");
  const middle = [...code.slice(1, -1)].map((c) => {
    if (!(c in t.CODES)) throw new Error("Codabar can only contain numerics or $:/.+-");
    return t.CODES[c];
  });
  return nwModules(`${t.STARTSTOP[code[0]]}n${middle.join("n")}n${t.STARTSTOP[code.at(-1)]}`);
}

/** The bars of a barcode as a 0/1 string, one character per module (codes.barcode_modules). */
function barcodeModules(kind, content) {
  try {
    content = String(content ?? "");
    let added = false, bars, label;
    if (["ean13", "ean8", "upca", "itf14"].includes(kind)) [content, added] = gs1Digits(kind, content);
    switch (kind) {
      case "code128": bars = code128Bars(content); label = content; break;
      case "code39": label = content.toUpperCase(); bars = code39Bars(label); break;
      case "codabar": { const text = content.toUpperCase(); label = "ABCD".includes(text[0] || "x") ? text : `A${text}A`; bars = codabarBars(label); break; }
      case "ean13": case "ean8": bars = eanBars(content); label = content; break;
      case "upca": bars = upcBars(content); label = content; break;
      case "itf14": bars = itfBars(content); label = content; break;
      default: throw new Error(`unknown barcode: ${kind}`);
    }
    return { ok: true, bars, label, check_added: added, check: ["ean13", "ean8", "upca", "itf14"].includes(kind) ? content.at(-1) : null };
  } catch (e) {
    return { ok: false, detail: e.message || String(e) };
  }
}

// ------------------------------------------------------------------ QR codes
const QR_ECC = { l: 0, m: 1, q: 2, h: 3 };
const QR_FORMAT = { l: 1, m: 0, q: 3, h: 2 };
const QR_ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const QR_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];
const QR_ALNUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";
const QR_MODES = { numeric: [1, 10, 12, 14], alphanumeric: [2, 9, 11, 13], byte: [4, 8, 16, 16] };

function qrRawModules(ver) {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}
const qrDataCodewords = (ver, e) => Math.floor(qrRawModules(ver) / 8) - QR_ECC_PER_BLOCK[e][ver] * QR_BLOCKS[e][ver];
const qrCountBits = (mode, ver) => QR_MODES[mode][1 + Math.floor((ver + 7) / 17)];

function gfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = gfMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return r;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
  }
  return result;
}

/** The data as bits in one segment: numeric, alphanumeric or bytes (Latin-1 when it fits, else UTF-8, as segno). */
function qrSegment(text) {
  const bits = [];
  const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  if (/^\d*$/.test(text)) {
    for (let i = 0; i < text.length; i += 3) {
      const part = text.slice(i, i + 3);
      put(Number(part), part.length * 3 + 1);
    }
    return { mode: "numeric", count: text.length, bits };
  }
  if ([...text].every((c) => QR_ALNUM.includes(c))) {
    for (let i = 0; i + 1 < text.length; i += 2) put(QR_ALNUM.indexOf(text[i]) * 45 + QR_ALNUM.indexOf(text[i + 1]), 11);
    if (text.length % 2) put(QR_ALNUM.indexOf(text.at(-1)), 6);
    return { mode: "alphanumeric", count: text.length, bits };
  }
  const latin1 = [...text].every((c) => c.codePointAt(0) <= 0xff);
  const bytes = latin1 ? [...text].map((c) => c.codePointAt(0)) : [...new TextEncoder().encode(text)];
  for (const b of bytes) put(b, 8);
  return { mode: "byte", count: bytes.length, bits };
}

/** A QR code as rows of "0"/"1" (codes.qr_modules). ecc: l m q h; version: 1–40 or auto; mask: 0–7 or auto. */
function qrModules(content, { micro = false, ecc = "m", version = null, mask = null } = {}) {
  if (micro) return { ok: false, detail: "Micro QR is not available in the browser: use a QR code" };
  try {
    const text = String(content || " ");
    const e = QR_ECC[(ecc || "m").toLowerCase()];
    if (e === undefined) throw new Error(`error correction ${ecc}?`);
    const seg = qrSegment(text);
    const fixed = version && version !== "auto" ? Number(version) : null;
    let ver = fixed || 1;
    for (; ; ver++) {
      if (ver > (fixed || 40)) throw new Error(fixed ? `too much data for version ${fixed}` : "too much data for a QR code");
      const used = 4 + qrCountBits(seg.mode, ver) + seg.bits.length;
      if (seg.count < 2 ** qrCountBits(seg.mode, ver) && used <= qrDataCodewords(ver, e) * 8) break;
    }
    // bits → codewords: mode, count, data, terminator, padding
    const capacity = qrDataCodewords(ver, e) * 8;
    const bits = [];
    const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    put(QR_MODES[seg.mode][0], 4);
    put(seg.count, qrCountBits(seg.mode, ver));
    bits.push(...seg.bits);
    put(0, Math.min(4, capacity - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((v, b) => (v << 1) | b, 0));

    // error correction, interleaved
    const numBlocks = QR_BLOCKS[e][ver], eccLen = QR_ECC_PER_BLOCK[e][ver];
    const raw = Math.floor(qrRawModules(ver) / 8);
    const numShort = numBlocks - (raw % numBlocks), shortLen = Math.floor(raw / numBlocks);
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc_ = rsRemainder(dat, divisor);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc_));
    }
    const codewords = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((b, j) => { if (i !== shortLen - eccLen || j >= numShort) codewords.push(b[i]); });
    }

    // the symbol
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFunction = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };
    const bit = (v, i) => ((v >>> i) & 1) !== 0;
    for (let i = 0; i < size; i++) { setFunction(6, i, i % 2 === 0); setFunction(i, 6, i % 2 === 0); }
    const finder = (x, y) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)), xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < size && yy >= 0 && yy < size) setFunction(xx, yy, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const align = [];
    if (ver > 1) {
      const n = Math.floor(ver / 7) + 2;
      const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
      for (let pos = size - 7; align.length < n - 1; pos -= step) align.unshift(pos);
      align.unshift(6);
    }
    align.forEach((ay, i) => align.forEach((ax, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFunction(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }));
    const formatBits = (m) => {
      const value = (QR_FORMAT[Object.keys(QR_ECC)[e]] << 3) | m;
      let rem = value;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((value << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setFunction(8, i, bit(b, i));
      setFunction(8, 7, bit(b, 6)); setFunction(8, 8, bit(b, 7)); setFunction(7, 8, bit(b, 8));
      for (let i = 9; i < 15; i++) setFunction(14 - i, 8, bit(b, i));
      for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, bit(b, i));
      for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, bit(b, i));
      setFunction(8, size - 8, true);
    };
    formatBits(0);
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3), c = Math.floor(i / 3);
        setFunction(a, c, bit(b, i)); setFunction(c, a, bit(b, i));
      }
    }
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
        if (!isFunction[y][x] && k < codewords.length * 8) { modules[y][x] = bit(codewords[k >>> 3], 7 - (k & 7)); k++; }
      }
    }
    const MASKS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const applyMask = (m) => {
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!isFunction[y][x] && MASKS[m](x, y)) modules[y][x] = !modules[y][x];
    };
    const penalty = () => {
      let score = 0;
      const addHistory = (run, history) => { if (history[0] === 0) run += size; history.pop(); history.unshift(run); };
      const countPatterns = (h) => {
        const n = h[1];
        const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
        return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
      };
      const lines = (get) => {
        for (let a = 0; a < size; a++) {
          let color = false, run = 0;
          const history = [0, 0, 0, 0, 0, 0, 0];
          for (let b = 0; b < size; b++) {
            if (get(a, b) === color) {
              run++;
              if (run === 5) score += 3; else if (run > 5) score++;
            } else {
              addHistory(run, history);
              if (!color) score += countPatterns(history) * 40;
              color = get(a, b);
              run = 1;
            }
          }
          if (color) { addHistory(run, history); run = 0; }
          run += size;
          addHistory(run, history);
          score += countPatterns(history) * 40;
        }
      };
      lines((y, x) => modules[y][x]);
      lines((x, y) => modules[y][x]);
      for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
      }
      const dark = modules.reduce((s, row) => s + row.filter(Boolean).length, 0);
      const total = size * size;
      score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return score;
    };
    let chosen = mask === null || mask === undefined || mask === "auto" ? -1 : Number(mask);
    if (chosen < 0) {
      let best = Infinity;
      for (let m = 0; m < 8; m++) {
        applyMask(m); formatBits(m);
        const p = penalty();
        if (p < best) { best = p; chosen = m; }
        applyMask(m);
      }
    }
    applyMask(chosen);
    formatBits(chosen);
    const matrix = modules.map((row) => row.map((v) => (v ? "1" : "0")).join(""));
    return { ok: true, matrix, label: `${ver}-${"LMQH"[e]}`, version: ver, modules: size, mode: seg.mode, chars: text.length, mask: chosen };
  } catch (err) {
    return { ok: false, detail: err.message || String(err) };
  }
}
