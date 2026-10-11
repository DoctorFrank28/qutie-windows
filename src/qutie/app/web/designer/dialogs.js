"use strict";
/* Dialogs and pickers: print (with the series preview and the progress), templates,
 * export, save as template, symbols, fonts, find and replace, shortcuts, the command
 * palette and the small help pages.
 */

const SYMBOLS = {
  symbols: "★☆♥♡✓✔✗✘⚠⚡♻❄☀☂☃☕♨✂✉☎⌂⚙⚑✿❀☘♫♪☺☹⚓⚐✈⚽♠♣♦⚫⚪©®™°±×÷€£$¥§¶†‡•…‰",
  arrows: "←↑→↓↔↕↖↗↘↙⇐⇑⇒⇓⇔➔➜➝➞➟➠➡⬅⬆⬇↩↪↺↻⤴⤵",
  home: "⌂☕♨✂✉☎⚙⚒⚖⚗⚛☢☣⚕⚱⚰⛏⛽⛺⛪⛲⛳⛵⛟⛔⛅☁☔⚾⚽",
  numbers: "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳❶❷❸❹❺❻❼❽❾❿⓪●■▲◆○□△◇",
  emoji: "😀😊😍🎉🎂🎁🍎🍓🍋🥕🌶🧄🧅🍯🥫🧂🍝🍕🍪☕🍷🧀🥚🐟🥩❄🔥⭐💡🔋🔌🔧🔑🏠📦📎✏📌📅🧪💊🌱🐶🐱",
};
const SYMBOL_NAMES = { "★": "star stella", "♥": "heart cuore", "✓": "check spunta ok", "✗": "x no", "⚠": "warning attenzione", "⚡": "lightning fulmine corrente", "♻": "recycle riciclo", "❄": "snowflake fiocco neve freezer congelatore", "☀": "sun sole", "☂": "umbrella ombrello", "☕": "coffee caffè tazza", "♨": "hot caldo", "✂": "scissors forbici", "✉": "mail lettera busta", "☎": "phone telefono", "⌂": "home casa", "⚙": "gear ingranaggio", "⚑": "flag bandiera", "✿": "flower fiore", "☘": "clover trifoglio", "♫": "music musica", "☺": "smile sorriso", "⚓": "anchor ancora", "→": "arrow freccia", "←": "arrow freccia", "↑": "arrow freccia", "↓": "arrow freccia" };

/* The fonts the Studio offers. At 203 dpi a 12 mm label is 96 dots tall, so text is often
 * 20–40 dots high: what survives is sturdy, even strokes, open shapes and clear digits.
 * Thin strokes, hairline serifs and scripts break up into dots. All of these come with
 * Windows 10/11 (Cascadia Mono with Windows 11); the picker hides those not installed.
 */
const FONT_GROUPS = [
  { key: "text", fonts: [{ name: "Segoe UI", note: "segoe" }, { name: "Arial", note: "arial" }, { name: "Verdana", note: "verdana" },
    { name: "Tahoma", note: "tahoma" }, { name: "Bahnschrift", note: "bahnschrift" }, { name: "Franklin Gothic Medium", note: "franklin" }] },
  { key: "titles", fonts: [{ name: "Arial Black", note: "arialBlack" }, { name: "Impact", note: "impact" }] },
  { key: "codes", fonts: [{ name: "Consolas", note: "consolas" }, { name: "Cascadia Mono", note: "cascadia" }] },
  { key: "serif", fonts: [{ name: "Georgia", note: "georgia" }] },
  { key: "hand", fonts: [{ name: "Segoe Print", note: "segoePrint" }, { name: "Ink Free", note: "inkFree" }] },
];

/** Whether the browser draws this family. The app's list names a file by its typographic
 * family ("Arial Black" is "Arial", style Black), so a family can be missing from it. */
function fontInstalled(name) {
  const ctx = (fontInstalled.ctx ||= document.createElement("canvas").getContext("2d"));
  const width = (family) => { ctx.font = `40px ${family}`; return ctx.measureText("mmmmmmmmmmlli0O").width; };
  return ["monospace", "serif"].some((base) => width(`"${name}", ${base}`) !== width(base));
}

