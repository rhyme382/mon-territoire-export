// Fully synthetic Leaflet-like runtime. No SOGEFI data: every value below is a placeholder.
export const SECRET = 'SECRET-VALUE-9f3';
export const CENTER = 45.123456;
export const TILE_X = 123456;
export const TILE_Y = 654321;

// Leaflet.Class.extend gives every class the constructor name "NewClass": classification must not rely on names.
function cls(parent) { const Klass = function NewClass() {}; if (parent) Klass.prototype = Object.create(parent.prototype, { constructor: { value: Klass } }); return Klass; }

export function createSyntheticL() {
  const Layer = cls(); const GridLayer = cls(Layer); const TileLayer = cls(GridLayer); const WMS = cls(TileLayer); TileLayer.WMS = WMS;
  const VectorGrid = cls(GridLayer); const Protobuf = cls(VectorGrid); VectorGrid.Protobuf = Protobuf;
  const Renderer = cls(Layer); const Canvas = cls(Renderer); const SVG = cls(Renderer);
  const Path = cls(Layer); const Polyline = cls(Path); const Polygon = cls(Polyline); const LayerGroup = cls(Layer); const FeatureGroup = cls(LayerGroup); const GeoJSON = cls(FeatureGroup);
  const hooks = [];
  const MapClass = cls(); MapClass.addInitHook = fn => hooks.push(fn);
  return { version: '1.9.4', Map: MapClass, Layer, GridLayer, TileLayer, VectorGrid, Renderer, Canvas, SVG, Path, Polyline, Polygon, LayerGroup, FeatureGroup, GeoJSON, hooks };
}

export function createContainer(width = 1000, height = 700) { return { clientWidth: width, clientHeight: height, tagName: 'DIV' }; }

// A map whose geographic accessors and mutators are spies: the inspector must never call them.
export function createSyntheticMap(L, layers = [], { zoom = 17, container = createContainer(), pixelOrigin = { x: 0, y: 0 }, panePos = { x: 0, y: 0 }, project = () => ({ x: 0, y: 0 }) } = {}) {
  const calls = [];
  const map = new L.Map();
  const spy = name => (...args) => { calls.push([name, args]); return CENTER; };
  Object.assign(map, {
    _leaflet_id: 1, _container: container, _layers: {}, _zoom: zoom, options: { crs: { code: 'EPSG:3857' } },
    getZoom: () => zoom, getCenter: spy('getCenter'), getBounds: spy('getBounds'), getPixelBounds: spy('getPixelBounds'),
    setView: spy('setView'), setZoom: spy('setZoom'), panTo: spy('panTo'), addLayer: spy('addLayer'), removeLayer: spy('removeLayer'), fitBounds: spy('fitBounds'), invalidateSize: spy('invalidateSize'),
    getPixelOrigin: () => pixelOrigin, latLngToLayerPoint: project,
    getSize: () => ({ x: container.clientWidth, y: container.clientHeight }), getZoomScale: (to, from) => 2 ** (to - from), layerPointToContainerPoint: p => ({ x: p.x + panePos.x, y: p.y + panePos.y }),
  });
  for (const layer of layers) map._layers[layer._leaflet_id] = layer;
  map.calls = calls;
  return map;
}

export function rasterLayer(L, id = 2) {
  const layer = new L.TileLayer(); Object.assign(layer, { _leaflet_id: id, _url: `https://tiles.test/base/{z}/{x}/{y}.png?token=${SECRET}`, options: { pane: 'tilePane', zIndex: 1 }, _tileZoom: 17, _tiles: { [`${TILE_X}:${TILE_Y}:17`]: { el: {}, coords: { x: TILE_X, y: TILE_Y, z: 17 } } } });
  return layer;
}
export function wmsLayer(L, id = 3) {
  const layer = new L.TileLayer.WMS(); Object.assign(layer, { _leaflet_id: id, _url: `https://wms.test/ows?service=WMS&token=${SECRET}`, wmsParams: { layers: 'zones' }, options: { pane: 'overlayPane' }, _tiles: { a: {}, b: {} } });
  return layer;
}
export function maskLayer(L, id = 9) {
  const layer = new L.Polygon(); Object.assign(layer, { _leaflet_id: id, options: { pane: 'mask' }, _parts: [[{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }]] });
  return layer;
}

