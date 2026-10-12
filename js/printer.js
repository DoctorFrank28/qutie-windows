// Connecting to the Qutie from the browser, and the public API.
//
// Bluetooth LE (Web Bluetooth: Chrome and Edge, Android included): service FF00, commands
// written to FF02 in 180-byte packets without response (slower sending lets the printer stop
// between blocks and leaves gaps), replies notified on FF01, flow control on FF03.
// Serial (Web Serial: Chrome and Edge on desktop): the Bluetooth SPP port.
// "dithering_finish" means the printer has printed everything it received.

const LE = { service: 0xff00, write: 0xff02, reply: 0xff01, flow: 0xff03, packet: 180 };
const SPP = "00001101-0000-1000-8000-00805f9b34fb";
const FINISHED = "dithering_finish";

class QutieError extends Error {
  constructor(message, code) { super(message); this.name = "QutieError"; this.code = code; }
}

/** Bytes from the printer, and waiting for some. */
class Inbox {
  constructor() { this.bytes = new Uint8Array(0); this.waiters = []; this.onData = null; }
  push(value) {
    this.onData?.(value);
    const next = new Uint8Array(this.bytes.length + value.length);
    next.set(this.bytes);
    next.set(value, this.bytes.length);
    this.bytes = next;
    this.waiters = this.waiters.filter((w) => !w());
  }
  /** What arrives after position `from`, once `test` accepts it; null after `ms`. */
  wait(from, test, ms) {
    return new Promise((resolve) => {
      const check = () => {
        const got = this.bytes.slice(from);
        if (!test(got)) return false;
        clearTimeout(timer);
        resolve(got);
        return true;
      };
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== check); resolve(null); }, ms);
      if (!check()) this.waiters.push(check);
    });
  }
}

const latin1 = (bytes) => new TextDecoder("latin1").decode(bytes);

async function openBluetooth(inbox, onClose) {
  const device = await navigator.bluetooth.requestDevice({
    filters: [{ services: [LE.service] }, { namePrefix: "Qutie" }], optionalServices: [LE.service],
  });
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(LE.service);
  const tx = await service.getCharacteristic(LE.write);
  const reply = await service.getCharacteristic(LE.reply);
  reply.addEventListener("characteristicvaluechanged", (e) => {
    const v = e.target.value;
    inbox.push(new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)));
  });
  await reply.startNotifications();
  try { await (await service.getCharacteristic(LE.flow)).startNotifications(); } catch { /* flow control is optional */ }
  device.addEventListener("gattserverdisconnected", onClose);
  return {
    kind: "bluetooth", name: device.name || "Qutie",
    async write(bytes) {
      for (let i = 0; i < bytes.length; i += LE.packet) await tx.writeValueWithoutResponse(bytes.slice(i, i + LE.packet));
    },
    async close() { device.removeEventListener("gattserverdisconnected", onClose); device.gatt.disconnect(); },
  };
}

async function openSerial(inbox, onClose, { allPorts = false } = {}) {
  const port = await navigator.serial.requestPort(allPorts
    ? { allowedBluetoothServiceClassIds: [SPP] }
    : { allowedBluetoothServiceClassIds: [SPP], filters: [{ bluetoothServiceClassId: SPP }] });
  await port.open({ baudRate: 115200 });
  const writer = port.writable.getWriter();
  let reader = null, open = true;
  (async () => {
    while (open && port.readable) {
      reader = port.readable.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) inbox.push(value);
        }
      } catch { break; } finally { reader.releaseLock(); reader = null; }
    }
  })();
  port.addEventListener("disconnect", onClose);
  return {
    kind: "serial", name: "Qutie",
    write: (bytes) => writer.write(bytes),
    async close() {
      open = false;
      port.removeEventListener("disconnect", onClose);
      try { await reader?.cancel(); } catch { /* already gone */ }
      try { writer.releaseLock(); } catch { /* already gone */ }
      try { await port.close(); } catch { /* already gone */ }
    },
  };
}

