// MVP-03A, isolated world. Closed-schema validation of MAIN-world captures, A/B comparison,
// deterministic conclusion and the sanitized report. Pure data in, pure data out: no DOM, no network.
const VMR_METHODS = new Set(['global-property', 'container-property', 'init-hook', 'none']);
const VMR_KINDS = new Set(['raster', 'wms', 'vectorgrid', 'vectortilelayer', 'geojson-vector', 'mask', 'unknown']);
const VMR_CONFIDENCE = new Set(['high', 'medium', 'low']);
const VMR_ENGINES = new Set(['VectorGrid', 'VectorTileLayer', 'GeoJSON']);
const VMR_EXPORTABILITY = new Set(['direct-geometry', 'renderer-geometry', 'not-recoverable', 'unknown']);
const VMR_TOKEN = /^[A-Za-z0-9_.:-]{1,96}$/;
const VMR_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,47}$/;
const VMR_SHAPE = /^(?:[n:,_ -]{1,24}|other)$/;
const VMR_HOST = /^[a-z0-9{}.-]{1,253}$/;
const VMR_MAX_LAYERS = 200;
const VMR_MAX_LIST = 64;

function vmrObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function vmrExact(value, keys) { return vmrObject(value) && Object.keys(value).every(key => keys.includes(key)); }
function vmrHas(value, keys) { return keys.every(key => value[key] !== undefined); }
function vmrInt(value, maximum = 1e9) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function vmrList(value, test, limit = VMR_MAX_LIST) { return Array.isArray(value) && value.length <= limit && value.every(test); }
function vmrCounts(value, allowed) { return vmrObject(value) && Object.keys(value).every(key => allowed.includes(key) && vmrInt(value[key])); }

