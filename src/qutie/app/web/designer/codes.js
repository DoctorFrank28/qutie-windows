"use strict";
/* Barcodes and QR codes in the Studio: inspector sections, the quick card on double
 * click and the QR generator, which sizes the code in whole printer dots for 12 mm tape.
 */

const BARCODE_KINDS = ["code128", "ean13", "ean8", "upca", "code39", "itf14", "codabar"];
const QR_TYPES = ["text", "link", "wifi", "contact", "email", "phone", "sms", "geo", "event", "field"];
const QR_TYPE_ICON = { text: "text", link: "link", wifi: "wifi", contact: "user", email: "mail", phone: "phone", sms: "message", geo: "mapPin", event: "calendar", field: "braces" };

// ------------------------------------------------------------------ QR payloads
const qrEscape = (s) => String(s ?? "").replace(/([\\;,:"])/g, "\\$1");
const icsDate = (iso) => (iso ? iso.replace(/[-:]/g, "").replace(/\.\d+/, "").slice(0, 15).padEnd(15, "0") : "");

/** The text inside the code for a guided content type. */
function qrPayload(type, d = {}) {
  switch (type) {
    case "link": { const u = String(d.url || "").trim(); return u && !/^[a-z][a-z0-9+.-]*:/i.test(u) ? `https://${u}` : u; }
    case "wifi": return `WIFI:T:${d.security === "nopass" ? "nopass" : d.security || "WPA"};S:${qrEscape(d.ssid)};${d.security === "nopass" ? "" : `P:${qrEscape(d.password)};`}${d.hidden ? "H:true;" : ""};`;
    case "contact": return `MECARD:N:${qrEscape(d.name)};${d.phone ? `TEL:${qrEscape(d.phone)};` : ""}${d.email ? `EMAIL:${qrEscape(d.email)};` : ""}${d.org ? `ORG:${qrEscape(d.org)};` : ""}${d.url ? `URL:${qrEscape(d.url)};` : ""};`;
    case "email": {
      const q = [d.subject ? `subject=${encodeURIComponent(d.subject)}` : "", d.body ? `body=${encodeURIComponent(d.body)}` : ""].filter(Boolean).join("&");
      return `mailto:${d.to || ""}${q ? `?${q}` : ""}`;
    }
    case "phone": return `tel:${String(d.number || "").replace(/[^\d+]/g, "")}`;
    case "sms": return `SMSTO:${String(d.number || "").replace(/[^\d+]/g, "")}:${d.message || ""}`;
    case "geo": return `geo:${d.lat || 0},${d.lon || 0}`;
    case "event": return ["BEGIN:VEVENT", `SUMMARY:${d.title || ""}`, d.start ? `DTSTART:${icsDate(d.start)}` : "", d.end ? `DTEND:${icsDate(d.end)}` : "", d.place ? `LOCATION:${d.place}` : "", "END:VEVENT"].filter(Boolean).join("\n");
    case "field": return d.field ? `«${d.field}»` : "";
    default: return d.text ?? "";
  }
}

/** The form of a content type: [{key, label, kind}] */
function qrForm(type) {
  const f = (key, label, kind = "text", more = {}) => ({ key, label, kind, ...more });
  switch (type) {
    case "link": return [f("url", T.qrUrl, "url")];
    case "wifi": return [f("ssid", T.qrSsid), f("password", T.qrPassword, "password"), f("security", T.qrSecurity, "seg", { options: [["WPA", "WPA/WPA2/WPA3"], ["WEP", "WEP"], ["nopass", T.qrOpen]] }), f("hidden", T.qrHidden, "switch")];
    case "contact": return [f("name", T.qrName), f("phone", T.qrPhone, "tel"), f("email", T.qrEmail, "email"), f("org", T.qrOrg)];
    case "email": return [f("to", T.qrTo, "email"), f("subject", T.qrSubject), f("body", T.qrBody, "area")];
    case "phone": return [f("number", T.qrPhone, "tel")];
    case "sms": return [f("number", T.qrPhone, "tel"), f("message", T.qrMessage, "area")];
    case "geo": return [f("lat", T.qrLat, "text", { inputmode: "decimal" }), f("lon", T.qrLon, "text", { inputmode: "decimal" })];
    case "event": return [f("title", T.qrTitle), f("start", T.qrStart, "datetime-local"), f("end", T.qrEnd, "datetime-local"), f("place", T.qrPlace)];
    case "field": return [f("field", T.field, "field")];
    default: return [f("text", T.qrText, "area")];
  }
}

/** Form controls for the guided content; onChange(data) on every edit. */
function qrFormControls(type, data, onChange) {
  const out = [];
  for (const fld of qrForm(type)) {
    const set = (v) => { data[fld.key] = v; onChange(data); };
    if (fld.kind === "seg") out.push(seg(fld.options.map(([value, label]) => ({ value, label })), data[fld.key] || fld.options[0][0], set, { full: true, label: fld.label }));
    else if (fld.kind === "switch") out.push(swRow(fld.label, !!data[fld.key], set));
    else if (fld.kind === "field") {
      const names = fieldNames(S.doc?.data);
      out.push(names.length ? field(fld.label, selectBox(names.map((n) => ({ value: n, label: n })), data.field || names[0], set, { label: fld.label })) : notice(T.qrNoFields, { action: button(T.cmdLinkData, { size: "sm", onClick: () => DataUI.connect() }) }));
      if (names.length && !data.field) data.field = names[0];
    } else if (fld.kind === "area") {
      const a = h("textarea.area", { rows: 3, "aria-label": fld.label });
      a.value = data[fld.key] || "";
      a.dataset.qf = fld.key;
      a.addEventListener("input", () => set(a.value));
      out.push(field(fld.label, a));
    } else {
      const inp = textInput({ value: data[fld.key] || "", label: fld.label, type: fld.kind === "password" ? "text" : fld.kind, onInput: set, mono: fld.kind === "password" });
      inp.input.dataset.qf = fld.key;
      if (fld.inputmode) inp.input.inputMode = fld.inputmode;
      out.push(field(fld.label, inp));
    }
  }
  return out;
}

/** Guess the guided type from existing content (files from before, pasted text). */
function guessQrType(content) {
  const c = String(content || "");
  if (/^«[^«»]+»$/.test(c)) return { type: "field", data: { field: c.slice(1, -1) } };
  if (/^WIFI:/i.test(c)) {
    const get = (k) => (new RegExp(`${k}:((?:\\\\.|[^;])*)`).exec(c)?.[1] || "").replace(/\\(.)/g, "$1");
    return { type: "wifi", data: { ssid: get("S"), password: get("P"), security: get("T") || "WPA", hidden: /H:true/i.test(c) } };
  }
  if (/^https?:\/\//i.test(c) || c === "https://") return { type: "link", data: { url: c } };
  if (/^tel:/i.test(c)) return { type: "phone", data: { number: c.slice(4) } };
  if (/^mailto:/i.test(c)) return { type: "email", data: { to: c.slice(7).split("?")[0] } };
  return { type: "text", data: { text: c } };
}

// ------------------------------------------------------------------ inspector
const CodesUI = {
  barcodeSections(o) {
    const env = editEnv(S.doc);
    const content = expandAll(o.content, env);
    const code = Codes.get(o.kind, content);
    const kindChips = h("div.chips", ...BARCODE_KINDS.map((k) => chip(T[`bc_${k}`], { on: o.kind === k, onClick: () => setProps({ kind: k }, null, [o]) })));
    const input = textInput({ value: o.content, label: T.codeContent, mono: true, onInput: (v) => setProps({ content: v }, `content-${o.id}`, [o]) });
    input.input.dataset.content = o.id;
    input.input.addEventListener("focus", () => { Inspector.lastContent = { id: o.id, el: input.input }; });
    const status = [];
    if (!code) status.push(h("span.desc", T.codeLoading));
    else if (!code.ok) {
      const errId = `err-${o.id}`;
      status.push(h("span.desc.err", { id: errId }, `✗ ${code.detail}`));
      input.input.setAttribute("aria-invalid", "true");
      input.input.setAttribute("aria-describedby", errId);
    }
    else if (code.check_added) status.push(h("span.desc", h("span.ok", "✓ "), T.checkAdded(code.check)));
    else if (["ean13", "ean8", "upca", "itf14"].includes(o.kind)) status.push(h("span.desc", h("span.ok", "✓ "), T.checkValid));
    if (S.doc.data?.columns.length) {
      status.push(h("span.desc", T.orFromField, " ", ...fieldNames(S.doc.data).filter((n) => ["ean13", "ean8", "text", "number"].includes(fieldType(S.doc.data, n))).slice(0, 3)
        .map((n) => chip(`«${n}»`, { mono: true, onClick: () => setProps({ content: `«${n}»` }, null, [o]) }))));
    }
    const lay = code?.ok ? barcodeLayout(o, code, dots(o.w), dots(o.h)) : null;
    const leg = lay ? (lay.fits ? legibility(lay.module + 1) : "no") : null; // bars of 1 dot still scan from close
    const moduleSeg = seg([{ value: 0, label: T.auto }, { value: 1, label: "1" }, { value: 2, label: "2" }, { value: 3, label: "3" }], o.moduleDots || 0, (v) => {
      const changes = { moduleDots: v };
      if (v && code?.ok) changes.w = round3(Math.max(o.w, toMm(code.bars.length * v + 2)));
      setProps(changes, null, [o]);
    }, { small: true, label: T.dotsPerModule });
    return [
      section(T.barcode, {},
        selectBox(BARCODE_KINDS.map((k) => ({ value: k, label: `${T[`bc_${k}`]} · ${T[`bcUse_${k}`]}` })), o.kind, (v) => setProps({ kind: v }, null, [o]), { label: T.barcodeKind }),
        kindChips, input, ...status,
        h("div.row.between",
          seg([{ value: "none", label: T.textNone }, { value: "below", label: T.textBelow }, { value: "above", label: T.textAbove }], o.textPos || "below", (v) => setProps({ textPos: v }, null, [o]), { small: true, label: T.humanText }),
          h("span.desc.mono", lay ? T.dotsPerModuleN(lay.module >= 1 ? lay.module : fmtNum(lay.module, 1)) : "")),
        h("div.row.between", h("span.desc", T.dotsPerModule), moduleSeg),
        o.textPos !== "none" ? slider({ label: T.textSize, min: 4, max: 12, step: 0.5, value: o.textSize || 6, format: (v) => `${fmtNum(v, 1)}\u00a0pt`, onInput: (v) => setProps({ textSize: v }, `ts-${o.id}`, [o]) }) : null,
        legibilityMeter(leg),
        lay && !lay.fits ? notice(T.barcodeTooLong, { kind: "warn", iconName: "alert" }) : null),
    ];
  },

  qrSections(o) {
    const env = editEnv(S.doc);
    const content = expandAll(o.content, env);
    const code = Codes.get(codeKind(o), content, codeOpts(o));
    const type = o.qrType || guessQrType(o.content).type;
    const data = { ...(o.qrType ? o.qrData : guessQrType(o.content).data) };
    const apply = (d) => setProps({ qrType: type, qrData: { ...d }, content: qrPayload(type, d) }, `qr-${o.id}`, [o]);
    const kinds = h("div.kinds", { role: "group", "aria-label": T.content }, ...QR_TYPES.filter((t) => t !== "event").map((t) => h(`button.kind${t === type ? ".on" : ""}`, {
      type: "button", "aria-pressed": String(t === type),
      onclick: () => { const g = t === "field" ? { field: fieldNames(S.doc.data)[0] } : {}; setProps({ qrType: t, qrData: g, content: qrPayload(t, g) }, null, [o]); },
    }, T[`qr_${t}`])));
    const lay = code?.ok ? qrLayout(o, code, dots(o.w), dots(o.h)) : null;
    const leg = lay ? legibility(lay.m) : null;
    const facts = code?.ok ? h("dl.facts",
      h("dt", T.version), h("dd.mono", `${code.label} · ${code.modules} × ${code.modules} ${T.modules}`),
      h("dt", T.module), h("dd.mono", lay.m >= 1 ? `${T.nDots(lay.m)} · ${fmtNum(toMm(lay.m), 2)} mm` : T.tooSmall),
      h("dt", T.characters), h("dd.mono", code.capacity ? T.charsOf(code.chars, code.capacity) : String(code.chars))) : h("p.desc", code ? `✗ ${code.detail}` : T.codeLoading);
    const sections = [
      section(T.content, {}, kinds, ...qrFormControls(type, data, apply)),
      section(T.code, {},
        seg([{ value: "qr", label: "QR" }, { value: "microqr", label: "Micro QR" }], o.kind, (v) => setProps({ kind: v, ecc: v === "microqr" && o.ecc === "h" ? "m" : o.ecc, version: "auto" }, null, [o]), { full: true, label: T.format }),
        h("div.row.between", h("span", T.errorCorrection),
          seg(["l", "m", "q", "h"].map((e) => ({ value: e, label: e.toUpperCase(), title: T[`ecc_${e}`], disabled: o.kind === "microqr" && e === "h" })), o.ecc, (v) => setProps({ ecc: v }, null, [o]), { small: true, label: T.errorCorrection })),
        swRow(T.quietZone, (o.quiet || 0) > 0, (v) => setProps({ quiet: v ? 2 : 0 }, null, [o])),
        facts, legibilityMeter(leg),
        o.kind === "qr" && content.length <= 13 && !fieldsIn(o.content).length ? notice(T.microHint) : null,
        lay && lay.m * lay.n > HEAD_DOTS ? notice(T.qrTooBig, { kind: "warn", iconName: "alert" }) : null,
        button(T.openQrGenerator, { size: "sm", icon: "qr", onClick: () => this.generator(o) })),
    ];
    return sections;
  },

  /** Double click on a code: a small card next to it (barcodes), the generator (QR codes). */
  quickPopover(o, at) {
    if (o.type === "qr") { this.generator(o); return; }
    const card = h("div.code-card", h("h3", ico("barcode"), T.barcode), ...this.barcodeSections(o)[0].children);
    const back = document.activeElement;
    const pop = showPopover(card, stage, { ...(at ? { x: at[0] + 12, y: at[1] - 40 } : { side: "bottom", align: "center" }), label: T.barcode, onClose: () => focusBack(back, stage) });
    setTimeout(() => card.querySelector("input")?.focus(), 0); // the card is for typing the content
    const refresh = () => {
      if (!pop.el.isConnected) { listeners.change.splice(listeners.change.indexOf(refresh), 1); return; }
      if (document.activeElement && pop.el.contains(document.activeElement)) return;
      const fresh = byId(o.id);
      if (!fresh) { pop.close(); return; }
      clear(card).append(h("h3", ico("barcode"), T.barcode), ...this.barcodeSections(fresh)[0].children);
    };
    listeners.change.push(refresh);
  },

  // ---------------------------------------------------------------- the QR generator
  /** The generator: what the code holds, how big it prints, whether it scans. */
  generator(target = null) {
    const g = target ? {
      type: target.qrType || guessQrType(target.content).type, data: { ...(target.qrType ? target.qrData : guessQrType(target.content).data) },
      micro: target.kind === "microqr", ecc: target.ecc || "m", version: target.version || "auto", moduleDots: target.moduleDots || 0,
      quiet: target.quiet || 0, invert: !!target.invert,
    } : { type: "link", data: { url: "https://" }, micro: false, ecc: "m", version: "auto", moduleDots: 0, quiet: 1, invert: false };
    const body = h("div.qrgen");
    let info = null, options = null, verify = null, seq = 0;
    const dlg = openDialog({ title: T.qrGenerator, description: T.qrGeneratorDesc, body, width: "min(1280px, 96vw)", cls: "qrgen-dlg", closeButton: true });

    const content = () => {
      const p = qrPayload(g.type, g.data);
      if (g.type === "field") { const env = editEnv(S.doc); return expandAll(p, env) || "QUTIE"; }
      return p;
    };
    const dotsFor = () => {
      if (!info?.ok) return 0;
      const n = info.modules + g.quiet * 2;
      const max = Math.floor(HEAD_DOTS / n);
      return g.moduleDots ? g.moduleDots : Math.min(max, 5);
    };
    const refresh = async () => {
      const my = ++seq;
      const text = content();
      const [i, opts] = await Promise.all([
        api("codes", g.micro ? "microqr" : "qr", text, { ecc: g.ecc, version: g.version === "auto" ? null : g.version }),
        api("qr_options", text, g.micro, g.quiet),
      ]).catch(() => [null, null]);
      if (my !== seq) return;
      info = i; options = opts; verify = null;
      render();
      if (info?.ok) {
        const m = dotsFor();
        if (m >= 1 && (info.modules + 2 * g.quiet) * m <= HEAD_DOTS) {
          const r = await api("verify_codes", qrBitmap(info.matrix, m, g.quiet, g.invert), [text]).catch(() => null);
          if (my === seq) { verify = r; renderChecks(); }
        }
      }
    };
    const ui = {};
    const render = () => {
      // Typing in a field redraws the generator: keep the cursor where it was.
      const active = document.activeElement?.dataset?.qf;
      const caret = active ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
      // Left: content
      const left = h("aside.col.l",
        section(T.content, {}, h("div.types", { role: "group", "aria-label": T.content }, ...QR_TYPES.map((t) => h(`button.ty${t === g.type ? ".on" : ""}`, {
          type: "button", "aria-pressed": String(t === g.type), onclick: () => { g.type = t; g.data = t === "field" ? { field: fieldNames(S.doc?.data)[0] } : t === "link" ? { url: "https://" } : {}; refresh(); },
        }, ico(QR_TYPE_ICON[t]), T[`qr_${t}`])))),
        section(T[`qr_${g.type}`], {}, ...qrFormControls(g.type, g.data, debounce(() => refresh(), 250))),
        section(T.dataInCode, { summary: h("span.sum.mono", info?.ok ? `${info.chars} ${T.charsShort} · ${T[`mode_${info.mode}`] || info.mode}` : "") },
          h("div.payload.mono", g.type === "wifi" ? content().replace(/P:((?:\\.|[^;])*)/, (m, p) => `P:${"•".repeat(p.length)}`) : content()),
          options?.upper && g.type === "link" ? notice(T.upperHint(options.upper.version), { action: button(T.optimize, { size: "sm", onClick: () => { g.data.url = content().toUpperCase(); refresh(); } }) }) : null));
      // Centre: the tape
      const center = h("main.center", this.tapeView(info, g, dotsFor()), this.sizeCards(info, g, (m) => { g.moduleDots = m; render(); }));
      // Right: format and checks
      const ecc = h("div.ecc", { role: "group", "aria-label": T.errorCorrection }, ...(g.micro ? ["l", "m", "q"] : ["l", "m", "q", "h"]).map((e) => {
        const o = options?.ecc?.[e];
        return h(`button.er${g.ecc === e ? ".on" : ""}`, { type: "button", "aria-pressed": String(g.ecc === e), disabled: o && !o.ok, onclick: () => { g.ecc = e; refresh(); } },
          h("span.k", e.toUpperCase()), h("span", T[`ecc_${e}`]),
          h(`span.v${o?.ok && o.max_dots < 3 ? ".warn" : ""}`, o?.ok ? `${o.label} · ${o.modules} ${T.modShort}${o.max_dots < 3 ? ` · ${T.nDots(o.max_dots)}` : ""}` : o ? T.doesNotFit : "…"));
      }));
      const right = h("aside.col.r",
        section(T.format, {}, seg([{ value: false, label: "QR" }, { value: true, label: "Micro QR" }], g.micro, (v) => { g.micro = v; if (v && g.ecc === "h") g.ecc = "m"; g.version = "auto"; refresh(); }, { full: true, label: T.format }),
          h("p.desc", g.micro ? (info?.ok ? T.microOk : T.microTooLong(content().length)) : T.microDesc)),
        section(T.errorCorrection, { summary: h("span.sum", T.resultingVersion) }, ecc),
        section(T.size, {},
          h("div.row.between", h("span", T.version), seg([{ value: "auto", label: T.auto }, { value: info?.ok ? info.version : 1, label: T.fixedVersion(info?.ok ? info.label : "—") }], g.version === "auto" ? "auto" : g.version, (v) => { g.version = v; refresh(); }, { small: true, label: T.version })),
          h("div.row.between", h("span", T.dotsPerModule), seg([{ value: 0, label: T.auto }, ...[2, 3, 4, 5].map((n) => ({ value: n, label: String(n) }))], g.moduleDots, (v) => { g.moduleDots = v; render(); }, { small: true, label: T.dotsPerModule })),
          h("div.row.between", h("span", T.quietZoneModules), seg([0, 1, 2, 4].map((n) => ({ value: n, label: String(n) })), g.quiet, (v) => { g.quiet = v; refresh(); }, { small: true, label: T.quietZoneModules })),
          swRow(T.whiteOnBlack, g.invert, (v) => { g.invert = v; render(); }, T.notAllReaders)),
        ui.checks = section(T.check, {}),
        this.capacityTable(info));
      keepFocus(body, () => clear(body).append(left, center, right)); // buttons and switches keep the focus too
      if (active) {
        const el = body.querySelector(`[data-qf="${active}"]`);
        if (el) { el.focus(); try { el.setSelectionRange(...caret); } catch { /* not a text field */ } }
      }
      renderChecks();
      dlg.setFooter([
        { node: h("span.desc", T.fixedVersionHint) },
        { spacer: true },
        { label: T.printTestSizes, icon: "printer", action: () => { this.testPrint(info, g); return false; }, disabled: !info?.ok },
        { label: T.cancel },
        target
          ? { label: T.applyToLabel, variant: "primary", disabled: !info?.ok, action: () => this.applyTo(target, g, info, dotsFor()) }
          : { label: T.addToLabel, variant: "primary", disabled: !info?.ok || !S.doc, action: () => this.applyTo(null, g, info, dotsFor()) },
      ]);
    };
    const renderChecks = () => {
      if (!ui.checks?.isConnected) return;
      const m = dotsFor();
      const items = [];
      if (info?.ok) {
        const size = (info.modules + 2 * g.quiet) * m;
        const fits = size <= HEAD_DOTS && m >= 1;
        const leg = fits ? legibility(m) : "no";
        const ok = (cond, text) => h("div", h(cond === true ? "span.ok" : cond === "warn" ? "span.warn" : "span.err", cond === true ? "✓" : cond === "warn" ? "!" : "✗"), h("span", text));
        items.push(ok(m >= 3 ? true : m === 2 ? "warn" : false, T.chkModule(m, fmtNum(toMm(m), 2))));
        items.push(ok(fits ? true : false, fits ? T.chkFits(size) : T.chkTooBig(size)));
        items.push(ok(g.quiet >= 4 ? true : "warn", g.quiet >= 4 ? T.chkQuietOk : T.chkQuiet(g.quiet, fmtNum(toMm((4 - g.quiet) * m), 1))));
        items.push(ok(true, T.chkThreshold));
        const density = Studio.printer.info?.density;
        items.push(ok(density && density > 85 ? "warn" : true, density ? T.chkDensity(density) : T.chkDensityUnknown));
        items.push(verify === null ? h("div", h("span.desc", "…"), h("span", T.chkReading)) : ok(verify?.ok === true ? true : verify?.ok === null ? "warn" : false, verify?.ok === true ? T.chkReadOk : verify?.ok === null ? T.chkReadUnavailable : T.chkReadFail));
        const score = !fits ? "no" : leg;
        clear(ui.checks).append(
          h("div.sec-t", h("h3", T.check)),
          h(`div.score.${score}`, h("span.typeic", ico(score === "no" ? "alert" : "check")), h("div", h("span.big", T[`score_${score}`]), h("span.desc", T[`scoreDesc_${score}`]))),
          h("div.check", ...items));
      } else clear(ui.checks).append(h("div.sec-t", h("h3", T.check)), notice(info?.detail || T.codeLoading, { kind: info ? "warn" : "", iconName: info ? "alert" : "info" }));
    };
    render();
    refresh();
  },

  /** The tape, 96 dots tall, with the code as the print head makes it. */
  tapeView(info, g, m) {
    const wrap = h("div.tapeview");
    const head = h("div.row.between", h("span.lbl", T.howItPrints), h("span.desc.mono", T.tapeScale));
    if (!info?.ok) { wrap.append(head, h("div.band.empty")); return wrap; }
    const n = info.modules;
    const scale = 4; // screen pixels per printer dot
    const quietDots = g.quiet * m, quiet4 = 4 * m;
    const size = (n + 2 * g.quiet) * m;
    const W = Math.max(size + 2 * quiet4, 140), H = HEAD_DOTS;
    const c = h("canvas", { width: W * scale, height: (H + 24) * scale, class: "band-canvas", role: "img", "aria-label": T.howItPrints });
    const ctx = c.getContext("2d");
    const ox = Math.round((W - size) / 2), oy = Math.max(0, Math.round((H - size) / 2));
    ctx.fillStyle = "#f5f5f5"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 12 * scale, W * scale, H * scale);
    // recommended quiet zone (4 modules), outside the tape when it does not fit
    ctx.strokeStyle = "#a3a3a3"; ctx.setLineDash([6, 4]);
    ctx.strokeRect((ox + quietDots - quiet4) * scale, (12 + oy + quietDots - quiet4) * scale, (n * m + 2 * quiet4) * scale, (n * m + 2 * quiet4) * scale);
    ctx.setLineDash([]);
    const dark = g.invert ? "#fff" : "#000", light = g.invert ? "#000" : "#fff";
    ctx.fillStyle = light;
    ctx.fillRect(ox * scale, (12 + oy) * scale, size * scale, size * scale);
    ctx.fillStyle = dark;
    info.matrix.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === "1") ctx.fillRect((ox + quietDots + x * m) * scale, (12 + oy + quietDots + y * m) * scale, m * scale, m * scale); });
    if (scale >= 3) { // the dot grid
      ctx.strokeStyle = "rgba(120,120,120,0.18)"; ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= W; x++) { ctx.moveTo(x * scale + 0.5, 12 * scale); ctx.lineTo(x * scale + 0.5, (12 + H) * scale); }
      for (let y = 0; y <= H; y++) { ctx.moveTo(0, (12 + y) * scale + 0.5); ctx.lineTo(W * scale, (12 + y) * scale + 0.5); }
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(220,38,38,0.12)";
    ctx.fillRect(0, 0, W * scale, 12 * scale);
    ctx.fillRect(0, (12 + H) * scale, W * scale, 12 * scale);
    ctx.fillStyle = "#dc2626"; ctx.font = `${10 * scale / 3}px Geist, sans-serif`;
    ctx.fillText(T.tapeEdge, 6, 10 * scale - 4);
    ctx.fillText(T.tapeEdge, 6, (H + 24) * scale - 8);
    const mag = h("div.mag", h("div.m", { style: { gridTemplateColumns: `repeat(${Math.max(1, m)}, 1fr)` } }, ...Array.from({ length: Math.max(1, m) ** 2 }, () => h("span"))),
      h("small", T.oneModule(m, fmtNum(toMm(m), 2))));
    wrap.append(head, h("div.band", c, mag), h("p.desc.mono", T.sizeLine(size, fmtNum(toMm(size), 1))));
    return wrap;
  },

  sizeCards(info, g, pick) {
    const cards = h("div.sizes", { role: "group", "aria-label": T.dotsPerModule });
    if (!info?.ok) return cards;
    for (const m of [2, 3, 4]) {
      const size = (info.modules + 2 * g.quiet) * m;
      const fits = size <= HEAD_DOTS;
      const leg = fits ? legibility(m) : "no";
      const lower = !fits ? CodesUI._lowerEcc(info, g, m) : null;
      const on = (g.moduleDots || Math.min(5, Math.floor(HEAD_DOTS / (info.modules + 2 * g.quiet)))) === m;
      cards.append(h(`button.sz${on ? ".on" : ""}${fits ? "" : ".no"}`, { type: "button", "aria-pressed": String(on), disabled: !fits, onclick: () => pick(m) },
        h("div.mini", qrThumb(info.matrix, Math.max(1, Math.round(m / 1.5)), g.invert)),
        h("div.tx", h("b", T.nDots(m)), h("span", `${fmtNum(toMm(size), 1)} mm · ${size}\u00a0${T.dots}`),
          h(`span.${leg === "great" || leg === "good" ? "ok" : leg === "limit" ? "warn" : "err"}`, fits ? T[`leg_${leg}`] : T.doesNotFitTape),
          lower ? h("span.desc", lower) : legibilityMeter(leg, true))));
    }
    return cards;
  },

  _lowerEcc(info, g, m) {
    return g.ecc !== "l" ? T.tryLowerEcc : null;
  },

  capacityTable(info) {
    const rows = [["Micro M4", 17, 5, 13], ["1", 21, 4, 14], ["2", 25, 3, 26], ["3", 29, 3, 42], ["4 – 7", "33–45", 2, "62–122"], ["8+", "49+", 1, T.unreadable]];
    const cur = info?.ok ? (String(info.label).startsWith("M") ? 0 : info.version <= 3 ? info.version : info.version <= 7 ? 4 : 5) : -1;
    return h("table.dtable.small.cap",
      h("thead", h("tr", h("th", T.version), h("th", T.modules), h("th", T.maxDots), h("th", T.charsM))),
      h("tbody", ...rows.map((r, i) => h(`tr${i === cur ? ".cur" : ""}${i === 5 ? ".off" : ""}`, ...r.map((v) => h("td.mono", String(v)))))));
  },

  async testPrint(info, g) {
    if (!info?.ok) return;
    const doc = newDocument({ name: T.qrTest, label: { media: "gap", length: 40, auto: false, margin: 2, feed: FEED_GAP } });
    const text = qrPayload(g.type, g.data);
    let x = 1;
    for (const m of [2, 3]) {
      const size = toMm((info.modules + 2 * g.quiet) * m);
      if (size > TAPE_MM) continue;
      doc.objects.push(makeObject("qr", { kind: g.micro ? "microqr" : "qr", content: text, ecc: g.ecc, quiet: g.quiet, moduleDots: m, invert: g.invert, x, y: (TAPE_MM - size) / 2, w: size, h: size }));
      doc.objects.push(makeObject("text", { text: T.nDots(m), x: x + size + 0.5, y: 4, w: 6, h: 4, bold: false }));
      x += size + 7;
    }
    doc.label.length = Math.max(30, Math.ceil(x + 1));
    Dialogs.runPrint({ doc, plan: labelPlan(doc), source: "studio", name: T.qrTest, noHistory: true });
  },

  applyTo(target, g, info, m) {
    const text = qrPayload(g.type, g.data);
    const size = round3(toMm((info.modules + 2 * g.quiet) * m));
    const props = {
      kind: g.micro ? "microqr" : "qr", content: text, ecc: g.ecc, version: g.version, moduleDots: g.moduleDots ? m : 0,
      quiet: g.quiet, invert: g.invert, qrType: g.type, qrData: { ...g.data },
    };
    if (target) {
      const cx = target.x + target.w / 2, cy = target.y + target.h / 2;
      setProps({ ...props, w: size, h: size, x: round3(cx - size / 2), y: round3(Math.max(0, Math.min(TAPE_MM - size, cy - size / 2))) }, null, [target]);
    } else if (S.doc) {
      addObject(makeObject("qr", { ...props, w: size, h: size, x: Studio.freeSpot(size), y: round3((TAPE_MM - size) / 2) }));
    }
  },
};

