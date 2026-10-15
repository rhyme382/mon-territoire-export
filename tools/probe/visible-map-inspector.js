// MVP-03A, MAIN world. Read-only inspection of the Leaflet state the page already built.
// It never requests anything, never moves the map and never adds/removes a layer. Only structure
// (class families, counters, key NAMES) leaves this file; values, coordinates and tile x/y never do.
const VMI_MAX_LAYERS = 200;
const VMI_MAX_TILES = 256;
const VMI_MAX_FEATURES = 20_000;
const VMI_MAX_SAMPLE = 200;
const VMI_MAX_KEYS = 64;
const VMI_MAX_GLOBALS = 5_000;
const VMI_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
const VMI_LAYER_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const VMI_INSTANCE_PATHS = ['VectorGrid.Protobuf', 'VectorGrid', 'TileLayer.WMS', 'TileLayer', 'GridLayer', 'GeoJSON', 'FeatureGroup', 'Polygon', 'Polyline', 'Path', 'Layer'];
const VMI_DIRECT = new Set(['lazy-loadGeometry', 'mvt-geometry', 'mvt-command-integers', 'geojson-geometry']);
const VMI_RENDERER = new Set(['leaflet-pixel-parts', 'leaflet-rings', 'leaflet-latlngs']);

// Data properties only: a page getter is never invoked by the probe.
function vmiGet(target, key) {
  try {
    let node = target;
    for (let depth = 0; node && (typeof node === 'object' || typeof node === 'function') && depth < 8; depth++, node = Object.getPrototypeOf(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
    }
  } catch {}
  return undefined;
}
function vmiKeys(target, limit = VMI_MAX_KEYS * 4) { try { return target && typeof target === 'object' ? Object.keys(target).slice(0, limit) : []; } catch { return []; } }
function vmiCount(target) { try { return target && typeof target === 'object' ? Object.keys(target).length : 0; } catch { return 0; } }
function vmiPath(root, path) { return path.split('.').reduce((value, key) => (value == null ? undefined : vmiGet(value, key)), root); }
function vmiInt(value, maximum = 1_000_000) { return Number.isFinite(value) && value >= 0 && value <= maximum ? Math.round(value) : undefined; }

export function sanitizeTemplate(input) {
  if (typeof input !== 'string' || input.length > 2048) return null;
  try {
    const url = new URL(input.replace(/\{s\}/g, 'subdomain-placeholder'));
    if (!/^https?:$/.test(url.protocol)) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith('/') || pathname.length > 512 || /[?#\u0000-\u001f\u007f]/.test(pathname)) return null;
    return { hostname: url.hostname.toLowerCase().replace('subdomain-placeholder', '{s}'), pathname: pathname.replace(/\/(\d+)\/(\d+)\/(\d+)(?=\.[a-z0-9]+$|$)/i, '/{z}/{x}/{y}') };
  } catch { return null; }
}
function vmiKeyShape(key) { const shape = String(key).replace(/-?\d+/g, 'n'); return /^[n:,_ -]{1,24}$/.test(shape) ? shape : 'other'; }
function vmiIsMap(value) { return Boolean(value) && typeof value === 'object' && Boolean(vmiGet(value, '_container')) && vmiGet(value, '_layers') && typeof vmiGet(value, 'getZoom') === 'function'; }
function vmiArea(map) { const container = vmiGet(map, '_container'); return (Number(vmiGet(container, 'clientWidth')) || 0) * (Number(vmiGet(container, 'clientHeight')) || 0); }

// Points in nested arrays: {x,y}/{lat,lng} objects or raw integers (MVT commands). Values are counted, never kept.
function vmiPoints(value, depth = 0) {
  if (!Array.isArray(value) || depth > 6) return 0;
  let total = 0;
  for (const item of value.slice(0, 5_000)) {
    if (typeof item === 'number') total++;
    else if (item && typeof item === 'object' && !Array.isArray(item)) total += ('x' in item && 'y' in item) || ('lat' in item && 'lng' in item) ? 1 : 0;
    else total += vmiPoints(item, depth + 1);
  }
  return total;
}
function vmiRings(value) { return Array.isArray(value) ? value.filter(Array.isArray).length || (value.length ? 1 : 0) : 0; }
function vmiGeometryType(feature, L) {
  const type = vmiGet(feature, 'type');
  if (type === 1 || type === 'Point' || type === 'MultiPoint') return 'Point';
  if (type === 2 || type === 'LineString' || type === 'MultiLineString') return 'LineString';
  if (type === 3 || type === 'Polygon' || type === 'MultiPolygon') return 'Polygon';
  const Polygon = vmiPath(L, 'Polygon'); const Polyline = vmiPath(L, 'Polyline');
  if (typeof Polygon === 'function' && feature instanceof Polygon) return 'Polygon';
  if (typeof Polyline === 'function' && feature instanceof Polyline) return 'LineString';
  return 'Unknown';
}

function vmiInspectFeature(feature, L, acc) {
  if (!feature || typeof feature !== 'object') return;
  acc.featureCount++;
  const properties = vmiGet(feature, 'properties') || vmiGet(vmiGet(feature, 'feature'), 'properties');
  for (const key of vmiKeys(properties)) if (VMI_NAME.test(key) && acc.propertyKeys.size < VMI_MAX_KEYS) acc.propertyKeys.add(key);
  if (vmiGet(feature, 'id') !== undefined || vmiGet(vmiGet(feature, 'feature'), 'id') !== undefined) acc.idsPresent++;
  let points = 0; let rings = 0; let type = vmiGeometryType(feature, L);
  const found = [];
  if (typeof vmiGet(feature, 'loadGeometry') === 'function') {
    try { const geometry = feature.loadGeometry(); const count = vmiPoints(geometry); if (count) { found.push(['lazy-loadGeometry', count, vmiRings(geometry)]); } } catch {}
  }
  const geometry = vmiGet(feature, 'geometry');
  if (Array.isArray(geometry) && vmiPoints(geometry)) found.push([geometry.some(item => typeof item === 'number') ? 'mvt-command-integers' : 'mvt-geometry', vmiPoints(geometry), vmiRings(geometry)]);
  else if (geometry && typeof geometry === 'object' && Array.isArray(vmiGet(geometry, 'coordinates')) && vmiPoints(vmiGet(geometry, 'coordinates'))) { found.push(['geojson-geometry', vmiPoints(geometry.coordinates), vmiRings(geometry.coordinates)]); if (type === 'Unknown') type = vmiGeometryType(geometry, L); }
  for (const [key, name] of [['_parts', 'leaflet-pixel-parts'], ['_rings', 'leaflet-rings'], ['_latlngs', 'leaflet-latlngs']]) {
    const value = vmiGet(feature, key); const count = vmiPoints(value);
    if (count) found.push([name, count, vmiRings(value)]);
  }
  if (!found.length) return;
  for (const [name] of found) acc.representations.add(name);
  [, points, rings] = found[0];
  acc.featuresWithGeometry++; acc.vertexCount += points; acc.ringCount += rings; acc.geometryTypes[type] = (acc.geometryTypes[type] || 0) + 1;
}

function vmiRendererFamily(renderer, L) {
  if (!renderer || typeof renderer !== 'object') return undefined;
  const Canvas = vmiPath(L, 'Canvas'); const SVG = vmiPath(L, 'SVG'); const tag = String(vmiGet(vmiGet(renderer, '_container'), 'tagName') || '').toUpperCase();
  if ((typeof Canvas === 'function' && renderer instanceof Canvas) || vmiGet(renderer, '_ctx') || tag === 'CANVAS') return 'Canvas';
  if ((typeof SVG === 'function' && renderer instanceof SVG) || tag === 'SVG') return 'SVG';
  return 'Unknown';
}

// Walks the per-tile caches a VectorGrid/GridLayer keeps in memory. Nothing is decoded from the network.
function vmiInspectTiles(layer, L, map) {
  const tiles = vmiGet(layer, '_tiles'); const vectorTiles = vmiGet(layer, '_vectorTiles');
  const acc = { featureCount: 0, featuresWithGeometry: 0, vertexCount: 0, ringCount: 0, idsPresent: 0, geometryTypes: {}, representations: new Set(), propertyKeys: new Set(), layerNames: new Set(), rendererFamilies: {}, stores: { featureMaps: 0, rendererLayers: 0, decodedLayers: 0 }, rendererTiles: 0 };
  const keys = vmiKeys(vectorTiles, VMI_MAX_TILES);
  const seen = new Set();
  for (const key of keys) {
    const tile = vmiGet(vectorTiles, key); if (!tile || typeof tile !== 'object') continue;
    const family = vmiRendererFamily(tile, L);
    if (family) { acc.rendererFamilies[family] = (acc.rendererFamilies[family] || 0) + 1; acc.rendererTiles++; }
    const budget = () => VMI_MAX_FEATURES - acc.featureCount;
    const features = vmiGet(tile, '_features');
    if (features && typeof features === 'object') {
      acc.stores.featureMaps++;
      for (const id of vmiKeys(features, VMI_MAX_FEATURES)) {
        if (budget() <= 0) break;
        const entry = vmiGet(features, id); const feature = vmiGet(entry, 'feature') || entry;
        const name = vmiGet(entry, 'layerName'); if (typeof name === 'string' && VMI_LAYER_NAME.test(name) && acc.layerNames.size < VMI_MAX_KEYS) acc.layerNames.add(name);
        if (feature && typeof feature === 'object' && !seen.has(feature)) { seen.add(feature); vmiInspectFeature(feature, L, acc); }
      }
    }
    const pathLayers = vmiGet(tile, '_layers');
    if (pathLayers && typeof pathLayers === 'object') {
      let any = false;
      for (const id of vmiKeys(pathLayers, VMI_MAX_FEATURES)) {
        if (budget() <= 0) break;
        const feature = vmiGet(pathLayers, id); if (!feature || typeof feature !== 'object' || seen.has(feature)) continue;
        seen.add(feature); any = true; vmiInspectFeature(feature, L, acc);
      }
      if (any) acc.stores.rendererLayers++;
    }
    const decoded = vmiGet(tile, 'layers');
    if (decoded && typeof decoded === 'object') {
      acc.stores.decodedLayers++;
      for (const name of vmiKeys(decoded, VMI_MAX_KEYS)) {
        const source = vmiGet(decoded, name); if (!source || typeof source !== 'object') continue;
        if (VMI_LAYER_NAME.test(name) && acc.layerNames.size < VMI_MAX_KEYS) acc.layerNames.add(name);
        const length = Number(vmiGet(source, 'length')) || 0; const reader = vmiGet(source, 'feature');
        if (typeof reader !== 'function') continue;
        for (let index = 0; index < Math.min(length, VMI_MAX_SAMPLE) && budget() > 0; index++) { try { vmiInspectFeature(source.feature(index), L, acc); } catch {} }
        if (length > VMI_MAX_SAMPLE) acc.featureCount += Math.min(length - VMI_MAX_SAMPLE, Math.max(0, budget()));
      }
    }
  }
  const representations = [...acc.representations].sort();
  const direct = representations.some(name => VMI_DIRECT.has(name)); const renderer = representations.some(name => VMI_RENDERER.has(name));
  const tileCount = vmiCount(tiles); const vectorTileCount = vmiCount(vectorTiles);
  const present = acc.featuresWithGeometry > 0;
  return {
    tileCache: { tiles: tileCount, vectorTiles: vectorTileCount, keyShapes: [...new Set(keys.map(vmiKeyShape))].slice(0, 4) },
    decodedFeatures: acc.featureCount,
    decodedLayerNames: [...acc.layerNames].sort(),
    decodedGeometry: { present, representations, geometryTypes: acc.geometryTypes, featuresWithGeometry: acc.featuresWithGeometry, vertexCount: acc.vertexCount, ringCount: acc.ringCount, featureIdsPresent: acc.idsPresent, rendererFamilies: acc.rendererFamilies, stores: acc.stores },
    propertyKeys: [...acc.propertyKeys].sort(),
    rendererOnly: !present && acc.rendererTiles > 0,
    exportability: {
      status: direct ? 'direct-geometry' : renderer ? 'renderer-geometry' : tileCount + vectorTileCount > 0 ? 'not-recoverable' : 'unknown',
      featureToGeometry: present, featureToTile: present && vectorTileCount > 0,
      tileToViewport: typeof vmiGet(map, 'getPixelOrigin') === 'function' && typeof vmiGet(layer, '_tileZoom') === 'number',
      requiresNetwork: false
    }
  };
}

function vmiFamily(layer, L, global) {
  const evidence = []; const family = [];
  const candidates = VMI_INSTANCE_PATHS.map(path => [path, vmiPath(L, path)]);
  for (const name of ['VectorTileLayer']) candidates.push([name, vmiGet(global, name) || vmiPath(L, name)]);
  for (const [path, Class] of candidates) { try { if (typeof Class === 'function' && layer instanceof Class) { family.push(path); evidence.push(`instanceof:${path}`); } } catch {} }
  const ctor = vmiGet(vmiGet(layer, 'constructor'), 'name');
  if (typeof ctor === 'string' && VMI_NAME.test(ctor) && ctor !== 'NewClass' && ctor !== 'Object') { family.push(ctor); evidence.push(`constructor-name:${ctor}`); }
  return { family, evidence };
}
function vmiClassify(layer, L, global) {
  const { family, evidence } = vmiFamily(layer, L, global);
  const options = vmiGet(layer, 'options') || {}; const pane = vmiGet(options, 'pane');
  const url = vmiGet(layer, '_url'); const instance = name => evidence.includes(`instanceof:${name}`);
  const has = key => vmiGet(layer, key) !== undefined;
  let kind = 'unknown'; let confidence = 'low';
  const set = (value, level) => { kind = value; confidence = level; };
  if (typeof pane === 'string' && /mask/i.test(pane)) { evidence.push('pane:mask'); set('mask', 'high'); }
  else if (instance('TileLayer.WMS') || has('wmsParams') || (typeof url === 'string' && /[?&]service=wms/i.test(url))) {
    if (has('wmsParams')) evidence.push('property:wmsParams'); if (typeof url === 'string' && /[?&]service=wms/i.test(url)) evidence.push('url-service:wms');
    set('wms', instance('TileLayer.WMS') ? 'high' : 'medium');
  } else if (instance('VectorGrid') || instance('VectorGrid.Protobuf') || has('_vectorTiles') || vmiGet(options, 'vectorTileLayerStyles')) {
    if (has('_vectorTiles')) evidence.push('property:_vectorTiles'); if (vmiGet(options, 'vectorTileLayerStyles')) evidence.push('option:vectorTileLayerStyles');
    set('vectorgrid', instance('VectorGrid') || instance('VectorGrid.Protobuf') ? 'high' : 'medium');
  } else if (instance('VectorTileLayer') || evidence.some(item => /^constructor-name:.*VectorTileLayer/i.test(item))) set('vectortilelayer', instance('VectorTileLayer') ? 'high' : 'low');
  else if (instance('TileLayer') || (typeof url === 'string' && /\.(?:png|jpe?g|webp)(?:$|\?)/i.test(url))) set('raster', instance('TileLayer') ? 'high' : 'medium');
  else if (instance('GeoJSON') || instance('FeatureGroup') || instance('Path')) set('geojson-vector', 'high');
  return { kind, confidence, evidence: evidence.slice(0, 16), family: family.slice(0, 8) };
}

function vmiLayerRecord(layer, L, global, map) {
  const { kind, confidence, evidence, family } = vmiClassify(layer, L, global);
  const options = vmiGet(layer, 'options') || {};
  const pane = vmiGet(options, 'pane'); const url = vmiGet(layer, '_url'); const template = typeof url === 'string' ? sanitizeTemplate(url) : null;
  let zIndex = vmiGet(options, 'zIndex'); if (!Number.isFinite(zIndex)) { try { const value = Number(layer.getPane?.()?.style?.zIndex); zIndex = Number.isFinite(value) ? value : undefined; } catch { zIndex = undefined; } }
  const renderer = vmiGet(layer, '_renderer'); const container = vmiGet(layer, '_container'); const tag = String(vmiGet(container, 'tagName') || '').toUpperCase();
  const record = {
    leafletId: vmiInt(vmiGet(layer, '_leaflet_id'), 1e9) ?? 0, kind, confidence, evidence, family,
    attached: true,
    ...(typeof pane === 'string' && VMI_LAYER_NAME.test(pane) ? { pane } : {}),
    ...(Number.isFinite(zIndex) && Math.abs(zIndex) < 1e6 ? { zIndex: Math.round(zIndex) } : {}),
    ...(vmiInt(vmiGet(layer, '_tileZoom'), 64) !== undefined ? { tileZoom: vmiInt(vmiGet(layer, '_tileZoom'), 64) } : {}),
    tileCacheCount: vmiCount(vmiGet(layer, '_tiles')), vectorTileCacheCount: vmiCount(vmiGet(layer, '_vectorTiles')),
    ...(vmiRendererFamily(renderer, L) ? { rendererFamily: vmiRendererFamily(renderer, L) } : {}),
    hasCanvas: tag === 'CANVAS' || Boolean(vmiGet(renderer, '_ctx')), hasSvg: tag === 'SVG', hasContainer: Boolean(container),
    structuralKeys: vmiKeys(layer).filter(key => /^_?(?:url|tiles|vectorTiles|tileZoom|renderer|container|map|layers|leaflet_id|pane|levels|features|wmsParams)$/.test(key)).slice(0, 16),
    ...(template ? { templatePattern: template } : {})
  };
  return record;
}

function vmiScore(record, inspection, styles) {
  const evidence = []; let score = 0;
  if (record.templatePattern && /cadastre/i.test(record.templatePattern.pathname)) { evidence.push('template-path:cadastre'); score += 3; }
  const named = styles.find(name => /cadastre/i.test(name)); if (named) { evidence.push(`vector-layer-style:${named}`); score += 3; }
  const decoded = inspection.decodedLayerNames.find(name => /cadastre/i.test(name)); if (decoded) { evidence.push(`decoded-layer-name:${decoded}`); score += 3; }
  if (inspection.propertyKeys.some(key => /^(?:idu|insee)$/i.test(key))) { evidence.push('property-keys:parcel-identity'); score += 2; }
  if (record.kind === 'vectorgrid' || record.kind === 'vectortilelayer') { evidence.push(`class:${record.kind}`); score += 1; }
  return { score, evidence };
}

function vmiZoom(map) { try { const value = map.getZoom(); return Number.isFinite(value) && value >= 0 && value <= 30 ? Math.round(value * 100) / 100 : undefined; } catch { return undefined; } }
function vmiCall(target, name, ...args) { const fn = vmiGet(target, name); if (typeof fn !== 'function') return undefined; try { return fn.apply(target, args); } catch { return undefined; } }
const vmiXY = value => (value && Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x, y: value.y } : null);
const VMI_TILE_PARCEL = /parcelle/i;
function vmiViewport(map) {
  let size = vmiXY(vmiCall(map, 'getSize')); let method = 'map.getSize';
  if (!size || size.x <= 0 || size.y <= 0) { const container = vmiGet(map, '_container'); size = vmiXY({ x: Number(vmiGet(container, 'clientWidth')), y: Number(vmiGet(container, 'clientHeight')) }); method = 'dom-client-size'; }
  return size && size.x > 0 && size.y > 0 && size.x <= 100_000 && size.y <= 100_000 ? { size, method } : null;
}

// Feature key used ONLY to group fragments in memory: runtime id first, then a stable cadastral value, else none (geometry fingerprint).
function vmiFeatureKey(feature, mapKey) {
  const explicit = vmiGet(feature, 'id') ?? vmiGet(vmiGet(feature, 'feature'), 'id');
  if (typeof explicit === 'string' || typeof explicit === 'number') return { tier: 'id', value: String(explicit) };
  if (typeof mapKey === 'string' && mapKey !== String(vmiGet(feature, '_leaflet_id'))) return { tier: 'id', value: mapKey };
  const properties = vmiGet(feature, 'properties') || vmiGet(vmiGet(feature, 'feature'), 'properties');
  for (const name of ['idu', 'id']) { const value = vmiGet(properties, name); if (typeof value === 'string' || typeof value === 'number') return { tier: 'property', value: String(value) }; }
  const parts = ['insee', 'section', 'numero'].map(name => vmiGet(properties, name)).filter(value => typeof value === 'string' || typeof value === 'number');
  return parts.length >= 2 ? { tier: 'property', value: parts.join('/') } : null;
}
// `only` (MVP-05A): Map of renderer `_features` keys -> opaque style class. Only those entries are kept, keyed by that map key,
// which is the key VectorGrid uses for `_overriddenStyles` (not `feature.id`). `stats.nonParcel` collects keys seen in a non-parcel layer.
function vmiTileFeatures(tile, L, G, only, stats) {
  const out = []; const seen = new Set(); const add = (feature, mapKey) => {
    if (!feature || typeof feature !== 'object' || seen.has(feature) || out.length >= VMI_MAX_FEATURES) return; seen.add(feature);
    if (vmiGeometryType(feature, L) !== 'Polygon') return;
    const rings = G.vcgNormalizeParts(vmiGet(feature, '_parts')); if (!rings.length) return;
    out.push(only ? { key: { tier: 'id', value: String(mapKey) }, rings, group: only.get(String(mapKey)) } : { key: vmiFeatureKey(feature, mapKey), rings });
  };
  const features = vmiGet(tile, '_features'); const featureIds = vmiKeys(features, VMI_MAX_FEATURES);
  if (featureIds.length) {
    for (const id of featureIds) {
      if (only && !only.has(id)) continue;
      const entry = vmiGet(features, id); const name = vmiGet(entry, 'layerName');
      if (typeof name === 'string' && !VMI_TILE_PARCEL.test(name)) { if (only && stats) stats.nonParcel.add(id); continue; }
      add(vmiGet(entry, 'feature') || entry, id);
    }
  } else if (!only) { const layers = vmiGet(tile, '_layers'); for (const id of vmiKeys(layers, VMI_MAX_FEATURES)) add(vmiGet(layers, id), undefined); }
  return out;
}
function vmiCadastreTiles(layer, map, L, G, only, stats) {
  const tileZoom = vmiGet(layer, '_tileZoom'); const zoom = vmiZoom(map);
  if (!Number.isFinite(tileZoom) || zoom === undefined) return null;
  const viewport = vmiViewport(map); if (!viewport) return null;
  const { size, method: viewportMethod } = viewport;
  const mapZoom = vmiCall(map, 'getZoom');
  const scale = vmiCall(map, 'getZoomScale', mapZoom, tileZoom) ?? 2 ** (mapZoom - tileZoom);
  const tileSizeValue = vmiCall(layer, 'getTileSize') ?? vmiGet(vmiGet(layer, 'options'), 'tileSize');
  const tileSize = vmiXY(tileSizeValue) || (Number.isFinite(tileSizeValue) ? { x: tileSizeValue, y: tileSizeValue } : { x: 256, y: 256 });
  const pixelOrigin = vmiXY(vmiCall(map, 'getPixelOrigin'));
  if (!Number.isFinite(scale) || scale <= 0 || !pixelOrigin || tileSize.x <= 0 || tileSize.y <= 0) return null;
  const hasPane = typeof vmiGet(map, 'layerPointToContainerPoint') === 'function';
  const vectorTiles = vmiGet(layer, '_vectorTiles'); const cache = vmiGet(layer, '_tiles');
  const tiles = []; let tilesInViewport = 0;
  const keys = vmiKeys(vectorTiles, VMI_MAX_TILES).map(key => {
    const coords = vmiGet(vmiGet(cache, key), 'coords') || (() => { const m = /^(-?\d+):(-?\d+):(-?\d+)$/.exec(key); return m ? { x: +m[1], y: +m[2], z: +m[3] } : null; })();
    return { key, coords };
  }).filter(item => item.coords && item.coords.z === tileZoom && Number.isFinite(item.coords.x) && Number.isFinite(item.coords.y)).sort((a, b) => a.coords.y - b.coords.y || a.coords.x - b.coords.x);
  for (const { key, coords } of keys) {
    const tile = vmiGet(vectorTiles, key); if (!tile || typeof tile !== 'object') continue;
    const layerPoint = { x: coords.x * tileSize.x * scale - pixelOrigin.x, y: coords.y * tileSize.y * scale - pixelOrigin.y };
    const origin = hasPane ? vmiXY(vmiCall(map, 'layerPointToContainerPoint', layerPoint)) : layerPoint;
    if (!origin) return null;
    if (origin.x < size.x && origin.y < size.y && origin.x + tileSize.x * scale > 0 && origin.y + tileSize.y * scale > 0) tilesInViewport++;
    tiles.push({ origin, tileSize, scale, features: vmiTileFeatures(tile, L, G, only, stats) });
  }
  return { tiles, tilesInViewport, size, zoom, tileZoom, scale, viewportMethod, hasPane };
}
// Tile-local pixel parts -> Leaflet container pixels, using only public Leaflet primitives; the map is never moved.
function vmiVisibleCadastre(layer, map, L, G) {
  const fail = status => ({ type: 'visible-cadastre', status });
  const built = vmiCadastreTiles(layer, map, L, G);
  if (!built) return fail('no-geometry');
  const { tiles, tilesInViewport, size, zoom, tileZoom, scale, viewportMethod, hasPane } = built;
  const tileSize = tiles[0]?.tileSize || vmiXY(vmiCall(layer, 'getTileSize')) || { x: 256, y: 256 };
  const { features, counts } = G.vcgAssemble({ viewport: { width: size.x, height: size.y }, tiles });
  if (!features.length) return fail('empty-view');
  return {
    type: 'visible-cadastre', status: 'ready', viewport: { width: size.x, height: size.y }, zoom, features,
    counts: { ...counts, tiles: tiles.length, tilesInViewport },
    diagnostics: { tileSize: { width: tileSize.x, height: tileSize.y }, tileZoom, zoomScale: Math.round(scale * 1000) / 1000, viewportMethod, pixelOriginMethod: hasPane ? 'map.getPixelOrigin+layerPointToContainerPoint' : 'map.getPixelOrigin', transformMethod: 'tile-local-px*zoomScale+tile-origin', clippingMethod: 'sutherland-hodgman-viewport-rect', dedupMethod: 'feature-id>property>geometry-fingerprint' }
  };
}

// ---- MVP-03C: selected parcels. Walks the Leaflet objects already in memory (data properties only); the map is never touched.
const VMI_MAX_SELECTION_OBJECTS = 20_000;
const VMI_MAX_DESCENDANTS = 5_000;
const VMI_SELECTION_PANE = /^[A-Za-z0-9_.-]{1,64}$/;
function vmiIsA(layer, L, name) { const Class = vmiPath(L, name); try { return typeof Class === 'function' && layer instanceof Class; } catch { return false; } }
function vmiHash(text) { let hash = 0x811c9dc5; for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; } return hash >>> 0; }
function vmiScalarSig(source, names) { return vmiHash(names.map(name => { const value = vmiGet(source, name); return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? `${name}=${value}` : name; }).join('|')); }
const vmiIsLatLng = value => Boolean(value) && typeof value === 'object' && Number.isFinite(vmiGet(value, 'lat')) && Number.isFinite(vmiGet(value, 'lng'));
// Rings of an L.Polygon `_latlngs`: a ring list, or nested lists for a MultiPolygon.
function vmiLatLngRings(value, out = [], depth = 0) {
  if (!Array.isArray(value) || depth > 5 || out.length > 5_000) return out;
  if (value.length && value.every(vmiIsLatLng)) out.push(value); else for (const item of value) vmiLatLngRings(item, out, depth + 1);
  return out;
}
function vmiPathStats(layer, L) {
  const rings = vmiLatLngRings(vmiGet(layer, '_latlngs'));
  return { polygon: vmiIsA(layer, L, 'Polygon'), rings: rings.length, vertices: rings.reduce((total, ring) => total + ring.length, 0), styleSig: vmiScalarSig(vmiGet(layer, 'options'), ['color', 'fillColor', 'fill', 'stroke', 'weight', 'opacity', 'fillOpacity', 'dashArray', 'className']) };
}
function vmiRole(layer, L, kind) {
  if (kind === 'wms') return 'wms'; if (kind === 'vectorgrid' || kind === 'vectortilelayer') return 'vectorgrid'; if (kind === 'raster') return 'tile';
  if (vmiIsA(layer, L, 'Renderer') || vmiIsA(layer, L, 'Canvas') || vmiIsA(layer, L, 'SVG')) return 'renderer';
  if (vmiIsA(layer, L, 'Path')) return 'path';
  const children = vmiGet(layer, '_layers'); return children && typeof children === 'object' && !vmiGet(layer, '_tiles') ? 'group' : 'other';
}
function vmiGroupStats(group, L, visited = new Set(), depth = 0) {
  const stats = { childCount: 0, pathCount: 0, polygonCount: 0, vertexCount: 0, childIds: [] };
  const children = vmiGet(group, '_layers'); if (!children || typeof children !== 'object' || visited.has(group) || depth > 4) return stats;
  visited.add(group);
  for (const id of vmiKeys(children, VMI_MAX_DESCENDANTS)) {
    const child = vmiGet(children, id); if (!child || typeof child !== 'object') continue;
    stats.childCount++; if (depth === 0) stats.childIds.push(id);
    if (vmiIsA(child, L, 'Path')) { const path = vmiPathStats(child, L); stats.pathCount++; if (path.polygon) stats.polygonCount++; stats.vertexCount += path.vertices; }
    else if (vmiGet(child, '_layers')) { const inner = vmiGroupStats(child, L, visited, depth + 1); stats.pathCount += inner.pathCount; stats.polygonCount += inner.polygonCount; stats.vertexCount += inner.vertexCount; }
  }
  return stats;
}
function vmiDomStats(map) {
  const out = { svgCount: 0, canvasCount: 0, svgPathCount: 0, panes: {} };
  const container = vmiGet(map, '_container'); if (!container || typeof container.querySelectorAll !== 'function') return out;
  try {
    out.svgCount = Math.min(container.querySelectorAll('svg').length, 100_000); out.canvasCount = Math.min(container.querySelectorAll('canvas').length, 100_000); out.svgPathCount = Math.min(container.querySelectorAll('svg path').length, 1_000_000);
    for (const pane of Array.from(container.querySelectorAll('.leaflet-pane')).slice(0, 32)) {
      const match = /(?:^|\s)leaflet-([A-Za-z0-9_-]{1,48})-pane(?:\s|$)/.exec(String(pane.className?.baseVal ?? pane.className ?? ''));
      if (match) out.panes[match[1]] = Math.min(Number(pane.children?.length) || 0, 1_000_000);
    }
  } catch {}
  return out;
}
const vmiRendererKey = family => (family === 'Canvas' || family === 'SVG' ? family : 'Unknown');
function vmiSelectionSnapshot(map, L, global) {
  const layers = []; let layersTruncated = false;
  const paths = { count: 0, polygons: 0, rings: 0, vertices: 0, parented: 0, parentless: 0, styleVariants: 0, styleSig: 0, byPane: {} };
  const renderers = { count: 0, families: {}, paneRenderers: vmiCount(vmiGet(map, '_paneRenderers')), defaultRenderer: Boolean(vmiGet(map, '_renderer')) };
  const objects = vmiGet(map, '_layers'); const ids = vmiKeys(objects, VMI_MAX_SELECTION_OBJECTS);
  const childOf = new Set(); const styles = new Set(); const pending = [];
  for (const id of ids) {
    const layer = vmiGet(objects, id); if (!layer || typeof layer !== 'object') continue;
    const { kind } = vmiClassify(layer, L, global); const role = vmiRole(layer, L, kind);
    if (kind === 'mask') continue;
    if (role === 'path') { pending.push({ id, layer }); continue; }
    const options = vmiGet(layer, 'options') || {}; const pane = vmiGet(options, 'pane');
    const group = role === 'group' ? vmiGroupStats(layer, L) : { childCount: 0, pathCount: 0, polygonCount: 0, vertexCount: 0, childIds: [] };
    for (const childId of group.childIds) childOf.add(childId);
    const family = role === 'renderer' ? vmiRendererFamily(layer, L) : vmiRendererFamily(vmiGet(layer, '_renderer'), L);
    if (role === 'renderer') { renderers.count++; renderers.families[vmiRendererKey(family)] = (renderers.families[vmiRendererKey(family)] || 0) + 1; }
    if (layers.length >= VMI_MAX_LAYERS) { layersTruncated = true; continue; }
    const wmsParams = vmiGet(layer, 'wmsParams'); const url = vmiGet(layer, '_url');
    layers.push({
      leafletId: vmiInt(vmiGet(layer, '_leaflet_id'), 1e9) ?? 0, kind, role,
      ...(typeof pane === 'string' && VMI_SELECTION_PANE.test(pane) ? { pane } : {}),
      tileCacheCount: vmiCount(vmiGet(layer, '_tiles')), vectorTileCacheCount: vmiCount(vmiGet(layer, '_vectorTiles')),
      childCount: group.childCount, pathCount: group.pathCount, polygonCount: group.polygonCount, vertexCount: group.vertexCount,
      styleOverrides: vmiCount(vmiGet(layer, '_overriddenStyles')),
      ...(family ? { rendererFamily: family } : {}),
      styleSig: role === 'group' || role === 'other' ? vmiScalarSig(options, ['color', 'fillColor', 'fill', 'weight', 'opacity', 'fillOpacity', 'className']) : 0,
      paramsSig: role === 'wms' ? vmiHash(`${typeof url === 'string' ? url : ''}|${vmiKeys(wmsParams).sort().map(key => `${key}=${String(vmiGet(wmsParams, key))}`).join('&')}`) : 0,
      paramKeyCount: vmiCount(wmsParams)
    });
  }
  for (const { id, layer } of pending.slice(0, VMI_MAX_SELECTION_OBJECTS)) {
    const stats = vmiPathStats(layer, L); const pane = vmiGet(vmiGet(layer, 'options'), 'pane'); const paneName = typeof pane === 'string' && VMI_SELECTION_PANE.test(pane) ? pane : 'unknown';
    paths.count++; if (stats.polygon) paths.polygons++; paths.rings += stats.rings; paths.vertices += stats.vertices; styles.add(stats.styleSig);
    if (childOf.has(id)) paths.parented++; else paths.parentless++;
    if (Object.keys(paths.byPane).length < 16 || paneName in paths.byPane) paths.byPane[paneName] = (paths.byPane[paneName] || 0) + 1;
  }
  paths.styleVariants = styles.size; paths.styleSig = vmiHash([...styles].sort((a, b) => a - b).join(','));
  return { layers, layersTruncated, paths, renderers, dom: vmiDomStats(map) };
}

