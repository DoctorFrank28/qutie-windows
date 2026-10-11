"use strict";
/* global T */

const STEPS = ["prepare", "search", "connect", "printer", "done"];
const $ = (sel) => document.querySelector(sel);
const content = $("#content");
const btnNext = $("#next");
const btnBack = $("#back");
const btnSecondary = $("#secondary");

const state = { step: null, mode: "install", devices: [], chosen: null, port: null, busy: false };
// What the footer buttons do in the current view.
let actions = {};

// pywebview exposes the Python API when it is ready; in a plain browser we use fake data.
const ready = new Promise((resolve) => {
  if (window.pywebview?.api) return resolve(window.pywebview.api);
  window.addEventListener("pywebviewready", () => resolve(window.pywebview.api));
  setTimeout(() => { if (!window.pywebview) resolve(fakeApi()); }, 1500);
});
const api = async (name, ...args) => (await ready)[name](...args);

const ICONS = {
  ok: '<svg class="icon ok" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  error: '<svg class="icon error" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m15 9-6 6M9 9l6 6"/></svg>',
  wait: '<svg class="icon wait spin" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>',
  dot: '<svg class="icon wait" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/></svg>',
  info: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
};

const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// `text` may contain the trusted markup of the translations; `detail` is always escaped.
const row = (icon, text, detail = "") =>
  `<li>${ICONS[icon]}<div><div>${text}</div>${detail ? `<div class="hint">${esc(detail)}</div>` : ""}</div></li>`;

const list = (rows) => `<ul class="list">${rows.join("")}</ul>`;

function alertBox(kind, title, text, log) {
  return `<div class="alert ${kind}">${ICONS[kind === "error" ? "error" : "info"]}<div>
    <p class="alert-title">${esc(title)}</p>${text ? `<p class="alert-text">${esc(text)}</p>` : ""}
    ${log ? `<details><summary>${T.details}</summary><pre class="log">${esc(log)}</pre></details>` : ""}
  </div></div>`;
}

/** Set the footer: labels, enabled state and handlers. */
function footer({ next = null, back = null, secondary = null }) {
  actions = { next: next?.run, back: back?.run, secondary: secondary?.run };
  for (const [btn, spec] of [[btnNext, next], [btnBack, back], [btnSecondary, secondary]]) {
    btn.hidden = !spec;
    if (spec) {
      btn.textContent = spec.label;
      btn.disabled = state.busy || spec.enabled === false;
    }
  }
}

async function busy(fn) {
  state.busy = true;
  for (const b of [btnNext, btnBack, btnSecondary]) b.disabled = true;
  try { return await fn(); } finally { state.busy = false; }
}

function go(step) {
  state.step = step;
  const i = STEPS.indexOf(step);
  $("#steps").hidden = i < 0;
  document.querySelectorAll("#steps li").forEach((li, j) => {
    li.dataset.state = j < i ? "done" : j === i ? "active" : "";
    if (j === i) li.setAttribute("aria-current", "step"); else li.removeAttribute("aria-current");
  });
  VIEWS[step]();
}

const close = { label: T.close, run: () => api("close") };

