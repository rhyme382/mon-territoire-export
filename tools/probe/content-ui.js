const EVENT = 'mon-territoire-probe:fact';
const READY_EVENT = 'mon-territoire-probe:ready';
const READY_REQUEST_EVENT = 'mon-territoire-probe:ready-request';
const ENGINE_SNAPSHOT_REQUEST_EVENT = 'mon-territoire-probe:engine-snapshot-request';
const VISIBLE_MAP_REQUEST_EVENT = 'mon-territoire-probe:visible-map-capture-request';
const VISIBLE_CADASTRE_REQUEST_EVENT = 'mon-territoire-probe:visible-cadastre-request';
const VISIBLE_SELECTION_REQUEST_EVENT = 'mon-territoire-probe:visible-selection-capture-request';
const VISIBLE_CADASTRE_POLL_MS = 3000;
const MAX_FACTS = 200;
const MAX_BYTES = 1_000_000;
const MAX_PCI_OBSERVATIONS = 5;
const MAX_DIMENSION = 100_000;
const FORBIDDEN = /^(?:cookie|authorization|token|body|propertyvalues|html|script|credentials?|password|query|fragment|url)$/i;
const MIME = /^[a-z0-9!#$&^_.+-]{1,48}\/[a-z0-9!#$&^_.+-]{1,48}$/i;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const TRANSFORM = /^(?:none|matrix\((-?(?:\d+|\d*\.\d+))(?:,\s*-?(?:\d+|\d*\.\d+)){5}\)|translate(?:3d)?\(-?(?:\d+|\d*\.\d+)px,\s*-?(?:\d+|\d*\.\d+)px(?:,\s*-?(?:\d+|\d*\.\d+)px)?\))$/;

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value, allowed) { return object(value) && Object.keys(value).every(key => allowed.has(key)); }
function finite(value, maximum = MAX_DIMENSION) { return Number.isSafeInteger(value) && value >= 0 && value <= maximum; }
function hostname(value) { return typeof value === 'string' && value === value.toLowerCase() && HOSTNAME.test(value) ? value : null; }
function pathname(value) { return typeof value === 'string' && value.length >= 1 && value.length <= 512 && value.startsWith('/') && !/[?#%\u0000-\u001f\u007f]/.test(value) ? value : null; }
function containsForbidden(value, depth = 0) { if (depth > 6 || value === null || typeof value !== 'object') return false; if (Array.isArray(value)) return value.length > 256 || value.some(item => containsForbidden(item, depth + 1)); return Object.keys(value).some(key => FORBIDDEN.test(key) || containsForbidden(value[key], depth + 1)); }
function zxy(value) { if (!exactKeys(value, new Set(['z', 'x', 'y'])) || !finite(value.z, 30) || !finite(value.x, 2 ** value.z - 1) || !finite(value.y, 2 ** value.z - 1)) return null; return { z: value.z, x: value.x, y: value.y }; }
function initiatorType(value) { return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/i.test(value) ? value.toLowerCase() : null; }
function mvtLayer(value) {
  if (!exactKeys(value, new Set(['name', 'extent', 'featureCount', 'featuresWithId', 'propertyNames', 'geometryTypes'])) || typeof value.name !== 'string' || value.name.length > 96 || !finite(value.featureCount, 10_000) || !finite(value.featuresWithId, 10_000) || value.featuresWithId > value.featureCount || (value.extent !== undefined && !finite(value.extent, MAX_BYTES)) || !Array.isArray(value.propertyNames) || value.propertyNames.length > 128 || value.propertyNames.some(name => typeof name !== 'string' || name.length > 96 || !/^[A-Za-z_][A-Za-z0-9_:-]*$/.test(name)) || !exactKeys(value.geometryTypes, new Set(['Point', 'LineString', 'Polygon'])) || !['Point', 'LineString', 'Polygon'].every(name => finite(value.geometryTypes[name], 10_000))) return null;
  return { name: value.name, ...(value.extent !== undefined ? { extent: value.extent } : {}), featureCount: value.featureCount, featuresWithId: value.featuresWithId, propertyNames: [...new Set(value.propertyNames)], geometryTypes: { ...value.geometryTypes } };
}
function mvt(value) {
  if (!exactKeys(value, new Set(['type', 'hostname', 'pathname', 'tileCoordinatesPresent', 'transport', 'contentType', 'byteLength', 'bodyReadable', 'decoded', 'layers', 'decodeFailure'])) || !hostname(value.hostname) || !pathname(value.pathname) || typeof value.tileCoordinatesPresent !== 'boolean' || !initiatorType(value.transport) || (value.contentType !== undefined && (!MIME.test(value.contentType) || value.contentType.length > 96)) || (value.byteLength !== undefined && !finite(value.byteLength, MAX_BYTES)) || typeof value.bodyReadable !== 'boolean' || typeof value.decoded !== 'boolean' || (value.decoded && (!value.bodyReadable || !Array.isArray(value.layers) || value.layers.length > 32 || value.decodeFailure !== undefined)) || (!value.decoded && (value.layers !== undefined || typeof value.decodeFailure !== 'string' || !/^[a-z0-9-]{1,48}$/.test(value.decodeFailure)))) return null;
  const layers = value.decoded ? value.layers.map(mvtLayer) : []; if (layers.some(layer => !layer)) return null;
  return { type: 'mvt', hostname: value.hostname, pathname: value.pathname, tileCoordinatesPresent: value.tileCoordinatesPresent, transport: value.transport, ...(value.contentType ? { contentType: value.contentType } : {}), ...(value.byteLength !== undefined ? { byteLength: value.byteLength } : {}), bodyReadable: value.bodyReadable, decoded: value.decoded, ...(value.decoded ? { layers } : { decodeFailure: value.decodeFailure }) };
}
function image(value) { if (!exactKeys(value, new Set(['hostname', 'pathname', 'width', 'height', 'class'])) || !hostname(value.hostname) || !pathname(value.pathname) || !finite(value.width) || !finite(value.height) || !['leaflet-tile', 'overlay', 'other'].includes(value.class)) return null; return { hostname: value.hostname, pathname: value.pathname, width: value.width, height: value.height, class: value.class }; }
function leaflet(value) {
  if (!exactKeys(value, new Set(['containers', 'viewport', 'panes', 'svgCount', 'canvasCount', 'imageCount', 'images', 'maskPane'])) || !finite(value.containers, 100) || !exactKeys(value.viewport, new Set(['width', 'height'])) || !finite(value.viewport.width) || !finite(value.viewport.height) || !Array.isArray(value.panes) || value.panes.length > 32 || !finite(value.svgCount, 10_000) || !finite(value.canvasCount, 10_000) || !finite(value.imageCount, 10_000) || !Array.isArray(value.images) || value.images.length > 64 || typeof value.maskPane !== 'boolean') return null;
  const panes = [];
  for (const pane of value.panes) { if (!exactKeys(pane, new Set(['name', 'transform'])) || !['tile', 'overlay', 'marker', 'shadow', 'map', 'popup', 'tooltip', 'mask'].includes(pane.name) || typeof pane.transform !== 'string' || pane.transform.length > 160 || !TRANSFORM.test(pane.transform)) return null; panes.push({ name: pane.name, transform: pane.transform }); }
  const images = value.images.map(image); if (images.some(item => !item)) return null;
  return { containers: value.containers, viewport: { width: value.viewport.width, height: value.viewport.height }, panes, svgCount: value.svgCount, canvasCount: value.canvasCount, imageCount: value.imageCount, images, maskPane: value.maskPane };
}
const GEO_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection', 'other']);
const ROOT_TYPES = new Set([...GEO_TYPES, 'Feature', 'FeatureCollection']);
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_:-]{0,47}$/;
const keyName = value => typeof value === 'string' && KEY_NAME.test(value) && !/\d{3,}/.test(value);
const nameList = (value, maximum) => Array.isArray(value) && value.length <= maximum && value.every(keyName);
const oneOf = (value, list) => list.includes(value);
const PCI_COMMON = ['status', 'reason', 'rootKind'];
function pciContour(value) {
  const base = ['type', ...PCI_COMMON];
  if (!object(value) || value.type !== 'pci-contour' || !oneOf(value.status, ['observed', 'too-large', 'invalid'])) return null;
  if (value.status !== 'observed') {
    if (!exactKeys(value, new Set(base)) || !oneOf(value.reason, ['response-too-large', 'http-status', 'no-json', 'not-object-or-array']) || (value.rootKind !== undefined && !oneOf(value.rootKind, ['null', 'string', 'number', 'boolean', 'bigint', 'undefined']))) return null;
    return { type: 'pci-contour', status: value.status, reason: value.reason, ...(value.rootKind ? { rootKind: value.rootKind } : {}) };
  }
  const keys = new Set([...base, 'rootType', 'rootKeyCount', 'rootKeys', 'redactedKeyCount', 'itemsSource', 'itemsKey', 'hasFeatures', 'featureCount', 'featuresInspected', 'geometryCount', 'geometryTypes', 'hasProperties', 'propertyKeys', 'explicitCrs', 'crsLocations', 'crsDeclared', 'coordinateShape', 'parcelIdentity', 'requestedCount', 'matchedRequestedCount', 'truncated']);
  const shape = value.coordinateShape, identity = value.parcelIdentity;
  if (!exactKeys(value, keys) || value.reason !== undefined || !oneOf(value.rootKind, ['object', 'array']) || !(value.rootType === null || ROOT_TYPES.has(value.rootType)) || (value.rootKeyCount !== undefined && !finite(value.rootKeyCount, 1_000_000)) || (value.rootKeys !== undefined && !nameList(value.rootKeys, 32)) || (value.redactedKeyCount !== undefined && !finite(value.redactedKeyCount, 32)) || !oneOf(value.itemsSource, ['array', 'features', 'feature', 'geometry', 'nested-array', 'none']) || (value.itemsKey !== undefined && !keyName(value.itemsKey)) || typeof value.hasFeatures !== 'boolean' || !finite(value.featureCount, 100_000_000) || !finite(value.featuresInspected, 2000) || !finite(value.geometryCount, 2000) || !Array.isArray(value.geometryTypes) || value.geometryTypes.length > 8 || !value.geometryTypes.every(name => GEO_TYPES.has(name)) || typeof value.hasProperties !== 'boolean' || !nameList(value.propertyKeys, 32) || typeof value.explicitCrs !== 'boolean' || !Array.isArray(value.crsLocations) || !value.crsLocations.every(name => oneOf(name, ['root', 'feature', 'geometry', 'properties'])) || value.crsLocations.length > 4 || (value.crsDeclared !== undefined && !(value.explicitCrs && (value.crsDeclared === 'unrecognized' || /^EPSG:\d{4,6}$/.test(value.crsDeclared)))) || (value.requestedCount !== undefined && !finite(value.requestedCount, 100_000)) || (value.matchedRequestedCount !== undefined && !finite(value.matchedRequestedCount, 100_000)) || typeof value.truncated !== 'boolean') return null;
  if (!exactKeys(shape, new Set(['maxDepth', 'numericLeafPairs', 'dimensions', 'valueRange', 'depthByGeometryType'])) || !finite(shape.maxDepth, 12) || typeof shape.numericLeafPairs !== 'boolean' || !Array.isArray(shape.dimensions) || !shape.dimensions.every(n => n === 2 || n === 3) || !oneOf(shape.valueRange, ['unknown', 'within-degree-bounds', 'exceeds-degree-bounds']) || !exactKeys(shape.depthByGeometryType, GEO_TYPES) || !Object.values(shape.depthByGeometryType).every(n => finite(n, 12))) return null;
  if (!exactKeys(identity, new Set(['propertyPresent', 'candidateKeys', 'featureIdPresent', 'coverage', 'uniqueValues'])) || typeof identity.propertyPresent !== 'boolean' || !nameList(identity.candidateKeys, 32) || typeof identity.featureIdPresent !== 'boolean' || !oneOf(identity.coverage, ['all', 'some', 'none']) || !(identity.uniqueValues === null || typeof identity.uniqueValues === 'boolean')) return null;
  return { ...value, geometryTypes: [...value.geometryTypes], propertyKeys: [...value.propertyKeys], crsLocations: [...value.crsLocations], ...(value.rootKeys ? { rootKeys: [...value.rootKeys] } : {}), coordinateShape: { maxDepth: shape.maxDepth, numericLeafPairs: shape.numericLeafPairs, dimensions: [...shape.dimensions], valueRange: shape.valueRange, depthByGeometryType: { ...shape.depthByGeometryType } }, parcelIdentity: { propertyPresent: identity.propertyPresent, candidateKeys: [...identity.candidateKeys], featureIdPresent: identity.featureIdPresent, coverage: identity.coverage, uniqueValues: identity.uniqueValues } };
}
function probeDiagnostics(value) {
  const keys = new Set(['mainObserverStarted', 'fetchWrapped', 'xhrWrapped', 'performanceInitialScanCompleted', 'performanceObserverAvailable', 'performanceObserverStarted', 'resourceFactsEmitted', 'resourceFactsAccepted', 'resourceFactsRejected', 'resourceFactsPending', 'performanceResourcesSeen', 'initiatorTypes']);
  if (!exactKeys(value, keys) || !['mainObserverStarted', 'fetchWrapped', 'xhrWrapped', 'performanceInitialScanCompleted', 'performanceObserverAvailable', 'performanceObserverStarted'].every(key => typeof value[key] === 'boolean') || !['resourceFactsEmitted', 'resourceFactsAccepted', 'resourceFactsRejected', 'resourceFactsPending', 'performanceResourcesSeen'].every(key => finite(value[key], MAX_FACTS)) || !object(value.initiatorTypes) || Object.keys(value.initiatorTypes).length > 32 || Object.entries(value.initiatorTypes).some(([key, count]) => !initiatorType(key) || !finite(count, MAX_FACTS))) return null;
  return { mainObserverStarted: value.mainObserverStarted, fetchWrapped: value.fetchWrapped, xhrWrapped: value.xhrWrapped, performanceInitialScanCompleted: value.performanceInitialScanCompleted, performanceObserverAvailable: value.performanceObserverAvailable, performanceObserverStarted: value.performanceObserverStarted, resourceFactsEmitted: value.resourceFactsEmitted, resourceFactsAccepted: value.resourceFactsAccepted, resourceFactsRejected: value.resourceFactsRejected, resourceFactsPending: value.resourceFactsPending, performanceResourcesSeen: value.performanceResourcesSeen, initiatorTypes: { ...value.initiatorTypes } };
}
function sanitizeLocationRecord(value) { if (!exactKeys(value, new Set(['hostname', 'pathname'])) || !hostname(value.hostname) || !pathname(value.pathname)) return null; return { hostname: value.hostname, pathname: value.pathname }; }
function engineText(value) { return typeof value === 'string' && value.length <= 96 && /^[A-Za-z0-9_][A-Za-z0-9 ._{}:/-]*$/.test(value) ? value : null; }
export function engineSnapshot(value) {
  const keys = new Set(['schemaVersion', 'inspection', 'no-additional-network-requests', 'runtime', 'primaryMap', 'layerAggregates', 'workers', 'serviceWorker', 'iframes', 'scriptSignatures', 'diagnostics']);
  if (!exactKeys(value, keys) || value.schemaVersion !== 1 || value.inspection !== 'passive-engine-worker-identification' || value['no-additional-network-requests'] !== true || !object(value.runtime) || !Array.isArray(value.runtime.libraries) || value.runtime.libraries.length > MAX_FACTS || !object(value.primaryMap) || !Array.isArray(value.layerAggregates) || value.layerAggregates.length > MAX_FACTS || !Array.isArray(value.workers) || value.workers.length > MAX_FACTS || !object(value.serviceWorker) || !object(value.iframes) || !Array.isArray(value.scriptSignatures) || value.scriptSignatures.length > MAX_FACTS || !object(value.diagnostics)) return null;
  const libraries = value.runtime.libraries.map(item => exactKeys(item, new Set(['libraryDetected', 'libraryName', 'version', 'classes', 'prototypeMethods'])) && item.libraryDetected === true && engineText(item.libraryName) && (item.version === undefined || engineText(item.version)) && ['classes', 'prototypeMethods'].every(key => Array.isArray(item[key]) && item[key].length <= 16 && item[key].every(engineText)) ? { libraryDetected: true, libraryName: item.libraryName, ...(item.version ? { version: item.version } : {}), classes: [...item.classes], prototypeMethods: [...item.prototypeMethods] } : null);
  const aggregates = value.layerAggregates.map(item => exactKeys(item, new Set(['constructorName', 'count', 'paneName', 'rendererType', 'containerTagName', 'hasUrlTemplate', 'sanitizedUrlPattern', 'hasTileLayerSemantics', 'hasVectorGridSemantics', 'hasCanvasRenderer', 'hasSvgRenderer', 'technicalPropertyNames'])) && engineText(item.constructorName) && finite(item.count, 10_000) && ['hasUrlTemplate', 'hasTileLayerSemantics', 'hasVectorGridSemantics', 'hasCanvasRenderer', 'hasSvgRenderer'].every(key => typeof item[key] === 'boolean') && (item.sanitizedUrlPattern === undefined || sanitizeLocationRecord(item.sanitizedUrlPattern)) && (!item.technicalPropertyNames || Array.isArray(item.technicalPropertyNames) && item.technicalPropertyNames.length <= 16 && item.technicalPropertyNames.every(engineText)) ? { ...item, ...(item.sanitizedUrlPattern ? { sanitizedUrlPattern: sanitizeLocationRecord(item.sanitizedUrlPattern) } : {}) } : null);
  const workers = value.workers.map(item => exactKeys(item, new Set(['type', 'scriptLocation', 'workerType', 'hasName'])) && ['Worker', 'SharedWorker'].includes(item.type) && (item.scriptLocation === undefined || sanitizeLocationRecord(item.scriptLocation)) && (item.workerType === undefined || ['classic', 'module'].includes(item.workerType)) && (item.hasName === undefined || typeof item.hasName === 'boolean') ? { ...item, ...(item.scriptLocation ? { scriptLocation: sanitizeLocationRecord(item.scriptLocation) } : {}) } : null);
  const signatures = value.scriptSignatures.map(item => exactKeys(item, new Set(['hostname', 'pathname', 'category'])) && sanitizeLocationRecord(item) && engineText(item.category) ? { ...sanitizeLocationRecord(item), category: item.category } : null);
  if (libraries.some(item => !item) || aggregates.some(item => !item) || workers.some(item => !item) || signatures.some(item => !item)) return null;
  const primaryKeys = new Set(['containers', 'index', 'reason', 'dimensions', 'engine', 'mapObjectReachable']); if (!exactKeys(value.primaryMap, primaryKeys) || !finite(value.primaryMap.containers, 100) || !(value.primaryMap.index === null || finite(value.primaryMap.index, 100)) || !engineText(value.primaryMap.reason) || (value.primaryMap.engine !== undefined && !engineText(value.primaryMap.engine)) || typeof value.primaryMap.mapObjectReachable !== 'boolean' || (value.primaryMap.dimensions !== undefined && (!exactKeys(value.primaryMap.dimensions, new Set(['width', 'height'])) || !finite(value.primaryMap.dimensions.width) || !finite(value.primaryMap.dimensions.height)))) return null;
  const sw = value.serviceWorker; if (!exactKeys(sw, new Set(['apiAvailable', 'controllerPresent', 'controllerScript'])) || typeof sw.apiAvailable !== 'boolean' || typeof sw.controllerPresent !== 'boolean' || (sw.controllerScript !== undefined && !sanitizeLocationRecord(sw.controllerScript))) return null;
  const frames = value.iframes; const optionalLocation = frame => (frame.hostname === undefined && frame.pathname === undefined) || Boolean(sanitizeLocationRecord(frame)); if (!exactKeys(frames, new Set(['count', 'sameOriginCount', 'crossOriginCount', 'frames'])) || !['count', 'sameOriginCount', 'crossOriginCount'].every(key => finite(frames[key], MAX_FACTS)) || !Array.isArray(frames.frames) || frames.frames.length > MAX_FACTS || frames.frames.some(frame => !exactKeys(frame, new Set(['hostname', 'pathname', 'width', 'height', 'containsLeafletContainer'])) || !optionalLocation(frame) || !finite(frame.width) || !finite(frame.height) || typeof frame.containsLeafletContainer !== 'boolean')) return null;
  const diagnosticKeys = ['runtimeInspectionCompleted', 'leafletDetected', 'mapLibreDetected', 'mapboxDetected', 'openLayersDetected', 'primaryMapReachable', 'workerConstructorWrapped', 'workersObserved', 'sharedWorkersObserved', 'serviceWorkerControllerPresent', 'iframesObserved', 'scriptSignaturesObserved', 'canvasCount', 'svgCount', 'containerCount']; if (!exactKeys(value.diagnostics, new Set(diagnosticKeys)) || diagnosticKeys.some(key => key.endsWith('Observed') || key.endsWith('Count') ? !finite(value.diagnostics[key], 10_000) : typeof value.diagnostics[key] !== 'boolean')) return null;
  return { ...value, runtime: { libraries }, primaryMap: { containers: value.primaryMap.containers, index: value.primaryMap.index, reason: value.primaryMap.reason, ...(value.primaryMap.dimensions ? { dimensions: { ...value.primaryMap.dimensions } } : {}), ...(value.primaryMap.engine ? { engine: value.primaryMap.engine } : {}), mapObjectReachable: value.primaryMap.mapObjectReachable }, layerAggregates: aggregates, workers, serviceWorker: { ...sw, ...(sw.controllerScript ? { controllerScript: sanitizeLocationRecord(sw.controllerScript) } : {}) }, iframes: { ...frames, frames: frames.frames.map(frame => ({ ...(sanitizeLocationRecord(frame) || {}), width: frame.width, height: frame.height, containsLeafletContainer: frame.containsLeafletContainer })) }, scriptSignatures: signatures };
}

// Sole trust boundary for data dispatched by the page MAIN world.
export function validatePageFact(value) {
  if (object(value) && value.type === 'visible-cadastre') return globalThis.MonTerritoireVisibleCadastre?.validateCapture(value) || null;
  if (object(value) && (value.type === 'background-isolation' || value.type === 'background-restore' || value.type === 'basemap-ready')) return globalThis.MonTerritoireRenderedBasemap?.rbmValidateFact(value) || null;
  if (object(value) && value.type === 'visible-selection-capture') { const capture = exactKeys(value, new Set(['type', 'capture'])) ? globalThis.MonTerritoireVisibleSelection?.validateCapture(value.capture) : null; return capture ? { type: 'visible-selection-capture', capture } : null; }
  if (!object(value) || containsForbidden(value)) return null;
  if (value.type === 'mvt') return mvt(value);
  if (value.type === 'pci-contour') return pciContour(value);
  if (value.type === 'visible-map-capture') { const capture = exactKeys(value, new Set(['type', 'capture'])) ? globalThis.MonTerritoireVisibleMap?.validateCapture(value.capture) : null; return capture ? { type: 'visible-map-capture', capture } : null; }
  if (value.type === 'engine-snapshot' && exactKeys(value, new Set(['type', 'snapshot']))) { const snapshot = engineSnapshot(value.snapshot); return snapshot ? { type: 'engine-snapshot', snapshot } : null; }
  if (!exactKeys(value, new Set(['type', 'hostname', 'pathname', 'zxy', 'initiatorType', 'transferSize', 'encodedBodySize', 'decodedBodySize', 'leaflet', 'probeDiagnostics']))) return null;
  if (value.type === 'resource') {
    const host = hostname(value.hostname), path = pathname(value.pathname);
    const type = initiatorType(value.initiatorType);
    if (!host || !path || !type || (value.zxy !== undefined && !zxy(value.zxy)) || ['transferSize', 'encodedBodySize', 'decodedBodySize'].some(key => value[key] !== undefined && !finite(value[key], MAX_BYTES))) return null;
    return { type: 'resource', hostname: host, pathname: path, ...(value.zxy ? { zxy: zxy(value.zxy) } : {}), initiatorType: type, ...(value.transferSize !== undefined ? { transferSize: value.transferSize } : {}), ...(value.encodedBodySize !== undefined ? { encodedBodySize: value.encodedBodySize } : {}), ...(value.decodedBodySize !== undefined ? { decodedBodySize: value.decodedBodySize } : {}) };
  }
  if (value.type === 'dom' || value.type === 'leaflet') { const diagnostic = leaflet(value.leaflet); return diagnostic ? { type: value.type, leaflet: diagnostic } : null; }
  if (value.type === 'diagnostic') { const diagnostic = probeDiagnostics(value.probeDiagnostics); return diagnostic ? { type: 'diagnostic', probeDiagnostics: diagnostic } : null; }
  return null;
}
function mvtDiagnostics(candidates, accepted, rejected) {
  const readable = candidates.filter(item => item.bodyReadable).length;
  const decoded = candidates.filter(item => item.decoded).length;
  return { candidatesObserved: candidates.length, bodiesReadable: readable, bodiesUnreadable: candidates.length - readable, decodeSuccess: decoded, decodeFailure: candidates.length - decoded, sanitizedFactsEmitted: candidates.length, sanitizedFactsAccepted: accepted, sanitizedFactsRejected: rejected, sanitizedFactsPending: Math.max(0, candidates.length - accepted - rejected) };
}
function safeMvtReport(report) {
  const candidates = Array.isArray(report?.candidates) ? report.candidates.map(validatePageFact).filter(fact => fact?.type === 'mvt').slice(0, MAX_FACTS) : [];
  const accepted = finite(report?.diagnostics?.sanitizedFactsAccepted, MAX_FACTS) ? report.diagnostics.sanitizedFactsAccepted : candidates.length;
  const rejected = finite(report?.diagnostics?.sanitizedFactsRejected, MAX_FACTS) ? report.diagnostics.sanitizedFactsRejected : 0;
  return { schemaVersion: 1, inspection: 'passive-mvt-runtime-only', 'no-additional-network-requests': true, privacy: { queryStrings: 'removed', tileCoordinates: 'replaced-with-placeholders', headers: 'not-retained', credentials: 'not-retained', rawPbf: 'not-retained', propertyValues: 'not-retained', geometry: 'not-retained' }, diagnostics: mvtDiagnostics(candidates, accepted, rejected), candidates: candidates.map(({ type, ...fact }) => fact) };
}
function safeReport(report) {
  const accepted = Array.isArray(report?.resources) ? report.resources.map(validatePageFact).filter(fact => fact?.type === 'resource').slice(0, MAX_FACTS) : [];
  const facts = Array.isArray(report?.facts) ? report.facts.map(validatePageFact).filter(fact => fact?.type === 'dom' || fact?.type === 'leaflet').slice(0, MAX_FACTS) : [];
  const received = probeDiagnostics(report?.probeDiagnostics) || { mainObserverStarted: false, fetchWrapped: false, xhrWrapped: false, performanceInitialScanCompleted: false, performanceObserverAvailable: false, performanceObserverStarted: false, resourceFactsEmitted: 0, resourceFactsAccepted: 0, resourceFactsRejected: 0, resourceFactsPending: 0, performanceResourcesSeen: 0, initiatorTypes: {} };
  const contour = Array.isArray(report?.pciContourObservations) ? report.pciContourObservations.map(validatePageFact).filter(fact => fact?.type === 'pci-contour').slice(-MAX_PCI_OBSERVATIONS) : [];
  return { schemaVersion: 1, privacy: 'sanitized-local-report', pciContour: { inspection: 'passive-pci-contour-structure-only', status: contour.length ? contour.at(-1).status : 'waiting', coordinates: 'not-retained', propertyValues: 'not-retained', observations: contour.map(({ type, ...fact }) => fact) }, resources: accepted.map(({ type, ...fact }) => fact), facts, totals: { resourceCount: accepted.length, knownBytes: accepted.reduce((sum, item) => sum + (item.transferSize || 0), 0) }, probeDiagnostics: { ...received, resourceFactsAccepted: finite(report?.resourceFactsAccepted, MAX_FACTS) ? report.resourceFactsAccepted : 0, resourceFactsRejected: finite(report?.resourceFactsRejected, MAX_FACTS) ? report.resourceFactsRejected : 0 } };
}
export async function copyReport(report, clipboard = navigator.clipboard) { const text = JSON.stringify(safeReport(report), null, 2); await clipboard.writeText(text); return text; }
export async function copyRenderReport(report, clipboard = navigator.clipboard) { const text = JSON.stringify(report, null, 2); await clipboard.writeText(text); return text; }
export async function copyMvtReport(report, clipboard = navigator.clipboard) { const text = JSON.stringify(safeMvtReport(report), null, 2); await clipboard.writeText(text); return text; }
function engineComparison(previous, current) {
  if (!previous || !current) return { available: false, summary: 'comparison unavailable' };
  const counts = list => new Map((list || []).map(item => [item.constructorName, item.count])); const before = counts(previous.layerAggregates), after = counts(current.layerAggregates);
  const newLayerTypes = [...after].filter(([name, count]) => count > (before.get(name) || 0)).map(([constructorName, count]) => ({ constructorName, count: count - (before.get(constructorName) || 0) }));
  const delta = key => (current.diagnostics?.[key] || 0) - (previous.diagnostics?.[key] || 0);
  const workers = (current.workers?.length || 0) - (previous.workers?.length || 0); const iframes = delta('iframesObserved'); const scripts = delta('scriptSignaturesObserved'); const renderers = { canvasCount: delta('canvasCount'), svgCount: delta('svgCount'), containerCount: delta('containerCount') };
  const changed = newLayerTypes.length || workers || iframes || scripts || Object.values(renderers).some(Boolean);
  return { available: true, newLayerTypes, workerDelta: workers, iframeDelta: iframes, scriptSignatureDelta: scripts, rendererDelta: renderers, summary: changed ? 'structural delta detected' : 'no structural delta' };
}
function safeEngineReport(snapshots, comparison) {
  const latest = snapshots.at(-1); const safe = latest ? engineSnapshot(latest) : null;
  const empty = { schemaVersion: 1, inspection: 'passive-engine-worker-identification', 'no-additional-network-requests': true, runtime: { libraries: [] }, primaryMap: { containers: 0, index: null, reason: 'not-captured', mapObjectReachable: false }, layerAggregates: [], workers: [], serviceWorker: { apiAvailable: false, controllerPresent: false }, iframes: { count: 0, sameOriginCount: 0, crossOriginCount: 0, frames: [] }, scriptSignatures: [], diagnostics: {} };
  const report = safe || empty;
  return { ...report, diagnostics: { ...report.diagnostics, snapshotCount: snapshots.length, comparisonAvailable: Boolean(comparison?.available) }, comparison: comparison || { available: false, summary: 'comparison unavailable' }, privacy: { queryStrings: 'removed', fragments: 'removed', tileCoordinates: 'placeholders', workerMessages: 'not-observed', cadastralPropertyValues: 'not-observed', geometry: 'not-observed', credentials: 'not-observed' } };
}
export async function copyEngineReport(snapshots, comparison, clipboard = navigator.clipboard) { const text = JSON.stringify(safeEngineReport(snapshots, comparison), null, 2); await clipboard.writeText(text); return text; }
function pciSummaryText(section) {
  const latest = section.observations.at(-1);
  if (!latest) return 'status: waiting';
  if (latest.status !== 'observed') return `status: ${latest.status}\nreason: ${latest.reason}`;
  const identity = latest.parcelIdentity.propertyPresent ? `candidate keys ${latest.parcelIdentity.candidateKeys.join(', ')} (${latest.parcelIdentity.coverage})` : 'no property found';
  return `status: observed\nroot type: ${latest.rootType ?? latest.rootKind}\nfeatures: ${latest.featureCount}\ngeometry types: ${latest.geometryTypes.join(', ') || 'none'}\nparcel identity: ${identity}\nexplicit CRS: ${latest.explicitCrs}`;
}
function installCollector() {
  const resources = []; const facts = []; const mvtCandidates = []; const pciObservations = []; const engineSnapshots = []; let engineDiff; let diagnostics; let resourceFactsAccepted = 0; let resourceFactsRejected = 0; let mvtFactsAccepted = 0; let mvtFactsRejected = 0; let internal; let renderSnapshot; let visibleCadastreHandler; const visibleMap = globalThis.MonTerritoireVisibleMap?.createAbSession(); const selectionAb = globalThis.MonTerritoireVisibleSelection?.createSession();
  // MVP-06: rendered-basemap capture session (isolated world). The privileged call itself lives in the service worker.
  const rendered = globalThis.MonTerritoireRenderedBasemap?.createRenderedBasemap({ request: (type, detail) => document.dispatchEvent(new CustomEvent(type, { detail })), runtime: globalThis.chrome?.runtime, win: globalThis, raf: callback => globalThis.requestAnimationFrame(callback), createImage: () => document.createElement('img'), createCanvas: (width, height) => { const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; return canvas; } });
  // Product commands arrive from the extension popup over a runtime port; the page receives no UI of its own. Internal diagnostics
  // live in a detached element that is never attached to the document and are looked up here.
  const ui = { querySelector: selector => internal?.querySelector?.(selector) ?? null };
  const report = () => safeReport({ pciContourObservations: pciObservations, resources, facts, probeDiagnostics: diagnostics, resourceFactsAccepted, resourceFactsRejected }); const engineReport = () => safeEngineReport(engineSnapshots, engineDiff); const render = () => { if (!internal) return; const value = report(); ui.querySelector('#counts').textContent = `${value.totals.resourceCount} resources · ${value.totals.knownBytes} B`; ui.querySelector('#summary').textContent = JSON.stringify(value, null, 2); ui.querySelector('#pci-contour').textContent = pciSummaryText(value.pciContour); const mvt = mvtReport(); ui.querySelector('#mvt-counts').textContent = `Instrumentation active · ${mvt.diagnostics.candidatesObserved} candidates`; const engine = engineReport(); ui.querySelector('#engine-counts').textContent = `${engine.diagnostics.snapshotCount} snapshots · ${engine.workers.length} workers · map reachable: ${engine.primaryMap.mapObjectReachable}`; };
  const renderVisibleMap = () => {
    if (!internal || !visibleMap) return; const T = globalThis.MonTerritoireVisibleMap; const latest = visibleMap.state.B || visibleMap.state.A; const c = latest?.cadastreCandidate; const set = (id, text) => { ui.querySelector(id).textContent = text; };
    set('#vm-map-status', latest ? latest.map.status : 'not captured'); set('#vm-map-zoom', latest?.map.zoom === undefined ? 'n/a' : String(latest.map.zoom)); set('#vm-map-layers', latest ? String(latest.map.layerCount) : 'n/a');
    set('#vm-c-status', c ? c.status : 'not captured'); set('#vm-c-engine', c?.engine || 'n/a'); set('#vm-c-active', c ? String(c.active) : 'n/a'); set('#vm-c-cache', c ? `${c.tileCache.tiles} tiles · ${c.tileCache.vectorTiles} vector tiles` : 'n/a');
    set('#vm-c-features', c ? String(c.decodedFeatures) : 'n/a'); set('#vm-c-geometry', c ? (c.decodedGeometry.present ? c.decodedGeometry.representations.join(' + ') : c.rendererOnly ? 'none (renderer only)' : 'none') : 'n/a');
    set('#vm-c-keys', c ? (c.propertyKeys.join(', ') || 'none') : 'n/a'); set('#vm-c-export', c ? c.exportability.status : 'n/a');
    set('#vm-slots', `A ${visibleMap.state.A ? 'captured' : '—'} · B ${visibleMap.state.B ? 'captured' : '—'}`);
    set('#vm-conclusion', T.buildVisibleMapReport({ captureA: visibleMap.state.A, captureB: visibleMap.state.B }).conclusion.code);
  };
  const renderSelection = () => {
    if (!internal || !selectionAb) return; const set = (id, text) => { ui.querySelector(id).textContent = text; };
    set('#vs-slots', `A ${selectionAb.state.A ? 'capturée' : '—'} · B ${selectionAb.state.B ? 'capturée' : '—'}`);
  };
  const mvtReport = () => safeMvtReport({ candidates: mvtCandidates, diagnostics: { sanitizedFactsAccepted: mvtFactsAccepted, sanitizedFactsRejected: mvtFactsRejected } });
  document.addEventListener(EVENT, event => { const fact = validatePageFact(event?.detail); if (!fact) { if (event?.detail?.type === 'resource') resourceFactsRejected = Math.min(MAX_FACTS, resourceFactsRejected + 1); if (event?.detail?.type === 'mvt') mvtFactsRejected = Math.min(MAX_FACTS, mvtFactsRejected + 1); return; } if (fact.type === 'resource' && resources.length < MAX_FACTS) { resources.push(fact); resourceFactsAccepted++; } else if (fact.type === 'mvt' && mvtCandidates.length < MAX_FACTS) { mvtCandidates.push(fact); mvtFactsAccepted++; } else if (fact.type === 'pci-contour') { pciObservations.push(fact); if (pciObservations.length > MAX_PCI_OBSERVATIONS) pciObservations.shift(); } else if (fact.type === 'engine-snapshot' && engineSnapshots.length < 8) engineSnapshots.push(fact.snapshot); else if (fact.type === 'background-isolation' || fact.type === 'background-restore' || fact.type === 'basemap-ready') { rendered?.onFact(fact); return; } else if (fact.type === 'visible-cadastre') { visibleCadastreHandler?.(fact); return; } else if (fact.type === 'visible-map-capture') { visibleMap?.record(fact.capture.slot, fact.capture); renderVisibleMap(); } else if (fact.type === 'visible-selection-capture') { selectionAb?.record(fact.capture.slot, fact.capture); renderSelection(); return; } else if ((fact.type === 'dom' || fact.type === 'leaflet') && facts.length < MAX_FACTS) facts.push(fact); else if (fact.type === 'diagnostic') diagnostics = fact.probeDiagnostics; else { if (fact.type === 'resource') resourceFactsRejected = Math.min(MAX_FACTS, resourceFactsRejected + 1); if (fact.type === 'mvt') mvtFactsRejected = Math.min(MAX_FACTS, mvtFactsRejected + 1); return; } render(); });
  const signalReady = () => { if (document.documentElement) document.documentElement.setAttribute('data-mon-territoire-probe-ready', '1'); document.dispatchEvent(new CustomEvent(READY_EVENT)); };
  document.addEventListener(READY_REQUEST_EVENT, signalReady);
  signalReady();
  const installUi = () => {
    if (internal || !document.documentElement) return;
    internal = document.createElement('div'); internal.innerHTML = `<details class="visible-cadastre"><summary>CADASTRE VISIBLE</summary><pre id="vc-diagnostic">Aucun export.</pre></details><details class="visible-background"><summary>FOND CARTOGRAPHIQUE</summary><pre id="vb-diagnostic">Aucun export.</pre></details><details class="visible-selection"><summary>SÉLECTION PARCELLAIRE</summary><button id="vs-capture-a" type="button">Capture A — Aucune sélection</button><button id="vs-capture-b" type="button">Capture B — Parcelles sélectionnées</button><button id="vs-compare" type="button">Comparer A/B</button><span id="vs-slots">A — · B —</span><span id="vs-conclusion">n/a</span><pre id="vs-comparison">Aucune comparaison.</pre><button id="vs-copy" type="button">Copier le rapport de sélection</button></details><details class="visible-map"><summary>VISIBLE MAP / CADASTRE</summary><h2>Map</h2><dl><dt>status</dt><dd id="vm-map-status">not captured</dd><dt>zoom</dt><dd id="vm-map-zoom">n/a</dd><dt>layers</dt><dd id="vm-map-layers">n/a</dd></dl><h2>Cadastre candidate</h2><dl><dt>status</dt><dd id="vm-c-status">not captured</dd><dt>engine</dt><dd id="vm-c-engine">n/a</dd><dt>active</dt><dd id="vm-c-active">n/a</dd><dt>tile cache</dt><dd id="vm-c-cache">n/a</dd><dt>decoded features</dt><dd id="vm-c-features">n/a</dd><dt>decoded geometry</dt><dd id="vm-c-geometry">n/a</dd><dt>property keys</dt><dd id="vm-c-keys">n/a</dd><dt>exportability</dt><dd id="vm-c-export">n/a</dd></dl><span id="vm-slots">A — · B —</span><button id="vm-capture-a" type="button">Capture A — Cadastre OFF</button><button id="vm-capture-b" type="button">Capture B — Cadastre ON</button><button id="vm-compare" type="button">Comparer A/B</button><span id="vm-conclusion"></span><pre id="vm-comparison"></pre><button id="vm-copy" type="button">Copier rapport MVP-03A</button><button id="vm-download" type="button">Télécharger rapport MVP-03A</button></details><details class="devtools"><summary>Probe tools</summary><strong>Probe active</strong><span id="counts">0 resources · 0 B</span><details><summary>Sanitized summary</summary><pre id="summary" readonly></pre></details><button id="copy" type="button">Copy sanitized report</button><button id="download" type="button">Download sanitized JSON</button><hr><strong>PCI CONTOUR</strong><pre id="pci-contour">status: waiting</pre><hr><strong>T00-D MVT/PBF passive probe</strong><span id="mvt-counts">Instrumentation active · 0 candidates</span><button id="copy-mvt" type="button">Copy sanitized MVT report</button><button id="download-mvt" type="button">Download sanitized MVT report</button><hr><strong>Render inspection (T00-C)</strong><span id="render-counts">Not inspected</span><button id="inspect-render" type="button">Inspect render</button><button id="copy-render" type="button">Copy sanitized render report</button><button id="download-render" type="button">Download sanitized render report</button><hr><strong>T00-E Engine / Worker probe</strong><span id="engine-counts">0 snapshots · 0 workers · map reachable: false</span><button id="capture-engine" type="button">Capture engine snapshot</button><button id="compare-engine" type="button">Compare with previous snapshot</button><button id="copy-engine" type="button">Copy sanitized T00-E report</button><button id="download-engine" type="button">Download sanitized T00-E report</button></details>`;
  const saveSvg = (name, svg) => { const blob = new Blob([svg], { type: 'image/svg+xml' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); };
  const ports = new Set();
  let lastNotice = '';
  const notify = (phase, text) => { if (`${phase}:${text}` === lastNotice) return; lastNotice = `${phase}:${text}`; for (const port of [...ports]) { try { port.postMessage({ type: 'mte:status', phase, text }); } catch { ports.delete(port); } } };
  // Visible cadastre: availability is polled from the page's memory; the export only runs after an explicit popup command.
  const visibleButton = { disabled: true }; let exportPending = false; let lastStatus = null; let startExport = () => notify('error', 'Carte non détectée.');
  const T3B = globalThis.MonTerritoireVisibleCadastre; const SVG3B = globalThis.MonTerritoireGpkgSvg;
  const requestVisible = mode => document.dispatchEvent(new CustomEvent(VISIBLE_CADASTRE_REQUEST_EVENT, { detail: mode }));
  if (T3B && SVG3B?.exportVisibleCadastre) {
    let capturing = false;
    const RBM = globalThis.MonTerritoireRenderedBasemap;
    const finishExport = (fact, reason, report) => {
      try {
        const result = SVG3B.exportVisibleCadastre(fact); saveSvg(result.fileName, result.svg);
        ui.querySelector('#vc-diagnostic').textContent = T3B.diagnosticText(fact, selectionAb?.conclusionCode());
        ui.querySelector('#vb-diagnostic').textContent = [T3B.backgroundText(fact), report ? RBM.rbmDiagnosticText(report) : ''].filter(Boolean).join('\n\n');
        if (fact.selection) selectionAb?.recordExport(fact.selection.counts);
        notify('done', fact.background?.status === 'embedded' ? 'Terminé.' : `Terminé.\n${T3B.backgroundFallbackMessage}`);
      } catch (error) { console.warn('[mon-territoire-export]', error?.name, error?.code); notify('error', SVG3B.describeError(error)); }
      visibleButton.disabled = false;
    };
    visibleCadastreHandler = fact => {
      if (capturing) return;
      lastStatus = fact.status;
      if (!fact.features) { visibleButton.disabled = fact.status !== 'ready'; if (exportPending) { exportPending = false; notify('error', T3B.message(fact.status)); } return; }
      if (!exportPending) return; exportPending = false;
      // The page reader could not compose the tiles: ask for the rendered basemap. Any failure still exports the vector layers.
      if (!rendered || fact.background?.status !== 'unavailable') { finishExport(fact, null, null); return; }
      capturing = true; notify('preparing', 'Préparation du fond…');
      rendered.capture(fact.background, { onPhase: phase => { if (phase === 'loading') notify('preparing', 'Préparation du fond…'); else notify('exporting', 'Export…'); } }).then(result => {
        let exportFact = fact; let reason = result.reason || null;
        if (result.background) { const merged = T3B.validateCapture({ ...fact, background: result.background }); if (merged) exportFact = merged; else reason = 'invalid-background'; }
        finishExport(exportFact, reason, result.report);
      }, () => { finishExport(fact, 'transaction-error', null); }).finally(() => { capturing = false; });
    };
    startExport = () => {
      if (exportPending || capturing) { notify('exporting', 'Export…'); return; }
      if (visibleButton.disabled) requestVisible('status'); // the answer is synchronous: the flag is cleared when the cadastre is usable
      if (visibleButton.disabled) { notify('error', T3B.message(lastStatus || 'no-map')); return; }
      exportPending = true; visibleButton.disabled = true; notify('exporting', 'Export…'); requestVisible('export');
    };
    requestVisible('status'); globalThis.setTimeout?.(() => requestVisible('status'), 500);
    globalThis.setInterval?.(() => { if (!exportPending && !capturing && !document.hidden) requestVisible('status'); }, VISIBLE_CADASTRE_POLL_MS);
  }
  ui.querySelector('#copy').addEventListener('click', async () => { try { await copyReport(report()); } catch {} });
  ui.querySelector('#download').addEventListener('click', () => { const blob = new Blob([JSON.stringify(report(), null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'mon-territoire-probe-sanitized.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); }); render();
  ui.querySelector('#copy-mvt').addEventListener('click', async () => { try { await copyMvtReport(mvtReport()); } catch {} });
  ui.querySelector('#download-mvt').addEventListener('click', () => { const blob = new Blob([JSON.stringify(mvtReport(), null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'mon-territoire-mvt-sanitized.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); });
  const maskControl = globalThis.MonTerritoireMaskControl?.createMaskControl(document);
  const snapshot = () => {
    try {
      const inspector = globalThis.MonTerritoireRenderInspector?.inspectLeafletRender;
      if (!inspector) return;
      renderSnapshot = inspector(document, getComputedStyle);
      const panes = renderSnapshot.containers.reduce((sum, container) => sum + container.panes.length, 0);
      ui.querySelector('#render-counts').textContent = `${renderSnapshot.containers.length} containers · ${panes} panes`;
    } catch {}
  };
  ui.querySelector('#inspect-render').addEventListener('click', snapshot);
  ui.querySelector('#copy-render').addEventListener('click', async () => { if (!renderSnapshot) return; try { await copyRenderReport(renderSnapshot); } catch {} });
  ui.querySelector('#download-render').addEventListener('click', () => { if (!renderSnapshot) return; const blob = new Blob([JSON.stringify(renderSnapshot, null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'mon-territoire-render-inspection.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); });
  // Captures happen only on an explicit click; the user toggles the cadastre in Mon Territoire, never this probe.
  for (const [id, slot] of [['#vm-capture-a', 'A'], ['#vm-capture-b', 'B']]) ui.querySelector(id).addEventListener('click', () => document.dispatchEvent(new CustomEvent(VISIBLE_MAP_REQUEST_EVENT, { detail: slot })));
  ui.querySelector('#vm-compare').addEventListener('click', () => { if (!visibleMap) return; const comparison = visibleMap.compare(); ui.querySelector('#vm-comparison').textContent = JSON.stringify(comparison, null, 2); renderVisibleMap(); });
  ui.querySelector('#vm-copy').addEventListener('click', async () => { if (!visibleMap) return; try { await globalThis.MonTerritoireVisibleMap.copyVisibleMapReport(visibleMap.report()); } catch {} });
  ui.querySelector('#vm-download').addEventListener('click', () => { if (!visibleMap) return; const blob = new Blob([JSON.stringify(visibleMap.report(), null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'mon-territoire-mvp-03a-visible-map.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); });
  renderVisibleMap();
  if (!visibleMap) for (const id of ['#vm-capture-a', '#vm-capture-b', '#vm-compare', '#vm-copy', '#vm-download']) ui.querySelector(id).disabled = true;
  // Selection A/B: the user selects parcels in Mon Territoire; this probe only reads the resulting structure on click.
  if (selectionAb) {
    for (const [id, slot] of [['#vs-capture-a', 'A'], ['#vs-capture-b', 'B']]) ui.querySelector(id).addEventListener('click', () => document.dispatchEvent(new CustomEvent(VISIBLE_SELECTION_REQUEST_EVENT, { detail: slot })));
    ui.querySelector('#vs-compare').addEventListener('click', () => { const comparison = selectionAb.compare(); ui.querySelector('#vs-comparison').textContent = JSON.stringify(comparison, null, 2); ui.querySelector('#vs-conclusion').textContent = comparison.conclusion.code; });
    ui.querySelector('#vs-copy').addEventListener('click', async () => { try { await globalThis.MonTerritoireVisibleSelection.copyReport(selectionAb.report()); } catch {} });
  } else for (const id of ['#vs-capture-a', '#vs-capture-b', '#vs-compare', '#vs-copy']) ui.querySelector(id).disabled = true;
  renderSelection();
  ui.querySelector('#capture-engine').addEventListener('click', () => document.dispatchEvent(new CustomEvent(ENGINE_SNAPSHOT_REQUEST_EVENT)));
  ui.querySelector('#compare-engine').addEventListener('click', () => { engineDiff = engineComparison(engineSnapshots.at(-2), engineSnapshots.at(-1)); render(); });
  ui.querySelector('#copy-engine').addEventListener('click', async () => { try { await copyEngineReport(engineSnapshots, engineDiff); } catch {} });
  ui.querySelector('#download-engine').addEventListener('click', () => { const blob = new Blob([JSON.stringify(engineReport(), null, 2)], { type: 'application/json' }); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'mon-territoire-engine-worker-sanitized.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 0); });
  // Popup commands. The toolbar click that opens the popup is the gesture granting activeTab on this tab.
  const maskView = message => ({ type: 'mte:mask', state: maskControl ? maskControl.state() : 'absent', label: maskControl ? maskControl.label() : 'Masquer le masque', ...(message ? { message } : {}) });
  const onCommand = (message, port) => {
    try {
      if (message?.type === 'mte:export') { lastNotice = ''; rendered?.arm(); startExport(); }
      else if (message?.type === 'mte:mask-toggle') { const result = maskControl?.toggle(); port.postMessage(maskView(result === 'absent' || !maskControl ? globalThis.MonTerritoireMaskControl?.MASK_ABSENT_MESSAGE : '')); }
      else if (message?.type === 'mte:mask-state') port.postMessage(maskView(''));
    } catch {}
  };
  try { globalThis.chrome?.runtime?.onConnect?.addListener(port => {
    if (port?.name !== 'mte-popup' || port.sender?.id !== globalThis.chrome.runtime.id) return;
    ports.add(port); port.onDisconnect?.addListener(() => ports.delete(port)); port.onMessage?.addListener(message => onCommand(message, port));
  }); } catch {}
  };
  return { report, mvtReport, engineReport, installUi };
}
let collector;
if (typeof document !== 'undefined') {
  collector = installCollector();
  if (document.documentElement) collector.installUi();
  else document.addEventListener('DOMContentLoaded', collector.installUi, { once: true });
}
