// MVP-03B, isolated world. Closed-schema validation of what the MAIN world reports about the visible
// cadastre, user-facing messages and the identifier-free diagnostic text. Pure: no DOM, no network.
const VCX_MAX_FEATURES = 20_000;
const VCX_MAX_RINGS = 256;
const VCX_MAX_VERTICES = 1_500_000;
const VCX_MAX_DIMENSION = 100_000;
const VCX_STATUSES = new Set(['no-map', 'no-cadastre', 'no-geometry', 'empty-view', 'ready']);
const VCX_METHODS = {
  viewportMethod: new Set(['map.getSize', 'dom-client-size']),
  pixelOriginMethod: new Set(['map.getPixelOrigin+layerPointToContainerPoint', 'map.getPixelOrigin']),
  transformMethod: new Set(['tile-local-px*zoomScale+tile-origin']),
  clippingMethod: new Set(['sutherland-hodgman-viewport-rect']),
  dedupMethod: new Set(['feature-id>property>geometry-fingerprint']),
};
const VCX_COUNTS = ['cachedFeatures', 'uniqueFeatures', 'visibleFeatures', 'exportedPaths', 'clippedFeatures', 'duplicatesHandled', 'tiles', 'tilesInViewport'];
const VCX_SELECTION_COUNTS = ['candidatePolygons', 'selectedFeaturesDetected', 'selectedFeaturesVisible', 'selectedPathsExported', 'selectedFeaturesClipped', 'duplicatesHandled'];
const VCX_PROJECTIONS = new Set(['leaflet-rings', 'latlngs-projected', 'leaflet-parts']);
const VCX_TOKEN = /^[A-Za-z0-9:_.+-]{1,64}$/;
const VCX_CONFIDENCE = new Set(['high', 'medium', 'low']);
const VCX_MECHANISMS = new Set(['ab-delta-new-group', 'ab-delta-group-modified', 'ab-delta-new-paths', 'vector-group+style-overrides', 'loose-polygons+style-overrides', 'ambiguous-candidates', 'insufficient-evidence', 'none']);
const VCX_INDIVIDUAL_SOURCES = new Set(['vectorgrid-overrides', 'aggregate-geojson', 'none']);
const VCX_INDIVIDUAL_BASIS = new Set(['ab-delta', 'all-overrides']);
const VCX_FALLBACK_REASONS = new Set(['none', 'no-overrides', 'no-new-overrides', 'no-matching-features', 'no-selection-evidence', 'geometry-disagreement', 'incomplete-coverage', 'ambiguous-style-groups', 'id-layer-collision']);
const VCX_PROVIDERS = new Set(['osm-foundation-standard', 'osm-france', 'osm-other-service', 'carto', 'thunderforest', 'maptiler', 'stadia', 'mapbox', 'ign-geoplateforme', 'esri', 'opentopomap', 'google', 'first-party', 'other-third-party', 'unknown']);
const VCX_SERVICE_FAMILIES = new Set(['xyz-tiles', 'wmts', 'vector-tiles', 'unknown']);
const VCX_FORMATS = new Set(['png', 'jpeg', 'webp', 'pbf', 'unknown']);
const VCX_STYLE_HINTS = new Set(['light', 'dark', 'voyager', 'topo', 'imagery', 'cycle', 'humanitarian', 'outdoors', 'plan', 'streets', 'bright', 'osm-in-path']);
const VCX_STATIC_FLAGS = new Set(['inline-mentions-openstreetmap', 'inline-mentions-maplibre', 'inline-mentions-mapbox', 'inline-mentions-vector-tile-extension', 'inline-mentions-style-json']);
const VCX_ATTRIBUTION = /^[\p{L}\p{N} ©®™&.,:;()'’\-–\/+]{1,200}$/u;
const VCX_MAX_PIXELS = 2 ** 25;
const VCX_MAX_DATA_URI = 2 ** 26;
const VCX_BACKGROUND_REASONS = new Set(['no-candidate', 'ambiguous', 'no-tiles', 'incomplete', 'cors', 'unreadable', 'too-large', 'canvas-error']);
const VCX_BACKGROUND_METHODS = new Set(['data-uri', 'blob', 'image-element', 'canvas-element']);
const VCX_IMAGE_ACCESS = new Set(['readable', 'partially-readable', 'unavailable-cors', 'unavailable']);
const VCX_BACKGROUND_FALLBACK = 'Fond cartographique non incorporable ; export vectoriel effectué.';
const VCX_MESSAGES = {
  'no-map': 'Carte non détectée.',
  'no-geometry': 'Carte non détectée.',
  'no-cadastre': 'Activez la couche Cadastre.',
  'empty-view': 'Aucune parcelle cadastrale dans la zone affichée.',
  ready: 'Prêt à exporter.',
};

const vcxObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const vcxKeys = (value, allowed) => vcxObject(value) && Object.keys(value).length === allowed.length && allowed.every(key => key in value);
const vcxInt = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;

function vcxValidateCapture(value) {
  if (!vcxObject(value) || value.type !== 'visible-cadastre' || !VCX_STATUSES.has(value.status)) return null;
  if (vcxKeys(value, ['type', 'status'])) return { type: 'visible-cadastre', status: value.status }; // availability answer
  if (value.status === 'ready' && vcxKeys(value, ['type', 'status', 'summary'])) { const summary = vcxSummary(value.summary); return summary ? { type: 'visible-cadastre', status: 'ready', summary } : null; } // availability answer with the content of the next export
  if (value.status !== 'ready') return null;
  const { selection: _selection, background: _background, ...core } = value; // `selection` and `background` are optional so that a cadastre-only capture stays valid
  if (!vcxKeys(core, ['type', 'status', 'viewport', 'zoom', 'features', 'counts', 'diagnostics'])) return null;
  const { viewport, zoom, features, counts, diagnostics } = value;
  if (!vcxKeys(viewport, ['width', 'height']) || !(viewport.width > 0 && viewport.width <= VCX_MAX_DIMENSION && viewport.height > 0 && viewport.height <= VCX_MAX_DIMENSION) || !Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return null;
  if (typeof zoom !== 'number' || !(zoom >= 0 && zoom <= 30)) return null;
  if (!Array.isArray(features) || features.length === 0 || features.length > VCX_MAX_FEATURES) return null;
  if (!vcxObject(counts) || Object.keys(counts).length !== VCX_COUNTS.length + 1 || !VCX_COUNTS.every(key => vcxInt(counts[key], 10_000_000)) || !vcxKeys(counts.keyTiers, ['id', 'property', 'geometry']) || !['id', 'property', 'geometry'].every(key => vcxInt(counts.keyTiers[key], 10_000_000))) return null;
  if (!vcxKeys(diagnostics, ['tileSize', 'tileZoom', 'zoomScale', 'viewportMethod', 'pixelOriginMethod', 'transformMethod', 'clippingMethod', 'dedupMethod']) || !vcxKeys(diagnostics.tileSize, ['width', 'height']) || !vcxInt(diagnostics.tileSize.width, 8192) || !vcxInt(diagnostics.tileSize.height, 8192) || !vcxInt(diagnostics.tileZoom, 30) || typeof diagnostics.zoomScale !== 'number' || !(diagnostics.zoomScale > 0 && diagnostics.zoomScale < 1e6) || !Object.keys(VCX_METHODS).every(key => VCX_METHODS[key].has(diagnostics[key]))) return null;
  const budget = { vertices: 0 };
  const clean = vcxFeatures(features, viewport, budget); if (!clean) return null;
  let selection; if ('selection' in value) { selection = vcxSelection(value.selection, viewport, budget); if (!selection) return null; }
  let background; if ('background' in value) { background = vcxBackground(value.background, viewport); if (!background) return null; }
  return {
    type: 'visible-cadastre', status: 'ready', viewport: { width: viewport.width, height: viewport.height }, zoom, features: clean,
    counts: { ...Object.fromEntries(VCX_COUNTS.map(key => [key, counts[key]])), keyTiers: { id: counts.keyTiers.id, property: counts.keyTiers.property, geometry: counts.keyTiers.geometry } },
    diagnostics: { tileSize: { width: diagnostics.tileSize.width, height: diagnostics.tileSize.height }, tileZoom: diagnostics.tileZoom, zoomScale: diagnostics.zoomScale, viewportMethod: diagnostics.viewportMethod, pixelOriginMethod: diagnostics.pixelOriginMethod, transformMethod: diagnostics.transformMethod, clippingMethod: diagnostics.clippingMethod, dedupMethod: diagnostics.dedupMethod },
    ...(selection ? { selection } : {}),
    ...(background ? { background } : {}),
  };
}
// Rings must stay inside the viewport (clipped by the page reader); only pixel pairs are accepted.
function vcxFeatures(features, viewport, budget) {
  const tolerance = 0.01; const clean = [];
  for (const feature of features) {
    if (!vcxKeys(feature, ['rings']) || !Array.isArray(feature.rings) || feature.rings.length === 0 || feature.rings.length > VCX_MAX_RINGS) return null;
    const rings = [];
    for (const ring of feature.rings) {
      if (!Array.isArray(ring) || ring.length < 3 || (budget.vertices += ring.length) > VCX_MAX_VERTICES) return null;
      const points = [];
      for (const point of ring) {
        if (!Array.isArray(point) || point.length !== 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1]) || point[0] < -tolerance || point[0] > viewport.width + tolerance || point[1] < -tolerance || point[1] > viewport.height + tolerance) return null;
        points.push([point[0], point[1]]);
      }
      rings.push(points);
    }
    clean.push({ rings });
  }
  return clean;
}
function vcxCountMap(value, allowed, pattern) {
  if (!vcxObject(value) || Object.keys(value).length > 16) return null;
  const out = {};
  for (const key of Object.keys(value)) { if (!(allowed ? allowed.has(key) : pattern.test(key)) || !vcxInt(value[key], 10_000_000)) return null; out[key] = value[key]; }
  return out;
}
// MVP-03C: selected parcels as a second vector layer. Counters only; no key, id or coordinate besides viewport pixels.
function vcxSelection(value, viewport, budget) {
  const { source: rawSource, perFeature: rawPerFeature, ...rest } = vcxObject(value) ? value : {};
  let perFeature; if (rawPerFeature !== undefined) { perFeature = vcxIndividual(rawPerFeature); if (!perFeature) return null; } // optional: older readers send none
  let source; if (rawSource !== undefined) { source = vcxSelectionSource(rawSource); if (!source) return null; } // optional: older readers send none
  if (!vcxKeys(rest, ['status', 'features', 'counts', 'diagnostics']) || !['none', 'ready'].includes(value.status) || !Array.isArray(value.features) || value.features.length > VCX_MAX_FEATURES) return null;
  if (value.status === 'none' && value.features.length) return null;
  const counts = value.counts;
  if (!vcxObject(counts) || Object.keys(counts).length !== VCX_SELECTION_COUNTS.length + 1 || !VCX_SELECTION_COUNTS.every(key => vcxInt(counts[key], 10_000_000)) || !vcxKeys(counts.keyTiers, ['id', 'property', 'geometry']) || !['id', 'property', 'geometry'].every(key => vcxInt(counts.keyTiers[key], 10_000_000))) return null;
  const diagnostics = value.diagnostics; if (!vcxKeys(diagnostics, ['projectionMethods', 'paneCounts'])) return null;
  const projectionMethods = vcxCountMap(diagnostics.projectionMethods, VCX_PROJECTIONS); const paneCounts = vcxCountMap(diagnostics.paneCounts, null, /^[A-Za-z0-9_.-]{1,64}$/);
  if (!projectionMethods || !paneCounts) return null;
  const features = vcxFeatures(value.features, viewport, budget); if (!features) return null;
  return { status: value.status, features, counts: { ...Object.fromEntries(VCX_SELECTION_COUNTS.map(key => [key, counts[key]])), keyTiers: { id: counts.keyTiers.id, property: counts.keyTiers.property, geometry: counts.keyTiers.geometry } }, diagnostics: { projectionMethods, paneCounts }, ...(source ? { source } : {}), ...(perFeature ? { perFeature } : {}) };
}
function vcxTokens(value, limit = 16) { return Array.isArray(value) && value.length <= limit && value.every(item => typeof item === 'string' && VCX_TOKEN.test(item)) ? [...value] : null; }
// How the selection was identified: a closed vocabulary and counters. No identifier, no coordinate.
function vcxSelectionSource(value) {
  if (!vcxKeys(value, ['confidence', 'mechanism', 'evidence', 'candidateGroups', 'rejectedPolygons']) || !VCX_CONFIDENCE.has(value.confidence) || !VCX_MECHANISMS.has(value.mechanism) || !vcxInt(value.candidateGroups, 10_000_000) || !vcxInt(value.rejectedPolygons, 10_000_000)) return null;
  const evidence = vcxTokens(value.evidence); return evidence ? { confidence: value.confidence, mechanism: value.mechanism, evidence, candidateGroups: value.candidateGroups, rejectedPolygons: value.rejectedPolygons } : null;
}
// MVP-05A: how the selected parcels were obtained. Closed vocabulary and counters: no key, no id, no coordinate.
const VCX_INDIVIDUAL_COUNTS = ['overrideCount', 'matchedFeatures', 'uniqueGeometries', 'exportedObjects', 'unmatchedFeatures', 'styleGroups'];
function vcxIndividual(value) {
  if (!vcxKeys(value, ['source', 'confidence', 'basis', ...VCX_INDIVIDUAL_COUNTS, 'coverage', 'fallbackReason', 'evidence']) || !VCX_INDIVIDUAL_SOURCES.has(value.source) || !VCX_CONFIDENCE.has(value.confidence) || !VCX_INDIVIDUAL_BASIS.has(value.basis) || !VCX_FALLBACK_REASONS.has(value.fallbackReason)) return null;
  if (!VCX_INDIVIDUAL_COUNTS.every(key => vcxInt(value[key], 10_000_000)) || !(value.coverage === null || (typeof value.coverage === 'number' && value.coverage >= 0 && value.coverage <= 1))) return null;
  const evidence = vcxTokens(value.evidence); if (!evidence) return null;
  return { source: value.source, confidence: value.confidence, basis: value.basis, ...Object.fromEntries(VCX_INDIVIDUAL_COUNTS.map(key => [key, value[key]])), coverage: value.coverage, fallbackReason: value.fallbackReason, evidence };
}
function vcxIndividualText(individual) {
  if (!individual) return [];
  return ['SÉLECTION INDIVIDUELLE', `  source: ${individual.source}`, `  confidence: ${individual.confidence}`, `  basis: ${individual.basis}`, `  override count: ${individual.overrideCount}`, `  matched features: ${individual.matchedFeatures}`, `  unique geometries: ${individual.uniqueGeometries}`, `  exported objects: ${individual.exportedObjects}`, `  unmatched features: ${individual.unmatchedFeatures}`,
    `  style groups: ${individual.styleGroups} · coverage: ${individual.coverage ?? 'n/a'}`, `  evidence: ${individual.evidence.join(', ') || 'n/a'}`, `  fallback reason: ${individual.fallbackReason}`];
}
function vcxSummary(value) {
  if (!vcxKeys(value, ['selection', 'background']) || !vcxKeys(value.selection, ['state', 'count']) || !['none', 'ready', 'ambiguous'].includes(value.selection.state) || !vcxInt(value.selection.count, 10_000_000) || !vcxKeys(value.background, ['state']) || !['embeddable', 'not-embeddable'].includes(value.background.state)) return null;
  return { selection: { state: value.selection.state, count: value.selection.count }, background: { state: value.background.state } };
}
function vcxShape(value, required, optional) { return vcxObject(value) && required.every(key => key in value) && Object.keys(value).every(key => required.includes(key) || optional.includes(key)); }
// MVP-04: the basemap as the page reader reports it. The image is the only pixel payload; the rest is counters and class names.
function vcxBackground(value, viewport) {
  if (!vcxObject(value) || !['embedded', 'unavailable'].includes(value.status)) return null;
  const embedded = value.status === 'embedded';
  if (!vcxShape(value, embedded ? ['status', 'image', 'candidate', 'tiles', 'composition'] : ['status', 'reason', 'candidate', 'tiles', 'composition'], ['provenance'])) return null;
  let provenance; if ('provenance' in value) { provenance = vcxProvenance(value.provenance); if (!provenance) return null; }
  const { candidate, tiles, composition } = value;
  if (!vcxShape(candidate, ['status', 'kind', 'confidence', 'evidence', 'tileCount', 'imageAccess'], ['tileSize', 'zoom']) || !['found', 'not-found', 'ambiguous'].includes(candidate.status) || !['raster', 'none'].includes(candidate.kind) || !VCX_CONFIDENCE.has(candidate.confidence) || !vcxInt(candidate.tileCount, 10_000_000) || !VCX_IMAGE_ACCESS.has(candidate.imageAccess)) return null;
  const evidence = vcxTokens(candidate.evidence); if (!evidence) return null;
  if (candidate.tileSize !== undefined && (!vcxKeys(candidate.tileSize, ['width', 'height']) || !vcxInt(candidate.tileSize.width, 8192) || !vcxInt(candidate.tileSize.height, 8192))) return null;
  if (candidate.zoom !== undefined && !(typeof candidate.zoom === 'number' && candidate.zoom >= 0 && candidate.zoom <= 30)) return null;
  if (!vcxKeys(tiles, ['cached', 'intersecting', 'readable', 'unreadable', 'completeness', 'methods']) || !['cached', 'intersecting', 'readable', 'unreadable'].every(key => vcxInt(tiles[key], 10_000_000)) || !['complete', 'incomplete', 'none'].includes(tiles.completeness)) return null;
  const methods = vcxCountMap(tiles.methods, VCX_BACKGROUND_METHODS); if (!methods) return null;
  if (!vcxShape(composition, ['method'], ['pixelWidth', 'pixelHeight', 'pixelRatio']) || !['canvas-2d-drawImage', 'tab-capture-crop', 'none'].includes(composition.method)) return null;
  const clean = { status: value.status, candidate: { status: candidate.status, kind: candidate.kind, confidence: candidate.confidence, evidence, tileCount: candidate.tileCount, ...(candidate.tileSize ? { tileSize: { width: candidate.tileSize.width, height: candidate.tileSize.height } } : {}), ...(candidate.zoom !== undefined ? { zoom: candidate.zoom } : {}), imageAccess: candidate.imageAccess }, tiles: { cached: tiles.cached, intersecting: tiles.intersecting, readable: tiles.readable, unreadable: tiles.unreadable, completeness: tiles.completeness, methods }, ...(provenance ? { provenance } : {}) };
  if (!embedded) {
    if (!VCX_BACKGROUND_REASONS.has(value.reason) || composition.method !== 'none' || Object.keys(composition).length !== 1) return null;
    return { ...clean, reason: value.reason, composition: { method: 'none' } };
  }
  const image = value.image;
  if (!vcxKeys(image, ['dataUri', 'pixelWidth', 'pixelHeight']) || typeof image.dataUri !== 'string' || image.dataUri.length > VCX_MAX_DATA_URI || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image.dataUri) || !vcxInt(image.pixelWidth, VCX_MAX_DIMENSION * 2) || !vcxInt(image.pixelHeight, VCX_MAX_DIMENSION * 2) || image.pixelWidth * image.pixelHeight > VCX_MAX_PIXELS || image.pixelWidth < 1 || image.pixelHeight < 1) return null;
  // The raster must fill the viewport exactly (any ratio, same aspect): otherwise it would need a manual realignment.
  if (Math.abs(image.pixelWidth * viewport.height - image.pixelHeight * viewport.width) > Math.max(viewport.width, viewport.height) * 1.01) return null;
  // MVP-06: the rendered capture cropped to the map rectangle. The tile counters then only describe why tiles were not composed.
  const captured = composition.method === 'tab-capture-crop';
  const ratioRange = captured ? [0.5, 8] : [1, 2];
  if (!vcxKeys(composition, ['method', 'pixelWidth', 'pixelHeight', 'pixelRatio']) || !(composition.method === 'canvas-2d-drawImage' || captured) || composition.pixelWidth !== image.pixelWidth || composition.pixelHeight !== image.pixelHeight || !(typeof composition.pixelRatio === 'number' && composition.pixelRatio >= ratioRange[0] && composition.pixelRatio <= ratioRange[1])) return null;
  if (!captured && (tiles.completeness !== 'complete' || tiles.unreadable !== 0 || tiles.readable !== tiles.intersecting)) return null;
  return { ...clean, image: { dataUri: image.dataUri, pixelWidth: image.pixelWidth, pixelHeight: image.pixelHeight }, composition: { method: composition.method, pixelWidth: composition.pixelWidth, pixelHeight: composition.pixelHeight, pixelRatio: composition.pixelRatio } };
}
// MVP-05B: provenance of the basemap tile layer. Closed vocabularies, counters and the public attribution text only: never a URL, host or tile coordinate.
function vcxProvenance(value) {
  if (!vcxKeys(value, ['provider', 'serviceFamily', 'format', 'renderType', 'styleHints', 'attribution', 'options', 'vectorLibraries', 'staticHints'])) return null;
  if (!VCX_PROVIDERS.has(value.provider) || !VCX_SERVICE_FAMILIES.has(value.serviceFamily) || !VCX_FORMATS.has(value.format) || !['raster-tiles', 'vector-tiles'].includes(value.renderType)) return null;
  if (!Array.isArray(value.styleHints) || value.styleHints.length > 12 || !value.styleHints.every(hint => VCX_STYLE_HINTS.has(hint))) return null;
  if (!Array.isArray(value.attribution) || value.attribution.length > 8 || !value.attribution.every(text => typeof text === 'string' && VCX_ATTRIBUTION.test(text) && !/https?:|\/\/|www\./i.test(text))) return null;
  const options = value.options;
  if (!vcxShape(options, ['crossOrigin', 'subdomainCount', 'retina'], ['tileSize', 'minZoom', 'maxZoom']) || !['unset', 'anonymous', 'use-credentials'].includes(options.crossOrigin) || !vcxInt(options.subdomainCount, 64) || typeof options.retina !== 'boolean') return null;
  for (const [name, maximum] of [['tileSize', 8192], ['minZoom', 30], ['maxZoom', 30]]) if (name in options && !vcxInt(options[name], maximum)) return null;
  const libraries = value.vectorLibraries;
  if (!vcxKeys(libraries, ['maplibregl', 'mapboxgl', 'leafletGlBridge', 'vectorGrid']) || !Object.values(libraries).every(flag => typeof flag === 'boolean')) return null;
  const hints = value.staticHints;
  if (!vcxKeys(hints, ['inlineScripts', 'externalScripts', 'flags']) || !vcxInt(hints.inlineScripts, 400) || !vcxInt(hints.externalScripts, 400) || !Array.isArray(hints.flags) || hints.flags.length > 8 || !hints.flags.every(flag => VCX_STATIC_FLAGS.has(flag))) return null;
  return {
    provider: value.provider, serviceFamily: value.serviceFamily, format: value.format, renderType: value.renderType, styleHints: [...value.styleHints], attribution: [...value.attribution],
    options: { crossOrigin: options.crossOrigin, subdomainCount: options.subdomainCount, retina: options.retina, ...Object.fromEntries(['tileSize', 'minZoom', 'maxZoom'].filter(name => name in options).map(name => [name, options[name]])) },
    vectorLibraries: { maplibregl: libraries.maplibregl, mapboxgl: libraries.mapboxgl, leafletGlBridge: libraries.leafletGlBridge, vectorGrid: libraries.vectorGrid },
    staticHints: { inlineScripts: hints.inlineScripts, externalScripts: hints.externalScripts, flags: [...hints.flags] },
  };
}
function vcxProvenanceText(provenance) {
  if (!provenance) return [];
  const o = provenance.options;
  return ['Provenance du fond (inférée, passive) :', `  provider: ${provenance.provider} · service: ${provenance.serviceFamily}`, `  format: ${provenance.format} · rendering: ${provenance.renderType}`, `  style hints: ${provenance.styleHints.join(', ') || 'none'}`,
    `  attribution: ${provenance.attribution.join(' | ') || 'none'}`, `  options: crossOrigin ${o.crossOrigin} · subdomains ${o.subdomainCount} · retina ${o.retina}${o.tileSize ? ` · tileSize ${o.tileSize}` : ''}${o.minZoom !== undefined ? ` · minZoom ${o.minZoom}` : ''}${o.maxZoom !== undefined ? ` · maxZoom ${o.maxZoom}` : ''}`,
    `  vector libraries: ${Object.entries(provenance.vectorLibraries).map(([name, flag]) => `${name} ${flag ? 'yes' : 'no'}`).join(' · ')} (vectorGrid: the cadastre uses it, not evidence of a vector basemap)`, `  static hints: inline scripts ${provenance.staticHints.inlineScripts} · external scripts (not read) ${provenance.staticHints.externalScripts} · ${provenance.staticHints.flags.join(', ') || 'no flag'}`];
}
function vcxMessage(status) { return VCX_MESSAGES[status] || VCX_MESSAGES['no-map']; }

