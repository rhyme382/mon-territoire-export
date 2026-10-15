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


const PNG = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(32);
const sleep = () => new Promise(resolve => setTimeout(resolve, 5));

async function setupCapture({ capture = async () => ({ ok: true, dataUrl: PNG }) } = {}) {
  const { document, shadow } = sharedDocument();
  const L = createSyntheticL();
  const tiles = { '1000:2000:17': geometryTile(L, [{ id: 'a', rings: [sq(60, 60, 120, 120)] }]) };
  const coords = { '1000:2000:17': { x: 1000, y: 2000, z: 17 } };
  const container = { ...createContainer(400, 250), getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 250 }), clientLeft: 0, clientTop: 0, offsetWidth: 400, offsetHeight: 250, querySelectorAll: () => [] };
  const tileImg = (overrides = {}) => ({ tagName: 'IMG', complete: true, naturalWidth: 256, style: {}, currentSrc: 'https://tiles.test/x.png', getBoundingClientRect: () => ({ left: 10, top: 10, width: 256, height: 256 }), ...overrides }); const domTiles = [tileImg()];
  const base = rasterLayer(L); base._container = { tagName: 'DIV', parentElement: null, querySelectorAll: () => domTiles, addEventListener() {}, removeEventListener() {} }; for (const tile of Object.values(base._tiles)) tile.el = { tagName: 'IMG', complete: true, naturalWidth: 256, naturalHeight: 256 };
  const map = createSyntheticMap(L, [base, maskLayer(L), vectorGridLayer(L, { tiles, coords })], { container, pixelOrigin: { x: 256 * 1000 - 40, y: 256 * 2000 - 30 } });
  const listeners = []; const messages = []; const ticks = [];
  const harness = popupHarness(); const chrome = { runtime: { ...harness.runtime, sendMessage: async message => { messages.push(message); return capture(); }, onMessage: { addListener: fn => listeners.push(fn) } } };
  const isolated = world(document, { chrome, innerWidth: 400, innerHeight: 250, setInterval: fn => ticks.push(fn), setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: callback => queueMicrotask(callback) });
  const main = world(document, { L, map }); main.document = { ...document, querySelectorAll: () => [container], getElementById: () => null };
  const requests = []; main.fetch = (...args) => { requests.push(args); return Promise.resolve({}); };
  const downloads = []; isolated.URL = { createObjectURL: blob => { downloads.push(blob); return 'blob:x'; }, revokeObjectURL() {} };
  isolated.Blob = class { constructor(parts, options) { this.parts = parts; this.options = options; } };
  await gpkgBundle(isolated);
  for (const file of ['render-inspector.js', 'mask-control.js', 'visible-map-report.js', 'visible-cadastre-export.js', 'rendered-basemap.js', 'content-ui.js']) await run(file, isolated);
  for (const file of ['engine-inspector.js', 'visible-cadastre-geometry.js', 'visible-background.js', 'visible-map-inspector.js', 'visible-capture-isolation.js', 'pci-contour-observer.js', 'main-observer.js']) await run(file, main);
  document.createElement = tag => (tag === 'img' ? { set src(value) { this._src = value; queueMicrotask(() => this.onload()); }, naturalWidth: 400, naturalHeight: 250 } : tag === 'canvas' ? { width: 0, height: 0, getContext: () => ({ drawImage() {} }), toDataURL: () => PNG } : { click() {}, set href(v) {}, get href() { return ''; } });
  for (const tick of ticks) tick();
  const popup = harness.open();
  return { popup, harness, shadow, map, requests, downloads, messages, listeners, container, domTiles, tileImg };
}
const labels = svg => [...svg.matchAll(/inkscape:label="([^"]+)"/g)].map(m => m[1]);

test('MVP-07B popup export: unreadable tiles → rendered capture embedded as the bottom layer, nothing requested, map untouched', async () => {
  const { popup, map, requests, downloads, messages, shadow } = await setupCapture();
  popup.exportVisible();
  assert.deepEqual(popup.statuses().map(status => status.text), ['Export…', 'Préparation du fond…']);
  await sleep();
  assert.equal(JSON.stringify(messages), '[{"type":"mte:capture-visible-tab"}]');
  assert.equal(downloads.length, 1);
  const svg = downloads[0].parts[0];
  assert.deepEqual(labels(svg), ['Fond cartographique', 'Cadastre']);
  assert.match(svg, /<image id="background-image" x="0" y="0" width="400" height="250"/);
  assert.match(svg, /viewBox="0 0 400 250"/);
  assert.equal(popup.lastStatus().phase, 'done'); assert.equal(popup.lastStatus().text, 'Terminé.');
  assert.match(shadow.querySelector('#vb-diagnostic').textContent, /CAPTURE DU FOND[\s\S]*raster embedded: yes[\s\S]*restoration: success[\s\S]*fallback reason: none/);
  assert.equal(requests.length, 0);
  assert.equal(map.calls.length, 0); // no layer, view or selection function was called
});

test('MVP-07B popup export without the activeTab grant: capture refused → vector export is intact, plain message', async () => {
  const { popup, shadow, downloads } = await setupCapture({ capture: async () => ({ ok: false, reason: 'permission' }) });
  popup.exportVisible();
  await sleep();
  assert.equal(downloads.length, 1);
  assert.deepEqual(labels(downloads[0].parts[0]), ['Cadastre']);
  const message = popup.lastStatus();
  assert.equal(message.phase, 'done');
  assert.match(message.text, /Fond cartographique non incorporable ; export vectoriel effectué\./);
  assert.doesNotMatch(message.text, /CORS|permission|captureVisibleTab|activeTab/i);
  assert.match(shadow.querySelector('#vb-diagnostic').textContent, /fallback reason: permission/);
});

test('MVP-07B popup command: only the extension itself may connect; the export runs once and survives the popup closing', async () => {
  const { harness, downloads, messages, popup } = await setupCapture();
  const foreign = harness.open({ sender: { id: 'someone-else' } });
  foreign.exportVisible(); await sleep();
  assert.equal(downloads.length, 0, 'a foreign sender is ignored');
  const wrongName = harness.open({ name: 'other' }); wrongName.exportVisible(); await sleep();
  assert.equal(downloads.length, 0, 'an unknown port name is ignored');
  popup.exportVisible(); popup.close(); await sleep(); // the popup closes right after the command
  assert.equal(downloads.length, 1); assert.equal(messages.length, 1);
  assert.deepEqual(labels(downloads[0].parts[0]), ['Fond cartographique', 'Cadastre']);
  assert.equal(popup.lastStatus().text, 'Préparation du fond…', 'a closed popup receives nothing more');
});

test('MVP-07B popup export asks for a status answer only: no toolbar message listener is needed', async () => {
  const { listeners } = await setupCapture();
  for (const listener of listeners) assert.equal(listener({ type: 'mte:export-request' }, { id: 'ext' }), undefined);
});

test('MVP-06 privacy: no coordinate, tile index, URL, token or identifier in the SVG, the diagnostics or the popup messages', async () => {
  const { popup, shadow, downloads } = await setupCapture();
  popup.exportVisible(); await sleep();
  const text = [downloads[0].parts[0].replace(/exportDatetime="[^"]*"/, '').replace(/xmlns[:\w]*="[^"]*"/g, ''), shadow.querySelector('#vb-diagnostic').textContent, shadow.querySelector('#vc-diagnostic').textContent, JSON.stringify(popup.posted)].join('\n');
  for (const forbidden of [SECRET, String(CENTER), '1000', '2000', 'idu', 'insee', 'EPSG', 'https://', 'token']) assert.equal(text.includes(forbidden), false, forbidden);
});
