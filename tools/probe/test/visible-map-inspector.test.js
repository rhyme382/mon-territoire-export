import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisibleMapInspector, sanitizeTemplate } from '../visible-map-inspector.js';
import { CENTER, SECRET, TILE_X, TILE_Y, createSyntheticL, createSyntheticMap, decodedTile, maskLayer, rasterLayer, rendererTile, vectorGridLayer, wmsLayer } from './fixtures/synthetic-leaflet.js';

function world({ cadastre = true, tiles, extra = [] } = {}) {
  const L = createSyntheticL();
  const layers = [rasterLayer(L), wmsLayer(L), maskLayer(L), ...extra];
  if (cadastre) layers.push(vectorGridLayer(L, { tiles: typeof tiles === 'function' ? tiles(L) : tiles || { [`${TILE_X}:${TILE_Y}:17`]: rendererTile(L) } }));
  const map = createSyntheticMap(L, layers);
  const global = { L, document: { querySelectorAll: () => [map._container] }, location: { href: 'https://carto.test/' }, myMap: map };
  return { L, map, global, inspector: createVisibleMapInspector(global) };
}
const json = value => JSON.stringify(value);
const cadastre = capture => capture.cadastreCandidate;

test('discovers the Leaflet map from a global data property and reports the method actually used', () => {
  const { inspector, map } = world();
  const capture = inspector.capture();
  assert.equal(capture.discovery.method, 'global-property');
  assert.equal(capture.map.status, 'found');
  assert.equal(capture.map.zoom, 17);
  assert.equal(capture.map.layerCount, Object.keys(map._layers).length);
});

test('never invokes accessor getters while scanning globals', () => {
  const { global } = world(); let touched = false;
  Object.defineProperty(global, 'trapMap', { enumerable: true, get() { touched = true; return {}; } });
  createVisibleMapInspector(global).capture();
  assert.equal(touched, false);
});

test('falls back to the init hook for maps created after installation, without altering the map', () => {
  const L = createSyntheticL(); const container = { clientWidth: 10, clientHeight: 10 };
  const global = { L, document: { querySelectorAll: () => [container] } };
  const inspector = createVisibleMapInspector(global); inspector.installDiscovery();
  assert.equal(L.hooks.length, 1);
  assert.equal(inspector.capture().map.status, 'not-found');
  const map = createSyntheticMap(L, [rasterLayer(L)], { container }); L.hooks[0].call(map);
  const capture = inspector.capture();
  assert.equal(capture.discovery.method, 'init-hook'); assert.equal(capture.map.status, 'found');
  inspector.installDiscovery(); assert.equal(L.hooks.length, 1, 'hook installed once');
});

test('discovers a map stored as a data property of the container element', () => {
  const L = createSyntheticL(); const container = { clientWidth: 10, clientHeight: 10 };
  const map = createSyntheticMap(L, [], { container }); container.__page_handle = map;
  const capture = createVisibleMapInspector({ L, document: { querySelectorAll: () => [container] } }).capture();
  assert.equal(capture.discovery.method, 'container-property');
});

test('reports not-found without throwing when no map is reachable', () => {
  const capture = createVisibleMapInspector({ L: createSyntheticL(), document: { querySelectorAll: () => [] } }).capture();
  assert.equal(capture.map.status, 'not-found'); assert.equal(capture.discovery.method, 'none'); assert.deepEqual(capture.layers, []);
  assert.equal(capture.cadastreCandidate.status, 'not-found');
});

test('inventories layers and classifies raster, WMS, VectorGrid and mask with evidence', () => {
  const { inspector } = world();
  const byKind = Object.fromEntries(inspector.capture().layers.map(layer => [layer.kind, layer]));
  assert.deepEqual(Object.keys(byKind).sort(), ['mask', 'raster', 'vectorgrid', 'wms']);
  assert.equal(byKind.raster.confidence, 'high'); assert.ok(byKind.raster.evidence.includes('instanceof:TileLayer'));
  assert.ok(byKind.wms.evidence.includes('property:wmsParams'));
  assert.ok(byKind.vectorgrid.evidence.includes('instanceof:VectorGrid.Protobuf')); assert.ok(byKind.vectorgrid.evidence.includes('property:_vectorTiles'));
  assert.ok(byKind.mask.evidence.includes('pane:mask'));
  assert.equal(byKind.raster.pane, 'tilePane'); assert.equal(byKind.raster.zIndex, 1); assert.equal(byKind.raster.tileZoom, 17); assert.equal(byKind.raster.tileCacheCount, 1);
  assert.equal(byKind.raster.attached, true);
});

