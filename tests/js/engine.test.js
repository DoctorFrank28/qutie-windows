// The Studio's label engine without a browser: document model, formulas, data plan.
// Run by tests/test_engine_js.py (node tests/js/engine.test.js).
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert/strict");

const web = path.join(__dirname, "..", "..", "src", "qutie", "app", "web", "designer");
const context = vm.createContext({
  console, Intl, URLSearchParams, Date, Math, JSON, Number, String, Array, Object, Set, Map, RegExp, Error, Infinity, NaN, structuredClone,
  navigator: { language: "it-IT", languages: ["it-IT"] }, localStorage: { getItem: () => null, setItem() {} },
  location: { search: "?lang=it" }, crypto: { randomUUID: () => "test-id" },
});
for (const file of ["strings.js", "lang.js", "model.js", "data.js"]) {
  // Top-level const/let stay in the script scope: expose what the tests use.
  vm.runInContext(fs.readFileSync(path.join(web, file), "utf8"), context, { filename: file });
}
const run = (code) => { const v = vm.runInContext(code, context); return v === undefined ? v : JSON.parse(JSON.stringify(v)); };

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("formulas: IF, ISBLANK, ADDDAYS in Italian and English", () => {
  const fields = ["Data", "Scade il", "Prezzo"];
  const v = (expr, values) => run(`(() => { const t = parseFormula(${JSON.stringify(expr)}, ${JSON.stringify(fields)}); return evalTree(t, ${JSON.stringify(values)}); })()`);
  const d = v("SE(VUOTO(Scade il); AGGIUNGIGIORNI(Data; 90); Scade il)", { Data: "2026-10-11", "Scade il": "" });
  assert.equal(run(`formatDate(new Date(${JSON.stringify(d)}), "short")`), "09/01/2027");
  assert.equal(v("IF(ISBLANK([Scade il]), ADDDAYS([Data], 1), [Scade il])", { Data: "2026-10-11", "Scade il": "2027-03-18" }), "2027-03-18");
  assert.equal(v('FORMATO(Prezzo; "€ 0,00")', { Prezzo: "4.9" }), "€ 4,90");
  assert.equal(v('MAIUSC("ab") & "-" & 3 * 2', {}), "AB-6");
  assert.equal(v("Data + 90 > Data", { Data: "2026-10-11" }), true);
});

test("formula errors are readable", () => {
  assert.throws(() => run(`parseFormula("SE(1;", [])`), /incompleta/);
  assert.throws(() => run(`parseFormula("Pippo + 1", ["Data"])`), /Pippo/);
});

test("plan: rows × copies × repeats with the counter", () => {
  const plan = run(`(() => {
    const doc = newDocument({ objects: [makeObject("text", { text: "«Nome» {n}" })] });
    doc.data = newData({ columns: [{ name: "Nome", type: "text" }, { name: "Quantità", type: "number" }],
      rows: [["Origano", "2"], ["Basilico", "1"], ["Curcuma", ""]], copies: "Quantità" });
    doc.series.repeat = 2;
    return labelPlan(doc).map((i) => i.texts.Nome + ":" + i.vars.n);
  })()`);
  assert.deepEqual(plan, ["Origano:1", "Origano:2", "Basilico:3", "Curcuma:4", "Origano:5", "Origano:6", "Basilico:7", "Curcuma:8"]);
});

test("plan without data: counter series and padding", () => {
  const texts = run(`(() => {
    const doc = newDocument({ objects: [makeObject("text", { text: "INV-{n}" })] });
    Object.assign(doc.series, { start: 7, step: 1, count: 3, pad: 3 });
    return labelPlan(doc).map((i) => expandAll("INV-{n}", i));
  })()`);
  assert.deepEqual(texts, ["INV-007", "INV-008", "INV-009"]);
});

test("conditional visibility and empty fields", () => {
  const shows = run(`(() => {
    const o = makeObject("text", { text: "PICCANTE", visible: { mode: "if", join: "and", rules: [{ field: "Piccante", op: "true", value: "" }] } });
    const e = makeObject("text", { text: "«Allergeni»" });
    return [objectShows(o, { raw: { Piccante: "sì" } }), objectShows(o, { raw: { Piccante: "no" } }),
            objectShows(e, { raw: {}, texts: { Allergeni: "" } }), objectShows(e, { raw: {}, texts: { Allergeni: "sedano" } })];
  })()`);
  assert.deepEqual(shows, [true, false, false, true]);
});

test("filters, checked rows and ranges", () => {
  const rows = run(`(() => {
    const data = newData({ columns: [{ name: "Categoria", type: "text" }], rows: [["Spezie"], ["Pasta"], ["Spezie"], ["Spezie"]],
      filter: [{ field: "Categoria", op: "eq", value: "Spezie" }], checked: [2] });
    return [printedRows(data, "all"), printedRows(data, "checked"), printedRows({ ...data, range: { from: 2, to: 3 } }, "range")];
  })()`);
  assert.deepEqual(rows, [[0, 2, 3], [2], [2, 3]]);
});

test("version 1 files: pasted rows become a table with fields", () => {
  const doc = run(`normalizeDocument({ name: "Scatole", series: { rows: "Scatola 1;cavi\\nScatola 2;libri" }, objects: [{ type: "text", text: "{1}" }, { type: "barcode", content: "{2}", showText: false }] })`);
  assert.equal(doc.data.rows.length, 2);
  assert.equal(doc.objects[0].text, "«Colonna 1»");
  assert.equal(doc.objects[1].textPos, "none");
});

test("every language has the English keys of the templates", () => {
  for (const lang of ["it", "es", "fr", "de", "pt", "ru", "zh", "ja"]) {
    const file = lang === "it" ? null : path.join(web, "lang", `${lang}.js`);
    if (file && fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
    const missing = run(`Object.keys(STUDIO_STRINGS.en).filter((k) => STUDIO_STRINGS.${lang} && !(k in STUDIO_STRINGS.${lang}))`);
    assert.deepEqual(missing, [], `${lang} misses ${missing.join(", ")}`);
  }
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