// A renderer tile holding Leaflet path layers (what Leaflet.VectorGrid keeps per tile).
export function rendererTile(L, { features = 3, geometry = 'pixel-parts', canvas = true } = {}) {
  const renderer = new (canvas ? L.Canvas : L.SVG)(); renderer._features = {}; if (canvas) renderer._ctx = {}; else renderer._container = { tagName: 'svg' };
  for (let i = 0; i < features; i++) {
    const path = new L.Polygon(); path.properties = { idu: `${SECRET}-${i}`, insee: SECRET, section: SECRET };
    if (geometry === 'pixel-parts') path._parts = [[{ x: 1 + i, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 9 }, { x: 1, y: 9 }]];
    if (geometry === 'latlngs') path._latlngs = [[{ lat: CENTER, lng: CENTER }, { lat: CENTER, lng: 2 }, { lat: 1, lng: 2 }]];
    renderer._features[`${SECRET}-${i}`] = { layerName: 'cadastre_parcelle', feature: path };
  }
  return renderer;
}

// A decoded Mapbox-style vector tile with lazy geometry.
export function decodedTile(features = 2) {
  const layerObject = { length: features, extent: 4096, feature: i => ({ id: 1000 + i, type: 3, properties: { idu: SECRET, insee: SECRET }, loadGeometry: () => [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 0 }]] }) };
  return { layers: { cadastre_parcelle: layerObject } };
}

// `coords` maps a tile key to its real {x,y,z}; without it every tile claims the same placeholder coordinates.
export function vectorGridLayer(L, { id = 5, tiles = {}, urlPath = 'cadastre_parcelle', coords = {} } = {}) {
  const layer = new L.VectorGrid.Protobuf();
  const vectorTiles = Object.fromEntries(Object.entries(tiles).map(([key, tile]) => [key, tile]));
  Object.assign(layer, { _leaflet_id: id, _url: `https://tiles.test/${urlPath}/{z}/{x}/{y}.pbf?token=${SECRET}`, options: { pane: 'overlayPane', vectorTileLayerStyles: { cadastre_parcelle: {} } }, _tileZoom: 17, _tiles: Object.fromEntries(Object.keys(vectorTiles).map(key => [key, { el: {}, coords: coords[key] || { x: TILE_X, y: TILE_Y, z: 17 } }])), getTileSize: () => ({ x: 256, y: 256 }), _vectorTiles: vectorTiles });
  return layer;
}

// A renderer tile whose features carry explicit tile-local rings (what Leaflet.VectorGrid keeps in `_parts`).
// features: [{ id, rings: [[[x,y],...]], idu }]; `id` is the key of the renderer `_features` map.
export function geometryTile(L, features, { layerName = 'cadastre_parcelle' } = {}) {
  const renderer = new L.Canvas(); renderer._features = {}; renderer._ctx = {};
  for (const { id, rings, idu = `${SECRET}-${id}`, layerName: own } of features) {
    const path = new L.Polygon(); path.properties = { idu, insee: SECRET, section: SECRET };
    path._parts = rings.map(ring => ring.map(([x, y]) => ({ x, y })));
    renderer._features[id] = { layerName: own ?? layerName, feature: path };
  }
  return renderer;
}