const VCX_NOT_EXPORTABLE = new Set(['WMS_SELECTION', 'RENDERER_SELECTION', 'DOM_SELECTION']);
// notExportable: conclusion code of the A/B selection comparison, when the selection only exists as raster/WMS/DOM.
function vcxSelectionText(selection, notExportable) {
  const note = !selection?.features.length && VCX_NOT_EXPORTABLE.has(notExportable) ? [`  sélection détectée (${notExportable}) : pas encore exportable`] : [];
  if (!selection || selection.status !== 'ready') return ['Parcelles sélectionnées :', selection?.source?.mechanism === 'ambiguous-candidates' ? '  sélection ambiguë : plusieurs candidats, non exportée' : '  aucune sélection vectorielle', ...vcxSourceText(selection?.source), ...note, ...vcxIndividualText(selection?.perFeature)];
  const { counts, diagnostics } = selection;
  return ['Parcelles sélectionnées :', ...vcxSourceText(selection.source), `  selected features detected: ${counts.selectedFeaturesDetected}`, `  selected features visible: ${counts.selectedFeaturesVisible}`, `  selected paths exported: ${counts.selectedPathsExported}`, `  selected features clipped: ${counts.selectedFeaturesClipped}`, `  duplicates handled: ${counts.duplicatesHandled} (candidate polygons: ${counts.candidatePolygons})`,
    `  projection: ${Object.entries(diagnostics.projectionMethods).map(([name, count]) => `${name} ${count}`).join(' · ') || 'n/a'}`, `  panes: ${Object.entries(diagnostics.paneCounts).map(([name, count]) => `${name} ${count}`).join(' · ') || 'n/a'}`, ...vcxIndividualText(selection.perFeature)];
}

