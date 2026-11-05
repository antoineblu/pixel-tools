/**
 * test/verify.mjs — synthetic verification for src/detect.js (Node, no deps).
 *
 * Generates fake pixel-art images with KNOWN cell size + offset (including
 * stretched / non-square cells), runs detectGrid, and checks the answer.
 * Run: `node test/verify.mjs`
 */
import { detectGrid } from "../src/detect.js";

// Minimal ImageData stand-in: { width, height, data: Uint8ClampedArray }
function makeImage(w, h, cellW, cellH, offX, offY, { noise = 0 } = {}) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Deterministic pseudo-random GRAY block colour per cell (like pixel
      // art flat fills). Grayscale on purpose: R=G=B so luminance steps are
      // full-size and Sobel sees them (no isoluminant channel cancellation).
      const cx = Math.floor((x - offX) / cellW);
      const cy = Math.floor((y - offY) / cellH);
      const v = ((cx * 73 + cy * 149 + 31) % 200) + 28;
      const n = noise ? Math.floor((rand() - 0.5) * 2 * noise) : 0;
      const i = (y * w + x) * 4;
      data[i] = Math.max(0, Math.min(255, v + n));
      data[i + 1] = Math.max(0, Math.min(255, v + n));
      data[i + 2] = Math.max(0, Math.min(255, v + n));
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const cases = [
  { name: "square 16px, offset 0,0", w: 320, h: 320, cellW: 16, cellH: 16, offX: 0, offY: 0 },
  { name: "square 12px, offset 5,7", w: 300, h: 300, cellW: 12, cellH: 12, offX: 5, offY: 7 },
  { name: "STRETCHED 16x10, offset 3,4", w: 320, h: 300, cellW: 16, cellH: 10, offX: 3, offY: 4 },
  { name: "STRETCHED 20x8 + noise", w: 400, h: 320, cellW: 20, cellH: 8, offX: 6, offY: 2, noise: 12 },
];

let failures = 0;
for (const c of cases) {
  const img = makeImage(c.w, c.h, c.cellW, c.cellH, c.offX, c.offY, { noise: c.noise || 0 });
  const t0 = Date.now();
  const got = await detectGrid(img, { blurRadius: 1, threshold: 40 });
  const ms = Date.now() - t0;
  const okW = Math.abs(got.cellW - c.cellW) <= 1;
  const okH = Math.abs(got.cellH - c.cellH) <= 1;
  // Offset is modulo cell size; allow +/-1.
  const modOff = (a, s) => ((a % s) + s) % s;
  const okX = Math.abs(modOff(got.offX, c.cellW) - modOff(c.offX, c.cellW)) <= 1;
  const okY = Math.abs(modOff(got.offY, c.cellH) - modOff(c.offY, c.cellH)) <= 1;
  const ok = okW && okH && okX && okY;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${c.name} -> got ${got.cellW}x${got.cellH} off ${got.offX},${got.offY} ` +
      `(conf ${Number(got.confidence || 0).toFixed(2)}, ${ms}ms)`
  );
}

if (failures) {
  console.error(`\n${failures} case(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll cases passed.");
}
