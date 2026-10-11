"use strict";
/* The language of the Studio and number formats. Loaded after strings.js and lang/*.js. */

const LOCALES = { en: "en-GB", it: "it-IT", es: "es-ES", fr: "fr-FR", de: "de-DE", pt: "pt-PT", ru: "ru-RU", zh: "zh-CN", ja: "ja-JP" };

/** The language to use: the one chosen in Settings, else the one of Windows. */
function pickLanguage(system = false) {
  let saved = "auto";
  try { saved = localStorage.getItem("qutie.lang") || "auto"; } catch { /* private mode */ }
  if (!system && saved !== "auto" && STUDIO_STRINGS[saved]) return saved;
  const asked = new URLSearchParams(location.search).get("lang");
  if (asked && STUDIO_STRINGS[asked]) return asked;
  for (const tag of navigator.languages || [navigator.language || "en"]) {
    const code = String(tag).slice(0, 2).toLowerCase();
    if (STUDIO_STRINGS[code]) return code;
  }
  return "en";
}

const LANG = pickLanguage();
const LOCALE = (() => {
  const nav = navigator.language || "";
  return nav.slice(0, 2).toLowerCase() === LANG ? nav : LOCALES[LANG] || "en-GB";
})();
const LOCALE_DECIMAL = (1.5).toLocaleString(LOCALE).charAt(1) || ".";

const T = new Proxy({}, {
  get(_, key) {
    if (typeof key !== "string") return undefined;
    const v = STUDIO_STRINGS[LANG]?.[key];
    return v !== undefined ? v : STUDIO_STRINGS.en[key];
  },
});

/** A number as the user's language writes it (1,5 in Italian). */
function fmtNum(v, decimals = 2) {
  let n = Number(v);
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n) < 0.5 * 10 ** -decimals) n = 0; // never "-0,00"
  return n.toLocaleString(LOCALE, { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false });
}

/** Read a number typed with a comma or a point. */
function parseNum(text) {
  const s = String(text ?? "").trim().replace(/\s/g, "").replace(",", ".");
  if (s === "" || s === "-") return NaN;
  return Number(s);
}