// ------------------------------------------------------------------ labels
/** A .qutie document from an object, JSON text, a File/Blob or a URL. */
async function readLabel(source) {
  if (source && typeof source === "object" && !(source instanceof Blob) && !(source instanceof URL)) return structuredClone(source);
  if (source instanceof Blob) return JSON.parse(await source.text());
  const text = String(source);
  if (text.trim().startsWith("{")) return JSON.parse(text);
  const response = await fetch(source);
  if (!response.ok) throw new QutieError(`cannot read ${source}: HTTP ${response.status}`, "load");
  return response.json();
}

const cell = (v) => (v instanceof Date ? `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}` : v ?? "");

/**
 * The document with the data to print: `fields` ({Name: value}) for one label, or `rows`
 * ([{Name: value}, …]) for one label per row. They take the place of the rows saved in the
 * file; its formula fields, copies column and filters still apply.
 */
function withData(doc, { fields, rows } = {}) {
  if (!fields && !rows) return doc;
  const list = rows || [fields];
  const old = doc.data;
  const names = (old?.columns || []).map((c) => c.name);
  const keys = [...new Set([...names, ...list.flatMap((r) => Object.keys(r))])];
  doc.data = engine.newData({
    ...(old || {}),
    source: { kind: "table", name: "data", path: null, sheet: null, header: true, link: "copy" },
    columns: keys.map((k) => old?.columns.find((c) => c.name === k) || { name: k, type: "text" }),
    rows: list.map((r) => keys.map((k) => cell(r[k]))),
    which: "all", checked: [], current: 0,
  });
  return doc;
}

/** Codes that cannot be made stop the print: the engine would draw a "!" in their place. */
function checkCodes(doc, plan) {
  for (const item of plan) {
    const env = { vars: item.vars, texts: item.texts, raw: item.raw, doc };
    for (const o of engine.layoutFor(doc, env)) {
      if (o.type !== "barcode" && o.type !== "qr") continue;
      const content = engine.expandAll(o.content, env);
      const kind = engine.codeKind(o), opts = engine.codeOpts(o);
      const r = kind === "qr" || kind === "microqr"
        ? qrModules(content, { micro: kind === "microqr", ecc: opts.ecc, version: opts.version })
        : barcodeModules(kind, content);
      if (!r.ok) throw new QutieError(`${o.name || o.type}: «${content}» cannot be encoded (${r.detail})`, "code");
    }
  }
}

/** Every label of a print, drawn: [{raster, item, media}] (raster: {width, height, bits}). */
async function renderLabels(label, options = {}) {
  const doc = withData(engine.normalizeDocument(await readLabel(label)), options);
  const plan = engine.labelPlan(doc, { start: options.start, repeat: options.repeat, count: options.count, collate: options.collate });
  const now = options.now ? new Date(options.now) : null;
  if (now) for (const item of plan) item.vars.now = now;
  if (options.copies > 1) {
    const copies = Math.min(999, Math.floor(options.copies));
    plan.splice(0, plan.length, ...plan.flatMap((item) => Array.from({ length: copies }, () => item)));
  }
  if (options.checkCodes !== false) checkCodes(doc, plan);
  const rendered = await engine.renderPlan(doc, plan);
  return rendered.map(({ item, raster }) => ({ item, raster, media: engine.mediaOf(doc, engine.labelLength(doc, raster.objects)) }));
}

/** A picture (img, canvas, ImageBitmap, Blob or URL) as a data URL and its size. */
async function pictureUrl(source) {
  let img = source;
  if (source instanceof Blob || typeof source === "string" || source instanceof URL) {
    const blob = source instanceof Blob ? source : await (await fetch(source)).blob();
    img = await createImageBitmap(blob);
  }
  const w = img.naturalWidth || img.videoWidth || img.width, h = img.naturalHeight || img.videoHeight || img.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d").drawImage(img, 0, 0);
  return { url: canvas.toDataURL("image/png"), width: w, height: h };
}

/** A label with one picture across the tape: `length` in mm, or "auto" for continuous tape. */
async function pictureLabel(source, { length = "auto", dither = "atkinson", fit = "contain", invert = false } = {}) {
  const pic = await pictureUrl(source);
  const H = engine.TAPE_MM;
  const auto = length === "auto";
  const len = Number(length) || 40;
  const width = auto ? Math.min(998, Math.max(3, H * pic.width / pic.height)) : len - 2;
  const doc = engine.newDocument({
    name: "picture",
    label: auto ? { media: "continuous", length: 40, auto: true, margin: 1, feed: engine.FEED_CONTINUOUS }
      : { media: "gap", length: len, auto: false, margin: 2, feed: engine.FEED_GAP },
    assets: { picture: pic.url },
  });
  doc.objects.push(engine.makeObject("image", {
    name: "picture", asset: "picture", x: 1, y: 0, w: width, h: H, fit, invert, dither: { mode: dither },
  }));
  return doc;
}

