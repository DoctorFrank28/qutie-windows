"use strict";
/* global T */

const $ = (sel) => document.querySelector(sel);
const SCALE = 3; // screen pixels per printer dot
let job = null;
// The driver turns landscape pages 90° clockwise onto the tape (LANDSCAPE_CC270):
// turning the label back 90° counter-clockwise makes the text read left to right.
let rotation = -90;

const ready = new Promise((resolve) => {
  if (window.pywebview?.api) return resolve(window.pywebview.api);
  window.addEventListener("pywebviewready", () => resolve(window.pywebview.api));
  setTimeout(() => { if (!window.pywebview) resolve(fakeApi()); }, 1500);
});
const api = async (name, ...args) => (await ready)[name](...args);

const images = []; // the labels as loaded <img>, in printed orientation (96 dots across)
let strip = false; // show the job as one strip of tape, as it comes off a continuous roll

function loadImages() {
  return Promise.all(job.labels.map((label, i) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => { images[i] = image; resolve(); };
    image.src = label.png;
  })));
}

/** Draw `source` (printed orientation) onto a new canvas, turned for reading. */
function turned(source, scale) {
  const canvas = document.createElement("canvas");
  const sideways = rotation % 180 !== 0;
  canvas.width = (sideways ? source.height : source.width) * scale;
  canvas.height = (sideways ? source.width : source.height) * scale;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(source, (-source.width * scale) / 2, (-source.height * scale) / 2, source.width * scale, source.height * scale);
  return canvas;
}

/** Screen pixels per dot, the same for every label: the longest one fits the window. */
function displayScale() {
  const room = Math.max(200, $("#labels").clientWidth - 48);
  const across = rotation % 180 !== 0 ? Math.max(...images.map((i) => i.height)) : Math.max(...images.map((i) => i.width));
  return Math.min(SCALE, room / across);
}

function drawLabel(label, index, scale) {
  const figure = document.createElement("figure");
  figure.className = "label";
  const canvas = turned(images[index], SCALE);
  canvas.style.width = `${(canvas.width / SCALE) * scale}px`;
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", T.pvLabel(index + 1));
  const caption = document.createElement("figcaption");
  caption.textContent = `${T.pvLabel(index + 1)} · 12 × ${label.length_mm} mm${label.gap ? "" : ` · ${T.continuous}`}`;
  figure.append(canvas, caption);
  return figure;
}

/** All the labels on one strip of tape: each label, its feed, then the tear line. */
function drawStrip() {
  const width = images[0]?.width || 96;
  const total = job.labels.reduce((sum, label, i) => sum + images[i].height + (label.feed || 0), 0);
  const tape = document.createElement("canvas");
  tape.width = width;
  tape.height = Math.max(1, total);
  const ctx = tape.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, tape.width, tape.height);
  let y = 0;
  job.labels.forEach((label, i) => {
    ctx.drawImage(images[i], 0, y);
    y += images[i].height + (label.feed || 0);
    if (i < job.labels.length - 1) { // where the tape is torn off
      ctx.strokeStyle = "#999";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, y - 0.5);
      ctx.lineTo(width, y - 0.5);
      ctx.stroke();
    }
  });
  // Keep very long strips within the size a canvas can hold.
  const scale = Math.min(SCALE, 30000 / Math.max(tape.width, tape.height));
  const canvas = turned(tape, scale);
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", T.stripView);
  const figure = document.createElement("figure");
  figure.className = "label strip";
  const caption = document.createElement("figcaption");
  caption.textContent = `${T.stripView} · ${Math.round(total / 8)} mm`;
  figure.append(canvas, caption);
  return figure;
}

function render() {
  const box = $("#labels");
  box.classList.toggle("as-strip", strip);
  const scale = displayScale();
  box.replaceChildren(...(strip && job.labels.length ? [drawStrip()] : job.labels.map((l, i) => drawLabel(l, i, scale))));
  const lengths = [...new Set(job.labels.map((l) => l.length_mm))];
  $("#summary").textContent = T.pvSummary(job.labels.length, lengths.join(" / "));
  $("#strip").textContent = strip ? T.separateView : T.stripView;
  $("#strip").setAttribute("aria-pressed", String(strip));
}

