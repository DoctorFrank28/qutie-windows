"use strict";
/* Commands: one registry for the menu bar, the context menus, the keyboard shortcuts
 * and the command palette (Ctrl+K). A command knows its label, icon, keys, when it is
 * available and what it does.
 */

const inEditor = () => Studio.view === "editor" && !!S.doc;
const hasSel = () => inEditor() && S.selection.length > 0;
const hasEditable = () => inEditor() && editable().length > 0;
const hasData = () => inEditor() && !!S.doc.data?.columns.length;

/** id → {label, icon, keys, when, checked, run} */
const CMD = {};
function command(id, spec) { CMD[id] = { id, when: () => true, ...spec }; }

function run(id, ...args) {
  const c = CMD[id];
  if (!c || !c.when()) return false;
  c.run(...args);
  return true;
}

/** A menu item for a command. */
function mi(id, extra = {}) {
  const c = CMD[id];
  if (!c) return null;
  const label = typeof c.label === "function" ? c.label() : c.label;
  return {
    label, icon: c.icon, shortcut: c.keys?.split(" / ")[0], disabled: !c.when(),
    checked: c.checked ? c.checked() : undefined, radio: c.radio, danger: c.danger,
    action: () => run(id), ...extra,
  };
}

// ------------------------------------------------------------------ file
command("new", { label: () => T.cmdNew, icon: "filePlus", keys: "Ctrl+N", run: () => Studio.newBlank() });
command("newFromTemplate", { label: () => T.cmdNewFromTemplate, icon: "templates", run: () => Dialogs.templates() });
command("open", { label: () => T.cmdOpen, icon: "folder", keys: "Ctrl+O", run: () => Studio.open() });
command("save", { label: () => T.cmdSave, icon: "save", keys: "Ctrl+S", when: inEditor, run: () => Studio.save() });
command("saveAs", { label: () => T.cmdSaveAs, keys: "Ctrl+Shift+S", when: inEditor, run: () => Studio.save(true) });
command("saveTemplate", { label: () => T.cmdSaveTemplate, when: inEditor, run: () => Dialogs.saveTemplate() });
command("linkData", { label: () => T.cmdLinkData, icon: "table", when: inEditor, run: () => DataUI.connect() });
command("exportPng", { label: () => T.cmdExportPng, icon: "download", keys: "Ctrl+E", when: inEditor, run: () => Dialogs.exporter("png") });
command("exportPdf", { label: () => T.cmdExportPdf, when: inEditor, run: () => Dialogs.exporter("pdf") });
command("print", { label: () => T.cmdPrint, icon: "printer", keys: "Ctrl+P", when: inEditor, run: () => Dialogs.print() });
command("printNow", { label: () => T.cmdPrintNow, keys: "Ctrl+Shift+P", when: inEditor, run: () => Studio.printNow() });
command("home", { label: () => T.cmdHome, icon: "home", when: () => Studio.view === "editor", run: () => Studio.show("home") });
// The label stays open while the Home pages are shown: Esc (or this command) goes back to it.
command("backToLabel", { label: () => T.cmdBackToLabel, icon: "chevronLeft", keys: "Esc", when: () => Studio.view === "home" && !!S.doc, run: () => Studio.show("editor") });
command("quit", { label: () => T.cmdQuit, keys: "Alt+F4", run: () => Studio.quit() });

