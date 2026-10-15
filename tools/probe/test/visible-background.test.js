import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { exportVisibleCadastre } from '../../gpkg-svg/browser/api.js';
import { prepareViewportDocument } from '../../gpkg-svg/core/viewport-export.js';
import { buildSvg } from '../../gpkg-svg/core/svg-writer.js';

globalThis.window = globalThis;
await import('../visible-background.js');
await import('../visible-cadastre-export.js');
const B = () => globalThis.MonTerritoireVisibleBackground;
const V = () => globalThis.MonTerritoireVisibleCadastre;
const NOW = new Date(2026, 9, 9, 12);
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

// ---- synthetic, offline page: decoded <img> elements and a recording canvas (no DOM, no network) ----------------
const img = (extra = {}) => ({ tagName: 'IMG', currentSrc: 'blob:synthetic', naturalWidth: 256, naturalHeight: 256, complete: true, ...extra });
const taintedImg = () => img({ tainted: true, currentSrc: 'https://tiles.test/secret-path/1/2/3.png?token=SECRET-VALUE-9f3' });
function canvasFactory({ log = [] } = {}) {
  const create = (width, height) => {
    const canvas = { width, height, tainted: false };
    canvas.getContext = () => ({
      drawImage: (element, ...args) => { if (element.tainted) canvas.tainted = true; log.push({ element, args, canvas }); },
      getImageData: () => { if (canvas.tainted) { const error = new Error('tainted'); error.name = 'SecurityError'; throw error; } return {}; },
    });
    canvas.toDataURL = () => { if (canvas.tainted) { const error = new Error('tainted'); error.name = 'SecurityError'; throw error; } return PNG; };
    return canvas;
  };
  return create;
}
const TILE = 256; const X0 = 10; const Y0 = 20;
// 2x2 tiles; the viewport starts 50/30 px inside the first tile, so the outer tiles are clipped on every side.
const view = (width = 400, height = 300) => ({ size: { x: width, y: height }, pixelOrigin: { x: X0 * TILE + 50, y: Y0 * TILE + 30 }, mapZoom: 17, zoomScale: () => 1, toContainer: point => point });
function tileLayer(elements, { zoom = 17, wms = false } = {}) {
  const tiles = {}; elements.forEach(([x, y, el, z = zoom]) => { tiles[`${x}:${y}:${z}`] = { el, coords: { x, y, z } }; });
  return { _tiles: tiles, _tileZoom: zoom, getTileSize: () => ({ x: TILE, y: TILE }), options: { tileSize: TILE }, ...(wms ? { wmsParams: { layers: 'zones' } } : {}) };
}
const grid = (make = () => img()) => [[X0, Y0, make()], [X0 + 1, Y0, make()], [X0, Y0 + 1, make()], [X0 + 1, Y0 + 1, make()]];
const candidate = (layer, record = {}) => ({ layer, record: { kind: 'raster', confidence: 'high', pane: 'tilePane', zIndex: 1, ...record } });
const capture = (candidates, { mode = 'export', log, v = view() } = {}) => B().vbgCapture({ candidates, view: v, createCanvas: canvasFactory({ log }), mode });

test('1. the principal basemap is a raster TileLayer holding decoded tile images (high confidence, structural evidence)', () => {
  const result = capture([candidate(tileLayer(grid()))]);
  assert.equal(result.status, 'embedded');
  assert.equal(result.candidate.status, 'found'); assert.equal(result.candidate.confidence, 'high');
  assert.ok(result.candidate.evidence.includes('tile-cache:images') && result.candidate.evidence.includes('not-wms'));
});

test('2. a WMS is never taken for the basemap: not raster-classified, or alone it is not enough to be identified', () => {
  const wmsOnly = capture([{ layer: tileLayer(grid(), { wms: true }), record: { kind: 'wms', confidence: 'high', pane: 'overlayPane' } }]);
  assert.equal(wmsOnly.status, 'unavailable'); assert.equal(wmsOnly.reason, 'no-candidate');
  const both = capture([candidate(tileLayer(grid(() => img({ naturalWidth: 128 })), { wms: true }), { pane: 'overlayPane', zIndex: 9 }), candidate(tileLayer(grid()))]);
  assert.equal(both.status, 'embedded'); assert.ok(both.candidate.evidence.includes('lowest-raster-layer'));
});

test('3. two raster layers at the same order are ambiguous: nothing is embedded', () => {
  const result = capture([candidate(tileLayer(grid())), candidate(tileLayer(grid()))]);
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'ambiguous');
});

test('4. a raster layer without any tile image in its cache is not identified', () => {
  assert.equal(capture([candidate(tileLayer([]))]).reason, 'no-candidate');
  assert.equal(capture([candidate(tileLayer([[X0, Y0, {}]]))]).reason, 'no-candidate'); // not an <img>/<canvas>
});

