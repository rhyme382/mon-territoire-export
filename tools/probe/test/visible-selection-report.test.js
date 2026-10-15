import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisibleMapInspector } from '../visible-map-inspector.js';
import { vsrCompare, vsrCreateSession, vsrValidateCapture } from '../visible-selection-report.js';
import { SECRET, attach, createSyntheticL, createSyntheticMap, geometryTile, groupLayer, maskLayer, polygonLayer, rasterLayer, rendererLayer, selectionProject, vectorGridLayer, wmsLayer } from './fixtures/synthetic-leaflet.js';

const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const json = value => JSON.stringify(value);

// Layers shared by A and B: base raster, the cadastre WMS, the mask, the cadastre VectorGrid and an empty overlay group (what the page keeps around).
function world() {
  const L = createSyntheticL();
  const wms = wmsLayer(L, 291); const cadastre = vectorGridLayer(L, { id: 292, tiles: { '1:1:17': geometryTile(L, [{ id: 'a', rings: [sq(1, 1, 5, 5)] }]) } });
  const overlay = groupLayer(L, { id: 293 });
  const map = createSyntheticMap(L, [rasterLayer(L), wms, maskLayer(L), cadastre, overlay], { project: selectionProject });
  const global = { L, document: { querySelectorAll: () => [map._container] }, myMap: map };
  const inspector = createVisibleMapInspector(global);
  const snap = slot => { const capture = vsrValidateCapture({ ...inspector.selectionCapture(), slot }); assert.ok(capture, `capture ${slot} passes the closed schema`); return capture; };
  return { L, map, wms, cadastre, overlay, snap, inspector };
}
const parcels = (L, ids, base = 100) => ids.map((id, index) => polygonLayer(L, { id, rings: [sq(base + index * 10, 20, base + index * 10 + 8, 28)] }));

test('1. a single new Polygon on the map is a vector selection', () => {
  const w = world(); const a = w.snap('A');
  attach(w.map, ...parcels(w.L, [400]));
  const result = vsrCompare(a, w.snap('B'));
  assert.equal(result.conclusion.code, 'LEAFLET_VECTOR_SELECTION'); assert.equal(result.conclusion.exportable, true);
  assert.equal(result.geometryChanges.pathDelta, 1); assert.equal(result.geometryChanges.polygonDelta, 1); assert.equal(result.geometryChanges.parentlessDelta, 1);
  assert.deepEqual(result.likelySelectionLayer, { role: 'path', pane: 'selection', existedInA: false, change: 'paths-added', evidence: ['path-count-increased'] });
});

test('2. several new Polygons are counted in the geometry delta, per pane', () => {
  const w = world(); const a = w.snap('A');
  attach(w.map, ...parcels(w.L, [400, 401, 402]));
  const result = vsrCompare(a, w.snap('B'));
  assert.equal(result.geometryChanges.pathDelta, 3); assert.equal(result.geometryChanges.vertexDelta, 12); assert.equal(result.geometryChanges.ringDelta, 3);
  assert.deepEqual(result.geometryChanges.paneDelta, { selection: 3 });
  assert.equal(result.layersAdded.length, 0, 'path layers are aggregated, not listed one by one');
});

test('3. an existing FeatureGroup that receives children is detected as a changed group, not as a new layer id', () => {
  const w = world(); const feature = groupLayer(w.L, { id: 310, klass: 'FeatureGroup', pane: 'polygone' }); attach(w.map, feature);
  const a = w.snap('A');
  const children = parcels(w.L, [411, 412]); Object.assign(feature._layers, Object.fromEntries(children.map(child => [child._leaflet_id, child]))); attach(w.map, ...children);
  const result = vsrCompare(a, w.snap('B'));
  assert.equal(result.conclusion.code, 'LEAFLET_GROUP_SELECTION'); assert.equal(result.layersAdded.length, 0);
  assert.deepEqual(result.groupsChanged, [{ leafletId: 310, kind: 'geojson-vector', role: 'group', pane: 'polygone', childDelta: 2, pathDelta: 2, polygonDelta: 2, vertexDelta: 8 }]);
  assert.equal(result.likelySelectionLayer.leafletId, 310); assert.equal(result.likelySelectionLayer.existedInA, true);
  assert.ok(result.layersChanged.some(layer => layer.leafletId === 310 && layer.changes.includes('children') && layer.changes.includes('paths')));
});