// ------------------------------------------------------------------ edit
command("undo", {
  label: () => (History.lastLabel() && T[`act_${History.lastLabel()}`] ? T.cmdUndoWhat(T[`act_${History.lastLabel()}`]) : T.cmdUndo),
  icon: "undo", keys: "Ctrl+Z", when: () => inEditor() && History.past.length > 0, run: () => History.undo(),
});
command("redo", { label: () => T.cmdRedo, icon: "redo", keys: "Ctrl+Y / Ctrl+Shift+Z", when: () => inEditor() && History.future.length > 0, run: () => History.redo() });
command("cut", { label: () => T.cmdCut, icon: "scissors", keys: "Ctrl+X", when: hasEditable, run: () => { Clip.copy(); deleteSelected(); } });
command("copy", { label: () => T.cmdCopy, icon: "copy", keys: "Ctrl+C", when: hasSel, run: () => Clip.copy() });
command("copyStyle", { label: () => T.cmdCopyStyle, keys: "Ctrl+Alt+C", when: () => inEditor() && S.selection.length === 1, run: () => Clip.copyStyle() });
command("pasteStyle", { label: () => T.cmdPasteStyle, keys: "Ctrl+Alt+V", when: () => hasEditable() && !!Clip.style, run: () => Clip.pasteStyle() });
command("paste", { label: () => T.cmdPaste, icon: "clipboard", keys: "Ctrl+V", when: inEditor, run: () => Clip.paste() });
command("pasteText", { label: () => T.cmdPasteText, keys: "Ctrl+Shift+V", when: inEditor, run: () => Clip.paste({ textOnly: true }) });
command("duplicate", { label: () => T.cmdDuplicate, icon: "copy", keys: "Ctrl+D", when: hasSel, run: () => duplicateSelected() });
command("delete", { label: () => T.cmdDelete, icon: "trash", keys: "Del", danger: true, when: hasEditable, run: () => deleteSelected() });
command("selectAll", { label: () => T.cmdSelectAll, keys: "Ctrl+A", when: inEditor, run: () => select(S.doc.objects.filter((o) => !o.hidden && !o.locked).map((o) => o.id)) });
command("deselect", { label: () => T.cmdDeselect, keys: "Esc", when: hasSel, run: () => select([]) });
command("selectSimilar", { label: () => T.cmdSelectSimilar, when: () => inEditor() && S.selection.length === 1, run: () => { const t = selected()[0]; select(S.doc.objects.filter((o) => o.type === t.type && !!o.symbol === !!t.symbol && !o.hidden).map((o) => o.id)); } });
command("findReplace", { label: () => T.cmdFindReplace, icon: "search", keys: "Ctrl+H", when: inEditor, run: () => Dialogs.findReplace() });
command("editText", { label: () => T.cmdEditText, icon: "text", keys: "Enter", when: () => inEditor() && S.selection.length === 1, run: () => Inspector.focusContent(S.selection[0]) });
command("rename", { label: () => T.cmdRename, keys: "F2", when: () => inEditor() && S.selection.length === 1, run: () => Inspector.renameLayer(S.selection[0]) });

// ------------------------------------------------------------------ insert
for (const [tool, key, iconName] of [["text", "T", "text"], ["rect", "R", "rect"], ["ellipse", "E", "ellipse"], ["line", "L", "line"]]) {
  command(`insert_${tool}`, { label: () => T[`tool_${tool}`], icon: iconName, keys: key, when: inEditor, run: () => Studio.insert(tool) });
}
command("insert_image", { label: () => T.cmdInsertImage, icon: "image", keys: "I", when: inEditor, run: () => Studio.insert("image") });
command("insert_qr", { label: () => T.cmdInsertQr, icon: "qr", keys: "Q", when: inEditor, run: () => Studio.insert("qr") });
command("insert_barcode", { label: () => T.cmdInsertBarcode, icon: "barcode", keys: "B", when: inEditor, run: () => Studio.insert("barcode") });
command("insert_symbol", { label: () => T.cmdInsertSymbol, icon: "symbol", keys: "S", when: inEditor, run: () => Dialogs.symbols() });
command("insert_formula", { label: () => T.cmdInsertFormula, icon: "formula", when: inEditor, run: () => DataUI.formulaEditor() });
command("toolSelect", { label: () => T.tool_select, icon: "select", keys: "V", when: inEditor, run: () => setTool("select") });
command("toolHand", { label: () => T.tool_hand, icon: "hand", keys: "H", when: inEditor, run: () => setTool("hand") });

// ------------------------------------------------------------------ arrange
const ALIGNS = [["left", "alignLeft", "Alt+Shift+A"], ["hcenter", "alignHCenter", "Alt+Shift+H"], ["right", "alignRight", "Alt+Shift+D"],
  ["top", "alignTop", "Alt+Shift+W"], ["vcenter", "alignVCenter", "Alt+Shift+V"], ["bottom", "alignBottom", "Alt+Shift+S"]];
