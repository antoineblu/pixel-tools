/**
 * detect.js — client-only pixel-grid detector.
 *
 * Pipeline (all pure, no DOM / no canvas access, Safari-compatible ES module):
 *
 *   ImageData (RGBA)
 *     -> grayscale (luminance)              [toGrayscale]
 *     -> separable Gaussian blur, clamp     [separableBlur]
 *     -> Sobel X / Sobel Y, |.|, threshold  [gradientProfiles]
 *     -> projection profiles: profileX[w] = sum_y |Gx|, profileY[h] = sum_x |Gy|
 *     -> independent comb vote per axis     [estimateAxis]
 *
 * Why this works: pixel-art / scaled-canvas grids have strictly vertical and
 * horizontal edges. Summing |Gx| per column (resp. |Gy| per row) collapses
 * every grid line on an axis into one spike, so a 2-D grid problem becomes
 * two independent 1-D period estimations. X and Y are estimated separately,
 * so NON-SQUARE / stretched cells (cellW != cellH) are supported by design.
 *
 * Performance: everything is Float32Array with a single Sobel pass that
 * accumulates straight into the profiles (no gradient maps stored).
 * The comb vote is O(77 * len) per axis — negligible vs. the pixel passes.
 */

export var MIN_CELL = 4;
export var MAX_CELL = 80;

// Binomial (Pascal) kernels, separable. Radius 0 = identity (no blur).
var BLUR_KERNELS = [
  [1],
  [1, 2, 1],
  [1, 4, 6, 4, 1],
  [1, 6, 15, 20, 15, 6, 1],
];

/**
 * Median of an array-like of numbers. Copies before sorting (pure).
 * Returns 0 for empty input.
 */
export function medianOf(values) {
  var a = Array.prototype.slice.call(values);
  var n = a.length;
  if (n === 0) return 0;
  a.sort(function (p, q) {
    return p - q;
  });
  var mid = Math.floor(n / 2);
  if (n % 2 === 1) return a[mid];
  return 0.5 * (a[mid - 1] + a[mid]);
}

/**
 * Luminance grayscale: 0.299 R + 0.587 G + 0.114 B.
 * @param {Object} imageData {width, height, data (RGBA, 4 bytes/px)}
 * @returns {Float32Array} length w*h
 */
