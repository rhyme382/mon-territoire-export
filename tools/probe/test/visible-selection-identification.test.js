import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisibleMapInspector } from '../visible-map-inspector.js';
import { exportVisibleCadastre } from '../../gpkg-svg/browser/api.js';
import { SECRET, attach, createContainer, createSyntheticL, createSyntheticMap, geometryTile, groupLayer, maskLayer, polygonLayer, selectionProject, vectorGridLayer } from './fixtures/synthetic-leaflet.js';

// MVP-04 part 1: the selection is identified from structure (A/B delta, group, corroboration), never as "every Polygon".
globalThis.window = globalThis;
const G = await import('../visible-cadastre-geometry.js');
await import('../visible-cadastre-export.js');
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const json = value => JSON.stringify(value);

function world({ overrides = 0 } = {}) {
  const L = createSyntheticL();
  const tiles = { '1000:2000:17': geometryTile(L, [{ id: 'a', rings: [sq(60, 60, 120, 120)] }]) };
  const cadastre = vectorGridLayer(L, { tiles, coords: { '1000:2000:17': { x: 1000, y: 2000, z: 17 } } });
  cadastre._overriddenStyles = Object.fromEntries(Array.from({ length: overrides }, (_, i) => [`k${i}`, {}]));
  const map = createSyntheticMap(L, [cadastre, maskLayer(L)], { container: createContainer(400, 250), pixelOrigin: { x: 256 * 1000 - 40, y: 256 * 2000 - 30 }, project: selectionProject });
  const global = { L, myMap: map, document: { querySelectorAll: () => [map._container] }, MonTerritoireVisibleCadastreGeometry: G };
  return { L, map, cadastre, inspector: createVisibleMapInspector(global) };
}
const poly = (w, id, x, extra = {}) => polygonLayer(w.L, { id, rings: [sq(x, 30, x + 40, 70)], idu: `${SECRET}-${id}`, ...extra });
const group = (w, id, children, extra = {}) => groupLayer(w.L, { id, children, ...extra });
const selection = w => { const result = w.inspector.visibleCadastre(); assert.equal(result.status, 'ready'); return result.selection; };
const ab = (w, mutate) => { w.inspector.selectionCapture('A'); mutate(); w.inspector.selectionCapture('B'); };

test('1. a GeoJSON group that appears between A and B is the selection (high confidence, no overrides needed)', () => {
  const w = world(); const geo = group(w, 300, [poly(w, 301, 20), poly(w, 302, 80)], { klass: 'GeoJSON', pane: 'polygone' });
  ab(w, () => attach(w.map, geo));
  const result = selection(w);
  assert.equal(result.status, 'ready'); assert.equal(result.features.length, 2);
  assert.deepEqual(result.source, { confidence: 'high', mechanism: 'ab-delta-new-group', evidence: ['ab-delta', 'group-absent-in-A', 'path-count-increased'], candidateGroups: 1, rejectedPolygons: 0 });
});

test('2. a group that already existed in A and was modified: only the polygons added since A are exported', () => {
  const w = world(); const old = poly(w, 310, 20); const geo = group(w, 311, [old], { klass: 'FeatureGroup' }); attach(w.map, geo);
  const added = poly(w, 312, 120); w.inspector.selectionCapture('A');
  geo._layers[312] = added; attach(w.map, added); w.inspector.selectionCapture('B');
  const result = selection(w);
  assert.equal(result.source.mechanism, 'ab-delta-group-modified'); assert.equal(result.source.confidence, 'high');
  assert.equal(result.features.length, 1); assert.equal(result.source.rejectedPolygons, 1);
  assert.deepEqual(result.source.evidence, ['ab-delta', 'group-existed-in-A', 'path-count-increased']);
});

test('3. a polygon without any proof of selection is rejected: no A/B, no style overrides', () => {
  const w = world(); attach(w.map, poly(w, 320, 20));
  const result = selection(w);
  assert.equal(result.status, 'none'); assert.deepEqual(result.features, []);
  assert.equal(result.source.mechanism, 'insufficient-evidence'); assert.equal(result.source.confidence, 'low'); assert.equal(result.source.rejectedPolygons, 1);
});