test('4. an existing GeoJSON layer that is modified is detected', () => {
  const w = world(); const geo = groupLayer(w.L, { id: 311, klass: 'GeoJSON', children: parcels(w.L, [420]) }); attach(w.map, geo);
  const a = w.snap('A');
  const more = parcels(w.L, [421, 422], 200); Object.assign(geo._layers, Object.fromEntries(more.map(child => [child._leaflet_id, child]))); attach(w.map, ...more);
  const result = vsrCompare(a, w.snap('B'));
  assert.equal(result.conclusion.code, 'LEAFLET_GROUP_SELECTION'); assert.equal(result.groupsChanged[0].pathDelta, 2);
});

test('5. the page overlay LayerGroup (present in A, empty) that fills up in B is the likely selection layer', () => {
  const w = world(); const a = w.snap('A');
  const children = parcels(w.L, [430, 431, 432]); Object.assign(w.overlay._layers, Object.fromEntries(children.map(child => [child._leaflet_id, child]))); attach(w.map, ...children);
  const result = vsrCompare(a, w.snap('B'));
  assert.equal(result.conclusion.code, 'LEAFLET_GROUP_SELECTION');
  assert.equal(result.likelySelectionLayer.leafletId, 293); assert.equal(result.likelySelectionLayer.role, 'group'); assert.equal(result.likelySelectionLayer.pane, 'overlayPane');
});

test('6. an unchanged WMS layer is not a selection', () => {
  const w = world(); const a = w.snap('A'); const result = vsrCompare(a, w.snap('B'));
  assert.equal(result.wmsChanges.paramsChanged, 0); assert.equal(result.wmsChanges.unchanged, 1);
  assert.equal(result.conclusion.code, 'NO_SELECTION_LAYER_FOUND'); assert.equal(result.conclusion.exportable, false);
});

test('7. modified WMS params are detected without ever reporting their values', () => {
  const w = world(); const a = w.snap('A');
  w.wms.wmsParams = { layers: 'zones', cql_filter: `idu IN ('${SECRET}')` };
  const result = vsrCompare(a, w.snap('B'));
  assert.equal(result.conclusion.code, 'WMS_SELECTION'); assert.equal(result.conclusion.exportable, false);
  assert.equal(result.wmsChanges.paramsChanged, 1); assert.equal(result.likelySelectionLayer.leafletId, 291); assert.equal(result.likelySelectionLayer.change, 'params-changed');
  assert.equal(json(result).includes(SECRET), false); assert.equal(json(result).includes('cql'), false);
});

test('8. a renderer added between A and B is a renderer selection when nothing else moved', () => {
  const w = world(); const a = w.snap('A'); attach(w.map, rendererLayer(w.L, { id: 500 }));
  const result = vsrCompare(a, w.snap('B'));
  assert.equal(result.conclusion.code, 'RENDERER_SELECTION'); assert.equal(result.rendererChanges.layersAdded, 1); assert.deepEqual(result.rendererChanges.familyDelta, { Canvas: 1 });
});

test('8b. DOM-only changes are reported as a DOM selection', () => {
  const w = world(); const counts = { svg: 0, path: 0 };
  w.map._container.querySelectorAll = selector => (selector === 'svg path' ? new Array(counts.path) : selector === 'svg' ? new Array(counts.svg) : []);
  const a = w.snap('A'); counts.path = 5; counts.svg = 1;
  const result = vsrCompare(a, w.snap('B'));
  assert.equal(result.conclusion.code, 'DOM_SELECTION'); assert.equal(result.domChanges.svgPathDelta, 5);
});

test('9. no change at all gives NO_SELECTION_LAYER_FOUND', () => {
  const w = world(); const result = vsrCompare(w.snap('A'), w.snap('B'));
  assert.equal(result.conclusion.code, 'NO_SELECTION_LAYER_FOUND'); assert.equal(result.likelySelectionLayer, null);
  assert.deepEqual(result.layersAdded, []); assert.deepEqual(result.layersChanged, []);
});

