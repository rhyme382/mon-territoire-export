// MVP-06, isolated world. Rendered-basemap capture: what the browser really painted for the basemap, without the
// cadastre, selection, mask, controls and extension UI, cropped to the exact map rectangle.
//
//   content script --(DOM event)--> MAIN world: wait until the visible basemap tiles are rendered (MVP-07, passive)
//   content script --(DOM event)--> MAIN world: hide (visibility only)       [visible-capture-isolation.js]
//   content script --(paint barrier: 2 animation frames)--
//   content script --(DOM event)--> MAIN world: last light check (tiles still ready, view unchanged)
//   content script --(runtime message)--> service worker: captureVisibleTab   [service-worker.js]
//   content script --(DOM event)--> MAIN world: restore, ALWAYS (finally)
//   content script: crop in a temporary canvas -> data:image/png -> ExportDocument raster layer
//
// Memory only: the tab screenshot, the canvas and the cropped image are never persisted. Only counters leave this file.
const RBM_ISOLATE_EVENT = 'mon-territoire-probe:background-isolate-request';
const RBM_RESTORE_EVENT = 'mon-territoire-probe:background-restore-request';
const RBM_CAPTURE_MESSAGE = 'mte:capture-visible-tab';
const RBM_READY_EVENT = 'mon-territoire-probe:basemap-ready-request';
const RBM_PHASE_TIMEOUT_MS = 1500;
const RBM_READY_TIMEOUT_MS = 6000; // the MAIN world gives up at 4 s on its own; this only covers a world that never answers
const RBM_ATTEMPTS = 2;
const RBM_CAPTURE_TIMEOUT_MS = 8000;
const RBM_EDGE_TOLERANCE = 0.5; // CSS px
const RBM_RATIO_TOLERANCE = 0.01;
const RBM_MIN_RATIO = 0.5;
const RBM_MAX_RATIO = 8;
const RBM_MAX_PIXELS = 2 ** 25;
const RBM_MAX_DATA_URI = 2 ** 26;
const RBM_FACT_TYPES = new Set(['background-isolation', 'background-restore', 'basemap-ready']);
const RBM_READY_VERDICTS = new Set(['ready', 'loading', 'error', 'timeout', 'view-changed', 'unavailable']);
const RBM_REASONS = new Set(['busy', 'no-map', 'no-view', 'no-rect', 'hide-failed', 'no-basemap', 'ambiguous-basemap', 'basemap-hidden']);
const RBM_PERMISSION_HINT = 'Cliquez sur l’icône de l’extension pour incorporer le fond.';

const rbmObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const rbmKeys = (value, keys) => rbmObject(value) && Object.keys(value).length === keys.length && keys.every(key => key in value);
const rbmCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
const rbmNumber = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000;

// ---- paint barrier ------------------------------------------------------------------------------------------------
// A style change is only guaranteed on screen after the frame that follows it: one frame to commit, one to be sure.
export function rbmPaintBarrier(raf, frames = 2) {
  return new Promise(resolve => {
    let remaining = frames;
    const step = () => { if (--remaining <= 0) resolve(); else raf(step); };
    raf(step);
  });
}

