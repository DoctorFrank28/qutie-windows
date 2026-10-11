"use strict";
/* Qutie Studio: start-up, the two views (Home and the editor), documents, the printer
 * and the parts of the window that are not panels: top bar, tool rail, status bar,
 * hints, banners and file drops.
 */

const Studio = {
  view: "home",
  page: "home",
  config: {},
  state: null,
  path: null,
  recent: [],
  printer: { state: "unknown", info: null, detail: null },
  pendingPrint: null, // a print waiting for the printer to come back
  _dropWait: null,

  // ---------------------------------------------------------------- start
  async boot() {
    applyTheme(localStorage.getItem("qutie.theme") || "system");
    let state;
    try {
      state = await api("state");
    } catch {
      state = { config: {}, start: {}, studio: true, version: "" };
    }
    this.state = state;
    this.config = state.config || {};
    if (chooseLanguage(this.config.language)) return; // reloads in the chosen language
    applyTheme(this.config.theme || "system");
    Prefs.font = this.config.default_font || "Segoe UI";
    Prefs.bold = this.config.default_bold !== false;
    S.view.mode = this.config.default_view === "smooth" ? "smooth" : "dots";
    S.inches = this.config.units === "in";
    document.documentElement.lang = LANG;
    $("#doc-name-label").textContent = T.docName;
    // The hint pill describes what to do on the canvas.
    stage.setAttribute("aria-describedby", "hint");
    $("#rail").setAttribute("aria-label", T.scTools);
    $("#banners").setAttribute("aria-live", "polite"); // printer warnings arrive while you work
    buildMenubar($("#menubar"));
    this.buildToolbar();
    this.buildRail();
    Inspector.build($("#inspector"));
    readColors();
    this.wireDocName();
    this.wireDrops();
    listeners.change.push((e) => this.onChange(e));
    // Codes and images arrive later: draw the label again when they do.
    Resources.listeners.add(() => { if (S.doc) { S.rasterDirty = true; invalidate(); } });
    listeners.selection.push(() => this.onSelection());
    api("watch_drops").catch(() => {});
    this.loadRecent();
    Home.build();

    const start = state.start || {};
    if (start.path) await this.open(start.path);
    else if (start.text) this.newWithText(start.text);
    else if (start.view) this.show("home", start.view);
    else if (this.config.open_on === "last" && this.config.last_document) {
      if (!(await this.open(this.config.last_document, { quiet: true }))) this.show("home");
    } else this.show("home");
    this.offerRecovery();
    this.refreshPrinter();
  },

  /** Commands from the app: open a file, a Home page or a text (quick print → Studio). */
  async external(start) {
    if (start.path) {
      if (await this.confirmDiscard()) await this.open(start.path);
    } else if (start.text) {
      if (await this.confirmDiscard()) this.newWithText(start.text);
    } else if (start.view) this.show("home", start.view);
  },

  // ---------------------------------------------------------------- views
  show(view, page) {
    this.view = view;
    document.body.dataset.view = view;
    closeTop();
    if (view === "home") {
      this.page = page || this.page || "home";
      Home.show(this.page);
      this.setTitle();
    } else {
      requestAnimationFrame(() => { resizeStage(); invalidate(); });
      this.setTitle();
    }
    this.renderToolbar();
  },

  setTitle() {
    const name = this.view === "editor" && S.doc ? `${S.doc.name}${modified ? " •" : ""}` : "";
    document.title = name ? `${name} · Qutie Studio` : "Qutie Studio";
    api("set_dirty", this.view === "editor" && modified, this.view === "editor" && S.doc ? S.doc.name : "").catch(() => {});
  },

  // ---------------------------------------------------------------- documents
  setDocument(doc, { path = null, fresh = false } = {}) {
    S.doc = normalizeDocument(doc);
    S.selection = [];
    S.view.fitted = false;
    S.pendingSymbol = null;
    History.clear();
    modified = false;
    this.path = path;
    if (fresh) api("forget_path").catch(() => {});
    $("#doc-name").value = S.doc.name;
    DataUI.tableOpen = false;
    DataUI.refresh();
    changed({ structure: true, save: false });
    modified = false;
    this.show("editor");
    Inspector.show(S.doc.objects.length ? "props" : "label");
    select([]);
    requestAnimationFrame(() => { fitView(); this.emptyState(); this.placeEmpty(); });
    this.renderSaved();
    this.hint();
    this.banners();
    if (S.doc.data?.source?.path && this.config.reread === "open") DataUI.reload({ quiet: true });
  },

  newBlank(length = 40, media = "gap") {
    this.confirmDiscard().then((ok) => {
      if (!ok) return;
      const doc = newDocument({ label: { media, length, auto: media === "continuous", margin: 2, feed: media === "continuous" ? FEED_CONTINUOUS : FEED_GAP } });
      this.setDocument(doc, { fresh: true });
    });
  },

  fromTemplate(tpl) {
    this.confirmDiscard().then((ok) => {
      if (!ok) return;
      const doc = structuredClone(tpl.doc);
      doc.id = uid();
      if (doc.template && !tpl.user) delete doc.template;
      if (tpl.user) doc.name = tpl.name;
      delete doc.template;
      this.setDocument(doc, { fresh: true });
      if (tpl.askSource) DataUI.connect();
    });
  },

  newWithText(text) {
    const doc = newDocument();
    doc.objects.push(makeObject("text", { name: `${T.type_text} 1`, text, x: 1, y: 1, w: 38, h: TAPE_MM - 2 }));
    this.setDocument(doc, { fresh: true });
  },

  async open(path, { quiet = false } = {}) {
    if (!path && !(await this.confirmDiscard())) return false;
    let r;
    try { r = await api("open", path || null); } catch (e) { r = { ok: false, detail: String(e) }; }
    if (!r?.ok) {
      if (!r?.cancelled && !quiet) toast(T.openFailed, { kind: "error", detail: r?.detail });
      return false;
    }
    let raw;
    try { raw = JSON.parse(r.document); } catch { toast(T.openFailed, { kind: "error" }); return false; }
    raw.name = raw.name || r.name;
    this.setDocument(raw, { path: r.path });
    this.loadRecent();
    return true;
  },

  async save(saveAs = false) {
    if (!S.doc) return false;
    const r = await api("save", JSON.stringify(cleanDocument()), S.doc.name, saveAs).catch((e) => ({ ok: false, detail: String(e) }));
    if (!r?.ok) {
      if (!r?.cancelled) toast(T.saveFailed, { kind: "error", detail: r?.detail });
      return false;
    }
    this.path = r.path;
    if (r.name && r.name !== S.doc.name && saveAs) { S.doc.name = r.name; $("#doc-name").value = r.name; }
    modified = false;
    api("discard_recovery", S.doc.id).catch(() => {});
    this.renderSaved();
    this.setTitle();
    this.loadRecent();
    return true;
  },

  /** Unsaved changes: save, discard or stay. Resolves true when it is fine to go on. */
  async confirmDiscard() {
    if (!S.doc || !modified || !S.doc.objects.length) return true;
    const choice = await ask({
      title: T.saveChangesTo(S.doc.name), text: T.saveChangesText,
      buttons: [{ label: T.dontSave, variant: "ghost", value: "discard" }, { spacer: true }, { label: T.cancel, value: "cancel" }, { label: T.save, variant: "primary", value: "save", autofocus: true }],
    });
    if (choice === "save") return this.save();
    if (choice === "discard") { modified = false; api("discard_recovery", S.doc.id).catch(() => {}); return true; }
    return false;
  },

  /** Closing the window: ask about unsaved changes; a clean close leaves nothing to recover. */
  async askClose() {
    if (!(await this.confirmDiscard())) return;
    if (S.doc && !modified) await api("discard_recovery", S.doc.id).catch(() => {});
    api("close", true);
  },

  quit() { return this.askClose(); },

  async offerRecovery() {
    const r = await api("restore").catch(() => null);
    if (!r?.document) return;
    let doc;
    try { doc = JSON.parse(r.document); } catch { return; }
    if (S.doc && doc.id === S.doc.id) return;
    if (!doc.objects?.length) return;
    toast(T.recoveryFound(doc.name || T.untitled), {
      duration: 12000, detail: relTime(r.time, { time: true }),
      action: { label: T.recover, run: async () => { if (await this.confirmDiscard()) { this.setDocument(doc, { fresh: true }); modified = true; this.renderSaved(); } } },
    });
  },

  async loadRecent() {
    this.recent = await api("recent").catch(() => []) || [];
    Home.recentChanged?.();
  },

  recentMenu() {
    const items = this.recent.slice(0, 10).map((r) => ({ label: r.name, hint: relTime(r.modified), action: () => this.confirmDiscard().then((ok) => ok && this.open(r.path)) }));
    return [...items, "-", { label: T.clearRecent, disabled: !items.length, action: async () => { await api("clear_recent"); this.loadRecent(); } }];
  },

  // ---------------------------------------------------------------- editing helpers
  insert(tool, { at = null } = {}) {
    if (!S.doc) return;
    if (tool === "symbol") { Dialogs.symbols(); return; }
    if (tool === "image") { this.pickImage(at); return; }
    const o = makeObject(tool);
    if (tool === "text") o.text = T.sampleText;
    const free = this.freeSpot(o.w);
    o.x = round3(at ? at[0] : free);
    o.y = round3(at ? Math.max(0, Math.min(TAPE_MM - o.h, at[1] - o.h / 2)) : Math.max(0, (TAPE_MM - o.h) / 2));
    if (tool === "text") { o.y = 1; o.h = round3(TAPE_MM - 2); }
    if (tool === "qr") { o.w = o.h = 11; o.y = 0.5; }
    addObject(o);
    Inspector.show("props");
    if (tool === "text" || tool === "barcode" || tool === "qr") Inspector.focusContent(o.id, true);
    if (tool === "qr") CodesUI.quickPopover(o);
  },

  /** Where a new object fits: after the last one, or at the start. */
  freeSpot(width) {
    const visible = S.doc.objects.filter((o) => !o.hidden);
    const L = labelLength(S.doc);
    if (!visible.length) return 1;
    const end = bounds(visible).x1 + 1;
    return end + width <= L ? end : Math.max(0, (L - width) / 2);
  },

  tool(name) {
    if (name === "image") { this.pickImage(); return; }
    if (name === "symbol") { Dialogs.symbols(); return; }
    setTool(S.tool === name ? "select" : name);
  },

  async pickImage(at = null) {
    const file = await pickFile("image/*");
    if (file) this.addImageFile(file, at);
  },

  /** An image file (or pasted blob) becomes an image object, scaled down to a sensible size. */
  async addImageFile(file, at = null) {
    const url = await readFileAs(file);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch { toast(T.imageFailed, { kind: "error" }); return; }
    const max = 1600;
    let src = url;
    if (Math.max(img.naturalWidth, img.naturalHeight) > max || (file.size || 0) > 1.5e6) {
      const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = h("canvas", { width: Math.round(img.naturalWidth * k), height: Math.round(img.naturalHeight * k) });
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      src = c.toDataURL(file.type === "image/png" || !file.type ? "image/png" : "image/jpeg", 0.9);
    }
    const asset = `a${Date.now().toString(36)}`;
    S.doc.assets[asset] = src;
    const ratio = img.naturalWidth / img.naturalHeight;
    const hMm = TAPE_MM, wMm = Math.min(labelLength(S.doc), round3(hMm * ratio));
    const o = makeObject("image", {
      asset, fileName: file.name || "", w: wMm, h: round3(Math.min(hMm, wMm / ratio)),
      x: at?.x ?? (Array.isArray(at) ? at[0] : this.freeSpot(wMm)), y: 0,
      name: (file.name || T.type_image).replace(/\.[^.]+$/, ""),
    });
    o.y = round3((TAPE_MM - o.h) / 2);
    addObject(o, { label: "add" });
    Inspector.show("props");
  },

  insertField(field) {
    const token = `«${field}»`;
    const o = selected()[0];
    if (o && S.selection.length === 1 && (o.type === "text" || o.type === "barcode" || o.type === "qr")) {
      if (!Inspector.insertAtCursor(o.id, token)) {
        const key = o.type === "text" ? "text" : "content";
        setProps({ [key]: o.type === "text" && o[key] && o[key] !== T.sampleText ? `${o[key]} ${token}` : token }, null, [o]);
      }
      return;
    }
    const type = fieldType(S.doc.data, field);
    if (type === "ean13" || type === "ean8") {
      const b = makeObject("barcode", { kind: type, content: token, x: this.freeSpot(30), y: 0.6, w: 30, h: 10.8 });
      addObject(b);
    } else {
      addObject(makeObject("text", { text: token, x: this.freeSpot(30), y: 1, w: 30, h: TAPE_MM - 2 }));
    }
  },

  insertVariable(token) {
    const o = selected()[0];
    if (o && S.selection.length === 1 && (o.type === "text" || o.type === "barcode" || o.type === "qr")) {
      if (!Inspector.insertAtCursor(o.id, token)) {
        const key = o.type === "text" ? "text" : "content";
        setProps({ [key]: `${o[key] || ""}${o[key] ? " " : ""}${token}` }, null, [o]);
      }
      return;
    }
    addObject(makeObject("text", { text: token, x: this.freeSpot(30), y: 1, w: 30, h: TAPE_MM - 2 }));
  },

  linkField(o, field) {
    if (o.type === "qr") setProps({ content: `«${field}»`, qrType: "field", qrData: { field } }, null, [o]);
    else setProps({ [o.type === "text" ? "text" : "content"]: `«${field}»` }, null, [o]);
  },

  setViewMode(mode) {
    S.view.mode = mode;
    invalidate();
    this.renderToolbar();
    this.hint();
  },

  toggle(what) {
    S[what] = !S[what];
    if (what === "rulers") { S.view.fitted = false; resizeStage(); }
    invalidate();
    this.status();
    Inspector.refresh();
  },

  togglePanel() {
    document.body.classList.toggle("no-panel");
    requestAnimationFrame(resizeStage);
  },

  setMedia(media) {
    if (!S.doc || !media) return;
    History.record(null, "edit");
    S.doc.label.media = media;
    S.doc.label.feed = media === "continuous" ? FEED_CONTINUOUS : FEED_GAP;
    if (media === "continuous" && !S.doc.label.length) S.doc.label.length = 40;
    changed();
    Inspector.refresh();
    this.banners();
  },

  async setConfig(changes) {
    Object.assign(this.config, changes);
    if ("theme" in changes) applyTheme(changes.theme);
    if ("default_font" in changes) Prefs.font = changes.default_font;
    if ("default_bold" in changes) Prefs.bold = changes.default_bold;
    if ("units" in changes) { S.inches = changes.units === "in"; invalidate(); }
    const saved = await api("set_config", changes).catch(() => null);
    if (saved) this.config = saved;
    if ("language" in changes) chooseLanguage(changes.language);
  },

  // ---------------------------------------------------------------- printer
  async refreshPrinter(force = false) {
    if (this.printer.state === "reading") return;
    if (!force && this.printer.readAt && Date.now() - this.printer.readAt < 20000) return;
    this.printer = { ...this.printer, state: "reading" };
    this.renderPrinterChips();
    const r = await api("printer").catch((e) => ({ ok: false, detail: String(e) }));
    this.printer = r?.ok ? { state: "ok", info: r, readAt: Date.now() } : { state: "off", info: this.printer.info, detail: r?.detail, readAt: Date.now() };
    this.renderPrinterChips();
    this.banners();
    Home.printerChanged?.();
    Inspector.refresh();
  },

  async printerAction(name) {
    toast(name === "feed" ? T.feeding : T.printingTest);
    const r = await api(name).catch((e) => ({ ok: false, detail: String(e) }));
    if (r?.ok) toast(name === "feed" ? T.fed : T.testSent, { kind: "ok" });
    else toast(T.printerUnreachable, { kind: "error", detail: r?.detail });
  },

  /** Ctrl+Shift+P: print everything as set up, without the dialog (but ask for long series). */
  async printNow() {
    const plan = labelPlan(S.doc);
    if (!plan.length) { toast(T.nothingToPrint); return; }
    Dialogs.runPrint({ plan, source: "studio" });
  },

  // ---------------------------------------------------------------- top bar, rail, status
  buildToolbar() {
    const tb = $("#tb-edit");
    this.ui = {
      undo: iconButton("undo", T.cmdUndo, () => run("undo")),
      redo: iconButton("redo", T.cmdRedo, () => run("redo")),
      viewSeg: seg([{ value: "dots", label: T.viewDotsShort, title: T.viewDotsHint }, { value: "smooth", label: T.viewSmoothShort, title: T.viewSmoothHint }],
        S.view.mode, (v) => this.setViewMode(v), { label: T.rendering }),
      zoomOut: iconButton("minus", T.zoomOut, () => zoomAt(0.8)),
      zoomValue: h("button.btn.ghost.sm.mono.zoomv", { type: "button", title: T.zoomFit, "aria-haspopup": "menu", onclick: (e) => showMenu([
        ...[1, 2, 4, 8].map((z) => ({ label: fmtPercent(z * 100), action: () => setZoom(z) })),
        "-", mi("zoomFit"), mi("zoomActual"),
      ], { anchor: e.currentTarget, align: "center" }) }),
      zoomIn: iconButton("plus", T.zoomIn, () => zoomAt(1.25)),
      settings: iconButton("settings", T.printerSettings, () => this.show("home", "printer")),
      print: button(T.print, { variant: "primary", icon: "printer", onClick: () => Dialogs.print() }),
    };
    append(tb, this.ui.undo, this.ui.redo, h("span.divider"), this.ui.viewSeg, this.ui.zoomOut, this.ui.zoomValue, this.ui.zoomIn,
      h("span.divider"), this.ui.settings, this.ui.print);
    // On the Home pages, the way back to the label still open (where the editor shows its name).
    this.ui.back = h("button.btn.outline.sm.back-label.home-only", { type: "button", onclick: () => run("backToLabel") });
    $("#menubar").after(this.ui.back);
    const home = $("#tb-home");
    this.ui.homePrinter = h("button.chip.printer-chip", { type: "button", onclick: () => this.show("home", "printer") });
    append(home, this.ui.homePrinter, button(T.newLabel, { variant: "primary", size: "sm", icon: "plus", onClick: () => this.newBlank() }));
  },

  renderToolbar() {
    if (!this.ui) return;
    this.ui.undo.disabled = !History.past.length;
    this.ui.redo.disabled = !History.future.length;
    this.ui.undo.title = CMD.undo.label();
    this.ui.viewSeg.set(S.view.mode);
    this.ui.zoomValue.textContent = fmtPercent(S.view.zoom * 100);
    const back = this.ui.back;
    back.hidden = !S.doc;
    if (S.doc) {
      clear(back).append(ico("chevronLeft", 14), h("span.nm", S.doc.name), modified ? h("span.dot", { "aria-hidden": "true" }, "•") : null);
      back.setAttribute("aria-label", `${T.cmdBackToLabel}: ${S.doc.name}${modified ? ` (${T.unsavedShort})` : ""}`);
      back.title = `${T.cmdBackToLabel} (Esc)`;
    }
    this.renderPrinterChips();
    DataUI.renderNavigator($("#recnav"));
  },

  renderPrinterChips() {
    const p = this.printer;
    const text = p.state === "ok" ? `Qutie · ${fmtPercent(p.info.battery)}` : p.state === "reading" ? T.printerReadingShort : p.state === "off" ? T.printerUnreachableShort : "Qutie";
    const iconName = p.state === "ok" ? "battery" : "bluetooth";
    if (this.ui?.homePrinter) {
      clear(this.ui.homePrinter).append(ico(iconName, 13), text);
      this.ui.homePrinter.classList.toggle("warn", p.state === "off");
    }
    this.status();
  },

  buildRail() {
    const rail = $("#rail");
    const tools = [["select", "V"], ["hand", "H"], "-", ["text", "T"], ["rect", "R"], ["ellipse", "E"], ["line", "L"], ["image", "I"], ["barcode", "B"], ["qr", "Q"], ["symbol", "S"]];
    this.railButtons = {};
    for (const t of tools) {
      if (t === "-") { rail.append(h("span.sep")); continue; }
      const [name, key] = t;
      const b = h("button.tool", {
        type: "button", "aria-label": `${T[`tool_${name}`]} (${key})`, title: `${T[`tool_${name}`]} (${key})`, "aria-pressed": "false",
        onclick: () => (name === "select" || name === "hand" ? setTool(name) : this.tool(name)),
      }, ico(name));
      this.railButtons[name] = b;
      rail.append(b);
    }
    rail.append(h("span.spacer"), h("button.tool", { type: "button", "aria-label": T.cmdShortcuts, title: `${T.cmdShortcuts} (Ctrl /)`, onclick: () => Dialogs.shortcuts() }, ico("keyboard")));
    this.renderRail();
  },

  renderRail() {
    for (const [name, b] of Object.entries(this.railButtons || {})) {
      const on = S.tool === name || (name === "symbol" && !!S.pendingSymbol);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  },

  status() {
    const bar = $("#statusbar");
    if (!bar || !S.doc) return;
    const L = S.raster ? S.raster.width / DPMM : labelLength(S.doc);
    const W = S.raster ? S.raster.width : mmToDots(L);
    const sel = selected();
    let middle;
    if (S.pendingSymbol) middle = T.clickToPlace(S.pendingSymbol.char);
    else if (sel.length > 1) { const b = bounds(sel); middle = T.selectionSize(sel.length, fmtNum(b.w, 1), fmtNum(b.h, 1)); }
    else if (S.cursor) middle = `x ${fmtNum(S.cursor[0], 1)} · y ${fmtNum(S.cursor[1], 1)} mm`;
    else if (sel.length === 1) middle = `${sel[0].name} · ${fmtNum(sel[0].w, 1)} × ${fmtNum(sel[0].h, 1)} mm`;
    else middle = T.noSelection;
    const env = S.doc.data?.columns.length ? editEnv(S.doc) : null;
    if (env && env.row !== undefined && !S.cursor && sel.length < 2 && !S.pendingSymbol) {
      const copies = rowCopies(S.doc.data, env.row);
      const first = S.doc.data.columns[0] ? env.texts[S.doc.data.columns[0].name] : "";
      middle = T.rowStatus(env.row + 1, first, copies);
    }
    const p = this.printer;
    const media = S.doc.label.media === "continuous" ? T.mediaContinuousShort : T.mediaGapShort;
    const printerText = p.state === "ok" ? `Qutie · ${fmtPercent(p.info.battery)} · ${p.info.paper === "continuous" ? T.mediaContinuousShort : T.mediaGapShort}` : p.state === "reading" ? T.printerReadingShort : p.state === "off" ? T.printerUnreachableShort : `Qutie · ${media}`;
    clear(bar).append(
      h("span.mono", `${fmtNum(TAPE_MM, 0)} × ${fmtNum(L, 0)} mm · ${HEAD_DOTS} × ${W} ${T.dots} · ${DPI} dpi`),
      h("span.mono.st-mid", middle),
      h("span.spacer"),
      chip(T.snap, { on: S.snap, icon: "magnet", onClick: () => this.toggle("snap"), title: `${T.snap} (Ctrl ;)` }),
      chip(T.grid, { on: S.grid, icon: "grid", onClick: () => this.toggle("grid"), title: `${T.grid1mm} (Ctrl ')` }),
      chip(printerText, { icon: p.state === "ok" ? "battery" : "bluetooth", cls: p.state === "off" ? "warn" : "", onClick: () => this.refreshPrinter(true), title: T.readAgain }),
    );
  },

  renderSaved() {
    const el = $("#saved");
    if (!el) return;
    el.textContent = modified ? (this.config.autosave !== false ? T.modifiedAutosave : T.modified) : this.path ? T.saved : T.notSavedYet;
  },

  wireDocName() {
    const input = $("#doc-name");
    input.addEventListener("change", () => {
      const name = input.value.trim() || T.untitled;
      if (name === S.doc.name) return;
      History.record(null, "rename");
      S.doc.name = name;
      changed();
      this.setTitle();
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") { if (e.key === "Escape") input.value = S.doc.name; input.blur(); stage.focus(); } });
  },

  // ---------------------------------------------------------------- reactions
  onChange(e) {
    if (e.doc) {
      this.renderSaved();
      this.setTitle();
      this.renderToolbar();
      this.emptyState();
      this.banners();
    }
    if (e.view) this.renderToolbar();
    if (e.tool) { this.renderRail(); this.hint(); }
    if (e.cursor || e.raster || e.doc) this.statusSoon();
    if (e.contextmenu) {
      const c = e.contextmenu;
      if (c.object) objectContextMenu(c.x, c.y);
      else emptyContextMenu(c.x, c.y, c.at);
    }
    if (e.edit) {
      const o = byId(e.edit);
      if (o?.type === "barcode" || o?.type === "qr") CodesUI.quickPopover(o, e.at);
      else Inspector.focusContent(e.edit);
    }
    if (e.request === "image") this.pickImage(e.at);
    if (e.request === "symbol") Dialogs.symbols();
    if (e.placeSymbol) Dialogs.placeSymbol(e.placeSymbol.at);
    if (e.focusContent) Inspector.focusContent(e.focusContent, e.selectAll);
  },

  statusSoon: (() => { let q = false; return function () { if (q) return; q = true; requestAnimationFrame(() => { q = false; Studio.status(); }); }; })(),

  onSelection() {
    this.floatbar();
    this.hint();
    this.status();
  },

  /** The floating bar above a multiple selection: align, distribute, relative to. */
  floatbar() {
    const bar = $("#floatbar");
    const sel = selected();
    if (sel.length < 2 || this.view !== "editor") { bar.hidden = true; return; }
    const relTo = S.alignTo === "label" ? T.alignToLabel : T.alignToSelection;
    clear(bar).append(
      h("span.lbl", T.nObjects(sel.length)),
      ...ALIGNS.slice(0, 3).map(([edge, i]) => iconButton(i, T[`align_${edge}`], () => align(edge))),
      h("span.div"),
      ...ALIGNS.slice(3).map(([edge, i]) => iconButton(i, T[`align_${edge}`], () => align(edge))),
      h("span.div"),
      iconButton("distH", T.distributeH, () => distribute("h"), { disabled: sel.length < 3 }),
      iconButton("distV", T.distributeV, () => distribute("v"), { disabled: sel.length < 3 }),
      h("span.div"),
      button(`${T.relativeTo}: ${relTo.toLowerCase()}`, { variant: "ghost", size: "sm", icon: null, onClick: (e) => showMenu([mi("alignToLabel"), mi("alignToSelection")], { anchor: e.currentTarget }) }),
    );
    bar.setAttribute("aria-label", T.selection);
    bar.hidden = false;
    this.positionFloatbar();
  },

  positionFloatbar() {
    const bar = $("#floatbar");
    const sel = selected();
    if (!bar || bar.hidden || sel.length < 2) return;
    const b = bounds(sel);
    const [x0, y0] = mmToScreen(b.x0, b.y0), [x1] = mmToScreen(b.x1, b.y0);
    const wrap = $("#stage-wrap").getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    bar.style.left = `${Math.max(8, Math.min(wrap.width - r.width - 8, (x0 + x1) / 2 - r.width / 2))}px`;
    bar.style.top = `${Math.max(rulerSize() + 8, y0 - r.height - 40)}px`;
  },

  /** The pill at the bottom of the stage: what you can do now. */
  hint() {
    const el = $("#hint");
    if (!el || !S.doc) return;
    const k = (t) => h("span.kbd", t);
    const sel = selected();
    let parts;
    if (S.pendingSymbol) parts = [h("span", T.hintPlaceSymbol)];
    else if (S.tool !== "select" && S.tool !== "hand") parts = [h("span", T.hintDraw)];
    else if (S.view.mode === "smooth") parts = [h("span", T.hintSmooth)];
    else if (sel.length > 1) parts = [h("span", T.hintMarquee), h("span", k(keyLabel("Shift")), " + ", T.hintClickAdds), h("span", k("Ctrl ]"), " ", T.hintForward)];
    else if (sel[0]?.type === "image") parts = [h("span", T.hintImage, " ", k("Ctrl"), " + ", k("V")), h("span", T.hintImageDots)];
    else if (sel[0]?.type === "barcode" || sel[0]?.type === "qr") parts = [h("span", T.hintCodeDbl), h("span", T.hintCodeDots)];
    else parts = [h("span", k(T.doubleClick), " ", T.hintEditText), h("span", k("Alt"), " + ", T.hintAltDrag), h("span", k(keyLabel("Shift")), " ", T.hintShiftAxis), h("span", k("Ctrl"), " + ", T.hintWheelZoom)];
    clear(el).append(...parts);
  },

  emptyState() {
    const el = $("#empty-label");
    if (!el) return;
    const empty = S.doc && !S.doc.objects.length && this.view === "editor";
    el.hidden = !empty;
    if (!empty) return;
    if (el.dataset.built === LANG + S.doc.label.length + S.doc.label.media) { this.placeEmpty(); return; }
    el.dataset.built = LANG + S.doc.label.length + S.doc.label.media;
    clear(el).append(
      h("div.empty-card",
        h("b", T.emptyLabel(fmtNum(labelLength(S.doc), 0))),
        h("span", h("span.kbd", "T"), ` ${T.wText} · `, h("span.kbd", "Q"), ` QR · `, h("span.kbd", "I"), ` ${T.wImage} · ${T.orDropFile}`)),
      h("div.empty-actions",
        button(T.writeText, { size: "sm", onClick: () => this.insert("text") }),
        button(T.useTemplate, { size: "sm", onClick: () => Dialogs.templates() }),
        button(T.cmdLinkData, { size: "sm", onClick: () => DataUI.connect() })),
    );
    this.placeEmpty();
  },

  placeEmpty() {
    const el = $("#empty-label");
    if (el.hidden || !S.raster) return;
    const [x0, y0] = mmToScreen(0, 0);
    const w = S.raster.width * S.view.zoom, hh = TAPE_MM * pxPerMm();
    Object.assign(el.style, { left: `${x0}px`, top: `${y0}px`, width: `${w}px`, height: `${hh}px` });
  },

  /** Warnings over the stage: printer not reachable, battery low, the wrong media inserted. */
  banners() {
    const el = $("#banners");
    if (!el || !S.doc) return;
    const items = [];
    const p = this.printer;
    // Rebuild only when something changed: the area is a live region, and a rebuild would
    // announce the same warning again and take the focus away from its buttons.
    const lowBattery = p.state === "ok" && p.info.battery !== null && p.info.battery <= 15;
    const mismatch = p.state === "ok" && p.info.paper && p.info.paper !== (S.doc.label.media === "continuous" ? "continuous" : "gap");
    const key = JSON.stringify([LANG, lowBattery && p.info.battery, mismatch && p.info.paper]);
    if (el.dataset.key === key && this._bannerJob === this.pendingPrint) return;
    el.dataset.key = key;
    this._bannerJob = this.pendingPrint;
    if (this.pendingPrint) {
      items.push(h("div.alert",
        ico("alert"),
        h("div", h("p.t", T.noReplyTitle), h("p.x", T.noReplyWaiting)),
        swRow(T.printWhenBack, this.pendingPrint.auto, (v) => { this.pendingPrint.auto = v; this.watchPrinter(); }),
        button(T.cancel, { variant: "ghost", size: "sm", onClick: () => { this.pendingPrint = null; this.banners(); } })));
    }
    if (lowBattery) {
      items.push(h("div.banner", ico("battery"), h("span", T.batteryLow(p.info.battery))));
    }
    if (mismatch) {
      items.push(h("div.banner", ico("info"), h("span", p.info.paper === "continuous" ? T.mismatchContinuous : T.mismatchGap),
        button(T.adapt, { size: "sm", onClick: () => this.setMedia(p.info.paper) })));
    }
    clear(el).append(...items);
  },

  /** With "print when it is back", try the printer every 15 seconds. */
  watchPrinter() {
    clearTimeout(this._watch);
    if (!this.pendingPrint?.auto) return;
    this._watch = setTimeout(async () => {
      if (!this.pendingPrint?.auto) return;
      await this.refreshPrinter(true);
      if (this.printer.state === "ok" && this.pendingPrint) {
        const job = this.pendingPrint;
        this.pendingPrint = null;
        this.banners();
        Dialogs.resumePrint(job);
      } else this.watchPrinter();
    }, 15000);
  },

  // ---------------------------------------------------------------- dropped files
  wireDrops() {
    const zone = $("#dropzone");
    let depth = 0;
    const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    document.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      depth++;
      if (this.view === "editor") { zone.hidden = false; this.renderDropzone(e); }
      else Home.dragOver?.(true);
    });
    document.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      if (--depth <= 0) { depth = 0; zone.hidden = true; Home.dragOver?.(false); }
    });
    document.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    document.addEventListener("drop", (e) => {
      depth = 0;
      zone.hidden = true;
      Home.dragOver?.(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      this.handleDrop([...e.dataTransfer.files], e);
    });
  },

  renderDropzone() {
    clear($("#dropzone")).append(h("div", ico("upload", 22), h("b", T.dropTitle), h("span", T.dropText)));
  },

  /** Images go on the label; .qutie files open; workbooks and tables become the data source. */
  async handleDrop(files, e) {
    const paths = await new Promise((resolve) => {
      this._dropWait = resolve;
      setTimeout(() => { if (this._dropWait === resolve) { this._dropWait = null; resolve([]); } }, 600);
    });
    const at = this.view === "editor" && e ? screenToMm(...pointerPos(e)) : null;
    for (const file of files) {
      const name = file.name.toLowerCase();
      const path = paths.find((p) => p.toLowerCase().endsWith(`\\${name}`) || p.toLowerCase().endsWith(`/${name}`)) || null;
      if (name.endsWith(".qutie")) {
        if (!(await this.confirmDiscard())) return;
        if (path) await this.open(path);
        else {
          try { this.setDocument(JSON.parse(await readFileAs(file, "text")), { fresh: true }); } catch { toast(T.openFailed, { kind: "error" }); }
        }
        return;
      }
      if (file.type.startsWith("image/")) {
        if (this.view !== "editor") this.newBlank();
        await new Promise((r) => setTimeout(r, 50));
        if (this.view === "editor") this.addImageFile(file, at && at[0] >= 0 ? { x: at[0] } : null);
        continue;
      }
      if (/\.(xlsx|xlsm|csv|tsv|txt|json)$/.test(name)) {
        if (this.view !== "editor") {
          if (!(await this.confirmDiscard())) return;
          this.setDocument(newDocument(), { fresh: true });
        }
        DataUI.connect({ file: path ? { path } : { file } });
        return;
      }
    }
  },

  /** Paths of the dropped files, from the app (pywebview). */
  droppedPaths(paths) {
    if (this._dropWait) { const r = this._dropWait; this._dropWait = null; r(paths); }
  },
};

// ------------------------------------------------------------------ theme and language
function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme; else delete root.dataset.theme;
  try { localStorage.setItem("qutie.theme", theme || "system"); } catch { /* private mode */ }
  readColors();
  invalidate();
}

/** Language from the settings; reloads the page when it changes. Returns true when reloading. */
function chooseLanguage(setting) {
  const wanted = !setting || setting === "auto" ? pickLanguage(true) : setting;
  try {
    if ((localStorage.getItem("qutie.lang") || "auto") !== (setting || "auto")) localStorage.setItem("qutie.lang", setting || "auto");
  } catch { /* private mode */ }
  if (wanted !== LANG && STUDIO_STRINGS[wanted]) {
    location.reload();
    return true;
  }
  return false;
}

window.Studio = Studio;
// After every redraw of the stage, the overlays follow the label (zoom, pan, moves).
S.afterDraw = () => { Studio.placeEmpty(); Studio.positionFloatbar(); };
Studio.boot();
