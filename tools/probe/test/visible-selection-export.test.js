import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareViewportDocument, renderViewportDocument, SELECTION_VIEWPORT_STYLE, CADASTRE_VIEWPORT_STYLE } from '../../gpkg-svg/core/viewport-export.js';
import { buildSvg } from '../../gpkg-svg/core/svg-writer.js';
import { exportVisibleCadastre } from '../../gpkg-svg/browser/api.js';
import { SECRET } from './fixtures/synthetic-leaflet.js';

globalThis.window = globalThis;
await import('../visible-cadastre-export.js');
const V = () => globalThis.MonTerritoireVisibleCadastre;
const NOW = new Date(2026, 9, 9, 12);
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const selectionFact = (features = [{ rings: [sq(10, 10, 60, 60), sq(20, 20, 30, 30)] }, { rings: [sq(100, 100, 400, 200)] }]) => ({
  status: 'ready', features,
  counts: { candidatePolygons: 3, selectedFeaturesDetected: 2, selectedFeaturesVisible: features.length, selectedPathsExported: features.length, selectedFeaturesClipped: 1, duplicatesHandled: 1, keyTiers: { id: 0, property: 2, geometry: 0 } },
  diagnostics: { projectionMethods: { 'leaflet-rings': 3 }, paneCounts: { selection: 3 } }
});
const ready = selection => ({
  type: 'visible-cadastre', status: 'ready', viewport: { width: 400, height: 250 }, zoom: 17,
  features: [{ rings: [sq(0, 0, 100, 50)] }, { rings: [sq(120, 0, 220, 50)] }, { rings: [sq(0, 60, 100, 110)] }],
  counts: { cachedFeatures: 5, uniqueFeatures: 4, visibleFeatures: 3, exportedPaths: 3, clippedFeatures: 0, duplicatesHandled: 1, tiles: 3, tilesInViewport: 2, keyTiers: { id: 5, property: 0, geometry: 0 } },
  diagnostics: { tileSize: { width: 256, height: 256 }, tileZoom: 17, zoomScale: 1, viewportMethod: 'map.getSize', pixelOriginMethod: 'map.getPixelOrigin+layerPointToContainerPoint', transformMethod: 'tile-local-px*zoomScale+tile-origin', clippingMethod: 'sutherland-hodgman-viewport-rect', dedupMethod: 'feature-id>property>geometry-fingerprint' },
  ...(selection ? { selection } : {})
});
const layersOf = svg => [...svg.matchAll(/inkscape:label="([^"]+)" id="([^"]+)"/g)].map(m => ({ label: m[1], id: m[2] }));

test('21-22. the document has the Cadastre layer first and the selected parcels above it', () => {
  const document = prepareViewportDocument(V().validateCapture(ready(selectionFact())));
  assert.deepEqual(document.layers.map(layer => [layer.id, layer.label, layer.type]), [['layer-cadastre', 'Cadastre', 'vector'], ['layer-selected-parcels', 'Parcelles sélectionnées', 'vector']]);
  const svg = renderViewportDocument(document, { now: NOW });
  assert.deepEqual(layersOf(svg).map(layer => layer.label), ['Cadastre', 'Parcelles sélectionnées'], 'later in the file = drawn on top');
  assert.ok(svg.indexOf('inkscape:label="Cadastre"') < svg.indexOf('inkscape:label="Parcelles sélectionnées"'));
  assert.match(svg, /width="400" height="250" viewBox="0 0 400 250"/);
});

