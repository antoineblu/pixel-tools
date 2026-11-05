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
import { cleanImage } from "./clean.js";

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
  cleaned: false, // viewing the median-flattened image (rebuilt from original)
};

const els = {};
let imgEl = null; // currently loaded HTMLImageElement (for re-detect / redraw)
let detectGridFn = null; // lazily imported from ./detect.js
let originalImageData = null; // pristine upload; cleaning always starts here

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
  "downloadBtn",
  "cleanBtn",
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
    // Always detect on the pristine upload, even in cleaned view.
    const imageData =
      state.cleaned && originalImageData
        ? originalImageData
        : imageCtx.getImageData(0, 0, imageCanvas.width, imageCanvas.height);
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
    refreshCleanedView(); // re-cleans when cleaned mode is on
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
  // Pristine copy: cleaning always starts here, detection reads it too.
  originalImageData = imageCtx.getImageData(0, 0, imageCanvas.width, imageCanvas.height);
  // A new upload leaves cleaned mode.
  state.cleaned = false;
  if (els.cleanBtn) els.cleanBtn.textContent = "🧹 Clean my pixels!";
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
      refreshView(key);
    });
    numEl.addEventListener("change", () => syncPairToState(key, sliderId, min, max));
  }
  if (sliderEl) {
    sliderEl.addEventListener("input", () => {
      state[key] = clampNum(sliderEl.value, min, max, state[key]);
      if (numEl) numEl.value = String(state[key]);
      refreshView(key);
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

// PNG blob from a canvas. Prefers toBlob; falls back to toDataURL for
// older Safari versions that have no canvas.toBlob.
function canvasToPngBlob(canvas) {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob === "function") {
      canvas.toBlob((blob) => resolve(blob), "image/png");
      return;
    }
    try {
      const dataUrl = canvas.toDataURL("image/png");
      const bin = atob(dataUrl.split(",")[1]);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      resolve(new Blob([bytes], { type: "image/png" }));
    } catch (err) {
      console.error(err);
      resolve(null);
    }
  });
}

// Trigger a file download for a blob URL. Feature-detects the `download`
// attribute: some Safari versions silently ignore programmatic clicks with
// it, so there we open the PNG in a new tab where the user can save it.
function triggerDownload(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  const canDownload = typeof a.download === "string";
  if (canDownload) a.download = filename;
  document.body.appendChild(a);
  if (canDownload) {
    a.click();
    a.remove();
    return "download";
  }
  window.open(url, "_blank", "noopener");
  a.remove();
  return "tab";
}

// Share a PNG via the native share sheet when possible (iPhone: Share →
// Save Image lands straight in the photo library), otherwise fall back to
// the classic download. Returns "shared" | "download" | "tab" | "dismissed".
async function shareOrDownload(url, blob, filename) {
  let file = null;
  try {
    file = new File([blob], filename, { type: "image/png" });
  } catch (err) {
    file = null; // very old browsers: skip straight to download
  }
  if (
    file &&
    navigator.canShare &&
    navigator.share &&
    navigator.canShare({ files: [file] })
  ) {
    try {
      await navigator.share({ files: [file], title: "Pixel Pals grid" });
      return "shared";
    } catch (err) {
      if (err && err.name === "AbortError") return "dismissed";
      console.error(err); // fall through to download
    }
  }
  return triggerDownload(url, filename);
}

// Composite image + grid overlay into one PNG and download it.
async function downloadGridPicture() {
  if (!imageCanvas.width || !imageCanvas.height) {
    setStatus("Load a picture first, cutie — then download away! 💗");
    return;
  }
  try {
    redrawOverlay(); // make sure the export matches what's on screen
    const out = document.createElement("canvas");
    out.width = imageCanvas.width;
    out.height = imageCanvas.height;
    const ctx = out.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(imageCanvas, 0, 0);
    ctx.drawImage(gridCanvas, 0, 0, out.width, out.height);
    setStatus("Preparing your picture… 🎁");
    const blob = await canvasToPngBlob(out);
    if (!blob) {
      setStatus("Hmm, the download fizzled — try again? 🥺");
      return;
    }
    const url = URL.createObjectURL(blob);
    const how = await shareOrDownload(url, blob, "pixel-pals-grid.png");
    // Revoke late: the new-tab fallback still needs the URL afterwards.
    setTimeout(() => URL.revokeObjectURL(url), how === "tab" ? 60000 : 5000);
    if (how === "tab") {
      setStatus("Opened your picture in a new tab — long-press it to save! 💖");
    } else if (how === "shared") {
      setStatus("Shared! Tap Save Image and it's in your photos. 💖");
    } else if (how === "dismissed") {
      setStatus("Share sheet closed — tap Save anytime! 💗");
    } else {
      setStatus("Saved your gridded masterpiece! 💖");
    }
  } catch (err) {
    console.error(err);
    setStatus("Download didn't work in this browser — screenshot time? 📸");
  }
}
if (els.downloadBtn) {
  els.downloadBtn.addEventListener("click", downloadGridPicture);
}

// ---- cleaned view (median-flattened pixels) ----
function putPixels(pixels) {
  // createImageData (not `new ImageData`) for old-Safari safety.
  const img = imageCtx.createImageData(pixels.width, pixels.height);
  img.data.set(pixels.data);
  imageCtx.putImageData(img, 0, 0);
}

// Rebuild the cleaned image from the pristine upload with current grid
// params, show it, redraw the overlay. Returns false when impossible.
function applyClean() {
  if (!originalImageData) return false;
  try {
    const out = cleanImage(originalImageData, {
      cellW: state.cellW,
      cellH: state.cellH,
      offX: state.offX,
      offY: state.offY,
    });
    putPixels(out);
    redrawOverlay();
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

// After any grid-affecting change: re-clean when cleaned mode is on,
// otherwise just redraw the overlay.
function refreshView(key) {
  if (
    state.cleaned &&
    (key === "cellW" || key === "cellH" || key === "offX" || key === "offY")
  ) {
    applyClean();
    return;
  }
  redrawOverlay();
}

// Same as refreshView() without a specific key (detection, resize…).
function refreshCleanedView() {
  if (state.cleaned) applyClean();
  else redrawOverlay();
}

function setCleaned(on) {
  if (on) {
    if (!originalImageData) {
      setStatus("Load a picture first, cutie — then sparkle-clean it! ✨");
      return;
    }
    if (!applyClean()) {
      setStatus("Cleaning fizzled — tweak the grid first? 🧹");
      return;
    }
    state.cleaned = true;
    if (els.cleanBtn) els.cleanBtn.textContent = "↩ Back to photo";
    setStatus("Squeaky clean! Nudge the grid and it re-cleans. ✨");
  } else {
    state.cleaned = false;
    if (originalImageData) {
      putPixels(originalImageData);
      redrawOverlay();
    }
    if (els.cleanBtn) els.cleanBtn.textContent = "🧹 Clean my pixels!";
    setStatus("Back to the original photo. 📷");
  }
}
if (els.cleanBtn) {
  els.cleanBtn.addEventListener("click", () => setCleaned(!state.cleaned));
}

// Keep overlay crisp if the window moves across displays (dpr change).
window.addEventListener("resize", () => redrawOverlay());

// Init
syncAllPairs();