const Dialogs = {
  // ---------------------------------------------------------------- print
  /** The print dialog: preview of the series, rows, repeats, media; then the progress. */
  async print(options = {}) {
    if (!S.doc) return;
    const doc = S.doc;
    const data = doc.data?.columns.length ? doc.data : null;
    if (data?.source.path && data.source.link !== "copy" && (Studio.config.reread || "print") === "print") {
      const ok = await DataUI.reload({ quiet: true });
      if (ok === false && data.source.path) toast(T.usingSavedCopy, { kind: "", detail: data.source.name });
    }
    const st = {
      which: options.rows ? "rows" : options.which || data?.which || "all",
      rows: options.rows || null,
      repeat: doc.series.repeat || 1, collate: doc.series.collate !== false,
      range: { ...(data?.range || { from: 1, to: data?.rows.length || 1 }) },
      count: doc.series.count || 1,
    };
    const body = h("div.print-body");
    const dlg = openDialog({ title: T.print, body, width: 1080, cls: "print-dlg" });
    const plan = () => labelPlan(doc, {
      which: st.which === "rows" ? undefined : st.which, rows: st.which === "rows" ? st.rows : undefined,
      repeat: st.repeat, collate: st.collate, count: st.count,
    });
    let seq = 0;
    const render = async () => {
      const my = ++seq;
      const items = plan();
      const L = labelLength(doc);
      const tape = items.length * (L + labelFeed(doc));
      const summary = h("p.desc", data ? T.printSummaryData(new Set(items.map((i) => i.row)).size, data.source.name, items.length, fmtNum(L, 0), fmtLen(tape)) : T.printSummary(items.length, fmtNum(L, 0), fmtLen(tape)));
      const previews = h("div.pv-list");
      const shown = [];
      const seen = new Set();
      for (const it of items) { const key = `${it.row}|${it.vars.n}`; if (seen.has(it.row ?? key) && data) continue; seen.add(it.row ?? key); shown.push(it); if (shown.length >= 6) break; }
      for (const it of shown) {
        const fig = h("figure.pfig", h("div.pl"), h("figcaption", data ? T.rowCaption(it.row + 1, it.texts?.[data.columns[0]?.name] || "") : T.labelN(it.vars.n), it.copies > 1 ? badge(`× ${it.copies}`) : null));
        previews.append(fig);
      }
      const more = (data ? new Set(items.map((i) => i.row)).size : items.length) - shown.length;
      if (more > 0) previews.append(h("span.more", T.andMore(more)));
      keepFocus(body, () => clear(body).append(h("div.print-head", summary), h("div.print-grid", h("div.pv-col", previews), this.printOptions(doc, st, items, render))));
      dlg.setFooter([
        { label: T.exportPng, icon: "download", action: () => { this.exporter("png", { plan: items }); } },
        { spacer: true },
        { label: T.cancel },
        { label: T.printN(items.length), variant: "primary", icon: "printer", disabled: !items.length, action: () => { this.runPrint({ plan: items, source: "studio" }); } },
      ]);
      // Draw the previews once their codes and images are ready.
      const rendered = await renderPlan(doc, shown);
      if (my !== seq) return;
      $$(".pfig .pl", previews).forEach((pl, i) => { const c = bitsToCanvas(rendered[i].raster); pl.append(c); });
    };
    render();
  },

  printOptions(doc, st, items, render) {
    const data = doc.data?.columns.length ? doc.data : null;
    const col = h("div.po-col");
    if (data) {
      const checked = data.checked?.length || 0;
      const n = visibleRows(data).length;
      const whichSeg = seg([
        { value: "all", label: T.allN(n) }, { value: "checked", label: T.checkedN(checked), disabled: !checked }, { value: "range", label: T.fromTo },
        ...(st.rows ? [{ value: "rows", label: T.thisRow }] : []),
      ], st.which, (v) => { st.which = v; data.which = v === "rows" ? data.which : v; render(); }, { full: true, label: T.data });
      const box = h("div.box",
        h("h3", T.data, h("span.sub", data.source.read ? ` ${T.updated} ${relTime(data.source.read, { time: true })}` : "")),
        h("div.row", h("div.inp.grow", ico("fileSheet", 14), h("span", [data.source.name, data.source.sheet].filter(Boolean).join(" › "))),
          data.source.path ? iconButton("refresh", T.reloadData, async () => { await DataUI.reload(); render(); }, { variant: "outline" }) : null),
        whichSeg);
      if (st.which === "range") {
        box.append(h("div.g2",
          numInput({ lead: T.leadFrom, value: st.range.from, decimals: 0, step: 1, min: 1, max: n, label: T.fromRow, onChange: (v) => { st.range.from = v; data.range = { ...st.range }; render(); } }),
          numInput({ lead: T.leadTo, value: st.range.to, decimals: 0, step: 1, min: 1, max: n, label: T.toRow, onChange: (v) => { st.range.to = v; data.range = { ...st.range }; render(); } })));
      }
      box.append(DataUI.filterChips(data));
      box.append(h("div.swrow", h("span", T.copiesFromColumn), selectBox([{ value: "", label: T.none }, ...fieldNames(data).map((f) => ({ value: f, label: f }))], data.copies || "", (v) => { History.record(null, "data"); data.copies = v || null; changed(); render(); }, { label: T.copiesFromColumn })));
      col.append(box);
    }
    const series = h("div.box", h("h3", T.series));
    if (!data && usesCounter(doc)) {
      series.append(h("div.row.between", h("span", T.howMany), numInput({ value: st.count, decimals: 0, step: 1, min: 1, max: 9999, label: T.howMany, width: "110px", onChange: (v) => { st.count = v; doc.series.count = v; render(); } })));
      series.append(h("p.desc", T.counterRange(expand("{n}", { n: doc.series.start, pad: doc.series.pad }), expand("{n}", { n: doc.series.start + (st.count - 1) * doc.series.step, pad: doc.series.pad }))));
    }
    series.append(h("div.row.between", h("span", data ? T.repeatSeries : T.copies), stepper(st.repeat, 1, 999, (v) => { st.repeat = v; doc.series.repeat = v; render(); }, data ? T.repeatSeries : T.copies)));
    if (st.repeat > 1 && (data || usesCounter(doc))) {
      series.append(seg([{ value: true, label: "1, 2, 3 · 1, 2, 3" }, { value: false, label: "1, 1 · 2, 2 · 3, 3" }], st.collate, (v) => { st.collate = v; doc.series.collate = v; render(); }, { full: true, label: T.collate }));
    }
    if (data) series.append(h("div.row.between", h("span", T.order), h("span.desc", data.sort?.field ? T.sortedBy(data.sort.field) : T.asInFile)));
    col.append(series);
    const p = Studio.printer;
    const media = doc.label.media === "continuous";
    col.append(h("div.box", h("h3", T.media),
      h("div", media ? T.mediaLineContinuous(fmtNum(labelLength(doc), 0), labelFeed(doc), doc.label.auto) : T.mediaLineGap(fmtNum(labelLength(doc), 0), labelFeed(doc))),
      p.state === "ok" ? notice(T.printerLine(p.info.battery, p.info.paper === "continuous" ? T.continuousInserted : T.gapInserted), { kind: p.info.paper !== (media ? "continuous" : "gap") ? "warn" : "" })
        : notice(p.state === "reading" ? T.printerReading : T.printerNotChecked, { action: button(T.check, { size: "sm", onClick: async () => { await Studio.refreshPrinter(true); render(); } }) })));
    const L = labelLength(doc);
    const seconds = Math.round(items.length * (2 + L / 25));
    col.append(h("div.total", T.total, " ", h("strong", T.nLabels(items.length)), ` · ${T.about} ${fmtDuration(seconds)}`));
    return col;
  },

  /**
   * Print a plan: confirm long series, check the codes, then send the labels one at a
   * time with progress; on error the rest can be printed later.
   */
  async runPrint({ plan, doc = S.doc, source = "studio", name = null, noHistory = false, start = 0, historyId = null, rendered = null }) {
    if (!plan.length) return;
    const limit = Studio.config.confirm_limit || 50;
    if (!start && Studio.config.confirm_series !== false && plan.length > limit) {
      const go = await this.confirmSeries(plan, doc);
      if (!go) return;
      if (go === "first10") plan = plan.slice(0, 10);
    }
    const prog = this.progress(doc, plan.length, name || doc.name);
    let labels = rendered;
    if (!labels) {
      const out = await renderPlan(doc, plan);
      labels = out.map((r) => toPng(r.raster));
      if (Studio.config.check_codes !== false) {
        const problem = await this.checkCodes(doc, out);
        if (problem && !(await this.codesProblem(problem))) { prog.close(); return; }
      }
    }
    const lengths = plan.map((item) => labelLength(doc, layoutFor(doc, { vars: item.vars, texts: item.texts, raw: item.raw, doc })));
    const media = mediaOf(doc, Math.max(...lengths));
    const job = {
      name: name || doc.name, source, doc: noHistory ? null : JSON.stringify(cleanDocumentOf(doc)), history_id: historyId,
      tape_mm: Math.round(lengths.reduce((s, l) => s + l + labelFeed(doc), 0)), no_history: noHistory,
      meta: { rows: doc.data?.columns.length ? new Set(plan.map((i) => i.row)).size : 0, data: doc.data?.source?.name || null, counter: usesCounter(doc) ? { from: plan[0].vars.n, to: plan[plan.length - 1].vars.n, pad: doc.series.pad } : null },
    };
    // With continuous tape every label has its own length; gap labels are all the same.
    const groups = doc.label.media === "continuous" ? lengths.map((l, i) => ({ from: i, to: i + 1, media: mediaOf(doc, l) })) : [{ from: 0, to: labels.length, media }];
    let printed = start, result = { ok: true };
    prog.update(printed, plan[printed]);
    const poll = setInterval(async () => {
      const s = await api("print_status").catch(() => null);
      if (s?.running) prog.update(printed + s.done, plan[Math.min(plan.length - 1, printed + s.done)]);
    }, 400);
    try {
      for (const g of groups) {
        if (g.to <= printed) continue;
        const from = Math.max(g.from, printed);
        result = await api("print_labels", labels.slice(from, g.to), g.media, { ...job, history_id: job.history_id }).catch((e) => ({ ok: false, printed: 0, detail: String(e) }));
        if (result.history_id) job.history_id = result.history_id;
        printed = from + (result.printed || 0);
        prog.update(printed, plan[Math.min(plan.length - 1, printed)]);
        if (!result.ok || result.stopped || prog.stopped) break;
      }
    } finally {
      clearInterval(poll);
    }
    prog.close();
    Studio.refreshPrinter(true);
    Home.historyChanged?.();
    const resume = { plan, doc, source, name, noHistory, start: printed, historyId: job.history_id, rendered: labels };
    if (result.ok && printed >= plan.length) {
      this.advanceCounter(doc, plan);
      this.success(doc, plan, job, resume);
    } else if (result.ok) {
      toast(T.stoppedAfter(printed, plan.length), { action: { label: T.printRest, run: () => this.runPrint(resume) } });
    } else this.failure(doc, plan, printed, result, resume);
  },

  resumePrint(job) { this.runPrint(job); },

  /** After a counter series, the next one starts where this one ended. */
  advanceCounter(doc, plan) {
    if (!usesCounter(doc) || doc.series.advance === false || doc !== S.doc) return;
    History.record(null, "edit");
    doc.series.start = plan[plan.length - 1].vars.n + (Number(doc.series.step) || 1);
    changed();
  },

  progress(doc, total, name) {
    const preview = h("div.lab");
    const line = h("div.row.between", h("span"), h("span.mono"));
    const bar = h("div.prog", { role: "progressbar", "aria-label": T.printing, "aria-valuemin": "0", "aria-valuemax": String(total), "aria-valuenow": "0" }, h("span"));
    const d = openDialog({
      title: T.printing, description: `${name} · ${T.nLabels(total)}`, width: 460, escape: false,
      body: h("div.progress-body", preview, line, bar, notice(T.tearAsYouGo)),
      footer: [{ label: T.stopAfterThis, action: () => { d.stopped = true; api("stop_print"); return false; } }],
    });
    const started = Date.now();
    let last = -1;
    d.update = async (done, item) => {
      const left = total - done;
      const rate = done ? (Date.now() - started) / done : 2500;
      clear(line.children[0]).append(h("b", String(Math.min(total, done + (left ? 1 : 0)))), ` ${T.ofN(total)}`, item?.row !== null && item?.row !== undefined ? ` · ${T.rowCopy(item.row + 1, item.copy, item.copies)}` : "");
      line.children[1].textContent = left ? `~ ${fmtDuration(Math.round((rate * left) / 1000))}` : "";
      bar.firstChild.style.width = `${(done / total) * 100}%`;
      bar.setAttribute("aria-valuenow", String(Math.min(total, done)));
      if (item && done !== last) {
        last = done;
        const r = await renderPlan(doc, [item]);
        clear(preview).append(bitsToCanvas(r[0].raster));
      }
    };
    return d;
  },

  success(doc, plan, job, resume) {
    const tape = job.tape_mm;
    const battery = Studio.printer.info?.battery;
    if (plan.length <= 3) { // short prints: a toast is enough
      toast(T.nPrinted(plan.length), { kind: "ok", detail: doc.name, action: { label: T.reprint, run: () => this.runPrint({ ...resume, start: 0 }) } });
      return;
    }
    const data = doc.data?.columns.length ? doc.data : null;
    let markChecked = !!data;
    openDialog({
      title: T.nPrinted(plan.length), description: `${fmtLen(tape)} ${T.ofTape}${battery !== undefined && battery !== null ? ` · ${T.batteryPct(battery)}` : ""}`, width: 440, cls: "done-dlg",
      body: h("div",
        h("dl.facts", h("dt", T.labelWord), h("dd", doc.name), data ? h("dt", T.data) : null, data ? h("dd", T.rowsOf(job.meta.rows, data.source.name)) : null),
        data ? swRow(T.markPrinted, markChecked, (v) => { markChecked = v; }) : null),
      footer: [
        { label: T.reprint, action: () => { this.runPrint({ ...resume, start: 0 }); } },
        { label: T.close, variant: "primary", autofocus: true, action: () => { if (markChecked && data) DataUI.checkRows([...new Set(plan.map((i) => i.row))], true); } },
      ],
    });
  },

  failure(doc, plan, printed, result, resume) {
    const left = plan.length - printed;
    const item = plan[printed];
    Studio.pendingPrint = { ...resume, auto: true };
    Studio.banners();
    Studio.watchPrinter();
    const d = openDialog({
      title: T.noReplyTitle, role: "alertdialog", width: 520, cls: "error-dlg",
      description: printed ? T.printedSoFar(printed, plan.length, left, item?.row !== null && item?.row !== undefined ? T.rowCopy(item.row + 1, item.copy, item.copies) : String(printed + 1)) : T.nothingPrinted(plan.length),
      body: h("div",
        h("ul.tips", h("li", T.tipOn), h("li", T.tipPhone), h("li", T.tipBattery), h("li", T.tipRestart)),
        h("details", h("summary", T.details), h("pre.log", result.detail || ""))),
      footer: [
        { label: T.cancelRest, variant: "ghost", action: () => { Studio.pendingPrint = null; Studio.banners(); } },
        { spacer: true },
        { label: T.restart, action: () => { Studio.pendingPrint = null; Studio.banners(); this.runPrint({ ...resume, start: 0, historyId: null }); } },
        { label: left === plan.length ? T.retry : T.printRemaining(left), variant: "primary", autofocus: true, action: () => { Studio.pendingPrint = null; Studio.banners(); this.runPrint(resume); } },
      ],
    });
    return d;
  },

  async confirmSeries(plan, doc) {
    const L = labelLength(doc);
    const tape = plan.length * (L + labelFeed(doc));
    const seconds = Math.round(plan.length * (2 + L / 25));
    const battery = Studio.printer.info?.battery;
    const counter = usesCounter(doc) ? T.counterRange(expand("{n}", { n: plan[0].vars.n, pad: doc.series.pad }), expand("{n}", { n: plan[plan.length - 1].vars.n, pad: doc.series.pad })) : "";
    let dont = false;
    const body = h("div",
      h("div.facts3", h("div", T.tape, h("b", fmtLen(tape))), h("div", T.time, h("b", `~ ${fmtDuration(seconds)}`)), h("div", T.battery, h("b", battery === undefined || battery === null ? "—" : battery > 30 || battery * 4 > plan.length ? T.enough : T.mayNotLast))),
      tape > 4000 ? notice(T.rollTooShort) : null,
      swRow(T.dontAskBelow(200), false, (v) => { dont = v; }));
    const choice = await ask({ title: T.printNQuestion(plan.length), text: `${doc.name}${counter ? ` · ${counter}` : ""}`, body, width: 480,
      buttons: [{ label: T.onlyFirst10, value: "first10" }, { label: T.printN(plan.length), variant: "primary", value: "all", autofocus: true }] });
    if (dont && choice) Studio.setConfig({ confirm_limit: 200 });
    return choice;
  },

  /** Read QR codes and barcodes back from the bitmaps of a few labels. */
  async checkCodes(doc, rendered) {
    const codesOn = doc.objects.filter((o) => (o.type === "qr" || o.type === "barcode") && !o.hidden);
    if (!codesOn.length) return null;
    for (const r of rendered.slice(0, 3)) {
      const env = { vars: r.item.vars, texts: r.item.texts, raw: r.item.raw };
      const expected = codesOn.filter((o) => r.raster.objects.some((x) => x.id === o.id)).map((o) => {
        const text = expandAll(o.content, env);
        const code = Codes.cache.get(Codes.key(codeKind(o), text, codeOpts(o)));
        return o.type === "barcode" && code?.label ? code.label : text;
      }).filter(Boolean);
      if (!expected.length) continue;
      const v = await api("verify_codes", toPng(r.raster), expected).catch(() => null);
      if (v && v.ok === false) return { missing: v.missing, label: r.item };
    }
    return null;
  },

  async codesProblem(problem) {
    const choice = await ask({
      title: T.codeUnreadable, text: T.codeUnreadableText(problem.missing.join(", ")),
      buttons: [{ label: T.cancel, value: false, autofocus: true }, { label: T.printAnyway, variant: "primary", value: true }],
    });
    return !!choice;
  },

  // ---------------------------------------------------------------- templates
  async templates({ category = "all" } = {}) {
    const user = await api("templates").catch(() => []);
    const builtIn = templates();
    const all = [
      ...builtIn.map((t) => ({ ...t, builtIn: true })),
      ...user.map((u) => ({ id: u.id, name: u.name, cats: ["mine", ...(u.category ? [u.category] : [])], note: u.description || `${fmtNum(u.length, 0)}\u00a0mm`, doc: u.doc, user: true, path: u.path, askSource: u.doc?.template?.ask_source, badge: T.badgeMine })),
    ];
    let cat = category, query = "", chosen = all[1]?.id || all[0].id;
    const grid = h("div.tgrid", { role: "listbox", "aria-label": T.templates });
    const draw = () => {
      clear(grid);
      const q = query.toLowerCase();
      for (const t of all.filter((x) => (cat === "all" || x.cats.includes(cat)) && (!q || `${x.name} ${x.note}`.toLowerCase().includes(q)))) {
        const card = h(`button.card${t.id === chosen ? ".on" : ""}`, { type: "button", role: "option", "aria-selected": String(t.id === chosen), onclick: () => { chosen = t.id; keepFocus(grid, draw); }, ondblclick: () => { d.close(); Studio.fromTemplate(t); } },
          h("div.th", t.id === "blank" ? h("div.mini.blank", T.blankShort) : thumbCanvas(t.doc, "mini")),
          h("div.nm", t.name, t.badge ? badge(t.badge) : null), h("small", t.note || ""));
        grid.append(card);
      }
      if (!grid.children.length) grid.append(h("p.desc", T.noTemplatesFound));
    };
    const cats = seg([{ value: "all", label: T.catAll }, { value: "kitchen", label: T.catKitchen }, { value: "home", label: T.catHome }, { value: "data", label: T.catData }, { value: "mine", label: T.catMine }], cat, (v) => { cat = v; keepFocus(grid, draw); }, { label: T.category });
    const search = textInput({ placeholder: T.searchTemplates, lead: "search", label: T.searchTemplates, onInput: (v) => { query = v; draw(); } });
    draw();
    const d = openDialog({
      title: T.newLabel, description: T.templatesDesc, width: 980, cls: "tpl-dlg",
      body: h("div", h("div.row", cats, h("span.spacer"), search), grid),
      footer: [
        { label: T.openQutieFile, icon: "folder", action: () => { Studio.open(); } },
        { spacer: true }, { label: T.cancel },
        { label: T.create, variant: "primary", action: () => { const t = all.find((x) => x.id === chosen); if (t) Studio.fromTemplate(t); } },
      ],
    });
  },

  saveTemplate() {
    if (!S.doc) return;
    const st = { name: S.doc.name, category: "", description: "", keep: true, ask: false };
    const preview = h("div.tpl-preview", thumbCanvas(cleanDocument(), "mini"));
    const cats = [{ value: "", label: T.noCategory }, { value: "kitchen", label: T.catKitchen }, { value: "home", label: T.catHome }, { value: "data", label: T.catData }];
    const desc = h("textarea.area", { rows: 2, "aria-label": T.description, placeholder: T.descriptionHint });
    desc.addEventListener("input", () => { st.description = desc.value; });
    openDialog({
      title: T.saveAsTemplate, description: T.saveAsTemplateDesc, width: 480,
      body: h("div.form", preview,
        field(T.name, textInput({ value: st.name, label: T.name, onInput: (v) => { st.name = v; } })),
        field(T.category, selectBox(cats, "", (v) => { st.category = v; })),
        field(T.description, desc),
        S.doc.data?.source?.path ? swRow(T.keepLink(S.doc.data.source.name), true, (v) => { st.keep = v; }) : null,
        S.doc.data ? swRow(T.askSourceOnUse, false, (v) => { st.ask = v; }) : null),
      footer: [{ spacer: true }, { label: T.cancel }, {
        label: T.saveTemplateBtn, variant: "primary", action: async () => {
          const r = await api("save_template", JSON.stringify(cleanDocument()), st.name.trim() || S.doc.name, st.category, st.description, st.keep, st.ask);
          if (r?.ok) { toast(T.templateSaved, { kind: "ok" }); Home.templatesChanged?.(); } else toast(T.saveFailed, { kind: "error", detail: r?.detail });
        },
      }],
    });
  },

  // ---------------------------------------------------------------- export
  exporter(kind = "png", { plan = null } = {}) {
    if (!S.doc) return;
    const doc = S.doc;
    const data = doc.data?.columns.length ? doc.data : null;
    const st = { kind, res: "dots", which: data || usesCounter(doc) ? "series" : "current", pattern: data ? `«${data.columns[0].name}»-{n}` : `${doc.name}-{n}`, folder: null, rotate: false };
    const body = h("div.form");
    const draw = () => {
      const items = st.which === "current" ? [labelPlan(doc).find((i) => i.row === (editEnv(doc).row ?? null)) || labelPlan(doc)[0]] : st.which === "checked" ? labelPlan(doc, { which: "checked" }) : plan || labelPlan(doc);
      const names = items.slice(0, 3).map((it) => `${fileNameFor(st.pattern, it)}.${st.kind === "pdf" ? "pdf" : "png"}`);
      keepFocus(body, () => clear(body).append(
        seg([{ value: "png", label: "PNG" }, { value: "pdf", label: "PDF" }, { value: "qutie", label: ".qutie" }], st.kind, (v) => { st.kind = v; draw(); }, { full: true, label: T.format }),
        st.kind !== "qutie" ? field(T.resolution, seg([{ value: "dots", label: T.resDots }, { value: "x4", label: T.resX4 }], st.res, (v) => { st.res = v; }, { full: true, label: T.resolution })) : null,
        st.kind !== "qutie" ? field(T.labelsWord, seg([{ value: "current", label: T.exportCurrent }, { value: "series", label: T.exportSeries(plan?.length || labelPlan(doc).length) }, ...(data ? [{ value: "checked", label: T.checkedN(data.checked?.length || 0), disabled: !data.checked?.length }] : [])], st.which, (v) => { st.which = v; draw(); }, { full: true, label: T.labelsWord })) : null,
        st.kind === "png" && st.which !== "current" ? field(T.fileNames, textInput({ value: st.pattern, mono: true, label: T.fileNames, onInput: debounce((v) => { st.pattern = v; draw(); }, 300) }), names.join(", ") + (items.length > 3 ? ", …" : "")) : null,
        st.kind !== "qutie" && (st.kind === "pdf" || st.which !== "current") ? field(T.folder, h("div.row", h("div.inp.grow.mono", st.folder || T.chooseFolderFirst), button(T.choose, { size: "sm", onClick: async () => { const f = await api("choose_folder"); if (f) { st.folder = f; draw(); } } }))) : null,
        st.kind !== "qutie" ? swRow(T.rotateAsPrinted, st.rotate, (v) => { st.rotate = v; }) : null));
      d?.setFooter([{ spacer: true }, { label: T.cancel }, {
        label: st.kind === "qutie" ? T.exportQutie : T.exportN(st.kind === "pdf" ? 1 : items.length, st.kind.toUpperCase()), variant: "primary", icon: "download",
        action: async () => {
          if (st.kind === "qutie") { const r = await api("export_qutie", JSON.stringify(cleanDocument()), doc.name); if (r?.ok) toast(T.exported, { kind: "ok", detail: r.path }); else if (r?.detail) toast(T.exportFailed, { kind: "error", detail: r.detail }); return; }
          const out = await renderPlan(doc, items);
          const files = out.map((r, i) => ({ name: fileNameFor(st.pattern, items[i]), png: exportPng(r.raster, st) }));
          if (st.kind === "png" && files.length === 1 && !st.folder) {
            const r = await api("export_png", files[0].png, files[0].name);
            if (r?.ok) toast(T.exported, { kind: "ok", detail: r.path });
            else if (r?.detail) toast(T.exportFailed, { kind: "error", detail: r.detail });
            return;
          }
          let folder = st.folder;
          if (!folder) folder = await api("choose_folder");
          if (!folder) return false;
          const r = await api("export_files", files, folder, st.kind);
          if (r?.ok) toast(T.exportedN(r.count), { kind: "ok", detail: r.path, action: { label: T.showFolder, run: () => api("file_action", "reveal", r.path) } });
          else toast(T.exportFailed, { kind: "error", detail: r?.detail });
        },
      }]);
    };
    const d = openDialog({ title: T.export, description: T.exportDesc, body, width: 520 });
    draw();
  },

  // ---------------------------------------------------------------- symbols
  symbols(anchor = null) {
    let cat = "symbols", query = "";
    const grid = h("div.symgrid", { role: "group", "aria-label": T.symbols });
    const draw = () => {
      clear(grid);
      const q = query.trim().toLowerCase();
      const chars = q ? [...new Set(Object.values(SYMBOLS).join(""))].filter((c) => (SYMBOL_NAMES[c] || "").includes(q) || c === q) : [...SYMBOLS[cat]];
      for (const c of chars) {
        grid.append(h(`button${S.pendingSymbol?.char === c ? ".on" : ""}`, { type: "button", title: SYMBOL_NAMES[c]?.split(" ")[0] || c, "aria-label": SYMBOL_NAMES[c]?.split(" ")[0] || c, onclick: () => { this.pickSymbol(c, cat === "emoji" || /\p{Extended_Pictographic}/u.test(c) && cat === "emoji"); pop.close(); } }, c));
      }
      if (!grid.children.length) grid.append(h("p.desc", T.noSymbols));
    };
    const cats = seg(["symbols", "arrows", "home", "numbers", "emoji"].map((c) => ({ value: c, label: T[`sym_${c}`] })), cat, (v) => { cat = v; draw(); }, { small: true, label: T.category });
    const search = textInput({ placeholder: T.searchSymbols, lead: "search", label: T.searchSymbols, onInput: (v) => { query = v; draw(); } });
    draw();
    const content = h("div.sympop", search, cats, grid, h("p.desc", T.symbolsDesc));
    const target = anchor || Studio.railButtons?.symbol || stage;
    const back = document.activeElement;
    const pop = showPopover(content, target, { side: anchor ? "bottom" : "right", cls: "symbols", label: T.symbols, onClose: () => focusBack(back, Studio.railButtons?.symbol) });
    setTimeout(() => search.input.focus(), 0);
  },

  /** A symbol chosen: replace the selected symbol, or place it with a click on the label. */
  pickSymbol(char, emoji) {
    const o = selected()[0];
    if (o?.symbol && S.selection.length === 1) { setProps({ text: char, font: emoji ? "Segoe UI Emoji" : "Segoe UI Symbol" }, null, [o]); return; }
    S.pendingSymbol = { char, emoji };
    Studio.renderRail();
    Studio.status();
    Studio.hint();
  },

  placeSymbol(at) {
    const p = S.pendingSymbol;
    if (!p) return;
    S.pendingSymbol = null;
    const size = 10;
    const o = makeObject("text", {
      text: p.char, symbol: true, font: p.emoji ? "Segoe UI Emoji" : "Segoe UI Symbol", bold: false,
      x: round3(at[0] - size / 2), y: round3(Math.max(0, Math.min(TAPE_MM - size, at[1] - size / 2))), w: size, h: size,
      dither: p.emoji ? { mode: "atkinson" } : undefined,
    });
    addObject(o);
    Studio.renderRail();
    Studio.hint();
  },

  // ---------------------------------------------------------------- fonts
  /** Only fonts that print well at 203 dpi on 12 mm tape, and only those installed. */
  async fontPicker(anchor, current, onPick) {
    const fonts = await (this._fonts ||= api("fonts").catch(() => []));
    const installed = new Set(fonts.map((f) => (typeof f === "string" ? f : f.name)));
    const groups = FONT_GROUPS.map((g) => ({ ...g, fonts: g.fonts.filter((f) => installed.has(f.name) || fontInstalled(f.name)) })).filter((g) => g.fonts.length);
    const list = groups.flatMap((g) => g.fonts);
    const known = (name) => list.find((f) => f.name === name);
    // A font from an older label or template stays at hand, but is not offered to others.
    if (current && !known(current)) groups.unshift({ key: "inUse", fonts: [{ name: current }] });
    const recent = (Studio.config.recent_fonts || []).filter((n) => n !== current && known(n)).slice(0, 3);
    let query = "";
    const ul = h("ul.fonts", { role: "listbox", "aria-label": T.font });
    const draw = () => {
      clear(ul);
      const q = query.toLowerCase();
      const row = (f) => {
        const on = f.name === current;
        const li = h(`li.opt${on ? ".on" : ""}`, { role: "option", tabindex: "-1", "aria-selected": String(on), dataset: { font: f.name } },
          h("span.fn", { style: { fontFamily: fontFamily(f.name) } }, f.name, on ? h("small", { "aria-hidden": "true" }, "✓") : null),
          f.note ? h("span.note", T[`fontNote_${f.note}`]) : null);
        li.addEventListener("click", () => choose(f.name));
        return li;
      };
      const group = (title, items) => {
        if (!items.length) return;
        ul.append(h("li.grp", { role: "presentation" }, title));
        items.forEach((f) => ul.append(row(f)));
      };
      if (!q) group(T.recentFonts, recent.map(known));
      for (const g of groups) group(g.key === "inUse" ? T.fontInUse : T[`fontGroup_${g.key}`], g.fonts.filter((f) => !q || f.name.toLowerCase().includes(q)));
      if (!ul.querySelector("li[role=option]")) ul.append(h("li.grp", { role: "presentation" }, T.noFonts));
    };
    const choose = (name) => {
      onPick(name);
      const rf = [name, ...(Studio.config.recent_fonts || []).filter((n) => n !== name)].slice(0, 8);
      Studio.setConfig({ recent_fonts: rf });
      pop.close();
    };
    const search = textInput({ placeholder: T.searchFonts(list.length), lead: "search", label: T.searchFonts(list.length), onInput: (v) => { query = v; draw(); } });
    search.input.addEventListener("keydown", (e) => {
      const items = $$("li[role=option]", ul);
      if (e.key === "ArrowDown") { e.preventDefault(); items[0]?.focus(); }
      if (e.key === "Enter") { e.preventDefault(); if (items[0]) choose(items[0].dataset.font); }
    });
    ul.addEventListener("keydown", (e) => {
      const items = $$("li[role=option]", ul);
      const i = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[Math.min(items.length - 1, i + 1)]?.focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); if (i <= 0) search.input.focus(); else items[i - 1].focus(); }
      if (e.key === "Enter") { e.preventDefault(); document.activeElement.click(); }
    });
    draw();
    // The inspector redraws its font button after a pick: the focus goes to the new one.
    const inInspector = !!Inspector.panel?.contains(anchor);
    const pop = showPopover(h("div.fontpop", search, ul), anchor, { cls: "fontpicker", label: T.font, onClose: () => focusBack(anchor, inInspector ? $(".font-btn", Inspector.panel) : null) });
    setTimeout(() => { search.input.focus(); ul.querySelector("li.on")?.scrollIntoView({ block: "center" }); }, 0);
  },

  // ---------------------------------------------------------------- find and replace
  findReplace() {
    if (!S.doc) return;
    const st = { find: "", replace: "", caseSensitive: false, whole: false };
    const where = h("div.cardx.hits");
    const count = h("span.unit", { "aria-live": "polite" }); // the number of matches is read out while typing
    const matcher = () => {
      if (!st.find) return null;
      const esc = st.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(st.whole ? `\\b${esc}\\b` : esc, st.caseSensitive ? "g" : "gi");
    };
    const hits = () => {
      const re = matcher();
      if (!re) return [];
      const out = [];
      for (const o of S.doc.objects) for (const key of ["text", "content", "name"]) {
        const v = o[key];
        if (typeof v === "string" && v.match(re)) out.push({ o, key, n: v.match(re).length });
      }
      for (const f of S.doc.data?.formulas || []) if (f.name.match(re)) out.push({ formula: f, key: "name", n: f.name.match(re).length });
      return out;
    };
    const draw = () => keepFocus(d.dialog, () => {
      const list = hits();
      const total = list.reduce((s, x) => s + x.n, 0);
      count.textContent = st.find ? T.nMatches(total) : "";
      clear(where);
      const re = matcher();
      for (const x of list.slice(0, 30)) {
        const text = x.formula ? x.formula.name : x.o[x.key];
        const parts = [];
        let last = 0;
        text.replace(re, (m, idx) => { parts.push(text.slice(last, idx), h("span.hit", m)); last = idx + m.length; return m; });
        parts.push(text.slice(last));
        where.append(h("button.k", { type: "button", onclick: () => { if (x.o) select(x.o.id); } },
          h("span", x.formula ? `${T.formulaField} · ` : `${x.o.name} · `, "«", ...parts, "»"), h("span.sub", x.formula ? T.field : T[`key_${x.key}`])));
      }
      if (st.find && !list.length) where.append(h("p.desc", T.noMatches));
      d.setFooter([{ label: T.replaceOne, disabled: !list.length, action: () => { replace(1); return false; } }, { label: T.replaceAll(total), variant: "primary", disabled: !list.length, action: () => { replace(Infinity); return false; } }]);
    }, findInput.input); // nothing left to replace: back to the search field
    const replace = (limit) => {
      const re = matcher();
      if (!re) return;
      History.record(null, "replace");
      let done = 0;
      for (const x of hits()) {
        if (done >= limit) break;
        const target = x.formula || x.o;
        if (limit === Infinity) { target[x.key] = target[x.key].replace(re, st.replace); done += x.n; }
        else { const once = new RegExp(re.source, re.flags.replace("g", "")); target[x.key] = target[x.key].replace(once, st.replace); done++; }
      }
      changed({ structure: true });
      draw();
      toast(T.replacedN(done));
    };
    const findInput = textInput({ label: T.find, onInput: (v) => { st.find = v; draw(); } });
    findInput.append(count);
    const body = h("div.form",
      field(T.find, findInput),
      field(T.replaceWith, textInput({ label: T.replaceWith, onInput: (v) => { st.replace = v; } })),
      h("div.chips",
        chip(T.matchCase, { on: false, onClick: (e) => { st.caseSensitive = !st.caseSensitive; e.currentTarget.classList.toggle("on", st.caseSensitive); e.currentTarget.setAttribute("aria-pressed", String(st.caseSensitive)); draw(); } }),
        chip(T.wholeWord, { on: false, onClick: (e) => { st.whole = !st.whole; e.currentTarget.classList.toggle("on", st.whole); e.currentTarget.setAttribute("aria-pressed", String(st.whole)); draw(); } })),
      field(T.where, where));
    const d = openDialog({ title: T.findReplace, body, width: 520, closeButton: true });
    draw();
  },

  // ---------------------------------------------------------------- shortcuts, palette
  shortcuts() {
    const groups = [
      [T.scTools, [["toolSelect"], ["toolHand", "H / Space"], ["insert_text"], [[T.tool_rect, T.tool_ellipse, T.tool_line].join(" · "), "R / E / L"], ["insert_image"], [`${T.tool_barcode} · QR`, "B / Q"], ["insert_symbol"]]],
      [T.scEdit, [[`${T.cmdUndo} · ${T.cmdRedo}`, "Ctrl+Z / Ctrl+Y"], [`${T.cmdCopy} · ${T.cmdCut} · ${T.cmdPaste}`, "Ctrl+C / Ctrl+X / Ctrl+V"], ["duplicate"], ["delete"], ["selectAll"], ["editText"], ["findReplace"]]],
      [T.scArrange, [[T.scMoveDot, "Left / Up / Right / Down"], [T.scMoveMm, "Shift+Left"], [T.scAltDrag, "Alt"], [T.scShift, "Shift"], [`${T.forward} · ${T.backward}`, "Ctrl+] / Ctrl+["], ["rotateRight"], ["group"]]],
      [T.scView, [[`${T.viewDotsShort} / ${T.viewSmoothShort}`, "D"], [T.zoom, "Ctrl+wheel"], [`${T.zoomFit} · ${T.zoomActual}`, "Ctrl+0 / Ctrl+1"], [T.scScroll, "wheel"], [`${T.grid} · ${T.snap}`, "Ctrl+' / Ctrl+;"], ["rulers"], ["palette"]]],
      [T.scFile, [[`${T.cmdNew} · ${T.cmdOpen} · ${T.cmdSave}`, "Ctrl+N / Ctrl+O / Ctrl+S"], ["print"], ["printNow"], ["exportPng"], ["feed"]]],
      [T.scData, [[`${T.rowPrev} · ${T.rowNext}`, "Alt+Left / Alt+Right"], [`${T.rowFirst} · ${T.rowLast}`, "Alt+Home / Alt+End"], ["dataTable"], ["reloadData"]]],
    ];
    const rows = [];
    const body = h("div.groups");
    for (const [title, items] of groups) {
      const g = h("div.grp", h("h3", title));
      for (const [a, b] of items) {
        const c = CMD[a];
        const label = c ? (typeof c.label === "function" ? c.label() : c.label) : a;
        const keys = b || c?.keys || "";
        const row = h("div.k", h("span", label), h("span", ...keys.split(" / ").map((k) => h("span.kbd", keyLabel(k.replace("wheel", T.wheel))))));
        rows.push([label.toLowerCase(), row]);
        g.append(row);
      }
      body.append(g);
    }
    const empty = h("p.desc", { hidden: true }, T.noResults);
    body.append(empty);
    const search = textInput({ placeholder: T.searchCommand, lead: "search", label: T.searchCommand, onInput: (v) => {
      for (const [l, r] of rows) r.hidden = !!v && !l.includes(v.toLowerCase());
      for (const g of $$(".grp", body)) g.hidden = $$(".k", g).every((r) => r.hidden); // no empty headings
      empty.hidden = rows.some(([, r]) => !r.hidden);
    } });
    openDialog({ title: T.cmdShortcuts, body, width: 980, cls: "shortcuts-dlg", headerExtra: search, closeButton: true });
  },

  /** Ctrl+K: every command and the recent labels, searchable. */
  palette() {
    const listId = `pal-${Math.random().toString(36).slice(2, 8)}`;
    const input = h("input", {
      type: "text", placeholder: T.paletteHint, "aria-label": T.cmdPalette, spellcheck: "false", autocomplete: "off",
      role: "combobox", "aria-expanded": "true", "aria-controls": listId, "aria-autocomplete": "list",
    });
    const list = h("div.pal-list", { role: "listbox", id: listId, "aria-label": T.cmdPalette });
    let active = 0, items = [];
    const all = () => {
      const cmds = Object.values(CMD).filter((c) => c.when() && c.label).map((c) => ({ group: T.commands, label: typeof c.label === "function" ? c.label() : c.label, keys: c.keys?.split(" / ")[0], run: () => run(c.id) }));
      const labels = Studio.recent.map((r) => ({ group: T.labelsWord, label: T.openNamed(r.name), hint: r.folder || "", run: () => Studio.confirmDiscard().then((ok) => ok && Studio.open(r.path)) }));
      const pages = ["home", "templates", "labels", "sources", "history", "printer", "settings"].map((p) => ({ group: T.pages, label: `Home › ${T[`nav_${p}`]}`, run: () => Studio.show("home", p) }));
      return [...cmds, ...labels, ...pages];
    };
    const draw = () => {
      const q = input.value.trim().toLowerCase();
      items = all().filter((x) => !q || x.label.toLowerCase().includes(q) || q.split(/\s+/).every((w) => x.label.toLowerCase().includes(w))).slice(0, 40);
      active = Math.min(active, Math.max(0, items.length - 1));
      clear(list);
      let group = null;
      items.forEach((x, i) => {
        if (x.group !== group) { group = x.group; list.append(h("div.lbl", { role: "presentation" }, group)); }
        list.append(h(`button.k${i === active ? ".on" : ""}`, { type: "button", role: "option", id: `${listId}-${i}`, tabindex: "-1", "aria-selected": String(i === active), onclick: () => { pop.close(); x.run(); }, onpointerenter: () => { active = i; } },
          h("span", x.label), x.keys ? h("span.kbd", keyLabel(x.keys)) : x.hint ? h("span.sub", x.hint) : null));
      });
      if (!items.length) list.append(h("p.desc", T.noResults));
      // The focus stays in the input; the active option is announced through it.
      if (items.length) input.setAttribute("aria-activedescendant", `${listId}-${active}`); else input.removeAttribute("aria-activedescendant");
    };
    input.addEventListener("input", () => { active = 0; draw(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % Math.max(1, items.length); draw(); list.querySelector(".on")?.scrollIntoView({ block: "nearest" }); }
      if (e.key === "Enter") { e.preventDefault(); const x = items[active]; if (x) { pop.close(); x.run(); } }
    });
    draw();
    const back = document.activeElement;
    const pop = showPopover(h("div.palette-box", h("div.pal-in", ico("search"), input), list), document.body, { cls: "palette", x: Math.max(16, window.innerWidth / 2 - 280), y: 90, label: T.cmdPalette, onClose: () => focusBack(back) });
    setTimeout(() => input.focus(), 0);
  },

  // ---------------------------------------------------------------- small pages
  guide() {
    openDialog({ title: T.cmdGuide, width: 640, closeButton: true, body: h("div.guide", ...T.guide.map(([title, text]) => h("section", h("h3", title), h("p", text)))) });
  },

  ditherExamples() {
    const modes = ["threshold", "floyd", "atkinson", "stucki", "bayer4", "bayer8", "halftone", "lines", "noise"];
    openDialog({
      title: T.cmdDitherExamples, description: T.ditherExamplesDesc, width: 760, closeButton: true,
      body: h("div.dither-examples", ...modes.map((m) => h("figure", ditherRamp(m, { cell: 6, angle: 45 }), h("figcaption", h("b", T[`dither_${m}`]), h("span", T[`ditherDesc_${m}`]))))),
    });
  },

  whatsNew() {
    openDialog({ title: T.cmdWhatsNew, width: 560, closeButton: true, body: h("ul.tips", ...T.whatsNewItems.map((x) => h("li", x))) });
  },

  about() {
    const v = Studio.state?.version || "";
    openDialog({
      title: `Qutie Studio ${v}`, width: 480, closeButton: true,
      body: h("div.about", h("p", T.aboutText), h("p.desc", T.aboutLicense),
        h("dl.facts", h("dt", T.componentsInstalled), h("dd", Studio.state?.studio === false ? T.driverOnly : T.driverAndStudio))),
      footer: [{ label: T.modifyInstall, action: () => { api("open_setup", "install"); } }, { label: T.close, variant: "primary" }],
    });
  },

  /** The linked file changed its columns: link to the renamed one, keep the copy, or leave it. */
  fileChanged(name, diff) {
    const lines = [diff.added ? T.diffNew(diff.added) : null, diff.changed ? T.diffChanged(diff.changed) : null, ...diff.renamed.map((r) => T.diffRenamed(r.from, r.to))].filter(Boolean);
    return ask({
      title: T.fileChangedTitle(name), text: `${T.sinceLastTime} ${lines.join(", ")}.`,
      body: h("div", ...diff.renamed.map((r) => h("div.row", h("span.chip.on", `«${r.from}» → ${r.to}`), h("span.sub", T.relinkQuestion(r.to))))),
      buttons: [{ label: T.useSavedCopy, variant: "ghost", value: "copy" }, { label: T.leaveUnlinked, value: "unlinked" }, { label: T.relinkAndUpdate, variant: "primary", value: "relink", autofocus: true }],
    });
  },
};