test('classifies a page-provided VectorTileLayer class by instanceof, not by constructor name', () => {
  const L = createSyntheticL(); const VectorTileLayer = function VectorTileLayer() {}; const layer = new VectorTileLayer();
  Object.assign(layer, { _leaflet_id: 7, options: { pane: 'overlayPane' }, _tiles: { a: {} } });
  const map = createSyntheticMap(L, [layer]);
  const result = createVisibleMapInspector({ L, VectorTileLayer, document: { querySelectorAll: () => [map._container] }, m: map }).capture();
  assert.equal(result.layers[0].kind, 'vectortilelayer'); assert.ok(result.layers[0].evidence.includes('instanceof:VectorTileLayer'));
  const unknown = new (function Mystery() {})(); unknown._leaflet_id = 8; map._layers[8] = unknown;
  const again = createVisibleMapInspector({ L, document: { querySelectorAll: () => [map._container] }, m: map }).capture();
  assert.equal(again.layers.find(layer => layer.leafletId === 8).kind, 'unknown'); assert.equal(again.layers.find(layer => layer.leafletId === 8).confidence, 'low');
});

test('sanitizes URL templates: no query, no fragment, no concrete tile coordinates', () => {
  assert.deepEqual(sanitizeTemplate('https://{s}.tiles.test/a/{z}/{x}/{y}.pbf?token=abc#frag'), { hostname: '{s}.tiles.test', pathname: '/a/{z}/{x}/{y}.pbf' });
  assert.deepEqual(sanitizeTemplate('https://tiles.test/a/17/123456/654321.pbf?k=v'), { hostname: 'tiles.test', pathname: '/a/{z}/{x}/{y}.pbf' });
  assert.equal(sanitizeTemplate('javascript:alert(1)'), null);
  assert.equal(sanitizeTemplate(42), null);
  const text = json(world().inspector.capture());
  for (const forbidden of [SECRET, 'token', '?', String(TILE_X), String(TILE_Y)]) assert.equal(text.includes(forbidden), false, forbidden);
});

test('inspects a simulated _vectorTiles cache of renderer path layers: decoded geometry present', () => {
  const { inspector } = world({ tiles: L => ({ '1:2:17': rendererTile(L, { features: 3 }), '1:3:17': rendererTile(L, { features: 2 }) }) });
  const candidate = cadastre(inspector.capture());
  assert.equal(candidate.status, 'found'); assert.equal(candidate.engine, 'VectorGrid'); assert.equal(candidate.active, true);
  assert.deepEqual(candidate.tileCache, { tiles: 2, vectorTiles: 2, keyShapes: ['n:n:n'] });
  assert.equal(candidate.decodedFeatures, 5);
  assert.equal(candidate.decodedGeometry.present, true);
  assert.deepEqual(candidate.decodedGeometry.representations, ['leaflet-pixel-parts']);
  assert.deepEqual(candidate.decodedGeometry.geometryTypes, { Polygon: 5 });
  assert.equal(candidate.decodedGeometry.vertexCount, 20);
  assert.deepEqual(candidate.propertyKeys.sort(), ['idu', 'insee', 'section']);
  assert.deepEqual(candidate.decodedGeometry.rendererFamilies, { Canvas: 2 });
  assert.equal(candidate.exportability.status, 'renderer-geometry');
  assert.equal(candidate.exportability.featureToGeometry, true); assert.equal(candidate.exportability.featureToTile, true);
});

test('inspects simulated decoded vector tiles with lazy loadGeometry: direct geometry', () => {
  const { inspector } = world({ tiles: { '1:2:17': decodedTile(4) } });
  const candidate = cadastre(inspector.capture());
  assert.equal(candidate.decodedFeatures, 4);
  assert.deepEqual(candidate.decodedGeometry.representations, ['lazy-loadGeometry']);
  assert.deepEqual(candidate.decodedGeometry.geometryTypes, { Polygon: 4 });
  assert.deepEqual(candidate.decodedLayerNames, ['cadastre_parcelle']);
  assert.equal(candidate.exportability.status, 'direct-geometry');
  assert.equal(candidate.decodedGeometry.featureIdsPresent, 4);
});

