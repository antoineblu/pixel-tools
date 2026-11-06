/**
 * palette.js — regrouper les couleurs par famille de teinte + précision par famille.
 *
 * Pipeline (travaille sur l'image NETTOYÉE : chaque cellule = 1 couleur plate) :
 *   1. extractCellColors : lit le pixel central de chaque cellule -> [{r,g,b,count}]
 *      + pré-fusion des quasi-doublons (écart max <= MERGE_BOX, artefacts JPEG).
 *   2. groupByHue : sépare achromatiques (saturation faible) des chromatiques,
 *      regroupe les chromatiques par angle de teinte HSV (coupure aux grands gaps).
 *   3. quantizeFamily : réduit les N nuances d'une famille à k (1..N) en triant
 *      par luminosité et en découpant en k paquets à poids équilibré.
 *   4. applyPalette : remappe chaque cellule vers son représentant quantifié.
 *
 * Pur, sans DOM. Les familles portent un id stable dérivé de leur teinte
 * ("hue-310" ou "gray") pour que les sliders survivent à un re-clean.
 */

var MERGE_BOX = 6; // écart max par canal pour fusionner deux variantes JPEG
var GRAY_SAT = 0.14; // saturation HSV sous laquelle un gris est achromatique
var HUE_GAP = 28; // coupure entre familles quand le gap de teinte dépasse ce seuil (degrés)
var MIN_FAMILY_SHARE = 0.015; // familles < 1.5% des cellules absorbées par la voisine