// ------------------------------------------------------------------- views
const VIEWS = {
  async start() {
    content.innerHTML = list([row("wait", T.checkingInstall)]);
    footer({});
    state.installed = await api("printer");
    go(state.installed ? "installed" : "prepare");
  },

  installed() {
    const p = state.installed;
    const port = esc(String(p.PortName || "").replace(/:$/, ""));
    content.innerHTML = `<h2>${T.installedTitle}</h2>
      <p class="description">${T.installedDesc(esc(p.Name), port)}</p>
      ${list([row("ok", T.installedPrinter, p.Name), row("ok", T.installedDriver, p.DriverName), row("ok", T.installedPort, port)])}
      <p class="description flat">${T.installedHint}</p>
      <div class="actions">
        <button class="outline" type="button" id="open-settings">${T.settings}</button>
        <button class="outline" type="button" id="reinstall">${T.reinstall}</button>
        <button class="outline danger" type="button" id="remove">${T.uninstall}</button>
      </div>`;
    $("#open-settings").addEventListener("click", () => api("open_app"));
    $("#reinstall").addEventListener("click", () => go("prepare"));
    $("#remove").addEventListener("click", () => go("uninstall"));
    footer({ next: close, secondary: { label: T.testPage, run: () => testPrint("test_windows") } });
  },

  prepare() {
    content.innerHTML = `<h2>${T.prepareTitle}</h2><p class="description">${T.prepareDesc}</p>
      ${list(T.prepare.map((t) => row("dot", t)))}`;
    footer({
      next: { label: T.findPrinter, run: () => go("search") },
      back: state.installed ? { label: T.back, run: () => go("installed") } : null,
    });
  },

  async search() {
    const title = `<h2>${T.searchTitle}</h2>`;
    const back = { label: T.back, run: () => go("prepare") };
    const again = { label: T.searchAgain, run: () => go("search") };
    const next = { label: T.pairContinue, run: () => go("connect") };
    content.innerHTML = title + list([row("wait", T.searching, T.searchingHint)]);
    footer({ next: { ...next, enabled: false }, back, secondary: again });

    let found;
    try {
      found = await busy(() => api("scan"));
    } catch (e) {
      content.innerHTML = title + alertBox("error", T.scanFailed, String(e));
      return footer({ next: { ...next, enabled: false }, back, secondary: again });
    }
    if (state.step !== "search") return;
    state.devices = found;
    const qutie = found.filter((d) => d.qutie);
    const others = found.filter((d) => !d.qutie);
    if (!found.some((d) => d.mac === state.chosen)) state.chosen = qutie[0]?.mac ?? null;

    const item = (d) => `
      <label class="choice">
        <input type="radio" name="device" value="${esc(d.mac)}" ${d.mac === state.chosen ? "checked" : ""}>
        <span class="texts"><span class="name">${esc(d.name || T.noName)}</span><span class="hint mono">${esc(d.mac)}</span></span>
        ${d.paired ? `<span class="badge">${T.badgePaired}</span>` : ""}
        ${d.qutie ? '<span class="badge solid">Qutie</span>' : ""}
      </label>`;

    content.innerHTML = title + (qutie.length
      ? `<p class="description">${qutie.length === 1 ? T.foundOne : T.foundMany}</p>
         <div class="choices" role="radiogroup">${qutie.map(item).join("")}</div>`
      : alertBox("error", T.noneTitle, T.noneText))
      + (others.length ? `<details><summary>${T.others(others.length)}</summary>
         <div class="choices" role="radiogroup" style="margin-top:12px">${others.map(item).join("")}</div></details>` : "");
    content.querySelectorAll('input[name="device"]').forEach((r) =>
      r.addEventListener("change", () => { state.chosen = r.value; btnNext.disabled = false; }));
    footer({ next: { ...next, enabled: !!state.chosen }, back, secondary: again });
  },

  async connect() {
    const device = state.devices.find((d) => d.mac === state.chosen);
    const title = `<h2>${esc(T.connectTitle(device?.name || state.chosen))}</h2>`;
    const back = { label: T.back, run: () => go("search") };
    const retry = { label: T.retry, run: () => go("connect") };
    const show = (rows, extra = "") => { content.innerHTML = title + list(rows) + extra; };

    footer({ next: { label: T.next, enabled: false }, back });
    show([row("wait", device?.paired ? T.checkingPaired : T.pairing)]);
    const paired = await busy(() => api("pair", state.chosen));
    if (!paired.ok) {
      show([row("error", T.pairFailed, paired.detail)], alertBox("error", T.pairFailedTitle, T.pairFailedText));
      return footer({ next: retry, back });
    }
    show([row("ok", T.paired), row("wait", T.waitingPort, T.waitingPortHint)]);
    const port = await busy(() => api("port", state.chosen));
    if (!port) {
      show([row("ok", T.paired), row("error", T.portMissing)], alertBox("error", T.portMissingTitle, T.portMissingText));
      return footer({ next: retry, back });
    }
    state.port = port;
    show([row("ok", T.paired), row("ok", esc(T.portOk(port)))], `<p class="description flat">${T.testHint}</p>`);
    footer({
      next: { label: T.next, run: () => go("printer") },
      back,
      secondary: { label: T.testLabel, run: () => testPrint("test_direct", state.port, state.chosen) },
    });
  },

  async printer() {
    const title = `<h2>${T.printerTitle}</h2>`;
    const back = { label: T.back, run: () => go("connect") };
    footer({ next: { label: T.install, enabled: false }, back });
    content.innerHTML = title + list([row("wait", T.checkingPrinters)]);
    const existing = await busy(() => api("printer"));
    const alreadyOk = existing && existing.PortName === `${state.port}:`;
    const port = esc(state.port);
    content.innerHTML = title
      + `<p class="description">${alreadyOk ? T.alreadyInstalled(esc(existing.Name), port) : T.willCreate(port)}</p>`
      + list([row("dot", T.adminNote), row("dot", T.certNote)]);
    const install = { label: alreadyOk ? T.reinstall : T.install, run: installDriver };
    footer(alreadyOk
      ? { next: { label: T.next, run: () => go("done") }, back, secondary: install }
      : { next: install, back });
  },

  done() {
    content.innerHTML = `<h2>${T.doneTitle}</h2><p class="description">${T.doneDesc}</p>
      ${list(T.done.map((t) => row("ok", t)))}
      <div class="actions"><button class="outline" type="button" id="open-settings">${T.settings}</button></div>`;
    $("#open-settings").addEventListener("click", () => api("open_app"));
    footer({ next: close, secondary: { label: T.testPage, run: () => testPrint("test_windows") } });
  },

  uninstall() {
    content.innerHTML = `<h2>${T.uninstallTitle}</h2><p class="description">${T.uninstallDesc}</p>
      ${list(T.uninstallItems.map((t) => row("dot", t)))}
      <label class="choice">
        <input type="checkbox" id="remove-pairing" class="check">
        <span class="texts"><span class="name">${T.removePairing}</span><span class="hint">${T.removePairingHint}</span></span>
      </label>`;
    const cancel = state.mode === "uninstall"
      ? { label: T.cancel, run: () => api("close") }
      : { label: T.cancel, run: () => go(state.installed ? "installed" : "prepare") };
    footer({ next: { label: T.uninstall, run: uninstall }, secondary: cancel });
  },

  uninstalled() {
    content.innerHTML = `<h2>${T.uninstalledTitle}</h2>${list([row("ok", T.uninstalled)])}
      ${state.log ? `<details><summary>${T.details}</summary><pre class="log">${esc(state.log)}</pre></details>` : ""}`;
    footer({ next: close });
  },
};

