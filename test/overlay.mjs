/**
 * test/overlay.mjs — smoke test for src/overlay.js (Node, no deps).
 *
 * Stubs canvas 2D context + window, records draw calls, asserts:
 *  - red grid draws lines at offset + n*cell,
 *  - 5x5 chunk highlights + labels appear,
 *  - both toggles off draws nothing.
 * Run: `node test/overlay.mjs`
 */
import { drawGrid, withAlpha } from "../src/overlay.js";

globalThis.window = { devicePixelRatio: 1 };

function makeCtx() {
  return {
    calls: [],
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    font: "",
    textBaseline: "",
    save() {},
    restore() {},
    scale() {},
    clearRect() {},
    beginPath() {},
    stroke() {
      this.calls.push({ t: "stroke" });
    },
    moveTo(x, y) {
      this.calls.push({ t: "move", x, y });
    },
    lineTo(x, y) {
      this.calls.push({ t: "line", x, y });
    },
    fillText(text, x, y) {
      this.calls.push({ t: "text", text, x, y });
    },
  };
}

function makeCanvas(size) {
  const ctx = makeCtx();
  return { width: size, height: size, ctx, getContext: () => ctx };
}

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra}`);
  if (!cond) failures++;
}

// 200px canvas, 20px cells -> grid lines at 0,20,...,200 (11 per axis).
const c1 = makeCanvas(200);
drawGrid(c1, { cellW: 20, cellH: 20, offX: 0, offY: 0, showGrid: true, showChunks: false });
const vLines = c1.ctx.calls.filter((c) => c.t === "move" && c.y === 0).map((c) => c.x);
check("grid vertical lines at 0..200 step 20", vLines.length === 11 && vLines[1] === 20.5);

// Offset respected: offX=7 -> first vertical at 7.
const c2 = makeCanvas(200);
drawGrid(c2, { cellW: 20, cellH: 20, offX: 7, offY: 3, showGrid: true, showChunks: false });
const v2 = c2.ctx.calls.filter((c) => c.t === "move" && c.y === 0).map((c) => c.x);
check("offset shifts grid (first line at 7)", v2.length === 10 && v2[0] === 7.5);

// Non-square cells: chunk lines every 5*cellW=100 -> 0,100,200.
const c3 = makeCanvas(200);
drawGrid(c3, { cellW: 20, cellH: 10, offX: 0, offY: 0, showGrid: false, showChunks: true });
const labels = c3.ctx.calls.filter((c) => c.t === "text");
check("5x5 chunks draw 2x4=8 labels on stretched cells", labels.length === 8, ` (got ${labels.length})`);
check("chunk label format col,row", labels.length > 0 && labels[0].text === "0,0");

// Both off -> nothing drawn.
const c4 = makeCanvas(200);
drawGrid(c4, { cellW: 20, cellH: 20, offX: 0, offY: 0, showGrid: false, showChunks: false });
check("toggles off draws nothing", c4.ctx.calls.length === 0);

// Custom grid color drives chunk lines + labels (last stroke wins).
const c5 = makeCanvas(200);
drawGrid(c5, { cellW: 20, cellH: 20, offX: 0, offY: 0, showGrid: true, showChunks: true, gridColor: "#00ff00" });
check("custom color reaches canvas", c5.ctx.strokeStyle === "rgba(0, 255, 0, 1)", ` (got ${c5.ctx.strokeStyle})`);

// Default stays the classic red (backward compatible).
const c6 = makeCanvas(200);
drawGrid(c6, { cellW: 20, cellH: 20, offX: 0, offY: 0, showGrid: false, showChunks: true });
check("default color is classic red", c6.ctx.strokeStyle === "rgba(255, 45, 85, 1)");

// withAlpha helper: short hex + garbage fallback.
check("withAlpha short hex", withAlpha("#0f0", 0.5) === "rgba(0, 255, 0, 0.5)");
check("withAlpha garbage falls back to red", withAlpha("nope", 1) === "rgba(255, 45, 85, 1)");

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll overlay checks passed.");