for (const [edge, iconName, keys] of ALIGNS) {
  command(`align_${edge}`, { label: () => T[`align_${edge}`], icon: iconName, keys, when: hasEditable, run: () => align(edge) });
}
command("alignToLabel", { label: () => T.alignToLabel, radio: true, checked: () => S.alignTo === "label" || (S.alignTo === "auto" && S.selection.length < 2), when: inEditor, run: () => { S.alignTo = "label"; Inspector.refresh(); } });
command("alignToSelection", { label: () => T.alignToSelection, radio: true, checked: () => S.alignTo === "selection" || (S.alignTo === "auto" && S.selection.length > 1), when: inEditor, run: () => { S.alignTo = "selection"; Inspector.refresh(); } });
command("distribute_h", { label: () => T.distributeH, icon: "distH", when: () => editable().length >= 3 && inEditor(), run: () => distribute("h") });
command("distribute_v", { label: () => T.distributeV, icon: "distV", when: () => editable().length >= 3 && inEditor(), run: () => distribute("v") });
command("toFront", { label: () => T.toFront, icon: "toFront", keys: "Ctrl+Shift+]", when: hasSel, run: () => reorder(Infinity) });
command("forward", { label: () => T.forward, icon: "front", keys: "Ctrl+]", when: hasSel, run: () => reorder(1) });
command("backward", { label: () => T.backward, icon: "back", keys: "Ctrl+[", when: hasSel, run: () => reorder(-1) });
command("toBack", { label: () => T.toBack, icon: "toBack", keys: "Ctrl+Shift+[", when: hasSel, run: () => reorder(-Infinity) });
command("rotateRight", { label: () => T.rotateRight, icon: "rotate", keys: "Ctrl+R", when: hasEditable, run: () => rotateBy(90) });
command("rotateLeft", { label: () => T.rotateLeft, keys: "Ctrl+Shift+R", when: hasEditable, run: () => rotateBy(-90) });
command("flipH", { label: () => T.flipH, icon: "flipH", when: hasEditable, run: () => flip("h") });
command("flipV", { label: () => T.flipV, icon: "flipV", when: hasEditable, run: () => flip("v") });
command("group", { label: () => T.cmdGroup, icon: "group", keys: "Ctrl+G", when: () => editable().length > 1 && inEditor(), run: () => groupSelection() });
command("ungroup", { label: () => T.cmdUngroup, keys: "Ctrl+Shift+G", when: () => inEditor() && editable().some((o) => o.group), run: () => ungroupSelection() });
command("lock", {
  label: () => (selected().every((o) => o.locked) && S.selection.length ? T.cmdUnlock : T.cmdLock), icon: "lock", keys: "Ctrl+L", when: hasSel,
  run: () => { const lock = !selected().every((o) => o.locked); setProps({ locked: lock }, null, selected()); if (lock) select([]); },
});
command("hide", {
  label: () => (selected().every((o) => o.hidden) && S.selection.length ? T.cmdShow : T.cmdHide), icon: "eyeOff", keys: "Ctrl+Shift+H", when: hasSel,
  run: () => setProps({ hidden: !selected().every((o) => o.hidden) }, null, selected()),
});

// ------------------------------------------------------------------ view
command("viewDots", { label: () => T.viewDots, radio: true, keys: "D", checked: () => S.view.mode === "dots", when: inEditor, run: () => Studio.setViewMode("dots") });
command("viewSmooth", { label: () => T.viewSmooth, radio: true, keys: "D", checked: () => S.view.mode === "smooth", when: inEditor, run: () => Studio.setViewMode("smooth") });
command("toggleView", { label: () => T.toggleView, keys: "D", when: inEditor, run: () => Studio.setViewMode(S.view.mode === "dots" ? "smooth" : "dots") });
command("zoomIn", { label: () => T.zoomIn, icon: "plus", keys: "Ctrl+=", when: inEditor, run: () => zoomAt(1.25) });
command("zoomOut", { label: () => T.zoomOut, icon: "minus", keys: "Ctrl+-", when: inEditor, run: () => zoomAt(0.8) });
command("zoomFit", { label: () => T.zoomFit, icon: "fit", keys: "Ctrl+0", when: inEditor, run: () => fitView() });
command("zoomActual", { label: () => T.zoomActual, keys: "Ctrl+1", when: inEditor, run: () => actualSize() });
command("rulers", { label: () => T.rulers, keys: "Ctrl+Alt+R", checked: () => S.rulers, when: inEditor, run: () => Studio.toggle("rulers") });
command("snap", { label: () => T.snap, icon: "magnet", keys: "Ctrl+;", checked: () => S.snap, when: inEditor, run: () => Studio.toggle("snap") });
command("grid", { label: () => T.grid1mm, icon: "grid", keys: "Ctrl+'", checked: () => S.grid, when: inEditor, run: () => Studio.toggle("grid") });
command("dataTable", { label: () => T.dataTable, icon: "table", keys: "Ctrl+Shift+T", checked: () => DataUI.tableOpen, when: inEditor, run: () => DataUI.toggleTable() });
command("panel", { label: () => T.propertiesPanel, keys: "F4", checked: () => !document.body.classList.contains("no-panel"), when: inEditor, run: () => Studio.togglePanel() });
for (const theme of ["system", "light", "dark"]) {
  command(`theme_${theme}`, { label: () => T[`theme_${theme}`], radio: true, checked: () => (Studio.config.theme || "system") === theme, run: () => Studio.setConfig({ theme }) });
}

