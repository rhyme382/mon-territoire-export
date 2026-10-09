const EVENT = 'mon-territoire-probe:fact';
const READY_EVENT = 'mon-territoire-probe:ready';
const READY_REQUEST_EVENT = 'mon-territoire-probe:ready-request';
const ENGINE_SNAPSHOT_REQUEST_EVENT = 'mon-territoire-probe:engine-snapshot-request';
const MAX_BODY_BYTES = 1_000_000;
const MAX_FACTS = 200;

function normalized(input) {
  try {
    const url = new URL(input, globalThis.location?.href);
    if (!/^https?:$/.test(url.protocol) || url.pathname.length > 512) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith('/') || /[\u0000-\u001f\u007f?#]/.test(pathname)) return null;
    const result = { hostname: url.hostname, pathname };
    const match = result.pathname.match(/\/(\d+)\/(\d+)\/(\d+)(?:\.[a-z0-9]+)?$/i);
    if (match) result.zxy = { z: Number(match[1]), x: Number(match[2]), y: Number(match[3]) };
    return result;
  } catch { return null; }
}
export function sanitizeMvtPath(input) {
  const safe = normalized(input); if (!safe) return null;
  const pathname = safe.pathname.replace(/\/(\d+)\/(\d+)\/(\d+)(?=\.[a-z0-9]+$|$)/i, '/{z}/{x}/{y}');
  return { hostname: safe.hostname, pathname, tileCoordinatesPresent: Boolean(safe.zxy) };
}
function mime(response) { const value = response?.headers?.get?.('content-type') || ''; return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+/i.test(value) ? value.slice(0, 96) : undefined; }
function isMvtCandidate(source, contentType) {
  const safe = normalized(source); if (!safe) return false;
  const extension = /(?:\.pbf|\.mvt)$/i.test(safe.pathname);
  const thematicPath = /(?:cadastre|vector|tile)/i.test(safe.pathname);
  const mvtMime = /(?:protobuf|pbf|vector-tile|octet-stream)/i.test(contentType || '');
  return (extension && (safe.zxy || mvtMime || thematicPath)) || (mvtMime && (safe.zxy || thematicPath));
}
export function pbfSummary(buffer) {
  // Structural decoder only: MVT values and coordinate deltas are skipped immediately.
  try {
    if (buffer.byteLength > MAX_BODY_BYTES) throw Error('input-limit');
    const read = (bytes, state) => { let n = 0; for (let shift = 0; shift < 35; shift += 7) { if (state.i >= bytes.length) throw Error('truncated'); const b = bytes[state.i++]; n += (b & 127) * 2 ** shift; if (!(b & 128)) return n; } throw Error('invalid-varint'); };
    const slice = (bytes, state) => { const n = read(bytes, state); if (n < 0 || state.i + n > bytes.length) throw Error('truncated'); const out = bytes.subarray(state.i, state.i + n); state.i += n; return out; };
    const skip = (bytes, state, wire) => { if (wire === 0) read(bytes, state); else if (wire === 2) slice(bytes, state); else if (wire === 1) state.i += 8; else if (wire === 5) state.i += 4; else throw Error('unsupported-wire'); if (state.i > bytes.length) throw Error('truncated'); };
    const decodeText = bytes => { const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return value.length <= 96 && /^[\x20-\x7e]+$/.test(value) ? value : null; };
    const parseFeature = bytes => { const s = { i: 0 }; let type = 0; let vertices = 0; let hasId = false; while (s.i < bytes.length) { const tag = read(bytes, s), no = tag >>> 3, wire = tag & 7; if (no === 1 && wire === 0) { read(bytes, s); hasId = true; } else if (no === 3 && wire === 0) type = read(bytes, s); else if (no === 4 && wire === 2) { const geometry = slice(bytes, s), g = { i: 0 }; let commands = 0; while (g.i < geometry.length) { const command = read(geometry, g), id = command & 7, count = command >>> 3; if (!count || ![1, 2, 7].includes(id) || (commands += count) > 100000) throw Error('invalid-geometry'); if (id < 7) for (let i = 0; i < count; i++) { read(geometry, g); read(geometry, g); vertices++; } } } else skip(bytes, s, wire); } return { type, vertices, hasId }; };
    const tile = new Uint8Array(buffer), s = { i: 0 }, layers = []; let featureCount = 0, vertexCount = 0;
    while (s.i < tile.length) { const tag = read(tile, s), no = tag >>> 3, wire = tag & 7; if (no !== 3 || wire !== 2) { skip(tile, s, wire); continue; } if (layers.length >= 32) throw Error('limit-layers'); const bytes = slice(tile, s), l = { i: 0 }, layer = { propertyNames: [], geometryTypes: { Point: 0, LineString: 0, Polygon: 0 }, featureCount: 0, featuresWithId: 0 };
      while (l.i < bytes.length) { const lt = read(bytes, l), ln = lt >>> 3, lw = lt & 7; if (ln === 1 && lw === 2) layer.name = decodeText(slice(bytes, l)); else if (ln === 2 && lw === 2) { if (++layer.featureCount > 10000) throw Error('limit-features'); const feature = parseFeature(slice(bytes, l)); featureCount++; vertexCount += feature.vertices; if (feature.hasId) layer.featuresWithId++; const name = ({ 1: 'Point', 2: 'LineString', 3: 'Polygon' })[feature.type]; if (name) layer.geometryTypes[name]++; } else if (ln === 3 && lw === 2) { if (layer.propertyNames.length >= 128) throw Error('limit-properties'); const key = decodeText(slice(bytes, l)); if (key) layer.propertyNames.push(key); } else if (ln === 5 && lw === 0) layer.extent = read(bytes, l); else skip(bytes, l, lw); }
      if (!layer.name) throw Error('invalid-layer'); layers.push({ name: layer.name, ...(layer.extent !== undefined ? { extent: layer.extent } : {}), featureCount: layer.featureCount, featuresWithId: layer.featuresWithId, propertyNames: layer.propertyNames, geometryTypes: layer.geometryTypes }); }
    return { status: 'ok', byteCount: buffer.byteLength, layers, featureCount, vertexCount };
  } catch (error) { return { status: 'unreadable', reason: new Set(['input-limit', 'truncated', 'invalid-varint', 'unsupported-wire', 'invalid-geometry', 'limit-layers', 'limit-features', 'limit-properties', 'invalid-layer']).has(error instanceof Error ? error.message : '') ? error.message : 'invalid' }; }
}
export function summarizeObservedMvt(source, transport, contentType, buffer) {
  const safe = sanitizeMvtPath(source); if (!safe) return null;
  const byteLength = buffer instanceof ArrayBuffer ? buffer.byteLength : undefined;
  const decoded = buffer instanceof ArrayBuffer ? pbfSummary(buffer) : { status: 'unreadable', reason: 'body-unavailable' };
  // Only aggregated response-derived values cross the boundary; never the response body.
  return { type: 'mvt', ...safe, transport: initiator(transport), ...(contentType ? { contentType } : {}), ...(byteLength !== undefined ? { byteLength } : {}), bodyReadable: buffer instanceof ArrayBuffer, decoded: decoded.status === 'ok', ...(decoded.status === 'ok' ? { layers: decoded.layers } : { decodeFailure: decoded.reason }) };
}
function size(value) { return Number.isSafeInteger(value) && value >= 0 && value <= MAX_BODY_BYTES ? value : undefined; }
function initiator(value) { return typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/i.test(value) ? value.toLowerCase() : 'other'; }
function resourceFact(source, extra = {}) { const safe = normalized(source); return safe ? { type: 'resource', ...safe, ...extra } : null; }

export function createFactBridge(dispatch) {
  const queued = []; let ready = false;
  const diagnostics = { mainObserverStarted: true, fetchWrapped: false, xhrWrapped: false, performanceInitialScanCompleted: false, performanceObserverAvailable: false, performanceObserverStarted: false, resourceFactsEmitted: 0, resourceFactsAccepted: 0, resourceFactsRejected: 0, resourceFactsPending: 0, performanceResourcesSeen: 0, initiatorTypes: {} };
  const diagnostic = () => ({ type: 'diagnostic', probeDiagnostics: { ...diagnostics, initiatorTypes: { ...diagnostics.initiatorTypes } } });
  const send = detail => { if (ready) dispatch(detail); else if (queued.length < MAX_FACTS * 2) queued.push(detail); };
  return {
    diagnostics,
    resource(fact) { if (!fact || diagnostics.resourceFactsEmitted >= MAX_FACTS) return; diagnostics.resourceFactsEmitted++; if (!ready) diagnostics.resourceFactsPending++; send({ type: 'resource', ...fact }); send(diagnostic()); },
    fact(fact) { if (fact) send(fact); }, diagnostic,
    ready() { if (ready) return; ready = true; for (const fact of queued.splice(0)) { if (fact.type === 'resource') diagnostics.resourceFactsPending--; dispatch(fact); } dispatch(diagnostic()); }
  };
}
async function readBounded(response) {
  const reader = response.body?.getReader?.(); if (!reader) return null;
  const chunks = []; let length = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > MAX_BODY_BYTES) { await reader.cancel(); return null; } chunks.push(value); } const out = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; } return out.buffer; } catch { return null; }
}
function existingXhrArrayBuffer(xhr) {
  try {
    if (xhr.responseType === 'arraybuffer' && xhr.response instanceof ArrayBuffer) return xhr.response.byteLength <= MAX_BODY_BYTES ? xhr.response : null;
  } catch {}
  return null;
}
async function readExistingXhrBlob(xhr) {
  try { if (xhr.responseType === 'blob' && xhr.response instanceof Blob && xhr.response.size <= MAX_BODY_BYTES) return await xhr.response.arrayBuffer(); } catch {}
  return null;
}

