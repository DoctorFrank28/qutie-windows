"use strict";
/* Interface building blocks in the style of shadcn/ui: elements, controls, menus,
 * popovers, dialogs and toasts. Everything is built with h(), never with innerHTML on
 * user data.
 */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Create an element: h("button.btn.ghost", {onclick, title}, "text", child…). */
function h(spec, attrs, ...children) {
  if (attrs instanceof Node || typeof attrs === "string" || Array.isArray(attrs) || attrs === null || attrs === undefined || attrs === false) {
    if (attrs !== undefined) children.unshift(attrs);
    attrs = {};
  }
  const [tag, ...classes] = spec.split(".");
  const el = document.createElement(tag || "div");
  if (classes.length) el.className = classes.join(" ");
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = [el.className, v].filter(Boolean).join(" ");
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "html") el.innerHTML = v; // trusted markup only (icons)
    else if (k === "text") el.textContent = v;
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  append(el, children);
  return el;
}

function append(el, ...children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const ico = (name, size = 16) => h("span.ico", { html: icon(name, size), "aria-hidden": "true" });
const frag = (...children) => append(document.createDocumentFragment(), children);
const clear = (el) => { el.replaceChildren(); return el; };

// ------------------------------------------------------------------ controls
function button(label, { variant = "outline", size = "", icon: iconName, onClick, title, danger, disabled, id, type = "button", cls } = {}) {
  return h(`button.btn.${variant}${size ? `.${size}` : ""}${danger ? ".danger" : ""}${cls ? `.${cls}` : ""}`,
    { type, onclick: onClick, title, disabled, id, "aria-label": !label && title ? title : null }, iconName ? ico(iconName) : null, label);
}

function iconButton(iconName, title, onClick, { variant = "ghost", size = "", pressed, disabled, cls } = {}) {
  return h(`button.btn.${variant}.icon${size ? `.${size}` : ""}${cls ? `.${cls}` : ""}`, {
    type: "button", "aria-label": title, title, onclick: onClick, disabled,
    "aria-pressed": pressed === undefined ? null : String(!!pressed),
  }, ico(iconName));
}

/** Segmented control: one value out of a few. options: [{value, label, icon, title}] */
function seg(options, value, onChange, { full = false, label, small = false, cls } = {}) {
  const el = h(`div.seg${full ? ".full" : ""}${small ? ".small" : ""}${cls ? `.${cls}` : ""}`, { role: "radiogroup", "aria-label": label });
  const buttons = options.map((o) => {
    const b = h("button", {
      type: "button", role: "radio", "aria-checked": String(o.value === value), class: o.value === value ? "on" : "",
      title: o.title, "aria-label": o.icon && !o.label ? o.title : null, disabled: o.disabled,
      onclick: () => { if (o.value !== value) { set(o.value); onChange?.(o.value); } },
    }, o.icon ? ico(o.icon) : null, o.label ?? null);
    b.dataset.value = String(o.value);
    return b;
  });
  // One tab stop for the group (the checked option); arrows move between the options.
  const tabStop = () => {
    const stop = buttons.find((b) => b.dataset.value === String(value) && !b.disabled) || buttons.find((b) => !b.disabled);
    for (const b of buttons) b.tabIndex = b === stop ? 0 : -1;
  };
  const set = (v) => {
    value = v;
    for (const b of buttons) { const on = b.dataset.value === String(v); b.classList.toggle("on", on); b.setAttribute("aria-checked", String(on)); }
    tabStop();
  };
  el.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    const enabled = buttons.filter((b) => !b.disabled);
    const i = enabled.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const forward = e.key === "ArrowRight" || e.key === "ArrowDown";
    const next = enabled[(i + (forward ? 1 : -1) + enabled.length) % enabled.length];
    next.focus();
    next.click();
  });
  tabStop();
  append(el, buttons);
  el.set = set;
  return el;
}

/** Switch (shadcn): a button with role="switch". */
function sw(checked, onChange, label) {
  const b = h("button.sw", { type: "button", role: "switch", "aria-checked": String(!!checked), "aria-label": label }, h("span"));
  b.addEventListener("click", () => {
    checked = !checked;
    b.setAttribute("aria-checked", String(checked));
    onChange?.(checked);
  });
  b.set = (v) => { checked = !!v; b.setAttribute("aria-checked", String(checked)); };
  return b;
}

