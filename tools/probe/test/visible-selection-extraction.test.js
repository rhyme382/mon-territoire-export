import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisibleMapInspector } from '../visible-map-inspector.js';
import { SECRET, attach, createContainer, createSyntheticL, createSyntheticMap, geometryTile, groupLayer, maskLayer, polygonLayer, selectionProject, vectorGridLayer } from './fixtures/synthetic-leaflet.js';

// The extraction code is a MAIN-world classic script that reaches the geometry helpers through a global.
globalThis.window = globalThis;
const G = await import('../visible-cadastre-geometry.js');
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const PANE = { x: 10, y: 5 }; // layer point -> container point offset
const json = value => JSON.stringify(value);

function world({ selection = [], project = selectionProject, overrides = true } = {}) {
  const L = createSyntheticL();
  const tiles = { '1000:2000:17': geometryTile(L, [{ id: 'a', rings: [sq(60, 60, 120, 120)] }]) };
  const cadastre = vectorGridLayer(L, { tiles, coords: { '1000:2000:17': { x: 1000, y: 2000, z: 17 } } });
  if (overrides) cadastre._overriddenStyles = { a: {}, b: {} }; // VectorGrid re-styled the selected parcels: the corroboration the hardened identification requires
  const map = createSyntheticMap(L, [cadastre, maskLayer(L)], { container: createContainer(400, 250), pixelOrigin: { x: 256 * 1000 - 40, y: 256 * 2000 - 30 }, panePos: PANE, project });
  attach(map, ...selection);
  const global = { L, myMap: map, document: { querySelectorAll: () => [map._container] }, MonTerritoireVisibleCadastreGeometry: G };
  return { L, map, inspector: createVisibleMapInspector(global) };
}
const extract = (w) => { const result = w.inspector.visibleCadastre(); assert.equal(result.status, 'ready'); return result.selection; };
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.011, `${actual} ≈ ${expected}`);

test('13. a Polygon becomes one feature in viewport pixels (layer point + pane offset)', () => {
  const w = world(); attach(w.map, polygonLayer(w.L, { id: 400, rings: [sq(50, 50, 100, 100)] }));
  const selection = extract(w);
  assert.equal(selection.status, 'ready'); assert.equal(selection.features.length, 1);
  assert.deepEqual(selection.features[0].rings[0].map(([x, y]) => [x, y]), sq(60, 55, 110, 105));
  assert.deepEqual(selection.counts, { candidatePolygons: 1, selectedFeaturesDetected: 1, selectedFeaturesVisible: 1, selectedPathsExported: 1, selectedFeaturesClipped: 0, duplicatesHandled: 0, keyTiers: { id: 0, property: 0, geometry: 1 } });
  assert.deepEqual(selection.diagnostics, { projectionMethods: { 'leaflet-rings': 1 }, paneCounts: { selection: 1 } });
});

test('14. a MultiPolygon layer keeps all its polygons inside one feature', () => {
  const w = world(); const rings = [sq(10, 10, 40, 40), sq(100, 100, 140, 140)];
  const multi = polygonLayer(w.L, { id: 401, rings, latlngs: [[rings[0].map(([x, y]) => ({ lat: y, lng: x }))], [rings[1].map(([x, y]) => ({ lat: y, lng: x }))]] }); attach(w.map, multi);
  const selection = extract(w);
  assert.equal(selection.features.length, 1); assert.equal(selection.features[0].rings.length, 2); assert.equal(selection.counts.selectedPathsExported, 1);
});

test('15. holes are kept as extra rings of the same feature (evenodd)', () => {
  const w = world(); attach(w.map, polygonLayer(w.L, { id: 402, rings: [sq(20, 20, 120, 120), sq(50, 50, 80, 80)] }));
  const [feature] = extract(w).features; assert.equal(feature.rings.length, 2);
  approx(Math.abs(G.vcgSignedArea(feature.rings[1])), 900);
});

test('16. projection: verified Leaflet rings are preferred; stale rings fall back to the public projection; parts are the last resort', () => {
  const rings = [sq(50, 50, 100, 100)];
  let selection = extract(world({ selection: [polygonLayer(createSyntheticL(), { id: 1, rings })] }));
  const fresh = world(); const stale = polygonLayer(fresh.L, { id: 410, rings, staleRings: [sq(300, 300, 340, 340)] }); attach(fresh.map, stale);
  selection = extract(fresh);
  assert.deepEqual(selection.diagnostics.projectionMethods, { 'latlngs-projected': 1 });
  assert.deepEqual(selection.features[0].rings[0], sq(60, 55, 110, 105), 'the stale rings are ignored');
  const noRings = world(); attach(noRings.map, polygonLayer(noRings.L, { id: 411, rings, projected: false }));
  assert.deepEqual(extract(noRings).diagnostics.projectionMethods, { 'latlngs-projected': 1 });
  const partsOnly = world(); const layer = polygonLayer(partsOnly.L, { id: 412, rings, projected: false, parts: true }); layer._latlngs = undefined; attach(partsOnly.map, layer);
  assert.deepEqual(extract(partsOnly).diagnostics.projectionMethods, { 'leaflet-parts': 1 });
});