function vcxSourceText(source) {
  return source ? ['  selectionSource:', `    confidence: ${source.confidence}`, `    mechanism: ${source.mechanism}`, `    evidence: ${source.evidence.join(', ') || 'n/a'}`, `    candidate groups: ${source.candidateGroups} · rejected polygons: ${source.rejectedPolygons}`] : [];
}

// FOND CARTOGRAPHIQUE: counters, class names and method names only. Never a URL, a tile x/y or a coordinate.
function vcxBackgroundText(capture) {
  if (!capture || capture.status !== 'ready') return 'Aucun export.';
  const background = capture.background; if (!background) return 'Fond cartographique : non évalué.';
  const { candidate, tiles, composition } = background;
  return [
    'Candidate :', `  ${candidate.status === 'found' ? 'detected' : candidate.status === 'ambiguous' ? 'ambiguous' : 'not detected'}`, `  type: ${candidate.kind}`, `  confidence: ${candidate.confidence}`, `  evidence: ${candidate.evidence.join(', ') || 'n/a'}`,
    `  tile size: ${candidate.tileSize ? `${candidate.tileSize.width}×${candidate.tileSize.height}` : 'n/a'} · zoom: ${candidate.zoom ?? 'n/a'}`,
    'Tuiles :', `  tiles cached: ${tiles.cached}`, `  tiles intersecting viewport: ${tiles.intersecting}`, `  tiles readable: ${tiles.readable}`, `  tiles unreadable: ${tiles.unreadable}`,
    `  image access: ${candidate.imageAccess}`, `  sources: ${Object.entries(tiles.methods).map(([name, count]) => `${name} ${count}`).join(' · ') || 'n/a'}`,
    `  completeness: ${tiles.completeness}`, `Viewport :`, `  ${capture.viewport.width} × ${capture.viewport.height}`,
    'Composition :', `  method: ${composition.method}`, ...(background.status === 'embedded' ? [`  raster: ${composition.pixelWidth} × ${composition.pixelHeight} px (ratio ${composition.pixelRatio})`, '  result: embedded'] : [`  result: not embedded (${background.reason})`]),
    ...vcxProvenanceText(background.provenance),
  ].join('\n');
}

