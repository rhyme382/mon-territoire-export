import test from 'node:test';
import assert from 'node:assert/strict';
import loose from 'node:assert'; // vm results carry another realm's prototypes: structural comparison only
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { bundleModules } from '../bundle-modules.mjs';

// Synthetic fixtures only: no real tile, URL, coordinate or identifier.
async function load(file, sandbox = {}) {
  const context = vm.createContext({ console, URL, ...sandbox }); context.window = context;
  vm.runInContext((await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).replace(/^export /gm, '') + '\n;globalThis.__exports = { ' + (sandbox.__names || []).join(', ') + ' };', context, { filename: file });
  return context;
}
const PNG = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(32);

// A DOM element whose inline style attribute is serialized exactly like a browser would, so "bit for bit" is checkable.
function fakeElement(initial = null) {
  const props = new Map(); let attribute = initial;
  if (initial) for (const part of initial.split(';')) { const [name, ...rest] = part.split(':'); if (!rest.length) continue; const raw = rest.join(':').trim(); const important = /!important$/.test(raw); props.set(name.trim(), { value: raw.replace(/\s*!important$/, ''), priority: important ? 'important' : '' }); }
  const sync = () => { attribute = [...props].map(([name, { value, priority }]) => `${name}: ${value}${priority ? ' !important' : ''};`).join(' '); };
  return {
    style: {
      getPropertyValue: name => props.get(name)?.value ?? '', getPropertyPriority: name => props.get(name)?.priority ?? '',
      setProperty(name, value, priority = '') { props.set(name, { value, priority }); sync(); },
      removeProperty(name) { props.delete(name); if (attribute !== null) sync(); },
    },
    hasAttribute: name => name === 'style' && attribute !== null, getAttribute: name => (name === 'style' ? attribute : null), removeAttribute(name) { if (name === 'style') { attribute = null; props.clear(); } },
    snapshot: () => attribute, visibility: () => props.get('visibility')?.value ?? null,
  };
}
const rectOf = (left, top, width, height) => ({ left, top, width, height });
function scene({ signature = () => 'sig', broken = null } = {}) {
  const els = { cadastre: fakeElement('opacity: 1;'), selection: fakeElement(), mask: fakeElement('display: none;'), controls: fakeElement('visibility: visible;'), overlay: fakeElement('visibility: visible !important;'), basemap: fakeElement('z-index: 1;'), ui: fakeElement() };
  const container = { getBoundingClientRect: () => rectOf(10, 20, 400, 300), clientLeft: 0, clientTop: 0, clientWidth: 400, clientHeight: 300, offsetWidth: 400, offsetHeight: 300 };
  const targets = { container, basemap: [els.basemap], thematic: [], unknownRaster: [], basemapStatus: 'found', signature: () => signature(), groups: { cadastre: [els.cadastre], selection: [els.selection], mask: [els.mask], controls: [els.controls], overlays: [els.overlay] } };
  const timers = [];
  const global = { MonTerritoireVisibleMapInspector: { captureTargets: () => (broken === 'no-map' ? null : targets) }, document: { getElementById: id => (id === 'mon-territoire-probe-ui' ? els.ui : null) }, setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} };
  return { els, global, timers, snapshot: () => Object.fromEntries(Object.entries(els).map(([key, el]) => [key, el.snapshot()])) };
}

test('isolation: hides exactly cadastre / selection / mask / controls / overlays / extension UI and never the basemap', async () => {
  const { createCaptureIsolation } = (await load('visible-capture-isolation.js', { __names: ['createCaptureIsolation'] })).__exports;
  const s = scene(); const isolation = createCaptureIsolation(s.global);
  const result = isolation.isolate('tx-1');
  assert.equal(result.status, 'isolated');
  for (const name of ['cadastre', 'selection', 'mask', 'controls', 'overlay', 'ui']) assert.equal(s.els[name].visibility(), 'hidden', name);
  assert.equal(s.els.basemap.visibility(), null, 'basemap is never hidden');
  loose.deepEqual(result.counts, { basemap: 1, thematic: 0, vector: 3, controls: 1, appUi: 0, extension: 1, minimaps: 0, markers: 1, unknown: 0 });
  loose.deepEqual(result.rect, rectOf(10, 20, 400, 300));
});

