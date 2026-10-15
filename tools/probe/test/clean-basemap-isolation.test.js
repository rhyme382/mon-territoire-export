import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { vciPlan, vciHide, vciRestore, createCaptureIsolation } from '../visible-capture-isolation.js';
import { rbmValidateFact, rbmDiagnosticText } from '../rendered-basemap.js';

// Synthetic DOM: only structure, classes, geometry and computed style exist; the "text" is a secret that must never be read.
const SECRET = 'SECRET-USER-TEXT';
function el(tag, { cls = '', rect = null, position = 'static', role = null, attrs = {}, style = null, parent = null } = {}) {
  const props = new Map(); let attribute = style;
  const node = {
    tagName: tag, parentElement: parent, children: [], rect, position, visibilityComputed: 'inherit',
    get textContent() { throw new Error('text inspected'); }, get innerText() { throw new Error('text inspected'); },
    getAttribute: name => (name === 'class' ? cls : name === 'role' ? role : name === 'style' ? attribute : attrs[name] ?? null),
    hasAttribute: name => (name === 'style' ? attribute !== null : name in attrs),
    removeAttribute(name) { if (name === 'style') { attribute = null; props.clear(); } },
    getBoundingClientRect: () => node.rect || { left: 0, top: 0, width: 0, height: 0 },
    querySelector(selector) { const walk = n => { for (const c of n.children) { if (selector === '.leaflet-container' && / leaflet-container /.test(` ${c.getAttribute('class')} `)) return c; const r = walk(c); if (r) return r; } return null; }; return walk(node); },
    contains(other) { for (let n = other; n; n = n.parentElement) if (n === node) return true; return false; },
    querySelectorAll() { const out = []; const walk = n => { for (const c of n.children) { out.push(c); walk(c); } }; walk(node); return out; },
    style: {
      getPropertyValue: name => props.get(name)?.value ?? '', getPropertyPriority: name => props.get(name)?.priority ?? '',
      setProperty(name, value, priority = '') { props.set(name, { value, priority }); attribute = [...props].map(([n, v]) => `${n}: ${v.value};`).join(' '); },
      removeProperty(name) { props.delete(name); if (attribute !== null) attribute = [...props].map(([n, v]) => `${n}: ${v.value};`).join(' '); },
    },
    snapshot: () => attribute, hidden: () => props.get('visibility')?.value === 'hidden',
  };
  if (parent) parent.children.push(node);
  return node;
}
const R = (left, top, width, height) => ({ left, top, width, height });
const MAP = R(100, 80, 600, 400);

