import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisibleMapInspector } from '../visible-map-inspector.js';
import { buildVisibleMapReport, compareCaptures, concludeRuntime, copyVisibleMapReport, createAbSession, validateCapture } from '../visible-map-report.js';
import { validatePageFact } from '../content-ui.js';
import { CENTER, SECRET, TILE_X, TILE_Y, createSyntheticL, createSyntheticMap, decodedTile, maskLayer, rasterLayer, rendererTile, vectorGridLayer } from './fixtures/synthetic-leaflet.js';

// One page, one map: cadastre can be added later by the "user" (the test), never by the inspector.
function page({ tiles } = {}) {
  const L = createSyntheticL(); const layers = [rasterLayer(L), maskLayer(L)];
  const map = createSyntheticMap(L, layers);
  const global = { L, document: { querySelectorAll: () => [map._container] }, map };
  const inspector = createVisibleMapInspector(global);
  const enableCadastre = (build = tiles) => { const layer = vectorGridLayer(L, { tiles: build ? build(L) : { [`${TILE_X}:${TILE_Y}:17`]: rendererTile(L) } }); map._layers[layer._leaflet_id] = layer; return layer; };
  return { L, map, inspector, enableCadastre, disableCadastre: () => { delete map._layers[5]; } };
}
const json = value => JSON.stringify(value);

test('capture A (cadastre OFF) and capture B (cadastre ON) are stored by slot and survive validation', () => {
  const p = page(); const session = createAbSession();
  session.record('A', p.inspector.capture());
  p.enableCadastre();
  session.record('B', p.inspector.capture());
  assert.equal(session.state.A.cadastreCandidate.status, 'not-found');
  assert.equal(session.state.B.cadastreCandidate.status, 'found');
  assert.equal(session.state.A.slot, 'A'); assert.equal(session.state.B.slot, 'B');
  assert.equal(session.record('C', p.inspector.capture()), false);
  assert.equal(session.record('A', { hostile: true }), false);
});

test('comparison reports added/removed layers, tile cache change and the likeliest cadastre candidate', () => {
  const p = page(); const a = p.inspector.capture(); const layer = p.enableCadastre(); const b = p.inspector.capture();
  const comparison = compareCaptures(validateCapture({ ...a, slot: 'A' }), validateCapture({ ...b, slot: 'B' }));
  assert.equal(comparison.available, true);
  assert.deepEqual(comparison.layersAdded.map(item => [item.leafletId, item.kind]), [[layer._leaflet_id, 'vectorgrid']]);
  assert.deepEqual(comparison.layersRemoved, []);
  assert.equal(comparison.layerCountDelta, 1);
  assert.deepEqual(comparison.tileCacheDelta, { tiles: 1, vectorTiles: 1, decodedFeatures: 3 });
  assert.deepEqual(comparison.rendererDelta, { Canvas: 1 });
  assert.ok(comparison.newStructures.includes('representation:leaflet-pixel-parts'));
  assert.equal(comparison.mostLikelyCadastre.leafletId, layer._leaflet_id);
  assert.equal(comparison.viewport.sameZoom, true);
  assert.equal(compareCaptures(null, b).available, false);
  p.disableCadastre();
  const c = p.inspector.capture();
  assert.deepEqual(compareCaptures(validateCapture({ ...b, slot: 'B' }), validateCapture({ ...c, slot: 'A' })).layersRemoved.map(item => item.leafletId), [layer._leaflet_id]);
});

test('comparison flags a viewport change instead of hiding it', () => {
  const p = page(); const a = p.inspector.capture(); p.enableCadastre(); p.map.getZoom = () => 18; const b = p.inspector.capture();
  assert.equal(compareCaptures(validateCapture({ ...a, slot: 'A' }), validateCapture({ ...b, slot: 'B' })).viewport.sameZoom, false);
});

test('taking captures never changes the layers: no automatic cadastre toggle, no map mutation', () => {
  const p = page(); const session = createAbSession();
  const before = Object.keys(p.map._layers).join();
  session.record('A', p.inspector.capture()); session.compare(); session.report();
  assert.equal(Object.keys(p.map._layers).join(), before); assert.deepEqual(p.map.calls, []);
});