// Leaflet-projected rings when they agree with the public projection, else the public projection of the in-memory latlngs, else clipped parts.
function vmiSelectionRings(layer, map, G) {
  const latlngRings = vmiLatLngRings(vmiGet(layer, '_latlngs'));
  const project = point => vmiXY(vmiCall(map, 'latLngToLayerPoint', point));
  const toContainer = typeof vmiGet(map, 'layerPointToContainerPoint') === 'function' ? point => vmiXY(vmiCall(map, 'layerPointToContainerPoint', point)) : point => point;
  const finish = (rings, method) => {
    const out = [];
    for (const ring of rings) { const converted = ring.map(([x, y]) => toContainer({ x, y })); if (converted.some(point => !point)) return null; out.push(converted.map(point => [point.x, point.y])); }
    return { rings: out, method };
  };
  const fromProjected = G.vcgNormalizeParts(vmiGet(layer, '_rings'));
  if (fromProjected.length) {
    const probe = latlngRings[0] && project(latlngRings[0][0]);
    const agrees = !latlngRings.length || (probe && Math.abs(probe.x - fromProjected[0][0][0]) <= 1.5 && Math.abs(probe.y - fromProjected[0][0][1]) <= 1.5);
    if (agrees) { const done = finish(fromProjected, 'leaflet-rings'); if (done) return done; }
  }
  if (latlngRings.length && project(latlngRings[0][0])) {
    const rings = latlngRings.map(ring => ring.map(project).filter(Boolean).map(point => [point.x, point.y]));
    const normalized = G.vcgNormalizeParts(rings.map(ring => ring.map(([x, y]) => ({ x, y }))));
    if (normalized.length) { const done = finish(normalized, 'latlngs-projected'); if (done) return done; }
  }
  const parts = G.vcgNormalizeParts(vmiGet(layer, '_parts'));
  return parts.length ? finish(parts, 'leaflet-parts') : null;
}
// ---- MVP-04: structured identification of the selection (replaces "every Polygon outside the mask pane").
// Evidence, strongest first: (1) the A/B delta kept in memory, (2) a single vector group holding polygons while the cadastre
// VectorGrid carries style overrides, (3) loose polygons of one pane under the same corroboration (low confidence).
// Anything else is rejected, and several competing candidates are never exported arbitrarily.
function vmiIsMaskPane(pane) { return typeof pane === 'string' && /mask/i.test(pane); }
function vmiSelectionIndex(map, L) {
  const objects = vmiGet(map, '_layers'); const polygons = new Map(); const groups = new Set(); const parentOf = new Map(); let overrides = 0; const overrideKeys = new Set();
  for (const id of vmiKeys(objects, VMI_MAX_SELECTION_OBJECTS)) {
    const layer = vmiGet(objects, id); if (!layer || typeof layer !== 'object') continue;
    overrides += vmiCount(vmiGet(layer, '_overriddenStyles'));
    if (overrideKeys.size < VMI_MAX_FEATURES) for (const key of vmiKeys(vmiGet(layer, '_overriddenStyles'), VMI_MAX_FEATURES)) overrideKeys.add(key);
    const pane = vmiGet(vmiGet(layer, 'options'), 'pane');
    if (vmiIsA(layer, L, 'Polygon')) { if (!vmiIsMaskPane(pane)) polygons.set(id, { layer, pane: typeof pane === 'string' && VMI_SELECTION_PANE.test(pane) ? pane : 'unknown' }); continue; }
    const children = vmiGet(layer, '_layers');
    const holder = children && typeof children === 'object' && !vmiGet(layer, '_tiles') && !vmiGet(layer, '_vectorTiles') && !vmiIsA(layer, L, 'Path') && !vmiIsA(layer, L, 'Renderer') && !vmiIsA(layer, L, 'Canvas') && !vmiIsA(layer, L, 'SVG');
    if (!holder || vmiIsMaskPane(pane)) continue;
    groups.add(id);
    for (const childId of vmiKeys(children, VMI_MAX_DESCENDANTS)) if (!parentOf.has(childId)) parentOf.set(childId, id);
  }
  for (const id of [...polygons.keys()]) { const parent = parentOf.get(id); polygons.get(id).parent = parent !== undefined && groups.has(parent) ? parent : null; }
  return { polygons, groups, overrides, overrideKeys };
}
// What the memory of an A/B capture keeps: opaque Leaflet-internal keys and counters, never geometry. Lost on page reload.
function vmiAbMemory(map, L) {
  const index = vmiSelectionIndex(map, L); const viewport = vmiViewport(map);
  return { polygonIds: new Set(index.polygons.keys()), groupIds: index.groups, overrides: index.overrides, overrideKeys: index.overrideKeys, zoom: vmiZoom(map), width: viewport?.size.x, height: viewport?.size.y };
}
function vmiSelectionSource(index, ab) {
  const reject = (mechanism, evidence, extra = {}) => ({ accepted: null, source: { confidence: 'low', mechanism, evidence, candidateGroups: 0, rejectedPolygons: index.polygons.size, ...extra } });
  const accept = (ids, confidence, mechanism, evidence, candidateGroups) => ({ accepted: ids, source: { confidence, mechanism, evidence, candidateGroups, rejectedPolygons: index.polygons.size - ids.size } });
  const evidence = [];
  const overridesNow = index.overrides > 0;
  if (ab?.A && ab?.B) {
    const sameView = ab.A.zoom === ab.B.zoom && ab.A.width === ab.B.width && ab.A.height === ab.B.height;
    if (!sameView) evidence.push('ab-viewport-changed');
    else {
      // Containers that gained polygons between A and B: a new group, an existing group that grew, or loose polygon layers.
      const containers = new Map();
      const polygonsB = [...ab.B.polygonIds].filter(id => !ab.A.polygonIds.has(id));
      for (const id of polygonsB) { const current = index.polygons.get(id); if (!current) continue; const key = current.parent === null ? 'loose' : `group:${current.parent}`; containers.set(key, { parent: current.parent, existedInA: current.parent !== null && ab.A.groupIds.has(current.parent) }); }
      if (containers.size > 1) return reject('ambiguous-candidates', ['ab-delta', 'several-containers-changed'], { candidateGroups: containers.size });
      if (containers.size === 1) {
        const [container] = containers.values();
        const ids = new Set([...index.polygons].filter(([id, polygon]) => polygon.parent === container.parent && !ab.A.polygonIds.has(id)).map(([id]) => id));
        const mechanism = container.parent === null ? 'ab-delta-new-paths' : container.existedInA ? 'ab-delta-group-modified' : 'ab-delta-new-group';
        const proof = ['ab-delta', container.parent === null ? 'new-path-layers' : container.existedInA ? 'group-existed-in-A' : 'group-absent-in-A', container.parent === null ? 'paths-absent-in-A' : 'path-count-increased'];
        if (ab.B.overrides > ab.A.overrides) proof.push('vectorgrid-style-overrides-increased');
        if (ids.size) return accept(ids, 'high', mechanism, proof, container.parent === null ? 0 : 1);
        evidence.push('ab-delta-container-emptied');
      } else evidence.push('ab-delta-empty');
    }
  }
  const byGroup = new Map(); const loose = [];
  for (const [id, polygon] of index.polygons) { if (polygon.parent === null) loose.push(id); else { if (!byGroup.has(polygon.parent)) byGroup.set(polygon.parent, []); byGroup.get(polygon.parent).push(id); } }
  if (byGroup.size > 1) return reject('ambiguous-candidates', [...evidence, 'several-polygon-groups'], { candidateGroups: byGroup.size });
  if (byGroup.size === 1) {
    if (!overridesNow) return reject('insufficient-evidence', [...evidence, 'polygon-group-without-selection-context'], { candidateGroups: 1 });
    return accept(new Set([...byGroup.values()][0]), 'medium', 'vector-group+style-overrides', [...evidence, 'single-polygon-group', 'vectorgrid-style-overrides-present', ...(loose.length ? ['loose-polygons-ignored'] : [])], 1);
  }
  if (loose.length) {
    const panes = new Set(loose.map(id => index.polygons.get(id).pane));
    if (!overridesNow) return reject('insufficient-evidence', [...evidence, 'polygons-without-selection-context']);
    if (panes.size > 1) return reject('ambiguous-candidates', [...evidence, 'loose-polygons-in-several-panes']);
    return accept(new Set(loose), 'low', 'loose-polygons+style-overrides', [...evidence, 'single-pane-polygons', 'vectorgrid-style-overrides-present'], 0);
  }
  return reject('none', [...evidence, 'no-polygon-layer']);
}
// `rings` (MAIN-world only, never reported): unclipped viewport ring lists of the aggregate polygons, the proof used by the individual matching.
function vmiSelectionAggregate(map, L, G, ab) {
  const emptyCounts = { candidatePolygons: 0, selectedFeaturesDetected: 0, selectedFeaturesVisible: 0, selectedPathsExported: 0, selectedFeaturesClipped: 0, duplicatesHandled: 0, keyTiers: { id: 0, property: 0, geometry: 0 } };
  const none = source => ({ result: { status: 'none', features: [], counts: emptyCounts, diagnostics: { projectionMethods: {}, paneCounts: {} }, source }, rings: null });
  const viewport = vmiViewport(map); const objects = vmiGet(map, '_layers');
  if (!viewport || !objects || !G?.vcgAssemblePaths) return none({ confidence: 'low', mechanism: 'none', evidence: ['map-unavailable'], candidateGroups: 0, rejectedPolygons: 0 });
  const index = vmiSelectionIndex(map, L); const { accepted, source } = vmiSelectionSource(index, ab);
  if (!accepted) return none(source);
  const items = []; const methods = {}; const paneCounts = {};
  for (const id of accepted) {
    const { layer, pane } = index.polygons.get(id);
    const projected = vmiSelectionRings(layer, map, G); if (!projected) continue;
    items.push({ key: vmiFeatureKey(layer), rings: projected.rings });
    methods[projected.method] = (methods[projected.method] || 0) + 1;
    if (Object.keys(paneCounts).length < 16 || pane in paneCounts) paneCounts[pane] = (paneCounts[pane] || 0) + 1;
  }
  if (!items.length) return none({ ...source, mechanism: 'none', confidence: 'low', evidence: [...source.evidence, 'no-projectable-geometry'] });
  const { features, counts } = G.vcgAssemblePaths({ viewport: { width: viewport.size.x, height: viewport.size.y }, items });
  return { result: { status: 'ready', features, counts, diagnostics: { projectionMethods: methods, paneCounts }, source }, rings: items.map(item => item.rings).filter(rings => rings.length) };
}