function scene() {
  const html = el('HTML'); const body = el('BODY', { parent: html, rect: R(0, 0, 1000, 700) });
  html.body = body;
  const header = el('HEADER', { parent: body, rect: R(0, 0, 1000, 90), cls: 'app-header' });          // intersects the map (80..90)
  const search = el('DIV', { parent: body, rect: R(120, 85, 300, 40), position: 'absolute', cls: 'search-panel' });
  const account = el('DIV', { parent: body, rect: R(650, 20, 200, 120), position: 'fixed', cls: 'account-menu' });
  const outside = el('DIV', { parent: body, rect: R(0, 600, 1000, 100), cls: 'footer-area' });          // outside the map
  const wrapper = el('DIV', { parent: body, rect: R(100, 80, 600, 400), cls: 'map-wrapper' });
  const map = el('DIV', { parent: wrapper, rect: R(100, 80, 600, 400), cls: 'leaflet-container' });
  const mapPane = el('DIV', { parent: map, cls: 'leaflet-pane leaflet-map-pane' });
  const tilePane = el('DIV', { parent: mapPane, cls: 'leaflet-pane leaflet-tile-pane' });
  const basemap = el('DIV', { parent: tilePane, rect: R(100, 80, 600, 400), cls: 'leaflet-layer', style: 'z-index: 1;' });
  const tile = el('IMG', { parent: basemap, rect: R(100, 80, 256, 256), cls: 'leaflet-tile' });
  const thematic = el('DIV', { parent: tilePane, rect: R(100, 80, 600, 400), cls: 'leaflet-layer' });
  const cadastre = el('DIV', { parent: tilePane, rect: R(100, 80, 600, 400), cls: 'leaflet-layer' });
  const overlayPane = el('DIV', { parent: mapPane, cls: 'leaflet-pane leaflet-overlay-pane' });
  const selection = el('SVG', { parent: overlayPane, rect: R(100, 80, 600, 400), cls: 'leaflet-zoom-animated' });
  const markerPane = el('DIV', { parent: mapPane, cls: 'leaflet-pane leaflet-marker-pane' });
  const marker = el('IMG', { parent: markerPane, rect: R(300, 200, 25, 41), cls: 'leaflet-marker-icon' });
  const tooltipPane = el('DIV', { parent: mapPane, cls: 'leaflet-pane leaflet-tooltip-pane' });
  const popupPane = el('DIV', { parent: mapPane, cls: 'leaflet-pane leaflet-popup-pane' });
  const maskPane = el('DIV', { parent: mapPane, cls: 'leaflet-pane leaflet-mask-pane' });
  const controls = el('DIV', { parent: map, rect: R(100, 80, 600, 400), cls: 'leaflet-control-container' });
  const miniWrap = el('DIV', { parent: map, rect: R(560, 360, 130, 110), position: 'absolute', cls: 'minimap-wrap' });
  const minimap = el('DIV', { parent: miniWrap, rect: R(560, 360, 130, 110), cls: 'leaflet-container' });
  const leaky = el('DIV', { parent: miniWrap, rect: R(560, 360, 20, 20), cls: 'x' }); leaky.visibilityComputed = 'visible';
  const toolbar = el('DIV', { parent: wrapper, rect: R(110, 120, 40, 200), position: 'absolute', cls: 'floating-toolbar' });
  const panel = el('DIV', { parent: html, rect: R(450, 90, 260, 300), attrs: { 'data-mon-territoire-export-ui': '' }, cls: '' });
  const panel2 = el('DIV', { parent: html, rect: R(0, 0, 10, 10), attrs: { 'data-mon-territoire-export-ui': '' } });
  const doc = { documentElement: html, body };
  const win = { getComputedStyle: node => ({ position: node.position, display: 'block', visibility: node.visibilityComputed }) };
  return { html, body, header, search, account, outside, wrapper, map, mapPane, tilePane, basemap, tile, thematic, cadastre, overlayPane, selection, markerPane, marker, tooltipPane, popupPane, maskPane, controls, minimap, miniWrap, toolbar, panel, panel2, doc, win };
}
const plan = (s, extra = {}) => vciPlan({
  document: s.doc, win: s.win, container: s.map, rect: MAP, keep: { basemap: [s.basemap], thematic: [s.thematic] },
  hints: { cadastre: [s.cadastre], selection: [s.selection], mask: [s.maskPane] }, controls: [s.controls], markers: [s.markerPane, s.tooltipPane, s.popupPane],
  extension: [s.panel, s.panel2], ...extra,
});
const hidden = p => { const roots = new Set(p.hide); return { has: n => { for (let x = n; x; x = x.parentElement) if (roots.has(x)) return true; return false; }, [Symbol.iterator]: () => roots[Symbol.iterator]() }; };

