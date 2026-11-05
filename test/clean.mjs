/**
 * test/clean.mjs — verification for src/clean.js (Node, no deps).
 *
 * Builds images with KNOWN flat cells + noise + baked-in dark grid lines,
 * runs cleanImage, and asserts every pixel comes out at (near) the cell's
 * true color — i.e. lines and noise are gone.
 * Run: `node test/clean.mjs`
 */
import { cleanImage } from "../src/clean.js";

function makeDirty(w, h, cellW, cellH, offX, offY) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 777;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const truth = (x, y) => {
    const cx = Math.floor((x - offX) / cellW);
    const cy = Math.floor((y - offY) / cellH);
    // Positive modulo: border cells have negative cx/cy and JS % keeps sign.
    return ((((cx * 67 + cy * 131 + 53) % 180) + 180) % 180) + 30;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = truth(x, y);
      // Baked-in dark grid lines on true boundaries (like the prototype).
      const onLine =
        Math.abs(x - (offX + Math.round((x - offX) / cellW) * cellW)) < 0.6 ||
        Math.abs(y - (offY + Math.round((y - offY) / cellH) * cellH)) < 0.6;
      const n = Math.floor((rand() - 0.5) * 24); // +/-12 noise
      const i = (y * w + x) * 4;
      const g = onLine ? 20 : Math.max(0, Math.min(255, v + n));
      data[i] = g;
      data[i + 1] = g;
      data[i + 2] = g;
      data[i + 3] = 255;
    }
  }
  return { img: { width: w, height: h, data }, truth };
}

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra}`);
  if (!cond) failures++;
}

for (const c of [
  { name: "integer 10px grid + lines + noise", cellW: 10, cellH: 10, offX: 3, offY: 2 },
  { name: "fractional 12.5x9.5 grid + lines + noise", cellW: 12.5, cellH: 9.5, offX: 4, offY: 6 },
]) {
  const w = 200;
  const h = 160;
  const { img, truth } = makeDirty(w, h, c.cellW, c.cellH, c.offX, c.offY);
  const t0 = Date.now();
  const out = cleanImage(img, { cellW: c.cellW, cellH: c.cellH, offX: c.offX, offY: c.offY });
  const ms = Date.now() - t0;
  let worst = 0;
  let bad = 0;
  let lineBad = 0;
  let lineCount = 0;
  let checked = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Assert only on FULLY INTERIOR cells: edge strips are partially
      // outside the image, and rounding fractional boundaries can bury a
      // whole strip under a 2px line — unrecoverable by any median.
      const cx = Math.floor((x - c.offX) / c.cellW);
      const cy = Math.floor((y - c.offY) / c.cellH);
      const interior =
        c.offX + cx * c.cellW >= 0 &&
        c.offX + (cx + 1) * c.cellW <= w &&
        c.offY + cy * c.cellH >= 0 &&
        c.offY + (cy + 1) * c.cellH <= h;
      if (!interior) continue;
      checked++;
      const i = (y * w + x) * 4;
      const d = Math.abs(out.data[i] - truth(x, y));
      if (d > worst) worst = d;
      // Tolerance 6: the stress input has +/-12 uniform noise plus ~19%
      // near-black line pixels, so the median wobbles a few levels. A real
      // bug (wrong cell assignment) misses by ~60 on average.
      if (d > 6) bad++;
      const wasLine = img.data[i] <= 20 && truth(x, y) > 60;
      if (wasLine) {
        lineCount++;
        if (d > 6) lineBad++;
      }
    }
  }
  check(`${c.name}: all pixels within 6 of true color`, bad === 0, ` (bad=${bad}, worst=${worst}, ${ms}ms)`);
  check(`${c.name}: baked-in grid lines erased (${lineCount} line px)`, lineCount > 0 && lineBad === 0, ` (unfixed=${lineBad})`);
  check(`${c.name}: same size + opaque`, out.width === w && out.height === h && out.data[3] === 255);
}

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll clean checks passed.");