/** A row with a label (and an optional hint) and a switch. */
function swRow(label, checked, onChange, hint) {
  const id = `sw-${Math.random().toString(36).slice(2, 8)}`;
  const s = sw(checked, onChange, label);
  s.id = id;
  return h("div.swrow", h("label", { for: id }, h("span", label), hint ? h("small", hint) : null), s);
}

/** Slider with its label and value: [Label ........ value]. */
function slider({ label, min = 0, max = 100, step = 1, value, format = (v) => String(v), onInput, onChange, cls }) {
  const out = h("b", format(value));
  const input = h("input", { type: "range", min, max, step, value, "aria-label": label });
  const fillTrack = () => { // the filled part of the track, and the value as read aloud (with its unit)
    input.style.setProperty("--p", `${((Number(input.value) - min) / (max - min)) * 100}%`);
    input.setAttribute("aria-valuetext", format(Number(input.value)));
  };
  input.addEventListener("input", () => { out.textContent = format(Number(input.value)); fillTrack(); onInput?.(Number(input.value)); });
  input.addEventListener("change", () => onChange?.(Number(input.value)));
  fillTrack();
  const el = h(`div.ctl${cls ? `.${cls}` : ""}`, h("div.ctl-l", h("span", label), out), input);
  el.set = (v) => { input.value = v; out.textContent = format(Number(v)); fillTrack(); };
  return el;
}

/** Number field with a leading letter and a unit: [X  1,50  mm]. Commits on Enter/blur; arrows step. */
function numInput({ lead, value, unit, step = 0.1, min = -Infinity, max = Infinity, decimals = 2, onChange, label, width, disabled, placeholder }) {
  const input = h("input", { type: "text", inputmode: "decimal", spellcheck: "false", autocomplete: "off", "aria-label": label || lead, disabled, placeholder });
  const show = (v) => { input.value = v === null || v === undefined || v === "" ? "" : fmtNum(v, decimals); };
  show(value);
  const commit = () => {
    const v = parseNum(input.value);
    if (Number.isNaN(v)) { show(value); return; }
    const clamped = Math.max(min, Math.min(max, v));
    if (clamped !== value) { value = clamped; onChange?.(clamped); }
    show(value);
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { commit(); input.select(); }
    if (e.key === "Escape") { show(value); input.blur(); }
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const k = (e.shiftKey ? 10 : 1) * step * (e.key === "ArrowUp" ? 1 : -1);
      input.value = fmtNum(Math.max(min, Math.min(max, (parseNum(input.value) || 0) + k)), decimals);
      commit();
    }
  });
  input.addEventListener("blur", commit);
  input.addEventListener("focus", () => setTimeout(() => input.select(), 0));
  const el = h("label.inp", { style: width ? { width } : null, class: disabled ? "disabled" : "" },
    lead ? h("span.lead", lead) : null, input, unit ? h("span.unit", unit) : null);
  el.input = input;
  el.set = (v) => { value = v; if (document.activeElement !== input) show(v); };
  return el;
}

/** Text field. */
function textInput({ value = "", placeholder, onInput, onChange, label, lead, cls, mono, type = "text", id } = {}) {
  const input = h("input", { type, value, placeholder, "aria-label": label, spellcheck: "false", autocomplete: "off", id });
  if (onInput) input.addEventListener("input", () => onInput(input.value));
  if (onChange) input.addEventListener("change", () => onChange(input.value));
  const el = h(`label.inp${mono ? ".mono" : ""}${cls ? `.${cls}` : ""}`, lead ? (typeof lead === "string" && ICONS[lead] ? ico(lead) : h("span.lead", lead)) : null, input);
  el.input = input;
  return el;
}

/** Native select styled as a shadcn select. options: [{value, label}] or strings. */
function selectBox(options, value, onChange, { label, cls, id } = {}) {
  const el = h(`select.select${cls ? `.${cls}` : ""}`, { "aria-label": label, id });
  for (const o of options) {
    const opt = typeof o === "object" ? o : { value: o, label: o };
    if (opt.group) { el.append(h("optgroup", { label: opt.group })); continue; }
    el.append(h("option", { value: opt.value, selected: String(opt.value) === String(value), disabled: opt.disabled }, opt.label));
  }
  el.addEventListener("change", () => onChange?.(el.value));
  return el;
}