test('plan: basemap and reliable thematic raster are kept, everything non-cartographic is HIDE', () => {
  const s = scene(); const p = plan(s); const h = hidden(p);
  assert.equal(p.ok, true);
  for (const name of ['basemap', 'thematic', 'tile']) assert.equal(h.has(s[name]), false, name);
  for (const name of ['cadastre', 'selection', 'maskPane', 'marker', 'markerPane', 'tooltipPane', 'popupPane', 'controls', 'header', 'search', 'account', 'toolbar', 'panel', 'panel2', 'miniWrap']) assert.equal(h.has(s[name]), true, name);
  assert.equal(h.has(s.outside), false, 'outside the map rectangle: untouched');
});
test('plan: structural ancestors, body and html are never hidden; a mixed parent is not hidden, only its HIDE children', () => {
  const s = scene(); const h = hidden(plan(s));
  for (const name of ['html', 'body', 'wrapper', 'map', 'mapPane', 'tilePane']) assert.equal(h.has(s[name]), false, name);
  const hostile = plan(s, { extension: [s.html, s.body, s.wrapper, s.tilePane, s.basemap] });
  for (const name of ['html', 'body', 'wrapper', 'tilePane', 'basemap']) assert.equal(hidden(hostile).has(s[name]), false, name);
});
test('plan: summary counts by role, minimap detected, nothing read from text', () => {
  const s = scene(); const p = plan(s);
  assert.equal(p.summary.basemap, 1); assert.equal(p.summary.thematic, 1);
  assert.equal(p.summary.extension, 2); assert.equal(p.summary.minimaps, 1); assert.equal(p.summary.controls, 1);
  assert.equal(p.summary.markers, 3); assert.equal(p.summary.vector, 3); assert.equal(p.summary.appUi, 4);
  assert.equal(p.summary.unknown, 0); assert.equal(p.confidence, 'high');
});
test('plan: second Leaflet container is a minimap even without any hint', () => {
  const s = scene(); const p = plan(s, { controls: [], markers: [], hints: {}, extension: [] });
  assert.equal(hidden(p).has(s.miniWrap), true); assert.equal(hidden(p).has(s.map), false);
});
test('plan: an unclassified static element over the map is hidden and counted unknown (medium)', () => {
  const s = scene(); const stray = el('DIV', { parent: s.body, rect: R(300, 300, 50, 50) });
  const p = plan(s); assert.equal(hidden(p).has(stray), true); assert.equal(p.summary.unknown, 1); assert.equal(p.confidence, 'medium');
});
test('plan: unknown raster (e.g. WMS) is hidden and counted, never trusted as background', () => {
  const s = scene(); const wms = el('DIV', { parent: s.tilePane, rect: R(100, 80, 600, 400), cls: 'leaflet-layer' });
  const p = plan(s, { unknownRaster: [wms] }); assert.equal(hidden(p).has(wms), true); assert.equal(p.summary.unknown, 1);
});
test('plan: no basemap / ambiguous basemap → abort (vector fallback), never a fake clean background', () => {
  const s = scene();
  assert.deepEqual([plan(s, { keep: { basemap: [], thematic: [s.thematic] } }).ok, plan(s, { keep: { basemap: [], thematic: [] } }).reason], [false, 'no-basemap']);
  assert.equal(plan(s, { basemapStatus: 'ambiguous' }).reason, 'ambiguous-basemap');
  assert.equal(plan(s, { win: { getComputedStyle: () => ({ display: 'none' }) } }).reason, 'basemap-hidden');
});
test('regression: basemap + search + toolbar + minimap + extension panel + vector selection → only basemap stays visible', () => {
  const s = scene(); const p = plan(s); const h = hidden(p);
  const intersecting = [...s.html.querySelectorAll()].filter(n => { const r = n.rect; return r && r.width > 0 && r.left < 700 && r.left + r.width > 100 && r.top < 480 && r.top + r.height > 80; });
  const visible = intersecting.filter(n => !h.has(n));
  const structural = new Set([s.body, s.wrapper, s.map, s.tilePane]);
  const survivors = visible.filter(n => !structural.has(n));
  assert.deepEqual(new Set(survivors), new Set([s.basemap, s.thematic, s.tile]));
});
test('hide/restore: previous value, priority and absent style attribute are restored exactly, also on error', () => {
  const s = scene(); s.search.style.setProperty('visibility', 'visible', 'important'); s.header.style.setProperty('opacity', '1');
  const before = [s.search, s.header, s.toolbar, s.account].map(n => n.snapshot());
  const records = vciHide([s.search, s.header, s.toolbar, s.account]);
  assert.ok([s.search, s.header, s.toolbar, s.account].every(n => n.hidden()));
  assert.equal(vciRestore(records), true);
  assert.deepEqual([s.search, s.header, s.toolbar, s.account].map(n => n.snapshot()), before);
  assert.equal(s.toolbar.hasAttribute('style'), false);
  const broken = { style: { setProperty() { throw new Error('x'); }, getPropertyValue: () => '', getPropertyPriority: () => '' }, hasAttribute: () => false };
  assert.throws(() => vciHide([s.toolbar, broken])); assert.equal(s.toolbar.hasAttribute('style'), false);
});
function isolationGlobal(s, { keep = [s.basemap] } = {}) {
  const targets = { container: s.map, basemap: keep, thematic: [s.thematic], unknownRaster: [], basemapStatus: 'found', signature: () => 's', groups: { cadastre: [s.cadastre], selection: [s.selection], mask: [s.maskPane], controls: [s.controls], overlays: [s.markerPane, s.tooltipPane, s.popupPane] } };
  s.map.clientWidth = 600; s.map.clientHeight = 400; s.map.clientLeft = 0; s.map.clientTop = 0; s.map.offsetWidth = 600; s.map.offsetHeight = 400;
  const global = { MonTerritoireVisibleMapInspector: { captureTargets: () => targets }, document: { ...s.doc, querySelectorAll: () => [s.panel, s.panel2], getElementById: () => null }, getComputedStyle: s.win.getComputedStyle, setTimeout: () => 0, clearTimeout() {} };
  return global;
}
test('isolation: hides the plan, leaked visible descendants too, then restores bit for bit', () => {
  const s = scene(); const names = ['header', 'search', 'account', 'toolbar', 'panel', 'panel2', 'miniWrap', 'minimap', 'leaky', 'basemap', 'tile'];
  s.leaky = s.miniWrap.children[1];
  const before = names.map(name => s[name].snapshot());
  const iso = createCaptureIsolation(isolationGlobal(s));
  const result = iso.isolate('tx-1');
  assert.equal(result.status, 'isolated'); assert.equal(result.confidence, 'high');
  assert.equal(result.counts.basemap, 1); assert.equal(result.counts.minimaps, 1); assert.equal(result.counts.extension, 2);
  for (const name of ['header', 'search', 'account', 'toolbar', 'panel', 'panel2', 'miniWrap', 'leaky']) assert.equal(s[name].hidden(), true, name);
  for (const name of ['basemap', 'tile', 'html', 'body']) assert.equal(s[name].hidden(), false, name);
  assert.equal(iso.restore('tx-1').restored, true);
  assert.deepEqual(names.map(name => s[name].snapshot()), before);
});
test('isolation: no basemap kept → unavailable and nothing was touched', () => {
  const s = scene(); const iso = createCaptureIsolation(isolationGlobal(s, { keep: [] }));
  const result = iso.isolate('tx-1');
  assert.deepEqual([result.status, result.reason], ['unavailable', 'no-basemap']);
  assert.equal([s.header, s.search, s.panel].some(n => n.hidden()), false);
});
test('facts and diagnostics: new closed schema, no URL, coordinate, id, user name or token', () => {
  const counts = { basemap: 1, thematic: 0, vector: 3, controls: 1, appUi: 4, extension: 2, minimaps: 1, markers: 3, unknown: 0 };
  const fact = { type: 'background-isolation', transaction: 'tx-1', status: 'isolated', rect: R(0, 0, 4, 3), transformed: false, confidence: 'high', counts };
  assert.ok(rbmValidateFact(fact));
  assert.equal(rbmValidateFact({ ...fact, counts: { ...counts, rasterLeft: 0 } }), null);
  assert.equal(rbmValidateFact({ ...fact, confidence: 'certain' }), null);
  const text = rbmDiagnosticText({ apiAvailable: true, activeTab: 'armed', captureRequested: true, isolation: counts, confidence: 'high', paintSync: 'double-animation-frame', captureSize: null, mapSize: null, pixelRatio: null, cropSize: null, rasterEmbedded: false, restored: true, watchdog: false, fallbackReason: null });
  for (const line of ['visual isolation mode: positive-basemap', 'basemap surfaces kept: 1', 'thematic raster kept: 0', 'vector overlays hidden: 3', 'controls hidden: 1', 'application UI hidden: 4', 'extension UI hidden: 2', 'minimaps hidden: 1', 'markers/popups/tooltips hidden: 3', 'unknown intersecting elements: 0', 'isolation confidence: high']) assert.ok(text.includes(line), line);
  assert.equal(/https?:|SECRET/.test(text), false);
});
test('audit: isolation never reads text, never removes nodes, never calls application code', async () => {
  const code = (await readFile(new URL('../visible-capture-isolation.js', import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
  assert.equal(code.match(/textContent|innerText|innerHTML|\.remove\(|removeChild|removeLayer|setView|setZoom/), null);
  const ui = await readFile(new URL('../content-ui.js', import.meta.url), 'utf8');
  // MVP-07B: the content script no longer injects any UI; the marker only survives as a defensive filter in the isolation.
  assert.equal(ui.includes('data-mon-territoire-export-ui'), false);
  assert.ok(code.includes('data-mon-territoire-export-ui'));
});
