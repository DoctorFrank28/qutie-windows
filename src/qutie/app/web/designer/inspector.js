"use strict";
/* The panel on the right: Properties (or Label when nothing is selected), Layers, Data. */

const TYPE_ICON = { text: "text", rect: "rect", ellipse: "ellipse", line: "line", image: "image", barcode: "barcode", qr: "qr" };
const objIcon = (o) => (o.symbol ? "symbol" : TYPE_ICON[o.type] || "rect");

/** Lengths in the unit chosen in Settings (mm, inches or printer dots). */
const Units = {
  get unit() { return Studio.config.units || "mm"; },
  label() { return this.unit === "in" ? "in" : this.unit === "dots" ? T.dotsShort : "mm"; },
  to(mm) { return this.unit === "in" ? mm / 25.4 : this.unit === "dots" ? mm * DPMM : mm; },
  from(v) { return this.unit === "in" ? v * 25.4 : this.unit === "dots" ? v / DPMM : v; },
  decimals() { return this.unit === "in" ? 3 : this.unit === "dots" ? 0 : 2; },
  step() { return this.unit === "in" ? 0.01 : this.unit === "dots" ? 1 : 0.1; },
};

function lenInput(lead, mm, onChange, { label, min = -1000, max = 1000 } = {}) {
  return numInput({
    lead, value: Units.to(mm), unit: Units.label(), decimals: Units.decimals(), step: Units.step(),
    min: Units.to(min), max: Units.to(max), label, onChange: (v) => onChange(round3(Units.from(v))),
  });
}

/**
 * Rebuild part of the interface without losing the keyboard focus. The control that had it
 * is found again at the same place in the tree with the same kind, value and name; else as
 * the nth control with that kind, value and name; else at the same place (a toggle that
 * changed its name); else `fallback` (an element, or a function that returns one).
 */
function keepFocus(root, rebuild, fallback = null) {
  const active = document.activeElement;
  if (!active || active === root || !root.contains(active)) { rebuild(); return; }
  const FOCUSABLE = "button,input,select,textarea,[tabindex]";
  const key = (el) => [el.tagName, el.getAttribute("role"), el.dataset.value ?? el.dataset.layer, el.getAttribute("aria-label") || el.textContent.trim(),
    el.parentElement?.closest("[aria-label]")?.getAttribute("aria-label")].join("|");
  const k = key(active);
  const before = $$(FOCUSABLE, root).filter((x) => key(x) === k);
  const path = [];
  for (let x = active; x !== root; x = x.parentElement) path.unshift([...x.parentElement.children].indexOf(x));
  rebuild();
  if (root.contains(document.activeElement)) return;
  const usable = (x) => !!x?.matches?.(FOCUSABLE) && !x.disabled;
  const there = path.reduce((x, i) => x?.children[i], root);
  const same = $$(FOCUSABLE, root).filter((x) => key(x) === k);
  const target = (usable(there) && key(there) === k ? there : null)
    || (same.length === before.length && usable(same[before.indexOf(active)]) ? same[before.indexOf(active)] : null)
    || (usable(there) && there.tagName === active.tagName ? there : null)
    || same.find(usable) || (typeof fallback === "function" ? fallback() : fallback);
  target?.focus({ preventScroll: true });
}

