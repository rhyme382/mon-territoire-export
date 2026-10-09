// T00-G: passive structural observation of the page's own PCI contour response.
// It never creates, replays or alters a request; it only reads the completed jqXHR the page already holds.
const CONTOUR_PATHNAME = '/cadastre/v1.0/pci/parcelle/geometries';
const MAX_RESPONSE_CHARS = 5_000_000;
const PCI_CONTOUR_MAX_ITEMS = 2000;
const MAX_NODES = 200_000;
const MAX_DEPTH = 12;
const MAX_KEYS = 32;
const MAX_REQUESTED = 100_000;
const GEOMETRY_TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon', 'GeometryCollection']);
const ROOT_TYPES = new Set([...GEOMETRY_TYPES, 'Feature', 'FeatureCollection']);
const CRS_KEY = /^(?:crs|srs|srid|epsg|projection|spatialreference)$/i;
const IDENTITY_KEY = /(?:^|_)(?:id|idu|par|parcelle|parcelles|ref|reference)(?:_|$)|idu|idpar/i;
const CRS_VALUE = /^(?:urn:ogc:def:crs:)?EPSG:{1,2}(\d{4,6})$/i;

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// Key names are schema vocabulary only; anything that could be data (long digit runs, odd characters) is redacted.
const safeName = key => /^[A-Za-z_][A-Za-z0-9_:-]{0,47}$/.test(key) && !/\d{3,}/.test(key);
const isGeometry = value => isObject(value) && typeof value.type === 'string' && (Array.isArray(value.coordinates) || Array.isArray(value.geometries));
const present = value => (typeof value === 'string' && value.length > 0) || Number.isFinite(value);

function rootKind(value) { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }

export function isContourRequest(input, base) {
  try {
    const raw = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    if (typeof raw !== 'string') return false;
    const url = new URL(raw, base);
    return url.pathname === CONTOUR_PATHNAME && url.searchParams.get('geometryType') === 'contour';
  } catch { return false; }
}

function crsDeclaration(value) {
  const candidate = typeof value === 'string' || typeof value === 'number' ? String(value) : value?.properties?.name ?? value?.name;
  if (typeof candidate !== 'string' && typeof candidate !== 'number') return 'unrecognized';
  const text = String(candidate);
  const match = CRS_VALUE.exec(text) || /^(\d{4,6})$/.exec(text);
  return match ? `EPSG:${match[1]}` : 'unrecognized';
}

function geometryStats(geometry, state, depthLimit = 3) {
  const name = GEOMETRY_TYPES.has(geometry.type) ? geometry.type : 'other';
  state.geometryTypes.add(name);
  if (Array.isArray(geometry.geometries)) {
    if (depthLimit > 0) for (const child of geometry.geometries.slice(0, 64)) if (isGeometry(child)) geometryStats(child, state, depthLimit - 1);
    return;
  }
  let deepest = 0;
  const walk = (node, depth) => {
    if (++state.nodes > MAX_NODES || depth > MAX_DEPTH) { state.truncated = true; return; }
    deepest = Math.max(deepest, depth);
    if (node.length >= 2 && node.length <= 3 && node.every(Number.isFinite)) {
      state.leaves++; state.dimensions.add(node.length);
      if (Math.abs(node[0]) > 180 || Math.abs(node[1]) > 90) state.outOfDegrees = true;
      return;
    }
    for (const child of node) { if (Array.isArray(child)) walk(child, depth + 1); else state.violation = true; }
  };
  if (Array.isArray(geometry.coordinates)) walk(geometry.coordinates, 1);
  state.maxDepth = Math.max(state.maxDepth, deepest);
  state.depthByType[name] = Math.max(state.depthByType[name] || 0, deepest);
}

function findItems(root) {
  if (Array.isArray(root)) return { items: root, source: 'array' };
  if (Array.isArray(root.features)) return { items: root.features, source: 'features' };
  if (root.type === 'Feature') return { items: [root], source: 'feature' };
  if (isGeometry(root)) return { items: [root], source: 'geometry' };
  for (const key of Object.keys(root).slice(0, 64)) {
    const value = root[key];
    if (Array.isArray(value) && value.length > 0 && value.every(isObject)) return { items: value, source: 'nested-array', key: safeName(key) ? key : undefined };
  }
  return { items: [], source: 'none' };
}