test('17. a parcel crossing the viewport edge is cut exactly at the edge', () => {
  const w = world(); attach(w.map, polygonLayer(w.L, { id: 420, rings: [sq(350, 100, 450, 150)] })); // container x = 360..460, viewport is 400 wide
  const selection = extract(w); const xs = selection.features[0].rings[0].map(p => p[0]);
  assert.equal(Math.max(...xs), 400); assert.equal(Math.min(...xs), 360); assert.equal(selection.counts.selectedFeaturesClipped, 1);
  for (const [x, y] of selection.features[0].rings[0]) assert.ok(x >= 0 && x <= 400 && y >= 0 && y <= 250);
});

test('18. a selection entirely outside the viewport is detected but not exported', () => {
  const w = world(); attach(w.map, polygonLayer(w.L, { id: 430, rings: [sq(900, 900, 950, 950)] }));
  const selection = extract(w);
  assert.equal(selection.status, 'ready'); assert.deepEqual(selection.features, []);
  assert.equal(selection.counts.selectedFeaturesDetected, 1); assert.equal(selection.counts.selectedFeaturesVisible, 0); assert.equal(selection.counts.selectedPathsExported, 0);
});

test('19. partially visible parcels are clipped, fully visible ones are not', () => {
  const w = world(); attach(w.map, polygonLayer(w.L, { id: 440, rings: [sq(-30, 20, 40, 60)] }), polygonLayer(w.L, { id: 441, rings: [sq(100, 100, 140, 140)] }));
  const selection = extract(w);
  assert.equal(selection.counts.selectedFeaturesVisible, 2); assert.equal(selection.counts.selectedFeaturesClipped, 1);
  assert.ok(selection.features.some(feature => Math.min(...feature.rings[0].map(p => p[0])) === 0));
});

test('20. duplicates: same object held twice is dropped; complementary fragments of one parcel are both kept', () => {
  const w = world();
  const first = polygonLayer(w.L, { id: 450, rings: [sq(20, 20, 60, 60)], idu: 'ONE' }); const copy = polygonLayer(w.L, { id: 451, rings: [sq(20, 20, 60, 60)], idu: 'ONE' });
  const left = polygonLayer(w.L, { id: 452, rings: [sq(100, 20, 140, 60)], idu: 'TWO' }); const right = polygonLayer(w.L, { id: 453, rings: [sq(140, 20, 180, 60)], idu: 'TWO' });
  const loose = polygonLayer(w.L, { id: 454, rings: [sq(200, 20, 240, 60)] }); const looseCopy = polygonLayer(w.L, { id: 455, rings: [sq(200, 20, 240, 60)] });
  for (const layer of [loose, looseCopy]) delete layer.feature;
  attach(w.map, first, copy, left, right, loose, looseCopy);
  const selection = extract(w);
  assert.equal(selection.counts.candidatePolygons, 6); assert.equal(selection.counts.selectedFeaturesDetected, 3); assert.equal(selection.counts.duplicatesHandled, 2);
  assert.deepEqual(selection.features.map(feature => feature.rings.length).sort(), [1, 1, 2], 'TWO keeps both fragments');
  assert.deepEqual(selection.counts.keyTiers, { id: 0, property: 2, geometry: 1 });
  assert.equal(json(selection).includes('ONE'), false); assert.equal(json(selection).includes('TWO'), false);
});

test('a feature id is used for de-duplication when present and never leaves the page reader', () => {
  const w = world(); attach(w.map, polygonLayer(w.L, { id: 460, rings: [sq(20, 20, 60, 60)], featureId: 'ID-A' }), polygonLayer(w.L, { id: 461, rings: [sq(20, 20, 60, 60)], featureId: 'ID-A' }));
  const selection = extract(w); assert.equal(selection.counts.keyTiers.id, 1); assert.equal(selection.counts.duplicatesHandled, 1); assert.equal(json(selection).includes('ID-A'), false);
});

test('polygons of the mask pane and cadastre tile paths are never selected', () => {
  const w = world(); const result = extract(w);
  assert.equal(result.status, 'none'); assert.deepEqual(result.features, []); assert.equal(result.counts.candidatePolygons, 0);
});

test('a selection inside a group that was filled after the page loaded is extracted like any other polygon', () => {
  const w = world(); const children = [polygonLayer(w.L, { id: 470, rings: [sq(30, 30, 70, 70)] }), polygonLayer(w.L, { id: 471, rings: [sq(80, 30, 120, 70)] })];
  attach(w.map, groupLayer(w.L, { id: 293, children }));
  assert.equal(extract(w).counts.selectedPathsExported, 2);
});

test('nothing sensitive is returned: no id, property value, geographic coordinate or bounds', () => {
  const w = world(); attach(w.map, polygonLayer(w.L, { id: 480, rings: [sq(20, 20, 60, 60)], featureId: SECRET }));
  const text = json(extract(w));
  for (const forbidden of [SECRET, 'idu', 'insee', 'section', 'lat', 'lng', 'bounds', 'tile']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.deepEqual(w.map.calls, [], 'no map mutator or geographic accessor was called');
});

test('without a cadastre the availability answer is unchanged and selection is not exposed', () => {
  const w = world();
  const L = createSyntheticL(); const map = createSyntheticMap(L, [], { project: selectionProject }); attach(map, polygonLayer(L, { id: 1, rings: [sq(1, 1, 5, 5)] }));
  const inspector = createVisibleMapInspector({ L, myMap: map, document: { querySelectorAll: () => [map._container] }, MonTerritoireVisibleCadastreGeometry: G });
  assert.deepEqual(inspector.visibleCadastre(), { type: 'visible-cadastre', status: 'no-cadastre' });
  assert.equal(w.inspector.visibleCadastre({ dryRun: true }).status, 'ready');
});
