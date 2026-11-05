# Pixel Tools — client-only pixel-art grid detector

Upload a pixel-art image, auto-detect the grid (cell width, cell height,
offset — each estimated independently, so **stretched / non-square pixels**
work), and overlay a red grid plus highlighted **5×5 chunks** to work through
the piece block by block. Everything runs in the browser; images never leave
the computer.

## Run locally

Any static server works (ES modules need `http`, not `file://`):

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

## Host on GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo → **Settings → Pages** → Deploy from branch → `main`, folder `/ (root)`.
3. Open the published URL. No build step, works in Safari/Chrome/Firefox.

## How detection works (`src/detect.js`)

Grayscale → Gaussian blur → Sobel X/Y → per-column / per-row gradient
projection profiles → independent comb vote per axis (cell width from columns,
cell height from rows) → fundamental descent (rejects 2×/4× multiples from
alternating line strength) → fractional refinement. See the file header and
`test/verify.mjs` for details.

## Tests

```sh
node test/verify.mjs   # synthetic square + stretched grids (needs src/detect.js)
node test/overlay.mjs  # grid/chunk overlay geometry with stubbed canvas
node test/clean.mjs    # median flattening: lines + noise erased (needs src/clean.js)
```

## Manual controls

Auto-detect pre-fills cell width/height and offset X/Y on every upload; nudge
any of them by hand when the source is stretched oddly. Blur and threshold
tune the detector; toggles switch the red grid and 5×5 chunk highlights.

## Clean my pixels 🧹

The **Clean** button flattens every cell to its median color (`src/clean.js`),
erasing baked-in grid lines, JPEG wobble and noise — each cell becomes one
perfect flat square with the red grid on top. It re-cleans automatically when
you nudge the grid, and the Save button exports exactly what's on screen
(cleaned or original) — via the native share sheet on iPhone (Save Image
lands straight in the photo library) or a PNG download elsewhere.