// ------------------------------------------------------------------- actions
async function installDriver() {
  const title = `<h2>${T.printerTitle}</h2>`;
  content.innerHTML = title + list([row("wait", T.installing, T.confirmUac)]);
  footer({ next: { label: T.install, enabled: false } });
  const result = await busy(() => api("install", state.port));
  if (result.ok) {
    state.installed = await api("printer");
    return go("done");
  }
  const text = result.cancelled ? T.uacDeclined : result.detail;
  content.innerHTML = title + alertBox("error", T.installFailed, text, result.log);
  footer({ next: { label: T.retry, run: installDriver }, back: { label: T.back, run: () => go("connect") } });
}

async function uninstall() {
  const removePairing = !!$("#remove-pairing")?.checked;
  const title = `<h2>${T.uninstallTitle}</h2>`;
  content.innerHTML = title + list([row("wait", T.uninstalling, T.confirmUac)]);
  footer({ next: { label: T.uninstall, enabled: false } });
  const result = await busy(() => api("uninstall", removePairing));
  state.log = result.log;
  if (result.ok) {
    state.installed = null;
    return go("uninstalled");
  }
  const text = result.cancelled ? T.uacDeclined : result.detail;
  content.innerHTML = title + alertBox("error", T.uninstallFailed, text, result.log);
  footer({ next: { label: T.retry, run: () => go("uninstall") }, secondary: { label: T.cancel, run: () => api("close") } });
}

async function testPrint(method, ...args) {
  const label = btnSecondary.textContent;
  btnSecondary.textContent = T.printing;
  const result = await busy(() => api(method, ...args));
  btnSecondary.textContent = result.ok ? T.sent : T.failed;
  btnSecondary.title = result.detail || "";
  for (const b of [btnNext, btnBack, btnSecondary]) b.disabled = false;
  setTimeout(() => { btnSecondary.textContent = label; }, 2500);
}

btnNext.addEventListener("click", () => actions.next?.());
btnBack.addEventListener("click", () => actions.back?.());
btnSecondary.addEventListener("click", () => actions.secondary?.());

// ------------------------------------------------------------------- start
$("#title").textContent = T.title;
$("#subtitle").textContent = T.subtitle;
document.title = T.title;
$("#steps").innerHTML = T.steps.map((s) => `<li>${esc(s)}</li>`).join("");
$("#steps").setAttribute("aria-label", T.steps.join(" › "));

api("mode").then((mode) => {
  state.mode = mode;
  go(mode === "uninstall" ? "uninstall" : "start");
});

// Fake data, to open the page in a browser during development (?uninstall, ?lang=xx).
function fakeApi() {
  const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  return {
    mode: () => later(10, new URLSearchParams(location.search).has("uninstall") ? "uninstall" : "install"),
    scan: () => later(800, [
      { name: "Qutie-1234", mac: "02:3C:00:00:12:34", paired: true, qutie: true },
      { name: "Phone", mac: "AA:BB:CC:DD:EE:FF", paired: true, qutie: false },
    ]),
    pair: () => later(500, { ok: true }),
    port: () => later(500, "COM5"),
    printer: () => later(300, new URLSearchParams(location.search).has("installed")
      ? { Name: "Qutie", DriverName: "HPRT Qutie", PortName: "COM5:" } : null),
    install: () => later(800, { ok: true }),
    uninstall: () => later(800, { ok: true, log: "> Removing the printer\n  printer 'Qutie' removed" }),
    open_app: () => {},
    test_direct: () => later(500, { ok: true }),
    test_windows: () => later(500, { ok: true }),
    close: () => {},
  };
}