// ------------------------------------------------------------------ printer
command("printTest", { label: () => T.printTest, run: () => Studio.printerAction("test_label") });
command("feed", { label: () => T.feed, keys: "Ctrl+Shift+F", run: () => Studio.printerAction("feed") });
command("mediaGap", { label: () => T.mediaGap, radio: true, checked: () => S.doc?.label.media !== "continuous", when: inEditor, run: () => Studio.setMedia("gap") });
command("mediaContinuous", { label: () => T.mediaContinuous, radio: true, checked: () => S.doc?.label.media === "continuous", when: inEditor, run: () => Studio.setMedia("continuous") });
command("mediaInserted", { label: () => T.mediaInserted, when: () => inEditor() && !!Studio.printer.info, run: () => Studio.setMedia(Studio.printer.info.paper) });
command("density", { label: () => T.densityMenu, run: () => Studio.show("home", "printer") });
command("autoOff", { label: () => T.autoOffMenu, run: () => Studio.show("home", "printer") });
command("printerSettings", { label: () => T.printerSettings, icon: "settings", run: () => Studio.show("home", "printer") });
command("pairAnother", { label: () => T.pairAnother, run: () => api("open_setup", "install") });
command("readPrinter", { label: () => T.readAgain, icon: "refresh", run: () => Studio.refreshPrinter(true) });

// ------------------------------------------------------------------ data
command("rowPrev", { label: () => T.rowPrev, keys: "Alt+Left", when: hasData, run: () => DataUI.goRow(-1, true) });
command("rowNext", { label: () => T.rowNext, keys: "Alt+Right", when: hasData, run: () => DataUI.goRow(1, true) });
command("rowFirst", { label: () => T.rowFirst, keys: "Alt+Home", when: hasData, run: () => DataUI.goRow(0) });
command("rowLast", { label: () => T.rowLast, keys: "Alt+End", when: hasData, run: () => DataUI.goRow(Infinity) });
command("reloadData", { label: () => T.reloadData, icon: "refresh", keys: "F5", when: () => hasData() && !!S.doc.data.source.path, run: () => DataUI.reload() });

// ------------------------------------------------------------------ help
command("shortcuts", { label: () => T.cmdShortcuts, icon: "keyboard", keys: "Ctrl+/", run: () => Dialogs.shortcuts() });
command("palette", { label: () => T.cmdPalette, icon: "command", keys: "Ctrl+K", run: () => Dialogs.palette() });
command("guide", { label: () => T.cmdGuide, keys: "F1", run: () => Dialogs.guide() });
command("ditherExamples", { label: () => T.cmdDitherExamples, run: () => Dialogs.ditherExamples() });
command("whatsNew", { label: () => T.cmdWhatsNew, run: () => Dialogs.whatsNew() });
command("about", { label: () => T.cmdAbout, icon: "info", run: () => Dialogs.about() });
command("checkUpdates", { label: () => T.cmdCheckUpdates, icon: "refresh", run: () => Dialogs.checkUpdates() });
command("reportProblem", { label: () => T.cmdReportProblem, icon: "message", run: () => api("open_page", "issues").catch(() => {}) });