test('10-12. classification priority: a vector delta wins over a WMS/renderer delta; WMS wins over renderer', () => {
  const w = world(); const a = w.snap('A');
  w.wms.wmsParams = { layers: 'zones', other: '1' }; attach(w.map, rendererLayer(w.L, { id: 500 }));
  assert.equal(vsrCompare(a, w.snap('B')).conclusion.code, 'WMS_SELECTION');
  attach(w.map, ...parcels(w.L, [440]));
  const result = vsrCompare(a, w.snap('B'));
  assert.equal(result.conclusion.code, 'LEAFLET_VECTOR_SELECTION'); assert.equal(result.wmsChanges.paramsChanged, 1, 'the WMS delta is still reported');
});

test('a viewport that moved or a missing capture is INSUFFICIENT_EVIDENCE', () => {
  const w = world(); const a = w.snap('A'); w.map.getZoom = () => 18;
  const moved = vsrCompare(a, w.snap('B'));
  assert.equal(moved.conclusion.code, 'INSUFFICIENT_EVIDENCE'); assert.deepEqual(moved.conclusion.evidence, ['viewport-changed-between-captures']);
  const missing = vsrCompare(a, null); assert.equal(missing.available, false); assert.equal(missing.conclusion.code, 'INSUFFICIENT_EVIDENCE');
});

test('a selection with many more polygons than the layer cap is still aggregated (no truncation of the path counters)', () => {
  const w = world(); const a = w.snap('A'); attach(w.map, ...parcels(w.L, Array.from({ length: 500 }, (_, i) => 1000 + i)));
  const b = w.snap('B'); assert.equal(b.paths.count, 500); assert.equal(b.layersTruncated, false); assert.ok(b.layers.length <= 200);
  assert.equal(vsrCompare(a, b).geometryChanges.pathDelta, 500);
});

test('the session keeps captures in memory, validates them and reports only counters', () => {
  const w = world(); const session = vsrCreateSession();
  assert.equal(session.record('A', w.inspector.selectionCapture()), true);
  w.wms.wmsParams = { layers: 'x', cql: SECRET }; attach(w.map, ...parcels(w.L, [450]));
  assert.equal(session.record('B', w.inspector.selectionCapture()), true);
  assert.equal(session.record('C', w.inspector.selectionCapture()), false); assert.equal(session.record('A', { forged: true }), false);
  session.compare(); assert.equal(session.conclusionCode(), 'LEAFLET_VECTOR_SELECTION');
  session.recordExport({ selectedFeaturesDetected: 3, selectedFeaturesVisible: 2, selectedPathsExported: 2, selectedFeaturesClipped: 1 });
  const report = session.report();
  assert.deepEqual(report.lastExport, { selectedFeaturesDetected: 3, selectedFeaturesVisible: 2, selectedPathsExported: 2, selectedFeaturesClipped: 1 });
  assert.deepEqual(Object.keys(report.selectionComparison).sort(), ['available', 'conclusion', 'domChanges', 'geometryChanges', 'groupsChanged', 'layersAdded', 'layersChanged', 'layersRemoved', 'likelySelectionLayer', 'rendererChanges', 'sameViewport', 'wmsChanges']);
  const text = json(report); for (const forbidden of [SECRET, 'idu', 'insee', 'cql', 'styleSig', 'paramsSig', 'bounds', 'tile']) assert.equal(text.includes(forbidden), false, forbidden);
});

test('the closed schema rejects unknown keys, bad hashes and oversized inputs', () => {
  const w = world(); const good = w.inspector.selectionCapture();
  assert.ok(vsrValidateCapture({ ...good, slot: 'A' }));
  assert.equal(vsrValidateCapture({ ...good, extra: SECRET }), null);
  assert.equal(vsrValidateCapture({ ...good, layers: [{ ...good.layers[0], idu: SECRET }] }), null);
  assert.equal(vsrValidateCapture({ ...good, layers: [{ ...good.layers[0], styleSig: -1 }] }), null);
  assert.equal(vsrValidateCapture({ ...good, paths: { ...good.paths, byPane: { 'bad pane': 1 } } }), null);
  assert.equal(vsrValidateCapture({ ...good, layers: new Array(201).fill(good.layers[0]) }), null);
});

test('capturing never calls a map mutator or a geographic accessor', () => {
  const w = world(); attach(w.map, ...parcels(w.L, [460])); w.snap('A'); w.inspector.visibleCadastre(); assert.deepEqual(w.map.calls, []);
});