test('3b. pane "polygone" alone proves nothing (a future layer may use it); a group in it is rejected without corroboration', () => {
  const w = world(); attach(w.map, group(w, 330, [poly(w, 331, 20, { pane: 'polygone' })], { pane: 'polygone' }));
  const result = selection(w); assert.equal(result.status, 'none'); assert.equal(result.source.mechanism, 'insufficient-evidence'); assert.deepEqual(result.source.evidence, ['polygon-group-without-selection-context']);
});

test('4. a synthetic "urbanisme" polygon group is rejected, even next to the real selection when A/B names the selection', () => {
  const w = world({ overrides: 3 });
  const urbanisme = group(w, 340, [poly(w, 341, 200, { pane: 'urbanisme' })], { pane: 'urbanisme' }); attach(w.map, urbanisme);
  const geo = group(w, 342, [poly(w, 343, 20), poly(w, 344, 80)], { klass: 'GeoJSON', pane: 'polygone' });
  ab(w, () => attach(w.map, geo));
  const result = selection(w);
  assert.equal(result.features.length, 2); assert.equal(result.source.mechanism, 'ab-delta-new-group'); assert.equal(result.source.rejectedPolygons, 1);
  const alone = world({ overrides: 0 }); attach(alone.map, urbanisme.constructor === Object ? urbanisme : group(alone, 345, [poly(alone, 346, 200, { pane: 'urbanisme' })], { pane: 'urbanisme' }));
  assert.equal(selection(alone).status, 'none');
});

test('5. mask polygons are never selection candidates, alone or inside a group of the mask pane', () => {
  const w = world({ overrides: 3 }); const masked = polygonLayer(w.L, { id: 350, rings: [sq(0, 0, 90, 90)], pane: 'mask' });
  attach(w.map, group(w, 351, [masked], { pane: 'mask' }), masked);
  const result = selection(w); assert.equal(result.status, 'none'); assert.equal(result.source.mechanism, 'none'); assert.equal(result.source.rejectedPolygons, 0);
});

test('6. two competing polygon groups without A/B: nothing is exported arbitrarily', () => {
  const w = world({ overrides: 5 });
  attach(w.map, group(w, 360, [poly(w, 361, 20)]), group(w, 362, [poly(w, 363, 100)]));
  const result = selection(w);
  assert.equal(result.status, 'none'); assert.deepEqual(result.features, []); assert.equal(result.source.mechanism, 'ambiguous-candidates'); assert.equal(result.source.candidateGroups, 2);
  assert.deepEqual(w.inspector.visibleCadastre({ dryRun: true }).summary.selection, { state: 'ambiguous', count: 0 });
});

test('6b. two containers changed between A and B is ambiguous too', () => {
  const w = world({ overrides: 5 }); ab(w, () => attach(w.map, group(w, 365, [poly(w, 366, 20)]), group(w, 367, [poly(w, 368, 100)])));
  const result = selection(w); assert.equal(result.status, 'none'); assert.equal(result.source.mechanism, 'ambiguous-candidates'); assert.deepEqual(result.source.evidence, ['ab-delta', 'several-containers-changed']);
});

test('7. corroboration: a single group is medium with style overrides present, rejected without; an overrides increase between A and B is reported', () => {
  const w = world({ overrides: 0 }); const geo = group(w, 370, [poly(w, 371, 20)]); attach(w.map, geo);
  assert.equal(selection(w).status, 'none');
  w.cadastre._overriddenStyles = { a: {}, b: {} };
  const corroborated = selection(w); assert.equal(corroborated.source.confidence, 'medium'); assert.equal(corroborated.source.mechanism, 'vector-group+style-overrides'); assert.ok(corroborated.source.evidence.includes('vectorgrid-style-overrides-present'));
  const fresh = world({ overrides: 0 }); fresh.inspector.selectionCapture('A'); fresh.cadastre._overriddenStyles = { a: {} }; attach(fresh.map, group(fresh, 372, [poly(fresh, 373, 20)])); fresh.inspector.selectionCapture('B');
  assert.ok(selection(fresh).source.evidence.includes('vectorgrid-style-overrides-increased'));
});