// ------------------------------------------------------------------ menu bar
const MENUS = {
  file: () => [
    mi("new"), mi("newFromTemplate"), mi("open"),
    { label: T.openRecent, submenu: () => Studio.recentMenu(), disabled: !Studio.recent.length },
    "-", mi("save"), mi("saveAs"), mi("saveTemplate"),
    "-", mi("linkData"), mi("exportPng"), mi("exportPdf"),
    "-", mi("print"), mi("printNow"),
    "-", Studio.view === "home" ? mi("backToLabel") : mi("home"), mi("quit"),
  ],
  edit: () => [
    mi("undo"), mi("redo"), "-", mi("cut"), mi("copy"), mi("paste"), mi("pasteText"), mi("duplicate"), mi("delete"),
    "-", mi("selectAll"), mi("deselect"), "-", mi("findReplace"),
  ],
  insert: () => [
    mi("insert_text"), mi("insert_rect"), mi("insert_ellipse"), mi("insert_line"),
    "-", mi("insert_image"), mi("insert_qr"), mi("insert_barcode"), mi("insert_symbol"),
    "-", { label: T.insertField, icon: "braces", disabled: !hasData(), submenu: () => fieldMenu((f) => Studio.insertField(f)) },
    { label: T.insertVariable, disabled: !inEditor(), submenu: () => variableMenu((v) => Studio.insertVariable(v)) },
    mi("insert_formula"),
  ],
  arrange: () => [
    { label: T.align, icon: "alignLeft", disabled: !hasEditable(), submenu: () => alignMenu() },
    { label: T.distribute, icon: "distH", disabled: editable().length < 3, submenu: () => [mi("distribute_h"), mi("distribute_v")] },
    "-", mi("toFront"), mi("forward"), mi("backward"), mi("toBack"),
    "-", mi("rotateRight"), mi("rotateLeft"), mi("flipH"), mi("flipV"),
    "-", mi("group"), mi("ungroup"), mi("lock"),
  ],
  view: () => [
    { header: T.rendering }, mi("viewDots", { shortcut: "D" }), mi("viewSmooth", { shortcut: null }),
    "-", mi("zoomIn"), mi("zoomOut"), mi("zoomFit"), mi("zoomActual"),
    "-", mi("rulers"), mi("snap"), mi("grid"), mi("dataTable"), mi("panel"),
    "-", { header: T.theme }, mi("theme_system"), mi("theme_light"), mi("theme_dark"),
  ],
  printer: () => [
    { custom: printerMenuStatus() },
    "-", mi("print"), mi("printTest"), mi("feed"),
    "-", { header: T.media }, mi("mediaGap"), mi("mediaContinuous"), mi("mediaInserted"),
    "-", mi("density"), mi("autoOff"), mi("printerSettings"), mi("pairAnother"),
  ],
  help: () => [mi("shortcuts"), mi("palette"), mi("guide"), mi("ditherExamples"), "-", mi("whatsNew"), mi("checkUpdates"), mi("reportProblem"), "-", mi("about")],
};

function alignMenu() {
  return [{ header: T.relativeTo }, mi("alignToLabel"), mi("alignToSelection"), "-", ...ALIGNS.map(([edge]) => mi(`align_${edge}`))];
}

function fieldMenu(pick) {
  const names = fieldNames(S.doc?.data);
  if (!names.length) return [{ label: T.noFields, disabled: true }];
  return names.map((n) => ({ label: n, icon: fieldIcon(S.doc.data, n), action: () => pick(n) }));
}

function variableMenu(pick) {
  return VARIABLE_CHOICES().map((v) => ({ label: v.label, hint: v.token, action: () => pick(v.token) }));
}

/** The variables offered in menus and chips, written as the user's language writes them. */
const VARIABLE_CHOICES = () => [
  { label: T.varCounter, token: "{n}" },
  { label: T.varToday, token: `{${T.varDateWord}}` },
  { label: T.varIn30, token: `{${T.varDateWord}+30}` },
  { label: T.varMonth, token: `{${T.varMonthWord}}` },
  { label: T.varTime, token: `{${T.varTimeWord}}` },
];

function printerMenuStatus() {
  const p = Studio.printer;
  const text = p.state === "ok" ? T.printerConnected : p.state === "reading" ? T.printerReading : T.printerUnreachable;
  const detail = p.state === "ok" ? `${T.batteryPct(p.info.battery)} · ${p.info.paper === "continuous" ? T.mediaContinuous.toLocaleLowerCase(LOCALE) : T.mediaGap.toLocaleLowerCase(LOCALE)}` : T.printerHint;
  return h("div.menu-status", ico(p.state === "ok" ? "battery" : "bluetooth"), h("span", h("b", text), h("br"), h("span", detail)));
}

