"use strict";
/* global T */

const $ = (sel, root = document) => root.querySelector(sel);
const panel = $("#panel");
const SECTIONS = ["status", "paper", "quality", "device", "app", "about"];
const state = { section: "status", overview: null, device: null };

const ready = new Promise((resolve) => {
  if (window.pywebview?.api) return resolve(window.pywebview.api);
  window.addEventListener("pywebviewready", () => resolve(window.pywebview.api));
  setTimeout(() => { if (!window.pywebview) resolve(fakeApi()); }, 1500);
});
const api = async (name, ...args) => (await ready)[name](...args);
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Options of the driver (QUTIE.GPD), as they appear in the Windows print ticket.
const SIZES = [["Q12X30", "12 × 30 mm"], ["Q12X40", "12 × 40 mm"], ["Q12X50", "12 × 50 mm"], ["Q12X70", "12 × 70 mm"], ["Q12X100", "12 × 100 mm"], ["FIT_A5", T.fitToTape]];
const FEEDS = [0, 5, 10, 15, 20, 25];
const MARGINS = [0, 1, 2, 3, 5, 8, 10];

let toastTimer;
function toast(text, kind = "") {
  const el = $("#toast");
  el.textContent = text;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

/** Run an action from a button, showing progress on it and the outcome in a toast. */
async function act(button, fn, okText = T.saved) {
  const label = button.textContent;
  button.disabled = true;
  const result = await fn();
  button.disabled = false;
  button.textContent = label;
  if (result?.ok === false) toast(`${T.failed}: ${result.detail || ""}`, "error");
  else if (okText) toast(okText);
  return result;
}

// ------------------------------------------------------------------ building blocks
const section = (title, desc, body) =>
  `<header class="panel-head"><h2>${title}</h2>${desc ? `<p class="description flat">${desc}</p>` : ""}</header>${body}`;
const card = (body, title = "") => `<section class="card-box">${title ? `<h3>${title}</h3>` : ""}${body}</section>`;
const row = (label, control, hint = "", id = "") =>
  `<div class="setting"><div class="setting-text"><label ${id ? `for="${id}"` : ""}>${label}</label>${hint ? `<p class="hint">${hint}</p>` : ""}</div><div class="setting-control">${control}</div></div>`;
const select = (id, options, value) =>
  `<select id="${id}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
const segmented = (id, options, value) =>
  `<div class="segmented" role="radiogroup" id="${id}">${options.map(([v, l]) =>
    `<button type="button" role="radio" aria-checked="${v === value}" data-value="${esc(v)}">${esc(l)}</button>`).join("")}</div>`;
const toggle = (id, on) => `<button type="button" class="switch" role="switch" id="${id}" aria-checked="${!!on}"><span></span></button>`;
const facts = (pairs) => `<dl class="facts">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;

function onSegmented(id, fn) {
  const group = $(`#${id}`);
  group?.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-value]");
    if (!b) return;
    group.querySelectorAll("button").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    fn(b.dataset.value);
  });
}
function onToggle(id, fn) {
  const el = $(`#${id}`);
  el?.addEventListener("click", () => {
    const on = el.getAttribute("aria-checked") !== "true";
    el.setAttribute("aria-checked", String(on));
    fn(on);
  });
}

async function device(force = false) {
  if (!state.device || force) state.device = await api("read_device");
  return state.device;
}

async function setDefault(feature, value) {
  const result = await api("set_defaults", { [feature]: value });
  if (result.ok) {
    state.overview.defaults = result.defaults;
    toast(T.saved);
  } else toast(`${T.failed}: ${result.detail || ""}`, "error");
}

/** Card shown when the printer cannot be read, with the likely fix and a retry button. */
function failCard(d) {
  const text = d.reason === "no_reply" ? T.noReplyText : T.readFailedText;
  return card(`<p class="alert-title">${T.readFailed}</p><p class="hint">${text}</p>
    <div class="actions"><button class="outline" type="button" data-retry>${T.retry}</button></div>`);
}
function onRetry(view) {
  panel.querySelector("[data-retry]")?.addEventListener("click", () => { state.device = null; VIEWS[view](); });
}