test('conclusion is deterministic for each runtime situation', () => {
  const direct = page({ tiles: () => ({ '1:2:17': decodedTile(2) }) }); direct.enableCadastre();
  const renderer = page(); renderer.enableCadastre();
  const cache = page({ tiles: L => { const r = new L.Canvas(); r._ctx = {}; return { '1:2:17': r }; } }); cache.enableCadastre();
  const empty = page({ tiles: () => ({}) }); empty.enableCadastre();
  const none = page();
  const code = p => concludeRuntime(validateCapture({ ...p.inspector.capture(), slot: 'B' }), null).code;
  assert.equal(code(direct), 'DIRECT_GEOMETRY_AVAILABLE');
  assert.equal(code(renderer), 'RENDERER_GEOMETRY_AVAILABLE');
  assert.equal(code(cache), 'TILE_CACHE_WITHOUT_GEOMETRY');
  assert.equal(code(empty), 'NO_RUNTIME_GEOMETRY_FOUND');
  assert.equal(code(none), 'INSUFFICIENT_EVIDENCE');
  assert.equal(concludeRuntime(null, null).code, 'INSUFFICIENT_EVIDENCE');
  const again = concludeRuntime(validateCapture({ ...direct.inspector.capture(), slot: 'B' }), null);
  assert.deepEqual(again, concludeRuntime(validateCapture({ ...direct.inspector.capture(), slot: 'B' }), null));
  assert.ok(again.recommendedNextStep.length > 20);
});

test('a map that is present but without cadastre after an A/B comparison is NO_RUNTIME_GEOMETRY_FOUND, not a guess', () => {
  const p = page(); const a = validateCapture({ ...p.inspector.capture(), slot: 'A' }); const b = validateCapture({ ...p.inspector.capture(), slot: 'B' });
  assert.equal(concludeRuntime(b, compareCaptures(a, b)).code, 'NO_RUNTIME_GEOMETRY_FOUND');
  assert.equal(concludeRuntime(b, null).code, 'INSUFFICIENT_EVIDENCE');
});

test('the JSON report is sanitized: structure and key names only', () => {
  const p = page(); const session = createAbSession();
  session.record('A', p.inspector.capture()); p.enableCadastre(); session.record('B', p.inspector.capture());
  const report = session.report(); const text = json(report);
  assert.deepEqual(Object.keys(report).sort(), ['cadastreCandidate', 'comparison', 'conclusion', 'inspection', 'layers', 'map', 'privacy', 'schemaVersion'].sort());
  assert.equal(report.inspection, 'visible-map-runtime'); assert.ok(report.conclusion.code); assert.ok(report.conclusion.recommendedNextStep);
  assert.match(text, /"idu"/);
  for (const forbidden of [SECRET, String(CENTER), String(TILE_X), String(TILE_Y), 'token', 'Authorization', 'Cookie', '?']) assert.equal(text.includes(forbidden), false, forbidden);
});

test('an empty session still yields a valid INSUFFICIENT_EVIDENCE report', () => {
  const report = buildVisibleMapReport({});
  assert.equal(report.conclusion.code, 'INSUFFICIENT_EVIDENCE'); assert.equal(report.map.status, 'not-captured');
});

test('copy writes exactly the sanitized report text', async () => {
  let written = ''; const p = page(); p.enableCadastre();
  const report = buildVisibleMapReport({ captureB: validateCapture({ ...p.inspector.capture(), slot: 'B' }) });
  const text = await copyVisibleMapReport(report, { writeText: async value => { written = value; } });
  assert.equal(written, text); assert.equal(text, JSON.stringify(report, null, 2));
});

test('hostile or oversized captures are rejected by the closed schema', () => {
  const p = page(); p.enableCadastre(); const good = { ...p.inspector.capture(), slot: 'A' };
  assert.ok(validateCapture(good));
  for (const hostile of [
    { ...good, cookie: 'x' }, { ...good, map: { ...good.map, center: [45.1, 2.3] } }, { ...good, 'no-additional-network-requests': false },
    { ...good, layers: [{ ...good.layers[0], templatePattern: { hostname: 'x.test', pathname: '/a?token=1' } }] },
    { ...good, layers: [{ ...good.layers[0], rawUrl: 'https://x.test/?token=1' }] },
    { ...good, cadastreCandidate: { ...good.cadastreCandidate, propertyValues: ['v'] } },
    { ...good, cadastreCandidate: { ...good.cadastreCandidate, propertyKeys: ['bad key with spaces'] } },
    { ...good, layers: Array.from({ length: 300 }, () => good.layers[0]) }
  ]) assert.equal(validateCapture(hostile), null);
});

test('the isolated bridge accepts only validated visible-map captures', () => {
  const p = page(); p.enableCadastre(); const capture = { ...p.inspector.capture(), slot: 'B' };
  assert.ok(validatePageFact({ type: 'visible-map-capture', capture }));
  assert.equal(validatePageFact({ type: 'visible-map-capture', capture: { ...capture, cookie: 'x' } }), null);
  assert.equal(validatePageFact({ type: 'visible-map-capture', capture, extra: 1 }), null);
});
