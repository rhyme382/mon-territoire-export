import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePageFact } from '../content-ui.js';

// The isolated-world validator is a classic script that publishes itself on globalThis when a window exists.
globalThis.window = globalThis;
await import('../visible-cadastre-export.js');

const ready = () => ({
  type: 'visible-cadastre', status: 'ready', viewport: { width: 400, height: 250 }, zoom: 17,
  features: [{ rings: [[[0, 0], [100, 0], [100, 50]], [[10, 10], [20, 10], [20, 20]]] }],
  counts: { cachedFeatures: 5, uniqueFeatures: 4, visibleFeatures: 1, exportedPaths: 1, clippedFeatures: 0, duplicatesHandled: 1, tiles: 3, tilesInViewport: 2, keyTiers: { id: 5, property: 0, geometry: 0 } },
  diagnostics: { tileSize: { width: 256, height: 256 }, tileZoom: 17, zoomScale: 1, viewportMethod: 'map.getSize', pixelOriginMethod: 'map.getPixelOrigin+layerPointToContainerPoint', transformMethod: 'tile-local-px*zoomScale+tile-origin', clippingMethod: 'sutherland-hodgman-viewport-rect', dedupMethod: 'feature-id>property>geometry-fingerprint' },
});
const V = () => globalThis.MonTerritoireVisibleCadastre;
test('accepts a well-formed capture, availability answers, and rebuilds clean copies', () => {
  const input = ready(); const out = V().validateCapture(input);
  assert.deepEqual(out, input); assert.notEqual(out.features, input.features);
  assert.deepEqual(V().validateCapture({ type: 'visible-cadastre', status: 'no-cadastre' }), { type: 'visible-cadastre', status: 'no-cadastre' });
  assert.deepEqual(validatePageFact({ type: 'visible-cadastre', status: 'ready' }), { type: 'visible-cadastre', status: 'ready' });
  assert.deepEqual(validatePageFact(ready()), ready(), 'large geometry is not rejected by the generic array cap');
});

test('rejects extra fields (ids, tile coordinates, properties), out-of-viewport points and bad shapes', () => {
  const bad = [];
  const add = mutate => { const v = ready(); mutate(v); bad.push(v); };
  add(v => { v.features[0].idu = 'X'; }); add(v => { v.features[0].properties = {}; }); add(v => { v.tile = { x: 1, y: 2 }; }); add(v => { v.center = [1, 2]; });
  add(v => { v.counts.tileX = 1; }); add(v => { v.counts.keyTiers.extra = 1; }); add(v => { v.diagnostics.url = 'https://x'; }); add(v => { v.diagnostics.pixelOriginMethod = 'x:123456'; });
  add(v => { v.features[0].rings[0][0] = [-5, 0]; }); add(v => { v.features[0].rings[0][0] = [0, 9999]; }); add(v => { v.features[0].rings[0][0] = [NaN, 0]; }); add(v => { v.features[0].rings[0][0] = [1, 2, 3]; });
  add(v => { v.features[0].rings = []; }); add(v => { v.features = []; }); add(v => { v.viewport.width = 0; }); add(v => { v.zoom = 99; }); add(v => { v.status = 'ready2'; }); add(v => { v.counts.cachedFeatures = -1; });
  add(v => { v.features = Array.from({ length: 20_001 }, () => ({ rings: [[[0, 0], [1, 0], [1, 1]]] })); });
  for (const value of bad) assert.equal(V().validateCapture(value), null);
  assert.equal(V().validateCapture({ type: 'visible-cadastre', status: 'no-map', extra: 1 }), null);
});

test('messages are plain French and free of engine jargon', () => {
  assert.equal(V().message('no-cadastre'), 'Activez la couche Cadastre.');
  assert.equal(V().message('no-map'), 'Carte non détectée.');
  assert.equal(V().message('no-geometry'), 'Carte non détectée.');
  for (const status of ['no-map', 'no-cadastre', 'no-geometry', 'empty-view', 'ready']) assert.doesNotMatch(V().message(status), /VectorGrid|Leaflet|tile|renderer/i);
});

test('diagnostic text has the requested summary and no identifier or coordinate', () => {
  const text = V().diagnosticText(ready());
  for (const label of ['Viewport :', '400 × 250', 'Cadastre :', 'cached features: 5', 'unique features: 4', 'visible features: 1', 'exported paths: 1', 'clipped features: 0', 'duplicates/fragments handled: 1', 'pixel origin: map.getPixelOrigin+layerPointToContainerPoint', 'tile size: 256×256']) assert.ok(text.includes(label), label);
  assert.doesNotMatch(text, /\[\[|idu|insee|lat|lng/i);
  assert.equal(V().diagnosticText(null), 'Aucun export.');
});