const Inspector = {
  tab: "props",
  root: null,
  dirty: false,
  lastContent: null, // {id, el} of the content field last focused, for inserting fields at the cursor
  folded: {}, // collapsible sections opened or closed by the user, by key: they stay so across rebuilds

  build(root) {
    this.root = root;
    this.tabs = h("div.tabs", { role: "tablist" });
    this.panel = h("div.scroll", { role: "tabpanel", id: "insp-panel" });
    append(root, this.tabs, this.panel);
    // Tabs as in the WAI-ARIA pattern: arrows move between them, only the active one is in the Tab order.
    this.tabs.addEventListener("keydown", (e) => {
      const keys = $$(".tab", this.tabs).map((b) => b.dataset.tab);
      const i = keys.indexOf(this.tab);
      if (i < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const next = e.key === "Home" ? 0 : e.key === "End" ? keys.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length;
      this.show(keys[next]);
      this.tabs.querySelector(".tab.on")?.focus();
    });
    root.addEventListener("pointerdown", () => { this.pointer = true; });
    window.addEventListener("pointerup", () => { if (this.pointer) { this.pointer = false; if (this.dirty) this.refresh(); } });
    root.addEventListener("focusout", () => setTimeout(() => { if (this.dirty && !root.contains(document.activeElement)) this.refresh(); }, 0));
    listeners.selection.push(() => {
      // Another object: the field being edited belongs to the old one.
      if (this.root.contains(document.activeElement) && document.activeElement.matches?.("input,textarea")) document.activeElement.blur();
      this.lastContent = null;
      this.refresh(true);
    });
    listeners.change.push((e) => {
      if (e.structure) this.refresh(true);
      else if (e.doc) this.refresh();
    });
  },

  show(tab, focusSection) {
    this.tab = tab;
    this.refresh(true);
    if (focusSection) setTimeout(() => this.panel.querySelector(`[data-sec="${focusSection}"]`)?.scrollIntoView({ block: "start" }), 0);
  },

  /**
   * Rebuild the panel, unless the user is typing or dragging a slider in it. Buttons and
   * switches redraw at once and keep the focus, so the panel never lags behind a click.
   */
  refresh(force = false) {
    if (!this.root || !S.doc) return;
    const active = document.activeElement;
    const busy = this.pointer || (this.root.contains(active) && !!active.matches?.("input,textarea"));
    if (busy && !force) { this.dirty = true; return; }
    this.dirty = false;
    const scroll = this.panel.scrollTop;
    const onTab = this.tabs.contains(active);
    this.renderTabs();
    if (onTab) this.tabs.querySelector(".tab.on")?.focus();
    const layer = active?.closest?.("[data-layer]")?.dataset.layer; // a layer's own buttons change name when toggled
    keepFocus(this.panel, () => {
      clear(this.panel);
      if (this.tab === "layers") this.layers();
      else if (this.tab === "data") DataUI.panel(this.panel);
      else if (this.tab === "label" || !S.selection.length) this.labelPanel();
      else if (S.selection.length > 1) this.multiPanel();
      else this.objectPanel(selected()[0]);
    }, () => (layer ? this.panel.querySelector(`[data-layer="${CSS.escape(layer)}"]`) : null));
    this.panel.scrollTop = scroll;
  },

  /** Options for a collapsible section that remembers being opened or closed. */
  fold(key, collapsed) {
    return { collapsed: this.folded[key] ?? collapsed, onToggle: (c) => { this.folded[key] = c; } };
  },

  renderTabs() {
    const first = S.selection.length ? "props" : "label";
    if (this.tab === "props" || this.tab === "label") this.tab = first;
    const tabs = [[first, first === "props" ? T.tabProps : T.tabLabel], ["layers", T.tabLayers, S.doc.objects.length], ["data", T.tabData, S.doc.data?.columns.length ? "●" : null]];
    clear(this.tabs);
    for (const [key, label, count] of tabs) {
      const on = this.tab === key;
      const b = h("button.tab", {
        type: "button", role: "tab", id: `insp-tab-${key}`, "aria-selected": String(on), "aria-controls": "insp-panel", tabindex: on ? "0" : "-1", class: on ? "on" : "",
        onclick: () => { this.show(key); this.tabs.querySelector(".tab.on")?.focus(); }, // the tabs are rebuilt: keep the focus on the new one
      }, label, count ? h("small", String(count)) : null);
      b.dataset.tab = key;
      this.tabs.append(b);
    }
    this.panel.setAttribute("aria-labelledby", `insp-tab-${this.tab}`);
  },

  // ---------------------------------------------------------------- one object
  objectPanel(o) {
    const p = this.panel;
    p.append(this.headSection(o));
    p.append(this.positionSection(o));
    if (o.type === "text") p.append(this.textSection(o));
    if (o.type === "rect") p.append(section(T.shape, {}, slider({ label: T.cornerRadius, min: 0, max: 6, step: 0.1, value: o.radius || 0, format: (v) => `${fmtNum(v, 1)}\u00a0mm`, onInput: (v) => setProps({ radius: v }, "radius") })));
    if (o.type === "image") { p.append(this.imageSection(o)); p.append(this.greySection(o)); }
    if (o.type === "barcode") p.append(...CodesUI.barcodeSections(o));
    if (o.type === "qr") p.append(...CodesUI.qrSections(o));
    if (o.type === "text") {
      p.append(this.fillSection(o, "fill", T.fill, { collapsed: true }));
      p.append(this.backgroundSection(o));
    }
    if (o.type === "rect" || o.type === "ellipse") {
      p.append(this.fillSection(o, "fill", T.fill));
      p.append(this.strokeSection(o));
    }
    if (o.type === "line") p.append(this.lineSection(o));
    if (o.type !== "barcode" && o.type !== "qr") p.append(this.ditherSection(o, { collapsed: o.type !== "image" }));
    if (S.doc.data?.columns.length || o.visible?.mode !== "always") p.append(this.visibilitySection(o));
    if (fieldsIn(o.text ?? o.content).length) p.append(this.emptySection(o));
  },

  headSection(o) {
    const name = h("input", { type: "text", value: o.name, "aria-label": T.objectName, spellcheck: "false", autocomplete: "off" });
    name.addEventListener("change", () => setProps({ name: name.value.trim() || defaultName(o) }, null, [o]));
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });
    return h("section.sec", h("div.head",
      h("span.typeic", ico(objIcon(o))),
      h("label.inp", name),
      iconButton(o.hidden ? "eyeOff" : "eye", o.hidden ? T.cmdShow : T.cmdHide, () => setProps({ hidden: !o.hidden }, null, [o]), { size: "xs", pressed: o.hidden }),
      iconButton(o.locked ? "lock" : "unlock", o.locked ? T.cmdUnlock : T.cmdLock, () => setProps({ locked: !o.locked }, null, [o]), { size: "xs", pressed: o.locked }),
      iconButton("copy", T.cmdDuplicate, () => duplicateSelected(), { size: "xs" }),
      iconButton("trash", T.cmdDelete, () => deleteSelected(), { size: "xs", cls: "danger" })));
  },

  positionSection(o) {
    const lock = o.locked;
    const grid = h("div.g2",
      lenInput("X", o.x, (v) => setProps({ x: v }, null, [o]), { label: "X" }),
      lenInput("Y", o.y, (v) => setProps({ y: v }, null, [o]), { label: "Y" }),
      lenInput(T.leadW, o.w, (v) => this.resize(o, v, null), { label: T.width, min: 0.3 }),
      lenInput(T.leadH, o.h, (v) => this.resize(o, null, v), { label: T.height, min: 0.3 }));
    const rot = numInput({ lead: "↻", value: o.rotation || 0, unit: "°", decimals: 0, step: 1, min: -180, max: 180, label: T.rotation, onChange: (v) => setProps({ rotation: v }, null, [o]) });
    rot.style.flex = "1";
    const alignH = toggles([{ value: "left", icon: "alignLeft", title: T.align_left }, { value: "hcenter", icon: "alignHCenter", title: T.align_hcenter }, { value: "right", icon: "alignRight", title: T.align_right }],
      () => false, (v) => align(v), { label: T.align });
    const alignV = toggles([{ value: "top", icon: "alignTop", title: T.align_top }, { value: "vcenter", icon: "alignVCenter", title: T.align_vcenter }, { value: "bottom", icon: "alignBottom", title: T.align_bottom }],
      () => false, (v) => align(v), { label: T.align });
    const el = section(T.position, { summary: h("span.sum", Units.label()) }, grid,
      h("div.row", rot, iconButton("rotate", T.rotateRight, () => rotateBy(90), { variant: "outline" })),
      h("div.row.between", alignH, alignV),
      h("p.desc", T.alignDesc));
    if (lock) el.classList.add("disabled");
    return el;
  },

  /** Width or height changed in the panel: QR codes stay square, images keep their ratio. */
  resize(o, w, hh) {
    const keep = o.type === "qr" || (o.type === "image" && o.fit !== "stretch");
    const ratio = o.w / o.h;
    const changes = {};
    if (w !== null) { changes.w = w; if (keep) changes.h = round3(w / ratio); }
    if (hh !== null) { changes.h = hh; if (keep) changes.w = round3(hh * ratio); }
    setProps(changes, null, [o]);
  },

  // ---------------------------------------------------------------- text
  textSection(o) {
    const area = h("textarea.area", { rows: 2, spellcheck: "false", "aria-label": T.textContent, "data-content": o.id });
    area.value = o.text;
    area.addEventListener("input", () => setProps({ text: area.value }, `text-${o.id}`, [o]));
    const remember = () => { this.lastContent = { id: o.id, el: area }; };
    area.addEventListener("focus", remember);
    area.addEventListener("keyup", remember);
    area.addEventListener("click", remember);
    area.addEventListener("keydown", (e) => { if (e.key === "Escape") { area.blur(); stage.focus(); } });

    const chips = h("div.chips",
      ...VARIABLE_CHOICES().slice(0, 4).map((v) => chip(v.token, { mono: true, title: v.label, onClick: () => this.insertToken(o, area, v.token) })),
      chip(T.dataField, { icon: "braces", onClick: (e) => {
        if (!S.doc.data?.columns.length) { DataUI.connect(); return; }
        showMenu(fieldMenu((f) => this.insertToken(o, area, `«${f}»`)), { anchor: e.currentTarget });
      } }));

    const env = editEnv(S.doc);
    const fitted = o.autoFit ? fittedSize(o, env) : null;
    const size = numInput({
      value: o.autoFit ? null : o.size, unit: "pt", decimals: 0, step: 1, min: 3, max: 400, label: T.fontSize,
      placeholder: o.autoFit ? `${T.auto} · ${fitted ? Math.round(fitted) : "—"}` : "", disabled: o.autoFit,
      onChange: (v) => setProps({ size: v, autoFit: false }, null, [o]),
    });
    size.style.flex = "1";
    const fitSw = sw(o.autoFit, (v) => setProps({ autoFit: v, size: v ? o.size : Math.round(fitted || o.size) }, null, [o]), T.fit);
    fitSw.id = `fit-${o.id}`;
    const fit = h("div.swrow.inline", h("label", { for: fitSw.id }, T.fit), fitSw); // the word toggles the switch too

    const fontBtn = h("button.select.font-btn", { type: "button", "aria-haspopup": "dialog", "aria-label": `${T.font}: ${o.font}`, onclick: (e) => Dialogs.fontPicker(e.currentTarget, o.font, (f) => setProps({ font: f }, null, [o])) },
      h("span", { style: { fontFamily: fontFamily(o.font), fontWeight: o.bold ? 700 : 400 } }, o.font), ico("chevron"));

    const styleToggles = toggles([
      { value: "bold", icon: "bold", title: T.bold }, { value: "italic", icon: "italic", title: T.italic },
      { value: "underline", icon: "underline", title: T.underline }, { value: "strike", icon: "strike", title: T.strike },
    ], (k) => o[k], (k) => setProps({ [k]: !o[k] }, null, [o]), { label: T.style });
    const caseSeg = seg([{ value: "none", label: "Aa", title: T.caseAsTyped }, { value: "upper", label: "AA", title: T.caseUpper }, { value: "lower", label: "aa", title: T.caseLower }],
      o.transform || "none", (v) => setProps({ transform: v }, null, [o]), { label: T.letterCase, small: true });
    $$("button", caseSeg).forEach((b) => b.setAttribute("aria-label", b.title)); // "Aa", "AA", "aa" read badly: use the full name
    const hAlign = toggles([
      { value: "left", icon: "tLeft", title: T.textLeft }, { value: "center", icon: "tCenter", title: T.textCenter },
      { value: "right", icon: "tRight", title: T.textRight }, { value: "justify", icon: "tJustify", title: T.textJustify },
    ], (v) => o.align === v, (v) => setProps({ align: v }, null, [o]), { label: T.textAlign });
    const vAlign = toggles([
      { value: "top", icon: "vTop", title: T.vTop }, { value: "middle", icon: "vMiddle", title: T.vMiddle }, { value: "bottom", icon: "vBottom", title: T.vBottom },
    ], (v) => o.valign === v, (v) => setProps({ valign: v }, null, [o]), { label: T.verticalAlign });

    return section(T.text, { cls: "sec-text" }, area, chips, fontBtn,
      h("div.row", size, fit),
      h("div.row.between", styleToggles, caseSeg),
      h("div.row.between", hAlign, vAlign),
      h("div.g2",
        slider({ label: T.letterSpacing, min: -20, max: 100, step: 1, value: o.spacing || 0, format: (v) => `${v}%`, onInput: (v) => setProps({ spacing: v }, `spacing-${o.id}`, [o]) }),
        slider({ label: T.lineHeight, min: 0.6, max: 2, step: 0.05, value: o.lineHeight || 1.05, format: (v) => fmtNum(v, 2), onInput: (v) => setProps({ lineHeight: v }, `lh-${o.id}`, [o]) })),
      swRow(T.wrap, o.wrap, (v) => setProps({ wrap: v }, null, [o])));
  },

  insertToken(o, area, token) {
    const start = area.selectionStart ?? area.value.length, end = area.selectionEnd ?? start;
    const text = area.value === T.sampleText ? token : area.value.slice(0, start) + token + area.value.slice(end);
    area.value = text;
    setProps({ text }, null, [o]);
    area.focus();
    const pos = text === token ? token.length : start + token.length;
    area.setSelectionRange(pos, pos);
  },

  /** Insert a field or a variable where the cursor was in the content field. */
  insertAtCursor(id, token) {
    const lc = this.lastContent;
    if (!lc || lc.id !== id || !lc.el.isConnected) return false;
    const o = byId(id);
    if (o.type === "text") this.insertToken(o, lc.el, token);
    else {
      const el = lc.el;
      const start = el.selectionStart ?? el.value.length;
      el.value = el.value.slice(0, start) + token + el.value.slice(el.selectionEnd ?? start);
      el.dispatchEvent(new Event("input"));
      el.dispatchEvent(new Event("change"));
    }
    return true;
  },

  /** Show the object's content field and put the cursor in it (double click, Enter). */
  focusContent(id, selectAll = false) {
    if (!S.selection.includes(id)) select(id);
    this.tab = "props";
    this.refresh(true);
    const field = this.panel.querySelector(`[data-content="${id}"]`);
    if (field) {
      field.focus();
      if (selectAll) field.select?.(); else field.setSelectionRange?.(field.value.length, field.value.length);
    }
  },

  renameLayer(id) {
    this.show("layers");
    setTimeout(() => this.panel.querySelector(`[data-layer="${id}"] .nm`)?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })), 0);
  },

  // ---------------------------------------------------------------- fills, strokes, dithering
  fillSection(o, key, title, { collapsed = false } = {}) {
    const f = o[key] || fill("none");
    const set = (changes, k = null) => setProps({ [key]: { ...f, ...changes } }, k, [o]);
    const types = [["none", T.fillNone], ["solid", T.fillSolid], ["grey", T.fillGrey], ["pattern", T.fillPattern], ["gradient", T.fillGradient]];
    const cards = h("div.typecards", { role: "group", "aria-label": title }, ...types.map(([t, label]) => h(`button.typecard${f.type === t ? ".on" : ""}`, {
      type: "button", "aria-pressed": String(f.type === t), onclick: () => set({ type: t, ink: t === "grey" && (f.ink === 100 || f.ink === 0) ? 50 : t === "solid" && f.type === "grey" ? 100 : f.ink }),
    }, h(`span.tx.fill-${t}`), label)));
    const body = [cards];
    if (f.type === "solid") body.push(seg([{ value: 100, label: T.black }, { value: 0, label: T.white }], f.ink >= 50 ? 100 : 0, (v) => set({ ink: v }), { full: true, small: true, label: title }));
    if (f.type === "grey") body.push(slider({ label: T.intensity, min: 0, max: 100, step: 1, value: f.ink, format: (v) => `${v}%`, onInput: (v) => set({ ink: v }, `ink-${o.id}`) }));
    if (f.type === "pattern") {
      body.push(h("div.swatches", { role: "group", "aria-label": T.fillPattern }, ...PATTERNS.map((name) => {
        const c = h("canvas", { width: 40, height: 28 });
        const ctx = c.getContext("2d");
        ctx.fillStyle = ctx.createPattern(patternTile(name, f.scale, f.weight, 100), "repeat");
        ctx.fillRect(0, 0, 40, 28);
        return h(`button.swatch${f.pattern === name ? ".on" : ""}`, { type: "button", title: T[`pattern_${name}`], "aria-label": T[`pattern_${name}`], "aria-pressed": String(f.pattern === name), onclick: () => set({ pattern: name }) }, c);
      })));
      body.push(h("div.g2",
        slider({ label: T.pitch, min: 2, max: 24, step: 1, value: f.scale, format: (v) => T.nDots(v), onInput: (v) => set({ scale: v }, `scale-${o.id}`) }),
        slider({ label: T.thickness, min: 1, max: 8, step: 1, value: f.weight, format: (v) => T.nDots(v), onInput: (v) => set({ weight: v }, `weight-${o.id}`) })));
      body.push(slider({ label: T.intensity, min: 0, max: 100, step: 5, value: f.ink, format: (v) => `${v}%`, onInput: (v) => set({ ink: v }, `ink-${o.id}`) }));
    }
    if (f.type === "gradient") {
      body.push(h("div.g2",
        slider({ label: T.gradFrom, min: 0, max: 100, step: 1, value: f.from, format: (v) => `${v}%`, onInput: (v) => set({ from: v }, `from-${o.id}`) }),
        slider({ label: T.gradTo, min: 0, max: 100, step: 1, value: f.to, format: (v) => `${v}%`, onInput: (v) => set({ to: v }, `to-${o.id}`) })));
      body.push(slider({ label: T.angle, min: 0, max: 359, step: 1, value: f.angle || 0, format: (v) => `${v}°`, onInput: (v) => set({ angle: v }, `angle-${o.id}`) }));
    }
    if (f.type !== "none" && f.type !== "solid") body.push(h("p.desc", T.fillDesc));
    const summary = h("span.sum", h("span.swatch-dot", { class: `fill-${f.type}` }), fillSummary(f), ico("chevron"));
    return section(title, { summary, ...this.fold(`${key}-${o.id}`, collapsed), cls: "fill-sec" }, ...body);
  },

  backgroundSection(o) {
    const bgOn = o.background?.type && o.background.type !== "none";
    const st = o.stroke || stroke(0);
    const summary = h("span.sum", !bgOn && !st.width ? T.none : [bgOn ? fillSummary(o.background) : null, st.width ? `${T.outline} ${fmtNum(st.width, 2)}\u00a0mm` : null].filter(Boolean).join(" · "), ico("chevron"));
    const bg = this.fillSection(o, "background", T.background);
    return section(T.backgroundAndOutline, { summary, ...this.fold(`bg-${o.id}`, !bgOn && !st.width), cls: "fill-sec" },
      ...[...bg.children].slice(1),
      slider({ label: T.cornerRadius, min: 0, max: 4, step: 0.1, value: o.radius || 0, format: (v) => `${fmtNum(v, 1)}\u00a0mm`, onInput: (v) => setProps({ radius: v }, `radius-${o.id}`, [o]) }),
      slider({ label: T.padding, min: 0, max: 3, step: 0.1, value: o.padding || 0, format: (v) => `${fmtNum(v, 1)}\u00a0mm`, onInput: (v) => setProps({ padding: v }, `pad-${o.id}`, [o]) }),
      h("h4.subhead", T.outline),
      ...this.strokeControls(o, { textOutline: true }));
  },

  strokeSection(o) {
    return section(T.outline, {}, ...this.strokeControls(o));
  },

  strokeControls(o, { textOutline = false } = {}) {
    const st = o.stroke || stroke(0);
    const set = (changes, k = null) => setProps({ stroke: { ...st, ...changes } }, k, [o]);
    return [
      h("div.g2",
        lenInput("↔", st.width, (v) => set({ width: Math.max(0, v) }), { label: T.outlineWidth, min: 0, max: 5 }),
        seg([{ value: 100, label: T.black }, { value: 0, label: T.white }], (st.ink ?? 100) >= 50 ? 100 : 0, (v) => set({ ink: v }), { full: true, small: true, label: T.outlineColor })),
      textOutline ? null : seg([{ value: "solid", label: T.dashSolid }, { value: "dashed", label: T.dashDashed }, { value: "dotted", label: T.dashDotted }], st.dash || "solid", (v) => set({ dash: v }), { full: true, label: T.dashStyle }),
    ].filter(Boolean);
  },

  lineSection(o) {
    return section(T.lineStyle, {},
      ...this.strokeControls(o),
      h("div.row.between", h("span", T.arrows),
        toggles([{ value: "arrowStart", icon: "arrowStart", title: T.arrowStart }, { value: "arrowEnd", icon: "arrowEnd", title: T.arrowEnd }],
          (k) => o[k], (k) => setProps({ [k]: !o[k] }, null, [o]), { label: T.arrows })));
  },

  ditherSection(o, { collapsed = true } = {}) {
    const d = o.dither || { mode: "auto" };
    const actual = ditherMode(o);
    const set = (changes, k = null) => setProps({ dither: { ...d, ...changes } }, k, [o]);
    const modes = ["auto", "threshold", "floyd", "atkinson", "stucki", "bayer4", "bayer8", "halftone", "lines", "noise"];
    const grid = h("div.modes", { role: "group", "aria-label": T.printRendering }, ...modes.map((m) => h(`button.mode${d.mode === m ? ".on" : ""}`, { type: "button", "aria-pressed": String(d.mode === m), title: T[`ditherDesc_${m}`], onclick: () => set({ mode: m }) },
      ditherSwatch(m === "auto" ? actual : m, d), h("span", T[`dither_${m}`]))));
    const body = [grid];
    if (actual === "halftone" || actual === "lines") {
      body.push(h("div.g2",
        slider({ label: T.cell, min: 3, max: 16, step: 1, value: d.cell || 6, format: (v) => T.nDots(v), onInput: (v) => set({ cell: v }, `cell-${o.id}`) }),
        slider({ label: T.angle, min: 0, max: 90, step: 1, value: d.angle ?? 45, format: (v) => `${v}°`, onInput: (v) => set({ angle: v }, `dangle-${o.id}`) })));
    }
    body.push(slider({ label: T.threshold, min: 30, max: 225, step: 1, value: d.threshold ?? 128, format: (v) => String(v), onInput: (v) => set({ threshold: v }, `thr-${o.id}`) }));
    body.push(h("div.dprev", ditherRamp(actual, d)));
    body.push(h("p.desc", T[`ditherDesc_${d.mode === "auto" ? "auto" : actual}`]));
    const summary = h("span.sum", d.mode === "auto" ? `${T.dither_auto} · ${T[`dither_${actual}`].toLowerCase()}` : T[`dither_${actual}`], ico("chevron"));
    const el = section(T.printRendering, { summary, ...this.fold(`dither-${o.id}`, collapsed) }, ...body);
    el.dataset.sec = "dither";
    return el;
  },

  // ---------------------------------------------------------------- images
  imageSection(o) {
    const size = Images.size(o, S.doc);
    const thumb = h("div.img-thumb");
    const src = S.doc.assets[o.asset];
    if (src) thumb.append(h("img", { src, alt: "" }));
    return section(T.image, { summary: h("span.sum", [o.fileName, size ? `${size[0]} × ${size[1]}` : null].filter(Boolean).join(" · ")) },
      h("div.row", thumb, h("div.col", button(T.replaceImage, { size: "sm", icon: "upload", onClick: async () => {
        const file = await pickFile("image/*");
        if (!file) return;
        const url = await readFileAs(file);
        const asset = `a${Date.now().toString(36)}`;
        S.doc.assets[asset] = url;
        setProps({ asset, fileName: file.name }, null, [o]);
      } }))),
      h("div.row.between",
        seg([{ value: "contain", label: T.fitContain }, { value: "cover", label: T.fitCover }, { value: "stretch", label: T.fitStretch }], o.fit, (v) => setProps({ fit: v }, null, [o]), { small: true, label: T.fitMode }),
        toggles([{ value: "flipH", icon: "flipH", title: T.flipH }, { value: "flipV", icon: "flipV", title: T.flipV }], (k) => o[k], (k) => setProps({ [k]: !o[k] }, null, [o]), { label: T.flip })));
  },

  greySection(o) {
    const reset = button(T.reset, { variant: "ghost", size: "sm", onClick: () => setProps({ autoLevels: true, brightness: 0, contrast: 0, gamma: 1, invert: false }, null, [o]) });
    return section(T.greyscale, { actions: reset },
      swRow(T.autoLevels, o.autoLevels, (v) => setProps({ autoLevels: v }, null, [o])),
      slider({ label: T.brightness, min: -100, max: 100, step: 1, value: o.brightness, format: (v) => (v > 0 ? `+${v}` : String(v)), onInput: (v) => setProps({ brightness: v }, `bri-${o.id}`, [o]) }),
      slider({ label: T.contrast, min: -100, max: 100, step: 1, value: o.contrast, format: (v) => (v > 0 ? `+${v}` : String(v)), onInput: (v) => setProps({ contrast: v }, `con-${o.id}`, [o]) }),
      slider({ label: T.gamma, min: 0.3, max: 3, step: 0.05, value: o.gamma, format: (v) => fmtNum(v, 2), onInput: (v) => setProps({ gamma: v }, `gam-${o.id}`, [o]) }),
      h("div.g2",
        swRow(T.invert, o.invert, (v) => setProps({ invert: v }, null, [o])),
        swRow(T.whiteEmpty, o.whiteEmpty, (v) => setProps({ whiteEmpty: v }, null, [o]))));
  },

  // ---------------------------------------------------------------- data-driven
  visibilitySection(o) {
    const vis = o.visible || { mode: "always", join: "and", rules: [] };
    const set = (changes) => setProps({ visible: { ...vis, ...changes } }, null, [o]);
    const fields = fieldNames(S.doc.data);
    const body = [seg([{ value: "always", label: T.visAlways }, { value: "if", label: T.visIf }, { value: "never", label: T.visNever }], vis.mode, (v) => {
      set({ mode: v, rules: v === "if" && !vis.rules.length && fields.length ? [{ field: fields[0], op: "notEmpty", value: "" }] : vis.rules });
    }, { full: true, label: T.visibility })];
    if (vis.mode === "if") {
      vis.rules.forEach((r, i) => {
        if (i > 0) body.push(seg([{ value: "and", label: T.joinAnd }, { value: "or", label: T.joinOr }], vis.join, (v) => set({ join: v }), { small: true, label: T.joinConditions }));
        const update = (changes) => set({ rules: vis.rules.map((x, j) => (j === i ? { ...x, ...changes } : x)) });
        const needsValue = !["empty", "notEmpty", "true", "false"].includes(r.op);
        body.push(h("div.cond",
          selectBox(fields.map((f) => ({ value: f, label: f })), r.field, (v) => update({ field: v }), { label: T.field }),
          selectBox(RULE_OPS.map((op) => ({ value: op, label: T[`op_${op}`] })), r.op, (v) => update({ op: v }), { label: T.condition }),
          iconButton("x", T.removeCondition, () => set({ rules: vis.rules.filter((_, j) => j !== i) }), { size: "xs" })));
        if (needsValue) body.push(textInput({ value: r.value, label: T.value, onChange: (v) => update({ value: v }) }));
      });
      body.push(button(T.addCondition, { variant: "ghost", size: "sm", icon: "plus", onClick: () => set({ rules: [...vis.rules, { field: fields[0] || "", op: "eq", value: "" }] }) }));
      const data = S.doc.data;
      if (data?.rows.length) {
        const shown = printedRows(data, "all").filter((r) => objectShows({ ...o, hidden: false, empty: null }, { raw: rowValues(data, r), texts: null })).map((r) => r + 1);
        body.push(h("p.desc", shown.length === data.rows.length ? T.visAllRows : shown.length ? T.visRows(shown.length <= 6 ? shown.join(", ") : `${shown.length}`, data.rows.length) : T.visNoRows));
      }
    }
    const el = section(T.visibility, { summary: vis.mode !== "always" ? badge(vis.mode === "if" ? T.conditional : T.visNever) : null }, ...body);
    el.dataset.sec = "visibility";
    return el;
  },

  emptySection(o) {
    return section(T.emptyField, {},
      seg([{ value: "hide", label: T.emptyHide }, { value: "dash", label: T.emptyDash }, { value: "keep", label: T.emptyKeep }], o.empty || "hide", (v) => setProps({ empty: v }, null, [o]), { full: true, label: T.emptyField }),
      swRow(T.closeGap, o.closeGap, (v) => setProps({ closeGap: v }, null, [o])));
  },

  // ---------------------------------------------------------------- several objects
  multiPanel() {
    const sel = selected();
    const b = bounds(sel);
    const p = this.panel;
    p.append(section(T.nObjects(sel.length), { summary: h("span.sum.mono", `${fmtNum(b.w, 1)} × ${fmtNum(b.h, 1)}\u00a0mm`) },
      h("div.row.between",
        toggles(ALIGNS.slice(0, 3).map(([e, i]) => ({ value: e, icon: i, title: T[`align_${e}`] })), () => false, (e) => align(e), { label: T.align }),
        toggles(ALIGNS.slice(3).map(([e, i]) => ({ value: e, icon: i, title: T[`align_${e}`] })), () => false, (e) => align(e), { label: T.align })),
      h("div.row.between",
        toggles([{ value: "h", icon: "distH", title: T.distributeH, disabled: sel.length < 3 }, { value: "v", icon: "distV", title: T.distributeV, disabled: sel.length < 3 }], () => false, (a) => distribute(a), { label: T.distribute }),
        seg([{ value: "label", label: T.alignToLabelShort }, { value: "selection", label: T.alignToSelectionShort }], S.alignTo === "label" ? "label" : "selection", (v) => { S.alignTo = v; }, { small: true, label: T.relativeTo })),
      h("p.desc", T.alignDesc)));
    p.append(this.orderSection(sel.length));
    const texts = sel.filter((o) => o.type === "text");
    if (texts.length === sel.length) {
      const sameFont = texts.every((t) => t.font === texts[0].font);
      p.append(section(T.text, {},
        h("button.select.font-btn", { type: "button", "aria-haspopup": "dialog", "aria-label": `${T.font}: ${sameFont ? texts[0].font : T.mixed}`, onclick: (e) => Dialogs.fontPicker(e.currentTarget, texts[0].font, (f) => setProps({ font: f }, null, texts)) }, h("span", sameFont ? texts[0].font : T.mixed), ico("chevron")),
        toggles([{ value: "bold", icon: "bold", title: T.bold }, { value: "italic", icon: "italic", title: T.italic }],
          (k) => texts.every((t) => t[k]), (k) => setProps({ [k]: !texts.every((t) => t[k]) }, null, texts), { label: T.style })));
    }
  },

  orderSection(count) {
    return section(T.order, { summary: h("span.sum", T.nSelected(count)) },
      toggles([
        { value: Infinity, icon: "toFront", title: T.toFront }, { value: 1, icon: "front", title: T.forward },
        { value: -1, icon: "back", title: T.backward }, { value: -Infinity, icon: "toBack", title: T.toBack },
      ], () => false, (v) => reorder(v), { fill: true, label: T.order }),
      h("div.g2",
        button(T.cmdDuplicate, { size: "sm", icon: "copy", onClick: () => duplicateSelected() }),
        button(T.cmdDelete, { size: "sm", icon: "trash", danger: true, onClick: () => deleteSelected() })));
  },

  // ---------------------------------------------------------------- the label
  labelPanel() {
    const l = S.doc.label;
    const p = this.panel;
    const set = (changes) => { History.record(null, "edit"); Object.assign(S.doc.label, changes); changed(); this.refresh(true); requestAnimationFrame(fitView); };
    const cont = l.media === "continuous";
    const body = [
      seg([{ value: "gap", label: T.mediaGap }, { value: "continuous", label: T.mediaContinuous }], l.media, (v) => Studio.setMedia(v), { full: true, label: T.media }),
    ];
    if (cont) body.push(swRow(T.autoLength, l.auto, (v) => set({ auto: v })));
    const length = lenInput("↔", cont && l.auto ? labelLength(S.doc) : l.length, (v) => set({ length: Math.max(5, Math.min(1000, v)), auto: false }), { label: T.length, min: 5, max: 1000 });
    if (cont && l.auto) length.classList.add("disabled");
    body.push(h("div.g2", length, cont ? lenInput(T.margin, l.margin ?? 2, (v) => set({ margin: Math.max(0, v) }), { label: T.margin, min: 0, max: 20 }) : h("span")));
    body.push(h("div.chips", ...LENGTHS.map((n) => chip(n === 100 ? `${n}\u00a0mm` : String(n), { on: !(cont && l.auto) && Number(l.length) === n, onClick: () => set({ length: n, auto: false }) })),
      chip(T.custom, { onClick: () => length.input.focus() })));
    body.push(slider({ label: T.feedAfter, min: 0, max: 30, step: 1, value: labelFeed(S.doc), format: (v) => `${v}\u00a0mm`, onChange: (v) => set({ feed: v }) }));
    body.push(h("p.desc", T.feedDesc));
    p.append(section(T.media, { summary: h("span.sum", T.tape12) }, ...body));

    const L = S.raster ? S.raster.width / DPMM : labelLength(S.doc);
    const W = S.raster ? S.raster.width : mmToDots(L);
    p.append(section(T.dimensions, {}, h("dl.facts",
      h("dt", T.labelWord), h("dd.mono", `${fmtNum(TAPE_MM, 0)} × ${fmtNum(L, 1)}\u00a0mm`),
      h("dt", T.printHead), h("dd.mono", `${HEAD_DOTS} × ${W} ${T.dots}`),
      h("dt", T.resolution), h("dd.mono", `${DPI} dpi · 8 ${T.dotsPerMm}`))));

    if (usesCounter(S.doc) || !S.doc.data) p.append(this.counterSection());

    const pr = Studio.printer;
    p.append(section(T.printer, { summary: badge(pr.state === "ok" ? T.connected : pr.state === "reading" ? T.reading : T.notReachable, pr.state === "ok" ? "ok" : pr.state === "off" ? "warn" : "") },
      h("div.row", h("span.typeic", ico("printer")), h("div.col",
        h("strong", pr.info?.model ? `HPRT ${pr.info.model}` : "HPRT Qutie"),
        h("span.sub", pr.state === "ok" ? `${T.batteryPct(pr.info.battery)} · ${pr.info.paper === "continuous" ? T.continuousInserted : T.gapInserted}` : pr.state === "off" ? T.printerHint : T.printerReading))),
      h("div.row",
        button(T.useInserted, { size: "sm", disabled: pr.state !== "ok", onClick: () => Studio.setMedia(pr.info.paper) }),
        button(T.feedShort, { variant: "ghost", size: "sm", onClick: () => Studio.printerAction("feed") }),
        iconButton("refresh", T.readAgain, () => Studio.refreshPrinter(true), { size: "sm" }))));

    p.append(section(T.workspace, {},
      swRow(T.snapLong, S.snap, () => Studio.toggle("snap")),
      swRow(T.grid1mm, S.grid, () => Studio.toggle("grid")),
      swRow(T.rulersInches, S.inches, (v) => { S.inches = v; invalidate(); })));
  },

  counterSection() {
    const s = S.doc.series;
    const set = (changes) => { History.record(null, "edit"); Object.assign(S.doc.series, changes); changed(); };
    const uses = usesCounter(S.doc);
    const body = uses ? [
      h("div.g2",
        numInput({ lead: T.leadStart, value: s.start, decimals: 0, step: 1, label: T.counterStart, onChange: (v) => set({ start: v }) }),
        numInput({ lead: T.leadStep, value: s.step, decimals: 0, step: 1, label: T.counterStep, onChange: (v) => set({ step: v || 1 }) }),
        numInput({ lead: T.leadDigits, value: s.pad, decimals: 0, step: 1, min: 0, max: 8, label: T.counterDigits, onChange: (v) => set({ pad: v }) }),
        numInput({ lead: T.leadCount, value: s.count, decimals: 0, step: 1, min: 1, max: 9999, label: T.counterCount, onChange: (v) => set({ count: v }) })),
      swRow(T.counterAdvance, s.advance !== false, (v) => set({ advance: v })),
      h("p.desc", T.counterDesc(expand("{n}", { n: s.start, pad: s.pad }), expand("{n}", { n: s.start + (s.count - 1) * s.step, pad: s.pad }))),
    ] : [h("p.desc", T.counterHint), button(T.addCounter, { size: "sm", icon: "plus", onClick: () => Studio.insertVariable("{n}") })];
    return section(T.counter, { summary: uses ? badge("{n}") : null }, ...body);
  },

  // ---------------------------------------------------------------- layers
  layers() {
    const list = h("ul.layers", { role: "listbox", "aria-label": T.tabLayers, "aria-multiselectable": "true" });
    const objs = [...S.doc.objects].reverse();
    for (const o of objs) list.append(this.layerRow(o, list));
    if (!objs.length) list.append(h("li.layer-empty", T.noLayers));
    // One row in the Tab order (the selected one, or the top one); the arrows move between rows.
    const rows = $$(".layer", list);
    const current = rows.find((r) => r.classList.contains("on")) || rows[0];
    rows.forEach((r) => { r.tabIndex = r === current ? 0 : -1; });
    this.panel.append(list, h("p.desc.pad", T.layersDesc), h("span.spacer"));
    if (S.selection.length) this.panel.append(this.orderSection(S.selection.length));
    this.panel.classList.add("layers-panel");
  },

  layerRow(o, list) {
    const on = S.selection.includes(o.id);
    const detail = o.type === "text" ? (o.symbol ? o.text : o.text?.slice(0, 40)) : o.type === "barcode" ? `${T[`bc_${o.kind}`] || o.kind} · ${o.content}` : o.type === "qr" ? (o.kind === "microqr" ? "Micro QR" : "QR") : o.type === "image" ? o.fileName : "";
    const name = h("span.nm", o.name, detail ? h("small", detail) : null);
    const row = h(`li.layer${on ? ".on" : ""}${o.hidden ? ".off" : ""}`, { role: "option", "aria-selected": String(on), tabindex: "0", "data-layer": o.id },
      h("span.grip", ico("grip", 14)), h("span.ic", ico(objIcon(o))), name,
      iconButton(o.hidden ? "eyeOff" : "eye", o.hidden ? T.cmdShow : T.cmdHide, (e) => { e.stopPropagation(); setProps({ hidden: !o.hidden }, null, [o]); }, { size: "xs", cls: o.hidden ? "keep" : "", pressed: o.hidden }),
      iconButton(o.locked ? "lock" : "unlock", o.locked ? T.cmdUnlock : T.cmdLock, (e) => { e.stopPropagation(); setProps({ locked: !o.locked }, null, [o]); if (!o.locked) select(S.selection.filter((id) => id !== o.id)); }, { size: "xs", cls: o.locked ? "keep" : "", pressed: o.locked }));
    row.addEventListener("click", (e) => {
      if (e.shiftKey || e.ctrlKey) select(on ? S.selection.filter((id) => id !== o.id) : [...S.selection, o.id]);
      else select(o.id);
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(o.id); }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); (e.key === "ArrowDown" ? row.nextElementSibling : row.previousElementSibling)?.focus(); }
      if (e.key === "F2") { e.preventDefault(); name.dispatchEvent(new MouseEvent("dblclick")); }
    });
    row.addEventListener("contextmenu", (e) => { e.preventDefault(); if (!on) select(o.id); layerContextMenu(e.clientX, e.clientY); });
    name.addEventListener("dblclick", () => {
      const input = h("input.rename", { type: "text", value: o.name, "aria-label": T.objectName, spellcheck: "false", autocomplete: "off" });
      name.replaceWith(input);
      input.focus();
      input.select();
      const done = (save) => { if (save && input.value.trim()) setProps({ name: input.value.trim() }, null, [o]); else this.refresh(true); };
      input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
      input.addEventListener("blur", () => done(true));
    });
    // Drag to reorder: the list shows where it lands.
    row.querySelector(".grip").addEventListener("pointerdown", (e) => {
      e.preventDefault();
      row.setPointerCapture(e.pointerId);
      row.classList.add("dragging");
      let target = null;
      const move = (ev) => {
        const rows = $$(".layer", list).filter((r) => r !== row);
        rows.forEach((r) => r.classList.remove("drop", "drop-after"));
        target = null;
        for (const r of rows) {
          const b = r.getBoundingClientRect();
          if (ev.clientY < b.top + b.height / 2) { r.classList.add("drop"); target = { id: r.dataset.layer, after: false }; break; }
        }
        if (!target && rows.length) { rows[rows.length - 1].classList.add("drop-after"); target = { id: rows[rows.length - 1].dataset.layer, after: true }; }
      };
      const up = () => {
        row.removeEventListener("pointermove", move);
        row.removeEventListener("pointerup", up);
        row.classList.remove("dragging");
        if (!target) return this.refresh(true);
        // The list is top first; the document is bottom first.
        const others = S.doc.objects.filter((x) => x.id !== o.id);
        const idx = others.findIndex((x) => x.id === target.id);
        moveToIndex(o.id, target.after ? idx : idx + 1);
      };
      row.addEventListener("pointermove", move);
      row.addEventListener("pointerup", up);
    });
    return row;
  },
};

