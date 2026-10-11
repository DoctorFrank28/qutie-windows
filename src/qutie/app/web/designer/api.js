"use strict";
/* The app behind the page: pywebview in Qutie, the development server in a browser
 * (python -m qutie.app.designer), or a stand-in when the page is opened on its own.
 */

const ready = new Promise((resolve) => {
  if (window.pywebview?.api) return resolve(window.pywebview.api);
  window.addEventListener("pywebviewready", () => resolve(window.pywebview.api));
  setTimeout(async () => { if (!window.pywebview?.api) resolve(await browserApi()); }, 600);
});

const api = async (name, ...args) => {
  const target = await ready;
  if (typeof target[name] !== "function") throw new Error(`${name}: not available`);
  return target[name](...args);
};

// What only the window can do (file dialogs, closing): done by the browser instead.
const BROWSER_ONLY = ["save", "open", "export_png", "export_qutie", "choose_folder", "pick_data_file", "import_template",
  "close", "minimize", "watch_drops", "open_settings", "forget_path", "set_dirty", "current_path"];

async function browserApi() {
  const post = async (name, args) => {
    const r = await fetch(`/api/${name}`, { method: "POST", body: JSON.stringify(args) });
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    return r.json();
  };
  try {
    await post("fonts", []);
    const local = offlineApi();
    return new Proxy({}, {
      // "then" must stay undefined, or the promise that resolves to this proxy waits for it forever.
      get: (_, name) => (name === "then" || typeof name !== "string" ? undefined : BROWSER_ONLY.includes(name) ? local[name] : (...args) => post(name, args)),
    });
  } catch {
    return offlineApi();
  }
}

/** Enough to try the Studio without the app: no printer, files go through the browser. */
function offlineApi() {
  const later = (v, ms = 120) => new Promise((r) => setTimeout(() => r(v), ms));
  const download = (href, name) => {
    const a = document.createElement("a");
    a.href = href;
    a.download = name;
    a.click();
  };
  const fail = (ms = 400) => later({ ok: false, detail: T.offline }, ms);
  return {
    state: () => later({ version: "dev", config: {}, studio: true, library: "Documents\\Qutie", autostart: false, start: {} }),
    set_config: (c) => later(c),
    fonts: () => later(["Arial", "Arial Black", "Bahnschrift", "Consolas", "Courier New", "Franklin Gothic Medium", "Georgia", "Impact",
      "Ink Free", "Segoe Print", "Segoe Script", "Segoe UI", "Segoe UI Emoji", "Segoe UI Symbol", "Tahoma", "Times New Roman", "Verdana"].map((name) => ({ name, mono: /Consolas|Courier/.test(name) }))),
    codes: (kind, content) => later(kind === "qr" || kind === "microqr"
      ? { ok: true, matrix: sampleMatrix(content, kind === "microqr" ? 13 : 25), label: "demo", version: 2, modules: kind === "microqr" ? 13 : 25, chars: String(content).length, capacity: 26, mode: "byte" }
      : { ok: true, bars: sampleBars(content), label: content }),
    qr_options: () => later({ chars: 0, ecc: {} }),
    verify_codes: () => later({ ok: null, found: [], missing: [] }),
    printer: () => fail(), apply_printer: () => fail(), feed: () => fail(), test_label: () => fail(),
    check_updates: () => fail(), open_page: () => later(false),
    print_labels: () => fail(600), print_status: () => later({ running: false }), stop_print: () => later(null),
    history: () => later({ entries: [], stats: null }), history_detail: () => later(null), history_remove: () => later(null), history_clear: () => later(null), reprint: () => fail(),
    autosave: () => later(null), restore: () => later(null), discard_recovery: () => later(null), set_dirty: () => later(null), current_path: () => later(null),
    recent: () => later([]), clear_recent: () => later(null), library: () => later({ root: "Documents\\Qutie", labels: [], folders: [] }),
    file_action: () => fail(), templates: () => later([]), save_template: () => fail(), delete_template: () => later(null),
    read_data: () => fail(), read_data_bytes: () => fail(), data_status: () => later({ exists: false }), sources: () => later([]),
    parse_table: (text) => later(parseTsv(text)),
    windows_printer: () => later({ printer: null, defaults: {}, preview: true }), set_windows_defaults: () => fail(), set_preview: () => later(null),
    test_windows: () => fail(), open_windows: () => later(null), open_setup: () => later(null), set_autostart: (v) => later(v),
    forget_path: () => later(null), watch_drops: () => later(null), open_settings: () => later(null), close: () => later(null), minimize: () => later(null),
    choose_folder: () => later(null), pick_data_file: () => later(null), import_template: () => later({ ok: false, cancelled: true }),
    save: (document, name) => {
      download(URL.createObjectURL(new Blob([document], { type: "application/json" })), `${name || "label"}.qutie`);
      return later({ ok: true, name });
    },
    export_qutie: (document, name) => { download(URL.createObjectURL(new Blob([document], { type: "application/json" })), `${name || "label"}.qutie`); return later({ ok: true }); },
    open: () => new Promise((resolve) => {
      const input = Object.assign(document.createElement("input"), { type: "file", accept: ".qutie,application/json" });
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return resolve({ ok: false, cancelled: true });
        resolve({ ok: true, document: await file.text(), name: file.name.replace(/\.qutie$/i, "") });
      };
      input.click();
    }),
    export_png: (dataUrl, name) => { download(dataUrl, `${name || "label"}.png`); return later({ ok: true }); },
  };
}

/** A pasted table, for the stand-in (the app reads it in Python). */
function parseTsv(text) {
  const lines = String(text || "").split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { ok: false, columns: [], rows: [] };
  const sep = lines[0].includes("\t") ? "\t" : lines[0].includes(";") ? ";" : ",";
  const cells = lines.map((l) => l.split(sep).map((c) => c.trim()));
  return { ok: true, columns: cells[0].map((name) => ({ name, type: "text" })), rows: cells.slice(1) };
}

// Stand-ins for the demo: they look like codes but do not scan.
function sampleBars(content) {
  let s = "11010010000";
  for (const ch of String(content)) s += ((ch.charCodeAt(0) * 2654435761) >>> 0).toString(2).padStart(32, "0").slice(0, 11);
  return `${s}1100011101011`;
}
function sampleMatrix(content, n) {
  let seed = [...String(content)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const rows = Array.from({ length: n }, () => Array.from({ length: n }, () => (rnd() > 0.5 ? 1 : 0)));
  const finder = (ox, oy) => {
    for (let y = -1; y < 8; y++) for (let x = -1; x < 8; x++) {
      const X = ox + x, Y = oy + y;
      if (X < 0 || Y < 0 || X >= n || Y >= n) continue;
      const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
      rows[Y][X] = x < 0 || y < 0 || x > 6 || y > 6 ? 0 : ring === 3 || ring <= 1 ? 1 : 0;
    }
  };
  finder(0, 0);
  if (n > 13) { finder(n - 7, 0); finder(0, n - 7); }
  return rows.map((r) => r.join(""));
}