test('23. ids are neutral and sequential', () => {
  const svg = exportVisibleCadastre(V().validateCapture(ready(selectionFact())), { now: NOW }).svg;
  assert.deepEqual([...svg.matchAll(/<path id="([^"]+)"/g)].map(m => m[1]), ['cadastre-visible-1', 'cadastre-visible-2', 'cadastre-visible-3', 'selection-1', 'selection-2']);
});

test('G. styles stay distinct and centralised: thin unfilled Cadastre, translucent filled selection, Inkscape-editable attributes', () => {
  const svg = exportVisibleCadastre(V().validateCapture(ready(selectionFact())), { now: NOW }).svg;
  const cadastre = svg.match(/<path id="cadastre-visible-1"[^>]*>/)[0]; const selected = svg.match(/<path id="selection-1"[^>]*>/)[0];
  assert.match(cadastre, /fill="none"/); assert.doesNotMatch(cadastre, /fill-opacity/); assert.match(cadastre, /stroke-width="1"/);
  assert.match(selected, new RegExp(`fill="${SELECTION_VIEWPORT_STYLE.fill}" fill-opacity="0.25"`)); assert.match(selected, /stroke-width="2.5"/); assert.match(selected, /fill-rule="evenodd"/);
  assert.notEqual(SELECTION_VIEWPORT_STYLE.stroke, CADASTRE_VIEWPORT_STYLE.stroke);
  assert.equal(selected.match(/ d="([^"]+)"/)[1].split('M').length - 1, 2, 'outer ring and hole are two subpaths of one path');
});

test('24-26. no cadastral property, identifier or geographic coordinate reaches the SVG or its metadata', () => {
  const svg = exportVisibleCadastre(V().validateCapture(ready(selectionFact())), { now: NOW }).svg;
  const metadata = svg.match(/<mte:export[\s\S]*?\/>/)[0];
  assert.match(metadata, /selectedFeatureCount="2"/); assert.match(metadata, /featureCount="3"/);
  const stripped = svg.replace(/exportDatetime="[^"]*"/, '').replace(/xmlns[:\w]*="[^"]*"/g, '');
  for (const forbidden of [SECRET, 'idu', 'insee', 'section', 'numero', 'EPSG', 'lat', 'lng', 'property', 'tile', 'candidate']) assert.equal(stripped.includes(forbidden), false, forbidden);
  const numbers = [...svg.matchAll(/ d="([^"]+)"/g)].flatMap(m => m[1].match(/-?\d+(?:\.\d+)?/g).map(Number));
  assert.ok(numbers.every(value => value >= 0 && value <= 400), 'only viewport pixels');
});

test('27. without a selection the export is the Cadastre layer alone, whether `selection` is absent, "none" or empty', () => {
  const none = { ...selectionFact([]), status: 'none', counts: { ...selectionFact().counts, selectedFeaturesDetected: 0, selectedFeaturesVisible: 0, selectedPathsExported: 0, selectedFeaturesClipped: 0 } };
  for (const selection of [undefined, none, selectionFact([])]) {
    const capture = V().validateCapture(ready(selection)); assert.ok(capture);
    const result = exportVisibleCadastre(capture, { now: NOW });
    assert.deepEqual(layersOf(result.svg).map(layer => layer.label), ['Cadastre']); assert.equal(result.summary.selectedFeatures, undefined);
    assert.doesNotMatch(result.svg, /selectedFeatureCount|fill-opacity/);
  }
});

test('28. a WMS/raster selection never blocks the Cadastre export and is reported as not yet exportable', () => {
  const capture = V().validateCapture(ready({ ...selectionFact([]), status: 'none' }));
  assert.ok(exportVisibleCadastre(capture, { now: NOW }).svg.includes('inkscape:label="Cadastre"'));
  const text = V().diagnosticText(capture, 'WMS_SELECTION');
  assert.match(text, /Parcelles sélectionnées :\n {2}aucune sélection vectorielle\n {2}sélection détectée \(WMS_SELECTION\) : pas encore exportable/);
  assert.doesNotMatch(V().diagnosticText(capture, 'LEAFLET_VECTOR_SELECTION'), /pas encore exportable/);
  assert.doesNotMatch(V().diagnosticText(capture), /pas encore exportable/);
});

test('diagnostic text of a vector selection shows counters only', () => {
  const text = V().diagnosticText(V().validateCapture(ready(selectionFact())), 'LEAFLET_GROUP_SELECTION');
  assert.match(text, /selected features detected: 2\n {2}selected features visible: 2\n {2}selected paths exported: 2\n {2}selected features clipped: 1\n {2}duplicates handled: 1 \(candidate polygons: 3\)/);
  assert.match(text, /projection: leaflet-rings 3/); assert.match(text, /panes: selection 3/);
  for (const forbidden of [SECRET, 'idu']) assert.equal(text.includes(forbidden), false);
});

test('the writer is generic: a third layer needs no change to the engine', () => {
  const layer = (id, label, idPrefix) => ({ id, label, type: 'vector', idPrefix, features: [{ polygons: [[sq(1, 1, 5, 5)]] }] });
  const document = prepareViewportDocument({ viewport: { width: 10, height: 10 }, features: [{ rings: [sq(0, 0, 9, 9)] }], selection: { features: [{ rings: [sq(1, 1, 4, 4)] }] } });
  const svg = buildSvg({ layers: [...document.layers, layer('layer-background', 'Fond IGN', 'background')], transform: { width: 10, height: 10, apply: p => p }, metadata: { generator: 'test' } });
  assert.deepEqual(layersOf(svg).map(item => item.label), ['Cadastre', 'Parcelles sélectionnées', 'Fond IGN']);
});

test('the closed schema rejects forged selections: ids, extra keys, out-of-viewport points, features on a "none" selection', () => {
  const bad = [];
  const add = mutate => { const value = ready(selectionFact()); mutate(value.selection, value); bad.push(value); };
  add(s => { s.features[0].idu = 'X'; }); add(s => { s.features[0].rings[0][0] = [-5, 0]; }); add(s => { s.features[0].rings[0][0] = [0, 9999]; }); add(s => { s.extra = 1; });
  add(s => { s.counts.idu = 1; }); add(s => { s.counts.selectedFeaturesVisible = -1; }); add(s => { s.diagnostics.projectionMethods = { 'x:123456': 1 }; }); add(s => { s.diagnostics.paneCounts = { 'bad pane': 1 }; });
  add(s => { s.status = 'none'; }); add(s => { s.status = 'other'; }); add(s => { s.diagnostics.url = 'https://x'; }); add(s => { s.features = new Array(20_001).fill({ rings: [sq(0, 0, 1, 1)] }); });
  add((s, v) => { v.selection = 'x'; });
  for (const value of bad) assert.equal(V().validateCapture(value), null, JSON.stringify(value).slice(0, 120));
  const clean = V().validateCapture(ready(selectionFact())); assert.deepEqual(clean.selection, selectionFact());
});

test('an invalid selection in the viewport capture is an error, never silently dropped geometry', () => {
  assert.throws(() => prepareViewportDocument({ viewport: { width: 10, height: 10 }, features: [{ rings: [sq(0, 0, 9, 9)] }], selection: { features: [{ rings: [[[0, 0], [1, 1]]] }] } }), /Anneau invalide|Le cadastre/);
});