test('7b. loose polygons: low confidence, only with overrides and a single pane; several panes are ambiguous', () => {
  const w = world({ overrides: 2 }); attach(w.map, poly(w, 380, 20), poly(w, 381, 100));
  const result = selection(w); assert.equal(result.source.mechanism, 'loose-polygons+style-overrides'); assert.equal(result.source.confidence, 'low'); assert.equal(result.features.length, 2);
  const mixed = world({ overrides: 2 }); attach(mixed.map, poly(mixed, 382, 20, { pane: 'a' }), poly(mixed, 383, 100, { pane: 'b' }));
  assert.equal(selection(mixed).source.mechanism, 'ambiguous-candidates');
});

test('8. no selection: the capture is cadastre-only and the product export stays a single Cadastre layer', () => {
  const w = world({ overrides: 0 }); w.inspector.selectionCapture('A'); w.inspector.selectionCapture('B');
  const capture = w.inspector.visibleCadastre(); assert.equal(capture.selection.status, 'none'); assert.equal(capture.selection.source.mechanism, 'none');
  const safe = globalThis.MonTerritoireVisibleCadastre.validateCapture(capture); assert.ok(safe);
  assert.deepEqual([...exportVisibleCadastre(safe).svg.matchAll(/inkscape:label="([^"]+)"/g)].map(m => m[1]), ['Cadastre']);
});

test('9. a validated selection becomes the second layer above the Cadastre', () => {
  const w = world(); ab(w, () => attach(w.map, group(w, 390, [poly(w, 391, 20)], { klass: 'GeoJSON' })));
  const safe = globalThis.MonTerritoireVisibleCadastre.validateCapture(w.inspector.visibleCadastre()); assert.ok(safe?.selection?.source);
  assert.deepEqual([...exportVisibleCadastre(safe).svg.matchAll(/inkscape:label="([^"]+)"/g)].map(m => m[1]), ['Cadastre', 'Parcelles sélectionnées']);
});

test('10. no identifier, property value or geographic value leaves the reader; the source only carries a closed vocabulary', () => {
  const w = world({ overrides: 2 }); ab(w, () => attach(w.map, group(w, 395, [poly(w, 396, 20, { featureId: SECRET })], { klass: 'GeoJSON' })));
  const capture = w.inspector.visibleCadastre(); const text = json(capture.selection);
  for (const forbidden of [SECRET, 'idu', 'insee', 'section', 'lat', 'lng', 'bounds', 'tile']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.deepEqual(Object.keys(capture.selection.source).sort(), ['candidateGroups', 'confidence', 'evidence', 'mechanism', 'rejectedPolygons']);
  assert.deepEqual(w.map.calls, [], 'no map mutator or geographic accessor was called');
  const tampered = { ...capture, selection: { ...capture.selection, source: { ...capture.selection.source, evidence: ['https://x.test/?a=1'] } } };
  assert.equal(globalThis.MonTerritoireVisibleCadastre.validateCapture(tampered), null, 'free text is not accepted in the evidence');
});

test('A/B captured at another zoom is ignored (the delta would be meaningless)', () => {
  const w = world({ overrides: 2 }); w.inspector.selectionCapture('A');
  attach(w.map, group(w, 398, [poly(w, 399, 20)])); w.map.getZoom = () => 16; w.inspector.selectionCapture('B'); w.map.getZoom = () => 17;
  const result = selection(w); assert.ok(result.source.evidence.includes('ab-viewport-changed') || result.source.mechanism !== 'ab-delta-new-group');
  assert.notEqual(result.source.mechanism, 'ab-delta-new-group');
});