// ---- geometry: tab screenshot -> map rectangle ---------------------------------------------------------------
// rect: map content box in CSS px (viewport coordinates); viewport: CSS size of the tab viewport; image: screenshot pixels.
// The scale is derived from the screenshot itself (never from devicePixelRatio, which browser zoom and OS scaling decouple).
export function rbmComputeCrop({ rect, viewport, image, visual = { scale: 1, offsetLeft: 0, offsetTop: 0 }, size = null, transformed = false }) {
  const bad = reason => ({ ok: false, reason });
  if (![rect?.left, rect?.top, rect?.width, rect?.height, viewport?.width, viewport?.height, image?.width, image?.height].every(rbmNumber) || rect.width <= 0 || rect.height <= 0 || viewport.width <= 0 || viewport.height <= 0 || image.width <= 0 || image.height <= 0) return bad('invalid-input');
  if (transformed) return bad('map-transformed');
  if (Math.abs((visual.scale ?? 1) - 1) > 0.001 || Math.abs(visual.offsetLeft || 0) > RBM_EDGE_TOLERANCE || Math.abs(visual.offsetTop || 0) > RBM_EDGE_TOLERANCE) return bad('page-zoomed');
  if (size && (Math.abs(size.width - rect.width) > RBM_EDGE_TOLERANCE || Math.abs(size.height - rect.height) > RBM_EDGE_TOLERANCE)) return bad('size-mismatch');
  if (rect.left < -RBM_EDGE_TOLERANCE || rect.top < -RBM_EDGE_TOLERANCE || rect.left + rect.width > viewport.width + RBM_EDGE_TOLERANCE || rect.top + rect.height > viewport.height + RBM_EDGE_TOLERANCE) return bad('map-clipped');
  const ratioX = image.width / viewport.width; const ratioY = image.height / viewport.height;
  if (Math.abs(ratioX - ratioY) / Math.max(ratioX, ratioY) > RBM_RATIO_TOLERANCE) return bad('ratio-mismatch');
  if (ratioX < RBM_MIN_RATIO || ratioX > RBM_MAX_RATIO) return bad('ratio-out-of-range');
  const width = Math.round(rect.width * ratioX); const height = Math.round(rect.height * ratioY);
  if (width < 1 || height < 1 || width * height > RBM_MAX_PIXELS) return bad('too-large');
  let x = Math.round(rect.left * ratioX); let y = Math.round(rect.top * ratioY);
  x = Math.max(0, Math.min(x, image.width - width)); y = Math.max(0, Math.min(y, image.height - height)); // at most a rounding pixel
  if (x + width > image.width || y + height > image.height || Math.abs(x - rect.left * ratioX) > 1.5 || Math.abs(y - rect.top * ratioY) > 1.5) return bad('out-of-image');
  return { ok: true, ratio: Math.round(ratioX * 1000) / 1000, source: { x, y, width, height }, output: { width, height } };
}

// ---- transaction ------------------------------------------------------------------------------------------------
// hide -> paint -> capture -> restore. The restoration is in a `finally`: it runs whatever isolate / barrier / capture did,
// including when isolate never answered (the page may already have hidden something).
export async function rbmRunTransaction({ isolate, barrier, verify, capture, restore }) {
  let isolation = null; let shot = null; let failure = null; let restored = { restored: false };
  try {
    isolation = await isolate();
    if (!isolation || isolation.status !== 'isolated') failure = `isolation-${isolation?.reason || 'failed'}`;
    else { await barrier(); if (verify) await verify(); shot = await capture(); }
  } catch (error) { failure = error?.rbmReason || 'transaction-error'; }
  finally {
    try { restored = await restore() || restored; } catch { restored = { restored: false }; }
    try { await barrier(); } catch {} // let the browser repaint the restored page
  }
  return { isolation, shot, restored, failure };
}

// ---- crop ------------------------------------------------------------------------------------------------------
// Everything below happens after the page was restored. createImage / createCanvas are injected.
export function rbmLoadImage(dataUrl, createImage) {
  return new Promise((resolve, reject) => {
    const image = createImage(); image.onload = () => resolve(image); image.onerror = () => reject(Object.assign(new Error('image'), { rbmReason: 'image-decode-failed' }));
    image.src = dataUrl;
  });
}
export function rbmCropToDataUri(image, crop, createCanvas) {
  const canvas = createCanvas(crop.output.width, crop.output.height); const context = canvas.getContext('2d');
  context.drawImage(image, crop.source.x, crop.source.y, crop.source.width, crop.source.height, 0, 0, crop.output.width, crop.output.height);
  const dataUri = canvas.toDataURL('image/png');
  if (typeof dataUri !== 'string' || dataUri.length > RBM_MAX_DATA_URI || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUri)) throw Object.assign(new Error('encode'), { rbmReason: 'encode-failed' });
  return dataUri;
}

// Embedded-background record in the shape the export schema validates (method 'tab-capture-crop').
export function rbmBuildBackground(original, dataUri, crop) {
  const { reason: _reason, composition: _composition, ...rest } = original;
  return { ...rest, status: 'embedded', image: { dataUri, pixelWidth: crop.output.width, pixelHeight: crop.output.height }, composition: { method: 'tab-capture-crop', pixelWidth: crop.output.width, pixelHeight: crop.output.height, pixelRatio: crop.ratio } };
}

