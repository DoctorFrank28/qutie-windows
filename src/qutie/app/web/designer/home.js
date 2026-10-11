"use strict";
/* Home: the start page and its sections (templates, my labels, data sources, print
 * history, printer, settings).
 */

const NAV = [["home", "home"], ["templates", "templates"], ["labels", "folder"], ["sources", "table"], ["history", "history"], "-", ["printer", "printer"], ["settings", "settings"]];
const WIN_SIZES = [["Q12X30", "12 × 30 mm"], ["Q12X40", "12 × 40 mm"], ["Q12X50", "12 × 50 mm"], ["Q12X70", "12 × 70 mm"], ["Q12X100", "12 × 100 mm"]];
const HISTORY_PAGE = 100; // history entries rendered at a time
const LANGUAGES =[["auto", null], ["en", "English"], ["it", "Italiano"], ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"], ["pt", "Português"], ["ru", "Русский"], ["zh", "中文"], ["ja", "日本語"]];

const Home = {
  page: "home",
  lib: null, tpls: null, srcs: null, hist: null, win: null,
  folder: "", selected: null, query: "", layout: "list", histFilter: "all", tplCat: "all", tplMedia: "any",
  hiddenJobs: new Set(), // history entries removed, still undoable

  build() {
    this.nav = $("#home-nav");
    this.main = $("#home-page");
    this.renderNav();
  },

  renderNav() {
    clear(this.nav);
    for (const item of NAV) {
      if (item === "-") { this.nav.append(h("span.spacer")); continue; }
      const [key, iconName] = item;
      const count = key === "templates" ? (this.tpls ? templates().length - 1 + this.tpls.length : null) : key === "labels" ? this.lib?.labels.length : key === "sources" ? this.srcs?.length : null;
      this.nav.append(h(`button.hnav${this.page === key ? ".on" : ""}`, { type: "button", "aria-current": this.page === key ? "page" : null, onclick: () => Studio.show("home", key) },
        ico(iconName), T[`nav_${key}`], count ? h("small", fmtCount(count)) : null));
    }
  },

  async show(page) {
    this.page = page;
    this.renderNav();
    clear(this.main);
    this.main.scrollTop = 0;
    const render = this[`page_${page}`] || this.page_home;
    await render.call(this);
    this.renderNav();
  },

  rerender() { if (Studio.view === "home") this.show(this.page); },

  /** Re-render after choosing an item of a list: keep the scroll and the keyboard focus on it. */
  async reselect(key) {
    if (Studio.view !== "home") return;
    const focused = this.main.contains(document.activeElement);
    const top = this.main.scrollTop;
    await this.show(this.page);
    this.main.scrollTop = top;
    if (focused) [...this.main.querySelectorAll("[data-key]")].find((el) => el.dataset.key === key)?.focus({ preventScroll: true });
  },
  recentChanged() { if (Studio.view === "home" && this.page === "home") this.rerender(); },
  printerChanged() { if (Studio.view === "home" && (this.page === "home" || this.page === "printer")) this.rerender(); },
  historyChanged() { this.hist = null; if (Studio.view === "home" && (this.page === "home" || this.page === "history")) this.rerender(); },
  templatesChanged() { this.tpls = null; },

  async loadLib(force = false) { if (!this.lib || force) this.lib = await api("library").catch(() => ({ root: "", labels: [], folders: [] })); return this.lib; },
  async loadTpls(force = false) { if (!this.tpls || force) this.tpls = await api("templates").catch(() => []); return this.tpls; },
  async loadSrcs(force = false) { if (!this.srcs || force) this.srcs = await api("sources").catch(() => []); return this.srcs; },
  async loadHist(force = false) { if (!this.hist || force) this.hist = await api("history").catch(() => ({ entries: [], stats: null })); return this.hist; },

  head(title, desc, ...tools) {
    return h("div.hhead", h("div", h("h1", title), desc ? h("p", desc) : null), tools.length ? h("div.tools", ...tools) : null);
  },

  dragOver(on) { this.main?.classList.toggle("dragging", on); },

  // ---------------------------------------------------------------- start page
  async page_home() {
    const m = this.main;
    const cols = h("div.home-cols");
    const main = h("div.home-main");
    const right = h("aside.home-right");
    cols.append(main, right);
    m.append(cols);
    const first = !Studio.recent.length && !Studio.state?.mac && Studio.printer.state !== "ok";
    if (first) main.append(h("div.welcome", h("h1", T.welcome), h("p.desc", T.welcomeText)));
    if (!Studio.state?.printer_installed && Studio.printer.state !== "ok" && !Studio.state?.mac) {
      main.append(h("div.banner", ico("bluetooth"), h("span", h("b", T.noPrinterPaired), " ", T.noPrinterPairedText), button(T.setupPrinter, { variant: "primary", size: "sm", onClick: () => api("open_setup", "install") })));
    }
    main.append(h("h1", T.newLabel), this.quickBar(), this.starts());
    const recent = h("section.recent-sec", h("div.row.between", h("h2", T.recent), h("span.desc", T.dropHere)));
    if (Studio.recent.length) {
      recent.append(h("div.recent", ...Studio.recent.slice(0, 4).map((r) => h("button.rc", { type: "button", onclick: () => Studio.open(r.path) },
        h("div.th", r.doc ? thumbCanvas(r.doc, "minil") : h("div.minil")),
        h("div.meta", h("b", { title: r.name }, r.name), h("small", [relTime(r.modified), r.data ? T.rowsFrom(r.rows, r.data) : `12 × ${fmtNum(r.length, 0)} mm`].join(" · ")))))));
    } else {
      recent.append(h("div.empty-state.wide", h("div.ic", ico("templates", 22)), h("b", T.noLabelsYet), h("p", T.noLabelsYetText),
        h("div.row", button(T.browseTemplates, { size: "sm", onClick: () => Studio.show("home", "templates") }), button(T.newLabel, { variant: "primary", size: "sm", onClick: () => Studio.newBlank() }))));
    }
    main.append(recent, notice(T.printFromApps));
    right.append(this.printerBox(), await this.latestBox());
  },

  quickBar() {
    const input = h("input", { type: "text", placeholder: T.quickPlaceholder, "aria-label": T.quickPrint, spellcheck: "false", autocomplete: "off" });
    let length = Studio.config.quick_length || "40";
    const lenSeg = seg([{ value: "40", label: "40 mm" }, { value: "auto", label: T.auto }], length === "auto" ? "auto" : "40", (v) => { length = v; Studio.setConfig({ quick_length: v }); }, { small: true });
    const doPrint = () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      const doc = quickDocument(text, length);
      Dialogs.runPrint({ doc, plan: labelPlan(doc), source: "quick", name: `«${text}»` });
      input.value = "";
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") doPrint(); });
    return h("div.quick", ico("text"), input, lenSeg,
      button(T.openInEditor, { size: "sm", onClick: () => { const t = input.value.trim(); if (t) Studio.newWithText(t); else Studio.newBlank(); } }),
      button(T.print, { variant: "primary", size: "sm", icon: "printer", onClick: doPrint }));
  },

  starts() {
    const blank = h("div.start",
      h("button.start-main", { type: "button", onclick: () => Studio.newBlank(40) }, h("div.ic", ico("filePlus")), h("b", T.blank)),
      h("div.chips", ...[30, 40, 50, 70].map((n) => chip(String(n), { onClick: () => Studio.newBlank(n), on: n === 40, title: `${n} mm` })), chip(T.continuousShort, { onClick: () => Studio.newBlank(40, "continuous") })));
    const card = (iconName, title, text, onClick) => h("button.start", { type: "button", onclick: onClick }, h("div.ic", ico(iconName)), h("b", title), h("p", text));
    return h("div.starts", blank,
      card("templates", T.fromTemplate, T.fromTemplateText, () => Studio.show("home", "templates")),
      card("table", T.fromData, T.fromDataText, async () => { if (await Studio.confirmDiscard()) { Studio.setDocument(newDocument(), { fresh: true }); DataUI.connect(); } }),
      card("qr", T.qrCode, T.qrCodeText, async () => { if (await Studio.confirmDiscard()) { Studio.setDocument(newDocument(), { fresh: true }); CodesUI.generator(); } }));
  },

  printerBox() {
    const p = Studio.printer;
    const info = p.info || {};
    const box = h("section.box",
      h("div.row.between", h("h2", T.printer), badge(p.state === "ok" ? T.connected : p.state === "reading" ? T.reading : T.notReachable, p.state === "ok" ? "ok" : p.state === "off" ? "warn" : "")),
      h("div.row", h("span.typeic", ico("printer")), h("div.col", h("strong", info.model ? `HPRT ${info.model}` : "HPRT Qutie"),
        h("span.desc", p.state === "ok" ? `${T.firmware} ${info.firmware} · ${T.density} ${info.density}` : p.state === "off" ? T.printerHint : T.printerReading))));
    if (p.state === "ok") {
      box.append(h("div.ctl", h("div.ctl-l", h("span", T.battery), h("b", fmtPercent(info.battery))), h("div.bat", h("span", { style: { width: `${Math.min(100, info.battery)}%` } }))),
        h("div.row.between", h("span.desc", T.mediaInsertedLabel), h("span", info.paper === "continuous" ? T.mediaContinuous : T.mediaGap)));
    }
    box.append(h("div.g2",
      button(T.feedTape, { size: "sm", onClick: () => Studio.printerAction("feed") }),
      button(T.printTest, { size: "sm", onClick: () => Studio.printerAction("test_label") })));
    if (p.state !== "ok") box.append(button(T.readAgain, { variant: "ghost", size: "sm", icon: "refresh", onClick: () => Studio.refreshPrinter(true) }));
    return box;
  },

  async latestBox() {
    const hist = await this.loadHist();
    const box = h("section.box", h("div.row.between", h("h2", T.latestPrints), h("span.desc", T.oneClickReprint)));
    const list = h("div.hist");
    const entries = hist.entries.filter((e) => !this.hiddenJobs.has(e.id));
    for (const e of entries.slice(0, 4)) {
      list.append(h("div.hi", h("div.t", { title: this.jobName(e) }, this.jobName(e), h("small", `${relTime(e.time, { time: true })} · ${this.jobSource(e)} · ${T.nLabels(e.count)}`)),
        button(e.ok ? T.reprint : T.retry, { variant: "ghost", size: "sm", onClick: () => this.reprint(e) })));
    }
    if (!entries.length) list.append(h("p.desc", T.noPrintsYet));
    box.append(list);
    if (entries.length) box.append(button(T.allHistory, { variant: "ghost", size: "sm", onClick: () => Studio.show("home", "history") }));
    return box;
  },

  jobName(e) { return e.name || (e.source === "windows" ? T.fromWindows : T.untitled); },
  jobSource(e) { return e.source === "windows" ? T.srcWindows : e.source === "quick" ? T.srcQuick : T.srcStudio; },

  async reprint(e, { reread = false } = {}) {
    if (reread) {
      const detail = await api("history_detail", e.id);
      if (!detail?.doc) { toast(T.cannotReread); return; }
      const doc = normalizeDocument(JSON.parse(detail.doc));
      Studio.setDocument(doc, { path: e.path || null });
      Dialogs.print();
      return;
    }
    toast(T.printingNow);
    const r = await api("reprint", e.id).catch((err) => ({ ok: false, detail: String(err) }));
    if (r.ok) toast(T.nPrinted(e.count), { kind: "ok", detail: this.jobName(e) });
    else toast(T.printerUnreachable, { kind: "error", detail: r.detail });
    this.historyChanged();
  },

  // ---------------------------------------------------------------- templates
  async page_templates() {
    const user = await this.loadTpls();
    const built = templates().filter((t) => t.id !== "blank");
    const count = (cat) => built.filter((t) => cat === "all" || t.cats.includes(cat)).length;
    const media = (t) => (t.doc.label.media === "continuous" ? "continuous" : "gap");
    const search = textInput({ placeholder: T.searchTemplates, lead: "search", label: T.searchTemplates, value: this.query, onInput: debounce((v) => { this.query = v; this.rerender(); }, 250) });
    this.main.append(
      this.head(T.nav_templates, T.templatesPageDesc, search, button(T.importQutie, { size: "sm", icon: "upload", onClick: async () => { const r = await api("import_template"); if (r?.ok) { this.tpls = null; this.rerender(); } } })),
      h("div.row",
        seg([{ value: "all", label: `${T.catAll} · ${count("all")}` }, { value: "kitchen", label: `${T.catKitchen} · ${count("kitchen")}` }, { value: "home", label: `${T.catHome} · ${count("home")}` }, { value: "data", label: `${T.catData} · ${count("data")}` }], this.tplCat, (v) => { this.tplCat = v; this.rerender(); }),
        h("span.spacer"),
        seg([{ value: "any", label: T.anyLength }, { value: "gap", label: T.gapShort }, { value: "continuous", label: T.continuousShort }], this.tplMedia, (v) => { this.tplMedia = v; this.rerender(); })));
    const q = this.query.toLowerCase();
    const keep = (name, note, cats, med) => (!q || `${name} ${note}`.toLowerCase().includes(q)) && (this.tplCat === "all" || cats.includes(this.tplCat)) && (this.tplMedia === "any" || med === this.tplMedia);
    const mine = user.filter((u) => keep(u.name, u.description, [u.category, "data"].filter(Boolean), u.media));
    this.main.append(h("div.sect", h("h2", T.myTemplates), h("span.sub", T.myTemplatesHint)));
    const grid = h("div.tg4");
    for (const u of mine) {
      const tpl = { id: u.id, name: u.name, doc: u.doc, user: true, askSource: u.doc?.template?.ask_source };
      grid.append(h("div.cardx.tc", h("div.thumb", thumbCanvas(u.doc, "minil")),
        h("div.meta", h("b", { title: u.name }, u.name, u.data ? badge(T.badgeData) : null), h("span.sub", [`12 × ${fmtNum(u.length, 0)} mm`, u.data || u.description].filter(Boolean).join(" · "))),
        h("div.acts",
          button(T.use, { variant: "primary", size: "sm", onClick: () => Studio.fromTemplate(tpl) }),
          button(T.edit, { size: "sm", onClick: () => Studio.confirmDiscard().then((ok) => ok && Studio.open(u.path)) }),
          iconButton("more", T.more, (e) => showMenu([
            { label: T.showInFolder, action: () => api("file_action", "reveal", u.path) },
            { label: T.deleteTemplate, danger: true, action: () => this.deleteTemplate(u) },
          ], { anchor: e.currentTarget, align: "end" })))));
    }
    if (S.doc) grid.append(h("button.cardx.tc.add", { type: "button", onclick: () => Dialogs.saveTemplate() }, ico("plus"), T.saveOpenAsTemplate));
    else if (!mine.length) grid.append(h("div.cardx.tc.add", ico("info"), T.noUserTemplates));
    this.main.append(grid);
    this.main.append(h("div.sect", h("h2", T.builtIn), h("span.sub", T.builtInHint)));
    const g2 = h("div.tg4");
    const shownBuilt = built.filter((t) => keep(t.name, t.note, t.cats, media(t)));
    if (!shownBuilt.length) g2.append(h("div.cardx.tc.add", ico("search"), T.noTemplatesFound));
    for (const t of shownBuilt) {
      g2.append(h("button.cardx.tc", { type: "button", onclick: () => Studio.fromTemplate(t) },
        h("div.thumb", thumbCanvas(t.doc, "minil")), h("div.meta", h("b", t.name, t.badge ? badge(t.badge) : null), h("span.sub", t.note))));
    }
    this.main.append(g2);
  },

  async deleteTemplate(u) {
    const ok = await ask({ title: T.deleteTemplateQ(u.name), text: T.deleteTemplateText, buttons: [{ label: T.cancel, value: false }, { label: T.deleteTemplate, variant: "primary", danger: true, value: true }] });
    if (!ok) return;
    await api("delete_template", u.path);
    this.tpls = null;
    this.rerender();
  },

  // ---------------------------------------------------------------- my labels
  async page_labels() {
    const lib = await this.loadLib(true);
    const histAll = (await this.loadHist()).entries;
    const lastPrint = (path) => histAll.find((e) => e.path && e.path.toLowerCase() === path.toLowerCase());
    const printsOf = (path) => histAll.filter((e) => e.path && e.path.toLowerCase() === path.toLowerCase());
    const search = textInput({ placeholder: T.searchByName, lead: "search", label: T.searchByName, value: this.query, onInput: debounce((v) => { this.query = v; this.rerender(); }, 250) });
    this.main.append(this.head(T.nav_labels, T.labelsDesc, search,
      seg([{ value: "list", icon: "list", title: T.listView }, { value: "grid", icon: "grid", title: T.gridView }], this.layout, (v) => { this.layout = v; this.rerender(); }, { small: true, label: T.viewMode }),
      button(T.newShort, { variant: "primary", size: "sm", icon: "plus", onClick: () => Studio.newBlank() })));
    const folders = [...new Set(lib.labels.map((l) => l.folder.split("/")[0]).filter(Boolean)), ...lib.folders.filter((f) => !f.includes("/"))];
    const uniq = [...new Set(folders)];
    const withData = lib.labels.filter((l) => l.data).length;
    this.main.append(h("div.chips",
      chip(`${T.all} · ${lib.labels.length}`, { on: this.folder === "", onClick: () => { this.folder = ""; this.rerender(); } }),
      ...uniq.map((f) => chip(`${f} · ${lib.labels.filter((l) => l.folder.split("/")[0] === f).length}`, { on: this.folder === f, onClick: () => { this.folder = f; this.rerender(); } })),
      withData ? chip(`${T.withData} · ${withData}`, { on: this.folder === "\u0000data", onClick: () => { this.folder = "\u0000data"; this.rerender(); } }) : null,
      chip(T.addFolder, { icon: "plus", onClick: (e) => this.newFolder(e.currentTarget) })));
    const q = this.query.toLowerCase();
    const shown = lib.labels.filter((l) => (this.folder === "" || (this.folder === "\u0000data" ? l.data : l.folder.split("/")[0] === this.folder)) && (!q || `${l.name} ${l.text || ""}`.toLowerCase().includes(q)));
    if (!lib.labels.length) {
      this.main.append(h("div.empty-state.wide", h("div.ic", ico("folder", 22)), h("b", T.noLabelsYet), h("p", T.labelsEmptyText(lib.root)), button(T.newLabel, { variant: "primary", size: "sm", onClick: () => Studio.newBlank() })));
      return;
    }
    if (!shown.length) {
      this.main.append(h("div.empty-state.wide", h("div.ic", ico("search", 22)), h("b", T.noResults)));
      return;
    }
    if (!shown.some((l) => l.path === this.selected)) this.selected = shown[0]?.path || null;
    const split = h("div.split");
    const fmt = (l) => (l.media === "continuous" ? (l.auto ? T.continuousShort : `${T.continuousShort} · ${fmtNum(l.length, 0)}`) : `12 × ${fmtNum(l.length, 0)}`);
    if (this.layout === "grid") {
      split.append(h("div.lgrid", ...shown.map((l) => h(`button.cardx.tc${l.path === this.selected ? ".on" : ""}`, { type: "button", "aria-current": l.path === this.selected ? "true" : null, dataset: { key: l.path }, onclick: () => { this.selected = l.path; this.reselect(l.path); }, ondblclick: () => Studio.open(l.path) },
        h("div.thumb", l.doc ? thumbCanvas(l.doc, "minil") : h("div.minil")), h("div.meta", h("b", { title: l.name }, l.name), h("span.sub", `${fmt(l)} · ${relTime(l.modified)}`))))));
    } else {
      const rows = shown.map((l) => {
        const last = lastPrint(l.path);
        const tr = h(`tr${l.path === this.selected ? ".on" : ""}`, { tabindex: "0", "aria-current": l.path === this.selected ? "true" : null, dataset: { key: l.path }, onclick: () => { this.selected = l.path; this.reselect(l.path); }, ondblclick: () => Studio.open(l.path) },
          h("td", h("div.lt", l.doc ? thumbCanvas(l.doc, "lt-canvas") : null)),
          h("td", h("b", { title: l.name }, l.name), h("div.sub", l.folder || (l.inside ? T.mainFolder : T.elsewhere))),
          h("td.mono", fmt(l)),
          h("td", l.data ? badge(l.data) : l.variables?.length ? badge(l.variables.join(" "), "mono") : h("span.sub", "—")),
          h("td", relTime(l.modified, { time: true })),
          h("td", last ? `${relTime(last.time)} · ${last.count}` : h("span.sub", T.never)),
          h("td", iconButton("more", T.more, (e) => { e.stopPropagation(); this.labelMenu(l, e.currentTarget); })));
        tr.addEventListener("keydown", (e) => {
          if (e.target !== tr) return; // keys on the row's own buttons stay theirs
          if (e.key === "Enter") Studio.open(l.path);
          else if (e.key === " ") { e.preventDefault(); this.selected = l.path; this.reselect(l.path); }
          else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); (e.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling)?.focus(); }
        });
        return tr;
      });
      split.append(h("div.cardx.tablecard", h("table.tbl", h("thead", h("tr", ...["", T.name, T.format, T.data, T.modifiedSort, T.lastPrint, ""].map((t) => h("th", { scope: "col" }, t)))), h("tbody", ...rows))));
    }
    const sel = shown.find((l) => l.path === this.selected);
    if (sel) {
      const prints = printsOf(sel.path);
      split.append(h("aside.cardx.det",
        h("div.thumb", sel.doc ? thumbCanvas(sel.doc, "minil big") : null),
        h("div", h("b", { title: sel.name }, sel.name), h("div.sub.mono.path", sel.path)),
        h("dl.facts",
          h("dt", T.format), h("dd", `${fmt(sel)} mm · ${sel.media === "continuous" ? T.mediaContinuous.toLowerCase() : T.mediaGap.toLowerCase()}`),
          h("dt", T.objects), h("dd", `${sel.objects} · ${(sel.types || []).map((t) => T[`type_${t}`]?.toLowerCase() || t).join(", ")}`),
          sel.variables?.length ? h("dt", T.variables) : null, sel.variables?.length ? h("dd.mono", sel.variables.join(" ")) : null,
          sel.data ? h("dt", T.data) : null, sel.data ? h("dd", T.rowsFrom(sel.rows, sel.data)) : null,
          h("dt", T.printed), h("dd", prints.length ? T.printedTimes(prints.length, relTime(prints[0].time)) : T.never)),
        h("div.g2",
          button(T.open, { variant: "primary", size: "sm", onClick: () => Studio.open(sel.path) }),
          button(T.print, { size: "sm", icon: "printer", onClick: async () => { if (await Studio.open(sel.path)) Dialogs.print(); } }),
          button(T.cmdDuplicate, { size: "sm", onClick: async () => { await api("file_action", "duplicate", sel.path); this.rerender(); } }),
          button(T.cmdRename, { size: "sm", onClick: () => this.rename(sel) })),
        h("div.row",
          button(T.showInFolder, { variant: "ghost", size: "sm", onClick: () => api("file_action", "reveal", sel.path) }),
          h("span.spacer"),
          button(T.moveToBin, { variant: "ghost", size: "sm", onClick: () => this.recycle(sel) }))));
    }
    this.main.append(split);
  },

  labelMenu(l, anchor) {
    const lib = this.lib;
    showMenu([
      { label: T.open, action: () => Studio.open(l.path) },
      { label: T.cmdDuplicate, action: async () => { await api("file_action", "duplicate", l.path); this.rerender(); } },
      { label: T.cmdRename, action: () => this.rename(l) },
      { label: T.moveTo, submenu: () => [{ label: T.mainFolder, action: () => this.move(l, "") }, ...lib.folders.map((f) => ({ label: f, action: () => this.move(l, f) }))] },
      { label: T.showInFolder, action: () => api("file_action", "reveal", l.path) },
      "-", { label: T.moveToBin, danger: true, action: () => this.recycle(l) },
    ], { anchor, align: "end" });
  },

  async move(l, folder) { await api("file_action", "move", l.path, folder); this.rerender(); },

  rename(l) {
    const input = textInput({ value: l.name, label: T.name });
    openDialog({
      title: T.cmdRename, body: field(T.name, input), width: 420,
      footer: [{ spacer: true }, { label: T.cancel }, {
        label: T.cmdRename, variant: "primary", action: async () => {
          const r = await api("file_action", "rename", l.path, input.input.value.trim());
          if (!r?.ok) { toast(T.renameFailed, { kind: "error", detail: r?.detail }); return false; }
          this.selected = r.path;
          this.rerender();
        },
      }],
    });
  },

  async recycle(l) {
    const backup = l.doc ? JSON.stringify(l.doc) : null;
    const r = await api("file_action", "recycle", l.path);
    if (!r?.ok) { toast(T.deleteFailed, { kind: "error" }); return; }
    this.rerender();
    toast(T.movedToBin(l.name), { duration: 8000, action: backup ? { label: T.undo, run: async () => { await api("file_action", "write", l.path, backup); this.rerender(); } } : null });
  },

  newFolder(anchor) {
    const input = textInput({ label: T.folderName, placeholder: T.folderName });
    const create = button(T.create, { variant: "primary", size: "sm", onClick: async () => {
      const name = input.input.value.trim();
      if (name) { await api("file_action", "new_folder", "", name); this.lib = null; this.rerender(); }
      pop.close();
    } });
    input.input.addEventListener("keydown", (e) => { if (e.key === "Enter") create.click(); });
    const content = h("div.form", h("h3", T.addFolderTitle), input, h("div.row.end", create));
    const pop = showPopover(content, anchor, { cls: "pad" });
    setTimeout(() => input.input.focus(), 0);
  },

  // ---------------------------------------------------------------- data sources
  async page_sources() {
    const srcs = await this.loadSrcs(true);
    this.main.append(this.head(T.nav_sources, T.sourcesDesc,
      button(T.refreshAll, { size: "sm", icon: "refresh", onClick: async () => { this.srcs = null; await this.show(this.page); toast(T.sourcesChecked); } }),
      button(T.cmdLinkData, { variant: "primary", size: "sm", icon: "plus", onClick: async () => { if (await Studio.confirmDiscard()) { Studio.setDocument(newDocument(), { fresh: true }); DataUI.connect(); } } })));
    if (!srcs.length) {
      this.main.append(h("div.empty-state.wide", h("div.ic", ico("table", 22)), h("b", T.noSources), h("p", T.noSourcesText)));
      return;
    }
    const key = (s) => s.path || s.labels[0]?.path;
    if (!srcs.some((s) => key(s) === this.selectedSrc)) this.selectedSrc = key(srcs[0]);
    const list = h("div.list");
    for (const s of srcs) {
      const missing = s.path && s.file && !s.file.exists;
      list.append(h(`button.cardx.src${key(s) === this.selectedSrc ? ".on" : ""}`, { type: "button", "aria-current": key(s) === this.selectedSrc ? "true" : null, dataset: { key: key(s) }, onclick: () => { this.selectedSrc = key(s); this.reselect(key(s)); } },
        h("div.ic", ico(s.path ? "fileSheet" : "table")),
        h("div", h("b", { title: s.path || s.name }, s.path ? s.path.split(/[\\/]/).pop() : s.name),
          h("div.sub", s.path ? [s.sheet ? T.sheetName(s.sheet) : null, T.nRows(s.count), T.nColumns(s.columns.length)].filter(Boolean).join(" · ") : T.tableIn(s.labels[0]?.name, s.count)),
          h("div.row", badge(missing ? T.fileMissing : s.path ? T.linked : T.internal, missing ? "warn" : s.path ? "ok" : ""),
            h("span.sub", missing ? T.usingCopyOf(relTime(s.copied)) : s.path ? T.usedByN(s.labels.length) : T.editableInApp)))));
    }
    const s = srcs.find((x) => key(x) === this.selectedSrc);
    const det = h("section.cardx.det");
    if (s) {
      const missing = s.path && s.file && !s.file.exists;
      det.append(
        h("div.row.between", h("div", h("b", { title: s.path || s.name }, s.path ? s.path.split(/[\\/]/).pop() : s.name), s.path ? h("div.sub.mono.path", s.path) : null),
          h("div.row",
            s.path && !missing ? button(T.openInExcel, { size: "sm", onClick: () => api("file_action", "open_with", s.path) }) : null,
            s.path ? button(missing ? T.findFile : T.changePath, { size: "sm", onClick: () => this.relink(s) }) : null)),
        h("div.g3",
          h("div.cardx.stat", h("div.sub", T.rows), h("b", fmtCount(s.count))),
          h("div.cardx.stat", h("div.sub", T.rereading), h("b", s.path ? (s.link === "copy" ? T.never : T.atEachPrint) : "—")),
          h("div.cardx.stat", h("div.sub", T.fileModified), h("b", s.file?.modified ? relTime(s.file.modified, { time: true }) : "—"))),
        h("div.ctl", h("div.ctl-l", h("span", T.columnsAndTypes)), h("div.colchips", ...s.columns.map((c) => h("span.cc", typeMark(c.type), c.name, c.type?.startsWith("ean") ? ` · ${T[`type_${c.type}Field`]}` : "")))),
        h("div.ctl", h("div.ctl-l", h("span", T.firstRows)), h("div.cardx.tablecard", h("table.tbl.mini",
          h("thead", h("tr", ...s.columns.slice(0, 6).map((c) => h("th", { scope: "col" }, c.name)))),
          h("tbody", ...s.rows.slice(0, 5).map((r) => h("tr", ...s.columns.slice(0, 6).map((c, i) => h(`td${c.type !== "text" ? ".mono" : ""}`, display(r[i], c.type) || "—")))))))),
        h("div.ctl", h("div.ctl-l", h("span", T.usedBy)), h("div.row.wrap", ...s.labels.map((l) => chip(l.name, { onClick: () => Studio.open(l.path) })), s.labels.length ? null : h("span.sub", "—"))));
    }
    this.main.append(h("div.split.sources", list, det));
  },

  /** A linked file moved: choose it again; every label that used the old path follows. */
  async relink(s) {
    const path = await api("pick_data_file");
    if (!path) return;
    const lib = await this.loadLib(true);
    let n = 0;
    for (const l of lib.labels) {
      const src = l.doc?.data?.source;
      if (src?.path && src.path.toLowerCase() === s.path.toLowerCase()) {
        src.path = path;
        src.name = path.split(/[\\/]/).pop();
        await api("file_action", "write", l.path, JSON.stringify(l.doc));
        n++;
      }
    }
    if (S.doc?.data?.source?.path?.toLowerCase() === s.path.toLowerCase()) { S.doc.data.source.path = path; S.doc.data.source.name = path.split(/[\\/]/).pop(); changed(); }
    toast(T.relinked(n), { kind: "ok" });
    this.srcs = null;
    this.rerender();
  },

  // ---------------------------------------------------------------- history
  async page_history() {
    const hist = await this.loadHist(true);
    const failed = hist.entries.filter((e) => !e.ok).length;
    this.main.append(this.head(T.nav_history, T.historyDesc(Studio.config.history_days || 90),
      seg([{ value: "all", label: T.all }, { value: "studio", label: T.srcStudio }, { value: "windows", label: T.srcWindowsShort }, { value: "failed", label: failed ? `${T.failed} · ${failed}` : T.failed }], this.histFilter, (v) => { this.histFilter = v; this.rerender(); }),
      button(T.clearHistory, { variant: "ghost", size: "sm", onClick: async () => {
        const ok = await ask({ title: T.clearHistoryQ, text: T.clearHistoryText, buttons: [{ label: T.cancel, value: false }, { label: T.clearHistory, variant: "primary", danger: true, value: true }] });
        if (ok) { await api("history_clear"); this.historyChanged(); }
      } })));
    const entries = hist.entries.filter((e) => !this.hiddenJobs.has(e.id)).filter((e) => this.histFilter === "all" || (this.histFilter === "failed" ? !e.ok : this.histFilter === "studio" ? e.source !== "windows" : e.source === "windows"));
    const col = h("div.hist-col");
    if (!entries.length && hist.entries.length) col.append(h("div.empty-state.wide", h("div.ic", ico("history", 22)), h("b", T.noResults)));
    else if (!entries.length) col.append(h("div.empty-state.wide", h("div.ic", ico("history", 22)), h("b", T.noPrintsYet), h("p", T.noPrintsYetText)));
    const clock = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });
    let day = null, card = null, shown = 0;
    // A long history renders HISTORY_PAGE entries at a time.
    const more = button(T.showOlder, { variant: "ghost", size: "sm", onClick: () => {
      const first = renderJobs();
      if (more.isConnected) more.focus(); else first?.querySelector("button")?.focus();
    } });
    const renderJobs = () => {
      more.remove();
      let first = null;
      for (const e of entries.slice(shown, shown + HISTORY_PAGE)) { const job = renderJob(e); first ??= job; }
      shown = Math.min(entries.length, shown + HISTORY_PAGE);
      if (shown < entries.length) col.append(more);
      return first;
    };
    const renderJob = (e) => {
      const d = new Date(e.time);
      const dayKey = d.toDateString();
      if (dayKey !== day) {
        day = dayKey;
        col.append(h("div.day", dayLabel(d)));
        card = h("div.cardx");
        col.append(card);
      }
      const counter = e.meta?.counter;
      const action = !e.ok
        ? button(T.retry, { variant: "primary", size: "sm", onClick: () => this.reprint(e) })
        : counter && e.path ? button(T.continueFrom(expand("{n}", { n: counter.to + 1, pad: counter.pad })), { size: "sm", onClick: () => this.continueSeries(e) })
        : button(e.meta?.data ? T.reprintEllipsis : T.reprint, { size: "sm", onClick: () => (e.meta?.data ? this.reprintChoice(e) : this.reprint(e)) });
      const sub = [clock.format(d), this.jobSource(e), e.meta?.data ? T.labelsFromRows(e.count, e.meta.rows, e.meta.data) : counter ? T.labelsCounter(e.count, expand("{n}", { n: counter.from, pad: counter.pad }), expand("{n}", { n: counter.to, pad: counter.pad })) : `${T.nLabels(e.count)}${e.length_mm ? ` 12 × ${fmtNum(e.length_mm, 0)} mm` : ""}`, e.meta?.fitted ? T.fittedToTape : null, !e.ok && e.error ? T.unreachableShort : null].filter(Boolean).join(" · ");
      return card.appendChild(h("div.job",
        h("div.strip", ...(e.thumbs || []).slice(0, 3).map((src) => h("img", { src, alt: "" }))),
        h("div.grow", h("b", { title: this.jobName(e) }, this.jobName(e)), h("div.sub", sub)),
        h("div.row", badge(e.ok ? T.printedBadge : T.notPrinted, e.ok ? "ok" : "warn"), action,
          iconButton("more", T.more, (ev) => showMenu([
            e.path ? { label: T.openLabel, action: () => Studio.open(e.path) } : null,
            e.ok && e.meta?.data ? { label: T.reprintSame, action: () => this.reprint(e) } : null,
            e.meta?.data || e.path ? { label: T.reprintReread, action: () => this.reprint(e, { reread: true }) } : null,
            "-", { label: T.removeFromHistory, danger: true, action: () => this.removeJob(e) },
          ].filter(Boolean), { anchor: ev.currentTarget, align: "end" })))));
    };
    renderJobs();
    const st = hist.stats || {};
    const maxWeek = Math.max(1, ...(st.weeks || [0]));
    const aside = h("aside.hist-side",
      h("div.cardx.stat", h("span.sub", T.thisMonth), h("b", T.nLabels(st.month_labels || 0)), h("span.sub", `${fmtLen(st.month_mm || 0)} ${T.ofTape} · ${T.nPrints(st.month_prints || 0)}`)),
      h("div.cardx.stat", h("span.sub", T.labelsPerWeek), h("div.bars", { role: "img", "aria-label": `${T.labelsPerWeek}: ${(st.weeks || []).join(", ")}` }, ...(st.weeks || [0, 0, 0, 0, 0]).map((v, i) => h(`span${i < 4 ? ".lo" : ""}`, { style: { height: `${Math.max(4, (v / maxWeek) * 100)}%` }, title: String(v) }))),
        h("div.row.between.sub", h("span", T.fiveWeeksAgo), h("span", T.thisWeek))),
      st.top ? h("div.cardx.stat", h("span.sub", T.mostPrinted), h("b", st.top.name || T.fromWindows), h("span.sub", T.topDetail(st.top.labels, st.top.prints))) : null,
      notice(T.reprintNote));
    this.main.append(h("div.split.history", col, aside));
  },

  /** Remove an entry with a few seconds to undo it; the history forgets it only afterwards. */
  removeJob(e) {
    this.hiddenJobs.add(e.id);
    this.rerender();
    let undone = false;
    toast(T.removedFromHistory, { duration: 6000, action: { label: T.undo, run: () => { undone = true; this.hiddenJobs.delete(e.id); this.rerender(); } } });
    setTimeout(async () => {
      if (undone) return;
      await api("history_remove", e.id).catch(() => {});
      this.hiddenJobs.delete(e.id);
      this.historyChanged();
    }, 6300);
  },

  async reprintChoice(e) {
    const choice = await ask({ title: T.reprintQ, text: T.reprintQText, buttons: [{ label: T.cancel, value: null }, { label: T.reprintSame, value: "same" }, { label: T.reprintReread, variant: "primary", value: "reread" }] });
    if (choice === "same") this.reprint(e);
    if (choice === "reread") this.reprint(e, { reread: true });
  },

  async continueSeries(e) {
    if (!(await Studio.open(e.path))) return;
    History.record(null, "edit");
    S.doc.series.start = e.meta.counter.to + (Number(S.doc.series.step) || 1);
    changed();
    Dialogs.print();
  },

  // ---------------------------------------------------------------- printer
  async page_printer() {
    const p = Studio.printer;
    const info = p.info || {};
    this.main.append(this.head(T.nav_printer, T.printerPageDesc,
      button(T.readAgain, { size: "sm", icon: "refresh", onClick: () => Studio.refreshPrinter(true) }),
      button(T.feedTape, { size: "sm", onClick: () => Studio.printerAction("feed") }),
      button(T.printTest, { variant: "primary", size: "sm", onClick: () => Studio.printerAction("test_label") })));
    const ok = p.state === "ok";
    this.main.append(h("div.cardx.card.device",
      h("div.dev", h("span")),
      h("div.grow",
        h("div.row", h("b", info.model ? `HPRT ${info.model}` : "HPRT Qutie"), badge(ok ? T.connected : p.state === "reading" ? T.reading : T.notReachable, ok ? "ok" : p.state === "off" ? "warn" : "")),
        ok ? h("div.row", h("div.bat", h("span", { style: { width: `${Math.min(100, info.battery)}%` } })), h("span.mono", fmtPercent(info.battery))) : h("p.desc", p.state === "off" ? T.printerHint : T.printerReading),
        ok ? h("div.sub", [info.paper === "continuous" ? T.continuousInserted : T.gapInserted, `${T.density} ${info.density}`, info.auto_off ? T.turnsOffAfter(info.auto_off) : null].filter(Boolean).join(" · ")) : null),
      ok ? h("dl.facts",
        h("dt", T.firmware), h("dd.mono", `${info.firmware}${info.bt ? ` · BT ${info.bt}` : ""}`),
        h("dt", T.serial), h("dd.mono", info.serial || "—"),
        h("dt", T.address), h("dd.mono", info.mac || "—"),
        h("dt", T.windowsPort), h("dd.mono", info.port || "—")) : null));

    const quality = h("section.cardx.card", h("h2", T.printQuality));
    if (ok) {
      const [lo, hi] = info.density_range || [50, 100];
      let density = Math.max(lo, Math.min(hi, info.density));
      const samples = h("div.samples", ...[60, 75, 90].map((d) => h("div", { style: { opacity: String(0.45 + (d - 50) / 90), fontWeight: d > 80 ? 700 : 500 } }, `Aa ${d}`)));
      quality.append(
        slider({ label: T.density, min: lo, max: hi, step: 5, value: density, onChange: async (v) => { density = v; const r = await api("apply_printer", v, null); toast(r?.ok ? T.savedInPrinter : T.printerUnreachable, { kind: r?.ok ? "ok" : "error" }); if (r?.ok) { Studio.printer.info.density = v; } } }),
        h("div.row.between.sub", h("span", T.lighter), h("span", T.darker)),
        samples, h("p.desc", T.densityDesc),
        h("div.set", h("div.t", h("b", T.autoOff), h("span.sub", T.autoOffDesc)),
          selectBox((info.auto_off_choices || [10, 15, 30, 60, 180, 240]).map((m) => ({ value: m, label: T.minutes(m) })), info.auto_off, async (v) => {
            const r = await api("apply_printer", null, Number(v));
            toast(r?.ok ? T.savedInPrinter : T.printerUnreachable, { kind: r?.ok ? "ok" : "error" });
          }, { label: T.autoOff })));
    } else quality.append(h("p.desc", T.qualityNeedsPrinter), button(T.readAgain, { size: "sm", icon: "refresh", onClick: () => Studio.refreshPrinter(true) }));

    const winBox = h("section.cardx.card", h("h2", T.windowsPrinter), h("p.desc", T.reading));
    this.main.append(h("div.grid2", quality, winBox));
    this.main.append(h("section.cardx.card",
      h("div.t", h("b", T.bluetoothLink), h("span.sub", T.bluetoothLinkDesc)),
      h("div.row",
        button(T.pairAgain, { size: "sm", onClick: () => api("open_setup", "install") }),
        button(T.pairAnother, { size: "sm", onClick: () => api("open_setup", "install") }),
        button(T.uninstall, { variant: "ghost", size: "sm", onClick: () => api("open_setup", "uninstall") }))));
    this.windowsBox(winBox);
  },

  async windowsBox(box) {
    const w = this.win || (this.win = await api("windows_printer").catch(() => null));
    clear(box).append(h("h2", T.windowsPrinter));
    if (!w?.printer) {
      box.append(h("div.set", h("div.t", h("b", "Qutie"), h("span.sub", T.windowsPrinterMissing)), badge(T.notInstalled, "warn")),
        button(T.installDriver, { size: "sm", onClick: () => api("open_setup", "install") }));
      return;
    }
    const d = w.defaults || {};
    const key = (name) => Object.keys(d).find((k) => k === name || k.endsWith(name));
    const feedKey = key("TapeFeed");
    const setDefault = async (feature, value) => {
      const r = await api("set_windows_defaults", { [feature]: value });
      if (r?.ok) { this.win.defaults = r.defaults; toast(T.saved, { kind: "ok" }); } else toast(T.saveFailed, { kind: "error", detail: r?.detail });
    };
    const sizes = [...WIN_SIZES, ["FIT_A5", T.fitToTape]];
    box.append(
      h("div.set", h("div.t", h("b", w.printer.Name || "Qutie"), h("span.sub", T.windowsPrinterDesc)), badge(T.installed, "ok")),
      h("div.set", h("div.t", h("b", T.defaultSize), h("span.sub", T.defaultSizeDesc)),
        selectBox([...sizes, ...(sizes.some(([v]) => v === d.PageMediaSize) ? [] : [[d.PageMediaSize || "", T.custom]])].map(([value, label]) => ({ value, label })), d.PageMediaSize, (v) => setDefault("PageMediaSize", v), { label: T.defaultSize })),
      h("div.set", h("div.t", h("b", T.previewBeforePrint), h("span.sub", T.previewBeforePrintDesc)), sw(w.preview, (v) => { api("set_preview", v); this.win.preview = v; }, T.previewBeforePrint)),
      feedKey ? h("div.set", h("div.t", h("b", T.feedAfter), h("span.sub", T.feedDesc)),
        selectBox([0, 5, 10, 15, 20, 25].map((mm) => ({ value: `F${mm}`, label: `${mm} mm` })), d[feedKey], (v) => setDefault(feedKey, v), { label: T.feedAfter })) : null,
      h("div.row",
        button(T.windowsTestPage, { size: "sm", onClick: async () => { const r = await api("test_windows"); toast(r?.ok ? T.testSent : T.saveFailed, { kind: r?.ok ? "ok" : "error", detail: r?.detail }); } }),
        button(T.printingPreferences, { variant: "ghost", size: "sm", onClick: () => api("open_windows", "preferences") })));
  },

  // ---------------------------------------------------------------- settings
  async page_settings() {
    const c = Studio.config;
    const set = (changes) => Studio.setConfig(changes);
    const row = (title, sub, control) => h("div.set", h("div.t", h("b", title), sub ? h("span.sub", sub) : null), control);
    const langName = (code) => LANGUAGES.find(([k]) => k === code)?.[1];
    const lang = selectBox(LANGUAGES.map(([k, name]) => ({ value: k, label: k === "auto" ? `${T.asWindows} · ${langName(pickLanguage(true)) || "English"}` : name })), c.language || "auto", (v) => set({ language: v }), { label: T.language });
    const fontBtn = h("button.select.font-btn", { type: "button", onclick: (e) => Dialogs.fontPicker(e.currentTarget, c.default_font || "Segoe UI", (f) => { set({ default_font: f }); this.rerender(); }) },
      h("span", { style: { fontFamily: fontFamily(c.default_font) } }, `${c.default_font || "Segoe UI"}${c.default_bold !== false ? ` · ${T.bold.toLowerCase()}` : ""}`), ico("chevron"));
    const autostart = Studio.state?.autostart;
    this.main.append(this.head(T.nav_settings, T.settingsDesc));
    this.main.append(h("div.grid2",
      h("div",
        h("section.cardx.card", h("h2", T.general),
          row(T.language, T.languageDesc, lang),
          row(T.theme, null, seg([{ value: "system", label: T.theme_system }, { value: "light", label: T.theme_light }, { value: "dark", label: T.theme_dark }], c.theme || "system", (v) => set({ theme: v }), { small: true })),
          row(T.startWithWindows, T.startWithWindowsDesc, sw(autostart, async (v) => { const now = await api("set_autostart", v); Studio.state.autostart = now; }, T.startWithWindows)),
          row(T.openOn, null, seg([{ value: "home", label: "Home" }, { value: "last", label: T.lastLabel }], c.open_on || "home", (v) => set({ open_on: v }), { small: true })),
          row(T.quickHotkey, keyLabel("Win+Shift+Q"), sw(c.quick_hotkey, (v) => set({ quick_hotkey: v }), T.quickHotkey))),
        h("section.cardx.card", h("h2", T.editor),
          row(T.defaultView, T.defaultViewDesc, seg([{ value: "dots", label: T.viewDotsShort }, { value: "smooth", label: T.viewSmoothShort }], c.default_view || "dots", (v) => set({ default_view: v }), { small: true })),
          row(T.units, null, seg([{ value: "mm", label: "mm" }, { value: "in", label: T.inches }, { value: "dots", label: T.dots }], c.units || "mm", (v) => set({ units: v }), { small: true })),
          row(T.arrowNudge, T.arrowNudgeDesc, seg([{ value: "dot", label: T.oneDot }, { value: "half", label: `${fmtNum(0.5, 1)} mm` }], c.nudge || "dot", (v) => set({ nudge: v }), { small: true })),
          row(T.defaultFont, null, h("div.row", fontBtn, toggles([{ value: "b", icon: "bold", title: T.bold }], () => c.default_bold !== false, () => { set({ default_bold: c.default_bold === false }); this.rerender(); }))))),
      h("div",
        h("section.cardx.card", h("h2", T.printAndData),
          row(T.confirmSeries, T.confirmSeriesDesc(c.confirm_limit || 50), sw(c.confirm_series !== false, (v) => set({ confirm_series: v }), T.confirmSeries)),
          row(T.checkCodes, T.checkCodesDesc, sw(c.check_codes !== false, (v) => set({ check_codes: v }), T.checkCodes)),
          row(T.rereadFiles, null, seg([{ value: "print", label: T.atEachPrint }, { value: "open", label: T.onOpen }, { value: "manual", label: T.manually }], c.reread || "print", (v) => set({ reread: v }), { small: true })),
          row(T.historyKeep, T.historyKeepDesc, selectBox([30, 90, 180, 365, 0].map((d) => ({ value: d, label: d ? T.nDays(d) : T.forever })), c.history_days ?? 90, (v) => set({ history_days: Number(v) }), { label: T.historyKeep }))),
        h("section.cardx.card", h("h2", T.files),
          row(T.labelsFolder, Studio.state?.library || "", button(T.change, { size: "sm", onClick: async () => { const f = await api("choose_folder", Studio.state?.library); if (f) { await set({ library_dir: f }); Studio.state.library = f; this.lib = null; this.rerender(); } } })),
          row(T.autosave, T.autosaveDesc, sw(c.autosave !== false, (v) => set({ autosave: v }), T.autosave)),
          row(T.qutieFiles, T.qutieFilesDesc, badge(Studio.state?.studio === false ? T.notInstalled : T.installed, Studio.state?.studio === false ? "" : "ok"))),
        h("section.cardx.card", h("h2", T.aboutSection),
          row(`Qutie Studio ${Studio.state?.version || ""}`, T.aboutLicense, button(T.cmdWhatsNew, { size: "sm", onClick: () => Dialogs.whatsNew() })),
          row(T.componentsInstalled, Studio.state?.studio === false ? T.driverOnly : T.driverAndStudioChecks, button(T.modifyInstall, { size: "sm", onClick: () => api("open_setup", "install") }))))));
  },
};

/** A percentage as the user's language writes it ("85 %" in French). */
function fmtPercent(v) {
  if (v === null || v === undefined || v === "") return "—"; // not known (e.g. battery not reported)
  try {
    return new Intl.NumberFormat(LOCALE, { style: "percent", maximumFractionDigits: 0 }).format(Number(v) / 100);
  } catch {
    return `${v}%`;
  }
}

/** A count with the language's thousands separator. */
function fmtCount(n) {
  try {
    return new Intl.NumberFormat(LOCALE).format(n);
  } catch {
    return String(n);
  }
}

/** "Today", "Yesterday" or "8 October" for the history. */
function dayLabel(d) {
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(d)) / 86400000);
  if (diff === 0) return T.todayCap;
  if (diff === 1) return T.yesterdayCap;
  try {
    return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "long", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}
