// The Studio's engine (model.js, data.js, render.js) on documents read from stdin: for
// every label of every document, what prints. tests/test_label_data.py compares it with
// the headless Python port (qutie.label).
//
// stdin: {"lang": "it", "now": "2026-10-03T09:05:00", "templates": true, "docs": [...]}
// stdout: [{"name", "labels": [{"row", "copy", "repeat", "n", "texts", "shown", "text", "length"}]}]
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const input = JSON.parse(fs.readFileSync(0, "utf8"));
const web = path.join(__dirname, "..", "..", "src", "qutie", "app", "web", "designer");
const lang = input.lang || "en";
const locale = input.locale || lang; // the Studio follows the system locale (en-US, en-GB…) when it is the same language
const context = vm.createContext({
  console, Intl, URLSearchParams, Date, Math, JSON, Number, String, Array, Object, Set, Map, RegExp, Error, Infinity, NaN, structuredClone,
  navigator: { language: locale, languages: [locale] }, localStorage: { getItem: () => null, setItem() {} },
  location: { search: `?lang=${lang}` }, crypto: { randomUUID: () => "test-id" },
});
for (const file of ["strings.js", ...["es", "fr", "de", "pt", "ru", "zh", "ja"].map((l) => `lang/${l}.js`), "lang.js", "model.js", "data.js", "render.js"]) {
  vm.runInContext(fs.readFileSync(path.join(web, file), "utf8"), context, { filename: file });
}
context.__input = input;
const out = vm.runInContext(`(() => {
  const now = new Date(__input.now);
  const docs = (__input.templates ? templates().map((t) => ({ ...t.doc, name: t.id })) : []).concat(__input.docs || []);
  return docs.map((raw) => {
    const doc = normalizeDocument(JSON.parse(JSON.stringify(raw)));
    const plan = labelPlan(doc, __input.options || {});
    return {
      name: raw.name, doc,
      labels: plan.map((item) => {
        item.vars.now = now;
        const env = { vars: item.vars, texts: item.texts, raw: item.raw, doc };
        const objects = layoutFor(doc, env);
        return {
          row: item.row, copy: item.copy, repeat: item.repeat, n: item.vars.n, texts: item.texts || null,
          shown: objects.map((o) => o.id), x: objects.map((o) => Math.round(o.x * 1000) / 1000),
          text: Object.fromEntries(objects.filter((o) => o.type === "text" || o.type === "barcode" || o.type === "qr").map((o) => [o.id, objectText(o, env)])),
          length: labelLength(doc, objects),
        };
      }),
    };
  });
})()`, context);
process.stdout.write(JSON.stringify(out));