function vmrTemplate(value) {
  if (!vmrExact(value, ['hostname', 'pathname']) || typeof value.hostname !== 'string' || !VMR_HOST.test(value.hostname)) return null;
  if (typeof value.pathname !== 'string' || value.pathname.length > 512 || !value.pathname.startsWith('/') || /[?#%\u0000-\u001f\u007f]/.test(value.pathname)) return null;
  return { hostname: value.hostname, pathname: value.pathname };
}
function vmrLayer(value) {
  const keys = ['leafletId', 'kind', 'confidence', 'evidence', 'family', 'attached', 'pane', 'zIndex', 'tileZoom', 'tileCacheCount', 'vectorTileCacheCount', 'rendererFamily', 'hasCanvas', 'hasSvg', 'hasContainer', 'structuralKeys', 'templatePattern'];
  if (!vmrExact(value, keys) || !vmrHas(value, ['leafletId', 'kind', 'confidence', 'evidence', 'family', 'attached', 'tileCacheCount', 'vectorTileCacheCount', 'hasCanvas', 'hasSvg', 'hasContainer', 'structuralKeys'])) return null;
  if (!vmrInt(value.leafletId) || !VMR_KINDS.has(value.kind) || !VMR_CONFIDENCE.has(value.confidence) || !vmrList(value.evidence, item => typeof item === 'string' && VMR_TOKEN.test(item), 16) || !vmrList(value.family, item => typeof item === 'string' && VMR_TOKEN.test(item), 8)) return null;
  if (typeof value.attached !== 'boolean' || ['hasCanvas', 'hasSvg', 'hasContainer'].some(key => typeof value[key] !== 'boolean') || !vmrInt(value.tileCacheCount) || !vmrInt(value.vectorTileCacheCount)) return null;
  if (!vmrList(value.structuralKeys, item => typeof item === 'string' && VMR_NAME.test(item), 16)) return null;
  if ((value.pane !== undefined && !(typeof value.pane === 'string' && VMR_TOKEN.test(value.pane))) || (value.zIndex !== undefined && !(Number.isSafeInteger(value.zIndex) && Math.abs(value.zIndex) < 1e6)) || (value.tileZoom !== undefined && !vmrInt(value.tileZoom, 64)) || (value.rendererFamily !== undefined && !['Canvas', 'SVG', 'Unknown'].includes(value.rendererFamily))) return null;
  let templatePattern; if (value.templatePattern !== undefined) { templatePattern = vmrTemplate(value.templatePattern); if (!templatePattern) return null; }
  return { leafletId: value.leafletId, kind: value.kind, confidence: value.confidence, evidence: [...value.evidence], family: [...value.family], attached: value.attached, ...(value.pane !== undefined ? { pane: value.pane } : {}), ...(value.zIndex !== undefined ? { zIndex: value.zIndex } : {}), ...(value.tileZoom !== undefined ? { tileZoom: value.tileZoom } : {}), tileCacheCount: value.tileCacheCount, vectorTileCacheCount: value.vectorTileCacheCount, ...(value.rendererFamily ? { rendererFamily: value.rendererFamily } : {}), hasCanvas: value.hasCanvas, hasSvg: value.hasSvg, hasContainer: value.hasContainer, structuralKeys: [...value.structuralKeys], ...(templatePattern ? { templatePattern } : {}) };
}
function vmrCandidate(value) {
  const keys = ['status', 'leafletId', 'engine', 'active', 'score', 'evidence', 'tileCache', 'decodedFeatures', 'decodedLayerNames', 'decodedGeometry', 'propertyKeys', 'rendererOnly', 'exportability'];
  if (!vmrExact(value, keys) || !['found', 'not-found'].includes(value.status) || typeof value.active !== 'boolean' || !vmrInt(value.score, 100) || !vmrInt(value.decodedFeatures) || typeof value.rendererOnly !== 'boolean') return null;
  if ((value.leafletId !== undefined && !vmrInt(value.leafletId)) || (value.engine !== undefined && !VMR_ENGINES.has(value.engine))) return null;
  if (!vmrList(value.evidence, item => typeof item === 'string' && VMR_TOKEN.test(item), 16) || !vmrList(value.decodedLayerNames, item => typeof item === 'string' && VMR_TOKEN.test(item)) || !vmrList(value.propertyKeys, item => typeof item === 'string' && VMR_NAME.test(item))) return null;
  const cache = value.tileCache; if (!vmrExact(cache, ['tiles', 'vectorTiles', 'keyShapes']) || !vmrInt(cache.tiles) || !vmrInt(cache.vectorTiles) || !vmrList(cache.keyShapes, item => typeof item === 'string' && VMR_SHAPE.test(item), 4)) return null;
  const geometry = value.decodedGeometry; if (!vmrExact(geometry, ['present', 'representations', 'geometryTypes', 'featuresWithGeometry', 'vertexCount', 'ringCount', 'featureIdsPresent', 'rendererFamilies', 'stores']) || typeof geometry.present !== 'boolean' || !vmrList(geometry.representations, item => typeof item === 'string' && VMR_TOKEN.test(item), 12) || !vmrCounts(geometry.geometryTypes, ['Point', 'LineString', 'Polygon', 'Unknown']) || !['featuresWithGeometry', 'vertexCount', 'ringCount', 'featureIdsPresent'].every(key => vmrInt(geometry[key])) || !vmrCounts(geometry.rendererFamilies, ['Canvas', 'SVG', 'Unknown']) || !vmrExact(geometry.stores, ['featureMaps', 'rendererLayers', 'decodedLayers']) || !Object.values(geometry.stores).every(item => vmrInt(item))) return null;
  const exportability = value.exportability; if (!vmrExact(exportability, ['status', 'featureToGeometry', 'featureToTile', 'tileToViewport', 'requiresNetwork']) || !VMR_EXPORTABILITY.has(exportability.status) || ['featureToGeometry', 'featureToTile', 'tileToViewport', 'requiresNetwork'].some(key => typeof exportability[key] !== 'boolean')) return null;
  return { status: value.status, ...(value.leafletId !== undefined ? { leafletId: value.leafletId } : {}), ...(value.engine ? { engine: value.engine } : {}), active: value.active, score: value.score, evidence: [...value.evidence], tileCache: { tiles: cache.tiles, vectorTiles: cache.vectorTiles, keyShapes: [...cache.keyShapes] }, decodedFeatures: value.decodedFeatures, decodedLayerNames: [...value.decodedLayerNames], decodedGeometry: { present: geometry.present, representations: [...geometry.representations], geometryTypes: { ...geometry.geometryTypes }, featuresWithGeometry: geometry.featuresWithGeometry, vertexCount: geometry.vertexCount, ringCount: geometry.ringCount, featureIdsPresent: geometry.featureIdsPresent, rendererFamilies: { ...geometry.rendererFamilies }, stores: { ...geometry.stores } }, propertyKeys: [...value.propertyKeys], rendererOnly: value.rendererOnly, exportability: { ...exportability } };
}
export function validateCapture(value) {
  if (!vmrExact(value, ['schemaVersion', 'inspection', 'no-additional-network-requests', 'discovery', 'map', 'layers', 'cadastreCandidate', 'slot'])) return null;
  if (value.schemaVersion !== 1 || value.inspection !== 'visible-map-runtime' || value['no-additional-network-requests'] !== true || (value.slot !== undefined && !['A', 'B'].includes(value.slot))) return null;
  const discovery = value.discovery; if (!vmrExact(discovery, ['method', 'attempted', 'mapCount', 'hookInstalled']) || !VMR_METHODS.has(discovery.method) || !vmrList(discovery.attempted, item => VMR_METHODS.has(item), 4) || !vmrInt(discovery.mapCount, 100) || typeof discovery.hookInstalled !== 'boolean') return null;
  const map = value.map; if (!vmrExact(map, ['status', 'zoom', 'layerCount', 'crs']) || !['found', 'not-found'].includes(map.status) || !vmrInt(map.layerCount) || (map.zoom !== undefined && !(Number.isFinite(map.zoom) && map.zoom >= 0 && map.zoom <= 30)) || (map.crs !== undefined && !(typeof map.crs === 'string' && /^[A-Za-z0-9:_.-]{1,24}$/.test(map.crs)))) return null;
  if (!Array.isArray(value.layers) || value.layers.length > VMR_MAX_LAYERS) return null;
  const layers = value.layers.map(vmrLayer); if (layers.includes(null)) return null;
  const candidate = vmrCandidate(value.cadastreCandidate); if (!candidate) return null;
  return { schemaVersion: 1, inspection: 'visible-map-runtime', 'no-additional-network-requests': true, ...(value.slot ? { slot: value.slot } : {}), discovery: { method: discovery.method, attempted: [...discovery.attempted], mapCount: discovery.mapCount, hookInstalled: discovery.hookInstalled }, map: { status: map.status, ...(map.zoom !== undefined ? { zoom: map.zoom } : {}), layerCount: map.layerCount, ...(map.crs ? { crs: map.crs } : {}) }, layers, cadastreCandidate: candidate };
}

function vmrSum(capture, key) { return (capture?.layers || []).reduce((total, layer) => total + layer[key], 0); }
function vmrSummary(layer) { return { leafletId: layer.leafletId, kind: layer.kind, confidence: layer.confidence, ...(layer.pane ? { pane: layer.pane } : {}), tileCacheCount: layer.tileCacheCount, vectorTileCacheCount: layer.vectorTileCacheCount }; }
function vmrStructures(capture) {
  const set = new Set();
  for (const layer of capture.layers) set.add(`kind:${layer.kind}`);
  for (const name of capture.cadastreCandidate.decodedGeometry.representations) set.add(`representation:${name}`);
  for (const [name, count] of Object.entries(capture.cadastreCandidate.decodedGeometry.stores)) if (count > 0) set.add(`store:${name}`);
  for (const name of capture.cadastreCandidate.propertyKeys) set.add(`property-key:${name}`);
  for (const name of Object.keys(capture.cadastreCandidate.decodedGeometry.rendererFamilies)) set.add(`renderer:${name}`);
  return set;
}
export function compareCaptures(a, b) {
  if (!a || !b) return { available: false, summary: 'comparison unavailable' };
  const before = new Map(a.layers.map(layer => [layer.leafletId, layer])); const after = new Map(b.layers.map(layer => [layer.leafletId, layer]));
  const layersAdded = b.layers.filter(layer => !before.has(layer.leafletId)).map(vmrSummary);
  const layersRemoved = a.layers.filter(layer => !after.has(layer.leafletId)).map(vmrSummary);
  const rendererDelta = {};
  for (const name of new Set([...Object.keys(a.cadastreCandidate.decodedGeometry.rendererFamilies), ...Object.keys(b.cadastreCandidate.decodedGeometry.rendererFamilies)])) {
    const delta = (b.cadastreCandidate.decodedGeometry.rendererFamilies[name] || 0) - (a.cadastreCandidate.decodedGeometry.rendererFamilies[name] || 0); if (delta) rendererDelta[name] = delta;
  }
  const known = vmrStructures(a); const newStructures = [...vmrStructures(b)].filter(item => !known.has(item)).sort();
  const candidate = b.cadastreCandidate;
  const mostLikelyCadastre = candidate.status === 'found' ? { leafletId: candidate.leafletId, engine: candidate.engine, score: candidate.score, evidence: [...candidate.evidence], addedByToggle: layersAdded.some(layer => layer.leafletId === candidate.leafletId) } : null;
  const changed = layersAdded.length || layersRemoved.length || newStructures.length || Object.keys(rendererDelta).length;
  return {
    available: true, layersAdded, layersRemoved, layerCountDelta: b.map.layerCount - a.map.layerCount,
    tileCacheDelta: { tiles: vmrSum(b, 'tileCacheCount') - vmrSum(a, 'tileCacheCount'), vectorTiles: vmrSum(b, 'vectorTileCacheCount') - vmrSum(a, 'vectorTileCacheCount'), decodedFeatures: b.cadastreCandidate.decodedFeatures - a.cadastreCandidate.decodedFeatures },
    rendererDelta, newStructures, mostLikelyCadastre,
    viewport: { sameZoom: a.map.zoom === b.map.zoom },
    summary: changed ? 'structural delta detected' : 'no structural delta'
  };
}

const VMR_NEXT = {
  DIRECT_GEOMETRY_AVAILABLE: 'MVP-03B: lire la geometrie decodee du cadastre dans les tuiles deja en memoire (lien entite, tuile, viewport confirme par le rapport) et la projeter en SVG dans le meme viewport. Aucune requete supplementaire.',
  RENDERER_GEOMETRY_AVAILABLE: 'MVP-03B: exploiter la geometrie conservee par les objets du renderer (coordonnees en pixels de tuile), les replacer par tuile dans le viewport puis les exporter en SVG. Verifier que chaque entite garde sa cle de tuile.',
  TILE_CACHE_WITHOUT_GEOMETRY: 'Les tuiles sont en cache mais sans geometrie recuperable: observer le point de decodage (avant le dessin sur canvas) par une instrumentation passive des objets decodes, ou etudier le rendu raster du canvas. Ne pas rejouer de requete.',
  NO_RUNTIME_GEOMETRY_FOUND: 'Aucune geometrie dans l etat Leaflet: le cadastre est probablement rendu hors des couches Leaflet (worker, canvas separe ou autre moteur). Prochain point d observation: le couple Worker, canvas du cadastre, a identifier avec un nouveau test A/B.',
  INSUFFICIENT_EVIDENCE: 'Preuves insuffisantes: verifier que la carte est chargee, faire la capture A (cadastre desactive) puis la capture B (cadastre active) sans deplacer ni zoomer, puis comparer.'
};
export function concludeRuntime(capture, comparison) {
  const code = (() => {
    if (!capture || capture.map.status !== 'found') return 'INSUFFICIENT_EVIDENCE';
    const candidate = capture.cadastreCandidate;
    if (candidate.status !== 'found') return comparison?.available ? 'NO_RUNTIME_GEOMETRY_FOUND' : 'INSUFFICIENT_EVIDENCE';
    switch (candidate.exportability.status) {
      case 'direct-geometry': return 'DIRECT_GEOMETRY_AVAILABLE';
      case 'renderer-geometry': return 'RENDERER_GEOMETRY_AVAILABLE';
      case 'not-recoverable': return 'TILE_CACHE_WITHOUT_GEOMETRY';
      default: return 'NO_RUNTIME_GEOMETRY_FOUND';
    }
  })();
  return { code, recommendedNextStep: VMR_NEXT[code] };
}

export function buildVisibleMapReport({ captureA, captureB, comparison } = {}) {
  const latest = captureB || captureA || null;
  const compared = comparison || (captureA && captureB ? compareCaptures(captureA, captureB) : { available: false, summary: 'comparison unavailable' });
  return {
    schemaVersion: 1, inspection: 'visible-map-runtime',
    privacy: { coordinates: 'not-retained', tileCoordinates: 'not-retained', propertyValues: 'not-retained', identifiers: 'not-retained', queryStrings: 'removed', networkRequests: 'none-added' },
    map: latest ? { ...latest.map, discovery: latest.discovery } : { status: 'not-captured', layerCount: 0 },
    layers: latest ? latest.layers : [],
    cadastreCandidate: latest ? latest.cadastreCandidate : { status: 'not-captured' },
    comparison: compared,
    conclusion: concludeRuntime(latest, compared)
  };
}
export async function copyVisibleMapReport(report, clipboard = navigator.clipboard) { const text = JSON.stringify(report, null, 2); await clipboard.writeText(text); return text; }

// A/B state for the Diagnostic UI. Captures only come from explicit user clicks; nothing here toggles a layer.
export function createAbSession() {
  const state = { A: null, B: null }; let comparison;
  return {
    state,
    record(slot, capture) {
      if (slot !== 'A' && slot !== 'B') return false;
      const safe = validateCapture({ ...capture, slot }); if (!safe) return false;
      state[slot] = safe; comparison = undefined; return true;
    },
    compare() { comparison = compareCaptures(state.A, state.B); return comparison; },
    report() { return buildVisibleMapReport({ captureA: state.A, captureB: state.B, comparison }); }
  };
}
export function summarizeVisibleMap(capture) {
  if (!capture) return { map: 'not captured', cadastre: 'not captured' };
  const c = capture.cadastreCandidate;
  return {
    map: `${capture.map.status} · zoom ${capture.map.zoom ?? 'n/a'} · ${capture.map.layerCount} layers · via ${capture.discovery.method}`,
    cadastre: c.status === 'found' ? `found · ${c.engine} · active ${c.active} · tiles ${c.tileCache.tiles}/${c.tileCache.vectorTiles} · features ${c.decodedFeatures} · geometry ${c.decodedGeometry.present ? c.decodedGeometry.representations.join('+') : 'none'} · keys ${c.propertyKeys.join(',') || 'none'} · ${c.exportability.status}` : 'not found'
  };
}
globalThis.MonTerritoireVisibleMap = { validateCapture, compareCaptures, concludeRuntime, buildVisibleMapReport, copyVisibleMapReport, createAbSession, summarizeVisibleMap };