// ------------------------------------------------------------------ sections
const VIEWS = {
  async status() {
    panel.innerHTML = section(T.navStatus, "", card(`<ul class="list"><li><svg class="icon wait spin" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>${T.reading}</li></ul>`));
    const d = await device();
    if (state.section !== "status") return;
    const badge = d.ok ? `<span class="badge ok-badge">${T.stConnected}</span>` : `<span class="badge err-badge">${T.stUnreachable}</span>`;
    const battery = d.ok ? `<div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${d.status.battery}" aria-label="${T.battery}"><span style="width:${Math.min(100, d.status.battery)}%"></span></div><span class="mono">${d.status.battery}%</span>` : "—";
    panel.innerHTML = section(T.navStatus, "",
      card(`<div class="printer-head"><img src="icon.svg" alt="" width="48" height="48"><div><strong>${esc(state.overview.printer?.Name || "Qutie")}</strong>
        <span class="hint">${esc(d.ok ? d.info.model : (d.reason === "no_reply" ? T.noReplyText : T.readFailedText))}</span></div>${badge}</div>
        ${d.ok ? facts([
          [T.battery, `<div class="battery">${battery}</div>`],
          [T.model, esc(d.info.model)],
          [T.serial, `<span class="mono">${esc(d.info.serial)}</span>`],
          [T.firmware, `<span class="mono">${esc(d.info.firmware)} · BT ${esc(d.info.bt_firmware)}</span>`],
          // The Qutie reports 0 with a continuous roll loaded.
          [T.paper, d.status.paper_type === 0 ? T.continuous : esc(T.paperType(d.status.paper_type))],
        ]) : `<p class="hint">${esc(d.detail || "")}</p>`}`)
      + card(`<div class="actions">
          <button class="primary" id="test-label" type="button">${T.testLabel}</button>
          <button class="outline" id="test-page" type="button">${T.testPage}</button>
          <button class="outline" id="feed" type="button">${T.feedPaper}</button>
          <button class="ghost" id="reload" type="button">${T.readAgain}</button></div>
          <p class="hint">${T.testsHint}</p>`, T.tests));
    $("#test-label").addEventListener("click", (e) => act(e.currentTarget, () => api("test_label"), T.sent));
    $("#test-page").addEventListener("click", (e) => act(e.currentTarget, () => api("test_windows"), T.sent));
    $("#feed").addEventListener("click", (e) => act(e.currentTarget, () => api("feed"), T.sent));
    $("#reload").addEventListener("click", async () => { state.device = null; VIEWS.status(); });
  },

  paper() {
    const d = state.overview.defaults;
    // Windows prefixes the driver's features by scope (PageMediaType, PageTapeFeed…).
    const key = (name) => Object.keys(d).find((k) => k === name || k.endsWith(name));
    const mediaKey = key("MediaType");
    const feedKey = key("TapeFeed");
    const old = !mediaKey || !feedKey;
    panel.innerHTML = section(T.navPaper, T.paperDesc,
      card(
        row(T.size, select("size", [...SIZES, ...(SIZES.some(([v]) => v === d.PageMediaSize) ? [] : [[d.PageMediaSize || "", T.custom]])], d.PageMediaSize), "", "size")
        + row(T.orientation, segmented("orientation", [["Landscape", T.landscape], ["Portrait", T.portrait]], d.PageOrientation), T.orientationHint)
        + (old ? "" : row(T.mediaType, segmented("media", [["GAP", T.gap], ["CONTINUOUS", T.continuous]], d[mediaKey]))
          + row(T.tapeFeed, select("tape-feed", FEEDS.map((mm) => [`F${mm}`, `${mm} mm`]), d[feedKey]), T.tapeFeedHint, "tape-feed"))
        + row(T.trimMargin, select("trim-margin", MARGINS.map((mm) => [mm, `${mm} mm`]), state.overview.margin_mm), T.trimMarginHint, "trim-margin")
        + row(T.sameHeight, toggle("same-height", state.overview.same_height), T.sameHeightHint))
      + (old ? card(`<p class="hint">${T.driverOld}</p>`) : "")
      + card(`<div class="actions"><button class="outline" id="win-preferences" type="button">${T.printingPreferences}</button>
          <button class="outline" id="win-properties" type="button">${T.printerProperties}</button></div>`, T.windowsDialogs));
    $("#size").addEventListener("change", (e) => setDefault("PageMediaSize", e.target.value));
    onSegmented("orientation", (v) => setDefault("PageOrientation", v));
    onSegmented("media", (v) => setDefault(mediaKey, v));
    $("#tape-feed")?.addEventListener("change", (e) => setDefault(feedKey, e.target.value));
    onToggle("same-height", (on) => { state.overview.same_height = on; api("set_same_height", on); toast(T.saved); });
    $("#trim-margin").addEventListener("change", (e) => {
      state.overview.margin_mm = Number(e.target.value);
      api("set_margin", state.overview.margin_mm);
      toast(T.saved);
    });
    $("#win-preferences").addEventListener("click", () => api("open_windows", "preferences"));
    $("#win-properties").addEventListener("click", () => api("open_windows", "properties"));
  },

  async quality() {
    panel.innerHTML = section(T.navQuality, T.qualityDesc, card(`<p class="hint">${T.reading}</p>`));
    const d = await device();
    if (state.section !== "quality") return;
    if (!d.ok) {
      panel.innerHTML = section(T.navQuality, T.qualityDesc, failCard(d));
      return onRetry("quality");
    }
    const [low, high] = d.density_range;
    const value = Math.max(low, Math.min(high, d.status.density));
    panel.innerHTML = section(T.navQuality, T.qualityDesc, card(
      `<div class="field">
        <div class="field-row"><label for="density">${T.density}</label><span class="mono" id="density-value">${value}</span></div>
        <input type="range" id="density" min="${low}" max="${high}" step="5" value="${value}">
        <div class="field-row hint"><span>${T.lighter}</span><span>${T.darker}</span></div>
        <p class="hint">${T.densityHint}</p>
      </div>
      <div class="actions"><button class="primary" id="apply-density" type="button">${T.apply}</button></div>`));
    $("#density").addEventListener("input", (e) => { $("#density-value").textContent = e.target.value; });
    $("#apply-density").addEventListener("click", (e) => act(e.currentTarget, async () => {
      const r = await api("apply_device", Number($("#density").value), null);
      if (r.ok) state.device.status = r.status;
      return r;
    }));
  },

  async device() {
    panel.innerHTML = section(T.navDevice, "", card(`<p class="hint">${T.reading}</p>`));
    const d = await device();
    if (state.section !== "device") return;
    const bt = card(facts([
      [T.address, `<span class="mono">${esc(d.ok ? d.mac : "—")}</span>`],
      [T.port, `<span class="mono">${esc((d.ok && d.com_port) || "—")}</span>`],
    ]) + `<div class="actions"><button class="outline" id="repair" type="button">${T.repair}</button></div>`, "Bluetooth");
    if (!d.ok) {
      panel.innerHTML = section(T.navDevice, "", failCard(d) + bt);
      onRetry("device");
    } else {
      panel.innerHTML = section(T.navDevice, "",
        card(row(T.autoOff, select("auto-off", d.auto_off_choices.map((m) => [m, T.minutes(m)]), d.status.auto_off_min), T.autoOffHint, "auto-off"), T.power) + bt);
      $("#auto-off").addEventListener("change", async (e) => {
        const r = await api("apply_device", null, Number(e.target.value));
        if (r.ok) { state.device.status = r.status; toast(T.saved); } else toast(`${T.failed}: ${r.detail || ""}`, "error");
      });
    }
    $("#repair").addEventListener("click", () => api("open_setup", "install"));
  },

  app() {
    const o = state.overview;
    panel.innerHTML = section(T.navApp, "", card(
      row(T.previewSwitch, toggle("preview", o.preview), T.previewHint)
      + row(T.autostart, toggle("autostart", o.autostart), T.autostartHint)));
    onToggle("preview", (on) => { o.preview = on; api("set_preview", on); toast(T.saved); });
    onToggle("autostart", (on) => { o.autostart = on; api("set_autostart", on); toast(T.saved); });
  },

  about() {
    const o = state.overview;
    panel.innerHTML = section(T.navAbout, "",
      card(facts([
        [T.version, `<span class="mono">${esc(o.version)}</span>`],
        [T.driver, esc(o.printer?.DriverName || "—")],
        [T.printerName, esc(o.printer?.Name || "—")],
      ]) + `<p class="hint">${T.aboutText}</p>`)
      + card(`<div class="setting"><div class="setting-text"><label>${T.updates}</label><p class="hint" id="update-status" aria-live="polite">${T.updatesHint}</p></div>
          <div class="setting-control"><button class="outline" id="check-updates" type="button">${T.checkUpdates}</button></div></div>
          <div class="actions"><button class="ghost" id="report-problem" type="button">${T.reportProblem}</button>
          <button class="ghost" id="source-code" type="button">${T.sourceCode}</button></div>`)
      + card(`<div class="setting"><div class="setting-text"><label>${T.uninstallApp}</label><p class="hint">${T.uninstallHint}</p></div>
          <div class="setting-control"><button class="outline danger" id="uninstall" type="button">${T.uninstall}</button></div></div>`));
    $("#uninstall").addEventListener("click", () => api("open_setup", "uninstall"));
    $("#report-problem").addEventListener("click", () => api("open_page", "issues"));
    $("#source-code").addEventListener("click", () => api("open_page", "repository"));
    const check = $("#check-updates"), status = $("#update-status");
    check.addEventListener("click", async () => {
      if (check.dataset.download) { api("open_page", "releases"); return; }
      check.disabled = true;
      status.textContent = T.checkingUpdates;
      const r = await api("check_updates").catch((e) => ({ ok: false, detail: String(e) }));
      check.disabled = false;
      if (!r.ok) status.textContent = `${T.updateCheckFailed}: ${r.detail || ""}`;
      else if (!r.newer) status.textContent = T.upToDate(r.current);
      else {
        // A newer release: the same button now opens its download page.
        status.textContent = T.updateAvailable(r.latest);
        check.textContent = T.download;
        check.className = "primary";
        check.dataset.download = "1";
      }
    });
  },
};