// ---- facts from the MAIN world (closed schema) ----------------------------------------------------------------------
export function rbmValidateFact(value) {
  if (!rbmObject(value) || !RBM_FACT_TYPES.has(value.type) || typeof value.transaction !== 'string' || !/^[a-z0-9-]{1,40}$/.test(value.transaction)) return null;
  if (value.type === 'basemap-ready') {
    const names = ['visible', 'ready', 'loading', 'error'];
    if (!rbmKeys(value, ['type', 'transaction', 'mode', 'verdict', 'counts', 'waitMs', 'timedOut', 'viewUnchanged']) || !['wait', 'check'].includes(value.mode) || !RBM_READY_VERDICTS.has(value.verdict)) return null;
    if (!rbmKeys(value.counts, names) || !names.every(name => rbmCount(value.counts[name])) || !rbmCount(value.waitMs) || typeof value.timedOut !== 'boolean' || typeof value.viewUnchanged !== 'boolean') return null;
    return { type: value.type, transaction: value.transaction, mode: value.mode, verdict: value.verdict, counts: Object.fromEntries(names.map(name => [name, value.counts[name]])), waitMs: value.waitMs, timedOut: value.timedOut, viewUnchanged: value.viewUnchanged };
  }
  if (value.type === 'background-restore') {
    if (!rbmKeys(value, ['type', 'transaction', 'restored', 'viewUnchanged', 'watchdog']) || ![value.restored, value.viewUnchanged, value.watchdog].every(flag => typeof flag === 'boolean')) return null;
    return { type: value.type, transaction: value.transaction, restored: value.restored, viewUnchanged: value.viewUnchanged, watchdog: value.watchdog };
  }
  if (value.status === 'unavailable') {
    if (!rbmKeys(value, ['type', 'transaction', 'status', 'reason']) || !RBM_REASONS.has(value.reason)) return null;
    return { type: value.type, transaction: value.transaction, status: 'unavailable', reason: value.reason };
  }
  if (value.status !== 'isolated' || !rbmKeys(value, ['type', 'transaction', 'status', 'rect', 'transformed', 'counts', 'confidence'])) return null;
  const { rect, counts } = value;
  const names = ['basemap', 'thematic', 'vector', 'controls', 'appUi', 'extension', 'minimaps', 'markers', 'unknown'];
  if (!rbmKeys(rect, ['left', 'top', 'width', 'height']) || !Object.values(rect).every(rbmNumber) || typeof value.transformed !== 'boolean' || !['high', 'medium', 'low'].includes(value.confidence) || !rbmKeys(counts, names) || !names.every(name => rbmCount(counts[name]))) return null;
  return { type: value.type, transaction: value.transaction, status: 'isolated', rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, transformed: value.transformed, confidence: value.confidence, counts: Object.fromEntries(names.map(name => [name, counts[name]])) };
}

