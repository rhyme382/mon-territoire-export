import test from 'node:test';
import assert from 'node:assert/strict';
import * as geometry from '../visible-cadastre-geometry.js';
import { createVisibleMapInspector } from '../visible-map-inspector.js';
import { CENTER, SECRET, createSyntheticL, createSyntheticMap, createContainer, geometryTile, maskLayer, rasterLayer, vectorGridLayer } from './fixtures/synthetic-leaflet.js';

const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
// Viewport 400x250. Tile size 256 at zoom 17. The map pane is shifted by panePos; pixelOrigin is far away like in a real map.
function scene({ zoom = 17, tileZoom = 17, pixelOrigin = { x: 256 * 1000 - 40, y: 256 * 2000 - 30 }, panePos = { x: 5, y: 7 }, extraTiles = {}, geometryModule = geometry } = {}) {
  const L = createSyntheticL();
  const tiles = {
    '1000:2000:17': geometryTile(L, [{ id: 'full', rings: [sq(60, 60, 120, 120)] }, { id: 'cross', rings: [sq(200, 20, 256, 60)] }, { id: 'hole', rings: [sq(10, 150, 100, 250), sq(30, 170, 60, 200).reverse()] }]),
    '1001:2000:17': geometryTile(L, [{ id: 'cross', rings: [sq(0, 20, 30, 60)] }]),
    '5000:5000:17': geometryTile(L, [{ id: 'far', rings: [sq(10, 10, 50, 50)] }]),
    ...extraTiles,
  };
  const coords = Object.fromEntries(Object.keys(tiles).map(key => { const [x, y, z] = key.split(':').map(Number); return [key, { x, y, z }]; }));
  const layer = vectorGridLayer(L, { tiles, coords }); layer._tileZoom = tileZoom;
  const map = createSyntheticMap(L, [rasterLayer(L), maskLayer(L), layer], { zoom, container: createContainer(400, 250), pixelOrigin, panePos });
  const global = { L, document: { querySelectorAll: () => [map._container] }, myMap: map, MonTerritoireVisibleCadastreGeometry: geometryModule };
  return { L, map, layer, inspector: createVisibleMapInspector(global) };
}
const ring = (feature) => feature.rings.flat();

test('reports ready after the availability check only, without extracting', () => {
  assert.deepEqual(scene().inspector.visibleCadastre({ dryRun: true }), { type: 'visible-cadastre', status: 'ready', summary: { selection: { state: 'none', count: 0 }, background: { state: 'not-embeddable' } } });
});

test('maps tile-local parts to container pixels: tile pos - pixel origin + pane offset', () => {
  const { inspector, map } = scene();
  const result = inspector.visibleCadastre();
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.viewport, { width: 400, height: 250 });
  // tile 1000:2000 origin = (40,30) + pane (5,7) = (45,37); 'full' local (60,60) -> (105,97)
  const full = result.features.find(f => ring(f).some(([x, y]) => x === 105 && y === 97));
  assert.ok(full, 'full parcel placed at tile origin + local');
  assert.deepEqual(map.calls, [], 'the map is never moved or queried geographically');
});

test('drops the far cached tile, clips the viewport edge, merges the parcel cut by a tile seam', () => {
  const result = scene().inspector.visibleCadastre();
  const { counts } = result;
  assert.equal(counts.cachedFeatures, 5);
  assert.equal(counts.uniqueFeatures, 4);
  assert.equal(counts.visibleFeatures, 3);
  assert.equal(counts.exportedPaths, 3);
  assert.equal(counts.duplicatesHandled, 1);
  assert.equal(counts.tiles, 3); assert.equal(counts.tilesInViewport, 2);
  assert.ok(result.features.every(f => ring(f).every(([x, y]) => x >= 0 && x <= 400 && y >= 0 && y <= 250)));
  assert.ok(counts.clippedFeatures >= 1, 'the hole parcel crosses the bottom edge');
  const cross = result.features.find(f => f.rings.length === 1 && f.rings[0].length === 4 && Math.abs(geometry.vcgSignedArea(f.rings[0]) - 86 * 40) < 1e-6);
  assert.ok(cross, 'cross-seam fragments (56+30 wide) joined into one ring');
});

