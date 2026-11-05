/**
 * clean.js — flatten each grid cell to its median color (pure, no DOM).
 *
 * Takes the source image + grid geometry (cellW, cellH, offX, offY, each
 * possibly fractional) and returns a same-size image where every cell is
 * filled with the per-channel MEDIAN of its pixels.
 *
 * Why median: baked-in grid lines, JPEG ringing and sensor noise only ever
 * cover a minority of a cell's pixels, so the median ignores them while a
 * mean would smear them in. Works for stretched (non-square) cells since
 * membership is computed per axis with float math.
 *
 * Pixel (x, y) belongs to cell (cx, cy) with:
 *   cx = floor((x - offX) / cellW), cy = floor((y - offY) / cellH)
 * Alpha channel is copied through untouched.
 */

var BINS = 256;

var histR = new Int32Array(BINS);
var histG = new Int32Array(BINS);
var histB = new Int32Array(BINS);

function medianOfHist(hist, count) {
  if (count <= 0) return 0;
  var half = (count + 1) >> 1;
  var cum = 0;
  for (var v = 0; v < BINS; v++) {
    cum += hist[v];
    if (cum >= half) return v;
  }
  return 255;
}

/**
 * @param {Object} imageData {width, height, data} — RGBA, like Canvas ImageData
 * @param {Object} opts {cellW, cellH, offX, offY} (numbers, may be fractional)
 * @returns {{width:number, height:number, data:Uint8ClampedArray}}
 */
export function cleanImage(imageData, opts) {
  var w = imageData.width;
  var h = imageData.height;
  var src = imageData.data;
  if (!(w > 0) || !(h > 0) || !src || src.length < w * h * 4) {
    throw new TypeError("cleanImage: imageData must be {width, height, data}");
  }
  var o = opts || {};
  var cellW = Number(o.cellW);
  var cellH = Number(o.cellH);
  var offX = Number(o.offX) || 0;
  var offY = Number(o.offY) || 0;
  if (!(cellW >= 1) || !(cellH >= 1)) {
    throw new RangeError("cleanImage: cellW/cellH must be >= 1");
  }

  var out = new Uint8ClampedArray(src.length);
  // Copy alpha through first (color passes overwrite RGB only).
  for (var a = 3; a < src.length; a += 4) out[a] = src[a];

  var cxMin = Math.floor((0 - offX) / cellW);
  var cxMax = Math.floor((w - 1 - offX) / cellW);
  var cyMin = Math.floor((0 - offY) / cellH);
  var cyMax = Math.floor((h - 1 - offY) / cellH);

  for (var cy = cyMin; cy <= cyMax; cy++) {
    var y0 = Math.max(0, Math.ceil(offY + cy * cellH));
    var y1 = Math.min(h - 1, Math.ceil(offY + (cy + 1) * cellH) - 1);
    if (y1 < y0) continue;
    for (var cx = cxMin; cx <= cxMax; cx++) {
      var x0 = Math.max(0, Math.ceil(offX + cx * cellW));
      var x1 = Math.min(w - 1, Math.ceil(offX + (cx + 1) * cellW) - 1);
      if (x1 < x0) continue;

      histR.fill(0);
      histG.fill(0);
      histB.fill(0);
      var count = 0;
      // Suspect margin around grid lines, in pixels: baked-in lines, JPEG
      // ringing and anti-aliased edge pixels all live within ~1px of a
      // boundary, so voters must be clearly interior. 1.5 (not 1.0) keeps a
      // safe distance from float knife-edges at exact integer distances.
      var M = 1.5;
      for (var y = y0; y <= y1; y++) {
        // Distance to the nearest horizontal grid line, in pixels.
        var fy = (y - offY) / cellH;
        var fry = fy - Math.floor(fy);
        var distY = (fry < 1 - fry ? fry : 1 - fry) * cellH;
        var skipY = distY < M;
        var row = y * w;
        for (var x = x0; x <= x1; x++) {
          // Pixels near a grid line are suspect (baked-in lines live
          // there), so they don't vote — but they still get repainted.
          if (skipY) continue;
          var fx = (x - offX) / cellW;
          var frx = fx - Math.floor(fx);
          var distX = (frx < 1 - frx ? frx : 1 - frx) * cellW;
          if (distX < M) continue;
          var i = (row + x) * 4;
          histR[src[i]]++;
          histG[src[i + 1]]++;
          histB[src[i + 2]]++;
          count++;
        }
      }
      if (count === 0) {
        // Degenerate cell (tiny or all-border): fall back to all pixels.
        for (var yy = y0; yy <= y1; yy++) {
          var rrow = yy * w;
          for (var xx = x0; xx <= x1; xx++) {
            var ii = (rrow + xx) * 4;
            histR[src[ii]]++;
            histG[src[ii + 1]]++;
            histB[src[ii + 2]]++;
            count++;
          }
        }
      }
      if (count === 0) continue;
      var mr = medianOfHist(histR, count);
      var mg = medianOfHist(histG, count);
      var mb = medianOfHist(histB, count);
      for (var fy = y0; fy <= y1; fy++) {
        var frow = fy * w;
        for (var fx = x0; fx <= x1; fx++) {
          var j = (frow + fx) * 4;
          out[j] = mr;
          out[j + 1] = mg;
          out[j + 2] = mb;
        }
      }
    }
  }

  return { width: w, height: h, data: out };
}