// ---- session ----------------------------------------------------------------------------------------------------
// deps: request(eventType, detail) dispatches a DOM event to the MAIN world; runtime: chrome.runtime (or undefined);
// win: { innerWidth, innerHeight, visualViewport }; raf; createImage; createCanvas; setTimeout/clearTimeout.
export function createRenderedBasemap({ request, runtime, win, raf, createImage, createCanvas, setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  const pending = new Map(); let counter = 0; let armed = false;
  const withTimeout = (promise, ms, reason) => new Promise((resolve, reject) => {
    const timer = later(() => reject(Object.assign(new Error(reason), { rbmReason: reason })), ms);
    promise.then(value => { cancel(timer); resolve(value); }, error => { cancel(timer); reject(error); });
  });
  const EVENTS = { isolate: RBM_ISOLATE_EVENT, restore: RBM_RESTORE_EVENT, 'ready-wait': RBM_READY_EVENT, 'ready-check': RBM_READY_EVENT };
  const exchange = (type, transaction, ms = RBM_PHASE_TIMEOUT_MS) => withTimeout(new Promise(resolve => {
    pending.set(`${type}:${transaction}`, resolve);
    request(EVENTS[type], type.startsWith('ready-') ? `${type.slice(6)}:${transaction}` : transaction);
  }), ms, `${type}-timeout`).finally(() => pending.delete(`${type}:${transaction}`));
  const send = () => new Promise((resolve, reject) => {
    try { Promise.resolve(runtime.sendMessage({ type: RBM_CAPTURE_MESSAGE })).then(resolve, () => reject(Object.assign(new Error('message'), { rbmReason: 'message-failed' }))); }
    catch { reject(Object.assign(new Error('message'), { rbmReason: 'message-failed' })); }
  });
  return {
    get armed() { return armed; },
    arm() { armed = true; },
    // Facts coming back from the MAIN world (already routed by type by the caller).
    onFact(fact) {
      const clean = rbmValidateFact(fact); if (!clean) return false;
      const key = `${clean.type === 'basemap-ready' ? `ready-${clean.mode}` : clean.type === 'background-isolation' ? 'isolate' : 'restore'}:${clean.transaction}`;
      const resolve = pending.get(key); if (!resolve) return false;
      resolve(clean); return true;
    },
    // original: the (unavailable) background record of the export capture. Resolves with { background } or { background: null, reason }; never rejects.
    // onPhase('loading' | 'ready'): product feedback while the visible basemap tiles are being rendered.
    async capture(original, { onPhase } = {}) {
      const report = { apiAvailable: typeof runtime?.sendMessage === 'function', activeTab: armed ? 'armed' : 'not-armed', captureRequested: false, basemap: null, isolation: null, confidence: null, paintSync: 'double-animation-frame', captureSize: null, mapSize: null, pixelRatio: null, cropSize: null, rasterEmbedded: false, restored: null, watchdog: false, fallbackReason: null };
      const fail = reason => { report.fallbackReason = reason; return { background: null, reason, report }; };
      const phase = value => { try { onPhase?.(value); } catch {} };
      if (!report.apiAvailable) return fail('api-unavailable');
      let state = null;
      for (let attempt = 1; attempt <= RBM_ATTEMPTS; attempt++) {
        const transaction = `tx-${++counter}-${Math.random().toString(36).slice(2, 10)}`;
        // 1. barrier: nothing is hidden and nothing is captured until every visible basemap tile is rendered.
        phase('loading');
        let ready;
        try { ready = await exchange('ready-wait', transaction, RBM_READY_TIMEOUT_MS); } catch { return fail('basemap-wait-failed'); }
        report.basemap = { ...ready.counts, waitMs: ready.waitMs, timedOut: ready.timedOut, verdict: ready.verdict, attempts: attempt };
        if (ready.verdict === 'error') return fail('basemap-error');            // a hole would be embedded: vector-only export
        if (ready.verdict === 'timeout') return fail('basemap-timeout');
        if (ready.verdict === 'view-changed') return fail('view-changed');
        if (ready.verdict === 'loading') return fail('basemap-timeout');
        // 'unavailable' goes on: the isolation reports the precise reason (no map, no basemap, ambiguous...).
        if (ready.verdict === 'ready') phase('ready');
        // 2. hide -> paint -> last check -> capture -> restore.
        let recheck = null;
        try {
          state = await rbmRunTransaction({
            isolate: async () => { const fact = await exchange('isolate', transaction); if (fact.status === 'isolated') { report.isolation = { ...fact.counts }; report.confidence = fact.confidence; } return fact; },
            barrier: () => withTimeout(rbmPaintBarrier(raf), RBM_PHASE_TIMEOUT_MS, 'paint-timeout'),
            verify: ready.verdict !== 'ready' ? undefined : async () => {
              recheck = await exchange('ready-check', transaction);
              report.basemap = { ...report.basemap, recheck: recheck.verdict };
              if (!recheck.viewUnchanged) throw Object.assign(new Error('view'), { rbmReason: 'view-changed' });
              if (recheck.verdict !== 'ready') throw Object.assign(new Error('tiles'), { rbmReason: 'basemap-changed' });
            },
            capture: async () => { report.captureRequested = true; const response = await withTimeout(send(), RBM_CAPTURE_TIMEOUT_MS, 'capture-timeout'); if (!response?.ok) throw Object.assign(new Error('capture'), { rbmReason: typeof response?.reason === 'string' && /^[a-z-]{1,24}$/.test(response.reason) ? response.reason : 'capture-failed' }); return response; },
            restore: async () => { try { return await exchange('restore', transaction); } catch { return { restored: false, viewUnchanged: false, watchdog: false }; } },
          });
        } catch { return fail('transaction-error'); }
        report.restored = state.restored?.restored === true; report.watchdog = state.restored?.watchdog === true;
        // Tiles were renewed between the barrier and the capture (nothing was captured, the page is restored): wait once more.
        if (state.failure === 'basemap-changed' && attempt < RBM_ATTEMPTS && report.restored) continue;
        break;
      }
      if (state.failure) return fail(state.failure);
      if (!report.restored) return fail('restore-failed');
      if (!state.restored.viewUnchanged) return fail('view-changed'); // the map moved while hidden: the raster would not match the vectors
      try {
        const image = await rbmLoadImage(state.shot.dataUrl, createImage);
        const natural = { width: image.naturalWidth || image.width, height: image.naturalHeight || image.height };
        report.captureSize = natural; report.mapSize = { width: state.isolation.rect.width, height: state.isolation.rect.height };
        const visual = win.visualViewport ? { scale: win.visualViewport.scale, offsetLeft: win.visualViewport.offsetLeft, offsetTop: win.visualViewport.offsetTop } : undefined;
        const crop = rbmComputeCrop({ rect: state.isolation.rect, viewport: { width: win.innerWidth, height: win.innerHeight }, image: natural, visual, transformed: state.isolation.transformed });
        if (!crop.ok) return fail(crop.reason);
        report.pixelRatio = crop.ratio; report.cropSize = { ...crop.output };
        const dataUri = rbmCropToDataUri(image, crop, createCanvas);
        report.rasterEmbedded = true;
        return { background: rbmBuildBackground(original, dataUri, crop), report };
      } catch (error) { return fail(error?.rbmReason || 'crop-failed'); }
    },
  };
}

export function rbmDiagnosticText(report) {
  if (!report) return 'Aucune capture du fond.';
  const size = value => (value ? `${value.width} × ${value.height}` : 'n/a');
  const iso = report.isolation; const n = name => (iso ? iso[name] : 'n/a');
  const tiles = report.basemap;
  return ['CAPTURE DU FOND',
    `  basemap tiles visible: ${tiles ? tiles.visible : 'n/a'}`, `  basemap tiles ready: ${tiles ? tiles.ready : 'n/a'}`, `  basemap tiles loading: ${tiles ? tiles.loading : 'n/a'}`, `  basemap tiles error: ${tiles ? tiles.error : 'n/a'}`,
    `  basemap wait: ${tiles ? `${tiles.waitMs} ms` : 'n/a'}`, `  basemap wait timeout: ${tiles ? (tiles.timedOut ? 'yes' : 'no') : 'n/a'}`, `  basemap attempts: ${tiles ? tiles.attempts : 'n/a'}`,
    `  API available: ${report.apiAvailable ? 'yes' : 'no'}`, `  activeTab context: ${report.activeTab}`, `  capture requested: ${report.captureRequested ? 'yes' : 'no'}`,
    '  visual isolation mode: positive-basemap', `  basemap surfaces kept: ${n('basemap')}`, `  thematic raster kept: ${n('thematic')}`, `  vector overlays hidden: ${n('vector')}`, `  controls hidden: ${n('controls')}`, `  application UI hidden: ${n('appUi')}`, `  extension UI hidden: ${n('extension')}`, `  minimaps hidden: ${n('minimaps')}`, `  markers/popups/tooltips hidden: ${n('markers')}`, `  unknown intersecting elements: ${n('unknown')}`, `  isolation confidence: ${report.confidence || 'n/a'}`,
    `  paint synchronization: ${report.paintSync}`, `  capture dimensions: ${size(report.captureSize)}`, `  map rectangle: ${size(report.mapSize)}`,
    `  pixel ratio: ${report.pixelRatio ?? 'n/a'}`, `  crop dimensions: ${size(report.cropSize)}`, `  raster embedded: ${report.rasterEmbedded ? 'yes' : 'no'}`,
    `  restoration: ${report.restored === null ? 'n/a' : report.restored ? 'success' : 'failed'}${report.watchdog ? ' (watchdog)' : ''}`, `  fallback reason: ${report.fallbackReason || 'none'}`].join('\n');
}

if (typeof window !== 'undefined') globalThis.MonTerritoireRenderedBasemap = { createRenderedBasemap, rbmDiagnosticText, rbmValidateFact, rbmComputeCrop, rbmPaintBarrier, permissionHint: RBM_PERMISSION_HINT };
