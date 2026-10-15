import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { bundleModules } from '../bundle-modules.mjs';
import { popupHarness } from './fixtures/popup-port.js';
import { CENTER, SECRET, createContainer, createSyntheticL, createSyntheticMap, geometryTile, maskLayer, rasterLayer, vectorGridLayer } from './fixtures/synthetic-leaflet.js';

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
async function gpkgBundle(context) { vm.runInContext(await bundleModules(new URL('../../gpkg-svg/browser/api.js', import.meta.url), 'MonTerritoireGpkgSvg'), context, { filename: 'gpkg-svg.js' }); }

async function setup({ cadastre = true } = {}) {
  const { document, shadow } = sharedDocument();
  const L = createSyntheticL();
  const tiles = { '1000:2000:17': geometryTile(L, [{ id: 'a', rings: [sq(60, 60, 120, 120)] }, { id: 'x', rings: [sq(200, 20, 256, 60)] }]), '1001:2000:17': geometryTile(L, [{ id: 'x', rings: [sq(0, 20, 30, 60)] }]) };
  const coords = { '1000:2000:17': { x: 1000, y: 2000, z: 17 }, '1001:2000:17': { x: 1001, y: 2000, z: 17 } };
  const layers = [rasterLayer(L), maskLayer(L)]; if (cadastre) layers.push(vectorGridLayer(L, { tiles, coords }));
  const map = createSyntheticMap(L, layers, { container: createContainer(400, 250), pixelOrigin: { x: 256 * 1000 - 40, y: 256 * 2000 - 30 } });
  const ticks = []; const harness = popupHarness(); const isolated = world(document, { chrome: { runtime: harness.runtime }, setInterval: fn => ticks.push(fn), setTimeout: () => 0 }); const main = world(document, { L, map }); main.document = { ...document, querySelectorAll: () => [map._container] };
  const requests = []; main.fetch = (...args) => { requests.push(args); return Promise.resolve({}); };
  const downloads = []; isolated.URL = { createObjectURL: blob => { downloads.push(blob); return 'blob:x'; }, revokeObjectURL() {} };
  isolated.Blob = class { constructor(parts, options) { this.parts = parts; this.options = options; } };
  await gpkgBundle(isolated);
  for (const file of ['render-inspector.js', 'mask-control.js', 'visible-map-report.js', 'visible-cadastre-export.js', 'content-ui.js']) await run(file, isolated);
  for (const file of ['engine-inspector.js', 'visible-cadastre-geometry.js', 'visible-map-inspector.js', 'pci-contour-observer.js', 'main-observer.js']) await run(file, main);
  const anchors = []; document.createElement = () => { const a = { click() { anchors.push({ href: a.href, name: a.download }); }, set href(v) { this._href = v; }, get href() { return this._href; } }; return a; };
  for (const tick of ticks) tick(); // the page script is now loaded: the next availability poll sees it
  const popup = harness.open();
  return { popup, document, shadow, map, requests, downloads, anchors, isolated, main };
}

test('button is disabled until the cadastre is active, then exports a viewport SVG without touching the map or the network', async () => {
  const { popup, map, requests, downloads, anchors, shadow } = await setup();
  popup.exportVisible();
  assert.equal(anchors.length, 1);
  assert.match(anchors[0].name, /^mon-territoire-cadastre-visible-\d{8}\.svg$/);
  const svg = downloads[0].parts[0]; const withoutDate = svg.replace(/exportDatetime="[^"]*"/, '').replace(/xmlns[:\w]*="[^"]*"/g, ''); // timestamp digits and XML namespaces are not data
  assert.match(svg, /width="400" height="250" viewBox="0 0 400 250"/);
  assert.match(svg, /inkscape:label="Cadastre"/);
  assert.deepEqual([...svg.matchAll(/<path id="([^"]+)"/g)].map(m => m[1]), ['cadastre-visible-1', 'cadastre-visible-2']);
  for (const forbidden of [SECRET, String(CENTER), '1000', '2000', 'idu', 'insee', 'EPSG', 'lat']) assert.equal(withoutDate.includes(forbidden), false, forbidden);
  const diagnostic = shadow.querySelector('#vc-diagnostic').textContent;
  assert.match(diagnostic, /Viewport :\n {2}400 × 250/); assert.match(diagnostic, /unique features: 2/); assert.match(diagnostic, /duplicates\/fragments handled: 1/);
  for (const forbidden of [SECRET, '1000:', String(CENTER)]) assert.equal(diagnostic.includes(forbidden), false, forbidden);
  assert.deepEqual(popup.statuses().map(status => status.phase), ['exporting', 'done']);
  assert.match(popup.lastStatus().text, /^Terminé\./);
  assert.deepEqual(requests, []); assert.deepEqual(map.calls, []);
});

test('without the Cadastre layer the popup command ends with a simple message and no download', async () => {
  const { popup, anchors } = await setup({ cadastre: false });
  popup.exportVisible();
  assert.equal(JSON.stringify(popup.lastStatus()), JSON.stringify({ type: 'mte:status', phase: 'error', text: 'Activez la couche Cadastre.' }));
  assert.equal(anchors.length, 0);
});

test('an unsolicited or forged geometry fact never triggers a download', async () => {
  const { document, anchors } = await setup();
  document.dispatchEvent(new FakeEvent('mon-territoire-probe:fact', { detail: { type: 'visible-cadastre', status: 'ready', viewport: { width: 10, height: 10 }, zoom: 17, features: [{ rings: [[[0, 0], [5, 0], [5, 5]]] }], counts: {}, diagnostics: {} } }));
  assert.equal(anchors.length, 0);
});

test('hostile slot/mode in a request is ignored', async () => {
  const { document, anchors } = await setup();
  document.dispatchEvent(new FakeEvent('mon-territoire-probe:visible-cadastre-request', { detail: { mode: 'export' } }));
  document.dispatchEvent(new FakeEvent('mon-territoire-probe:visible-cadastre-request', { detail: 'other' }));
  assert.equal(anchors.length, 0);
});

test('existing products keep working through the popup port: mask toggle answers, no product control is created in the page', async () => {
  const { popup, shadow } = await setup();
  popup.send({ type: 'mte:mask-state' });
  assert.equal(popup.lastMask().state, 'absent');
  popup.toggleMask();
  assert.equal(popup.lastMask().message, 'Masque non détecté');
  for (const id of ['#toggle-mask', '#export-svg', '#gpkg-file', '#export-visible']) assert.equal(shadow.querySelector(id).handlers.click || shadow.querySelector(id).handlers.change, undefined, `${id} has no page handler`);
});

test('manifest keeps activeTab only and wires the new files in the right worlds', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab']); assert.equal(manifest.host_permissions, undefined);
  const [isolated, main] = manifest.content_scripts;
  assert.ok(main.js.indexOf('visible-cadastre-geometry.js') < main.js.indexOf('visible-map-inspector.js'));
  assert.ok(isolated.js.indexOf('gpkg-svg.js') < isolated.js.indexOf('visible-cadastre-export.js') && isolated.js.indexOf('visible-cadastre-export.js') < isolated.js.indexOf('content-ui.js'));
  assert.equal(isolated.js.includes('visible-cadastre-geometry.js'), false, 'page-state reading stays in MAIN');
});