/** A group of icon toggles (B/I/U/S, alignments). items: [{value, icon, title}] */
function toggles(items, isOn, onToggle, { fill = false, label } = {}) {
  const el = h(`div.tg${fill ? ".fill" : ""}`, { role: "group", "aria-label": label });
  for (const it of items) {
    const on = isOn(it.value);
    el.append(h("button", {
      type: "button", class: on ? "on" : "", "aria-pressed": String(!!on), "aria-label": it.title, title: it.title,
      disabled: it.disabled, onclick: () => onToggle(it.value),
    }, ico(it.icon)));
  }
  return el;
}

function chip(label, { on = false, mono = false, onClick, title, icon: iconName, cls, draggable } = {}) {
  return h(`button.chip${on ? ".on" : ""}${mono ? ".mono" : ""}${cls ? `.${cls}` : ""}`, { type: "button", onclick: onClick, title, "aria-pressed": onClick ? String(!!on) : null, draggable },
    iconName ? ico(iconName, 12) : null, label);
}

function badge(label, kind = "") { return h(`span.badge${kind ? `.${kind}` : ""}`, label); }

/** An inspector section: title, optional summary, content. */
function section(title, { summary, actions, cls, collapsed, onToggle } = {}, ...children) {
  const head = h("div.sec-t", h("h3", title), summary ?? null, actions ?? null);
  const el = h(`section.sec${cls ? `.${cls}` : ""}`, head, ...children);
  if (collapsed !== undefined) {
    el.classList.toggle("collapsed", collapsed);
    head.classList.add("toggle");
    head.setAttribute("role", "button");
    head.tabIndex = 0;
    head.setAttribute("aria-expanded", String(!collapsed));
    const toggle = () => { const c = !el.classList.contains("collapsed"); el.classList.toggle("collapsed", c); head.setAttribute("aria-expanded", String(!c)); onToggle?.(c); };
    head.addEventListener("click", (e) => { if (!e.target.closest("button")) toggle(); });
    head.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
  }
  return el;
}

function notice(text, { kind = "", iconName = "info", action } = {}) {
  return h(`div.notice${kind ? `.${kind}` : ""}`, ico(iconName, 14), h("span", text), action || null);
}

function field(label, control, hint) {
  const id = control.id || `f-${Math.random().toString(36).slice(2, 8)}`;
  const target = control.matches?.("input,select,textarea") ? control : control.querySelector?.("input,select,textarea");
  if (target && !target.id) target.id = id;
  return h("div.field", h("label.lbl", { for: target?.id || id }, label), control, hint ? h("span.sub", hint) : null);
}

// ------------------------------------------------------------------ overlays
const overlayRoot = () => document.getElementById("overlays") || document.body;
const openOverlays = [];

/** Close the topmost overlay (menu, popover, dialog). Returns true if one was open. */
function closeTop() {
  const top = openOverlays[openOverlays.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && openOverlays.length) {
    const top = openOverlays[openOverlays.length - 1];
    if (top.modal && top.escape === false) return;
    e.preventDefault();
    e.stopPropagation();
    closeTop();
  }
}, true);

document.addEventListener("pointerdown", (e) => {
  for (let i = openOverlays.length - 1; i >= 0; i--) {
    const o = openOverlays[i];
    if (o.modal) break;
    if (o.el.contains(e.target) || o.anchor?.contains?.(e.target)) break;
    o.close();
  }
}, true);