// ------------------------------------------------------------------ helpers
/** A popover closed: the focus goes back where it was, or to `fallback` when that is gone. */
function focusBack(el, fallback = null) {
  const target = el?.isConnected && el !== document.body ? el : fallback;
  target?.focus?.({ preventScroll: true });
}

function stepper(value, min, max, onChange, label) {
  const num = h("span.num.mono", { "aria-live": "polite" }, String(value));
  const set = (v) => { value = Math.max(min, Math.min(max, v)); num.textContent = String(value); onChange(value); };
  return h("div.stepper", { role: "group", "aria-label": label }, iconButton("minus", T.less, () => set(value - 1)), num, iconButton("plus", T.more, () => set(value + 1)));
}

// Non-breaking spaces keep a number and its unit on one line.
function fmtLen(mm) { return mm >= 1000 ? `${fmtNum(mm / 1000, 1)}\u00a0m` : mm >= 100 ? `${fmtNum(mm / 10, 0)}\u00a0cm` : `${fmtNum(mm, 0)}\u00a0mm`; }
function fmtDuration(s) { return s < 60 ? `${s}\u00a0s` : s < 3600 ? T.minutes(Math.round(s / 60)) : `${Math.floor(s / 3600)}\u00a0h ${Math.round((s % 3600) / 60)}\u00a0min`; }

