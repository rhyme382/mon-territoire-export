import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyScript, compareSnapshots, createEngineInspector, sanitizeEngineUrl
} from '../engine-inspector.js';
import { validatePageFact } from '../content-ui.js';

test('detects a Leaflet VectorGrid runtime without serializing business data', () => {
  const inspector = createEngineInspector({
    L: { version: '1.9.4', Map: function Map() {}, TileLayer: function TileLayer() {}, GridLayer: function GridLayer() {}, Canvas: function Canvas() {}, SVG: function SVG() {}, VectorGrid: { Protobuf: function Protobuf() {} } }
  });
  const runtime = inspector.runtime();
  assert.equal(runtime.libraries.find(item => item.libraryName === 'Leaflet').version, '1.9.4');
  assert.equal(runtime.libraries.find(item => item.libraryName === 'Leaflet').classes.includes('VectorGrid.Protobuf'), true);
  assert.equal(JSON.stringify(runtime).match(/parcel|idu|insee|feature/i), null);
});

test('chooses the largest reachable Leaflet map and aggregates layers by constructor', () => {
  const primary = { _leaflet_id: 10, _container: { clientWidth: 1000, clientHeight: 700 }, _layers: { a: { constructor: { name: 'TileLayer' }, _url: 'https://tiles.test/a/{z}/{x}/{y}.png?token=hidden', options: { pane: 'tilePane' } }, b: { constructor: { name: 'Protobuf' }, _url: 'https://tiles.test/cadastre/17/66000/44000.pbf?token=hidden', options: { pane: 'overlayPane' } } } };
  const secondary = { _leaflet_id: 11, _container: { clientWidth: 100, clientHeight: 70 }, _layers: {} };
  const L = { Map: function Map() {}, _instances: { 10: primary, 11: secondary } };
  const inspector = createEngineInspector({ L, document: { querySelectorAll: () => [primary._container, secondary._container] } });
  const snapshot = inspector.capture();
  assert.equal(snapshot.primaryMap.index, 0);
  assert.equal(snapshot.primaryMap.reason, 'largest-container');
  assert.deepEqual(snapshot.layerAggregates.map(item => [item.constructorName, item.count]), [['Protobuf', 1], ['TileLayer', 1]]);
  const vector = snapshot.layerAggregates.find(item => item.constructorName === 'Protobuf');
  assert.equal(vector.hasVectorGridSemantics, true);
  assert.equal(vector.sanitizedUrlPattern.pathname, '/cadastre/{z}/{x}/{y}.pbf');
  assert.equal(JSON.stringify(snapshot).includes('66000'), false);
  assert.equal(JSON.stringify(snapshot).includes('hidden'), false);
  assert.ok(validatePageFact({ type: 'engine-snapshot', snapshot }), 'the isolated-world bridge accepts the canonical sanitized snapshot');
});

test('transparent Worker and SharedWorker wrappers call originals once with identical arguments and observe no messages', () => {
  const calls = []; const sharedCalls = [];
  function OriginalWorker(...args) { calls.push(args); this.args = args; }
  function OriginalSharedWorker(...args) { sharedCalls.push(args); this.args = args; }
  const global = { Worker: OriginalWorker, SharedWorker: OriginalSharedWorker, location: { href: 'https://carto.test/' } };
  const inspector = createEngineInspector(global); inspector.installWorkerObservation();
  const options = { type: 'module', name: 'ordinary-map-worker' };
  const worker = new global.Worker('https://cdn.test/assets/worker.js?token=secret', options);
  const shared = new global.SharedWorker('https://cdn.test/assets/shared.js#fragment', { name: 'tile-worker' });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], ['https://cdn.test/assets/worker.js?token=secret', options]); assert.equal(worker.args[1], options);
  assert.equal(sharedCalls.length, 1); assert.equal(inspector.capture().workers.length, 2);
  const text = JSON.stringify(inspector.capture());
  assert.equal(text.includes('secret'), false); assert.equal(text.includes('fragment'), false); assert.equal(text.includes('postMessage'), false);
});

test('reads only service worker controller metadata and inventories same-origin iframes', () => {
  let registrations = 0;
  const same = { clientWidth: 300, clientHeight: 200, src: '/embed?token=hidden', contentDocument: { querySelector: () => ({}) } };
  const cross = { clientWidth: 10, clientHeight: 10, src: 'https://other.test/x?token=hidden', get contentDocument() { throw Error('SOP'); } };
  const inspector = createEngineInspector({ location: { href: 'https://carto.test/page' }, navigator: { serviceWorker: { controller: { scriptURL: 'https://carto.test/sw.js?token=hidden' }, getRegistrations() { registrations++; } } }, document: { querySelectorAll: selector => selector === 'iframe' ? [same, cross] : [] } });
  const snapshot = inspector.capture();
  assert.equal(registrations, 0); assert.equal(snapshot.serviceWorker.controllerPresent, true);
  assert.deepEqual(snapshot.iframes, { count: 2, sameOriginCount: 1, crossOriginCount: 1, frames: [{ hostname: 'carto.test', pathname: '/embed', width: 300, height: 200, containsLeafletContainer: true }, { hostname: 'other.test', pathname: '/x', width: 10, height: 10, containsLeafletContainer: false }] });
});

test('classifies already loaded script signatures without fetching', () => {
  assert.equal(classifyScript('/vendor/leaflet.js'), 'leaflet');
  assert.equal(classifyScript('/vectorgrid-protobuf.js'), 'vectorgrid');
  assert.equal(classifyScript('/maplibre-gl.js'), 'maplibre');
  assert.equal(classifyScript('/pbf.min.js'), 'protobuf-pbf');
  assert.deepEqual(sanitizeEngineUrl('https://cdn.test/a/17/66000/44000.js?token=x#y'), { hostname: 'cdn.test', pathname: '/a/{z}/{x}/{y}.js' });
});

test('snapshot comparison identifies a new VectorGrid and honestly reports no structural delta', () => {
  const A = { layerAggregates: [{ constructorName: 'TileLayer', count: 1 }], workers: [], iframes: { count: 0 }, scriptSignatures: [], diagnostics: { canvasCount: 0, svgCount: 0, containerCount: 1 } };
  const B = { ...A, layerAggregates: [...A.layerAggregates, { constructorName: 'VectorGrid.Protobuf', count: 1, hasVectorGridSemantics: true }] };
  assert.deepEqual(compareSnapshots(A, B).newLayerTypes, [{ constructorName: 'VectorGrid.Protobuf', count: 1 }]);
  assert.equal(compareSnapshots(A, A).summary, 'no structural delta');
});
