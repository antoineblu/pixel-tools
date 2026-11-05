/**
 * main.js — app wiring (ES module, no bundler, no dependencies).
 *
 * Responsibilities:
 *  - Shared `state` object for all controls.
 *  - Load image via objectURL -> Image -> imageCanvas (FileReader fallback
 *    not needed; objectURL is Safari-safe and avoids base64 memory blowup).
 *  - Call detection on upload / auto-detect button.
 *  - Redraw overlay on any control change.
 *
 * Detection contract (./detect.js):
 *   import { detectGrid } from "./detect.js";
 *   detectGrid(imageData, opts) -> { cellW, cellH, offX, offY, confidence? }
 *   - imageData: ImageData from the source imageCanvas.
 *   - opts: { blurRadius (Gaussian radius 0..3), threshold } (numbers).
 *   The UI blur slider (0..20) is mapped to a radius via blurToRadius().
 *   - Returns partial state; missing keys are ignored.
 *   If ./detect.js does not exist yet, detection is skipped gracefully and
 *   the status line explains why (overlay + manual controls still work).
 */

import { drawGrid } from "./overlay.js";

const $ = (id) => document.getElementById(id);

// ---- shared state (single source of truth) ----
const state = {
  cellW: 16,
  cellH: 16,
  offX: 0,
  offY: 0,
  blurAmt: 0,
  threshold: 60,
  showGrid: true,
  showChunks: true,
};

const els = {};
let imgEl = null; // currently loaded HTMLImageElement (for re-detect / redraw)
let detectGridFn = null; // lazily imported from ./detect.js

for (const id of [
  "fileInput",
  "dropZone",
  "imageCanvas",
  "gridCanvas",
  "cellW",
  "cellH",
  "offX",
  "offY",
  "blurAmt",
  "threshold",
  "showGrid",
  "showChunks",
  "autoDetectBtn",
  "status",
]) {
  els[id] = $(id);
}

const imageCanvas = els.imageCanvas;
const gridCanvas = els.gridCanvas;
const imageCtx = imageCanvas.getContext("2d", { willReadFrequently: true });

function setStatus(msg) {
  if (els.status) els.status.textContent = msg;
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Keep each number input <-> range slider pair in sync.
const pairs = [
  ["cellW", "cellWSlider", 2, 100],
  ["cellH", "cellHSlider", 2, 100],
  ["offX", "offXSlider", -100, 100],
  ["offY", "offYSlider", -100, 100],
  ["blurAmt", "blurAmtSlider", 0, 20],
  ["threshold", "thresholdSlider", 0, 255],
];

function syncPairToState(key, sliderId, min, max) {
  const numEl = $(key);
  const sliderEl = $(sliderId);
  const value = clampNum(state[key], min, max, state[key]);
  state[key] = value;
  if (numEl && numEl.value !== String(value)) numEl.value = String(value);
  if (sliderEl && sliderEl.value !== String(value)) sliderEl.value = String(value);
}

function syncAllPairs() {
  for (let i = 0; i < pairs.length; i++) {
    syncPairToState(pairs[i][0], pairs[i][1], pairs[i][2], pairs[i][3]);
  }
  if (els.showGrid) els.showGrid.checked = state.showGrid;
  if (els.showChunks) els.showChunks.checked = state.showChunks;
}

// Size the overlay canvas to match the image canvas CSS box, with dpr backing.
function setupOverlayCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = imageCanvas.width;
  const cssH = imageCanvas.height;
  // Keep canvases visually 1:1 (cap display size via CSS if huge).
  imageCanvas.style.width = `${cssW}px`;
  imageCanvas.style.height = `${cssH}px`;
  gridCanvas.style.width = `${cssW}px`;
  gridCanvas.style.height = `${cssH}px`;
  gridCanvas.width = Math.max(1, Math.round(cssW * dpr));
  gridCanvas.height = Math.max(1, Math.round(cssH * dpr));
}

function redrawOverlay() {
  if (!imageCanvas.width || !imageCanvas.height) return;
  setupOverlayCanvas();
  drawGrid(gridCanvas, state);
}

async function loadDetectFn() {
  if (detectGridFn) return detectGridFn;
  try {
    const mod = await import("./detect.js");
    if (typeof mod.detectGrid === "function") {
      detectGridFn = mod.detectGrid;
      return detectGridFn;
    }
    setStatus("detect.js found but does not export detectGrid(imageData, opts).");
    return null;
  } catch {
    // ./detect.js not implemented yet — manual mode still fully works.
    return null;
  }
}

// UI blur slider (0..20) -> Gaussian radius (0..3) for detect.js.
function blurToRadius(blurAmt) {
  const n = Number(blurAmt);
  if (!(n > 0)) return 0;
  return Math.max(1, Math.min(3, Math.round((n / 20) * 3)));
}