// ------------------------------------------------------------------ the printer
class Printer extends EventTarget {
  constructor(link, inbox) {
    super();
    this.link = link;
    this.inbox = inbox;
    this.busy = Promise.resolve();
    /** What happened in the last print: [{ms, what}], times from its start (to see why it was slow). */
    this.lastTrace = [];
  }

  /** "bluetooth" or "serial"; null once disconnected. */
  get transport() { return this.link?.kind || null; }
  get connected() { return Boolean(this.link); }
  get name() { return this.link?.name || null; }

  async #send(bytes) {
    if (!this.link) throw new QutieError("the printer is not connected", "disconnected");
    await this.link.write(bytes);
  }

  /** One thing at a time: the printer takes one job and one question at a time. */
  #queue(task) {
    const run = this.busy.then(task, task);
    this.busy = run.catch(() => {});
    return run;
  }

  async #ask(command, size, label) {
    const from = this.inbox.bytes.length;
    await this.#send(command);
    const reply = await this.inbox.wait(from, (b) => b.length >= size, 4000);
    if (!reply) throw new QutieError(`no ${label} reply from the printer`, "timeout");
    return reply.slice(0, size);
  }

  /** Battery (%), paper ("continuous" or "gap"), density and auto power off (minutes). */
  status() { return this.#queue(async () => parseStatus(await this.#ask(COMMANDS.status(), 17, "status"))); }

  /** Model, serial number, firmware, board and Bluetooth firmware. */
  info() { return this.#queue(async () => parseInfo(await this.#ask(COMMANDS.info(), 124, "info"))); }

  /** Feed the tape by `mm` (14 by default). */
  feed(mm = FEED_MM) { return this.#queue(() => this.#send(COMMANDS.feed(mm))); }

  /** Print density, 50–100 (95 out of the box; HerePrint prints at 75). */
  setDensity(value) { return this.#queue(() => this.#send(COMMANDS.density(Math.max(50, Math.min(100, Number(value)))))); }

  /** Minutes before the printer turns itself off (15 out of the box). */
  setAutoOff(minutes) { return this.#queue(() => this.#send(COMMANDS.autoOff(Number(minutes)))); }

  /** Print rasters drawn elsewhere: [{raster: {width, height: 96, bits}, media}]. */
  printRasters(labels, { onProgress } = {}) {
    return this.#queue(async () => {
      let printed = 0;
      const started = performance.now();
      const trace = (this.lastTrace = []);
      const note = (what) => trace.push({ ms: Math.round(performance.now() - started), what });
      this.inbox.onData = (v) => note(`printer: ${latin1(v).replace(/[^ -~]+/g, " ").trim() || `${v.length} bytes`}`);
      try {
        for (const { raster, media } of labels) {
          const writes = labelJob(raster, media);
          const last = writes.findLastIndex((w) => w[0] === 0x1d && w[1] === 0x76); // the last raster block
          let from = this.inbox.bytes.length;
          for (const [i, w] of writes.entries()) {
            // The printer reports "dithering_finish" once it has printed all it received: the first
            // one from the start of the last block on (a slow link also gets one between blocks).
            if (i === last) from = this.inbox.bytes.length;
            await this.#send(w);
            note(`label ${printed + 1}: sent ${w.length} bytes`);
          }
          const done = await this.inbox.wait(from, (b) => latin1(b).includes(FINISHED), 20000);
          if (!done) throw new QutieError(`label ${printed + 1}: no confirmation from the printer`, "timeout");
          printed++;
          onProgress?.({ printed, total: labels.length });
          this.dispatchEvent(new CustomEvent("printed", { detail: { printed, total: labels.length } }));
        }
      } finally {
        this.inbox.onData = null;
      }
      return { printed };
    });
  }

  /**
   * Print a label from Qutie Studio (.qutie: an object, JSON, a File or a URL), with the data
   * and variables of the Studio. options: {fields | rows, copies, start, repeat, count, now, onProgress}.
   */
  async print(label, options = {}) {
    const labels = await renderLabels(label, options);
    return this.printRasters(labels, options);
  }

  /** Print text on one label: `length` 30, 40, 50… mm or "auto" (continuous tape, as long as the text). */
  printText(text, { length = 40, ...options } = {}) {
    return this.print(engine.quickDocument(String(text), String(length)), options);
  }

  /** Print a picture (img, canvas, ImageBitmap, Blob or URL) across the tape. */
  async printImage(source, options = {}) {
    return this.print(await pictureLabel(source, options), options);
  }

  /** Disconnect; the printer can be connected again with Qutie.connect(). */
  async disconnect() {
    const link = this.link;
    this.link = null;
    await link?.close();
  }
}

/** The library: support, connection, preview. */
const Qutie = {
  version: "__VERSION__",

  /** What this browser can use: {bluetooth, serial, secure}. */
  support() {
    const nav = typeof navigator === "undefined" ? {} : navigator;
    return { bluetooth: "bluetooth" in nav, serial: "serial" in nav, secure: typeof window !== "undefined" && window.isSecureContext };
  },

  /**
   * Choose a Qutie and connect (must follow a click or tap). via: "auto" (Bluetooth LE, else the
   * serial port), "bluetooth" or "serial"; allPorts: list every serial port, not just SPP ones.
   */
  async connect({ via = "auto", allPorts = false } = {}) {
    const s = Qutie.support();
    if (!s.secure) throw new QutieError("the page must be served over HTTPS (or from localhost)", "insecure");
    const kind = via === "auto" ? (s.bluetooth ? "bluetooth" : s.serial ? "serial" : null) : via;
    if (!kind || (kind === "bluetooth" && !s.bluetooth) || (kind === "serial" && !s.serial)) {
      throw new QutieError("this browser cannot reach the printer: use Chrome or Edge", "unsupported");
    }
    const inbox = new Inbox();
    let printer = null;
    const onClose = () => {
      if (!printer?.link) return;
      printer.link = null;
      printer.dispatchEvent(new Event("disconnect"));
    };
    const link = kind === "bluetooth" ? await openBluetooth(inbox, onClose) : await openSerial(inbox, onClose, { allPorts });
    printer = new Printer(link, inbox);
    return printer;
  },

  /**
   * The labels a print would make, as canvases with the printed dots (for previews).
   * Same options as printer.print(); scale enlarges each dot.
   */
  async preview(label, { scale = 1, ...options } = {}) {
    const labels = await renderLabels(label, { ...options, checkCodes: false });
    return labels.map(({ raster, item }) => {
      const canvas = engine.bitsToCanvas(raster);
      if (scale !== 1) {
        const big = document.createElement("canvas");
        big.width = raster.width * scale;
        big.height = raster.height * scale;
        const ctx = big.getContext("2d");
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(canvas, 0, 0, big.width, big.height);
        return { canvas: big, row: item.row, copy: item.copy };
      }
      return { canvas, row: item.row, copy: item.copy };
    });
  },

  /** The fields a label can be given: the columns of its data and the «fields» in its texts
   * (formula fields are left out: they are worked out from the others). */
  async fields(label) {
    const doc = engine.normalizeDocument(await readLabel(label));
    const formulas = new Set((doc.data?.formulas || []).map((f) => f.name));
    const own = (doc.data?.columns || []).map((c) => c.name);
    const used = doc.objects.flatMap((o) => engine.fieldsIn(`${o.text || ""} ${o.content || ""}`));
    return [...new Set([...own, ...used])].filter((f) => !formulas.has(f));
  },

  /** A quick-print document for text, to preview or print. */
  textLabel: (text, { length = 40 } = {}) => engine.quickDocument(String(text), String(length)),

  /** A document with a picture, to preview or print. */
  imageLabel: (source, options) => pictureLabel(source, options),

  /** Language of dates, numbers and yes/no in labels ("it", "en-US"…); the browser's by default. */
  setLanguage(tag) { engine.setLocale(tag); },

  barcode: barcodeModules,
  qr: qrModules,
};