/** The name of an exported file: fields and variables of that label. */
function fileNameFor(pattern, item) {
  const env = { vars: { ...item.vars, pad: Math.max(3, item.vars.pad || 0) }, texts: item.texts, raw: item.raw };
  return expandAll(pattern, env).replace(/[<>:"/\\|?*\x00-\x1f]/g, "").trim() || "label";
}

/** A label for export: 1:1 dots, or ×4, optionally turned as it leaves the printer. */
function exportPng(raster, st) {
  let c = bitsToCanvas(raster);
  if (st.res === "x4") {
    const big = h("canvas", { width: c.width * 4, height: c.height * 4 });
    const ctx = big.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, 0, 0, big.width, big.height);
    c = big;
  }
  if (st.rotate) {
    const r = h("canvas", { width: c.height, height: c.width });
    const ctx = r.getContext("2d");
    ctx.translate(r.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(c, 0, 0);
    c = r;
  }
  return c.toDataURL("image/png");
}

/** A document as saved, for any document (not only the one being edited). */
function cleanDocumentOf(doc) {
  const used = new Set(doc.objects.filter((o) => o.type === "image" && o.asset).map((o) => o.asset));
  return { ...doc, version: FORMAT_VERSION, assets: Object.fromEntries(Object.entries(doc.assets || {}).filter(([k]) => used.has(k))) };
}