export function toGrayscale(imageData) {
  var w = imageData.width;
  var h = imageData.height;
  var data = imageData.data;
  var n = w * h;
  var out = new Float32Array(n);
  for (var i = 0; i < n; i++) {
    var o = i * 4;
    out[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  }
  return out;
}

/**
 * Separable Gaussian blur. Edges handled by clamping (replicate border).
 * radius is clamped to 0..3. radius 0 returns the input untouched.
 * @returns {Float32Array} blurred copy (or the input ref when radius is 0)
 */
export function separableBlur(gray, w, h, radius) {
  var r = Math.round(radius);
  if (!(r > 0)) return gray;
  if (r > 3) r = 3;
  var kernel = BLUR_KERNELS[r];
  var kHalf = Math.floor(kernel.length / 2);
  var kSum = 0;
  for (var k = 0; k < kernel.length; k++) kSum += kernel[k];

  var tmp = new Float32Array(w * h);
  var out = new Float32Array(w * h);

  // Horizontal pass.
  for (var y = 0; y < h; y++) {
    var row = y * w;
    for (var x = 0; x < w; x++) {
      var acc = 0;
      for (var t = -kHalf; t <= kHalf; t++) {
        var xx = x + t;
        if (xx < 0) xx = 0;
        else if (xx >= w) xx = w - 1;
        acc += gray[row + xx] * kernel[t + kHalf];
      }
      tmp[row + x] = acc / kSum;
    }
  }
  // Vertical pass.
  for (var y2 = 0; y2 < h; y2++) {
    for (var x2 = 0; x2 < w; x2++) {
      var acc2 = 0;
      for (var t2 = -kHalf; t2 <= kHalf; t2++) {
        var yy = y2 + t2;
        if (yy < 0) yy = 0;
        else if (yy >= h) yy = h - 1;
        acc2 += tmp[yy * w + x2] * kernel[t2 + kHalf];
      }
      out[y2 * w + x2] = acc2 / kSum;
    }
  }
  return out;
}

/**
 * Sobel X and Y (absolute values) accumulated straight into projection
 * profiles in a single pass — no gradient maps are stored.
 * Magnitudes below `threshold` are zeroed to kill JPEG / sensor noise floor.
 * @returns {{profileX: Float32Array, profileY: Float32Array}}
 */
export function gradientProfiles(gray, w, h, threshold) {
  var thr = threshold > 0 ? threshold : 0;
  var profileX = new Float32Array(w);
  var profileY = new Float32Array(h);
  for (var y = 0; y < h; y++) {
    var y0 = y > 0 ? y - 1 : 0;
    var y2 = y + 1 < h ? y + 1 : h - 1;
    var r0 = y0 * w;
    var r1 = y * w;
    var r2 = y2 * w;
    for (var x = 0; x < w; x++) {
      var x0 = x > 0 ? x - 1 : 0;
      var x2 = x + 1 < w ? x + 1 : w - 1;
      var tl = gray[r0 + x0];
      var t = gray[r0 + x];
      var tr = gray[r0 + x2];
      var l = gray[r1 + x0];
      var rr = gray[r1 + x2];
      var bl = gray[r2 + x0];
      var b = gray[r2 + x];
      var br = gray[r2 + x2];
      var gx = -tl - 2 * l - bl + tr + 2 * rr + br;
      var gy = -tl - 2 * t - tr + bl + 2 * b + br;
      var ax = gx < 0 ? -gx : gx;
      var ay = gy < 0 ? -gy : gy;
      if (ax >= thr) profileX[x] += ax;
      if (ay >= thr) profileY[y] += ay;
    }
  }
  return { profileX: profileX, profileY: profileY };
}

/**
 * Best comb alignment for a (possibly fractional) period: tries every
 * integer offset in [0, period), tooth positions rounded to whole pixels.
 * @returns {{score:number, offset:number, mean:number, teeth:number}|null}
 *   null when fewer than 2 teeth fit (period longer than the profile).
 */
function combAt(profile, period, floor) {
  var n = profile.length;
  if (!(period >= 2) || !(n >= 2)) return null;
  var best = null;
  var nOff = Math.max(1, Math.floor(period));
  for (var o = 0; o < nOff; o++) {
    var sum = 0;
    var c = 0;
    var prev = -1;
    for (var x = o; x < n; x += period) {
      var i = Math.round(x);
      if (i === prev) continue;
      if (i >= n) break;
      prev = i;
      sum += profile[i];
      c++;
    }
    if (c < 2) continue;
    var m = sum / c;
    var sig = (m - floor) * Math.sqrt(c);
    if (!best || sig > best.score) best = { score: sig, offset: o, mean: m, teeth: c };
  }
  return best;
}

/**
 * Mean profile value over a comb's teeth, EXCLUDING teeth within 1px of
 * any tooth in `exclude` (used for the skipped-teeth fundamental test).
 * @returns {{mean:number, count:number}}
 */
function combMeanExcluding(profile, period, offset, excludePeriod, excludeOffset) {
  var n = profile.length;
  var excl = [];
  for (var e = excludeOffset; e < n; e += excludePeriod) excl.push(Math.round(e));
  var sum = 0;
  var c = 0;
  var prev = -1;
  for (var x = offset; x < n; x += period) {
    var i = Math.round(x);
    if (i === prev) continue;
    if (i >= n) break;
    prev = i;
    var shared = false;
    for (var k = 0; k < excl.length; k++) {
      if (Math.abs(excl[k] - i) <= 1) {
        shared = true;
        break;
      }
    }
    if (!shared) {
      sum += profile[i];
      c++;
    }
  }
  return { mean: c > 0 ? sum / c : 0, count: c };
}

/**
 * Comb/vote period estimation for one 1-D profile.
 *
 * For each candidate size s in [minCell, maxCell], every offset o in
 * [0, s) is tried; the score of s is its best offset's SIGNIFICANCE:
 * (toothMean - floor) * sqrt(teeth), where toothMean is the mean profile
 * value over the comb teeth (offset + k*s) and floor is the profile median.
 * The mean removes the bias toward small cells (more teeth); the sqrt(teeth)
 * factor removes the opposite bias toward large cells, whose few teeth
 * could otherwise cherry-pick the tallest spikes (it is the z-score of the
 * teeth excess under i.i.d. noise). Strict `>` comparison while scanning s
 * ascending prefers the fundamental period over its multiples on exact ties.
 * When alternate lines are systematically STRONGER (drawn grid over pixel
 * boundaries, resampling ringing), a multiple can still win on cherry-picked
 * teeth; the fundamental-descent pass below then walks the winner down to
 * the smallest sub-period whose added teeth sit on real lines.
 *
 * The winning size is refined to sub-pixel precision with a parabolic fit
 * through scores[s-1], scores[s], scores[s+1].
 *
 * @param {Float32Array|Array<number>} profile
 * @returns {{size:number, offset:number, score:number, toothMean:number,
 *            teeth:number, confidence:number, scores:Float32Array}}
 *   offset is in [0, size); confidence is best toothMean / profile median
 *   (~1 = no periodicity found).
 */
export function estimateAxis(profile, minCell, maxCell) {
  var n = profile.length;
  var lo = Math.floor(minCell != null ? minCell : MIN_CELL);
  if (!(lo >= 1)) lo = 1;
  var hi = Math.floor(maxCell != null ? maxCell : MAX_CELL);
  var cap = Math.floor(n / 2);
  if (hi > cap) hi = cap;

  var fallback = function () {
    return { size: n, offset: 0, score: 0, confidence: 1, scores: new Float32Array(0) };
  };
  if (n < 2 || hi < lo) return fallback();

  var floor = medianOf(profile); // background (non-edge) level, robust to spikes
  var scores = new Float32Array(hi + 1);
  var bestS = lo;
  var bestO = 0;
  var best = -Infinity;
  var bestMean = 0;
  var bestN = 0;
  for (var s = lo; s <= hi; s++) {
    var sBest = -Infinity;
    var oBest = 0;
    var mBest = 0;
    var nBest = 0;
    for (var o = 0; o < s; o++) {
      var sum = 0;
      var c = 0;
      for (var i = o; i < n; i += s) {
        sum += profile[i];
        c++;
      }
      var m = sum / c; // mean per tooth: unbiased across sizes
      var sig = (m - floor) * Math.sqrt(c); // significance: penalizes lucky few-tooth alignments
      if (sig > sBest) {
        sBest = sig;
        oBest = o;
        mBest = m;
        nBest = c;
      }
    }
    scores[s] = sBest;
    if (sBest > best) {
      best = sBest;
      bestS = s;
      bestO = oBest;
      bestMean = mBest;
      bestN = nBest;
    }
  }

  // ---- fundamental descent (anti-multiple) ----
  // Significance scoring alone can still elect a MULTIPLE of the true
  // period when alternate lines are systematically stronger (e.g. a drawn
  // grid over pixel boundaries, or resampling ringing): the multiple's
  // teeth cherry-pick the strong lines and the sqrt(teeth) penalty is not
  // enough. Detect that here: for each sub-period p = size/k, look at the
  // teeth p ADDS over the winner's comb (those not shared with it). If the
  // added teeth also sit on real lines — well above the background floor —
  // the winner is a multiple and p is adopted; repeat until no sub-period
  // adds real lines. True fundamentals never descend (their added teeth
  // land on background); pure noise is excluded by the confidence gate.
  var size = bestS;
  var off = bestO;
  var mean = bestMean;
  var teethN = bestN;
  var scr = best;
  var floorPos = floor > 1e-9 ? floor : 1e-9;
  var baseConf = mean > 0 ? mean / floorPos : 1;
  if (baseConf > 3) {
    var moved = true;
    while (moved) {
      moved = false;
      var ks = [2, 3, 4];
      for (var ki = 0; ki < ks.length && !moved; ki++) {
        var p = size / ks[ki];
        if (p < lo) continue;
        var dc = combAt(profile, p, floor);
        if (!dc) continue;
        var add = combMeanExcluding(profile, p, dc.offset, size, off);
        if (add.count >= 2 && add.mean - floor > 0.4 * (mean - floor)) {
          size = p;
          off = dc.offset;
          mean = dc.mean;
          teethN = dc.teeth;
          scr = dc.score;
          moved = true;
        }
      }
    }
  }

  // Fractional refinement: rescan the comb score in [size-1, size+1] at
  // quarter-pixel steps, then a parabolic fit around the best sample.
  // Needed because integer combs drift off a fractional truth within a few
  // teeth (e.g. period 18.4 sampled at 18 is 3px off by the 8th tooth), so
  // the integer scan cannot resolve sub-pixel periods — especially when
  // alternating strong/weak lines skew the integer peak. Fractional combs
  // stay phase-locked via rounded tooth positions.
  var rp = size;
  var rBest = -Infinity;
  var rStep = 0.25;
  var t;
  for (t = size - 1; t <= size + 1 + 1e-9; t += rStep) {
    if (t < 2) continue;
    var rc = combAt(profile, t, floor);
    if (rc && rc.score > rBest) {
      rBest = rc.score;
      rp = t;
    }
  }
  var fin = combAt(profile, rp, floor);
  var rA = combAt(profile, rp - rStep, floor);
  var rB = combAt(profile, rp, floor);
  var rC = combAt(profile, rp + rStep, floor);
  if (fin && rA && rB && rC) {
    var rd2 = rA.score - 2 * rB.score + rC.score;
    var rpBest = rp;
    if (rd2 < 0) {
      var sh = (0.5 * (rA.score - rC.score)) / rd2; // in units of rStep
      if (sh > 1) sh = 1;
      else if (sh < -1) sh = -1;
      var rFine = combAt(profile, rp + sh * rStep, floor);
      if (rFine) {
        fin = rFine;
        rpBest = rp + sh * rStep;
      }
    }
    size = rpBest;
    off = fin.offset;
    mean = fin.mean;
    teethN = fin.teeth;
    scr = fin.score;
  }
  // Note: combAt offsets are in [0, floor(period)) < period, so the offset
  // stays normalized in [0, size).

  var arr = mean; // contrast of grid lines vs background level
  var denom = floor > 1e-9 ? floor : 1e-9;
  var confidence = arr > 0 ? arr / denom : 1;
  if (!(confidence >= 1)) confidence = 1; // NaN guard
  if (confidence > 1000) confidence = 1000;

  return {
    size: size,
    offset: off,
    score: scr,
    toothMean: mean,
    teeth: teethN,
    confidence: confidence,
    scores: scores.slice(lo, hi + 1),
  };
}

function assertImageData(imageData) {
  if (
    !imageData ||
    !(imageData.width > 0) ||
    !(imageData.height > 0) ||
    !imageData.data ||
    imageData.data.length < imageData.width * imageData.height * 4
  ) {
    throw new TypeError(
      'detectGrid: imageData must be {width, height, data} with at least w*h*4 entries'
    );
  }
}

/**
 * Detect a pixel grid in an ImageData-like object.
 *
 * X and Y axes are estimated INDEPENDENTLY (cellW from columns, cellH from
 * rows), so stretched / non-square pixels are handled — cellW == cellH is
 * never assumed.
 *
 * @param {Object} imageData {width, height, data} — RGBA, like Canvas ImageData
 * @param {Object} [opts]
 * @param {number} [opts.blurRadius=1] Gaussian radius 0..3 (clamped, rounded)
 * @param {number} [opts.threshold=20] min Sobel magnitude kept (>=0); kills noise floor
 * @param {boolean} [opts.debug=false] attach profiles/scores to the result
 * @returns {{cellW:number, cellH:number, offX:number, offY:number,
 *            confidence:number, debug?:Object}}
 *   offX in [0, cellW), offY in [0, cellH). confidence ~1 means "no grid".
 */
export function detectGrid(imageData, opts) {
  assertImageData(imageData);
  var o = opts || {};

  var blurRadius = Number(o.blurRadius);
  if (!(blurRadius >= 0)) blurRadius = 1; // default (also covers NaN/undefined)
  blurRadius = Math.round(blurRadius);
  if (blurRadius > 3) blurRadius = 3;

  var threshold = Number(o.threshold);
  if (!(threshold >= 0)) threshold = 20; // default (also covers NaN/undefined)

  var w = imageData.width;
  var h = imageData.height;

  var gray = toGrayscale(imageData);
  var smooth = separableBlur(gray, w, h, blurRadius);
  var profs = gradientProfiles(smooth, w, h, threshold);

  var ex = estimateAxis(profs.profileX);
  var ey = estimateAxis(profs.profileY);

  var confidence = ex.confidence < ey.confidence ? ex.confidence : ey.confidence;

  var result = {
    cellW: ex.size,
    cellH: ey.size,
    offX: ex.offset,
    offY: ey.offset,
    confidence: confidence,
  };
  if (o.debug) {
    result.debug = {
      profileX: profs.profileX,
      profileY: profs.profileY,
      scoresX: ex.scores,
      scoresY: ey.scores,
      scoreX: ex.score,
      scoreY: ey.score,
      toothMeanX: ex.toothMean,
      toothMeanY: ey.toothMean,
      confX: ex.confidence,
      confY: ey.confidence,
      blurRadius: blurRadius,
      threshold: threshold,
    };
  }
  return result;
}