function go(name) {
  if (!VIEWS[name] || !state.overview) return;
  state.section = name;
  document.querySelectorAll("#nav button").forEach((b) => {
    const active = b.dataset.section === name;
    b.classList.toggle("active", active);
    if (active) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  });
  VIEWS[name]();
}

// ------------------------------------------------------------------ start
const NAV = { status: T.navStatus, paper: T.navPaper, quality: T.navQuality, device: T.navDevice, app: T.navApp, about: T.navAbout };
$("#nav").innerHTML = SECTIONS.map((s) => `<li><button type="button" data-section="${s}">${NAV[s]}</button></li>`).join("");
$("#nav").addEventListener("click", (e) => { const b = e.target.closest("button[data-section]"); if (b) go(b.dataset.section); });
$("#brand-sub").textContent = T.brandSub;
document.title = "Qutie";
document.addEventListener("keydown", (e) => { if (e.key === "Escape") api("close"); });

api("overview").then((o) => {
  state.overview = o;
  go(SECTIONS.includes(o.section) ? o.section : "status");
});

function fakeApi() {
  const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  const defaults = { PageMediaSize: "Q12X40", PageOrientation: "Landscape", PageMediaType: "GAP", PageTapeFeed: "F10", DocumentPrintDensity: "KEEP" };
  return {
    set_margin: () => {},
    set_same_height: () => {},
    overview: () => later(100, { margin_mm: 2, same_height: true, version: "1.0.0", printer: { Name: "Qutie", DriverName: "HPRT Qutie", PortName: "C:\\ProgramData\\Qutie\\spool\\job.prn" }, defaults, preview: true, autostart: true }),
    read_device: () => later(600, { ok: true, mac: "02:3C:00:00:12:34", com_port: "COM5", info: { model: "Qutie", serial: "QUTIEGL000000000", firmware: "1.1.20", bt_firmware: "V4110" }, status: { battery: 44, density: 95, auto_off_min: 15, paper_type: 0 }, density_range: [50, 100], auto_off_choices: [10, 15, 30, 60, 180, 240] }),
    apply_device: () => later(400, { ok: true, status: { battery: 44, density: 95, auto_off_min: 15, paper_type: 0 } }),
    set_defaults: (c) => later(300, { ok: true, defaults: Object.assign(defaults, c) }),
    feed: () => later(300, { ok: true }), test_label: () => later(500, { ok: true }), test_windows: () => later(500, { ok: true }),
    set_preview: () => {}, set_autostart: () => {}, open_windows: () => {}, open_setup: () => {}, close: () => {},
    check_updates: () => later(800, { ok: true, current: "1.0.0", latest: "1.2.0", newer: true }), open_page: () => {},
  };
}