function copies() {
  const n = Math.round(Number($("#copies").value));
  return Number.isFinite(n) ? Math.min(99, Math.max(1, n)) : 1;
}

async function print() {
  const button = $("#print");
  button.disabled = $("#cancel").disabled = true;
  button.textContent = T.printing;
  $("#error").hidden = true;
  const result = await api("print", copies());
  if (result.ok) return; // the window closes
  $("#error").innerHTML = `<div><p class="alert-title"></p><p class="alert-text"></p></div>`;
  $("#error .alert-title").textContent = T.pvFailed;
  $("#error .alert-text").textContent = `${T.pvFailedText} (${result.detail || ""})`;
  $("#error").hidden = false;
  button.textContent = T.retry;
  button.disabled = $("#cancel").disabled = false;
}

// ------------------------------------------------------------------ start
document.title = T.pvTitle;
$("#title").textContent = T.pvTitle;
$("#labels").setAttribute("aria-label", T.pvTitle);
$("#rotate").textContent = T.rotateView;
$("#always-label").textContent = T.alwaysPreview;
$("#same-height-label").textContent = T.sameHeightShort;
$("#same-height-wrap").title = T.sameHeightHint;
$("#copies-label").textContent = T.copies;
$("#cancel").textContent = T.cancel;
$("#print").textContent = T.print;

$("#rotate").addEventListener("click", () => { rotation = rotation === -90 ? 0 : -90; render(); });
$("#same-height").addEventListener("change", async (e) => {
  job = await api("set_same_height", e.target.checked);
  images.length = 0;
  await loadImages();
  render();
});
window.addEventListener("resize", () => { if (job) render(); });
$("#strip").addEventListener("click", () => { strip = !strip; api("set_strip", strip); render(); });
$("#less").addEventListener("click", () => { $("#copies").value = copies() - 1 || 1; });
$("#more").addEventListener("click", () => { $("#copies").value = Math.min(99, copies() + 1); });
$("#copies").addEventListener("change", () => { $("#copies").value = copies(); });
$("#always").addEventListener("change", (e) => api("set_preview", e.target.checked));
$("#print").addEventListener("click", print);
$("#cancel").addEventListener("click", () => api("cancel"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") api("cancel");
  if (e.key === "Enter" && document.activeElement?.tagName !== "BUTTON" && !$("#print").disabled) print();
});

api("job").then(async (data) => {
  job = data;
  strip = !!data.strip;
  $("#always").checked = data.preview;
  $("#same-height-wrap").hidden = !data.fitted;
  $("#same-height").checked = !!data.same_height;
  await loadImages();
  render();
  if (data.blank) {
    // Nothing to print: usually the app's margins are larger than the label.
    $("#error").innerHTML = `<div><p class="alert-title"></p><p class="alert-text"></p></div>`;
    $("#error .alert-title").textContent = T.pvBlank;
    $("#error .alert-text").textContent = `${T.pvBlankTip} ${T.pvBlankText}`;
    $("#error").hidden = false;
    $("#print").disabled = true;
    $("#cancel").focus();
    return;
  }
  $("#print").focus();
});

function fakeApi() {
  // A label drawn on a canvas, for opening the page in a browser during development.
  const canvas = document.createElement("canvas");
  canvas.width = 96; canvas.height = 320;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 96, 320);
  ctx.translate(48, 160); ctx.rotate(Math.PI / 2); // as the driver lays out landscape text (CC270)
  ctx.fillStyle = "#000"; ctx.font = "bold 44px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("Spezie", 0, 0);
  const png = canvas.toDataURL();
  const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  return {
    job: () => later(200, { preview: true, strip: false, fitted: true, same_height: true, labels: [{ png, rows: 320, length_mm: 40, gap: false, feed: 80 }, { png, rows: 320, length_mm: 40, gap: false, feed: 80 }] }),
    print: () => later(800, { ok: false, detail: "[WinError 10060] timeout" }),
    cancel: () => {},
    set_preview: () => {},
    set_strip: () => {},
    set_same_height: () => later(200, { preview: true, strip: false, fitted: true, same_height: false, labels: [{ png, rows: 320, length_mm: 40, gap: false, feed: 80 }] }),
  };
}
