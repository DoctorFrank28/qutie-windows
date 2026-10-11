"use strict";
/* Linked data in the editor: the Data tab, the table under the label, the record
 * navigator, the "connect a data source" dialog and the formula editor.
 */

const FIELD_TYPE_ICON = { text: "Aa", number: "#", date: "31", bool: "✓", ean13: "▥", ean8: "▥", formula: "fx" };
const fieldIcon = () => null;
/** The type as a short sign; screen readers get the name of the type instead. */
const typeMark = (t) => {
  const name = t === "formula" ? T.formula : T[`type_${FIELD_TYPE_ICON[t] ? t : "text"}Field`];
  return h("span.t", { title: name }, h("span", { "aria-hidden": "true" }, FIELD_TYPE_ICON[t] || "Aa"), h("span.sr-only", name));
};
/** Where a context menu opens: at the pointer, or under the element when it came from the
 * keyboard (menu key, Shift+F10). */
const menuAt = (e, el) => {
  if (e.button === 2) return { x: e.clientX, y: e.clientY };
  const r = el.getBoundingClientRect();
  return { x: r.left + 8, y: r.bottom };
};

const MAX_TABLE_ROWS = 500; // rows drawn in the table under the label

const DataUI = {
  tableOpen: false,
  dragField: null,

  data: () => (S.doc?.data?.columns.length ? S.doc.data : null),

  refresh() {
    if (Inspector.tab === "data") Inspector.refresh(true);
    this.renderTable();
    DataUI.renderNavigator($("#recnav"));
  },

  // ---------------------------------------------------------------- Data tab
  panel(p) {
    const data = this.data();
    if (!data) {
      p.append(h("div.empty-state",
        h("div.ic", ico("table", 22)),
        h("b", T.noSource),
        h("p", T.noSourceText),
        button(T.cmdLinkData, { variant: "primary", size: "sm", onClick: () => this.connect() }),
        button(T.pasteFromClipboard, { variant: "ghost", size: "sm", onClick: () => this.connect({ paste: true }) })));
      return;
    }
    const src = data.source;
    const status = src.kind === "file" && src.path ? (this.fileState?.[src.path] === false ? badge(T.fileMissing, "warn") : badge(src.link === "copy" ? T.copied : T.linked, "ok")) : badge(src.kind === "paste" ? T.pasted : T.internal);
    p.append(section(T.source, { summary: status },
      h("div.row", h("span.typeic", ico(src.kind === "file" ? "fileSheet" : "table")), h("div.col",
        h("strong", src.name || T.dataTableName),
        h("span.sub", [src.sheet ? T.sheetName(src.sheet) : null, T.nRows(data.rows.length), T.nColumns(data.columns.length)].filter(Boolean).join(" · ")))),
      src.kind === "file" && src.path ? swRow(T.rereadEachPrint, src.link !== "copy", (v) => this.setSource({ link: v ? "reread" : "copy" })) : null,
      h("div.g2",
        src.kind === "file" && src.path ? button(T.refresh, { size: "sm", icon: "refresh", onClick: () => this.reload() }) : button(T.editTable, { size: "sm", icon: "table", onClick: () => this.toggleTable(true) }),
        button(T.changeSource, { size: "sm", onClick: () => this.connect() }))));

    const fields = h("div.fields", ...data.columns.map((c) => this.fieldRow(c.name, c.type)));
    p.append(section(T.fields, { summary: h("span.sum", T.dragOnLabel) }, fields));

    const formulas = h("div.fields", ...(data.formulas || []).map((f) => this.fieldRow(f.name, "formula", f)));
    if (!data.formulas?.length) formulas.append(h("p.desc", T.noFormulas));
    p.append(section(T.formulaFields, { actions: button(T.newShort, { variant: "ghost", size: "sm", icon: "plus", onClick: () => this.formulaEditor() }) }, formulas));

    p.append(section(T.printing, {},
      h("div.ctl", h("div.ctl-l", h("span", T.copiesFrom)),
        selectBox([{ value: "", label: T.oneCopyEach }, ...fieldNames(data).map((n) => ({ value: n, label: n }))], data.copies || "", (v) => this.setData({ copies: v || null }), { label: T.copiesFrom })),
      h("div.ctl", h("div.ctl-l", h("span", T.order)),
        h("div.row",
          selectBox([{ value: "", label: T.fileOrder }, ...fieldNames(data).map((n) => ({ value: n, label: n }))], data.sort?.field || "", (v) => this.setData({ sort: v ? { field: v, desc: !!data.sort?.desc } : null }), { label: T.order }),
          data.sort ? iconButton(data.sort.desc ? "sortDesc" : "sortAsc", T.sortDirection, () => this.setData({ sort: { ...data.sort, desc: !data.sort.desc } }), { variant: "outline" }) : null)),
      this.filterChips(data),
      button(T.showTable, { size: "sm", icon: "table", onClick: () => this.toggleTable(true) })));
  },

  fieldRow(name, type, formula = null) {
    const data = this.data();
    const env = editEnv(S.doc);
    const example = env.texts?.[name] ?? "";
    // Dragging is the quick way; Enter (or Space) inserts the field and the menu key opens the menu.
    const row = h(`div.field-row${formula ? ".formula" : ""}`, { draggable: "true", tabindex: "0", role: "button", title: T.dragFieldHint },
      typeMark(type), h("span.nm", { title: name }, name), h("span.ex", { title: example || null }, example || "—"));
    row.addEventListener("dragstart", (e) => {
      this.dragField = name;
      e.dataTransfer.setData("text/plain", `«${name}»`);
      e.dataTransfer.effectAllowed = "copy";
    });
    row.addEventListener("dragend", () => { this.dragField = null; });
    row.addEventListener("dblclick", () => (formula ? this.formulaEditor(formula) : Studio.insertField(name)));
    row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); Studio.insertField(name); } });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showMenu([
        { label: T.addAsText, icon: "text", action: () => this.addFieldAs(name, "text") },
        { label: T.addAsQr, icon: "qr", action: () => this.addFieldAs(name, "qr") },
        { label: T.addAsBarcode, icon: "barcode", action: () => this.addFieldAs(name, "barcode") },
        "-",
        formula ? { label: T.editFormula, icon: "formula", action: () => this.formulaEditor(formula) } : {
          label: T.dataType, submenu: () => ["text", "number", "date", "bool", "ean13", "ean8"].map((t) => ({
            label: T[`type_${t}Field`], checked: type === t, radio: true,
            action: () => { History.record(null, "edit"); data.columns.find((c) => c.name === name).type = t; changed(); this.refresh(); },
          })),
        },
        { label: T.newFormulaFrom, icon: "formula", action: () => this.formulaEditor(null, `[${name}]`) },
        formula ? { label: T.deleteFormula, danger: true, action: () => { History.record(null, "edit"); data.formulas = data.formulas.filter((f) => f !== formula); changed(); this.refresh(); } } : null,
      ].filter(Boolean), menuAt(e, row));
    });
    return row;
  },

  addFieldAs(name, kind) {
    const token = `«${name}»`;
    const x = Studio.freeSpot(kind === "qr" ? 11 : 30);
    if (kind === "qr") addObject(makeObject("qr", { content: token, qrType: "field", qrData: { field: name }, x, y: 0.5, w: 11, h: 11 }));
    else if (kind === "barcode") {
      const t = fieldType(this.data(), name);
      addObject(makeObject("barcode", { kind: t === "ean13" || t === "ean8" ? t : "code128", content: token, x, y: 0.6, w: 30, h: 10.8 }));
    } else addObject(makeObject("text", { text: token, x, y: 1, w: 30, h: TAPE_MM - 2 }));
  },

  filterChips(data) {
    const chips = (data.filter || []).map((f, i) => chip(`${f.field} ${T[`opShort_${f.op}`] || f.op} ${["empty", "notEmpty", "true", "false"].includes(f.op) ? "" : f.value}`.trim(), {
      on: true, icon: "x", title: T.removeFilter, onClick: () => this.setData({ filter: data.filter.filter((_, j) => j !== i) }),
    }));
    chips.push(chip(T.addFilter, { icon: "filter", onClick: (e) => this.filterEditor(e.currentTarget) }));
    return h("div.chips", ...chips);
  },

  filterEditor(anchor, preset = null) {
    const data = this.data();
    const fields = fieldNames(data);
    const rule = preset || { field: fields[0], op: "eq", value: "" };
    const value = textInput({ value: rule.value, label: T.value });
    const content = h("div.form",
      h("h3", T.addFilter),
      selectBox(fields.map((f) => ({ value: f, label: f })), rule.field, (v) => { rule.field = v; }, { label: T.field }),
      selectBox(RULE_OPS.map((op) => ({ value: op, label: T[`op_${op}`] })), rule.op, (v) => { rule.op = v; value.hidden = ["empty", "notEmpty", "true", "false"].includes(v); }, { label: T.condition }),
      value,
      h("div.row.end", button(T.apply, { variant: "primary", size: "sm", onClick: () => { rule.value = value.input.value; this.setData({ filter: [...(data.filter || []), rule] }); pop.close(); } })));
    const pop = showPopover(content, anchor, { cls: "pad" });
  },

  setData(changes) {
    History.record(null, "data");
    Object.assign(S.doc.data, changes);
    changed();
    this.refresh();
  },

  setSource(changes) {
    History.record(null, "data");
    Object.assign(S.doc.data.source, changes);
    changed();
    this.refresh();
  },

  // ---------------------------------------------------------------- navigator ◀ 3 of 24 ▶
  renderNavigator(el) {
    if (!el) return;
    const data = this.data();
    el.hidden = !data || !data.rows.length || Studio.view !== "editor";
    if (el.hidden) return;
    const n = data.rows.length, cur = Math.min(n - 1, data.current || 0);
    const label = h("button.btn.ghost.sm.recpos", { type: "button", title: T.showTable, onclick: () => this.toggleTable() }, T.rowOf(cur + 1, n));
    clear(el).append(
      iconButton("chevronLeft", `${T.rowPrev} (Alt ←)`, () => this.goRow(-1, true), { disabled: cur <= 0 }),
      label,
      iconButton("chevronRight", `${T.rowNext} (Alt →)`, () => this.goRow(1, true), { disabled: cur >= n - 1 }),
      h("span.divider"));
  },

  goRow(target, relative = false) {
    const data = this.data();
    if (!data?.rows.length) return;
    const n = data.rows.length;
    let next = relative ? (data.current || 0) + target : target;
    if (next === Infinity) next = n - 1;
    next = Math.max(0, Math.min(n - 1, next));
    if (next === data.current) return;
    data.current = next;
    changed({ save: false });
    this.renderTable();
    Inspector.refresh(true);
  },

  // ---------------------------------------------------------------- the table under the label
  toggleTable(open = !this.tableOpen) {
    if (open && !S.doc.data) { this.connect(); return; }
    this.tableOpen = open;
    this.renderTable();
    requestAnimationFrame(() => fitView());
  },

  renderTable() {
    const el = $("#datatable");
    if (!el) return;
    const data = S.doc?.data;
    el.hidden = !this.tableOpen || !data || Studio.view !== "editor";
    if (el.hidden) return;
    const search = (data.search || "").toLowerCase();
    const visible = visibleRows(data);
    const rows = search ? visible.filter((i) => data.rows[i].some((c) => String(c).toLowerCase().includes(search))) : visible;
    const checked = new Set(data.checked || []);
    const env = editEnv(S.doc);
    // The table is rebuilt on every change: remember where the keyboard focus was (the search
    // field and its caret, or a row and its checkbox) to put it back afterwards.
    const active = el.contains(document.activeElement) ? document.activeElement : null;
    const caret = active?.dataset.focus === "search" ? [active.selectionStart, active.selectionEnd] : null;
    const focusRow = active?.closest("tr[data-row]");
    const focusCheck = focusRow && active.matches("input[type=checkbox]");
    const searchBox = textInput({ value: data.search || "", placeholder: T.searchRows, lead: "search", label: T.searchRows, onInput: debounce((v) => { data.search = v; this.renderTable(); }, 150) });
    searchBox.input.dataset.focus = "search";
    const allChecked = rows.length && rows.every((i) => checked.has(i));
    const head = h("tr",
      h("th.cbcell", { scope: "col" }, h("input", { type: "checkbox", checked: !!allChecked, "aria-label": T.checkAll, onchange: (e) => this.checkRows(rows, e.target.checked) })),
      h("th", { scope: "col" }, "#"),
      ...data.columns.map((c) => h("th", { scope: "col", title: T[`type_${c.type}Field`] }, typeMark(c.type), c.name)),
      ...(data.formulas || []).map((f) => h("th.fx", { scope: "col" }, typeMark("formula"), f.name)));
    const body = h("tbody");
    for (const i of rows.slice(0, MAX_TABLE_ROWS)) {
      const raw = rowValues(data, i);
      const tr = h(`tr${i === env.row ? ".cur" : ""}`, { "data-row": i, tabindex: "0", "aria-current": i === env.row ? "true" : null },
        h("td.cbcell", h("input", { type: "checkbox", checked: checked.has(i), "aria-label": T.checkRow(i + 1), onchange: (e) => this.checkRows([i], e.target.checked) })),
        h("td.mono", String(i + 1)),
        ...data.columns.map((c, ci) => {
          const text = display(data.rows[i][ci], c.type, c.format);
          const td = h(`td${c.type === "number" || c.type === "date" || c.type?.startsWith("ean") ? ".mono" : ""}`, { title: text.length > 30 ? text : null }, text || "—");
          td.addEventListener("dblclick", () => this.editCell(td, i, ci));
          return td;
        }),
        ...(data.formulas || []).map((f) => h("td.fx.mono", display(raw[f.name], null, f.format))));
      tr.addEventListener("click", (e) => { if (!e.target.closest("input")) this.goRow(i); });
      tr.addEventListener("contextmenu", (e) => { e.preventDefault(); this.rowMenu(e, i, tr); });
      // The keys of the row menu: Enter shows the row on the label, F2 edits its first cell.
      tr.addEventListener("keydown", (e) => {
        if (e.target !== tr) return; // keys on the checkbox stay its own
        if (e.key === "Enter") this.goRow(i);
        else if (e.key === "F2" && data.columns.length) this.editCell(tr.children[2], i, 0);
        else if (e.key === "ArrowDown" || e.key === "ArrowUp") (e.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling)?.focus();
        else return;
        e.preventDefault(); // not a command of the editor (F2 renames, arrows move objects)
      });
      body.append(tr);
    }
    const table = h("table.dtable", h("thead", head), body);
    const filterLabel = (data.filter || []).map((f) => `${f.field} ${T[`opShort_${f.op}`] || ""} ${f.value || ""}`.trim());
    clear(el).append(
      h("div.bar",
        h("h3", T.dataTable),
        badge(T.rowsChecked(data.rows.length, checked.size)),
        ...filterLabel.map((t, k) => chip(t, { on: true, icon: "x", title: T.removeFilter, onClick: () => this.setData({ filter: data.filter.filter((_, j) => j !== k) }) })),
        chip(data.sort?.field ? T.sortedBy(data.sort.field) : T.fileOrder, { onClick: (e) => showMenu([{ label: T.fileOrder, action: () => this.setData({ sort: null }) }, "-", ...fieldNames(data).map((n) => ({ label: n, action: () => this.setData({ sort: { field: n, desc: false } }) }))], { anchor: e.currentTarget }) }),
        h("span.spacer"),
        searchBox,
        data.source.kind !== "file" || data.source.link === "copy" ? button(T.addRow, { variant: "ghost", size: "sm", icon: "plus", onClick: () => this.addRow() }) : null,
        iconButton("x", T.closeTable, () => this.toggleTable(false))),
      h("div.tablewrap", table, rows.length > MAX_TABLE_ROWS ? h("p.desc", T.moreRows(rows.length - MAX_TABLE_ROWS)) : null));
    el.querySelector("tr.cur")?.scrollIntoView({ block: "nearest" });
    if (caret) { searchBox.input.focus(); searchBox.input.setSelectionRange(...caret); }
    else if (focusRow) {
      const tr = el.querySelector(`tr[data-row="${focusRow.dataset.row}"]`);
      (focusCheck ? tr?.querySelector("input[type=checkbox]") : tr)?.focus({ preventScroll: true });
    }
  },

  checkRows(rows, on) {
    const data = S.doc.data;
    const set = new Set(data.checked || []);
    for (const r of rows) on ? set.add(r) : set.delete(r);
    data.checked = [...set].sort((a, b) => a - b);
    changed();
    this.renderTable();
  },

  editCell(td, row, col) {
    const data = S.doc.data;
    if (data.source.kind === "file" && data.source.link !== "copy") {
      toast(T.editLinkedFile, { action: { label: T.copyToEdit, run: () => this.setSource({ link: "copy" }) } });
      return;
    }
    const input = h("input.cell", { value: data.rows[row][col] ?? "", "aria-label": data.columns[col].name });
    td.replaceChildren(input);
    input.focus();
    input.select();
    const done = (save) => {
      if (save && input.value !== data.rows[row][col]) {
        History.record(null, "data");
        let v = input.value;
        if (data.columns[col].type === "date") { const d = toDate(v); if (d) v = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
        data.rows[row][col] = v;
        changed();
      }
      this.renderTable();
    };
    input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
    input.addEventListener("blur", () => done(true));
  },

  addRow(after = null) {
    const data = S.doc.data;
    History.record(null, "data");
    const row = data.columns.map(() => "");
    if (after === null) data.rows.push(row); else data.rows.splice(after + 1, 0, row);
    if (data.source.kind === "file") data.source.link = "copy";
    data.current = after === null ? data.rows.length - 1 : after + 1;
    changed();
    this.renderTable();
  },

  rowMenu(e, i, tr) {
    const data = S.doc.data;
    const checked = data.checked || [];
    const firstCol = data.columns[0];
    const value = firstCol ? display(data.rows[i][0], firstCol.type) : "";
    const editable = data.source.kind !== "file" || data.source.link === "copy";
    showMenu([
      { label: T.printThisRow, icon: "printer", action: () => Dialogs.print({ rows: [i] }) },
      { label: T.printChecked(checked.length), disabled: !checked.length, action: () => Dialogs.print({ which: "checked" }) },
      { label: T.showOnLabel, shortcut: "Enter", action: () => this.goRow(i) },
      "-",
      { label: T.editCell, shortcut: "F2", disabled: !editable, action: () => this.editCell(tr.children[2], i, 0) },
      { label: T.insertRowBelow, disabled: !editable, action: () => this.addRow(i) },
      { label: T.checkAllNone, action: () => this.checkRows(data.rows.map((_, k) => k), checked.length < data.rows.length) },
      "-",
      firstCol ? { label: T.filterBy(value), action: () => this.setData({ filter: [...(data.filter || []), { field: firstCol.name, op: "eq", value: data.rows[i][0] }] }) } : null,
      data.columns[1] ? { label: T.filterBy(display(data.rows[i][1], data.columns[1].type)), action: () => this.setData({ filter: [...(data.filter || []), { field: data.columns[1].name, op: "eq", value: data.rows[i][1] }] }) } : null,
      { label: T.deleteRow, danger: true, disabled: !editable, action: () => { History.record(null, "data"); data.rows.splice(i, 1); data.checked = checked.filter((r) => r !== i).map((r) => (r > i ? r - 1 : r)); data.current = Math.min(data.current, data.rows.length - 1); changed(); this.renderTable(); } },
    ].filter(Boolean), menuAt(e, tr));
  },

  // ---------------------------------------------------------------- linked file
  /** Read the linked file again; with changes in the columns ask how to go on. */
  async reload({ quiet = false } = {}) {
    const data = this.data();
    const src = data?.source;
    if (!src?.path) return true;
    const r = await api("read_data", src.path, src.sheet, src.header !== false).catch((e) => ({ ok: false, detail: String(e) }));
    this.fileState = { ...(this.fileState || {}), [src.path]: !!r?.file?.exists };
    if (!r?.ok) {
      if (!quiet) toast(r?.file?.exists === false ? T.fileMissingCopy : T.readFailed, { kind: "error", detail: r?.detail });
      this.refresh();
      return false;
    }
    const diff = diffTables(data, r);
    const missing = missingFields({ ...S.doc, data: { ...data, columns: r.columns, formulas: data.formulas } });
    if (diff.renamed.length && missing.length) {
      const choice = await Dialogs.fileChanged(src.name, diff);
      if (choice === "copy") return true;
      if (choice === "unlinked") { this.setSource({ link: "copy" }); return true; }
      if (choice === null) return false;
      for (const rn of diff.renamed) renameField(S.doc, rn.from, rn.to);
    }
    History.record(null, "data");
    const keepTypes = Object.fromEntries(data.columns.map((c) => [c.name, c]));
    data.columns = r.columns.map((c) => ({ ...c, format: keepTypes[c.name]?.format }));
    data.rows = r.rows;
    data.source.read = new Date().toISOString();
    data.source.modified = r.file?.modified || null;
    data.checked = (data.checked || []).filter((i) => i < data.rows.length);
    data.current = Math.min(data.current || 0, Math.max(0, data.rows.length - 1));
    changed();
    this.refresh();
    if (!quiet) toast(T.dataUpdated(r.rows.length), { kind: "ok", detail: diff.added || diff.changed || diff.removed ? T.diffSummary(diff) : null });
    return true;
  },

  // ---------------------------------------------------------------- connect a source
  /** The three-step dialog: source → columns → rows to print. options: {paste, file: {path} | {file}} */
  async connect(options = {}) {
    const st = { step: 0, kind: "file", path: null, fileObj: null, sheet: null, header: true, link: "reread", table: null, text: "", which: "all", name: "" };
    if (options.paste) { st.kind = "paste"; st.text = typeof options.paste === "string" ? options.paste : ""; }
    if (options.file?.path) st.path = options.file.path;
    if (options.file?.file) st.fileObj = options.file.file;
    if (this.data()?.source.kind === "file" && !st.path && !st.fileObj && !options.paste) {
      st.path = this.data().source.path;
      st.sheet = this.data().source.sheet;
    }
    const steps = [T.stepSource, T.stepColumns, T.stepRows];
    const body = h("div.connect");
    const dlg = openDialog({ title: T.connectTitle, description: T.connectDesc, body, width: 960, cls: "connect-dlg" });

    const failed = (e) => ({ ok: false, detail: String(e) });
    const load = async () => {
      st.error = null;
      if (st.kind === "file" && (st.path || st.fileObj)) { st.loading = true; render(); } // a workbook can take a while
      if (st.kind === "file" && st.path) {
        const r = await api("read_data", st.path, st.sheet, st.header).catch(failed);
        if (r.ok) { st.table = r; st.sheet = r.sheet; st.name = r.file?.name || st.path.split(/[\\/]/).pop(); } else { st.table = null; st.error = r.detail; }
      } else if (st.kind === "file" && st.fileObj) {
        const r = await readFileAs(st.fileObj).then((bytes) => api("read_data_bytes", st.fileObj.name, bytes, st.sheet, st.header)).catch(failed);
        if (r.ok) { st.table = r; st.sheet = r.sheet; st.name = st.fileObj.name; st.link = "copy"; } else { st.table = null; st.error = r.detail; }
      } else if (st.kind === "paste" && st.text.trim()) {
        const r = await api("parse_table", st.text, st.header).catch(failed);
        st.table = r.ok ? r : null;
        st.name = T.pastedTable;
      } else if (st.kind === "table") {
        st.table = st.table?.manual ? st.table : { manual: true, columns: [{ name: T.colName, type: "text" }, { name: `${T.column} 2`, type: "text" }], rows: [["", ""], ["", ""], ["", ""]] };
        st.name = T.dataTableName;
      } else st.table = null;
      st.loading = false;
      render();
    };

    const render = () => {
      // The dialog is rebuilt at each step: keep the focus (and the caret while typing a table).
      const active = body.contains(document.activeElement) ? document.activeElement : null;
      const focusKey = active?.dataset.focus;
      const caret = active?.matches("textarea") ? [active.selectionStart, active.selectionEnd, active.scrollTop] : null;
      clear(body);
      body.append(h("ol.steps", ...steps.map((s, i) => h(`li${i < st.step ? ".done" : i === st.step ? ".on" : ""}`, s))));
      const grid = h("div.connect-grid");
      body.append(grid);
      grid.append(this.sourceColumn(st, load, render));
      grid.append(st.step === 2 ? this.rowsColumn(st, render) : this.previewColumn(st, render));
      dlg.setFooter([
        { label: T.back, variant: "ghost", disabled: st.step === 0, action: () => { st.step = Math.max(0, st.step - 1); render(); return false; } },
        { spacer: true },
        { label: T.cancel },
        st.step < 2
          ? { label: T.next, variant: "primary", disabled: !st.table?.columns?.length, action: () => { st.step++; render(); return false; } }
          : { label: T.connectDone, variant: "primary", action: () => { this.apply(st); } },
      ]);
      const again = focusKey && body.querySelector(`[data-focus="${focusKey}"]`);
      if (again) {
        again.focus({ preventScroll: true });
        if (caret) { again.setSelectionRange(caret[0], caret[1]); again.scrollTop = caret[2]; }
      }
    };
    render();
    if (st.path || st.fileObj || st.text) { st.step = 1; load(); }
  },

  sourceColumn(st, load, render) {
    const opt = (kind, title, sub) => h(`button.src${st.kind === kind ? ".on" : ""}`, {
      type: "button", "aria-pressed": String(st.kind === kind), dataset: { focus: `src-${kind}` },
      onclick: () => { st.kind = kind; st.table = kind === st.table?.kind ? st.table : null; load(); },
    }, h("span.ri"), h("div", h("b", title), h("small", sub)));
    const headerRow = () => {
      const row = swRow(T.firstRowHeader, st.header, (v) => { st.header = v; load(); });
      row.querySelector(".sw").dataset.focus = "header";
      return row;
    };
    const col = h("div.col.src-col",
      opt("file", T.srcFile, T.srcFileSub),
      opt("paste", T.srcPaste, T.srcPasteSub),
      opt("table", T.srcTable, T.srcTableSub));
    if (st.kind === "file") {
      const choose = button(st.path || st.fileObj ? T.chooseOther : T.chooseFile, { size: "sm", icon: "folder", onClick: async () => {
        const path = await api("pick_data_file").catch(() => null);
        if (path) { st.path = path; st.fileObj = null; st.sheet = null; st.step = Math.max(st.step, 1); load(); return; }
        if (!window.pywebview) {
          const file = await pickFile(".xlsx,.xlsm,.csv,.tsv,.txt,.json");
          if (file) { st.fileObj = file; st.path = null; st.step = Math.max(st.step, 1); load(); }
        }
      } });
      choose.dataset.focus = "choose";
      col.append(h("div.filebox", st.name ? h("div.row", ico("fileSheet"), h("b", st.name)) : null, st.path ? h("span.mono.sub.path", st.path) : null, choose));
      if (st.table?.sheets?.length > 1) {
        const sheet = selectBox(st.table.sheets.map((s) => ({ value: s.name, label: `${s.name} · ${T.nRows(s.rows)}` })), st.sheet, (v) => { st.sheet = v; load(); });
        sheet.dataset.focus = "sheet";
        col.append(field(T.sheet, sheet));
      }
      col.append(headerRow());
      if (st.path) {
        col.append(h("div.ctl", h("div.ctl-l", h("span", T.linkMode)),
          seg([{ value: "reread", label: T.linkReread }, { value: "copy", label: T.linkCopy }], st.link, (v) => { st.link = v; }, { full: true }),
          h("p.desc", T.linkDesc)));
      }
      if (st.error) {
        const warn = notice(st.error, { kind: "warn", iconName: "alert" });
        warn.setAttribute("role", "alert");
        col.append(warn);
      }
    }
    if (st.kind === "paste") {
      const area = h("textarea.area.mono", { rows: 8, placeholder: T.pasteHere, "aria-label": T.pasteHere, spellcheck: "false", dataset: { focus: "paste" } });
      area.value = st.text;
      const reparse = debounce(load, 300);
      area.addEventListener("input", () => { st.text = area.value; reparse(); }); // the text is kept at once: a rebuild must not lose keys
      col.append(area, headerRow(),
        button(T.pasteFromClipboard, { size: "sm", icon: "clipboard", onClick: async () => {
          const r = await api("parse_table", null, st.header);
          if (r?.ok) { st.table = r; st.name = T.pastedTable; st.text = "(clipboard)"; render(); }
          else toast(T.clipboardEmpty);
        } }));
    }
    if (st.kind === "table") col.append(h("p.desc", T.srcTableDesc));
    return col;
  },

  previewColumn(st, render) {
    const col = h("div.col.preview-col");
    const t = st.table;
    if (st.loading) {
      col.append(h("div.empty-state", { role: "status" }, h("div.ic", ico("table", 22)), h("b", T.reading)));
      return col;
    }
    if (!t?.columns?.length) {
      col.append(h("div.empty-state", h("div.ic", ico("table", 22)), h("b", T.noDataYet), h("p", T.noDataYetText)));
      return col;
    }
    col.append(h("div.row.between", h("span.lbl", T.columnsPreview), h("span.desc", T.autoDetected)));
    const head = h("tr", ...t.columns.map((c, i) => h("th", { scope: "col" },
      t.manual ? (() => { const inp = h("input.cell", { value: c.name, "aria-label": T.columnName }); inp.addEventListener("change", () => { c.name = inp.value.trim() || c.name; }); return inp; })() : c.name,
      selectBox(["text", "number", "date", "bool", "ean13", "ean8"].map((ty) => ({ value: ty, label: T[`type_${ty}Field`] })), c.type, (v) => { c.type = v; }, { cls: "ty", label: T.dataType }))));
    const body = h("tbody", ...t.rows.slice(0, 8).map((r, ri) => h("tr", ...t.columns.map((c, i) => {
      if (t.manual) {
        const inp = h("input.cell", { value: r[i] ?? "", "aria-label": `${c.name} ${ri + 1}` });
        inp.addEventListener("change", () => { r[i] = inp.value; });
        return h("td", inp);
      }
      return h(`td${c.type !== "text" && c.type !== "bool" ? ".mono" : ""}`, display(r[i], c.type) || "—");
    }))));
    col.append(h("div.tablewrap", h("table.dtable.small", h("thead", head), body)));
    if (t.manual) {
      col.append(h("div.row",
        button(T.addRow, { variant: "ghost", size: "sm", icon: "plus", onClick: () => { t.rows.push(t.columns.map(() => "")); render(); } }),
        button(T.addColumn, { variant: "ghost", size: "sm", icon: "plus", onClick: () => { t.columns.push({ name: `${T.column} ${t.columns.length + 1}`, type: "text" }); t.rows.forEach((r) => r.push("")); render(); } })));
    }
    if (t.rows.length > 8) col.append(h("p.desc", T.moreRows(t.rows.length - 8)));
    const qty = t.columns.find((c) => c.type === "number");
    const code = t.columns.find((c) => c.type === "ean13" || c.type === "ean8");
    if (qty || code) col.append(notice([qty ? T.qtyHint(qty.name) : "", code ? T.codeHint(code.name) : ""].filter(Boolean).join(" ")));
    const used = new Set(S.doc.objects.flatMap((o) => fieldsIn(`${o.text || ""} ${o.content || ""}`)));
    if (used.size) {
      const names = t.columns.map((c) => c.name);
      col.append(h("div.ctl", h("div.ctl-l", h("span", T.fieldsOnLabel)),
        h("div.chips", ...[...used].map((f) => chip(names.includes(f) ? `«${f}» → ${f}` : T.fieldNoColumn(f), { on: names.includes(f) })))));
    }
    return col;
  },

  rowsColumn(st, render) {
    const t = st.table;
    const col = h("div.col.preview-col");
    const qty = t.columns.filter((c) => c.type === "number");
    st.copies ??= qty.find((c) => /quant|qty|copie|copies|anzahl|cantidad|qté/i.test(c.name))?.name || null;
    col.append(
      h("div.ctl", h("div.ctl-l", h("span", T.whichRows)),
        seg([{ value: "all", label: T.allRows(t.rows.length) }, { value: "checked", label: T.checkedRowsLater }], st.which, (v) => { st.which = v; }, { full: true })),
      h("div.ctl", h("div.ctl-l", h("span", T.copiesFrom)),
        selectBox([{ value: "", label: T.oneCopyEach }, ...t.columns.map((c) => ({ value: c.name, label: c.name }))], st.copies || "", (v) => { st.copies = v || null; render(); })),
      h("p.desc", st.copies ? T.copiesTotal(t.rows.reduce((s, r) => { const v = toNumber(r[t.columns.findIndex((c) => c.name === st.copies)]); return s + (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 1); }, 0)) : T.oneLabelPerRow(t.rows.length)),
      notice(T.rowsLaterHint));
    if (!S.doc.objects.some((o) => fieldsIn(`${o.text || ""} ${o.content || ""}`).length)) {
      col.append(swRow(T.addFirstField, st.addField !== false, (v) => { st.addField = v; }));
    }
    return col;
  },

  apply(st) {
    const t = st.table;
    if (!t?.columns?.length) return;
    History.record(null, "data");
    const old = S.doc.data;
    S.doc.data = newData({
      source: {
        kind: st.kind === "paste" ? "paste" : st.kind === "table" ? "table" : "file",
        name: st.name || T.dataTableName, path: st.kind === "file" ? st.path : null, sheet: st.sheet || null,
        header: st.header, link: st.kind === "file" && st.path ? st.link : "copy",
        read: new Date().toISOString(), modified: t.file?.modified || null,
      },
      columns: t.columns.map((c) => ({ name: c.name, type: c.type })),
      rows: t.rows.map((r) => t.columns.map((_, i) => r[i] ?? "")),
      formulas: old?.formulas?.filter((f) => !t.columns.some((c) => c.name === f.name)) || [],
      copies: st.copies || null,
      which: st.which === "checked" ? "checked" : "all",
    });
    if (st.addField !== false && !S.doc.objects.some((o) => fieldsIn(`${o.text || ""} ${o.content || ""}`).length)) {
      const first = t.columns[0].name;
      const textObj = S.doc.objects.find((o) => o.type === "text");
      if (textObj && (!textObj.text || textObj.text === T.sampleText)) textObj.text = `«${first}»`;
      else S.doc.objects.push(makeObject("text", { name: first, text: `«${first}»`, x: Studio.freeSpot(30), y: 1, w: 30, h: TAPE_MM - 2 }));
    }
    changed({ structure: true });
    this.toggleTable(true);
    Inspector.show("data");
    this.refresh();
    toast(T.sourceConnected(S.doc.data.source.name), { kind: "ok" });
  },

  // ---------------------------------------------------------------- formula editor
  formulaEditor(existing = null, start = "") {
    const data = this.data();
    if (!data) { this.connect(); return; }
    const known = columnNames(data).concat((data.formulas || []).filter((f) => f !== existing).map((f) => f.name));
    const st = { name: existing?.name || T.newFormulaName(data.formulas.length + 1), expr: existing?.expr || start, format: existing?.format || "short" };
    const name = textInput({ value: st.name, label: T.fieldName, onInput: (v) => { st.name = v; } });
    const code = h("textarea.code", { rows: 4, spellcheck: "false", "aria-label": T.formula });
    code.value = st.expr;
    const highlight = h("div.code-hl", { "aria-hidden": "true" });
    const err = h("p.desc.err", { role: "status" });
    const results = h("div.tablewrap");
    const insert = (text) => {
      const s = code.selectionStart ?? code.value.length, e = code.selectionEnd ?? s;
      code.value = code.value.slice(0, s) + text + code.value.slice(e);
      code.focus();
      code.setSelectionRange(s + text.length, s + text.length);
      update();
    };
    const fnButtons = h("div.chips", ...functionList().map((f) => chip(f, { mono: true, onClick: () => insert(`${f}(`) })));
    const fieldButtons = h("div.chips", ...known.map((f) => chip(f, { onClick: () => insert(`[${f}]`) })));
    const formatSeg = seg([{ value: "short", label: formatDate(new Date(2027, 2, 18), "short") }, { value: "month", label: formatDate(new Date(2027, 2, 18), "month") }, { value: "long", label: formatDate(new Date(2027, 2, 18), "long") }],
      st.format, (v) => { st.format = v; update(); }, { label: T.dateFormat });
    const update = () => {
      st.expr = code.value;
      clear(highlight).append(...highlightFormula(st.expr, known));
      const c = compiled(st.expr, known);
      err.textContent = st.expr.trim() ? c.error || "" : "";
      clear(results);
      if (c.error || !st.expr.trim()) return;
      const first = data.columns[0]?.name;
      const used = [...new Set(tokenizeSafe(st.expr, known).filter((t) => t.t === "field").map((t) => t.v))].slice(0, 3);
      const trs = data.rows.slice(0, 5).map((_, i) => {
        const vals = rowValues(data, i);
        let v;
        try { v = evalTree(c.tree, vals); } catch { v = ""; }
        const type = (n) => data.columns.find((x) => x.name === n)?.type;
        return h("tr", h("td.mono", String(i + 1)), first ? h("td", display(vals[first], type(first))) : null,
          ...used.map((u) => h("td.mono", display(vals[u], type(u)) || "—")), h("td.mono", h("b", display(v, null, st.format) || "—")));
      });
      results.append(h("table.dtable.small", h("thead", h("tr", h("th", { scope: "col" }, T.row), first ? h("th", { scope: "col" }, first) : null, ...used.map((u) => h("th", { scope: "col" }, u)), h("th", { scope: "col" }, T.result))), h("tbody", ...trs)));
    };
    code.addEventListener("input", update);
    code.addEventListener("scroll", () => { highlight.scrollTop = code.scrollTop; });
    const body = h("div.formula-ed",
      field(T.fieldName, name),
      h("div.code-wrap", highlight, code), err,
      h("p.desc", T.formulaHelp),
      h("div.ctl", h("div.ctl-l", h("span", T.fields)), fieldButtons),
      h("div.ctl", h("div.ctl-l", h("span", T.functions)), fnButtons),
      results,
      h("div.row", h("span.desc", T.dateFormat), formatSeg));
    update();
    openDialog({
      title: existing ? T.editFormula : T.newFormula, description: T.formulaDesc, body, width: 720,
      footer: [
        existing ? { label: T.deleteFormula, variant: "ghost", danger: true, action: () => { History.record(null, "data"); data.formulas = data.formulas.filter((f) => f !== existing); changed(); this.refresh(); } } : null,
        { spacer: true }, { label: T.cancel },
        {
          label: T.saveField, variant: "primary", action: () => {
            const c = compiled(code.value, known);
            if (c.error) { err.textContent = c.error; return false; }
            const fieldName = st.name.trim();
            if (!fieldName || known.includes(fieldName)) { err.textContent = T.fieldNameTaken; return false; }
            History.record(null, "data");
            if (existing) {
              if (existing.name !== fieldName) renameField(S.doc, existing.name, fieldName);
              Object.assign(existing, { name: fieldName, expr: code.value, format: st.format });
            } else data.formulas.push({ name: fieldName, expr: code.value, format: st.format });
            changed();
            this.refresh();
          },
        },
      ].filter(Boolean),
    });
  },
};