function placeAt(el, x, y, { flipX = true } = {}) {
  el.style.left = "0px";
  el.style.top = "0px";
  const r = el.getBoundingClientRect();
  const W = window.innerWidth, H = window.innerHeight;
  let left = x, top = y;
  if (left + r.width > W - 8) left = flipX ? Math.max(8, x - r.width) : Math.max(8, W - r.width - 8);
  if (top + r.height > H - 8) top = Math.max(8, H - r.height - 8);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/** Place a floating element next to an anchor (below, or above when there is no room). */
function placeNear(el, anchor, { side = "bottom", align = "start", gap = 6 } = {}) {
  const a = anchor.getBoundingClientRect();
  el.style.left = "0px"; el.style.top = "0px";
  const r = el.getBoundingClientRect();
  let x = align === "end" ? a.right - r.width : align === "center" ? a.left + (a.width - r.width) / 2 : a.left;
  let y = a.bottom + gap;
  if (side === "right") { x = a.right + gap; y = a.top; }
  if (side === "left") { x = a.left - r.width - gap; y = a.top; }
  if (side === "bottom" && y + r.height > window.innerHeight - 8 && a.top - r.height - gap > 8) y = a.top - r.height - gap;
  x = Math.max(8, Math.min(window.innerWidth - r.width - 8, x));
  y = Math.max(8, Math.min(window.innerHeight - r.height - 8, y));
  el.style.left = `${Math.round(x)}px`;
  el.style.top = `${Math.round(y)}px`;
}

/**
 * A menu. items: {label, icon, shortcut, action, disabled, checked, radio, danger, hint,
 * submenu: items | () => items} | "-" (separator) | {header}.
 * where: {x, y} or {anchor, side, align}.
 */
function showMenu(items, where, { onClose, parent = null, label } = {}) {
  const list = (typeof items === "function" ? items() : items).filter(Boolean);
  const el = h("div.menu", { role: "menu", "aria-label": label, tabindex: "-1" });
  const entries = [];
  let sub = null;
  const previous = document.activeElement; // gets the focus back when the menu closes
  const overlay = {
    el, anchor: where.anchor, modal: false,
    close(all = false) {
      sub?.close();
      const hadFocus = el.contains(document.activeElement);
      el.remove();
      const i = openOverlays.indexOf(overlay);
      if (i >= 0) openOverlays.splice(i, 1);
      if (hadFocus) (parent ? where.anchor : where.anchor || previous)?.focus?.({ preventScroll: true });
      onClose?.();
      if (all && parent) parent.close(true);
    },
  };
  const openSub = (entry, item) => {
    sub?.close();
    const r = entry.getBoundingClientRect();
    sub = showMenu(item.submenu, { x: r.right - 4, y: r.top - 5, anchor: entry }, { parent: overlay, onClose: () => { sub = null; } });
  };
  for (const item of list) {
    if (item === "-") { if (entries.length && !el.lastChild?.matches?.("hr")) el.append(h("hr")); continue; }
    if (item.header) { el.append(h("div.mlabel", item.header)); continue; }
    if (item.custom) { el.append(item.custom); continue; }
    const mark = item.checked !== undefined ? h("span.mi-mark", item.checked ? (item.radio ? h("span.rd") : ico("check", 14)) : null)
      : item.icon ? h("span.mi-mark", ico(item.icon)) : h("span.mi-mark");
    const entry = h(`button.mi${item.danger ? ".danger" : ""}`, {
      type: "button", role: item.checked !== undefined ? (item.radio ? "menuitemradio" : "menuitemcheckbox") : "menuitem",
      "aria-checked": item.checked !== undefined ? String(!!item.checked) : null,
      "aria-haspopup": item.submenu ? "menu" : null, disabled: item.disabled, tabindex: "-1",
    }, mark, h("span.mi-l", item.label), item.hint ? h("span.mi-h", item.hint) : null,
    item.shortcut ? h("span.kbd", keyLabel(item.shortcut)) : null, item.submenu ? h("span.mi-sub", ico("chevronRight", 14)) : null);
    entry.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.disabled) return;
      if (item.submenu) { openSub(entry, item); return; }
      overlay.close(true);
      item.action?.();
    });
    entry.addEventListener("pointerenter", () => {
      entry.focus({ preventScroll: true });
      if (item.submenu && !item.disabled) openSub(entry, item);
      else if (sub && !sub.el.contains(document.activeElement)) sub.close();
    });
    entry._item = item;
    entries.push(entry);
    el.append(entry);
  }
  if (el.lastChild?.matches?.("hr")) el.lastChild.remove();
  el.addEventListener("keydown", (e) => {
    const enabled = entries.filter((x) => !x.disabled);
    const i = enabled.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = enabled[(i + (e.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length];
      next?.focus();
    } else if (e.key === "ArrowRight" && i >= 0 && enabled[i]._item.submenu) {
      e.preventDefault();
      openSub(enabled[i], enabled[i]._item);
      setTimeout(() => sub?.el.querySelector(".mi:not(:disabled)")?.focus(), 0);
    } else if (e.key === "ArrowLeft" && parent) {
      e.preventDefault();
      overlay.close();
      where.anchor?.focus?.();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      (e.key === "Home" ? enabled[0] : enabled[enabled.length - 1])?.focus();
    } else if (e.key === "Tab") { // Tab leaves the menu: close it and go on from where it was opened
      overlay.close(true);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const k = e.key.toLowerCase();
      const start = i + 1;
      const found = [...enabled.slice(start), ...enabled.slice(0, start)].find((x) => x.querySelector(".mi-l").textContent.trim().toLowerCase().startsWith(k));
      found?.focus();
    }
  });
  overlayRoot().append(el);
  if (where.anchor && where.x === undefined) placeNear(el, where.anchor, { side: where.side || "bottom", align: where.align || "start", gap: 4 });
  else placeAt(el, where.x, where.y);
  openOverlays.push(overlay);
  if (!parent) setTimeout(() => (where.focusFirst !== false ? entries.find((x) => !x.disabled)?.focus({ preventScroll: true }) : el.focus()), 0);
  return overlay;
}

