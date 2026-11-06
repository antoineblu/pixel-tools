/**
 * palette.js — regrouper les couleurs par famille de teinte + précision par famille.
 *
 * Pipeline (travaille sur l'image NETTOYÉE : chaque cellule = 1 couleur plate) :
 *   1. extractCellColors : lit le pixel central de chaque cellule -> [{r,g,b,count}]
 *      + pré-fusion des quasi-doublons par DeltaE (artefacts JPEG invisibles).
 *   2. groupByHue : sépare achromatiques (faible chroma CIELAB) des chromatiques,
 *      regroupe les chromatiques par teinte CIELAB circulaire (coupure au plus
 *      grand gap) puis par clarté (un bordeaux et un rose partagent leur teinte
 *      mais pas leur famille). La DIRECTION du vecteur chrominance compte, pas
 *      la proximité RGB brute : un gris teinté JPEG (petit vecteur, direction
 *      bruitée) reste gris, un rose pâle (petit vecteur mais franchement
 *      direction rose) reste rose.
 *   3. quantizeFamily : réduit les N nuances d'une famille à k (1..N) en triant
 *      par clarté L et en découpant en k paquets à poids équilibré, chaque
 *      paquet étant représenté par sa vraie couleur majoritaire (médoïde —
 *      jamais de teinte moyenne inventée).
 *   4. applyPalette : remappe chaque cellule vers son représentant quantifié.
 *
 * Pur, sans DOM. Les familles portent un id stable dérivé de leur teinte
 * ("hue-355" ou "gray") pour que les sliders survivent à un re-clean.
 */

// Fusion JPEG : en dessous de ~2-3 DeltaE, l'écart est invisible (JND).
// Mesuré : wobble JPEG ±4 -> dE ~0.7 ; vraies nuances proches -> dE >= 3.4.
var MERGE_DE = 2.5;
// Seuil achromatique sur la chroma CIELAB. Mesuré : gris teinté JPEG C ~9,
// rose pâle C ~10.4, gris chaud C ~12.7 (lui est vraiment mauve : il reste rose).
var GRAY_CHROMA = 10;
var HUE_GAP = 28; // coupure entre familles quand le gap de teinte dépasse ce seuil (degrés)
var L_SPLIT = 22; // ... ou quand le gap de clarté dépasse ce seuil (bordeaux vs rose)
var MIN_FAMILY_SHARE = 0.015; // familles < 1.5% des cellules absorbées par la voisine

function keyOf(r, g, b) {
  return (r << 16) | (g << 8) | b;
}

function hexOf(r, g, b) {
  var h = ((r << 16) | (g << 8) | b).toString(16);
  while (h.length < 6) h = "0" + h;
  return "#" + h;
}

