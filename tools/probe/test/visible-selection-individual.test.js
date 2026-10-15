import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisibleMapInspector } from '../visible-map-inspector.js';
import { exportVisibleCadastre } from '../../gpkg-svg/browser/api.js';
import { SECRET, attach, createContainer, createSyntheticL, createSyntheticMap, geometryTile, groupLayer, maskLayer, polygonLayer, selectionProject, vectorGridLayer } from './fixtures/synthetic-leaflet.js';

// MVP-05A: each selected parcel becomes its own object. Everything is synthetic: ids and cadastral values are placeholders.
globalThis.window = globalThis;
const G = await import('../visible-cadastre-geometry.js');
await import('../visible-cadastre-export.js');
const V = () => globalThis.MonTerritoireVisibleCadastre;
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const shift = (ring, dx, dy) => ring.map(([x, y]) => [x + dx, y + dy]);
const NOW = new Date('2026-01-02T03:04:05Z');
const SELECTED = { color: '#0057b8', fillColor: '#00b4d8', weight: 2 };
const HOVER = { color: '#ffaa00', weight: 4 };
const OX = 40; const OY = 30; // viewport position of tile 1000:2000
const json = value => JSON.stringify(value);
// Tile-local parcels (viewport = local + (40, 30)). `p` = viewport rings used for the aggregate selection polygon.
const P = {
  one: sq(10, 10, 50, 50), two: sq(60, 10, 100, 50), neighbour: sq(10, 60, 50, 100),
};
const holeRing = sq(130, 30, 150, 50);
const view = rings => shift(rings, OX, OY);

function world({ features, extraTiles = {}, overrides, aggregate, aggregatePane = 'polygone', width = 400, originX = OX } = {}) {
  const L = createSyntheticL();
  const tiles = { '1000:2000:17': geometryTile(L, features), ...Object.fromEntries(Object.entries(extraTiles).map(([key, list]) => [key, geometryTile(L, list)])) };
  const coords = { '1000:2000:17': { x: 1000, y: 2000, z: 17 }, '1001:2000:17': { x: 1001, y: 2000, z: 17 } };
  const cadastre = vectorGridLayer(L, { tiles, coords });
  cadastre._overriddenStyles = overrides;
  const map = createSyntheticMap(L, [cadastre, maskLayer(L)], { container: createContainer(width, 250), pixelOrigin: { x: 256 * 1000 - originX, y: 256 * 2000 - OY }, project: selectionProject });
  if (aggregate) attach(map, groupLayer(L, { id: 300, children: [polygonLayer(L, { id: 301, rings: aggregate, idu: `${SECRET}-agg` })], klass: 'GeoJSON', pane: aggregatePane }));
  const global = { L, myMap: map, document: { querySelectorAll: () => [map._container] }, MonTerritoireVisibleCadastreGeometry: G };
  return { L, map, cadastre, inspector: createVisibleMapInspector(global) };
}
const feat = (id, rings, extra = {}) => ({ id: `${SECRET}-${id}`, rings, ...extra });
const key = id => `${SECRET}-${id}`;
const ovr = (ids, style = SELECTED) => Object.fromEntries(ids.map(id => [key(id), style]));
const capture = w => { const result = w.inspector.visibleCadastre(); assert.equal(result.status, 'ready'); return result; };
const area = ring => Math.abs(G.vcgSignedArea(ring));
const base = () => [feat('one', [P.one]), feat('two', [P.two]), feat('neighbour', [P.neighbour])];

test('1. one selected feature becomes one independent object and the aggregate only acts as proof', () => {
  const w = world({ features: base(), overrides: ovr(['one']), aggregate: [view(P.one)] });
  const { selection } = capture(w);
  assert.equal(selection.features.length, 1); assert.deepEqual(selection.features[0].rings[0], view(P.one));
  assert.equal(selection.perFeature.source, 'vectorgrid-overrides'); assert.equal(selection.perFeature.confidence, 'high');
  assert.equal(selection.perFeature.exportedObjects, 1); assert.equal(selection.perFeature.fallbackReason, 'none');
});

test('2. several features: one object each, deterministic order, aggregate rings are not what is exported', () => {
  const w = world({ features: base(), overrides: ovr(['two', 'one']), aggregate: [view(P.one), view(P.two)] });
  const { selection } = capture(w);
  assert.equal(selection.features.length, 2);
  assert.deepEqual(selection.features.map(f => f.rings[0]), [view(P.one), view(P.two)]);
  assert.equal(selection.counts.selectedPathsExported, 2); assert.equal(selection.perFeature.uniqueGeometries, 2);
});