test('5. only the tiles intersecting the viewport are placed; tiles kept from another zoom are ignored', () => {
  const far = [X0 + 5, Y0 + 5, img()]; const stale = [X0, Y0, img(), 16];
  const log = [];
  const result = capture([candidate(tileLayer([...grid(), far, stale]))], { log });
  assert.equal(result.status, 'embedded');
  assert.equal(result.tiles.intersecting, 4); assert.equal(result.tiles.readable, 4);
  assert.equal(log.filter(entry => entry.element === far[2] || entry.element === stale[2]).length, 0);
});

test('6. clipping: each tile is cut to the canvas and the source rectangle follows the cut', () => {
  const placement = B().vbgTilePlacement({ x: -50, y: -30, w: 256, h: 256 }, 1, 400, 300, { width: 256, height: 256 });
  assert.deepEqual(placement, { dx: 0, dy: 0, dw: 206, dh: 226, sx: 50, sy: 30, sw: 206, sh: 226 });
  const last = B().vbgTilePlacement({ x: 206, y: 226, w: 256, h: 256 }, 1, 400, 300, { width: 256, height: 256 });
  assert.deepEqual([last.dx, last.dy, last.dw, last.dh], [206, 226, 194, 74]);
  assert.equal(B().vbgTilePlacement({ x: 400, y: 0, w: 256, h: 256 }, 1, 400, 300, { width: 256, height: 256 }), null);
});

test('7. 2x2 composition: a canvas of exactly the viewport size, tiles abut with no gap or overlap', () => {
  const log = [];
  const result = capture([candidate(tileLayer(grid()))], { log });
  assert.equal(result.image.pixelWidth, 400); assert.equal(result.image.pixelHeight, 300);
  assert.equal(result.composition.pixelRatio, 1);
  const draws = log.filter(entry => entry.args.length === 8);
  assert.equal(draws.length, 4);
  const rects = draws.map(({ args }) => args.slice(4)).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  assert.deepEqual(rects, [[0, 0, 206, 226], [206, 0, 194, 226], [0, 226, 206, 74], [206, 226, 194, 74]]);
  assert.equal(rects.reduce((area, [, , w, h]) => area + w * h, 0), 400 * 300);
  assert.ok(draws.every(({ canvas }) => canvas.width === 400 && canvas.height === 300));
  assert.match(result.image.dataUri, /^data:image\/png;base64,/);
});

test('8. higher-resolution tiles raise the output resolution (up to 2x), same viewport frame', () => {
  const result = capture([candidate(tileLayer(grid(() => img({ naturalWidth: 512, naturalHeight: 512 }))))]);
  assert.equal(result.composition.pixelRatio, 2);
  assert.deepEqual([result.image.pixelWidth, result.image.pixelHeight], [800, 600]);
});

test('9. readable <img>, data: and blob: elements are accepted; canvas elements too', () => {
  const log = [];
  const result = capture([candidate(tileLayer([
    [X0, Y0, img({ currentSrc: 'data:image/png;base64,AAAA' })], [X0 + 1, Y0, img({ currentSrc: 'blob:x' })],
    [X0, Y0 + 1, { tagName: 'CANVAS', width: 256, height: 256 }], [X0 + 1, Y0 + 1, img({ currentSrc: 'https://tiles.test/a.png' })],
  ]))], { log });
  assert.equal(result.status, 'embedded');
  assert.deepEqual(result.tiles.methods, { 'data-uri': 1, blob: 1, 'canvas-element': 1, 'image-element': 1 });
});

test('10. SecurityError / CORS: a tainted tile is unreadable, nothing is embedded and nothing is bypassed', () => {
  const layers = grid(); layers[1][2] = taintedImg();
  const result = capture([candidate(tileLayer(layers))]);
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'incomplete');
  assert.equal(result.tiles.unreadable, 1); assert.equal(result.tiles.completeness, 'incomplete');
  assert.equal(result.candidate.imageAccess, 'partially-readable');
  const all = capture([candidate(tileLayer(grid(taintedImg)))]);
  assert.equal(all.reason, 'cors'); assert.equal(all.candidate.imageAccess, 'unavailable-cors');
  assert.equal(B().vbgProbeReadable(taintedImg(), canvasFactory()).reason, 'cors');
  assert.equal(JSON.stringify(all).includes('SECRET'), false);
});

test('11. a missing or not yet decoded tile makes the basemap incomplete: no holed background is embedded', () => {
  const loading = grid(); loading[2][2] = img({ complete: false, naturalWidth: 0, naturalHeight: 0 });
  assert.equal(capture([candidate(tileLayer(loading))]).status, 'unavailable');
  assert.equal(capture([candidate(tileLayer(loading))]).tiles.completeness, 'incomplete');
  const missing = grid().slice(0, 3); // bottom-right quarter of the viewport has no tile
  const result = capture([candidate(tileLayer(missing))]);
  assert.equal(result.status, 'unavailable'); assert.equal(result.reason, 'incomplete'); assert.equal(result.image, undefined);
});