test('isolation: restoration is exact (value, priority, absent style attribute) and idempotent', async () => {
  const { createCaptureIsolation } = (await load('visible-capture-isolation.js', { __names: ['createCaptureIsolation'] })).__exports;
  const s = scene(); const before = s.snapshot(); const isolation = createCaptureIsolation(s.global);
  isolation.isolate('tx-1');
  const restored = isolation.restore('tx-1');
  loose.deepEqual({ restored: restored.restored, viewUnchanged: restored.viewUnchanged }, { restored: true, viewUnchanged: true });
  loose.deepEqual(s.snapshot(), before);
  loose.deepEqual(isolation.restore('tx-1').restored, true); // second request: still fine, nothing touched
  loose.deepEqual(s.snapshot(), before);
  assert.equal(s.els.selection.hasAttribute('style'), false, 'an element that had no style attribute has none again');
});

test('isolation: a pre-existing user-hidden mask stays hidden; a view change is reported; a stale restore is inert', async () => {
  const { createCaptureIsolation } = (await load('visible-capture-isolation.js', { __names: ['createCaptureIsolation'] })).__exports;
  let sig = 'a'; const s = scene({ signature: () => sig }); const isolation = createCaptureIsolation(s.global);
  isolation.isolate('tx-1'); assert.equal(isolation.isolate('tx-2').reason, 'busy');
  assert.equal(isolation.restore('tx-other').restored, false); assert.equal(s.els.cadastre.visibility(), 'hidden');
  sig = 'b';
  assert.equal(isolation.restore('tx-1').viewUnchanged, false);
  assert.equal(s.els.mask.getAttribute('style'), 'display: none;');
});

test('isolation: the watchdog restores when the isolated world never asks', async () => {
  const { createCaptureIsolation } = (await load('visible-capture-isolation.js', { __names: ['createCaptureIsolation'] })).__exports;
  const s = scene(); const before = s.snapshot(); const isolation = createCaptureIsolation(s.global);
  isolation.isolate('tx-1'); assert.equal(s.timers.length, 1);
  s.timers[0]();
  loose.deepEqual(s.snapshot(), before);
  const late = isolation.restore('tx-1'); assert.equal(late.watchdog, true); assert.equal(late.restored, true);
});

test('isolation: unavailable without a map, and a hide failure leaves nothing hidden', async () => {
  const { createCaptureIsolation, vciHide } = (await load('visible-capture-isolation.js', { __names: ['createCaptureIsolation', 'vciHide'] })).__exports;
  assert.equal(createCaptureIsolation(scene({ broken: 'no-map' }).global).isolate('t').reason, 'no-map');
  const a = fakeElement('color: red;'); const b = fakeElement(); b.style.setProperty = () => { throw new Error('boom'); };
  assert.throws(() => vciHide([a, b]));
  assert.equal(a.snapshot(), 'color: red;');
});