test('reports renderer-only tiles: canvas present, no recoverable geometry', () => {
  const { inspector } = world({ tiles: L => { const renderer = new L.Canvas(); renderer._ctx = {}; renderer._container = { tagName: 'CANVAS' }; return { '1:2:17': renderer }; } });
  const candidate = cadastre(inspector.capture());
  assert.equal(candidate.decodedGeometry.present, false); assert.equal(candidate.decodedFeatures, 0);
  assert.equal(candidate.rendererOnly, true);
  assert.equal(candidate.exportability.status, 'not-recoverable');
  assert.equal(candidate.tileCache.vectorTiles, 1);
});

test('reports features that carry only latlngs as renderer geometry and ignores features without geometry', () => {
  const { inspector } = world({ tiles: L => ({ '1:2:17': rendererTile(L, { features: 2, geometry: 'latlngs' }), '1:3:17': rendererTile(L, { features: 1, geometry: 'none' }) }) });
  const candidate = cadastre(inspector.capture());
  assert.equal(candidate.decodedFeatures, 3);
  assert.deepEqual(candidate.decodedGeometry.representations, ['leaflet-latlngs']);
  assert.equal(candidate.decodedGeometry.featuresWithGeometry, 2);
});

test('keeps property key names but never property values, ids, coordinates or tile x/y', () => {
  const { inspector } = world({ tiles: L => ({ [`${TILE_X}:${TILE_Y}:17`]: rendererTile(L), '9:9:17': decodedTile(1) }) });
  const text = json(inspector.capture());
  assert.match(text, /"idu"/); assert.match(text, /"insee"/);
  for (const forbidden of [SECRET, String(CENTER), String(TILE_X), String(TILE_Y), '1000']) assert.equal(text.includes(forbidden), false, forbidden);
});

test('never records exact centre or bounds and never calls geographic accessors or mutators', () => {
  const { inspector, map } = world();
  const text = json(inspector.capture());
  assert.equal(text.includes(String(CENTER)), false);
  assert.deepEqual(map.calls, []);
  assert.doesNotMatch(text, /"(?:center|bounds|latlng|lat|lng|coordinates)"/i);
});

test('capture is read-only: layer set, tile caches and attached layers are unchanged', () => {
  const { inspector, map } = world();
  const before = Object.keys(map._layers).join(); inspector.capture(); inspector.capture();
  assert.equal(Object.keys(map._layers).join(), before); assert.deepEqual(map.calls, []);
});

test('capture without a cadastre layer reports not-found, and no capture ever touches the network', () => {
  const calls = [];
  const { global } = world({ cadastre: false });
  global.fetch = (...args) => { calls.push(args); throw new Error('network'); }; global.XMLHttpRequest = function () { calls.push('xhr'); throw new Error('network'); };
  global.Worker = function () { calls.push('worker'); }; global.Image = function () { calls.push('image'); };
  const capture = createVisibleMapInspector(global).capture();
  assert.equal(capture.cadastreCandidate.status, 'not-found'); assert.equal(capture['no-additional-network-requests'], true);
  assert.deepEqual(calls, []);
});

test('the cadastre candidate is chosen on evidence and carries its score evidence', () => {
  const { inspector } = world();
  const candidate = cadastre(inspector.capture());
  assert.ok(candidate.evidence.includes('template-path:cadastre')); assert.ok(candidate.evidence.includes('vector-layer-style:cadastre_parcelle') || candidate.evidence.includes('class:vectorgrid'));
  const L = createSyntheticL(); const other = vectorGridLayer(L, { id: 11, urlPath: 'relief' }); other.options.vectorTileLayerStyles = { relief: {} };
  const map = createSyntheticMap(L, [other, vectorGridLayer(L, { id: 12 })]);
  const result = createVisibleMapInspector({ L, document: { querySelectorAll: () => [map._container] }, m: map }).capture();
  assert.equal(result.cadastreCandidate.leafletId, 12);
});