test('12. status mode only probes: it reports "embeddable" without composing any image', () => {
  const log = [];
  const result = capture([candidate(tileLayer(grid()))], { mode: 'status', log });
  assert.equal(result.status, 'embeddable'); assert.equal(result.image, undefined);
  assert.equal(log.filter(entry => entry.args.length === 8).length, 0);
});

test('13. the report carries counters and class names only: no URL, tile x/y or token', () => {
  const result = capture([candidate(tileLayer(grid(() => img({ currentSrc: 'https://tiles.test/p/10/20.png?token=SECRET-VALUE-9f3' }))))]);
  const { image, ...rest } = result;
  const text = JSON.stringify(rest);
  assert.doesNotMatch(text, /https?:|SECRET|tiles\.test|token/);
  assert.equal(text.includes(String(X0 * TILE)), false);
});

// ---- from the page reader to the SVG ---------------------------------------------------------------------------
const readyFact = (background, selection) => ({
  type: 'visible-cadastre', status: 'ready', viewport: { width: 400, height: 300 }, zoom: 17,
  features: [{ rings: [sq(0, 0, 100, 50)] }, { rings: [sq(120, 0, 220, 50)] }],
  counts: { cachedFeatures: 2, uniqueFeatures: 2, visibleFeatures: 2, exportedPaths: 2, clippedFeatures: 0, duplicatesHandled: 0, tiles: 3, tilesInViewport: 2, keyTiers: { id: 2, property: 0, geometry: 0 } },
  diagnostics: { tileSize: { width: 256, height: 256 }, tileZoom: 17, zoomScale: 1, viewportMethod: 'map.getSize', pixelOriginMethod: 'map.getPixelOrigin+layerPointToContainerPoint', transformMethod: 'tile-local-px*zoomScale+tile-origin', clippingMethod: 'sutherland-hodgman-viewport-rect', dedupMethod: 'feature-id>property>geometry-fingerprint' },
  ...(selection ? { selection } : {}), ...(background ? { background } : {}),
});
const selection = () => ({
  status: 'ready', features: [{ rings: [sq(10, 10, 60, 60)] }],
  counts: { candidatePolygons: 1, selectedFeaturesDetected: 1, selectedFeaturesVisible: 1, selectedPathsExported: 1, selectedFeaturesClipped: 0, duplicatesHandled: 0, keyTiers: { id: 0, property: 0, geometry: 1 } },
  diagnostics: { projectionMethods: { 'leaflet-rings': 1 }, paneCounts: { selection: 1 } },
  source: { confidence: 'high', mechanism: 'ab-delta-new-group', evidence: ['ab-delta'], candidateGroups: 1, rejectedPolygons: 0 },
});
const layersOf = svg => [...svg.matchAll(/inkscape:label="([^"]+)" id="([^"]+)"/g)].map(m => m[1]);

test('14. an embedded basemap becomes the first layer: Fond cartographique / Cadastre / Parcelles sélectionnées', () => {
  const background = capture([candidate(tileLayer(grid()))]);
  const fact = V().validateCapture(readyFact(background, selection()));
  assert.ok(fact && fact.background.status === 'embedded');
  const document = prepareViewportDocument(fact);
  assert.deepEqual(document.layers.map(layer => [layer.id, layer.type]), [['layer-background', 'raster'], ['layer-cadastre', 'vector'], ['layer-selected-parcels', 'vector']]);
  const { svg } = exportVisibleCadastre(fact, { now: NOW });
  assert.deepEqual(layersOf(svg), ['Fond cartographique', 'Cadastre', 'Parcelles sélectionnées']);
});