function keyOf(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

function hexOf(r, g, b) {
  var h = ((r << 16) | (g << 8) | b).toString(16);
  while (h.length < 6) h = "0" + h;
  return "#" + h;
}

export function rgbToHsv(r, g, b) {
  var rp = r / 255;
  var gp = g / 255;
  var bp = b / 255;
  var mx = Math.max(rp, gp, bp);
  var mn = Math.min(rp, gp, bp);
  var d = mx - mn;
  var h = 0;
  if (d > 0) {
    if (mx === rp) h = 60 * (((gp - bp) / d) % 6);
    else if (mx === gp) h = 60 * ((bp - rp) / d + 2);
    else h = 60 * ((rp - gp) / d + 4);
  }
  if (h < 0) h += 360;
  var s = mx === 0 ? 0 : d / mx;
  return { h: h, s: s, v: mx };
}

function hueDist(a, b) {
  var d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function hueMean(hues, weights) {
  var x = 0;
  var y = 0;
  for (var i = 0; i < hues.length; i++) {
    var rad = (hues[i] * Math.PI) / 180;
    x += Math.cos(rad) * weights[i];
    y += Math.sin(rad) * weights[i];
  }
  if (x === 0 && y === 0) return hues[0] || 0;
  var deg = (Math.atan2(y, x) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

// Nom affichable à partir d'un angle de teinte (français, volontairement large).
export function hueName(h) {
  if (h < 12 || h >= 345) return "Rouge";
  if (h < 32) return "Orange";
  if (h < 52) return "Jaune";
  if (h < 78) return "Vert anis";
  if (h < 150) return "Vert";
  if (h < 175) return "Menthe";
  if (h < 200) return "Cyan";
  if (h < 250) return "Bleu";
  if (h < 290) return "Violet";
  if (h < 325) return "Magenta";
  return "Rose";
}

function familyIdFor(hue, gray) {
  if (gray) return "gray";
  return "hue-" + String(Math.round(hue / 5) * 5);
}

/**
 * Lit le pixel central de chaque cellule de l'image nettoyée.
 * @returns {Array<{r,g,b,count}>} couleurs uniques pré-fusionnées, triées par count desc.
 */
export function extractCellColors(cleaned, opts) {
  var w = cleaned.width;
  var h = cleaned.height;
  var src = cleaned.data;
  var o = opts || {};
  var cellW = Number(o.cellW);
  var cellH = Number(o.cellH);
  var offX = Number(o.offX) || 0;
  var offY = Number(o.offY) || 0;
  if (!(w > 0) || !(h > 0) || !src) throw new TypeError("extractCellColors: cleaned invalide");
  if (!(cellW >= 1) || !(cellH >= 1)) throw new RangeError("extractCellColors: cellW/cellH >= 1");

  var counts = new Map();
  var cxMin = Math.floor((0 - offX) / cellW);
  var cxMax = Math.floor((w - 1 - offX) / cellW);
  var cyMin = Math.floor((0 - offY) / cellH);
  var cyMax = Math.floor((h - 1 - offY) / cellH);
  for (var cy = cyMin; cy <= cyMax; cy++) {
    var y0 = Math.max(0, Math.ceil(offY + cy * cellH));
    var y1 = Math.min(h - 1, Math.ceil(offY + (cy + 1) * cellH) - 1);
    if (y1 < y0) continue;
    var yMid = Math.min(y1, Math.max(y0, Math.floor((y0 + y1) / 2)));
    for (var cx = cxMin; cx <= cxMax; cx++) {
      var x0 = Math.max(0, Math.ceil(offX + cx * cellW));
      var x1 = Math.min(w - 1, Math.ceil(offX + (cx + 1) * cellW) - 1);
      if (x1 < x0) continue;
      var xMid = Math.min(x1, Math.max(x0, Math.floor((x0 + x1) / 2)));
      var i = (yMid * w + xMid) * 4;
      var k = keyOf(src[i], src[i + 1], src[i + 2]);
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }

  // Pré-fusion des quasi-doublons JPEG : greedy, les gros absorbent les petits proches.
  var entries = [];
  counts.forEach(function (count, k) {
    entries.push({
      r: (k >> 16) & 255,
      g: (k >> 8) & 255,
      b: k & 255,
      count: count,
    });
  });
  entries.sort(function (a, b) {
    return b.count - a.count;
  });
  var merged = [];
  for (var e = 0; e < entries.length; e++) {
    var c = entries[e];
    var absorbed = false;
    for (var m = 0; m < merged.length; m++) {
      var t = merged[m];
      if (
        Math.abs(t.r - c.r) <= MERGE_BOX &&
        Math.abs(t.g - c.g) <= MERGE_BOX &&
        Math.abs(t.b - c.b) <= MERGE_BOX
      ) {
        // Moyenne pondérée : le représentant suit le barycentre réel.
        var tot = t.count + c.count;
        t.r = Math.round((t.r * t.count + c.r * c.count) / tot);
        t.g = Math.round((t.g * t.count + c.g * c.count) / tot);
        t.b = Math.round((t.b * t.count + c.b * c.count) / tot);
        t.count = tot;
        absorbed = true;
        break;
      }
    }
    if (!absorbed) merged.push({ r: c.r, g: c.g, b: c.b, count: c.count });
  }
  merged.sort(function (a, b) {
    return b.count - a.count;
  });
  return merged;
}

/**
 * Regroupe des couleurs en familles de teinte.
 * @param {Array<{r,g,b,count}>} colors
 * @returns {Array<{id,name,hue,gray,colors,total,hex}>} familles triées par total desc.
 */
export function groupByHue(colors) {
  var grays = [];
  var chroma = [];
  for (var i = 0; i < colors.length; i++) {
    var c = colors[i];
    var hsv = rgbToHsv(c.r, c.g, c.b);
    var item = { r: c.r, g: c.g, b: c.b, count: c.count, hue: hsv.h, sat: hsv.s, val: hsv.v };
    if (hsv.s < GRAY_SAT) grays.push(item);
    else chroma.push(item);
  }
  chroma.sort(function (a, b) {
    return a.hue - b.hue;
  });

  // Découpe aux grands gaps de teinte.
  var groups = [];
  var cur = [];
  for (var j = 0; j < chroma.length; j++) {
    if (cur.length > 0 && chroma[j].hue - chroma[j - 1].hue > HUE_GAP) {
      groups.push(cur);
      cur = [];
    }
    cur.push(chroma[j]);
  }
  if (cur.length) groups.push(cur);

  // Absorbe les micro-familles (< 1.5% des cellules) par la voisine la plus proche en teinte.
  var totalCells = 0;
  for (var t = 0; t < colors.length; t++) totalCells += colors[t].count;
  if (totalCells > 0 && groups.length > 1) {
    var kept = [];
    var tiny = [];
    for (var g = 0; g < groups.length; g++) {
      var sum = 0;
      for (var s = 0; s < groups[g].length; s++) sum += groups[g][s].count;
      if (sum / totalCells < MIN_FAMILY_SHARE) tiny.push(groups[g]);
      else kept.push(groups[g]);
    }
    if (kept.length > 0) {
      for (var u = 0; u < tiny.length; u++) {
        var hues = tiny[u].map(function (c) {
          return c.hue;
        });
        var ws = tiny[u].map(function (c) {
          return c.count;
        });
        var hm = hueMean(hues, ws);
        var best = 0;
        var bestD = Infinity;
        for (var k = 0; k < kept.length; k++) {
          var kh = kept[k].map(function (c) {
            return c.hue;
          });
          var kw = kept[k].map(function (c) {
            return c.count;
          });
          var d = hueDist(hm, hueMean(kh, kw));
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        for (var v = 0; v < tiny[u].length; v++) kept[best].push(tiny[u][v]);
      }
      groups = kept;
    }
    for (var q = 0; q < groups.length; q++) {
      groups[q].sort(function (a, b) {
        return a.hue - b.hue;
      });
    }
  }

  var fams = [];
  function finalize(list, gray) {
    if (!list.length) return;
    var tot = 0;
    var hues = [];
    var ws = [];
    var rep = list[0];
    for (var i = 0; i < list.length; i++) {
      tot += list[i].count;
      hues.push(list[i].hue);
      ws.push(list[i].count);
      if (list[i].count > rep.count) rep = list[i];
    }
    var hue = gray ? 0 : hueMean(hues, ws);
    var cols = list
      .slice()
      .sort(function (a, b) {
        return b.count - a.count;
      })
      .map(function (c) {
        return { r: c.r, g: c.g, b: c.b, count: c.count, hex: hexOf(c.r, c.g, c.b) };
      });
    fams.push({
      id: familyIdFor(Math.round(hue), gray),
      name: gray ? "Gris / Noir / Blanc" : hueName(hue),
      hue: Math.round(hue),
      gray: gray,
      colors: cols,
      total: tot,
      hex: hexOf(rep.r, rep.g, rep.b),
    });
  }
  if (grays.length) finalize(grays, true);
  for (var f = 0; f < groups.length; f++) finalize(groups[f], false);
  // Unicité des ids si deux familles tombent sur le même bucket (rare).
  var seen = {};
  for (var n = 0; n < fams.length; n++) {
    var base = fams[n].id;
    var k2 = 2;
    while (seen[fams[n].id]) fams[n].id = base + "-" + k2++;
    seen[fams[n].id] = true;
  }
  fams.sort(function (a, b) {
    return b.total - a.total;
  });
  return fams;
}

/**
 * Quantifie une famille à k nuances : tri par luminosité (V), découpe en k
 * paquets à poids (nb de cellules) équilibré, représentant = moyenne pondérée.
 * @returns {Map<number,{r,g,b}>} clé rgb d'origine -> couleur de remplacement.
 */
export function quantizeFamily(family, k) {
  var map = new Map();
  var cols = family.colors.slice().sort(function (a, b) {
    var va = rgbToHsv(a.r, a.g, a.b).v;
    var vb = rgbToHsv(b.r, b.g, b.b).v;
    if (va !== vb) return va - vb;
    return (a.r + a.g + a.b) - (b.r + b.g + b.b);
  });
  var n = cols.length;
  var kk = Math.max(1, Math.min(k || n, n));
  if (kk >= n) {
    for (var i = 0; i < n; i++) map.set(keyOf(cols[i].r, cols[i].g, cols[i].b), { r: cols[i].r, g: cols[i].g, b: cols[i].b });
    return map;
  }
  var total = 0;
  for (var t = 0; t < n; t++) total += cols[t].count;
  var target = total / kk;
  var start = 0;
  var acc = 0;
  var made = 0;
  for (var c = 0; c < n; c++) {
    acc += cols[c].count;
    var last = c === n - 1;
    var remaining = kk - made - 1;
    // Ferme le paquet quand il atteint sa part, en gardant assez de couleurs pour la suite.
    if (!last && remaining > 0 && (acc >= target * (made + 1) && n - c - 1 >= remaining)) {
      emit(cols.slice(start, c + 1), map);
      made++;
      start = c + 1;
    } else if (last) {
      if (made < kk - 1 && start < c) {
        // Plus de paquets que de couleurs restantes : une couleur par paquet.
        for (var s = start; s < c; s++) {
          emit([cols[s]], map);
          made++;
        }
        emit([cols[c]], map);
        made++;
      } else {
        emit(cols.slice(start), map);
        made++;
      }
    }
  }
  return map;
}

function emit(bucket, map) {
  var tot = 0;
  var r = 0;
  var g = 0;
  var b = 0;
  for (var i = 0; i < bucket.length; i++) {
    tot += bucket[i].count;
    r += bucket[i].r * bucket[i].count;
    g += bucket[i].g * bucket[i].count;
    b += bucket[i].b * bucket[i].count;
  }
  var rep = tot > 0 ? { r: Math.round(r / tot), g: Math.round(g / tot), b: Math.round(b / tot) } : { r: bucket[0].r, g: bucket[0].g, b: bucket[0].b };
  for (var j = 0; j < bucket.length; j++) {
    map.set(keyOf(bucket[j].r, bucket[j].g, bucket[j].b), rep);
  }
}

/**
 * Remappe l'image nettoyée selon les niveaux par famille.
 * @param cleaned {width,height,data} image nettoyée (référence, non mutée).
 * @param grid {cellW,cellH,offX,offY}.
 * @param families sortie de groupByHue.
 * @param levels {familyId: k} (k absent ou >= N = identité).
 * @returns {{width,height,data}} nouvelle image.
 */
export function applyPalette(cleaned, grid, families, levels) {
  var w = cleaned.width;
  var h = cleaned.height;
  var src = cleaned.data;
  var out = new Uint8ClampedArray(src.length);
  out.set(src);

  var remap = new Map(); // clé rgb d'origine -> {r,g,b}
  for (var f = 0; f < families.length; f++) {
    var fam = families[f];
    var k = levels && Number(levels[fam.id]);
    if (!Number.isFinite(k)) k = fam.colors.length;
    k = Math.max(1, Math.min(Math.round(k), fam.colors.length));
    if (k >= fam.colors.length) continue; // identité : rien à remapper
    var q = quantizeFamily(fam, k);
    q.forEach(function (v, key) {
      remap.set(key, v);
    });
  }
  if (remap.size === 0) return { width: w, height: h, data: out };

  var gGrid = grid || {};
  var cellW = Number(gGrid.cellW);
  var cellH = Number(gGrid.cellH);
  var offX = Number(gGrid.offX) || 0;
  var offY = Number(gGrid.offY) || 0;
  if (!(cellW >= 1) || !(cellH >= 1)) throw new RangeError("applyPalette: cellW/cellH >= 1");

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
      var probe = (y0 * w + x0) * 4;
      var rep2 = remap.get(keyOf(src[probe], src[probe + 1], src[probe + 2]));
      if (!rep2) continue;
      for (var y = y0; y <= y1; y++) {
        var row = y * w;
        for (var x = x0; x <= x1; x++) {
          var j = (row + x) * 4;
          out[j] = rep2.r;
          out[j + 1] = rep2.g;
          out[j + 2] = rep2.b;
        }
      }
    }
  }
  return { width: w, height: h, data: out };
}

/** Nombre de couleurs distinctes après application (pour les tests / l'UI). */
export function countColors(pixels) {
  var s = new Set();
  var d = pixels.data;
  for (var i = 0; i < d.length; i += 4) s.add(keyOf(d[i], d[i + 1], d[i + 2]));
  return s.size;
}