// sRGB -> CIELAB (D65) + chroma + teinte. ~40 lignes, pas de dépendance.
export function rgbToLab(r, g, b) {
  function lin(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  var R = lin(r);
  var G = lin(g);
  var B = lin(b);
  var x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  var y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  var z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  function t(c) {
    return c > 0.008856 ? Math.cbrt(c) : 7.787 * c + 16 / 116;
  }
  x = t(x);
  y = t(y);
  z = t(z);
  var L = 116 * y - 16;
  var a = 500 * (x - y);
  var bb = 200 * (y - z);
  var C = Math.sqrt(a * a + bb * bb);
  var h = (Math.atan2(bb, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { L: L, a: a, b: bb, C: C, h: h };
}

export function deltaE(la, lb) {
  var dL = la.L - lb.L;
  var da = la.a - lb.a;
  var db = la.b - lb.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

// Moyenne circulaire de teintes, pondérée (poids = nb de cellules × chroma :
// les couleurs franches ancrent la famille, pas le bruit presque-gris).
function hueMean(items) {
  var x = 0;
  var y = 0;
  var tot = 0;
  for (var i = 0; i < items.length; i++) {
    var w = items[i].count * Math.max(items[i].C, 1);
    var rad = (items[i].h * Math.PI) / 180;
    x += Math.cos(rad) * w;
    y += Math.sin(rad) * w;
    tot += w;
  }
  if (tot === 0) return 0;
  var deg = (Math.atan2(y, x) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

function hueDist(a, b) {
  var d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Clarté moyenne d'un groupe, pondérée par l'effectif.
function groupLMean(gr) {
  var tot = 0;
  var sum = 0;
  for (var i = 0; i < gr.length; i++) {
    tot += gr[i].count;
    sum += gr[i].L * gr[i].count;
  }
  return tot > 0 ? sum / tot : 0;
}

// Nom affichable à partir d'une teinte CIELAB hab (0° = axe +a, rouge).
// Bornes calibrées sur mesures : rouge ~28°, orange ~67°, jaune ~97°,
// vert ~145-152°, menthe ~171°, cyan ~216°, bleu ~288-297°, violet ~313°,
// magenta ~328-338°, rose ~350-5°.
export function hueName(h) {
  if (h < 10 || h >= 345) return "Rose";
  if (h < 45) return "Rouge";
  if (h < 75) return "Orange";
  if (h < 105) return "Jaune";
  if (h < 165) return "Vert";
  if (h < 195) return "Menthe";
  if (h < 245) return "Cyan";
  if (h < 300) return "Bleu";
  if (h < 322) return "Violet";
  return "Magenta";
}

function familyIdFor(hue, gray, lMean) {
  if (gray) return "gray";
  return "hue-" + String(Math.round(hue / 5) * 5) + "-l" + String(Math.round((lMean || 0) / 10) * 10);
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

  // Pré-fusion des quasi-doublons invisibles : greedy en DeltaE, les gros
  // absorbent les petits proches. La moyenne stabilise les cas limites
  // (un gris teinté reste gris au lieu d'éparpiller ses cellules).
  var entries = [];
  counts.forEach(function (count, k) {
    var r = (k >> 16) & 255;
    var g = (k >> 8) & 255;
    var b = k & 255;
    entries.push({ r: r, g: g, b: b, count: count, lab: rgbToLab(r, g, b) });
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
      if (deltaE(t.lab, c.lab) < MERGE_DE) {
        var tot = t.count + c.count;
        t.r = Math.round((t.r * t.count + c.r * c.count) / tot);
        t.g = Math.round((t.g * t.count + c.g * c.count) / tot);
        t.b = Math.round((t.b * t.count + c.b * c.count) / tot);
        t.count = tot;
        t.lab = rgbToLab(t.r, t.g, t.b);
        absorbed = true;
        break;
      }
    }
    if (!absorbed) merged.push({ r: c.r, g: c.g, b: c.b, count: c.count, lab: c.lab });
  }
  merged.sort(function (a, b) {
    return b.count - a.count;
  });
  return merged.map(function (c) {
    return { r: c.r, g: c.g, b: c.b, count: c.count };
  });
}

/**
 * Regroupe des couleurs en familles de teinte (décision sur le Lab).
 * @param {Array<{r,g,b,count}>} colors
 * @returns {Array<{id,name,hue,gray,colors,total,hex}>} familles triées par total desc.
 */
export function groupByHue(colors) {
  var grays = [];
  var chroma = [];
  for (var i = 0; i < colors.length; i++) {
    var c = colors[i];
    var lab = rgbToLab(c.r, c.g, c.b);
    var item = { r: c.r, g: c.g, b: c.b, count: c.count, h: lab.h, C: lab.C, L: lab.L };
    if (lab.C < GRAY_CHROMA) grays.push(item);
    else chroma.push(item);
  }
  chroma.sort(function (a, b) {
    return a.h - b.h;
  });

  // Découpe circulaire : on coupe au PLUS GRAND gap (wrap inclus), puis aux
  // gaps intérieurs > HUE_GAP. Ça évite de couper une famille à cheval sur 0°
  // (ex. des roses à 355° et 5° restent ensemble).
  var groups = [];
  if (chroma.length) {
    var n = chroma.length;
    if (n === 1) {
      groups.push([chroma[0]]);
    } else {
      var gaps = [];
      for (var j = 0; j < n; j++) {
        var nxt = chroma[(j + 1) % n];
        var gap = (nxt.h - chroma[j].h + 360) % 360;
        gaps.push(gap);
      }
      var cut = 0;
      var maxGap = -1;
      for (var g2 = 0; g2 < n; g2++) {
        if (gaps[g2] > maxGap) {
          maxGap = gaps[g2];
          cut = g2;
        }
      }
      // Ordre de parcours à partir d'après la coupe, teintes DÉROULÉES
      // (+360° après un passage par 0°) pour que les gaps restent mesurables.
      var ordered = [];
      for (var o = 0; o < n; o++) ordered.push(chroma[(cut + 1 + o) % n]);
      var angs = [ordered[0].h];
      for (var o2 = 1; o2 < n; o2++) {
        var hh = ordered[o2].h;
        while (hh < angs[o2 - 1]) hh += 360;
        angs.push(hh);
      }
      var cur = [ordered[0]];
      for (var q = 1; q < ordered.length; q++) {
        if (angs[q] - angs[q - 1] > HUE_GAP) {
          groups.push(cur);
          cur = [];
        }
        cur.push(ordered[q]);
      }
      groups.push(cur);
      if (maxGap <= HUE_GAP && groups.length > 1) {
        // Toutes les teintes tiennent dans un mouchoir : une seule famille.
        var solo = [];
        for (var u = 0; u < groups.length; u++) solo.push.apply(solo, groups[u]);
        solo.sort(function (a, b) {
          return a.h - b.h;
        });
        groups = [solo];
      }
    }
  }

  // Sous-découpe par clarté : un bordeaux (L~27) et un rose (L~73) partagent
  // leur teinte mais pas leur famille — sauf vrai dégradé continu (pas < 22).
  var lSplit = [];
  for (var sp = 0; sp < groups.length; sp++) {
    var byL = groups[sp].slice().sort(function (a, b) {
      return a.L - b.L;
    });
    var run = [byL[0]];
    for (var sl = 1; sl < byL.length; sl++) {
      if (byL[sl].L - byL[sl - 1].L > L_SPLIT) {
        lSplit.push(run);
        run = [];
      }
      run.push(byL[sl]);
    }
    lSplit.push(run);
  }
  groups = lSplit;

  // Absorbe les micro-familles (< 1.5% des cellules) par la voisine la plus
  // proche en teinte ET clarté (un petit brun rejoint les oranges, pas les roses).
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
      for (var u2 = 0; u2 < tiny.length; u2++) {
        var hm = hueMean(tiny[u2]);
        var lm = groupLMean(tiny[u2]);
        var best = 0;
        var bestD = Infinity;
        for (var k = 0; k < kept.length; k++) {
          var d =
            hueDist(hm, hueMean(kept[k])) +
            Math.abs(lm - groupLMean(kept[k])) * 0.5;
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        }
        for (var v = 0; v < tiny[u2].length; v++) kept[best].push(tiny[u2][v]);
      }
      groups = kept;
    }
    for (var q2 = 0; q2 < groups.length; q2++) {
      groups[q2].sort(function (a, b) {
        return a.h - b.h;
      });
    }
  }

  var fams = [];
  function finalize(list, gray) {
    if (!list.length) return;
    var tot = 0;
    var rep = list[0];
    for (var i = 0; i < list.length; i++) {
      tot += list[i].count;
      if (list[i].count > rep.count) rep = list[i];
    }
    var hue = gray ? 0 : hueMean(list);
    var lMean = gray ? 0 : groupLMean(list);
    var cols = list
      .slice()
      .sort(function (a, b) {
        return b.count - a.count;
      })
      .map(function (c) {
        return { r: c.r, g: c.g, b: c.b, count: c.count, hex: hexOf(c.r, c.g, c.b) };
      });
    fams.push({
      id: familyIdFor(Math.round(hue), gray, lMean),
      name: gray ? "Gris / Noir / Blanc" : hueName(hue),
      hue: Math.round(hue),
      lMean: Math.round(lMean),
      gray: gray,
      colors: cols,
      total: tot,
      hex: hexOf(rep.r, rep.g, rep.b),
    });
  }
  if (grays.length) finalize(grays, true);
  for (var f = 0; f < groups.length; f++) finalize(groups[f], false);
  // Familles partageant un nom (deux roses séparés par la clarté) :
  // "Rose clair" / "Rose foncé" au lieu de deux cartes "Rose".
  var byName = {};
  for (var dn = 0; dn < fams.length; dn++) {
    var nm = fams[dn].name;
    (byName[nm] = byName[nm] || []).push(fams[dn]);
  }
  for (var key in byName) {
    if (Object.prototype.hasOwnProperty.call(byName, key) && byName[key].length > 1) {
      var dup = byName[key].slice().sort(function (a, b) {
        return a.lMean - b.lMean;
      });
      dup[0].name = key + " foncé";
      dup[dup.length - 1].name = key + " clair";
    }
  }
  // Unicité des ids si deux familles tombent sur le même bucket (rare).
  var seen = {};
  for (var nn = 0; nn < fams.length; nn++) {
    var base = fams[nn].id;
    var k2 = 2;
    while (seen[fams[nn].id]) fams[nn].id = base + "-" + k2++;
    seen[fams[nn].id] = true;
  }
  fams.sort(function (a, b) {
    return b.total - a.total;
  });
  return fams;
}

/**
 * Quantifie une famille à k nuances : tri par clarté L (perceptuelle),
 * découpe en k paquets à poids (nb de cellules) équilibré,
 * représentant = moyenne pondérée.
 * @returns {Map<number,{r,g,b}>} clé rgb d'origine -> couleur de remplacement.
 */
export function quantizeFamily(family, k) {
  var map = new Map();
  var cols = family.colors.slice().sort(function (a, b) {
    var la = rgbToLab(a.r, a.g, a.b).L;
    var lb = rgbToLab(b.r, b.g, b.b).L;
    if (la !== lb) return la - lb;
    return a.count - b.count;
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
  // Représentant = MEDOÏDE : la vraie couleur la plus fréquente du paquet.
  // (Jamais de moyenne inventée : pas de blanc rosâtre ni de rose brunâtre.)
  var rep = bucket[0];
  for (var i = 1; i < bucket.length; i++) {
    if (bucket[i].count > rep.count) rep = bucket[i];
  }
  var rgb = { r: rep.r, g: rep.g, b: rep.b };
  for (var j = 0; j < bucket.length; j++) {
    map.set(keyOf(bucket[j].r, bucket[j].g, bucket[j].b), rgb);
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