// The three product lines shown under the export button. Product wording only: no technical term.
// options.captureReady: the rendered-basemap capture is possible (the extension was invoked on this tab and did not fail).
function vcxStateLines(capture, options = {}) {
  const summary = capture?.status === 'ready' ? (capture.summary || (capture.features ? { selection: { state: capture.selection?.status === 'ready' ? 'ready' : capture.selection?.source?.mechanism === 'ambiguous-candidates' ? 'ambiguous' : 'none', count: capture.selection?.counts?.selectedFeaturesVisible || 0 }, background: { state: capture.background?.status === 'embedded' ? 'embeddable' : 'not-embeddable' } } : null)) : null;
  if (!summary) return ['Cadastre : non détecté', 'Sélection : —', 'Fond : —'];
  const { selection, background } = summary;
  const selected = selection.state === 'ready' ? `${selection.count} parcelle${selection.count > 1 ? 's' : ''}` : selection.state === 'ambiguous' ? 'ambiguë (non exportée)' : 'aucune';
  return ['Cadastre : détecté', `Sélection : ${selected}`, `Fond : ${background.state === 'embeddable' || options.captureReady ? 'incorporable' : 'non incorporable'}`];
}

// Counts, sizes and method names only: no identifier, no coordinate.
function vcxDiagnosticText(capture, notExportable) {
  if (!capture || capture.status !== 'ready') return 'Aucun export.';
  const { viewport, counts, diagnostics, zoom } = capture;
  return [
    'Viewport :', `  ${viewport.width} × ${viewport.height}`,
    'Cadastre :', `  cached features: ${counts.cachedFeatures}`, `  unique features: ${counts.uniqueFeatures}`, `  visible features: ${counts.visibleFeatures}`, `  exported paths: ${counts.exportedPaths}`, `  clipped features: ${counts.clippedFeatures}`, `  duplicates/fragments handled: ${counts.duplicatesHandled}`,
    'Contrôle géométrique :', `  zoom: ${zoom} · tile zoom: ${diagnostics.tileZoom} · tile size: ${diagnostics.tileSize.width}×${diagnostics.tileSize.height} · zoom scale: ${diagnostics.zoomScale}`, `  tiles: ${counts.tiles} (in viewport: ${counts.tilesInViewport})`,
    `  viewport size: ${diagnostics.viewportMethod}`, `  pixel origin: ${diagnostics.pixelOriginMethod}`, `  transform: ${diagnostics.transformMethod}`, `  clipping: ${diagnostics.clippingMethod}`,
    `  deduplication: ${diagnostics.dedupMethod} (id ${counts.keyTiers.id} · property ${counts.keyTiers.property} · geometry ${counts.keyTiers.geometry})`,
    ...vcxSelectionText(capture.selection, notExportable),
  ].join('\n');
}

if (typeof window !== 'undefined') globalThis.MonTerritoireVisibleCadastre = { validateCapture: vcxValidateCapture, message: vcxMessage, diagnosticText: vcxDiagnosticText, backgroundText: vcxBackgroundText, stateLines: vcxStateLines, backgroundFallbackMessage: VCX_BACKGROUND_FALLBACK };