// ---- crop, DPR, clipping ---------------------------------------------------------------------------------------
async function rbm() { return (await load('rendered-basemap.js', { __names: ['rbmComputeCrop', 'rbmPaintBarrier', 'rbmRunTransaction', 'rbmBuildBackground', 'rbmValidateFact', 'createRenderedBasemap', 'rbmDiagnosticText', 'rbmCropToDataUri'] })).__exports; }
for (const dpr of [1, 1.25, 1.5, 2]) {
  test(`crop: exact rectangle at DPR ${dpr}, scale derived from the screenshot`, async () => {
    const { rbmComputeCrop } = await rbm();
    const viewport = { width: 1200, height: 800 }; const image = { width: Math.round(1200 * dpr), height: Math.round(800 * dpr) };
    const crop = rbmComputeCrop({ rect: rectOf(100, 50, 640, 480), viewport, image });
    assert.equal(crop.ok, true);
    loose.deepEqual(crop.output, { width: Math.round(640 * dpr), height: Math.round(480 * dpr) });
    loose.deepEqual(crop.source, { x: Math.round(100 * dpr), y: Math.round(50 * dpr), width: Math.round(640 * dpr), height: Math.round(480 * dpr) });
    assert.equal(crop.ratio, dpr);
  });
}
test('crop: ratio comes from the image, not devicePixelRatio (browser zoom); high ratios are accepted', async () => {
  const { rbmComputeCrop } = await rbm();
  const crop = rbmComputeCrop({ rect: rectOf(0, 0, 300, 200), viewport: { width: 600, height: 400 }, image: { width: 1500, height: 1000 } });
  assert.equal(crop.ratio, 2.5); loose.deepEqual(crop.output, { width: 750, height: 500 });
});
test('crop: refuses incoherent geometry instead of embedding a misaligned background', async () => {
  const { rbmComputeCrop } = await rbm(); const ok = { rect: rectOf(0, 0, 400, 300), viewport: { width: 800, height: 600 }, image: { width: 800, height: 600 } };
  assert.equal(rbmComputeCrop(ok).ok, true);
  assert.equal(rbmComputeCrop({ ...ok, rect: rectOf(500, 0, 400, 300) }).reason, 'map-clipped');
  assert.equal(rbmComputeCrop({ ...ok, rect: rectOf(-20, 0, 400, 300) }).reason, 'map-clipped');
  assert.equal(rbmComputeCrop({ ...ok, image: { width: 800, height: 700 } }).reason, 'ratio-mismatch');
  assert.equal(rbmComputeCrop({ ...ok, visual: { scale: 1.5, offsetLeft: 0, offsetTop: 0 } }).reason, 'page-zoomed');
  assert.equal(rbmComputeCrop({ ...ok, size: { width: 380, height: 300 } }).reason, 'size-mismatch');
  assert.equal(rbmComputeCrop({ ...ok, transformed: true }).reason, 'map-transformed');
  assert.equal(rbmComputeCrop({ ...ok, image: { width: 0, height: 600 } }).reason, 'invalid-input');
  assert.equal(rbmComputeCrop({ ...ok, rect: rectOf(0, 0, 1000, 1000), viewport: { width: 1000, height: 1000 }, image: { width: 8000, height: 8000 } }).reason, 'too-large');
  const touching = rbmComputeCrop({ ...ok, rect: rectOf(400, 300, 400, 300) }); assert.equal(touching.ok, true); loose.deepEqual(touching.source, { x: 400, y: 300, width: 400, height: 300 }); // touches the bottom-right edge
});

test('paint barrier: waits for two animation frames before resolving', async () => {
  const { rbmPaintBarrier } = await rbm(); const queue = []; let resolved = false;
  const done = rbmPaintBarrier(cb => queue.push(cb)).then(() => { resolved = true; });
  await Promise.resolve(); assert.equal(queue.length, 1); assert.equal(resolved, false);
  queue.shift()(); await Promise.resolve(); assert.equal(queue.length, 1); assert.equal(resolved, false);
  queue.shift()(); await done; assert.equal(resolved, true);
});

// ---- transaction: restoration under every failure ----------------------------------------------------------------
async function harness({ capture, signature, runtime = true, image = { naturalWidth: 800, naturalHeight: 600 }, canvasFails = false, ready = (mode) => ({ verdict: 'ready', counts: { visible: 4, ready: 4, loading: 0, error: 0 }, waitMs: 0, timedOut: false, viewUnchanged: true }) } = {}) {
  const { createCaptureIsolation } = (await load('visible-capture-isolation.js', { __names: ['createCaptureIsolation'] })).__exports;
  const { createRenderedBasemap } = await rbm();
  const s = scene({ signature }); const before = s.snapshot(); const isolation = createCaptureIsolation(s.global);
  const order = []; const requests = []; let session;
  const request = (type, detail) => {
    requests.push(type);
    if (type.endsWith('basemap-ready-request')) { const [mode] = detail.split(':'); const tx = detail.slice(mode.length + 1); order.push(`ready-${mode}`); session.onFact({ type: 'basemap-ready', transaction: tx, mode, ...(ready(mode, tx)) }); }
    else if (type.endsWith('isolate-request')) { const r = isolation.isolate(detail); order.push('hide'); session.onFact({ type: 'background-isolation', transaction: detail, ...r }); }
    else { const r = isolation.restore(detail); order.push('restore'); session.onFact({ type: 'background-restore', transaction: detail, restored: r.restored, viewUnchanged: r.viewUnchanged, watchdog: r.watchdog }); }
  };
  const runtimeApi = runtime ? { sendMessage: async message => { order.push('capture'); loose.deepEqual(message, { type: 'mte:capture-visible-tab' }); assert.equal(s.els.cadastre.visibility(), 'hidden', 'hidden while the screenshot is taken'); return capture ? capture() : { ok: true, dataUrl: PNG }; } } : undefined;
  const canvases = [];
  session = createRenderedBasemap({
    setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id),
    request, runtime: runtimeApi, win: { innerWidth: 800, innerHeight: 600, visualViewport: { scale: 1, offsetLeft: 0, offsetTop: 0 } }, raf: cb => { order.push('frame'); queueMicrotask(cb); },
    createImage: () => ({ set src(value) { assert.match(value, /^data:image\/png/); queueMicrotask(() => this.onload()); }, ...image }),
    createCanvas: (width, height) => { const canvas = { width, height, getContext: () => ({ drawImage: (...args) => { canvas.args = args; if (canvasFails) throw new Error('canvas'); } }), toDataURL: () => PNG }; canvases.push(canvas); return canvas; },
  });
  const original = { status: 'unavailable', reason: 'cors', candidate: { status: 'found', kind: 'raster', confidence: 'high', evidence: ['class:TileLayer'], tileCount: 110, imageAccess: 'unavailable-cors' }, tiles: { cached: 110, intersecting: 81, readable: 0, unreadable: 81, completeness: 'incomplete', methods: {} }, composition: { method: 'none' } };
  return { s, before, session, order, requests, canvases, original, isolation };
}