async function runDetection() {
  if (!imgEl || !imageCanvas.width) {
    setStatus("Load an image first, then auto-detect.");
    return;
  }
  const fn = await loadDetectFn();
  if (!fn) {
    setStatus("Auto-detect not available yet (src/detect.js missing) — adjust controls manually.");
    redrawOverlay();
    return;
  }
  try {
    els.autoDetectBtn.disabled = true;
    setStatus("Detecting grid…");
    const imageData = imageCtx.getImageData(0, 0, imageCanvas.width, imageCanvas.height);
    const result = await fn(imageData, {
      blurRadius: blurToRadius(state.blurAmt),
      threshold: state.threshold,
    });
    if (result && typeof result === "object") {
      for (const key of ["cellW", "cellH", "offX", "offY"]) {
        if (Number.isFinite(Number(result[key]))) state[key] = Number(result[key]);
      }
      syncAllPairs();
    }
    redrawOverlay();
    setStatus(
      `Grid: ${state.cellW}×${state.cellH}px @ (${state.offX}, ${state.offY}). Tweak freely.`
    );
  } catch (err) {
    console.error(err);
    setStatus("Detection failed — adjust controls manually.");
  } finally {
    els.autoDetectBtn.disabled = false;
  }
}

function drawImageToCanvas(img) {
  imageCanvas.width = img.naturalWidth || img.width;
  imageCanvas.height = img.naturalHeight || img.height;
  imageCtx.imageSmoothingEnabled = false;
  imageCtx.clearRect(0, 0, imageCanvas.width, imageCanvas.height);
  imageCtx.drawImage(img, 0, 0);
}

function loadFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    setStatus(`"${file.name}" is not an image — pick a PNG/JPEG/GIF/WebP.`);
    return;
  }
  setStatus(`Loading ${file.name}…`);
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    imgEl = img;
    drawImageToCanvas(img);
    URL.revokeObjectURL(url);
    setStatus(`Loaded ${file.name} (${imageCanvas.width}×${imageCanvas.height}). Detecting…`);
    redrawOverlay();
    runDetection(); // auto-run on upload; falls back gracefully without detect.js
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    setStatus(`Could not decode "${file.name}". Try another file.`);
  };
  img.src = url;
}

// ---- events ----
if (els.fileInput) {
  els.fileInput.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    loadFile(file);
    // Reset so picking the same file twice still fires change.
    e.target.value = "";
  });
}

if (els.dropZone) {
  const dz = els.dropZone;
  dz.addEventListener("click", (e) => {
    // Let the <label for="fileInput"> handle it; otherwise open picker.
    if (e.target.closest('label[for="fileInput"]')) return;
    els.fileInput.click();
  });
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  for (const evt of ["dragenter", "dragover"]) {
    dz.addEventListener(evt, (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    });
  }
  for (const evt of ["dragleave", "drop"]) {
    dz.addEventListener(evt, (e) => {
      e.preventDefault();
      if (evt === "dragleave" && dz.contains(e.relatedTarget)) return;
      dz.classList.remove("dragover");
    });
  }
  dz.addEventListener("drop", (e) => {
    const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    loadFile(file);
  });
}

// Number + slider pairs -> state -> overlay redraw (no re-detect on tweak).
for (let i = 0; i < pairs.length; i++) {
  const [key, sliderId, min, max] = pairs[i];
  const numEl = $(key);
  const sliderEl = $(sliderId);
  if (numEl) {
    numEl.addEventListener("input", () => {
      state[key] = clampNum(numEl.value, min, max, state[key]);
      if (sliderEl) sliderEl.value = String(state[key]);
      redrawOverlay();
    });
    numEl.addEventListener("change", () => syncPairToState(key, sliderId, min, max));
  }
  if (sliderEl) {
    sliderEl.addEventListener("input", () => {
      state[key] = clampNum(sliderEl.value, min, max, state[key]);
      if (numEl) numEl.value = String(state[key]);
      redrawOverlay();
    });
  }
}

if (els.showGrid) {
  els.showGrid.addEventListener("change", () => {
    state.showGrid = els.showGrid.checked;
    redrawOverlay();
  });
}
if (els.showChunks) {
  els.showChunks.addEventListener("change", () => {
    state.showChunks = els.showChunks.checked;
    redrawOverlay();
  });
}
if (els.autoDetectBtn) {
  els.autoDetectBtn.addEventListener("click", runDetection);
}

// Keep overlay crisp if the window moves across displays (dpr change).
window.addEventListener("resize", () => redrawOverlay());

// Init
syncAllPairs();