test('15. raster and vector layers share width, height, viewBox and origin; no remote URL anywhere in the SVG', () => {
  const fact = V().validateCapture(readyFact(capture([candidate(tileLayer(grid()))]), selection()));
  const { svg } = exportVisibleCadastre(fact, { now: NOW });
  assert.match(svg, /<svg [^>]*width="400" height="300" viewBox="0 0 400 300"/);
  assert.match(svg, /<image id="background-image" x="0" y="0" width="400" height="300" preserveAspectRatio="none" xlink:href="data:image\/png;base64,/);
  assert.doesNotMatch(svg.replace('xmlns:xlink="http://www.w3.org/1999/xlink"', '').replace(/xmlns(?::\w+)?="[^"]+"/g, ''), /https?:\/\//);
  assert.doesNotMatch(svg, /xlink:href="(?!data:image)/);
  assert.equal((svg.match(/<image /g) || []).length, 1);
  assert.ok(svg.indexOf('layer-background') < svg.indexOf('layer-cadastre') && svg.indexOf('layer-cadastre') < svg.indexOf('layer-selected-parcels'));
});

test('16. a retina raster (2x) keeps the same viewport frame', () => {
  const fact = V().validateCapture(readyFact(capture([candidate(tileLayer(grid(() => img({ naturalWidth: 512, naturalHeight: 512 }))))]), null));
  const { svg } = exportVisibleCadastre(fact, { now: NOW });
  assert.match(svg, /viewBox="0 0 400 300"/); assert.match(svg, /<image [^>]*width="400" height="300"/);
});

test('17. fallback: an incomplete or blocked basemap leaves a working vector-only export, with an explicit state', () => {
  const layers = grid(); layers[0][2] = taintedImg();
  const blocked = capture([candidate(tileLayer(layers))]);
  const fact = V().validateCapture(readyFact(blocked, selection()));
  assert.ok(fact, 'the capture stays valid');
  const { svg } = exportVisibleCadastre(fact, { now: NOW });
  assert.deepEqual(layersOf(svg), ['Cadastre', 'Parcelles sélectionnées']);
  assert.doesNotMatch(svg, /<image /);
  assert.match(V().backgroundText(fact), /not embedded/);
  assert.match(V().backgroundFallbackMessage, /export vectoriel/);
});

test('18. a capture without any basemap report (old reader, no candidate) still exports the previous way', () => {
  const { svg } = exportVisibleCadastre(V().validateCapture(readyFact(null, null)), { now: NOW });
  assert.deepEqual(layersOf(svg), ['Cadastre']);
});

test('19. the reader is not trusted: a forged embedded background is rejected, never turned into a raster', () => {
  const good = capture([candidate(tileLayer(grid()))]);
  const forge = patch => V().validateCapture(readyFact({ ...good, ...patch }, null));
  assert.equal(forge({ image: { ...good.image, dataUri: 'https://evil.test/x.png' } }), null);
  assert.equal(forge({ image: { ...good.image, dataUri: 'data:image/svg+xml;base64,AAAA' } }), null);
  assert.equal(forge({ image: { ...good.image, pixelWidth: 400, pixelHeight: 100 } }), null);
  assert.equal(forge({ tiles: { ...good.tiles, unreadable: 1, completeness: 'incomplete' } }), null);
  assert.equal(forge({ extra: 1 }), null);
});

test('20. the SVG writer only accepts self-contained raster layers', () => {
  const layer = image => ({ id: 'layer-background', label: 'Fond cartographique', type: 'raster', idPrefix: 'background', rect: { x: 0, y: 0, width: 10, height: 10 }, image });
  const build = image => buildSvg({ layers: [layer(image)], transform: { width: 10, height: 10, apply: p => p }, metadata: {} });
  assert.match(build({ dataUri: PNG }), /<image /);
  for (const bad of ['https://tiles.test/a.png', 'blob:x', '//x/y.png', 'data:text/html;base64,AAAA', 'data:image/png;base64,AA" onload="x']) assert.throws(() => build({ dataUri: bad }), { code: 'INVALID_RASTER_LAYER' });
  assert.throws(() => buildSvg({ layers: [{ id: 'x', label: 'x', type: 'other' }], transform: { width: 1, height: 1, apply: p => p }, metadata: {} }), { code: 'UNSUPPORTED_LAYER_TYPE' });
});

test('21. the user state lines are Cadastre / Sélection / Fond, and a blocked basemap does not block the button', () => {
  const lines = fact => V().stateLines(fact);
  assert.deepEqual(lines({ type: 'visible-cadastre', status: 'ready', summary: { selection: { state: 'ready', count: 2 }, background: { state: 'embeddable' } } }).map(line => line.split(' :')[0]), ['Cadastre', 'Sélection', 'Fond']);
  assert.ok(lines({ type: 'visible-cadastre', status: 'ready', summary: { selection: { state: 'none', count: 0 }, background: { state: 'not-embeddable' } } }).includes('Fond : non incorporable'));
});

test('22. no network, no persistence, no new permission: the background reader is passive', () => {
  const source = readFileSync(new URL('../visible-background.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|new Image\b|\.src\s*=|crossOrigin|localStorage|sessionStorage|indexedDB|chrome\.|webRequest|debugger|createImageBitmap/);
  assert.doesNotMatch(source, /Object\.defineProperty|\.setPrototypeOf|\bwith\s*\(/);
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab']);
  assert.equal(manifest.host_permissions, undefined);
  assert.deepEqual(manifest.background, { service_worker: 'service-worker.js' }); // MVP-06: captureVisibleTab lives there; no permission added
});