// ---- MVP-05A: individual selected parcels. VectorGrid.setFeatureStyle(id, style) stores `_overriddenStyles[id]`, and the same id keys
// `tile._features[id]` in every tile that holds a fragment of that feature: that shared key is the association override <-> geometry.
// An override alone does not mean "selected" (hover, other highlights), so the aggregate selection polygon is the proof of membership
// and an A capture (override keys that existed before the selection) removes pre-existing overrides. Keys stay in this scope.
const VMI_STYLE_NAMES = ['color', 'fillColor', 'fill', 'stroke', 'weight', 'opacity', 'fillOpacity', 'dashArray', 'className'];
function vmiOverrideClass(style) {
  let source = style;
  if (source && typeof source === 'object' && !VMI_STYLE_NAMES.some(name => vmiGet(source, name) !== undefined)) { const nested = vmiKeys(source, 8).map(key => vmiGet(source, key)).find(value => value && typeof value === 'object'); if (nested) source = nested; } // style keyed by layer name
  return String(vmiScalarSig(source, VMI_STYLE_NAMES));
}
function vmiIndividualSelection(layer, map, L, G, ab, aggregate) {
  if (typeof G?.vcgSelectIndividual !== 'function') return null;
  const overrides = vmiGet(layer, '_overriddenStyles'); const keys = vmiKeys(overrides, VMI_MAX_FEATURES);
  const before = ab?.A?.overrideKeys; const basis = before ? 'ab-delta' : 'all-overrides';
  const candidates = before ? keys.filter(key => !before.has(key)) : keys;
  const evidence = Boolean(aggregate && aggregate.length) || basis === 'ab-delta'; // otherwise nothing can prove which overrides are the selection: skip the tile walk (this also runs on the status poll)
  const only = new Map(candidates.map(key => [key, vmiOverrideClass(vmiGet(overrides, key))]));
  const stats = { nonParcel: new Set() };
  const built = candidates.length && evidence ? vmiCadastreTiles(layer, map, L, G, only, stats) : { tiles: [], size: vmiViewport(map)?.size };
  if (!built || !built.size) return null;
  const matched = new Set(); for (const tile of built.tiles) for (const feature of tile.features) matched.add(feature.key.value);
  return G.vcgSelectIndividual({ viewport: { width: built.size.x, height: built.size.y }, tiles: built.tiles, aggregate, basis, overrideCount: keys.length, candidateCount: candidates.length, unmatchedCount: candidates.length - matched.size, collisions: [...stats.nonParcel].filter(key => matched.has(key)).length }); // a key naming both a parcel and a non-parcel feature cannot be told apart
}
// The selection that gets exported: individual cadastre features when the evidence is sufficient, else the aggregate polygon (explicit fallback).
function vmiVisibleSelection(layer, map, L, G, ab) {
  const { result, rings } = vmiSelectionAggregate(map, L, G, ab);
  const chosen = vmiIndividualSelection(layer, map, L, G, ab, rings);
  if (!chosen) return result;
  if (chosen.individual.source === 'vectorgrid-overrides') {
    const c = chosen.counts;
    return { ...result, status: 'ready', features: chosen.features, counts: { candidatePolygons: result.counts.candidatePolygons, selectedFeaturesDetected: c.uniqueFeatures, selectedFeaturesVisible: c.visibleFeatures, selectedPathsExported: c.exportedPaths, selectedFeaturesClipped: c.clippedFeatures, duplicatesHandled: c.duplicatesHandled, keyTiers: c.keyTiers }, perFeature: chosen.individual };
  }
  return { ...result, perFeature: { ...chosen.individual, source: result.status === 'ready' ? 'aggregate-geojson' : 'none' } };
}

