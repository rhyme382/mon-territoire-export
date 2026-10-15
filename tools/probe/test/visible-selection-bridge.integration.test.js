import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { bundleModules } from '../bundle-modules.mjs';
import { popupHarness } from './fixtures/popup-port.js';
import { SECRET, attach, createContainer, createSyntheticL, createSyntheticMap, geometryTile, groupLayer, maskLayer, polygonLayer, rasterLayer, selectionProject, vectorGridLayer, wmsLayer } from './fixtures/synthetic-leaflet.js';

class Bus {
  #listeners = new Map();
  addEventListener(type, listener) { this.#listeners.set(type, [...(this.#listeners.get(type) || []), listener]); }
  dispatchEvent(event) { for (const listener of this.#listeners.get(event.type) || []) listener(event); return true; }
}
class FakeEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function sharedDocument() {
  const bus = new Bus(); const attributes = new Map(); const nodes = new Map();
  const shadow = { querySelector(selector) { if (!nodes.has(selector)) { const handlers = {}; nodes.set(selector, { textContent: '', hidden: false, disabled: false, className: '', handlers, addEventListener(type, fn) { handlers[type] = fn; } }); } return nodes.get(selector); }, innerHTML: '' };
  const element = { getAttribute: key => attributes.get(key) || null, setAttribute: (key, value) => attributes.set(key, value), append() {}, querySelector: selector => shadow.querySelector(selector) };
  return { document: { documentElement: element, createElement: () => element, addEventListener: bus.addEventListener.bind(bus), dispatchEvent: bus.dispatchEvent.bind(bus), querySelectorAll: () => [], querySelector: () => null, hidden: false }, shadow };
}
function world(document, extra = {}) {
  const sandbox = { document, location: { href: 'https://carto.monterritoire.fr/' }, performance: { getEntriesByType: () => [] }, fetch: () => Promise.resolve({}), URL, CustomEvent: FakeEvent, MutationObserver: class { observe() {} }, getComputedStyle: () => ({ transform: 'none' }), innerWidth: 0, innerHeight: 0, setTimeout, addEventListener() {}, dispatchEvent() {}, Blob, console, ...extra };
  sandbox.window = sandbox; return vm.createContext(sandbox);
}
async function run(file, context) { vm.runInContext((await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).replace(/^export /gm, ''), context, { filename: file }); }

async function setup() {
  const { document, shadow } = sharedDocument();
  const L = createSyntheticL();
  const tiles = { '1000:2000:17': geometryTile(L, [{ id: 'a', rings: [sq(60, 60, 120, 120)] }, { id: 'b', rings: [sq(140, 60, 200, 120)] }]) };
  const wms = wmsLayer(L, 291); const overlay = groupLayer(L, { id: 293 });
  const layers = [rasterLayer(L), wms, maskLayer(L), vectorGridLayer(L, { id: 292, tiles, coords: { '1000:2000:17': { x: 1000, y: 2000, z: 17 } } }), overlay];
  const map = createSyntheticMap(L, layers, { container: createContainer(400, 250), pixelOrigin: { x: 256 * 1000 - 40, y: 256 * 2000 - 30 }, project: selectionProject });
  const ticks = []; const harness = popupHarness(); const isolated = world(document, { chrome: { runtime: harness.runtime }, setInterval: fn => ticks.push(fn), setTimeout: () => 0 }); const main = world(document, { L, map }); main.document = { ...document, querySelectorAll: () => [map._container] };
  const requests = []; main.fetch = (...args) => { requests.push(args); return Promise.resolve({}); };
  const downloads = []; isolated.URL = { createObjectURL: blob => { downloads.push(blob); return 'blob:x'; }, revokeObjectURL() {} };
  isolated.Blob = class { constructor(parts, options) { this.parts = parts; this.options = options; } };
  vm.runInContext(await bundleModules(new URL('../../gpkg-svg/browser/api.js', import.meta.url), 'MonTerritoireGpkgSvg'), isolated, { filename: 'gpkg-svg.js' });
  for (const file of ['render-inspector.js', 'mask-control.js', 'visible-map-report.js', 'visible-selection-report.js', 'visible-cadastre-export.js', 'content-ui.js']) await run(file, isolated);
  for (const file of ['engine-inspector.js', 'visible-cadastre-geometry.js', 'visible-map-inspector.js', 'pci-contour-observer.js', 'main-observer.js']) await run(file, main);
  const anchors = []; document.createElement = () => { const a = { click() { anchors.push({ href: a.href, name: a.download }); }, set href(v) { this._href = v; }, get href() { return this._href; } }; return a; };
  for (const tick of ticks) tick();
  const popup = harness.open();
  const click = id => (id === '#export-visible' ? popup.exportVisible() : shadow.querySelector(id).handlers.click());
  return { popup, L, map, wms, overlay, document, shadow, requests, downloads, anchors, click };
}
const select = (w, ids) => { const children = ids.map((id, index) => polygonLayer(w.L, { id, rings: [sq(40 + index * 60, 30, 90 + index * 60, 80)], idu: `${SECRET}-${id}` })); Object.assign(w.overlay._layers, Object.fromEntries(children.map(child => [child._leaflet_id, child]))); attach(w.map, ...children); };
const text = (w, id) => w.shadow.querySelector(id).textContent;

test('J. one popup command; it exports the Cadastre layer alone when nothing is selected', async () => {
  const w = await setup();
  assert.equal(w.shadow.innerHTML, '', 'nothing is written into a page-side product container');
  w.click('#export-visible');
  const svg = w.downloads[0].parts[0];
  assert.deepEqual([...svg.matchAll(/inkscape:label="([^"]+)"/g)].map(m => m[1]), ['Cadastre']);
  assert.match(text(w, '#vc-diagnostic'), /Parcelles sélectionnées :\n {2}aucune sélection vectorielle/);
});

test('B-D. the internal A/B flow classifies a group selection, and the next export carries both layers', async () => {
  const w = await setup();
  for (const id of ['#vs-capture-a', '#vs-capture-b', '#vs-compare', '#vs-copy']) assert.equal(typeof w.shadow.querySelector(id).handlers.click, 'function', id);
  // MVP-07: the A/B engine stays reachable internally but is not part of the product UI.
  w.click('#vs-capture-a'); select(w, [600, 601, 602]); w.click('#vs-capture-b');
  assert.equal(text(w, '#vs-slots'), 'A capturée · B capturée');
  w.click('#vs-compare');
  assert.equal(text(w, '#vs-conclusion'), 'LEAFLET_GROUP_SELECTION');
  const comparison = JSON.parse(text(w, '#vs-comparison')); assert.equal(comparison.likelySelectionLayer.leafletId, 293); assert.equal(comparison.groupsChanged[0].pathDelta, 3);
  for (const forbidden of [SECRET, 'idu', 'insee']) assert.equal(text(w, '#vs-comparison').includes(forbidden), false);

  w.click('#export-visible');
  const svg = w.downloads[0].parts[0];
  assert.deepEqual([...svg.matchAll(/inkscape:label="([^"]+)"/g)].map(m => m[1]), ['Cadastre', 'Parcelles sélectionnées']);
  assert.deepEqual([...svg.matchAll(/<path id="([^"]+)"/g)].map(m => m[1]), ['cadastre-visible-1', 'cadastre-visible-2', 'selection-1', 'selection-2', 'selection-3']);
  const diagnostic = text(w, '#vc-diagnostic');
  assert.match(diagnostic, /selected features detected: 3\n {2}selected features visible: 3\n {2}selected paths exported: 3\n {2}selected features clipped: 0/);
  for (const forbidden of [SECRET, 'idu', '600']) { assert.equal(diagnostic.includes(forbidden), false, forbidden); assert.equal(svg.replace(/xmlns[:\w]*="[^"]*"/g, '').includes(forbidden), false, forbidden); }
  assert.match(w.popup.lastStatus().text, /^Terminé\./);
});

test('WMS-only selection: the Cadastre still exports and Diagnostic says the selection is not exportable yet', async () => {
  const w = await setup();
  w.click('#vs-capture-a'); w.wms.wmsParams = { layers: 'zones', cql_filter: `idu='${SECRET}'` }; w.click('#vs-capture-b'); w.click('#vs-compare');
  assert.equal(text(w, '#vs-conclusion'), 'WMS_SELECTION');
  assert.equal(text(w, '#vs-comparison').includes(SECRET), false);
  w.click('#export-visible');
  assert.equal(w.downloads.length, 1); assert.deepEqual([...w.downloads[0].parts[0].matchAll(/inkscape:label="([^"]+)"/g)].map(m => m[1]), ['Cadastre']);
  assert.match(text(w, '#vc-diagnostic'), /sélection détectée \(WMS_SELECTION\) : pas encore exportable/);
});

test('29-32. no network, no map mutation, mask toggle wired through the popup', async () => {
  const w = await setup();
  w.click('#vs-capture-a'); select(w, [620]); w.click('#vs-capture-b'); w.click('#vs-compare'); w.click('#export-visible');
  assert.deepEqual(w.requests, []); assert.deepEqual(w.map.calls, []);
  w.popup.toggleMask(); assert.equal(w.popup.lastMask().message, 'Masque non détecté'); // the mask command is answered over the popup port
  assert.equal(w.shadow.querySelector('#gpkg-file').handlers.change, undefined, 'the GeoPackage input lives in the popup, not the page');
});

test('a forged selection capture fact never reaches the session', async () => {
  const w = await setup();
  const forged = { schemaVersion: 1, inspection: 'visible-selection', 'no-additional-network-requests': true, slot: 'A', map: { status: 'found', layerCount: 1 }, layers: [{ leafletId: 1, kind: 'unknown', role: 'other', idu: SECRET }], layersTruncated: false, paths: {}, renderers: {}, dom: {} };
  for (const detail of [{ type: 'visible-selection-capture', capture: forged }, { type: 'visible-selection-capture', capture: { ...forged, layers: [] } }, { type: 'visible-selection-capture' }]) w.document.dispatchEvent(new FakeEvent('mon-territoire-probe:fact', { detail }));
  assert.equal(text(w, '#vs-slots'), 'A — · B —');
  w.document.dispatchEvent(new FakeEvent('mon-territoire-probe:visible-selection-capture-request', { detail: 'C' }));
  w.click('#vs-capture-a'); assert.equal(text(w, '#vs-slots'), 'A capturée · B —');
});

test('manifest: activeTab only, the selection report runs in the isolated world and the page reader stays in MAIN', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab']); assert.equal(manifest.host_permissions, undefined);
  const [isolated, main] = manifest.content_scripts;
  assert.ok(isolated.js.indexOf('visible-selection-report.js') > 0 && isolated.js.indexOf('visible-selection-report.js') < isolated.js.indexOf('content-ui.js'));
  assert.equal(main.js.includes('visible-selection-report.js'), false);
});