test('3. 52 overrides: only the ones that match cadastre features count; the rest is reported as unmatched, never as a parcel', () => {
  const overrides = { ...ovr(['one', 'two']), ...Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`${SECRET}-x${i}`, SELECTED])) };
  const w = world({ features: base(), overrides, aggregate: [view(P.one), view(P.two)] });
  const { selection } = capture(w); const info = selection.perFeature;
  assert.equal(info.overrideCount, 52); assert.equal(info.matchedFeatures, 2); assert.equal(info.unmatchedFeatures, 50); assert.equal(info.exportedObjects, 2);
  assert.equal(selection.features.length, 2);
});

test('4. a parcel across two tiles is merged into one object; the buffer of the neighbour tile is not counted twice', () => {
  const across = sq(250, 40, 340, 80); // viewport; seam at x = 296
  const w = world({ features: [feat('across', [shift(across, -OX, -OY)])], extraTiles: { '1001:2000:17': [feat('across', [shift(across, -296, -OY)])] }, overrides: ovr(['across']), aggregate: [across] });
  const { selection, features } = capture(w);
  assert.equal(selection.features.length, 1); assert.equal(selection.features[0].rings.length, 1);
  assert.ok(Math.abs(area(selection.features[0].rings[0]) - 90 * 40) < 0.5, 'merged outline covers the whole parcel exactly once');
  assert.ok(features.length >= 1);
});

test('5. a polygon with a hole keeps the hole, and a probe in the hole does not reject it', () => {
  const holed = [view(sq(110, 10, 170, 70)), view(holeRing)];
  const w = world({ features: [feat('holed', [sq(110, 10, 170, 70), holeRing])], overrides: ovr(['holed']), aggregate: holed });
  const { selection } = capture(w);
  assert.equal(selection.perFeature.source, 'vectorgrid-overrides'); assert.equal(selection.features[0].rings.length, 2);
  assert.ok(Math.abs(area(selection.features[0].rings[1]) - 400) < 0.5);
});

test('6. a selection partly outside the viewport is clipped to it and counted as clipped', () => {
  const edge = sq(310, 40, 410, 80);
  const w = world({ features: [feat('edge', [sq(10, 10, 110, 50)])], overrides: ovr(['edge']), aggregate: [edge], originX: 300 });
  const { selection } = capture(w);
  assert.equal(selection.features.length, 1); assert.equal(selection.counts.selectedFeaturesClipped, 1);
  assert.ok(selection.features[0].rings[0].every(([x]) => x <= 400));
});

test('7. a hover override on a parcel outside the selection is excluded, not exported', () => {
  const overrides = { ...ovr(['one', 'two']), ...ovr(['neighbour'], HOVER) };
  const w = world({ features: base(), overrides, aggregate: [view(P.one), view(P.two)] });
  const { selection } = capture(w); const info = selection.perFeature;
  assert.equal(selection.features.length, 2); assert.equal(info.matchedFeatures, 3); assert.equal(info.confidence, 'medium');
  assert.ok(info.evidence.includes('overrides-outside-selection-excluded'));
});

test('8. an override that names a non-cadastral feature is unmatched and never exported', () => {
  const features = [...base(), feat('road', [sq(120, 80, 160, 120)], { layerName: 'routes' })];
  const w = world({ features, overrides: { ...ovr(['one']), ...ovr(['road'], HOVER) }, aggregate: [view(P.one)] });
  const { selection } = capture(w);
  assert.equal(selection.features.length, 1); assert.equal(selection.perFeature.unmatchedFeatures, 1); assert.equal(selection.perFeature.source, 'vectorgrid-overrides');
});

test('9. an id that is a parcel in one tile and a non-parcel feature in another is ambiguous: aggregate fallback', () => {
  const w = world({ features: base(), extraTiles: { '1001:2000:17': [feat('one', [sq(10, 10, 40, 40)], { layerName: 'routes' })] }, overrides: ovr(['one']), aggregate: [view(P.one)] });
  const { selection } = capture(w);
  assert.equal(selection.perFeature.fallbackReason, 'id-layer-collision'); assert.equal(selection.perFeature.source, 'aggregate-geojson');
});

test('10. no override at all: the aggregate polygon cannot be identified either, so nothing is exported and the reason says why', () => {
  const w = world({ features: base(), overrides: {}, aggregate: [view(P.one), view(P.two)] });
  const result = w.inspector.visibleCadastre();
  assert.equal(result.selection.status, 'none'); assert.equal(result.selection.perFeature.fallbackReason, 'no-overrides'); assert.equal(result.selection.perFeature.source, 'none');
});

