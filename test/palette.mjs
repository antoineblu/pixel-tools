/**
 * test/palette.mjs — vérification pour src/palette.js (Node, no deps).
 *
 * Scénario du besoin : 5 variantes roses (artefacts JPEG) + verts + gris.
 * On attend : 1 famille rose à 5 nuances -> slider à 3 = 3 couleurs,
 * à 1 = 1 couleur, et les familles vert/rose restent séparées.
 * Run: `node test/palette.mjs`
 */
import {
  extractCellColors,
  groupByHue,
  quantizeFamily,
  applyPalette,
  countColors,
} from "../src/palette.js";

let failures = 0;
function check(name, cond, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra}`);
  if (!cond) failures++;
}

// Image nettoyée synthétique : 8x2 cellules de 10px.
// Ligne 0 : 5 roses distincts + vert + bleu + gris. Ligne 1 : répétitions.
const PINKS = [
  [250, 150, 180],
  [248, 142, 172],
  [252, 158, 188],
  [240, 130, 165],
  [255, 170, 195],
];
const GREEN = [60, 180, 90];
const BLUE = [70, 120, 230];
const GRAY = [128, 128, 128];

const cellW = 10;
const cellH = 10;
const cols = 8;
const rows = 2;
const W = cols * cellW;
const H = rows * cellH;
const data = new Uint8ClampedArray(W * H * 4);
const layout = [
  [...PINKS, GREEN, BLUE, GRAY],
  [PINKS[0], PINKS[1], PINKS[2], PINKS[3], PINKS[4], GREEN, BLUE, GRAY],
];
for (let cy = 0; cy < rows; cy++) {
  for (let cx = 0; cx < cols; cx++) {
    const [r, g, b] = layout[cy][cx];
    for (let y = cy * cellH; y < (cy + 1) * cellH; y++) {
      for (let x = cx * cellW; x < (cx + 1) * cellW; x++) {
        const i = (y * W + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
  }
}
const cleaned = { width: W, height: H, data };
const grid = { cellW, cellH, offX: 0, offY: 0 };

const colors = extractCellColors(cleaned, grid);
check("extraction: 8 couleurs de cellules", colors.length === 8, ` (got ${colors.length})`);

const fams = groupByHue(colors);
const pink = fams.find((f) => f.name === "Rose" || f.name === "Magenta");
check("famille rose détectée", !!pink, ` (fams=${fams.map((f) => f.name + ":" + f.colors.length).join(",")})`);
check("famille rose = 5 nuances", !!pink && pink.colors.length === 5, ` (got ${pink && pink.colors.length})`);
check("familles séparées (rose/vert/bleu/gris)", fams.length >= 4, ` (got ${fams.length})`);

// Pré-fusion JPEG : 3 roses à ±4 niveaux doivent fusionner en 1.
const jdata = new Uint8ClampedArray(3 * cellW * cellH * 4);
const jpegs = [
  [250, 150, 180],
  [252, 152, 182],
  [248, 148, 178],
];
for (let cx = 0; cx < 3; cx++) {
  const [r, g, b] = jpegs[cx];
  for (let y = 0; y < cellH; y++) {
    for (let x = cx * cellW; x < (cx + 1) * cellW; x++) {
      const i = (y * 3 * cellW + x) * 4;
      jdata[i] = r;
      jdata[i + 1] = g;
      jdata[i + 2] = b;
      jdata[i + 3] = 255;
    }
  }
}
const jcolors = extractCellColors({ width: 3 * cellW, height: cellH, data: jdata }, grid);
check("artefacts JPEG ±4 pré-fusionnés en 1", jcolors.length === 1, ` (got ${jcolors.length})`);

// Quantification : 5 roses -> 3 nuances.
const q3 = quantizeFamily(pink, 3);
const distinct3 = new Set([...q3.values()].map((c) => `${c.r},${c.g},${c.b}`));
check("quantize rose à k=3 donne 3 teintes", distinct3.size === 3, ` (got ${distinct3.size})`);

const levels3 = { [pink.id]: 3 };
const out3 = applyPalette(cleaned, grid, fams, levels3);
// 5 roses -> 3, + vert + bleu + gris inchangés = 6 couleurs.
check("applyPalette k=3 : 8 -> 6 couleurs", countColors(out3) === 6, ` (got ${countColors(out3)})`);

const levels1 = { [pink.id]: 1 };
const out1 = applyPalette(cleaned, grid, fams, levels1);
check("applyPalette k=1 : 8 -> 4 couleurs", countColors(out1) === 4, ` (got ${countColors(out1)})`);

// Identité : pas de niveaux = image inchangée.
const outId = applyPalette(cleaned, grid, fams, {});
check("sans réglage : image identique", countColors(outId) === 8);

// Cas signalés : gris teinté JPEG -> gris, rose pâle -> rose,
// rouge séparé du rose, violet reconnu.
const tricky = [
  [245, 220, 230], // rose pâle (petit vecteur, direction rose franche)
  [235, 190, 205], // rose poudre
  [170, 150, 158], // gris teinté rose par le JPEG
  [128, 128, 128], // gris neutre
  [230, 40, 60], // rouge franc
  [150, 90, 200], // violet
  [60, 180, 90], // vert
];
const TW = tricky.length * cellW;
const tdata = new Uint8ClampedArray(TW * cellH * 4);
for (let cx = 0; cx < tricky.length; cx++) {
  const [r, g, b] = tricky[cx];
  for (let y = 0; y < cellH; y++) {
    for (let x = cx * cellW; x < (cx + 1) * cellW; x++) {
      const i = (y * TW + x) * 4;
      tdata[i] = r;
      tdata[i + 1] = g;
      tdata[i + 2] = b;
      tdata[i + 3] = 255;
    }
  }
}
const tcolors = extractCellColors({ width: TW, height: cellH, data: tdata }, grid);
const tfams = groupByHue(tcolors);
const famOf = (r, g, b) => tfams.find((f) => f.colors.some((c) => c.r === r && c.g === g && c.b === b));
check("rose pâle reste rose", famOf(245, 220, 230)?.name === "Rose", ` (got ${famOf(245, 220, 230)?.name})`);
check("rose poudre reste rose", famOf(235, 190, 205)?.name === "Rose", ` (got ${famOf(235, 190, 205)?.name})`);
check(
  "rose pâle + poudre dans la même famille",
  famOf(245, 220, 230) === famOf(235, 190, 205)
);
check("gris teinté JPEG reste gris", famOf(170, 150, 158)?.name === "Gris / Noir / Blanc", ` (got ${famOf(170, 150, 158)?.name})`);
check("rouge séparé du rose", famOf(230, 40, 60)?.name === "Rouge" && famOf(230, 40, 60) !== famOf(245, 220, 230), ` (got ${famOf(230, 40, 60)?.name})`);
check("violet reconnu", famOf(150, 90, 200)?.name === "Violet", ` (got ${famOf(150, 90, 200)?.name})`);
check("vert reconnu", famOf(60, 180, 90)?.name === "Vert", ` (got ${famOf(60, 180, 90)?.name})`);

// Bordeaux sombre vs rose clair : même direction de teinte, familles séparées.
const darkPink = groupByHue(
  extractCellColors(cellsImage([[120, 30, 50], [250, 150, 180], [255, 200, 215]]), grid)
);
check(
  "bordeaux séparé des roses clairs",
  darkPink.length === 2 && darkPink.some((f) => f.colors.some((c) => c.r === 120)),
  ` (fams=${darkPink.map((f) => f.name + ":" + f.colors.length).join(",")})`
);

// Rose poussiéreux sombre vs rose clair : deux cartes "Rose foncé" / "Rose clair".
const dusty = groupByHue(
  extractCellColors(cellsImage([[140, 90, 100], [250, 150, 180]]), grid)
);
const dustyNames = dusty.map((f) => f.name).sort().join("|");
check("rose sombre vs clair : deux cartes qualifiées", dustyNames === "Rose clair|Rose foncé", ` (got ${dustyNames})`);

// Médoïde : k=1 donne la vraie couleur majoritaire, jamais une moyenne inventée.
const whiteFam = {
  id: "t",
  colors: [
    { r: 250, g: 250, b: 250, count: 10, hex: "#fafafa" },
    { r: 245, g: 220, b: 230, count: 1, hex: "#f5dce6" },
  ],
};
const qMed = quantizeFamily(whiteFam, 1);
const medVals = new Set([...qMed.values()].map((c) => `${c.r},${c.g},${c.b}`));
check("k=1 blanc majoritaire : 1 seule vraie couleur", medVals.size === 1 && medVals.has("250,250,250"), ` (got ${[...medVals]})`);

// Forçage vert k=1 de bout en bout : 3 cellules vert majoritaire + 1 de chaque
// autre nuance -> une seule nuance, la majoritaire.
const gimg = cellsImage([[60, 180, 90], [60, 180, 90], [60, 180, 90], [85, 195, 115], [45, 165, 75], [150, 210, 150]]);
const gfams = groupByHue(extractCellColors(gimg, grid));
const gfam = gfams.find((f) => f.name === "Vert" || f.name === "Vert clair" || f.name === "Vert foncé") || gfams[0];
const gout = applyPalette(gimg, grid, gfams, { [gfam.id]: 1 });
const gset = new Set();
for (let i = 0; i < gout.data.length; i += 4) gset.add(`${gout.data[i]},${gout.data[i + 1]},${gout.data[i + 2]}`);
check("vert k=1 : une seule nuance, la majoritaire", gset.size === 1 && gset.has("60,180,90"), ` (got ${[...gset]})`);

// Famille grise : blanc majoritaire + teinte pâle minoritaire -> k=1 rend du
// vrai blanc, pas un blanc rosâtre moyen.
const wimg = cellsImage([[250, 250, 250], [250, 250, 250], [250, 250, 250], [250, 250, 250], [248, 232, 238], [200, 200, 200]]);
const wfams = groupByHue(extractCellColors(wimg, grid));
const wfam = wfams.find((f) => f.gray);
const wout = applyPalette(wimg, grid, wfams, wfam ? { [wfam.id]: 1 } : {});
const wset = new Set();
for (let i = 0; i < wout.data.length; i += 4) wset.add(`${wout.data[i]},${wout.data[i + 1]},${wout.data[i + 2]}`);
check("gris k=1 : blanc réel, pas de moyenne", wset.size === 1 && wset.has("250,250,250"), ` (got ${[...wset]})`);

function cellsImage(list) {
  const W2 = list.length * cellW;
  const d2 = new Uint8ClampedArray(W2 * cellH * 4);
  for (let cx = 0; cx < list.length; cx++) {
    const [r, g, b] = list[cx];
    for (let y = 0; y < cellH; y++) {
      for (let x = cx * cellW; x < (cx + 1) * cellW; x++) {
        const i = (y * W2 + x) * 4;
        d2[i] = r;
        d2[i + 1] = g;
        d2[i + 2] = b;
        d2[i + 3] = 255;
      }
    }
  }
  return { width: W2, height: cellH, data: d2 };
}

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("\nAll palette checks passed.");