function legibilityMeter(leg, small = false) {
  const n = { no: 0, limit: 2, good: 3, great: 4 }[leg] ?? 0;
  const cls = leg === "great" || leg === "good" ? "ok" : leg === "limit" ? "warn" : "err";
  const meter = h(`div.meter${small ? ".small" : ""}`, { role: "meter", "aria-valuemin": "0", "aria-valuemax": "4", "aria-valuenow": String(n), "aria-valuetext": leg ? T[`leg_${leg}`] : null, "aria-label": T.legibility },
    ...[0, 1, 2, 3].map((i) => h(`span${i < n ? `.${cls}` : ""}`)));
  if (small) return meter;
  return h("div.ctl", h("div.ctl-l", h("span", T.legibility), h(`b.${cls}`, leg ? T[`leg_${leg}`] : "…")), meter);
}

/** A 1-bit label with only the QR code, for reading it back. */
function qrBitmap(matrix, m, quiet, invert) {
  const n = matrix.length + 2 * quiet;
  const W = Math.max(n * m + 16, 40);
  const bits = new Uint8Array(W * HEAD_DOTS);
  const ox = Math.round((W - n * m) / 2), oy = Math.round((HEAD_DOTS - n * m) / 2);
  for (let y = 0; y < n * m; y++) for (let x = 0; x < n * m; x++) {
    const mx = Math.floor(x / m) - quiet, my = Math.floor(y / m) - quiet;
    const on = mx >= 0 && my >= 0 && mx < matrix.length && my < matrix.length && matrix[my][mx] === "1";
    const p = (oy + y) * W + ox + x;
    if (p >= 0 && p < bits.length) bits[p] = invert ? (on ? 0 : 1) : on ? 1 : 0;
  }
  return toPng({ width: W, height: HEAD_DOTS, bits });
}

function qrThumb(matrix, m, invert) {
  const n = matrix.length;
  const c = h("canvas", { width: n * m, height: n * m });
  const ctx = c.getContext("2d");
  ctx.fillStyle = invert ? "#000" : "#fff";
  ctx.fillRect(0, 0, n * m, n * m);
  ctx.fillStyle = invert ? "#fff" : "#000";
  matrix.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (row[x] === "1") ctx.fillRect(x * m, y * m, m, m); });
  return c;
}
