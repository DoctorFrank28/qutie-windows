// Runs pieces of web/qutie.js on cases read from stdin, for tests/test_js_library.py.
// stdin: {"barcodes": [[kind, content]], "qr": [[content, ecc, version, mask]], "jobs": [{width, bits, media}]}
import { readFileSync } from "node:fs";
import Qutie, { labelJob } from "../../web/qutie.js";

const input = JSON.parse(readFileSync(0, "utf8"));
const hex = (parts) => parts.map((p) => Buffer.from(p).toString("hex")).join("");
process.stdout.write(JSON.stringify({
  barcodes: (input.barcodes || []).map(([kind, content]) => Qutie.barcode(kind, content)),
  qr: (input.qr || []).map(([content, ecc, version, mask]) => Qutie.qr(content, { ecc, version, mask })),
  jobs: (input.jobs || []).map(({ width, bits, media }) => hex(labelJob({ width, height: 96, bits: Uint8Array.from(Buffer.from(bits, "base64")) }, media))),
}));