test('applies the zoom scale when the layer tile zoom differs from the map zoom', () => {
  const { inspector } = scene({ zoom: 18, tileZoom: 17, pixelOrigin: { x: 0, y: 0 }, panePos: { x: 0, y: 0 }, extraTiles: {} });
  const result = inspector.visibleCadastre();
  assert.equal(result.status, 'empty-view', 'scaled tiles land far from a zero origin');
  const near = scene({ zoom: 18, tileZoom: 17, pixelOrigin: { x: 2 * 256 * 1000 - 100, y: 2 * 256 * 2000 - 100 }, panePos: { x: 0, y: 0 } }).inspector.visibleCadastre();
  assert.equal(near.status, 'ready');
  assert.equal(near.diagnostics.zoomScale, 2);
  assert.ok(near.features.some(f => ring(f).some(([x, y]) => x === 220 && y === 220)), 'local (60,60) * 2 + (100,100)');
});

test('ignores tiles of another zoom level', () => {
  const stale = scene({ extraTiles: { '2000:4000:16': geometryTile(createSyntheticL(), [{ id: 'old', rings: [sq(0, 0, 200, 200)] }]) } });
  assert.equal(stale.inspector.visibleCadastre().counts.cachedFeatures, 5);
});

test('statuses: no map, no cadastre, no usable geometry', () => {
  assert.equal(createVisibleMapInspector({ L: createSyntheticL(), document: { querySelectorAll: () => [] } }).visibleCadastre().status, 'no-map');
  const L = createSyntheticL(); const map = createSyntheticMap(L, [rasterLayer(L)]);
  assert.equal(createVisibleMapInspector({ L, m: map, document: { querySelectorAll: () => [map._container] } }).visibleCadastre().status, 'no-cadastre');
  assert.equal(scene({ geometryModule: null }).inspector.visibleCadastre().status, 'no-geometry');
  const renderer = new (createSyntheticL().Canvas)(); renderer._ctx = {};
  const only = scene({ extraTiles: {} }); for (const key of Object.keys(only.layer._vectorTiles)) only.layer._vectorTiles[key] = renderer;
  assert.equal(only.inspector.visibleCadastre().status, 'no-geometry');
});

test('keeps only parcel layers of the VectorGrid', () => {
  const { inspector, layer, L } = scene();
  layer._vectorTiles['1000:2000:17']._features.road = { layerName: 'cadastre_batiment', feature: Object.assign(new L.Polygon(), { _parts: [sq(0, 0, 9, 9).map(([x, y]) => ({ x, y }))] }) };
  assert.equal(inspector.visibleCadastre().counts.cachedFeatures, 5);
});

test('output and diagnostics never contain ids, cadastral values, geographic or tile coordinates', () => {
  const result = scene().inspector.visibleCadastre();
  const text = JSON.stringify(result);
  for (const forbidden of [SECRET, String(CENTER), '1000', '2000', 'idu', 'insee', 'section', 'full', 'cross', 'hole', 'far', 'lat', 'lng']) assert.equal(text.includes(forbidden), false, forbidden);
  assert.deepEqual(Object.keys(result.features[0]), ['rings']);
});

test('without any id nor property the same parcel seen from two tiles is still de-duplicated through its geometry', () => {
  const L = createSyntheticL();
  const anonymous = parts => { const renderer = new L.Canvas(); renderer._ctx = {}; const path = new L.Polygon(); path._parts = parts.map(r => r.map(([x, y]) => ({ x, y }))); renderer._layers = { 1: path }; return renderer; };
  // one parcel spanning the seam between two tiles: each tile carries the same full shape (tile buffer)
  const tiles = { '1000:2000:17': anonymous([sq(200, 20, 300, 60)]), '1001:2000:17': anonymous([sq(-56, 20, 44, 60)]) };
  const coords = { '1000:2000:17': { x: 1000, y: 2000, z: 17 }, '1001:2000:17': { x: 1001, y: 2000, z: 17 } };
  const layer = vectorGridLayer(L, { tiles, coords });
  const map = createSyntheticMap(L, [layer], { container: createContainer(400, 250), pixelOrigin: { x: 256 * 1000 - 40, y: 256 * 2000 - 30 } });
  const result = createVisibleMapInspector({ L, m: map, document: { querySelectorAll: () => [map._container] }, MonTerritoireVisibleCadastreGeometry: geometry }).visibleCadastre();
  assert.equal(result.status, 'ready');
  assert.equal(result.counts.keyTiers.geometry, 2); assert.equal(result.counts.keyTiers.id, 0);
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].rings.length, 1);
  assert.equal(Math.abs(geometry.vcgSignedArea(result.features[0].rings[0])), 100 * 40);
});
