"use strict";
/* Quick print, from the tray icon or Win+Shift+Q: type, Enter, printed. The Studio does
 * not open; "Open in the Studio" takes the text into the editor.
 */

const Quick = {
  text: "",
  length: "40",
  copies: 1,
  busy: false,

  async boot() {
    let state = {};
    try { state = await api("state"); } catch { /* the stand-in */ }
    const config = state.config || {};
    if (config.theme === "light" || config.theme === "dark") document.documentElement.dataset.theme = config.theme;
    this.length = config.quick_length || "40";
    document.documentElement.lang = LANG;
    document.title = T.quickPrint;
    this.build();
    this.printer();
  },

  build() {
    const root = $("#quick");
    this.chip = h("span.chip", { role: "status", translate: "no" }, ico("bluetooth", 12), "Qutie");
    this.input = h("textarea.quick-input", { rows: 2, name: "text", autocomplete: "off", placeholder: T.quickPlaceholderShort, "aria-label": T.quickPrint, spellcheck: "false" });
    this.preview = h("div.quick-prev", { "aria-hidden": "true" });
    this.input.addEventListener("input", () => { this.text = this.input.value; this.draw(); });
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); this.print(); }
      if (e.key === "Escape") api("close", true);
    });
    const lengths = seg([{ value: "30", label: "30" }, { value: "40", label: "40" }, { value: "50", label: "50" }, { value: "auto", label: T.auto }], this.length,
      (v) => { this.length = v; api("set_config", { quick_length: v }).catch(() => {}); this.draw(); }, { small: true, label: T.length });
    const copies = numInput({ value: 1, decimals: 0, step: 1, min: 1, max: 99, label: T.copies, width: "64px", onChange: (v) => { this.copies = v; } });
    const add = (text) => () => {
      const pos = this.input.selectionStart ?? this.input.value.length;
      this.input.value = this.input.value.slice(0, pos) + text + this.input.value.slice(pos);
      this.text = this.input.value;
      this.input.focus();
      this.draw();
    };
    this.printBtn = button(T.printEnter, { variant: "primary", size: "sm", icon: "printer", onClick: () => this.print() });
    append(root,
      h("header.quick-head", h("span.logo", { "aria-hidden": "true" }, h("span")), h("h1", T.quickPrint), h("span.spacer"), this.chip),
      h("div.quick-body",
        this.input,
        this.preview,
        h("div.row.between", lengths, h("div.row", h("span.desc", T.copies), copies)),
        h("div.chips",
          chip(T.addToday, { onClick: add(` {${T.varDateWord}}`) }),
          chip("+ ❄", { onClick: add("❄ ") }),
          chip(T.twoLines, { onClick: add("\n") }))),
      h("footer.quick-foot",
        button(T.openInStudio, { variant: "ghost", size: "sm", onClick: () => api("open_in_studio", this.input.value).catch(() => {}) }),
        h("span.spacer"),
        this.printBtn));
    this.draw();
    setTimeout(() => this.input.focus(), 50);
  },

  doc() {
    return quickDocument(this.text.trim() || T.quickSample, this.length);
  },

  draw() {
    const doc = this.doc();
    clear(this.preview).append(thumbCanvas(doc, "quick-canvas"));
    this.preview.classList.toggle("placeholder", !this.text.trim());
  },

  async printer() {
    const r = await api("printer").catch(() => null);
    clear(this.chip).append(ico(r?.ok ? "battery" : "bluetooth", 12), r?.ok ? `Qutie · ${r.battery}%` : T.printerUnreachableShort);
    this.chip.classList.toggle("warn", !r?.ok);
  },

  async print() {
    if (this.busy) return;
    const text = this.input.value.trim();
    if (!text) { this.input.focus(); return; }
    this.busy = true;
    this.printBtn.disabled = true;
    this.printBtn.lastChild.textContent = `${T.printing}…`;
    let r, labels = [];
    try {
      const doc = this.doc();
      const plan = labelPlan(doc, { repeat: this.copies });
      const out = await renderPlan(doc, plan);
      labels = out.map((x) => toPng(x.raster));
      r = await api("print_labels", labels, mediaOf(doc, Math.max(...out.map((x) => x.raster.width / DPMM))), { name: `«${text.split("\n")[0]}»`, source: "quick", tape_mm: Math.round(out.reduce((s, x) => s + x.raster.width / DPMM + labelFeed(doc), 0)) });
    } catch (e) {
      r = { ok: false, detail: String(e) };
    } finally {
      this.busy = false;
      this.printBtn.disabled = false;
      this.printBtn.lastChild.textContent = T.printEnter;
    }
    if (r.ok) {
      toast(T.nPrinted(labels.length), { kind: "ok" });
      this.input.value = "";
      this.text = "";
      this.draw();
      this.input.focus();
    } else toast(T.printerUnreachable, { kind: "error", detail: r.detail });
  },
};

Quick.boot();