test('11. overrides that disagree with the selection geometry fall back to the aggregate polygon, with a reason', () => {
  const w = world({ features: base(), overrides: ovr(['neighbour']), aggregate: [view(P.one), view(P.two)] });
  const { selection } = capture(w);
  assert.equal(selection.perFeature.source, 'aggregate-geojson'); assert.equal(selection.perFeature.fallbackReason, 'geometry-disagreement');
  assert.equal(selection.features.length, 1, 'the aggregate is one object'); assert.equal(selection.features[0].rings.length, 2);
});

test('12. an incomplete match (a selected parcel has no override) falls back instead of silently dropping it', () => {
  const w = world({ features: base(), overrides: ovr(['one']), aggregate: [view(P.one), view(P.two)] });
  const { selection } = capture(w);
  assert.equal(selection.perFeature.fallbackReason, 'incomplete-coverage'); assert.equal(selection.perFeature.source, 'aggregate-geojson');
  assert.ok(selection.perFeature.coverage < 0.95);
});

test('13. two override styles inside the selection are ambiguous: aggregate fallback', () => {
  const w = world({ features: base(), overrides: { ...ovr(['one']), ...ovr(['two'], HOVER) }, aggregate: [view(P.one), view(P.two)] });
  const { selection } = capture(w);
  assert.equal(selection.perFeature.fallbackReason, 'ambiguous-style-groups'); assert.equal(selection.perFeature.styleGroups, 2); assert.equal(selection.perFeature.source, 'aggregate-geojson');
});

test('14. no selection: overrides without any proof export nothing', () => {
  const w = world({ features: base(), overrides: ovr(['one', 'two']) });
  const { selection } = capture(w);
  assert.equal(selection.status, 'none'); assert.deepEqual(selection.features, []);
  assert.equal(selection.perFeature.fallbackReason, 'no-selection-evidence'); assert.equal(selection.perFeature.source, 'none');
});

test('15. an A capture removes pre-existing overrides; keys new since A are the candidates (no aggregate needed)', () => {
  const w = world({ features: base(), overrides: ovr(['neighbour'], HOVER) });
  w.inspector.selectionCapture('A');
  Object.assign(w.cadastre._overriddenStyles, ovr(['one', 'two']));
  const { selection } = capture(w); const info = selection.perFeature;
  assert.equal(info.basis, 'ab-delta'); assert.equal(info.overrideCount, 3); assert.equal(info.matchedFeatures, 2);
  assert.equal(selection.features.length, 2); assert.equal(info.confidence, 'medium'); assert.ok(info.evidence.includes('no-aggregate-geometry'));
});

test('16. alignment: an individual object has exactly the rings of the same feature in the Cadastre layer', () => {
  const w = world({ features: base(), overrides: ovr(['one', 'two']), aggregate: [view(P.one), view(P.two)] });
  const result = capture(w);
  for (const feature of result.selection.features) assert.ok(result.features.some(candidate => json(candidate.rings) === json(feature.rings)), 'same transform, same clipping');
});

