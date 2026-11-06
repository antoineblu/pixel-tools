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

// NOTE: bump the ?v= query on every asset change — GitHub Pages (and
// Safari) cache aggressively, and a stale JS/CSS with fresh HTML is the
// classic "button exists but does nothing" mystery. Bump all together.
import { drawGrid } from "./overlay.js?v=3";
import { cleanImage } from "./clean.js?v=3";
import { extractCellColors, groupByHue, applyPalette } from "./palette.js?v=3";

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
  gridColor: "#ff2d55", // one color for grid lines, chunk highlights + labels
  cleaned: false, // viewing the median-flattened image (rebuilt from original)
  paletteLevels: {}, // familyId -> kept shade count (1..N, default N = untouched)
};

const els = {};
let imgEl = null; // currently loaded HTMLImageElement (for re-detect / redraw)
let detectGridFn = null; // lazily imported from ./detect.js
let originalImageData = null; // pristine upload; cleaning always starts here
let cleanedBase = null; // median-flattened image BEFORE palette quantization
let paletteFamilies = []; // groupByHue() output for the current cleaned view

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
  "paletteList",
  "paletteGroup",
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
    const mod = await import("./detect.js?v=2");
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
  state.paletteLevels = {};
  cleanedBase = null;
  paletteFamilies = [];
  renderPalette();
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
    const how = triggerDownload(url, "pixel-pals-grid.png");
    // Revoke late: the new-tab fallback still needs the URL afterwards.
    setTimeout(() => URL.revokeObjectURL(url), how === "tab" ? 60000 : 5000);
    setStatus(
      how === "tab"
        ? "Opened your picture in a new tab — long-press it to save! 💖"
        : "Saved your gridded masterpiece! 💖"
    );
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
// params, rebuild the palette families on top, apply each family's shade
// level, show it, redraw the overlay. Returns false when impossible.
function applyClean() {
  if (!originalImageData) return false;
  try {
    const grid = {
      cellW: state.cellW,
      cellH: state.cellH,
      offX: state.offX,
      offY: state.offY,
    };
    cleanedBase = cleanImage(originalImageData, grid);
    // Palette families are computed on the cleaned cells (1 color per cell),
    // so JPEG wobble is already gone and only true shades remain.
    try {
      paletteFamilies = groupByHue(extractCellColors(cleanedBase, grid));
    } catch (err) {
      console.error(err);
      paletteFamilies = [];
    }
    // Drop levels for families that vanished; clamp the rest to the new N.
    for (const id of Object.keys(state.paletteLevels)) {
      const fam = paletteFamilies.find((f) => f.id === id);
      if (!fam) delete state.paletteLevels[id];
      else state.paletteLevels[id] = Math.max(1, Math.min(fam.colors.length, Math.round(state.paletteLevels[id])));
    }
    applyPaletteView();
    renderPalette();
    return true;
  } catch (err) {
    console.error(err);
    return false;
  }
}

// Re-apply the per-family shade levels onto the cached cleanedBase
// (cheap: no re-clean needed when only a slider moved).
function applyPaletteView() {
  if (!cleanedBase) return;
  const grid = {
    cellW: state.cellW,
    cellH: state.cellH,
    offX: state.offX,
    offY: state.offY,
  };
  let out = cleanedBase;
  if (paletteFamilies.length) {
    try {
      out = applyPalette(cleanedBase, grid, paletteFamilies, state.paletteLevels);
    } catch (err) {
      console.error(err);
      out = cleanedBase;
    }
  }
  putPixels(out);
  redrawOverlay();
}

function levelOf(fam) {
  const v = Math.round(Number(state.paletteLevels[fam.id]));
  if (!Number.isFinite(v)) return fam.colors.length;
  return Math.max(1, Math.min(fam.colors.length, v));
}

// Render one card per hue family: swatch, shade dots, 1..N slider.
function renderPalette() {
  const list = els.paletteList;
  const group = els.paletteGroup;
  if (!list || !group) return;
  list.textContent = "";
  const show = state.cleaned && paletteFamilies.length > 0;
  group.hidden = !show;
  if (!show) return;
  for (const fam of paletteFamilies) {
    const n = fam.colors.length;
    const k = levelOf(fam);
    const card = document.createElement("div");
    card.className = "palette-fam";

    const top = document.createElement("div");
    top.className = "palette-fam-top";
    const dot = document.createElement("span");
    dot.className = "palette-dot";
    dot.style.background = fam.hex;
    const nameWrap = document.createElement("div");
    const name = document.createElement("div");
    name.className = "palette-fam-name";
    name.textContent = fam.name;
    const sub = document.createElement("div");
    sub.className = "palette-fam-sub";
    sub.textContent = `${fam.total} cells`;
    nameWrap.appendChild(name);
    nameWrap.appendChild(sub);
    const count = document.createElement("span");
    count.className = "palette-fam-count";
    count.textContent = n <= 1 ? "1 shade" : `${k} / ${n}`;
    top.appendChild(dot);
    top.appendChild(nameWrap);
    top.appendChild(count);
    card.appendChild(top);

    if (n > 1) {
      const dots = document.createElement("div");
      dots.className = "palette-shades";
      for (const c of fam.colors.slice(0, 12)) {
        const chip = document.createElement("i");
        chip.style.background = c.hex;
        chip.title = `${c.hex} (${c.count} cells)`;
        dots.appendChild(chip);
      }
      card.appendChild(dots);

      const row = document.createElement("label");
      row.className = "palette-slider-row";
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "1";
      slider.max = String(n);
      slider.step = "1";
      slider.value = String(k);
      slider.setAttribute("aria-label", `${fam.name} shades (1 to ${n})`);
      const val = document.createElement("span");
      val.textContent = k <= 1 ? "1 shade" : `${k} shades`;
      slider.addEventListener("input", () => {
        state.paletteLevels[fam.id] = Number(slider.value);
        val.textContent = Number(slider.value) <= 1 ? "1 shade" : `${slider.value} shades`;
        count.textContent = `${slider.value} / ${n}`;
        applyPaletteView();
      });
      row.appendChild(slider);
      row.appendChild(val);
      card.appendChild(row);
    } else {
      const single = document.createElement("div");
      single.className = "palette-fam-sub";
      single.textContent = `${fam.hex} · single shade`;
      card.appendChild(single);
    }
    list.appendChild(card);
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
    // Flag FIRST: renderPalette() inside applyClean() only shows the group
    // when cleaned mode is already on.
    state.cleaned = true;
    if (!applyClean()) {
      state.cleaned = false;
      setStatus("Cleaning fizzled — tweak the grid first? 🧹");
      return;
    }
    if (els.cleanBtn) els.cleanBtn.textContent = "↩ Back to photo";
    setStatus("Squeaky clean! Your palette cuties are below. ✨");
  } else {
    state.cleaned = false;
    cleanedBase = null;
    paletteFamilies = [];
    renderPalette();
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

// Grid color wheel -> state -> overlay redraw (+ swatch preview).
const gridColorEl = $("gridColor");
const gridSwatchEl = $("gridSwatch");
function syncSwatch() {
  if (gridSwatchEl) gridSwatchEl.style.setProperty("--pick", state.gridColor);
}
if (gridColorEl) {
  if (gridColorEl.value) state.gridColor = gridColorEl.value;
  syncSwatch();
  gridColorEl.addEventListener("input", () => {
    if (gridColorEl.value) state.gridColor = gridColorEl.value;
    syncSwatch();
    redrawOverlay();
  });
}

// Keep overlay crisp if the window moves across displays (dpr change).
window.addEventListener("resize", () => redrawOverlay());

// Init
syncAllPairs();