export function analyzeContourResponse(body, { responseLength, requestedIds } = {}) {
  if (Number.isFinite(responseLength) && responseLength > MAX_RESPONSE_CHARS) return { status: 'too-large', reason: 'response-too-large' };
  const kind = rootKind(body);
  if (body === undefined || body === null) return { status: 'invalid', reason: 'no-json', rootKind: kind };
  if (kind !== 'object' && kind !== 'array') return { status: 'invalid', reason: 'not-object-or-array', rootKind: kind };

  const state = { nodes: 0, truncated: false, geometryTypes: new Set(), dimensions: new Set(), depthByType: {}, maxDepth: 0, leaves: 0, violation: false, outOfDegrees: false };
  const summary = { status: 'observed', rootKind: kind };
  summary.rootType = isObject(body) && typeof body.type === 'string' ? (ROOT_TYPES.has(body.type) ? body.type : 'other') : null;
  if (isObject(body)) {
    const keys = Object.keys(body);
    summary.rootKeyCount = keys.length;
    if (keys.length <= MAX_KEYS) { summary.rootKeys = keys.filter(safeName).sort(); summary.redactedKeyCount = keys.length - summary.rootKeys.length; }
  }
  const found = findItems(body);
  summary.itemsSource = found.source;
  if (found.key) summary.itemsKey = found.key;
  summary.hasFeatures = isObject(body) && Array.isArray(body.features);
  summary.featureCount = found.items.length;
  const inspected = found.items.slice(0, PCI_CONTOUR_MAX_ITEMS);
  summary.featuresInspected = inspected.length;
  if (found.items.length > PCI_CONTOUR_MAX_ITEMS) state.truncated = true;

  const propertyKeys = new Set(); const crsLocations = new Set(); let crsValue; let geometryCount = 0; let featureIdPresent = false; let hasProperties = false;
  const records = [];
  const noteCrs = (location, container) => {
    for (const key of Object.keys(container).slice(0, 64)) if (CRS_KEY.test(key)) { crsLocations.add(location); if (crsValue === undefined) crsValue = container[key]; }
  };
  if (isObject(body)) noteCrs('root', body);
  for (const item of inspected) {
    if (!isObject(item)) continue;
    noteCrs('feature', item);
    let geometry = isGeometry(item) ? item : isGeometry(item.geometry) ? item.geometry : undefined;
    let geometryKey = geometry === item ? undefined : 'geometry';
    if (!geometry && item.type !== 'Feature') for (const key of Object.keys(item).slice(0, 32)) if (isGeometry(item[key])) { geometry = item[key]; geometryKey = key; break; }
    if (geometry) { geometryCount++; noteCrs('geometry', geometry); geometryStats(geometry, state); }
    if (present(item.id)) featureIdPresent = true;
    let props;
    if (item.type === 'Feature') props = isObject(item.properties) ? item.properties : undefined;
    else if (geometry === item) props = undefined;
    else { props = {}; for (const key of Object.keys(item).slice(0, 64)) if (key !== geometryKey && !isObject(item[key]) && !Array.isArray(item[key])) props[key] = item[key]; }
    if (props) {
      const keys = Object.keys(props).slice(0, 64);
      if (keys.length) hasProperties = true;
      noteCrs('properties', props);
      for (const key of keys) if (safeName(key) && propertyKeys.size < MAX_KEYS) propertyKeys.add(key);
      records.push(props);
    }
  }
  summary.geometryCount = geometryCount;
  summary.geometryTypes = [...state.geometryTypes].sort();
  summary.hasProperties = hasProperties;
  summary.propertyKeys = [...propertyKeys].sort();
  summary.explicitCrs = crsLocations.size > 0;
  summary.crsLocations = ['root', 'feature', 'geometry', 'properties'].filter(location => crsLocations.has(location));
  if (summary.explicitCrs) summary.crsDeclared = crsDeclaration(crsValue);
  summary.coordinateShape = {
    maxDepth: state.maxDepth,
    numericLeafPairs: state.leaves > 0 && !state.violation,
    dimensions: [...state.dimensions].sort(),
    valueRange: state.leaves === 0 ? 'unknown' : state.outOfDegrees ? 'exceeds-degree-bounds' : 'within-degree-bounds',
    depthByGeometryType: Object.fromEntries(Object.entries(state.depthByType).sort())
  };

  const candidateKeys = [...propertyKeys].filter(key => IDENTITY_KEY.test(key)).sort();
  const requested = Array.isArray(requestedIds) ? new Set(requestedIds.slice(0, MAX_REQUESTED).map(String)) : null;
  let best = { count: 0, unique: null }; let matched = 0;
  for (const key of candidateKeys) {
    const values = records.map(props => props[key]).filter(present).map(String);
    if (values.length > best.count) best = { count: values.length, unique: new Set(values).size === values.length };
    if (requested) matched = Math.max(matched, values.filter(value => requested.has(value)).length);
  }
  summary.parcelIdentity = {
    propertyPresent: candidateKeys.length > 0, candidateKeys, featureIdPresent,
    coverage: inspected.length > 0 && best.count === inspected.length ? 'all' : best.count > 0 ? 'some' : 'none',
    uniqueValues: best.count > 0 ? best.unique : null
  };
  if (requested) { summary.requestedCount = requested.size; summary.matchedRequestedCount = matched; }
  summary.truncated = state.truncated;
  return summary;
}

