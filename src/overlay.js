/**
 * overlay.js — grid overlay renderer (no dependencies).
 *
 * drawGrid(gridCanvas, state):
 *   state = { cellW, cellH, offX, offY, showGrid, showChunks }
 *   - Clears the overlay.
 *   - Draws thin 1px red grid lines at offset + n * cell.
 *   - Draws thicker highlighted lines every 5 cells + chunk labels (e.g. "2,1").
 *   - DevicePixelRatio-aware so lines stay crisp on retina/Safari.
 */

function mod(n, m) {
  return ((n % m) + m) % m;
}

export function drawGrid(gridCanvas, state) {
  const {
    cellW = 16,
    cellH = 16,
    offX = 0,
    offY = 0,
    showGrid = true,
    showChunks = true,
  } = state || {};

  const ctx = gridCanvas.getContext("2d");
  if (!ctx) return;

  // Canvas backing store is already scaled by setupOverlayCanvas() in main.js
  // (width = cssW * dpr). Read the CSS size back so drawing math stays in CSS px.
  const dpr = window.devicePixelRatio || 1;
  const cssW = gridCanvas.width / dpr;
  const cssH = gridCanvas.height / dpr;

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const w = Math.max(2, Number(cellW) || 2);
  const h = Math.max(2, Number(cellH) || 2);
  const ox = Number(offX) || 0;
  const oy = Number(offY) || 0;

  if (!showGrid && !showChunks) {
    ctx.restore();
    return;
  }

  // ---- thin 1px grid ----
  if (showGrid) {
    ctx.strokeStyle = "rgba(255, 45, 85, 0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    // Start from the first line >= 0 so negative offsets still tile correctly.
    for (let x = mod(ox, w); x <= cssW + 0.5; x += w) {
      const px = Math.round(x) + 0.5; // crisp 1px line
      ctx.moveTo(px, 0);
      ctx.lineTo(px, cssH);
    }
    for (let y = mod(oy, h); y <= cssH + 0.5; y += h) {
      const py = Math.round(y) + 0.5;
      ctx.moveTo(0, py);
      ctx.lineTo(cssW, py);
    }
    ctx.stroke();
  }

  // ---- 5x5 chunk highlights + labels ----
  if (showChunks) {
    const chunkW = w * 5;
    const chunkH = h * 5;
    ctx.strokeStyle = "rgba(255, 45, 85, 1)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = mod(ox, chunkW); x <= cssW + 1; x += chunkW) {
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, cssH);
    }
    for (let y = mod(oy, chunkH); y <= cssH + 1; y += chunkH) {
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(cssW, Math.round(y) + 0.5);
    }
    ctx.stroke();

    // Chunk labels: column,row index of each 5x5 block.
    ctx.fillStyle = "rgba(255, 45, 85, 1)";
    // Small but legible; scales modestly with cell size, capped for sanity.
    ctx.font = `${Math.max(9, Math.min(12, Math.min(w, h) * 0.55))}px system-ui, sans-serif`;
    ctx.textBaseline = "top";
    let row = 0;
    for (let y = mod(oy, chunkH); y < cssH; y += chunkH, row++) {
      let col = 0;
      for (let x = mod(ox, chunkW); x < cssW; x += chunkW, col++) {
        ctx.fillText(`${col},${row}`, x + 3, y + 2);
      }
    }
  }

  ctx.restore();
}
