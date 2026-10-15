import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { CENTER, SECRET, TILE_X, TILE_Y, createSyntheticL, createSyntheticMap, maskLayer, rasterLayer, rendererTile, vectorGridLayer } from './fixtures/synthetic-leaflet.js';

// Real MAIN-world and isolated-world scripts, wired by one shared document, like the browser does.
class Bus {
  #listeners = new Map();
  addEventListener(type, listener) { this.#listeners.set(type, [...(this.#listeners.get(type) || []), listener]); }
  dispatchEvent(event) { for (const listener of this.#listeners.get(event.type) || []) listener(event); return true; }
}
class FakeEvent { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } }

function sharedDocument() {
  const bus = new Bus(); const attributes = new Map(); const nodes = new Map();
  const shadow = { querySelector(selector) { if (!nodes.has(selector)) { const handlers = {}; nodes.set(selector, { textContent: '', hidden: false, disabled: false, handlers, addEventListener(type, fn) { handlers[type] = fn; } }); } return nodes.get(selector); }, innerHTML: '' };
  const element = { getAttribute: key => attributes.get(key) || null, setAttribute: (key, value) => attributes.set(key, value), append() {}, querySelector: selector => shadow.querySelector(selector) };
  return { document: { documentElement: element, createElement: () => element, addEventListener: bus.addEventListener.bind(bus), dispatchEvent: bus.dispatchEvent.bind(bus), querySelectorAll: () => [], querySelector: () => null }, shadow };
}
function world(document, extra = {}) {
  const sandbox = { document, location: { href: 'https://carto.monterritoire.fr/' }, performance: { getEntriesByType: () => [] }, fetch: () => Promise.resolve({}), URL, CustomEvent: FakeEvent, MutationObserver: class { observe() {} }, getComputedStyle: () => ({ transform: 'none' }), innerWidth: 0, innerHeight: 0, setTimeout, addEventListener() {}, dispatchEvent() {}, Blob, ...extra };
  sandbox.window = sandbox; return vm.createContext(sandbox);
}
async function run(file, context) { vm.runInContext((await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).replace(/^export /gm, ''), context, { filename: file }); }

test('click A then B travels MAIN -> isolated, is validated, compared and reported without touching the map', async () => {
  const { document, shadow } = sharedDocument();
  const L = createSyntheticL(); const layers = [rasterLayer(L), maskLayer(L)]; const map = createSyntheticMap(L, layers);
  const isolated = world(document); const main = world(document, { L, map }); main.document = { ...document, querySelectorAll: () => [map._container] };
  const requests = []; main.fetch = (...args) => { requests.push(args); return Promise.resolve({}); };
  for (const file of ['render-inspector.js', 'mask-control.js', 'visible-map-report.js', 'content-ui.js']) await run(file, isolated);
  for (const file of ['engine-inspector.js', 'visible-map-inspector.js', 'pci-contour-observer.js', 'main-observer.js']) await run(file, main);
  const copied = []; isolated.navigator = { clipboard: { writeText: async text => { copied.push(text); } } };
  const click = id => shadow.querySelector(id).handlers.click();
  const before = Object.keys(map._layers).join();

  click('#vm-capture-a');
  assert.match(shadow.querySelector('#vm-slots').textContent, /A captured/);
  assert.equal(shadow.querySelector('#vm-c-status').textContent, 'not-found');
  const cadastre = vectorGridLayer(L, { tiles: { [`${TILE_X}:${TILE_Y}:17`]: rendererTile(L) } }); map._layers[cadastre._leaflet_id] = cadastre; // the user enables Cadastre
  click('#vm-capture-b');
  assert.match(shadow.querySelector('#vm-slots').textContent, /B captured/);
  assert.equal(shadow.querySelector('#vm-c-status').textContent, 'found');
  assert.equal(shadow.querySelector('#vm-c-engine').textContent, 'VectorGrid');
  assert.match(shadow.querySelector('#vm-c-geometry').textContent, /leaflet-pixel-parts/);
  assert.match(shadow.querySelector('#vm-c-keys').textContent, /idu/);
  click('#vm-compare');
  const comparison = JSON.parse(shadow.querySelector('#vm-comparison').textContent);
  assert.equal(comparison.layersAdded.length, 1); assert.equal(comparison.mostLikelyCadastre.addedByToggle, true);
  await shadow.querySelector('#vm-copy').handlers.click();
  const report = JSON.parse(copied[0]);
  assert.equal(report.conclusion.code, 'RENDERER_GEOMETRY_AVAILABLE');
  for (const forbidden of [SECRET, String(CENTER), String(TILE_X), String(TILE_Y)]) assert.equal(copied[0].includes(forbidden), false, forbidden);

  assert.deepEqual(requests, []);
  assert.deepEqual(map.calls, []);
  assert.deepEqual(Object.keys(map._layers).sort(), [...before.split(','), String(cadastre._leaflet_id)].sort());
});

test('a capture request with a hostile slot is ignored', async () => {
  const { document, shadow } = sharedDocument();
  const L = createSyntheticL(); const map = createSyntheticMap(L, [rasterLayer(L)]);
  const isolated = world(document); const main = world(document, { L, map }); main.document = { ...document, querySelectorAll: () => [map._container] };
  for (const file of ['render-inspector.js', 'mask-control.js', 'visible-map-report.js', 'content-ui.js']) await run(file, isolated);
  for (const file of ['engine-inspector.js', 'visible-map-inspector.js', 'pci-contour-observer.js', 'main-observer.js']) await run(file, main);
  document.dispatchEvent(new FakeEvent('mon-territoire-probe:visible-map-capture-request', { detail: 'C' }));
  document.dispatchEvent(new FakeEvent('mon-territoire-probe:visible-map-capture-request', { detail: { slot: 'A' } }));
  assert.match(shadow.querySelector('#vm-slots').textContent, /A — · B —/);
});

test('manifest keeps activeTab only and loads both MVP-03A files in the right worlds', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab']);
  assert.equal(manifest.host_permissions, undefined);
  const [isolated, main] = manifest.content_scripts;
  assert.equal(main.world, 'MAIN'); assert.equal(isolated.world, undefined);
  assert.ok(main.js.indexOf('visible-map-inspector.js') > main.js.indexOf('engine-inspector.js') && main.js.indexOf('visible-map-inspector.js') < main.js.indexOf('main-observer.js'));
  assert.ok(isolated.js.indexOf('visible-map-report.js') < isolated.js.indexOf('content-ui.js'));
  assert.equal(isolated.js.includes('visible-map-inspector.js'), false, 'the page-state reader must stay in the MAIN world');
  assert.equal(JSON.stringify(manifest).match(/webRequest|debugger|cookies|storage|<all_urls>/), null);
});