// ---- MVP-04: basemap. The view reuses the Leaflet primitives of the cadastre so both share one viewport frame.
function vmiBackgroundView(map) {
  const viewport = vmiViewport(map); const pixelOrigin = vmiXY(vmiCall(map, 'getPixelOrigin')); const mapZoom = vmiCall(map, 'getZoom');
  if (!viewport || !pixelOrigin || !Number.isFinite(mapZoom)) return null;
  const hasPane = typeof vmiGet(map, 'layerPointToContainerPoint') === 'function';
  return {
    size: viewport.size, pixelOrigin, mapZoom,
    zoomScale: tileZoom => vmiCall(map, 'getZoomScale', mapZoom, tileZoom) ?? 2 ** (mapZoom - tileZoom),
    toContainer: point => (hasPane ? vmiXY(vmiCall(map, 'layerPointToContainerPoint', point)) : point),
  };
}
// ---- MVP-05B: provenance of the basemap tile layer, read passively from objects already in memory. The URL template is
// matched here and dropped: only closed-vocabulary tokens, counters and the public attribution text leave this function.
const VMI_PROVIDERS = [
  [/(^|\.)tile\.openstreetmap\.org$/, 'osm-foundation-standard'], [/(^|\.)tile\.openstreetmap\.fr$/, 'osm-france'], [/(^|\.)openstreetmap\.[a-z]+$/, 'osm-other-service'],
  [/(^|\.)basemaps\.cartocdn\.com$|(^|\.)cartocdn\.com$/, 'carto'], [/(^|\.)tile\.thunderforest\.com$/, 'thunderforest'], [/(^|\.)api\.maptiler\.com$/, 'maptiler'],
  [/(^|\.)stadiamaps\.com$/, 'stadia'], [/(^|\.)api\.mapbox\.com$/, 'mapbox'], [/(^|\.)(?:data\.geopf\.fr|wxs\.ign\.fr|geoservices\.ign\.fr)$/, 'ign-geoplateforme'],
  [/(^|\.)arcgisonline\.com$/, 'esri'], [/(^|\.)opentopomap\.org$/, 'opentopomap'], [/(^|\.)google\.com$|(^|\.)googleapis\.com$/, 'google'],
];
const VMI_STYLE_HINTS = [[/light_all|light_nolabels|positron/, 'light'], [/dark_all|dark_nolabels|dark-matter/, 'dark'], [/voyager/, 'voyager'], [/topo/, 'topo'], [/ortho|imagery|satellite/, 'imagery'], [/cycle/, 'cycle'], [/\/hot\//, 'humanitarian'], [/outdoors/, 'outdoors'], [/plan/, 'plan'], [/streets?/, 'streets'], [/bright|basic/, 'bright'], [/osm/, 'osm-in-path']];
const VMI_ATTRIBUTION = /^[\p{L}\p{N} ©®™&.,:;()'’\-–\/+]{1,200}$/u;
// Native DOM accessors (location, script.src, script.textContent) are plain reads; Leaflet objects keep going through vmiGet.
function vmiDom(target, key) { try { return target[key]; } catch { return undefined; } }
const vmiRegistrable = host => String(host).split('.').slice(-2).join('.');
function vmiAttribution(texts) {
  const out = new Set();
  for (const text of texts) {
    if (typeof text !== 'string') continue;
    for (const part of text.replace(/<[^>]*>/g, '').replace(/&copy;/gi, '©').replace(/&amp;/gi, '&').replace(/&[a-z#0-9]+;/gi, ' ').split(/\s*[|\n]\s*/)) {
      const clean = part.replace(/\s+/g, ' ').trim();
      if (clean && !/https?:|\/\/|www\./i.test(clean) && VMI_ATTRIBUTION.test(clean) && out.size < 8) out.add(clean);
    }
  }
  return [...out];
}
function vmiStaticHints(global) {
  const flags = new Set(); let inline = 0; let external = 0; let budget = 1_500_000;
  try {
    for (const script of Array.from(vmiDom(vmiDom(global, 'document'), 'scripts') || []).slice(0, 400)) {
      if (vmiDom(script, 'src')) { external++; continue; }
      const text = vmiDom(script, 'textContent'); if (typeof text !== 'string' || !text) continue;
      inline++; const code = text.slice(0, Math.max(0, budget)); budget -= code.length;
      for (const [pattern, flag] of [[/openstreetmap/i, 'inline-mentions-openstreetmap'], [/maplibre/i, 'inline-mentions-maplibre'], [/mapbox/i, 'inline-mentions-mapbox'], [/\.(?:pbf|mvt)\b/i, 'inline-mentions-vector-tile-extension'], [/style\.json/i, 'inline-mentions-style-json']]) if (pattern.test(code)) flags.add(flag);
    }
  } catch {}
  return { inlineScripts: Math.min(inline, 400), externalScripts: Math.min(external, 400), flags: [...flags].sort() };
}
function vmiProvenance(layer, L, global, map) {
  const options = vmiGet(layer, 'options') || {};
  const url = vmiGet(layer, '_url'); const template = typeof url === 'string' ? sanitizeTemplate(url) : null;
  const host = template ? template.hostname.replace('{s}.', '').replace('{s}', '') : '';
  const pageHost = String(vmiDom(vmiDom(global, 'location'), 'hostname') || '').toLowerCase();
  let provider = 'unknown';
  if (template) provider = pageHost && vmiRegistrable(host) === vmiRegistrable(pageHost) ? 'first-party' : (VMI_PROVIDERS.find(([pattern]) => pattern.test(host)) || [null, 'other-third-party'])[1];
  const path = template ? template.pathname.toLowerCase() : '';
  const extension = /\.(png|jpe?g|webp|pbf|mvt)$/.exec(path)?.[1];
  const format = extension ? (extension === 'jpg' ? 'jpeg' : extension === 'mvt' ? 'pbf' : extension) : 'unknown';
  const subdomains = vmiGet(options, 'subdomains');
  const crossOrigin = vmiGet(options, 'crossOrigin');
  const attributionControl = vmiGet(map, 'attributionControl');
  const mapAttributions = vmiKeys(vmiGet(attributionControl, '_attributions'), 32);
  const has = name => { try { const descriptor = Object.getOwnPropertyDescriptor(global, name); return Boolean(descriptor && 'value' in descriptor && descriptor.value); } catch { return false; } };
  const tileSize = vmiGet(options, 'tileSize');
  return {
    provider,
    serviceFamily: !template ? 'unknown' : format === 'pbf' ? 'vector-tiles' : /wmts|service=wmts/i.test(`${path} ${String(url)}`) ? 'wmts' : /\/\{z\}\/\{[xy]\}\/\{[xy]\}/.test(path) ? 'xyz-tiles' : 'unknown',
    format, renderType: format === 'pbf' ? 'vector-tiles' : 'raster-tiles',
    styleHints: VMI_STYLE_HINTS.filter(([pattern]) => pattern.test(path)).map(([, hint]) => hint),
    attribution: vmiAttribution([vmiGet(options, 'attribution'), ...mapAttributions]),
    options: {
      crossOrigin: crossOrigin === true || crossOrigin === '' ? 'anonymous' : crossOrigin === 'anonymous' || crossOrigin === 'use-credentials' ? crossOrigin : 'unset',
      subdomainCount: typeof subdomains === 'string' ? subdomains.length : Array.isArray(subdomains) ? subdomains.length : 0,
      retina: Boolean(vmiGet(options, 'detectRetina')) || (typeof url === 'string' && url.includes('{r}')),
      ...(Number.isFinite(tileSize) && tileSize > 0 && tileSize <= 8192 ? { tileSize } : {}),
      ...(vmiInt(vmiGet(options, 'minZoom'), 30) !== undefined ? { minZoom: vmiInt(vmiGet(options, 'minZoom'), 30) } : {}), ...(vmiInt(vmiGet(options, 'maxZoom'), 30) !== undefined ? { maxZoom: vmiInt(vmiGet(options, 'maxZoom'), 30) } : {}),
    },
    vectorLibraries: { maplibregl: has('maplibregl'), mapboxgl: has('mapboxgl'), leafletGlBridge: Boolean(vmiPath(L, 'maplibreGL') || vmiPath(L, 'mapboxGL')), vectorGrid: Boolean(vmiPath(L, 'VectorGrid')) },
    staticHints: vmiStaticHints(global),
  };
}
function vmiBackground(map, L, global, mode) {
  const B = global.MonTerritoireVisibleBackground; const view = vmiBackgroundView(map);
  if (!B?.vbgCapture || !view) return null;
  const candidates = Object.values(vmiGet(map, '_layers') || {}).slice(0, VMI_MAX_LAYERS).filter(layer => layer && typeof layer === 'object').map(layer => ({ layer, record: vmiLayerRecord(layer, L, global, map) })).filter(item => item.record.kind === 'raster');
  const createCanvas = (width, height) => { const canvas = global.document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas; };
  try {
    const capture = B.vbgCapture({ candidates, view, createCanvas, mode });
    let provenance = null; try { const chosen = B.vbgIdentify(candidates, view).chosen; provenance = chosen ? vmiProvenance(chosen.layer, L, global, map) : null; } catch {}
    return provenance ? { ...capture, provenance } : capture;
  } catch { return null; }
}

function vmiEmptyCandidate() {
  return { status: 'not-found', active: false, tileCache: { tiles: 0, vectorTiles: 0, keyShapes: [] }, decodedFeatures: 0, decodedLayerNames: [], decodedGeometry: { present: false, representations: [], geometryTypes: {}, featuresWithGeometry: 0, vertexCount: 0, ringCount: 0, featureIdsPresent: 0, rendererFamilies: {}, stores: { featureMaps: 0, rendererLayers: 0, decodedLayers: 0 } }, propertyKeys: [], rendererOnly: false, evidence: [], score: 0, exportability: { status: 'unknown', featureToGeometry: false, featureToTile: false, tileToViewport: false, requiresNetwork: false } };
}

export function createVisibleMapInspector(global = globalThis) {
  const hooked = []; let hookInstalled = false; const ab = { A: null, B: null };
  const mapOf = candidates => candidates.reduce((best, map) => (!best || vmiArea(map) > vmiArea(best) ? map : best), null);
  function discover() {
    const attempted = [];
    const L = global.L;
    attempted.push('global-property');
    const found = [];
    try {
      for (const key of Object.getOwnPropertyNames(global).slice(0, VMI_MAX_GLOBALS)) {
        let descriptor; try { descriptor = Object.getOwnPropertyDescriptor(global, key); } catch { continue; }
        if (descriptor && 'value' in descriptor && descriptor.value !== L && vmiIsMap(descriptor.value) && !found.includes(descriptor.value)) found.push(descriptor.value);
      }
    } catch {}
    if (found.length) return { method: 'global-property', attempted, maps: found };
    attempted.push('container-property');
    let containers = []; try { containers = Array.from(global.document?.querySelectorAll?.('.leaflet-container') || []).slice(0, 20); } catch {}
    for (const container of containers) {
      try {
        for (const key of Object.getOwnPropertyNames(container).slice(0, 200)) {
          const descriptor = Object.getOwnPropertyDescriptor(container, key);
          if (descriptor && 'value' in descriptor && vmiIsMap(descriptor.value) && !found.includes(descriptor.value)) found.push(descriptor.value);
        }
      } catch {}
    }
    if (found.length) return { method: 'container-property', attempted, maps: found };
    attempted.push('init-hook');
    const hookedMaps = hooked.filter(vmiIsMap);
    if (hookedMaps.length) return { method: 'init-hook', attempted, maps: hookedMaps };
    return { method: 'none', attempted, maps: [] };
  }
  function locateMap() { const discovery = discover(); return { L: global.L, discovery, map: mapOf(discovery.maps) }; }
  function locate() {
    const { L, discovery, map } = locateMap();
    if (!map) return { L, discovery, map: null, layers: [], best: null };
    const layerObjects = Object.values(vmiGet(map, '_layers') || {}).slice(0, VMI_MAX_LAYERS);
    const layers = []; let best = null;
    for (const layer of layerObjects) {
      if (!layer || typeof layer !== 'object') continue;
      const record = vmiLayerRecord(layer, L, global, map); layers.push(record);
      if (record.kind !== 'vectorgrid' && record.kind !== 'vectortilelayer' && record.kind !== 'geojson-vector') continue;
      const inspection = vmiInspectTiles(layer, L, map);
      const styles = vmiKeys(vmiGet(vmiGet(layer, 'options'), 'vectorTileLayerStyles'), VMI_MAX_KEYS).filter(name => VMI_LAYER_NAME.test(name));
      const { score, evidence } = vmiScore(record, inspection, styles);
      if (score >= 3 && (!best || score > best.score || (score === best.score && inspection.decodedFeatures > best.inspection.decodedFeatures))) best = { layer, record, inspection, score, evidence };
    }
    return { L, discovery, map, layers, best };
  }
  return {
    // Leaflet's public addInitHook only observes `this`; it wraps nothing and cannot change a map.
    installDiscovery() {
      if (hookInstalled) return true;
      const add = vmiPath(global.L, 'Map.addInitHook');
      if (typeof add !== 'function') return false;
      try { add.call(global.L.Map, function () { if (hooked.length < 8) hooked.push(this); }); hookInstalled = true; } catch {}
      return hookInstalled;
    },
    capture() {
      const { discovery, map, layers, best } = locate();
      const base = { schemaVersion: 1, inspection: 'visible-map-runtime', 'no-additional-network-requests': true, discovery: { method: discovery.method, attempted: discovery.attempted, mapCount: discovery.maps.length, hookInstalled } };
      if (!map) return { ...base, map: { status: 'not-found', layerCount: 0 }, layers: [], cadastreCandidate: vmiEmptyCandidate() };
      const zoom = vmiZoom(map);
      const crs = vmiGet(vmiGet(vmiGet(map, 'options'), 'crs'), 'code');
      const cadastreCandidate = best ? { status: 'found', leafletId: best.record.leafletId, engine: best.record.kind === 'vectorgrid' ? 'VectorGrid' : best.record.kind === 'vectortilelayer' ? 'VectorTileLayer' : 'GeoJSON', active: best.record.attached, score: best.score, evidence: best.evidence, ...best.inspection } : vmiEmptyCandidate();
      return { ...base, map: { status: 'found', ...(zoom !== undefined ? { zoom } : {}), layerCount: vmiCount(vmiGet(map, '_layers')), ...(typeof crs === 'string' && /^[A-Za-z0-9:_.-]{1,24}$/.test(crs) ? { crs } : {}) }, layers, cadastreCandidate };
    },
    // MVP-03B: the cadastre geometry currently visible, in viewport pixels. Reads memory only; { dryRun } stops after the availability check.
    visibleCadastre({ dryRun = false } = {}) {
      const { map, best, L } = locate(); const G = global.MonTerritoireVisibleCadastreGeometry;
      if (!map) return { type: 'visible-cadastre', status: 'no-map' };
      if (!best) return { type: 'visible-cadastre', status: 'no-cadastre' };
      const usable = best.inspection.decodedGeometry.representations.includes('leaflet-pixel-parts') && best.inspection.exportability.tileToViewport && G;
      if (!usable) return { type: 'visible-cadastre', status: 'no-geometry' };
      if (dryRun) {
        // Availability answer: what the next export would contain. The basemap is only probed for readability, never composed.
        const selection = vmiVisibleSelection(best.layer, map, L, G, ab); const background = vmiBackground(map, L, global, 'status');
        return { type: 'visible-cadastre', status: 'ready', summary: { selection: { state: selection.status === 'ready' ? 'ready' : selection.source.mechanism === 'ambiguous-candidates' ? 'ambiguous' : 'none', count: selection.counts.selectedFeaturesVisible }, background: { state: background?.status === 'embeddable' ? 'embeddable' : 'not-embeddable' } } };
      }
      const result = vmiVisibleCadastre(best.layer, map, L, G);
      if (result.status !== 'ready') return result;
      const background = vmiBackground(map, L, global, 'export');
      return { ...result, selection: vmiVisibleSelection(best.layer, map, L, G, ab), ...(background ? { background } : {}) };
    },
    // MVP-06: DOM elements that must not appear in the rendered basemap capture, grouped by role. Nothing is mutated here:
    // the isolation module hides them with a reversible visibility override. A selection that cannot be tied to a DOM
    // element, and any other layer, is left alone and only counted.
    captureTargets() {
      const { map, best, L } = locate(); if (!map) return null;
      const container = vmiGet(map, '_container'); const view = vmiBackgroundView(map); if (!container || !view) return null;
      const groups = { cadastre: [], selection: [], mask: [], controls: [], overlays: [] };
      const cadastre = best ? vmiGet(best.layer, '_container') : null; if (cadastre) groups.cadastre.push(cadastre);
      try {
        const index = vmiSelectionIndex(map, L); const { accepted } = vmiSelectionSource(index, ab);
        for (const id of accepted || []) {
          const layer = index.polygons.get(id)?.layer; if (!layer) continue;
          const path = vmiGet(layer, '_path'); const holder = vmiGet(vmiGet(layer, '_renderer'), '_container');
          const element = path || holder; if (element) groups.selection.push(element);
        }
      } catch {}
      // Positive basemap keep-set: the identified basemap tile layer, and plain raster TileLayers with decoded tile images
      // (thematic). WMS or otherwise unclassified rasters are UNKNOWN: hidden, never trusted as background.
      const layers = Object.values(vmiGet(map, '_layers') || {}).slice(0, VMI_MAX_LAYERS).filter(layer => layer && typeof layer === 'object');
      for (const layer of layers) {
        const pane = vmiGet(vmiGet(layer, 'options'), 'pane');
        if (vmiIsMaskPane(pane)) { const element = vmiCall(map, 'getPane', pane); if (element) groups.mask.push(element); }
      }
      const B = global.MonTerritoireVisibleBackground; const candidates = layers.map(layer => ({ layer, record: vmiLayerRecord(layer, L, global, map) })).filter(item => item.record.kind === 'raster');
      let identified = { status: 'not-found', chosen: null };
      try { identified = B?.vbgIdentify?.(candidates, view) || identified; } catch {}
      const layerElement = layer => { const element = vmiGet(layer, '_container'); return element && typeof element === 'object' ? element : null; };
      const basemap = []; const thematic = []; const unknownRaster = [];
      const chosen = identified.status === 'found' ? identified.chosen?.layer : null;
      if (chosen && layerElement(chosen)) basemap.push(layerElement(chosen));
      for (const layer of layers) {
        if (layer === chosen || layer === best?.layer || !vmiGet(layer, '_tiles') || vmiGet(layer, '_vectorTiles')) continue;
        const element = layerElement(layer); if (!element || vmiIsMaskPane(vmiGet(vmiGet(layer, 'options'), 'pane'))) continue;
        const plain = chosen && !vmiGet(layer, 'wmsParams') && candidates.some(item => item.layer === layer);
        (plain ? thematic : unknownRaster).push(element);
      }
      const query = selector => { try { return Array.from(container.querySelectorAll(selector)); } catch { return []; } };
      groups.mask.push(...query('.leaflet-mask-pane'));
      groups.controls.push(...query('.leaflet-control-container'));
      groups.overlays.push(...query('.leaflet-marker-pane, .leaflet-shadow-pane, .leaflet-popup-pane, .leaflet-tooltip-pane'));
      return { container, groups, basemap, thematic, unknownRaster, basemapStatus: identified.status === 'found' ? 'found' : identified.status === 'ambiguous' ? 'ambiguous' : 'not-found', signature: () => { const now = vmiBackgroundView(map); return now ? `${now.size.x}|${now.size.y}|${now.mapZoom}|${now.pixelOrigin.x}|${now.pixelOrigin.y}` : null; } };
    },
    // MVP-03C: structural snapshot used for the A (no selection) / B (selection) comparison. Counters, class families and hashes only.
    selectionCapture(slot) {
      const { L, discovery, map } = locateMap();
      const base = { schemaVersion: 1, inspection: 'visible-selection', 'no-additional-network-requests': true };
      const empty = { layers: [], layersTruncated: false, paths: { count: 0, polygons: 0, rings: 0, vertices: 0, parented: 0, parentless: 0, styleVariants: 0, styleSig: 0, byPane: {} }, renderers: { count: 0, families: {}, paneRenderers: 0, defaultRenderer: false }, dom: { svgCount: 0, canvasCount: 0, svgPathCount: 0, panes: {} } };
      if (!map) return { ...base, map: { status: 'not-found', layerCount: 0 }, ...empty };
      if (slot === 'A' || slot === 'B') ab[slot] = vmiAbMemory(map, L);
      const zoom = vmiZoom(map); const viewport = vmiViewport(map);
      return { ...base, map: { status: 'found', ...(zoom !== undefined ? { zoom } : {}), ...(viewport ? { width: viewport.size.x, height: viewport.size.y } : {}), layerCount: vmiCount(vmiGet(map, '_layers')) }, ...vmiSelectionSnapshot(map, L, global) };
    }
  };
}
if (typeof window !== 'undefined') {
  globalThis.MonTerritoireVisibleMapInspector = createVisibleMapInspector(globalThis);
  const retry = () => { try { globalThis.MonTerritoireVisibleMapInspector.installDiscovery(); } catch {} };
  retry(); document.addEventListener('DOMContentLoaded', retry, { once: true }); globalThis.addEventListener('load', retry, { once: true });
}