export function createObservedFetch(originalFetch, emit) {
  return function observedFetch(...args) {
    const responsePromise = originalFetch.apply(this, args);
    const source = typeof args[0] === 'string' || args[0] instanceof URL ? String(args[0]) : args[0]?.url;
    Promise.resolve(responsePromise).then(response => {
      try {
        const fact = resourceFact(source || response.url, { initiatorType: 'fetch' }); if (!fact) return;
        const contentType = mime(response);
        if (response.type === 'opaque') { if (isMvtCandidate(source || response.url, contentType)) emit(summarizeObservedMvt(source || response.url, 'fetch', contentType, null)); else emit(fact); }
        else if (isMvtCandidate(source || response.url, contentType)) {
          readBounded(response.clone()).then(buffer => {
            emit(summarizeObservedMvt(source || response.url, 'fetch', contentType, buffer));
          });
        } else emit(fact);
      } catch { /* observer failures must be invisible to the page */ }
    }, () => { try { emit(isMvtCandidate(source, '') ? summarizeObservedMvt(source, 'fetch', undefined, null) : resourceFact(source, { initiatorType: 'fetch' })); } catch {} });
    return responsePromise;
  };
}
export function installXhr(emit, diagnostics = null) {
  const proto = globalThis.XMLHttpRequest?.prototype; if (!proto || proto.__mtProbeInstalled) return;
  Object.defineProperty(proto, '__mtProbeInstalled', { value: true });
  const observed = new WeakMap();
  const open = proto.open;
  proto.open = function observedOpen(method, url, ...rest) {
    // Preserve the application's call exactly; this observes only the instance it created.
    const result = open.call(this, method, url, ...rest);
    try {
      const source = typeof url === 'string' || url instanceof URL ? String(url) : '';
      const previous = observed.get(this);
      observed.set(this, { source, method: typeof method === 'string' ? method : '' }); // method is observation-only and never retained in reports
      if (previous) return result;
      this.addEventListener('load', () => {
        try {
          const state = observed.get(this); const source = state?.source || '';
          const fact = resourceFact(source, { initiatorType: 'xmlhttprequest' }); if (!fact) return;
          let contentType;
          try { contentType = mime({ headers: { get: name => name === 'content-type' ? this.getResponseHeader(name) : null } }); } catch { emit(fact); return; }
          if (isMvtCandidate(source, contentType)) {
            const buffer = existingXhrArrayBuffer(this);
            if (buffer) emit(summarizeObservedMvt(source, 'xmlhttprequest', contentType, buffer));
            else if (this.responseType === 'blob') readExistingXhrBlob(this).then(blob => emit(summarizeObservedMvt(source, 'xmlhttprequest', contentType, blob)));
            else emit(summarizeObservedMvt(source, 'xmlhttprequest', contentType, null));
          }
          else emit(fact);
        } catch { /* never affect the page */ }
      });
      this.addEventListener('error', () => { const failed = observed.get(this)?.source; emit(isMvtCandidate(failed, '') ? summarizeObservedMvt(failed, 'xmlhttprequest', undefined, null) : resourceFact(failed, { initiatorType: 'xmlhttprequest' })); });
    } catch { /* listener attachment is best effort only */ }
    return result;
  };
  if (diagnostics) diagnostics.xhrWrapped = true;
}
export function installPerformance(emit, diagnostics = null) {
  const observe = entry => { try {
    const type = initiator(entry.initiatorType); if (diagnostics) { diagnostics.performanceResourcesSeen++; diagnostics.initiatorTypes[type] = Math.min(MAX_FACTS, (diagnostics.initiatorTypes[type] || 0) + 1); }
    const fact = resourceFact(entry.name, { initiatorType: type, ...(size(entry.transferSize) !== undefined ? { transferSize: size(entry.transferSize) } : {}), ...(size(entry.encodedBodySize) !== undefined ? { encodedBodySize: size(entry.encodedBodySize) } : {}), ...(size(entry.decodedBodySize) !== undefined ? { decodedBodySize: size(entry.decodedBodySize) } : {}) });
    if (fact) emit(fact);
  } catch {} };
  try { performance.getEntriesByType('resource').forEach(observe); if (diagnostics) diagnostics.performanceInitialScanCompleted = true; } catch {}
  try {
    if (diagnostics) diagnostics.performanceObserverAvailable = typeof PerformanceObserver === 'function';
    if (typeof PerformanceObserver !== 'function') return;
    new PerformanceObserver(list => list.getEntries().forEach(observe)).observe({ type: 'resource' });
    if (diagnostics) diagnostics.performanceObserverStarted = true;
  } catch {}
}
export function leafletImages(images, base) {
  const dimension = value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : 0;
  return Array.from(images).slice(0, 64).flatMap(img => { try {
    if (!img.closest?.('.leaflet-container')) return [];
    const safe = normalized(new URL(img.currentSrc || img.src, base).href); if (!safe) return [];
    const category = img.classList?.contains('leaflet-tile') ? 'leaflet-tile' : img.classList?.contains('leaflet-image-layer') || img.closest?.('.leaflet-overlay-pane') ? 'overlay' : 'other';
    return [{ hostname: safe.hostname, pathname: safe.pathname, width: dimension(img.naturalWidth || img.width), height: dimension(img.naturalHeight || img.height), class: category }];
  } catch { return []; } });
}
function installDomFallback(emit) {
  const dimension = value => Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : 0;
  const count = value => Math.min(10_000, dimension(value));
  const host = value => /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(value) ? value : null;
  const transform = value => /^(?:none|matrix\((-?(?:\d+|\d*\.\d+))(?:,\s*-?(?:\d+|\d*\.\d+)){5}\)|translate(?:3d)?\(-?(?:\d+|\d*\.\d+)px,\s*-?(?:\d+|\d*\.\d+)px(?:,\s*-?(?:\d+|\d*\.\d+)px)?\))$/.test(value) ? value : 'none';
  const snapshot = () => { try {
    const root = document; const panes = [];
    for (const name of ['tile', 'overlay', 'marker', 'shadow', 'map', 'popup', 'tooltip', 'mask']) { const pane = root.querySelector(`.leaflet-${name}-pane`); if (pane) panes.push({ name, transform: transform(getComputedStyle(pane).transform) }); }
    const images = leafletImages(root.images, location.href);
    emit({ type: 'dom', leaflet: { containers: Math.min(100, root.querySelectorAll('.leaflet-container').length), viewport: { width: dimension(innerWidth), height: dimension(innerHeight) }, panes, svgCount: count(root.querySelectorAll('svg').length), canvasCount: count(root.querySelectorAll('canvas').length), imageCount: count(root.images.length), images, maskPane: Boolean(root.querySelector('.leaflet-mask-pane')) } });
  } catch {} };
  snapshot(); try { new MutationObserver(snapshot).observe(document.documentElement, { childList: true, subtree: true }); } catch {}
}
function install() {
  if (globalThis.__monTerritoireProbeInstalled) return;
  globalThis.__monTerritoireProbeInstalled = true;
  const bridge = createFactBridge(detail => { try { document.dispatchEvent(new CustomEvent(EVENT, { detail })); } catch {} });
  document.addEventListener(READY_EVENT, () => bridge.ready(), { once: true });
  document.addEventListener(ENGINE_SNAPSHOT_REQUEST_EVENT, () => {
    try { bridge.fact({ type: 'engine-snapshot', snapshot: globalThis.MonTerritoireEngineInspector?.capture?.() }); } catch {}
  });
  if (document.documentElement?.getAttribute('data-mon-territoire-probe-ready') === '1') bridge.ready();
  else document.dispatchEvent(new CustomEvent(READY_REQUEST_EVENT));
  try { globalThis.fetch = createObservedFetch(globalThis.fetch, fact => bridge.resource(fact)); bridge.diagnostics.fetchWrapped = true; } catch {}
  installXhr(fact => bridge.resource(fact), bridge.diagnostics); installPerformance(fact => bridge.resource(fact), bridge.diagnostics); installDomFallback(fact => bridge.fact(fact)); try { globalThis.MonTerritoirePciContour?.install(fact => bridge.fact(fact)); } catch {} bridge.fact(bridge.diagnostic());
}
if (typeof window !== 'undefined') install();