function requestedIdsOf(args) {
  const settings = typeof args[0] === 'string' || args[0] instanceof URL ? args[1] : args[0];
  const parcelles = isObject(settings?.data) ? settings.data.parcelles : undefined;
  if (Array.isArray(parcelles)) return parcelles.slice(0, MAX_REQUESTED);
  if (typeof parcelles === 'string') return parcelles.split(',', MAX_REQUESTED);
  return undefined;
}

export function createObservedAjax(original, emit, base) {
  return function observedAjax(...args) {
    let watch = false; let requestedIds;
    try { watch = isContourRequest(args[0], base); if (watch) requestedIds = requestedIdsOf(args); } catch {}
    const result = original.apply(this, args);
    try {
      if (watch && result && typeof result.always === 'function') {
        result.always(() => {
          try {
            const status = result.status;
            let summary;
            if (!(status >= 200 && status < 300)) summary = { status: 'invalid', reason: 'http-status' };
            else summary = analyzeContourResponse(result.responseJSON, { responseLength: typeof result.responseText === 'string' ? result.responseText.length : undefined, requestedIds });
            emit({ type: 'pci-contour', ...summary });
          } catch { /* observation must never affect the page */ }
        });
      }
    } catch { /* observation must never affect the page */ }
    return result;
  };
}

export function installContourObserver(global, emit) {
  const targets = [...new Set([global.jQuery, global.$])].filter(item => item && (typeof item === 'function' || typeof item === 'object') && typeof item.ajax === 'function');
  let ok = false;
  for (const jq of targets) {
    if (jq.ajax.__mtPciContourWrapped) { ok = true; continue; }
    try {
      const wrapper = createObservedAjax(jq.ajax, emit, global.location?.href);
      Object.defineProperty(wrapper, '__mtPciContourWrapped', { value: true });
      jq.ajax = wrapper; ok = true;
    } catch { /* frozen jQuery: stay silent */ }
  }
  return ok;
}

// jQuery may be defined after document_start: bounded retries (default 100 x 100 ms) plus one attempt on DOMContentLoaded/load.
export function scheduleContourInstall(global, emit, { setTimeoutFn = globalThis.setTimeout, maxAttempts = 100, intervalMs = 100 } = {}) {
  let attempts = 0; let installed = false;
  const attempt = () => {
    if (installed) return;
    attempts++;
    try { installed = installContourObserver(global, emit); } catch {}
    if (!installed && attempts < maxAttempts) setTimeoutFn(attempt, intervalMs);
  };
  attempt();
  for (const type of ['DOMContentLoaded', 'load']) { try { global.addEventListener?.(type, () => { if (!installed) { try { installed = installContourObserver(global, emit); } catch {} } }, { once: true }); } catch {} }
  return { installed: () => installed };
}

if (typeof window !== 'undefined') globalThis.MonTerritoirePciContour = { install: emit => scheduleContourInstall(globalThis, emit) };