test('17. SVG: one independent path per feature in the Parcelles sélectionnées layer; the Cadastre layer is untouched', () => {
  const w = world({ features: base(), overrides: ovr(['one', 'two']), aggregate: [view(P.one), view(P.two)] });
  const fact = capture(w); const validated = V().validateCapture(fact); assert.ok(validated);
  const svg = exportVisibleCadastre(validated, { now: NOW }).svg;
  const layer = svg.slice(svg.indexOf('id="layer-selected-parcels"'));
  assert.deepEqual([...layer.matchAll(/<path id="(selection-\d+)"/g)].map(match => match[1]), ['selection-1', 'selection-2']);
  assert.equal([...svg.matchAll(/<path id="cadastre-visible-/g)].length, fact.features.length);
  assert.ok(svg.includes('selectedFeatureCount="2"'));
});

test('18. no cadastral value, key or coordinate besides viewport pixels leaves the reader, the diagnostic or the SVG', () => {
  const w = world({ features: base(), overrides: ovr(['one', 'two']), aggregate: [view(P.one), view(P.two)] });
  const fact = capture(w); const validated = V().validateCapture(fact);
  const svg = exportVisibleCadastre(validated, { now: NOW }).svg; const text = V().diagnosticText(validated);
  for (const output of [json(fact.selection.perFeature), json(validated.selection.perFeature), svg, text]) for (const forbidden of [SECRET, 'idu', 'insee', 'section']) assert.equal(output.includes(forbidden), false, forbidden);
  assert.deepEqual(Object.keys(fact.selection.perFeature).sort(), ['basis', 'confidence', 'coverage', 'evidence', 'exportedObjects', 'fallbackReason', 'matchedFeatures', 'overrideCount', 'source', 'styleGroups', 'uniqueGeometries', 'unmatchedFeatures']);
});

test('19. Diagnostic lists SÉLECTION INDIVIDUELLE with every counter and the fallback reason', () => {
  const w = world({ features: base(), overrides: { ...ovr(['one', 'two']), [`${SECRET}-x`]: SELECTED }, aggregate: [view(P.one), view(P.two)] });
  const text = V().diagnosticText(V().validateCapture(capture(w)));
  for (const line of ['SÉLECTION INDIVIDUELLE', 'source: vectorgrid-overrides', 'confidence: high', 'override count: 3', 'matched features: 2', 'unique geometries: 2', 'exported objects: 2', 'unmatched features: 1', 'fallback reason: none']) assert.ok(text.includes(line), line);
  const fallback = V().diagnosticText(V().validateCapture(capture(world({ features: base(), overrides: ovr(['neighbour']), aggregate: [view(P.one)] }))));
  assert.ok(fallback.includes('source: aggregate-geojson') && fallback.includes('fallback reason: geometry-disagreement'));
});

test('20. the validator keeps a closed schema for the new block', () => {
  const w = world({ features: base(), overrides: ovr(['one']), aggregate: [view(P.one)] });
  const fact = capture(w); const tampered = (patch) => V().validateCapture({ ...fact, selection: { ...fact.selection, perFeature: { ...fact.selection.perFeature, ...patch } } });
  assert.ok(tampered({}));
  assert.equal(tampered({ fallbackReason: 'because-i-say-so' }), null); assert.equal(tampered({ extra: 1 }), null); assert.equal(tampered({ source: SECRET }), null); assert.equal(tampered({ evidence: [`${SECRET} !`] }), null);
  assert.ok(V().validateCapture({ ...fact, selection: { ...fact.selection, perFeature: undefined } } && (() => { const { perFeature: _drop, ...rest } = fact.selection; return { ...fact, selection: rest }; })()), 'older readers send none');
});

test('21. the inspection stays read-only and the dry run announces the same number of parcels', () => {
  const w = world({ features: base(), overrides: ovr(['one', 'two']), aggregate: [view(P.one), view(P.two)] });
  const dry = w.inspector.visibleCadastre({ dryRun: true });
  assert.deepEqual(dry.summary.selection, { state: 'ready', count: 2 });
  capture(w); assert.deepEqual(w.map.calls, []);
});

test('22. realistic mismatch: small parcels, aggregate shifted by 0.7 px and a sliver fragment in the next tile still match', () => {
  const small = [sq(100, 40, 120, 60), sq(130, 40, 150, 60), sq(286, 100, 306, 120)]; // viewport; the third one crosses the tile seam at x = 296
  const local = small.map(ring => shift(ring, -OX, -OY));
  const features = [feat('s1', [local[0]]), feat('s2', [local[1]]), feat('s3', [local[2]]), feat('n', [P.neighbour])];
  const sliver = sq(-0.2, 70, 0.1, 80); // 0.3 x 10 px strip of s3 kept by the neighbour tile's buffer: under the fragment-area floor
  const w = world({ features, extraTiles: { '1001:2000:17': [feat('s3', [sliver])] }, overrides: ovr(['s1', 's2', 's3']), aggregate: small.map(ring => shift(ring, 0.7, 0.7)) });
  const { selection } = capture(w);
  assert.equal(selection.perFeature.source, 'vectorgrid-overrides', selection.perFeature.fallbackReason);
  assert.equal(selection.perFeature.exportedObjects, 3); assert.ok(selection.perFeature.coverage >= 0.95);
});

test('23. the tolerance does not let a neighbour in: a hovered adjacent small parcel stays excluded', () => {
  const small = [sq(100, 40, 120, 60), sq(122, 40, 142, 60)]; // 2 px apart
  const w = world({ features: [feat('s1', [shift(small[0], -OX, -OY)]), feat('s2', [shift(small[1], -OX, -OY)])], overrides: { ...ovr(['s1']), ...ovr(['s2'], HOVER) }, aggregate: [shift(small[0], 0.7, 0.7)] });
  const { selection } = capture(w);
  assert.equal(selection.perFeature.source, 'vectorgrid-overrides'); assert.equal(selection.perFeature.exportedObjects, 1); assert.equal(selection.perFeature.matchedFeatures, 2);
});