// ---- MVP-03C: selected parcels. A latlng is {lat: y, lng: x}, so the projection `selectionProject` is the identity on layer points.
export const selectionProject = ll => ({ x: ll.lng, y: ll.lat });
const toLatLngRings = rings => rings.map(ring => ring.map(([x, y]) => ({ lat: y, lng: x })));
// rings: layer-point rings (outer first, then holes). `latlngs` overrides the memory latlngs (MultiPolygon nesting); `projected: false` leaves no `_rings`/`_parts`.
export function polygonLayer(L, { id, rings, pane = 'selection', idu, featureId, latlngs, projected = true, parts = false, staleRings = null, className } = {}) {
  const layer = new L.Polygon();
  Object.assign(layer, { _leaflet_id: id, options: { pane, color: '#0057b8', fillColor: '#00b4d8', weight: 2, fillOpacity: 0.3, ...(className ? { className } : {}) }, _latlngs: latlngs || toLatLngRings(rings) });
  if (projected) layer._rings = (staleRings || rings).map(ring => ring.map(([x, y]) => ({ x, y })));
  if (parts) layer._parts = rings.map(ring => ring.map(([x, y]) => ({ x, y })));
  if (idu !== undefined || featureId !== undefined) layer.feature = { ...(featureId !== undefined ? { id: featureId } : {}), properties: { idu: idu ?? `${SECRET}-${id}`, insee: SECRET, section: SECRET } };
  return layer;
}
export function groupLayer(L, { id, children = [], pane = 'overlayPane', klass = 'LayerGroup' } = {}) {
  const group = new L[klass]();
  Object.assign(group, { _leaflet_id: id, options: { pane }, _layers: Object.fromEntries(children.map(child => [child._leaflet_id, child])) });
  return group;
}
export function rendererLayer(L, { id, canvas = true } = {}) {
  const renderer = new (canvas ? L.Canvas : L.SVG)(); Object.assign(renderer, { _leaflet_id: id, options: { pane: 'selection' }, _layers: {} });
  if (canvas) renderer._ctx = {}; else renderer._container = { tagName: 'svg' };
  return renderer;
}
// Adds layers to a synthetic map the way Leaflet registers them (children of a group are registered too).
export function attach(map, ...layers) { for (const layer of layers) { map._layers[layer._leaflet_id] = layer; if (layer._layers && !layer._tiles && !layer._vectorTiles) for (const child of Object.values(layer._layers)) map._layers[child._leaflet_id] = child; } return map; }
export function detach(map, ...layers) { for (const layer of layers) { delete map._layers[layer._leaflet_id]; if (layer._layers && !layer._tiles) for (const child of Object.values(layer._layers)) delete map._layers[child._leaflet_id]; } return map; }

// ---- MVP-04: basemap tiles. Everything is synthetic: no pixel, URL or token comes from a real service.
// An <img> the page already decoded. `taint` makes a canvas refuse to read it back (what a cross-origin tile without CORS does).
export function tileImage({ width = 256, height = 256, src = `https://tiles.test/base/17/1/2.png?token=${SECRET}`, taint = false, complete = true, tag = 'IMG' } = {}) {
  return { tagName: tag, complete, naturalWidth: complete ? width : 0, naturalHeight: complete ? height : 0, width, height, currentSrc: src, src, taint };
}
// tiles: [{ x, y, el }] at `tileZoom`; the key shape is Leaflet's `x:y:z`.
export function basemapLayer(L, { id = 2, pane = 'raster', zIndex = 1, tileZoom = 17, tiles = [], paneZIndex, wms = false } = {}) {
  const layer = wms ? new L.TileLayer.WMS() : new L.TileLayer();
  const cache = Object.fromEntries(tiles.map(({ x, y, z = tileZoom, el }) => [`${x}:${y}:${z}`, { el, coords: { x, y, z }, current: true, loaded: Date.now() }]));
  Object.assign(layer, { _leaflet_id: id, _url: `https://tiles.test/base/{z}/{x}/{y}.png?token=${SECRET}`, options: { pane, zIndex }, _tileZoom: tileZoom, _tiles: cache, getTileSize: () => ({ x: 256, y: 256 }) });
  if (wms) layer.wmsParams = { layers: 'zones' };
  if (paneZIndex !== undefined) layer.getPane = () => ({ style: { zIndex: String(paneZIndex) } });
  return layer;
}
// A canvas factory that records every draw and refuses to export once a tainted element was drawn into it.
export function createFakeCanvases() {
  const canvases = [];
  const factory = (width, height) => {
    const canvas = { width, height, draws: [], tainted: false, exported: 0 };
    const context = {
      drawImage: (element, ...args) => { if (element.taint) canvas.tainted = true; canvas.draws.push({ element, args }); },
      getImageData: () => { if (canvas.tainted) throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError'); return { data: [0, 0, 0, 0] }; },
    };
    canvas.getContext = () => context;
    canvas.toDataURL = type => { if (canvas.tainted) throw new DOMException('Tainted', 'SecurityError'); canvas.exported++; return `${type === 'image/png' ? 'data:image/png;base64,' : 'data:,'}iVBORw0KGgo${'A'.repeat(32)}`; };
    canvases.push(canvas);
    return canvas;
  };
  return { factory, canvases, composed: () => canvases.filter(canvas => canvas.width > 1 || canvas.height > 1) };
}