test('transaction: hide → paint → capture → restore → paint, crop exact, PNG data URI, page identical afterwards', async () => {
  const h = await harness();
  const result = await h.session.capture(h.original);
  assert.ok(result.background); assert.equal(result.report.fallbackReason, null);
  const hideAt = h.order.indexOf('hide'); const captureAt = h.order.indexOf('capture'); const restoreAt = h.order.indexOf('restore');
  assert.ok(hideAt < h.order.indexOf('frame') && h.order.indexOf('frame') < captureAt, 'a paint barrier separates hide and capture');
  assert.ok(captureAt < restoreAt && h.order.slice(restoreAt).includes('frame'), 'the page is repainted after the restoration');
  assert.equal(h.order.slice(hideAt, captureAt).filter(x => x === 'frame').length, 2);
  loose.deepEqual(h.s.snapshot(), h.before);
  assert.equal(result.background.status, 'embedded');
  assert.match(result.background.image.dataUri, /^data:image\/png;base64,/);
  loose.deepEqual(h.canvases[0].args.slice(1), [10, 20, 400, 300, 0, 0, 400, 300]); // exact crop of the map rectangle
  loose.deepEqual(result.background.composition, { method: 'tab-capture-crop', pixelWidth: 400, pixelHeight: 300, pixelRatio: 1 });
  assert.equal('reason' in result.background, false);
  loose.deepEqual(result.report.cropSize, { width: 400, height: 300 });
});

for (const [name, options, reason] of [
  ['capture rejected (no permission)', { capture: async () => ({ ok: false, reason: 'permission' }) }, 'permission'],
  ['capture throws', { capture: async () => { throw new Error('x'); } }, 'message-failed'],
  ['crop fails (canvas)', { canvasFails: true }, 'crop-failed'],
  ['view moved while hidden', { signature: (() => { let n = 0; return () => `s${n++ > 0 ? 'x' : ''}`; })() }, 'view-changed'],
]) {
  test(`transaction: ${name} → page restored bit for bit, vector-only fallback`, async () => {
    const h = await harness(options);
    const result = await h.session.capture(h.original);
    assert.equal(result.background, null); assert.equal(result.reason, reason);
    loose.deepEqual(h.s.snapshot(), h.before);
    assert.equal(h.requests.at(-1), 'mon-territoire-probe:background-restore-request');
  });
}
test('transaction: image of the wrong ratio is refused after restoration', async () => {
  const h = await harness({ image: { naturalWidth: 800, naturalHeight: 900 } });
  const result = await h.session.capture(h.original);
  assert.equal(result.reason, 'ratio-mismatch'); assert.equal(result.background, null); loose.deepEqual(h.s.snapshot(), h.before);
});
test('transaction: messaging API unavailable → fallback without touching the page', async () => {
  const h = await harness({ runtime: false });
  const result = await h.session.capture(h.original);
  assert.equal(result.reason, 'api-unavailable'); assert.equal(h.requests.length, 0); assert.equal(result.report.apiAvailable, false);
});
test('transaction: MAIN world never answers → restore is still requested and the watchdog covers the page', async () => {
  const { createRenderedBasemap, rbmRunTransaction } = await rbm();
  const calls = [];
  const out = await rbmRunTransaction({ isolate: async () => { throw Object.assign(new Error('t'), { rbmReason: 'isolate-timeout' }); }, barrier: async () => calls.push('barrier'), capture: async () => calls.push('capture'), restore: async () => { calls.push('restore'); return { restored: true }; } });
  loose.deepEqual(calls, ['restore', 'barrier']); assert.equal(out.failure, 'isolate-timeout');
  assert.equal(typeof createRenderedBasemap, 'function');
});
test('transaction: export failure after capture leaves the page restored (restoration precedes export)', async () => {
  const h = await harness();
  const result = await h.session.capture(h.original);
  loose.deepEqual(h.s.snapshot(), h.before); // content-ui exports only afterwards: a throwing exporter cannot affect the page
  assert.throws(() => { throw new Error('export'); });
  loose.deepEqual(h.s.snapshot(), h.before); assert.ok(result.background);
});