/** A popover anchored to an element; content is an element. */
function showPopover(content, anchor, { side = "bottom", align = "start", cls = "", onClose, label, modal = false, x, y } = {}) {
  const el = h(`div.popover${cls ? `.${cls}` : ""}`, { role: "dialog", "aria-label": label }, content);
  const previous = document.activeElement;
  const overlay = {
    el, anchor, modal,
    close() {
      const hadFocus = el.contains(document.activeElement);
      el.remove();
      const i = openOverlays.indexOf(overlay);
      if (i >= 0) openOverlays.splice(i, 1);
      if (hadFocus) (previous?.isConnected ? previous : anchor)?.focus?.({ preventScroll: true }); // the focus goes back where it was
      onClose?.();
    },
  };
  overlayRoot().append(el);
  if (x !== undefined) placeAt(el, x, y);
  else placeNear(el, anchor, { side, align });
  openOverlays.push(overlay);
  // The popover sits at the end of the page: bring the focus into it (callers may move it to a better field).
  setTimeout(() => {
    if (el.isConnected && !el.contains(document.activeElement)) $("input:not(:disabled),select:not(:disabled),textarea:not(:disabled),button:not(:disabled),[tabindex]:not([tabindex='-1'])", el)?.focus({ preventScroll: true });
  }, 0);
  overlay.reposition = () => (x !== undefined ? placeAt(el, x, y) : placeNear(el, anchor, { side, align }));
  return overlay;
}

/**
 * A modal dialog. footer: [{label, variant, action(close) → false keeps it open, autofocus,
 * icon, danger, spacer: true}]. Returns {el, body, close, footer}.
 */