function buildMenubar(nav) {
  clear(nav);
  nav.setAttribute("role", "menubar");
  const names = [["file", T.menuFile], ["edit", T.menuEdit], ["insert", T.menuInsert], ["arrange", T.menuArrange], ["view", T.menuView], ["printer", T.menuPrinter], ["help", T.menuHelp]];
  let open = null;
  const buttons = names.map(([key, label], i) => {
    // One tab stop for the whole bar: the arrows move between the menus.
    const b = h("button.mb", { type: "button", role: "menuitem", "aria-haspopup": "menu", "aria-expanded": "false", tabindex: i ? "-1" : "0" }, label);
    b.addEventListener("focus", () => { for (const x of buttons) x.tabIndex = x === b ? 0 : -1; });
    const show = () => {
      open?.close();
      b.setAttribute("aria-expanded", "true");
      b.classList.add("on");
      open = showMenu(MENUS[key], { anchor: b }, {
        label,
        onClose: () => { b.setAttribute("aria-expanded", "false"); b.classList.remove("on"); if (open?.button === b) open = null; },
      });
      open.button = b;
    };
    b.addEventListener("click", () => (open?.button === b ? open.close() : show()));
    b.addEventListener("pointerenter", () => { if (open && open.button !== b) show(); });
    b.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); show(); }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        const i = buttons.indexOf(b);
        buttons[(i + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length].focus();
      }
      if (e.key === "Home" || e.key === "End") { e.preventDefault(); buttons[e.key === "Home" ? 0 : buttons.length - 1].focus(); }
    });
    return b;
  });
  append(nav, buttons);
  // Arrows left/right inside an open menu move to the next menu.
  nav.addEventListener("keydown", () => {});
  document.addEventListener("keydown", (e) => {
    if (!open || !["ArrowLeft", "ArrowRight"].includes(e.key) || !open.el.contains(document.activeElement)) return;
    const item = document.activeElement;
    if (e.key === "ArrowRight" && item?._item?.submenu) return;
    if (e.key === "ArrowLeft" && openOverlays[openOverlays.length - 1] !== open) return;
    e.preventDefault();
    const i = buttons.indexOf(open.button);
    const next = buttons[(i + (e.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length];
    next.click();
  });
}

// ------------------------------------------------------------------ context menus
function objectContextMenu(x, y) {
  const one = S.selection.length === 1 ? selected()[0] : null;
  const items = [];
  if (one && (one.type === "text" || one.type === "barcode" || one.type === "qr")) items.push(mi("editText", { label: T.cmdEditText }), "-");
  items.push(mi("cut"), mi("copy"), mi("copyStyle"), Clip.style ? mi("pasteStyle") : null, mi("duplicate"),
    "-", { label: T.align, icon: "alignLeft", submenu: () => alignMenu() },
    { label: T.order, icon: "layers", submenu: () => [mi("toFront"), mi("forward"), mi("backward"), mi("toBack")] });
  if (one && (one.type === "text" || one.type === "barcode" || one.type === "qr")) {
    items.push("-", { label: T.linkField, icon: "braces", disabled: !hasData(), submenu: () => fieldMenu((f) => Studio.linkField(one, f)) });
  }
  if (one) items.push({ label: T.conditionalVisibility, action: () => Inspector.show("props", "visibility") });
  if (S.selection.length > 1) items.push("-", mi("group"));
  if (selected().some((o) => o.group)) items.push(mi("ungroup"));
  items.push("-", mi("lock"), mi("hide"), mi("delete"));
  showMenu(items, { x, y });
}

function emptyContextMenu(x, y, at) {
  showMenu([
    mi("paste"), mi("selectAll"),
    "-", {
      label: T.insertHere, icon: "plus",
      submenu: () => ["text", "rect", "ellipse", "line", "image", "qr", "barcode", "symbol"].map((t) => ({
        label: T[`tool_${t}`], icon: t, action: () => Studio.insert(t, { at }),
      })),
    },
    "-", { label: T.labelProperties, action: () => Inspector.show("label") },
    mi("snap"), mi("grid"), mi("zoomFit"),
  ], { x, y });
}

function layerContextMenu(x, y) {
  showMenu([
    mi("rename"), mi("duplicate"),
    { label: T.showHide, action: () => run("hide") },
    { label: T.lockUnlock, action: () => run("lock") },
    "-", mi("selectSimilar"), mi("delete"),
  ], { x, y });
}

// ------------------------------------------------------------------ keyboard
const typing = (el) => el && (el.matches?.("input:not([type=range]):not([type=checkbox]),textarea,select,[contenteditable='true']"));

// Whether the focus arrived with the keyboard (Tab, arrows) rather than with a click: a button
// reached with Tab keeps Enter and Space for itself, a clicked one leaves Space to panning.
let lastInput = "pointer", keyboardFocus = false;
document.addEventListener("pointerdown", () => { lastInput = "pointer"; }, true);
document.addEventListener("keydown", () => { lastInput = "key"; }, true);
document.addEventListener("focusin", () => { keyboardFocus = lastInput === "key"; }, true);

/** Keys the focused control handles itself: Enter and Space press it, arrows move a slider. */
function controlKey(el, key) {
  if (!el?.matches) return false;
  const k = key.replace("Shift+", "");
  if (k === "Up" || k === "Down" || k === "Left" || k === "Right") return el.matches("input[type=range],[role=slider]");
  if (k !== "Enter" && k !== "Space") return false;
  return keyboardFocus && el.matches("button,a[href],summary,input[type=checkbox],[role=button],[role=switch],[role=radio],[role=checkbox],[role=menuitem],[role=tab],[role=option]");
}

function keyString(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  let k = e.key;
  const codeKeys = { BracketLeft: "[", BracketRight: "]", Semicolon: ";", Quote: "'", Slash: "/", Equal: "=", Minus: "-", NumpadAdd: "=", NumpadSubtract: "-", Digit0: "0", Digit1: "1", Numpad0: "0", Numpad1: "1" };
  if (codeKeys[e.code]) k = codeKeys[e.code];
  else if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (k === " ") k = "Space";
  else if (k === "Delete") k = "Del";
  else if (k === "Escape") k = "Esc";
  else if (k.startsWith("Arrow")) k = k.slice(5);
  else if (k.length === 1) k = k.toUpperCase();
  if (k === "+") k = "=";
  parts.push(k);
  return parts.join("+");
}

const KEYMAP = (() => {
  const map = {};
  for (const c of Object.values(CMD)) {
    for (const k of (c.keys || "").split(" / ").filter(Boolean)) if (!map[k]) map[k] = c.id;
  }
  map.D = "toggleView";
  map["Ctrl+Shift+="] = "zoomIn";
  map.Backspace = "delete";
  // Copy, cut and paste go through the clipboard events, which carry images too.
  for (const k of ["Ctrl+C", "Ctrl+X", "Ctrl+V", "Alt+F4"]) delete map[k];
  return map;
})();

document.addEventListener("keydown", (e) => {
  if (e.defaultPrevented) return;
  if (openOverlays.some((o) => o.modal) || document.querySelector(".popover.palette")) return;
  const key = keyString(e);
  const inField = typing(document.activeElement);
  if (inField) {
    // Global file commands still work while typing; the rest belongs to the field.
    if (!["Ctrl+S", "Ctrl+Shift+S", "Ctrl+P", "Ctrl+Shift+P", "Ctrl+N", "Ctrl+O", "Ctrl+K", "Ctrl+/", "F1", "F5"].includes(key)) return;
  }
  if (controlKey(document.activeElement, key)) return; // the focused button or slider handles it
  if (inEditor() && !e.ctrlKey && !e.altKey && ["Up", "Down", "Left", "Right"].includes(key.replace("Shift+", ""))) {
    const step = e.shiftKey ? 1 : Studio.config.nudge === "half" ? 0.5 : 1 / DPMM;
    const k = key.replace("Shift+", "");
    if (S.selection.length) {
      e.preventDefault();
      moveBy(k === "Left" ? -step : k === "Right" ? step : 0, k === "Up" ? -step : k === "Down" ? step : 0);
    }
    return;
  }
  if (key === "Space" && inEditor()) {
    if (!S.space) { S.space = true; stage.style.cursor = "grab"; }
    e.preventDefault();
    return;
  }
  if (key === "Esc") {
    if (Studio.view === "home") { if (run("backToLabel")) e.preventDefault(); return; } // open overlays took Esc already
    if (S.pendingSymbol) { S.pendingSymbol = null; Studio.status(); invalidate(); return; }
    if (S.tool !== "select") { setTool("select"); return; }
  }
  const id = KEYMAP[key];
  if (!id) return;
  if (!/Ctrl|Alt|^F\d/.test(key) && Studio.view !== "editor") return; // single letters are editor tools
  if (["text", "rect", "ellipse", "line", "image", "qr", "barcode"].some((t) => id === `insert_${t}`) && !e.ctrlKey) {
    e.preventDefault();
    if (inEditor()) Studio.tool(id.slice(7));
    return;
  }
  if (run(id)) e.preventDefault();
  else if (/^Ctrl\+[POSNE]$/.test(key)) e.preventDefault(); // never the browser's own print or save
});

document.addEventListener("keyup", (e) => {
  if (e.key === " " && S.space) { S.space = false; stage.style.cursor = S.tool === "hand" ? "grab" : "default"; }
});

// ------------------------------------------------------------------ clipboard
const CLIP_MARK = "qutie-objects:";
const Clip = {
  objects: null,
  style: null,
  copy() {
    const list = selected().map((o) => structuredClone(o));
    if (!list.length) return;
    const assets = Object.fromEntries(list.filter((o) => o.asset).map((o) => [o.asset, S.doc.assets[o.asset]]));
    this.objects = { list, assets };
    navigator.clipboard?.writeText(CLIP_MARK + JSON.stringify(this.objects)).catch(() => {});
  },
  copyStyle() {
    const o = selected()[0];
    const keys = ["font", "size", "autoFit", "bold", "italic", "underline", "strike", "align", "valign", "spacing", "lineHeight", "transform", "fill", "stroke", "background", "padding", "radius", "dither"];
    this.style = Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, structuredClone(o[k])]));
    toast(T.styleCopied);
  },
  pasteStyle() {
    if (!this.style) return;
    History.record(null, "edit");
    for (const o of editable()) for (const [k, v] of Object.entries(this.style)) if (k in o) o[k] = structuredClone(v);
    changed();
  },
  /** Paste objects, an image or text. From the menu (no paste event) it reads the clipboard itself. */
  async paste({ textOnly = false, data = null } = {}) {
    if (!inEditor()) return;
    let text = null, image = null;
    if (data) {
      for (const item of data.items || []) if (item.kind === "file" && item.type.startsWith("image/")) image = item.getAsFile();
      text = data.getData("text/plain");
    } else {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          const type = item.types.find((t) => t.startsWith("image/"));
          if (type && !textOnly) image = await item.getType(type);
          if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
        }
      } catch {
        try { text = await navigator.clipboard.readText(); } catch { text = null; }
      }
    }
    if (!textOnly && text?.startsWith(CLIP_MARK)) {
      try { this.objects = JSON.parse(text.slice(CLIP_MARK.length)); } catch { /* keep the internal copy */ }
    }
    if (!textOnly && image) { Studio.addImageFile(image); return; }
    if (!textOnly && (text?.startsWith(CLIP_MARK) || (!text && this.objects))) { this.pasteObjects(); return; }
    if (text && text.trim()) {
      if (text.includes("\t") && text.trim().includes("\n") && !textOnly) { DataUI.connect({ paste: text }); return; }
      const o = makeObject("text", { text: text.trim().slice(0, 500), x: 1, y: 1, w: Math.min(labelLength(S.doc) - 2, 40), h: TAPE_MM - 2 });
      addObject(o, { label: "paste" });
      return;
    }
    if (this.objects) this.pasteObjects();
  },
  pasteObjects() {
    if (!this.objects) return;
    History.record(null, "paste");
    Object.assign(S.doc.assets, this.objects.assets || {});
    const groupMap = new Map();
    const copies = this.objects.list.map((o) => {
      const c = makeObject(o.type, { ...structuredClone(o), id: newId(), x: o.x + 1, y: o.y + 1, name: "" });
      if (o.group) { if (!groupMap.has(o.group)) groupMap.set(o.group, newId()); c.group = groupMap.get(o.group); }
      c.name = defaultName(c);
      return c;
    });
    S.doc.objects.push(...copies);
    this.objects.list = copies.map((c) => structuredClone(c)); // the next paste steps further
    changed({ structure: true });
    select(copies.map((c) => c.id));
  },
};

document.addEventListener("paste", (e) => {
  if (typing(document.activeElement) || !inEditor() || openOverlays.some((o) => o.modal)) return;
  e.preventDefault();
  Clip.paste({ data: e.clipboardData });
});
document.addEventListener("copy", (e) => {
  if (typing(document.activeElement) || !hasSel()) return;
  e.preventDefault();
  Clip.copy();
});
document.addEventListener("cut", (e) => {
  if (typing(document.activeElement) || !hasEditable()) return;
  e.preventDefault();
  Clip.copy();
  deleteSelected();
});