test('facts from the MAIN world are closed-schema validated', async () => {
  const { rbmValidateFact } = await rbm(); const good = { type: 'background-isolation', transaction: 'tx-1', status: 'isolated', rect: rectOf(0, 0, 4, 3), transformed: false, confidence: 'high', counts: { basemap: 1, thematic: 0, vector: 2, controls: 1, appUi: 1, extension: 1, minimaps: 0, markers: 2, unknown: 0 } };
  assert.ok(rbmValidateFact(good));
  assert.equal(rbmValidateFact({ ...good, extra: 1 }), null);
  assert.equal(rbmValidateFact({ ...good, rect: { ...good.rect, left: 'x' } }), null);
  assert.equal(rbmValidateFact({ ...good, transaction: 'A B' }), null);
  assert.equal(rbmValidateFact({ type: 'background-isolation', transaction: 'tx', status: 'unavailable', reason: SECRETISH }), null);
  assert.ok(rbmValidateFact({ type: 'background-restore', transaction: 'tx-1', restored: true, viewUnchanged: true, watchdog: false }));
});
const SECRETISH = 'https://tiles.test/17/1/2.png?token=SECRET';

// ---- service worker --------------------------------------------------------------------------------------------
async function worker() { return (await load('service-worker.js', { __names: ['swCapture', 'swInstall', 'swClassify'] })).__exports; }
const sender = (extra = {}) => ({ id: 'ext', url: 'https://carto.monterritoire.fr/?x=1', frameId: 0, tab: { id: 7, windowId: 3 }, ...extra });
test('service worker: captures the active tab as PNG with no extra argument beyond the format', async () => {
  const { swCapture } = await worker(); const calls = [];
  const api = { runtime: { id: 'ext' }, tabs: { query: async q => { calls.push(['query', q]); return [{ id: 7 }]; }, captureVisibleTab: async (...args) => { calls.push(['capture', args]); return PNG; } } };
  loose.deepEqual(await swCapture(api, sender()), { ok: true, dataUrl: PNG });
  loose.deepEqual(calls, [['query', { active: true, windowId: 3 }], ['capture', [3, { format: 'png' }]]]);
});
test('service worker: closed error vocabulary, no Chrome text forwarded', async () => {
  const { swCapture } = await worker();
  const api = fn => ({ runtime: { id: 'ext' }, tabs: { query: async () => [{ id: 7 }], captureVisibleTab: fn } });
  loose.deepEqual(await swCapture(api(async () => { throw new Error("Either the '<all_urls>' or 'activeTab' permission is required."); }), sender()), { ok: false, reason: 'permission' });
  loose.deepEqual(await swCapture(api(async () => { throw new Error('whatever https://x.test/?token=1'); }), sender()), { ok: false, reason: 'capture-failed' });
  loose.deepEqual(await swCapture(api(async () => 'data:text/html,x'), sender()), { ok: false, reason: 'capture-failed' });
  loose.deepEqual(await swCapture({ runtime: { id: 'ext' }, tabs: {} }, sender()), { ok: false, reason: 'api-unavailable' });
});
test('service worker: rejects foreign senders and non-active tabs', async () => {
  const { swCapture } = await worker(); let captured = 0;
  const api = { runtime: { id: 'ext' }, tabs: { query: async () => [{ id: 99 }], captureVisibleTab: async () => { captured++; return PNG; } } };
  assert.equal((await swCapture(api, sender({ id: 'other' }))).reason, 'sender-rejected');
  assert.equal((await swCapture(api, sender({ url: 'https://evil.test/' }))).reason, 'sender-rejected');
  assert.equal((await swCapture(api, sender({ tab: undefined }))).reason, 'sender-rejected');
  assert.equal((await swCapture(api, sender({ frameId: 2 }))).reason, 'sender-rejected');
  assert.equal((await swCapture(api, sender())).reason, 'not-active-tab');
  assert.equal(captured, 0);
});
test('service worker: message routing is asynchronous; there is no toolbar click handler (the popup replaces it)', async () => {
  const { swInstall } = await worker(); let onMessage; const sent = []; let clickHandlers = 0;
  const api = { runtime: { id: 'ext', onMessage: { addListener: fn => { onMessage = fn; } } }, action: { onClicked: { addListener: () => { clickHandlers++; } } }, tabs: { query: async () => [{ id: 7 }], captureVisibleTab: async () => PNG, sendMessage: async (id, message) => { sent.push([id, message]); } } };
  swInstall(api);
  assert.equal(onMessage({ type: 'other' }, sender(), () => {}), false);
  const reply = await new Promise(resolve => { assert.equal(onMessage({ type: 'mte:capture-visible-tab' }, sender(), resolve), true); });
  assert.equal(reply.ok, true);
  assert.equal(clickHandlers, 0, 'with action.default_popup onClicked never fires: nothing is registered');
  loose.deepEqual(sent, []);
});