function openDialog({ title, description, body, footer = [], width = 520, cls = "", role = "dialog", onClose, escape = true, header = true, closeButton = false, headerExtra }) {
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const previous = document.activeElement;
  const foot = h("footer");
  const bodyEl = body instanceof Node ? body : h("div", body);
  const described = header && description;
  const dialog = h(`div.dialog${cls ? `.${cls}` : ""}`, {
    role, "aria-modal": "true", "aria-labelledby": header ? titleId : null, "aria-describedby": described ? `${titleId}-d` : null,
    style: { width: typeof width === "number" ? `${width}px` : width },
  },
    header ? h("header", h("div.dlg-titles", h("h2", { id: titleId }, title), description ? h("p.desc", { id: `${titleId}-d` }, description) : null), headerExtra || null,
      closeButton ? iconButton("x", T.close, () => overlay.close()) : null) : null,
    h("div.dlg-body", bodyEl), foot);
  const backdrop = h("div.backdrop", dialog);
  const overlay = {
    el: backdrop, modal: true, escape, body: bodyEl, dialog, footer: foot,
    close(value) {
      backdrop.remove();
      const i = openOverlays.indexOf(overlay);
      if (i >= 0) openOverlays.splice(i, 1);
      previous?.focus?.({ preventScroll: true });
      onClose?.(value);
    },
    setFooter(buttons) {
      clear(foot);
      for (const b of buttons) {
        if (b.spacer) { foot.append(h("span.spacer")); continue; }
        if (b.node) { foot.append(b.node); continue; }
        const el = button(b.label, { variant: b.variant || "outline", icon: b.icon, danger: b.danger, disabled: b.disabled });
        let busy = false; // a second click while the action runs (printing, saving) does nothing
        el.addEventListener("click", async () => {
          if (!b.action) return overlay.close(b.value);
          if (busy) return;
          busy = true;
          el.setAttribute("aria-busy", "true");
          try {
            const keep = await b.action(overlay);
            if (keep !== false) overlay.close(b.value);
          } finally {
            busy = false;
            el.removeAttribute("aria-busy");
          }
        });
        if (b.autofocus) setTimeout(() => el.focus(), 0);
        if (b.id) el.id = b.id;
        foot.append(el);
      }
      foot.hidden = !buttons.length;
    },
  };
  overlay.setFooter(footer);
  backdrop.addEventListener("keydown", (e) => { // keep the focus inside the dialog
    if (e.key !== "Tab") return;
    const items = $$("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex='-1'])", dialog).filter((x) => x.offsetParent !== null && x.tabIndex >= 0);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  overlayRoot().append(backdrop);
  openOverlays.push(overlay);
  setTimeout(() => {
    if (!dialog.contains(document.activeElement)) ($("[autofocus]", dialog) || $("input,select,textarea", bodyEl) || $("footer .btn.primary", dialog) || dialog).focus?.();
  }, 0);
  return overlay;
}

/** A question with buttons; resolves to the value of the button chosen (null when closed). */
function ask({ title, text, buttons, role = "alertdialog", body, width = 460 }) {
  return new Promise((resolve) => {
    let answered = false;
    const d = openDialog({
      title, description: text, role, width, body: body || h("div"),
      footer: buttons.map((b) => (b.spacer ? b : { ...b, action: () => { answered = true; resolve(b.value); } })),
      onClose: () => { if (!answered) resolve(null); },
    });
    if (!body) d.body.parentElement.hidden = true;
  });
}

/** A short message at the bottom right; with an action (Undo, Reprint). */
function toast(text, { action, duration = 4200, kind = "", detail } = {}) {
  const host = $("#toasts") || overlayRoot();
  // #toasts is already a live region: a role="status" of its own would announce the toast twice.
  const el = h(`div.toast${kind ? `.${kind}` : ""}`, { role: host.hasAttribute("aria-live") ? null : "status" },
    kind === "ok" ? ico("checkCircle") : kind === "error" ? ico("alert") : null,
    h("div.toast-t", h("b", text), detail ? h("span", detail) : null),
    action ? button(action.label, { variant: "ghost", size: "sm", onClick: () => { el.remove(); action.run(); } }) : null);
  host.append(el);
  setTimeout(() => el.classList.add("leaving"), duration);
  setTimeout(() => el.remove(), duration + 300);
  return el;
}

/** Keys as written on keyboards in the user's language: "Ctrl+Shift+P" → "Ctrl Maiusc P". */
function keyLabel(keys) {
  const names = { Ctrl: "Ctrl", Shift: T.keyShift, Alt: "Alt", Del: T.keyDel, Enter: T.keyEnter, Esc: "Esc", Space: T.keySpace, Home: "Home", End: T.keyEnd, Left: "←", Right: "→", Up: "↑", Down: "↓", Win: "Win" };
  return String(keys).split(" / ").map((k) => k.split("+").map((p) => names[p] ?? p).join(" ")).join(" / ");
}

// ------------------------------------------------------------------ files
function readFileAs(file, kind = "dataURL") {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    if (kind === "text") r.readAsText(file); else r.readAsDataURL(file);
  });
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h("input", { type: "file", accept, style: { display: "none" } });
    input.addEventListener("change", () => { resolve(input.files[0] || null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

/** A relative time: "ora", "oggi 10:42", "ieri", "3 giorni fa", "8 ott". */
function relTime(iso, { time = false } = {}) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(now) - day(d)) / 86400000);
  let hm; // the time as the user's language writes it (10:42, 10:42 AM)
  try { hm = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" }).format(d); } catch { hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
  if (days === 0) return (now - d) < 90000 ? T.justNow : time ? T.todayAt(hm) : T.today;
  if (days === 1) return time ? T.yesterdayAt(hm) : T.yesterday;
  if (days < 7 && !time) return T.daysAgo(days);
  try {
    return new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

const debounce = (fn, ms = 200) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