function tokenizeSafe(expr, fields) {
  try { return tokenize(expr, fields); } catch { return []; }
}

/** The formula with functions, fields, numbers and text coloured (shown under the textarea). */
function highlightFormula(expr, fields) {
  const tokens = tokenizeSafe(expr, fields);
  if (!tokens.length) return [document.createTextNode(expr + "\n")];
  const out = [];
  let pos = 0;
  for (const t of tokens) {
    if (t.at > pos) out.push(document.createTextNode(expr.slice(pos, t.at)));
    let end = t.at + 1;
    if (t.t === "fn") end = t.at + t.len;
    else if (t.t === "field") end = t.len ? t.at + t.len : expr.indexOf(expr[t.at] === "[" ? "]" : "»", t.at) + 1;
    else if (t.t === "str") end = expr.indexOf('"', t.at + 1) + 1;
    else if (t.t === "num" || t.t === "bool") end = t.at + (/^[\d.,]+|^\p{L}+/u.exec(expr.slice(t.at))?.[0].length || 1);
    else if (t.t === "op") end = t.at + t.v.length;
    const cls = { fn: "fn", field: "fld", num: "num", str: "str", bool: "num" }[t.t];
    out.push(cls ? h(`span.${cls}`, expr.slice(t.at, end)) : document.createTextNode(expr.slice(t.at, end)));
    pos = end;
  }
  if (pos < expr.length) out.push(document.createTextNode(expr.slice(pos)));
  out.push(document.createTextNode("\n"));
  return out;
}

// Fields dragged from the Data panel onto the label become text (or codes).
stage.addEventListener("dragover", (e) => { if (DataUI.dragField) { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; } });
stage.addEventListener("drop", (e) => {
  if (!DataUI.dragField) return;
  e.preventDefault();
  e.stopPropagation();
  const name = DataUI.dragField;
  DataUI.dragField = null;
  const [x, y] = screenToMm(...pointerPos(e));
  const hit = hitObject(x, y);
  if (hit && (hit.type === "text" || hit.type === "barcode" || hit.type === "qr")) { Studio.linkField(hit, name); select(hit.id); return; }
  const type = fieldType(S.doc.data, name);
  const o = type === "ean13" || type === "ean8"
    ? makeObject("barcode", { kind: type, content: `«${name}»`, x: round3(x - 15), y: 0.6, w: 30, h: 10.8 })
    : makeObject("text", { text: `«${name}»`, name, x: round3(x - 2), y: round3(Math.max(0, Math.min(TAPE_MM - 5, y - 2.5))), w: 30, h: 5 });
  addObject(o);
});