function fillSummary(f) {
  switch (f?.type) {
    case "solid": return f.ink >= 50 ? `${T.fillSolid} · 100%` : `${T.fillSolid} · ${T.white.toLowerCase()}`;
    case "grey": return `${T.fillGrey} · ${f.ink}%`;
    case "pattern": return `${T.fillPattern} · ${T[`pattern_${f.pattern}`]}`;
    case "gradient": return `${T.fillGradient} · ${f.from}→${f.to}%`;
    default: return T.none;
  }
}

/** A small preview of a dithering method on a grey ramp. */
function ditherSwatch(mode, opts) {
  const c = h("canvas.tx", { width: 64, height: 26 });
  drawRamp(c, mode, opts);
  return c;
}

function ditherRamp(mode, opts) {
  const c = h("canvas", { width: 280, height: 28 });
  drawRamp(c, mode, opts);
  return c;
}

function drawRamp(canvas, mode, opts) {
  const W = canvas.width, H = canvas.height;
  const greyMap = new Float32Array(W * H), mask = new Uint8Array(W * H).fill(1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) greyMap[y * W + x] = 255 * (x / (W - 1));
  const bits = dither(greyMap, mask, W, H, mode === "auto" ? "bayer8" : mode, opts || {});
  bitsToCanvas({ width: W, height: H, bits }, canvas);
}