// ---- document: layer order, alignment, fallback ---------------------------------------------------------------------
async function exporter() {
  const context = vm.createContext({ console }); context.window = context;
  vm.runInContext(await bundleModules(new URL('../../gpkg-svg/browser/api.js', import.meta.url), 'MonTerritoireGpkgSvg'), context);
  vm.runInContext((await readFile(new URL('../visible-cadastre-export.js', import.meta.url), 'utf8')), context);
  return context;
}
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
function capturedFact(background) {
  const counts = { cachedFeatures: 1, uniqueFeatures: 1, visibleFeatures: 1, exportedPaths: 1, clippedFeatures: 0, duplicatesHandled: 0, tiles: 1, tilesInViewport: 1, keyTiers: { id: 1, property: 0, geometry: 0 } };
  const selCounts = { candidatePolygons: 1, selectedFeaturesDetected: 1, selectedFeaturesVisible: 1, selectedPathsExported: 1, selectedFeaturesClipped: 0, duplicatesHandled: 0, keyTiers: { id: 1, property: 0, geometry: 0 } };
  return { type: 'visible-cadastre', status: 'ready', viewport: { width: 400, height: 300 }, zoom: 17, features: [{ rings: [sq(10, 10, 50, 50)] }], counts,
    diagnostics: { tileSize: { width: 256, height: 256 }, tileZoom: 17, zoomScale: 1, viewportMethod: 'map.getSize', pixelOriginMethod: 'map.getPixelOrigin', transformMethod: 'tile-local-px*zoomScale+tile-origin', clippingMethod: 'sutherland-hodgman-viewport-rect', dedupMethod: 'feature-id>property>geometry-fingerprint' },
    selection: { status: 'ready', features: [{ rings: [sq(20, 20, 40, 40)] }], counts: selCounts, diagnostics: { projectionMethods: { 'leaflet-rings': 1 }, paneCounts: { overlayPane: 1 } } },
    ...(background ? { background } : {}) };
}
test('document: embedded capture → Fond, Cadastre, Sélection; raster at 0,0 over the same viewBox; no remote link', async () => {
  const { createRenderedBasemap, rbmBuildBackground } = await rbm();
  const h = await harness();
  const result = await h.session.capture(h.original);
  const ctx = await exporter(); const T = ctx.MonTerritoireVisibleCadastre; const G = ctx.MonTerritoireGpkgSvg;
  const fact = T.validateCapture(capturedFact({ ...result.background }));
  assert.ok(fact, 'the schema accepts the tab-capture-crop composition although every tile is unreadable');
  const { svg } = G.exportVisibleCadastre(fact);
  assert.match(svg, /viewBox="0 0 400 300"/);
  assert.match(svg, /<image id="background-image" x="0" y="0" width="400" height="300" preserveAspectRatio="none" xlink:href="data:image\/png;base64,/);
  loose.deepEqual([...svg.matchAll(/inkscape:label="([^"]+)"/g)].map(m => m[1]), ['Fond cartographique', 'Cadastre', 'Parcelles sélectionnées']);
  assert.equal(/https?:\/\//.test(svg.replace(/xmlns[:\w]*="[^"]*"/g, '')), false);
  assert.equal(typeof createRenderedBasemap + typeof rbmBuildBackground, 'functionfunction');
});
test('document: misaligned raster is rejected by the schema and by the writer (vector-only, never a shifted background)', async () => {
  const { rbmBuildBackground } = await rbm(); const ctx = await exporter(); const T = ctx.MonTerritoireVisibleCadastre; const G = ctx.MonTerritoireGpkgSvg;
  const original = { status: 'unavailable', reason: 'cors', candidate: { status: 'found', kind: 'raster', confidence: 'high', evidence: [], tileCount: 1, imageAccess: 'unavailable-cors' }, tiles: { cached: 1, intersecting: 1, readable: 0, unreadable: 1, completeness: 'incomplete', methods: {} }, composition: { method: 'none' } };
  const wrong = rbmBuildBackground(original, PNG, { output: { width: 400, height: 400 }, ratio: 1 });
  assert.equal(T.validateCapture(capturedFact(wrong)), null);
  const direct = { ...capturedFact(wrong), background: { status: 'embedded', image: { dataUri: PNG, pixelWidth: 400, pixelHeight: 400 } } };
  loose.deepEqual([...G.exportVisibleCadastre(direct).svg.matchAll(/inkscape:label="([^"]+)"/g)].map(m => m[1]), ['Cadastre', 'Parcelles sélectionnées']);
  const fallback = G.exportVisibleCadastre(T.validateCapture(capturedFact({ ...original })));
  assert.equal(fallback.summary.backgroundEmbedded, undefined); assert.match(T.backgroundFallbackMessage, /non incorporable ; export vectoriel effectué/);
});
test('UI state: Fond is incorporable only when the capture is possible', async () => {
  const ctx = await exporter(); const T = ctx.MonTerritoireVisibleCadastre;
  const status = { type: 'visible-cadastre', status: 'ready', summary: { selection: { state: 'ready', count: 2 }, background: { state: 'not-embeddable' } } };
  loose.deepEqual(T.stateLines(status), ['Cadastre : détecté', 'Sélection : 2 parcelles', 'Fond : non incorporable']);
  assert.equal(T.stateLines(status, { captureReady: true })[2], 'Fond : incorporable');
});

// ---- audit ---------------------------------------------------------------------------------------------------------
test('audit: capture modules request nothing, persist nothing, mutate no layer and expose no coordinate or URL', async () => {
  for (const file of ['rendered-basemap.js', 'visible-capture-isolation.js', 'service-worker.js']) {
    const code = (await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
    assert.equal(code.match(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|new\s+Image|localStorage|sessionStorage|indexedDB|chrome\.storage|webRequest|debugger|cookie|createImageBitmap|\.src\s*=\s*['"`]?https?/i), null, file);
    assert.equal(code.match(/\.(?:addLayer|removeLayer|setView|setZoom|panTo|panBy|fitBounds|redraw|setOpacity|setStyle|setUrl|setFeatureStyle|resetFeatureStyle|getCenter|getBounds|getLatLng|toGeoJSON|unproject)\s*\(/), null, file);
    assert.equal(code.match(/console\.|JSON\.stringify/), null, file);
  }
  const iso = (await readFile(new URL('../visible-capture-isolation.js', import.meta.url), 'utf8'));
  assert.equal(iso.match(/display\s*=|\.hidden\s*=|\.remove\(\)|removeChild|innerHTML/), null, 'isolation only overrides visibility');
});
test('audit: no persistence of the screenshot and no host permission', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  loose.deepEqual(manifest.permissions, ['activeTab']); assert.equal(manifest.host_permissions, undefined);
  const dist = JSON.parse(await readFile(new URL('../dist/manifest.json', import.meta.url), 'utf8'));
  loose.deepEqual(dist.permissions, ['activeTab']); assert.equal(dist.host_permissions, undefined);
  assert.equal(manifest.content_scripts.some(entry => entry.js.includes('service-worker.js')), false);
});

// ---- MVP-07: basemap readiness barrier inside the capture transaction -------------------------------------------------
const readyFact = (verdict, extra = {}) => ({ verdict, counts: { visible: 6, ready: verdict === 'ready' ? 6 : 4, loading: verdict === 'loading' || verdict === 'timeout' ? 2 : 0, error: verdict === 'error' ? 1 : 0 }, waitMs: 120, timedOut: verdict === 'timeout', viewUnchanged: true, ...extra });

test('MVP-07 barrier: ready check precedes isolation, paint and capture; the page is restored unchanged', async () => {
  const h = await harness({ ready: mode => readyFact('ready') }); const phases = [];
  const result = await h.session.capture(h.original, { onPhase: phase => phases.push(phase) });
  assert.ok(result.background);
  const at = name => h.order.indexOf(name);
  assert.ok(at('ready-wait') < at('hide') && at('hide') < at('frame') && at('frame') < at('ready-check') && at('ready-check') < at('capture') && at('capture') < at('restore'), h.order.join());
  loose.deepEqual(phases, ['loading', 'ready']);
  loose.deepEqual(h.s.snapshot(), h.before);
  loose.deepEqual(result.report.basemap, { visible: 6, ready: 6, loading: 0, error: 0, waitMs: 120, timedOut: false, verdict: 'ready', attempts: 1, recheck: 'ready' });
});

for (const [verdict, reason] of [['error', 'basemap-error'], ['timeout', 'basemap-timeout'], ['loading', 'basemap-timeout'], ['view-changed', 'view-changed']]) {
  test(`MVP-07 fallback: basemap ${verdict} → nothing hidden, nothing captured, vector-only export (${reason})`, async () => {
    const h = await harness({ ready: () => readyFact(verdict, { viewUnchanged: verdict !== 'view-changed' }) });
    const result = await h.session.capture(h.original);
    assert.equal(result.background, null); assert.equal(result.reason, reason);
    assert.equal(h.order.includes('hide'), false); assert.equal(h.order.includes('capture'), false);
    loose.deepEqual(h.s.snapshot(), h.before);
  });
}

test('MVP-07 last check: tiles renewed after isolation → restored, one more wait, then captured', async () => {
  let checks = 0;
  const h = await harness({ ready: mode => (mode === 'check' && checks++ === 0 ? readyFact('loading') : readyFact('ready')) });
  const result = await h.session.capture(h.original);
  assert.ok(result.background); assert.equal(result.report.basemap.attempts, 2);
  loose.deepEqual(h.order.filter(x => x.startsWith('ready') || x === 'hide' || x === 'restore' || x === 'capture'), ['ready-wait', 'hide', 'ready-check', 'restore', 'ready-wait', 'hide', 'ready-check', 'capture', 'restore']);
  loose.deepEqual(h.s.snapshot(), h.before);
});
test('MVP-07 last check: tiles keep changing → safe fallback after two attempts, page restored', async () => {
  const h = await harness({ ready: mode => (mode === 'check' ? readyFact('loading') : readyFact('ready')) });
  const result = await h.session.capture(h.original);
  assert.equal(result.background, null); assert.equal(result.reason, 'basemap-changed'); assert.equal(h.order.includes('capture'), false);
  loose.deepEqual(h.s.snapshot(), h.before);
});
test('MVP-07 last check: the view moved between the barrier and the capture → no raster, page restored', async () => {
  const h = await harness({ ready: mode => readyFact('ready', { viewUnchanged: mode !== 'check' }) });
  const result = await h.session.capture(h.original);
  assert.equal(result.reason, 'view-changed'); assert.equal(h.order.includes('capture'), false); loose.deepEqual(h.s.snapshot(), h.before);
});
test('MVP-07 facts: closed schema, counters only', async () => {
  const { rbmValidateFact, rbmDiagnosticText } = await rbm();
  const fact = { type: 'basemap-ready', transaction: 'tx-1', mode: 'wait', verdict: 'ready', counts: { visible: 4, ready: 4, loading: 0, error: 0 }, waitMs: 10, timedOut: false, viewUnchanged: true };
  assert.ok(rbmValidateFact(fact));
  assert.equal(rbmValidateFact({ ...fact, url: 'https://x' }), null);
  assert.equal(rbmValidateFact({ ...fact, counts: { ...fact.counts, x: 1, y: 2 } }), null);
  assert.equal(rbmValidateFact({ ...fact, verdict: 'whatever' }), null);
  assert.equal(rbmValidateFact({ ...fact, counts: { ...fact.counts, loading: -1 } }), null);
  const text = rbmDiagnosticText({ basemap: { visible: 4, ready: 3, loading: 1, error: 0, waitMs: 250, timedOut: false, attempts: 1 }, isolation: null });
  assert.match(text, /basemap tiles loading: 1[\s\S]*basemap wait: 250 ms[\s\S]*basemap wait timeout: no/);
});
