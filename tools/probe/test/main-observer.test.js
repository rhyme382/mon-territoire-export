import test from 'node:test';
import assert from 'node:assert/strict';
import { createFactBridge, createObservedFetch, installPerformance, installXhr, leafletImages } from '../main-observer.js';

test('buffers the first resource fact until the isolated listener is ready', () => {
  const events = [];
  const bridge = createFactBridge(detail => events.push(detail));
  bridge.resource({ hostname: 'tiles.test', pathname: '/16/1/2.pbf', initiatorType: 'img' });
  assert.equal(events.length, 0);
  bridge.ready();
  assert.deepEqual(events[0], { type: 'resource', hostname: 'tiles.test', pathname: '/16/1/2.pbf', initiatorType: 'img' });
  assert.equal(events.at(-1).type, 'diagnostic');
});

test('PerformanceResourceTiming is sanitized with initiator and all timing sizes', () => {
  const seen = [];
  const oldPerformance = globalThis.performance;
  const oldObserver = globalThis.PerformanceObserver;
  globalThis.performance = { getEntriesByType: () => [{ name: 'https://tiles.test/16/1/2.pbf?token=secret#x', initiatorType: 'img', transferSize: 111, encodedBodySize: 99, decodedBodySize: 222 }] };
  globalThis.PerformanceObserver = class { constructor(callback) { this.callback = callback; } observe() {} };
  const diagnostics = { performanceInitialScanCompleted: false, performanceObserverAvailable: false, performanceObserverStarted: false, performanceResourcesSeen: 0, initiatorTypes: {} };
  installPerformance(fact => seen.push(fact), diagnostics);
  assert.deepEqual(seen[0], { type: 'resource', hostname: 'tiles.test', pathname: '/16/1/2.pbf', zxy: { z: 16, x: 1, y: 2 }, initiatorType: 'img', transferSize: 111, encodedBodySize: 99, decodedBodySize: 222 });
  assert.deepEqual(diagnostics.initiatorTypes, { img: 1 });
  assert.equal(diagnostics.performanceInitialScanCompleted, true);
  assert.equal(diagnostics.performanceObserverAvailable, true);
  assert.equal(diagnostics.performanceObserverStarted, true);
  assert.equal(JSON.stringify(seen).includes('secret'), false);
  globalThis.performance = oldPerformance;
  globalThis.PerformanceObserver = oldObserver;
});

test('initial Resource Timing scan succeeds when PerformanceObserver is unavailable', () => {
  const seen = [];
  const oldPerformance = globalThis.performance;
  const oldObserver = globalThis.PerformanceObserver;
  globalThis.performance = { getEntriesByType: () => [{ name: 'https://tiles.test/16/1/2.png', initiatorType: 'img' }] };
  globalThis.PerformanceObserver = undefined;
  const diagnostics = { performanceInitialScanCompleted: false, performanceObserverAvailable: false, performanceObserverStarted: false, performanceResourcesSeen: 0, initiatorTypes: {} };
  installPerformance(fact => seen.push(fact), diagnostics);
  assert.equal(seen.length, 1);
  assert.equal(diagnostics.performanceInitialScanCompleted, true);
  assert.equal(diagnostics.performanceObserverAvailable, false);
  assert.equal(diagnostics.performanceObserverStarted, false);
  globalThis.performance = oldPerformance;
  globalThis.PerformanceObserver = oldObserver;
});

test('fetch wrapper delegates the original request once and emits a sanitized fact', async () => {
  const calls = [];
  const original = async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'application/x-protobuf' } });
  const wrapped = createObservedFetch(original, fact => calls.push(fact));
  await wrapped('https://tiles.test/16/1/2.pbf?session=secret');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(calls[0].pathname, '/{z}/{x}/{y}.pbf');
  assert.equal(calls[0].url, undefined);
  assert.equal(JSON.stringify(calls[0]).includes('secret'), false);
  assert.equal(calls[0].transport, 'fetch');
});

test('fetch wrapper records rejection without changing the rejection', async () => {
  const failure = new Error('network unavailable'); const calls = [];
  const wrapped = createObservedFetch(() => Promise.reject(failure), fact => calls.push(fact));
  await assert.rejects(wrapped('https://tiles.test/16/1/2.pbf?session=secret'), failure);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(calls[0], { type: 'mvt', hostname: 'tiles.test', pathname: '/{z}/{x}/{y}.pbf', tileCoordinatesPresent: true, transport: 'fetch', bodyReadable: false, decoded: false, decodeFailure: 'body-unavailable' });
});

test('XHR instrumentation observes a page-created instance without changing its request semantics', () => {
  const saved = globalThis.XMLHttpRequest;
  class FakeXhr extends EventTarget {
    constructor() { super(); this.calls = []; this.responseType = 'arraybuffer'; this.response = Uint8Array.of(1, 2).buffer; }
    open(...args) { this.calls.push(['open', args]); return 'open-result'; }
    send(...args) { this.calls.push(['send', args]); this.dispatchEvent(new Event('load')); return 'send-result'; }
    setRequestHeader(...args) { this.calls.push(['header', args]); }
    getResponseHeader(name) { this.calls.push(['getResponseHeader', [name]]); return name === 'content-type' ? 'application/x-protobuf' : null; }
  }
  globalThis.XMLHttpRequest = FakeXhr;
  const facts = [];
  installXhr(fact => facts.push(fact));
  const xhr = new FakeXhr();
  assert.equal(xhr.open('POST', 'https://tiles.test/16/1/2.pbf?token=secret', false, 'u', 'p'), 'open-result');
  xhr.setRequestHeader('Authorization', 'unchanged');
  assert.equal(xhr.send('original-body'), 'send-result');
  assert.deepEqual(xhr.calls.slice(0, 3), [
    ['open', ['POST', 'https://tiles.test/16/1/2.pbf?token=secret', false, 'u', 'p']],
    ['header', ['Authorization', 'unchanged']],
    ['send', ['original-body']]
  ]);
  assert.equal(facts[0].hostname, 'tiles.test');
  assert.equal(facts[0].pathname, '/{z}/{x}/{y}.pbf');
  assert.equal(facts[0].transport, 'xmlhttprequest');
  assert.equal(JSON.stringify(facts[0]).includes('secret'), false);
  globalThis.XMLHttpRequest = saved;
});

test('XHR reuse reports only the current open transport metadata', () => {
  const saved = globalThis.XMLHttpRequest;
  class FakeXhr extends EventTarget {
    constructor() { super(); this.responseType = ''; this.response = null; }
    open() {}
    send() { this.dispatchEvent(new Event('load')); }
    getResponseHeader() { return null; }
  }
  globalThis.XMLHttpRequest = FakeXhr;
  const facts = []; installXhr(fact => facts.push(fact));
  const xhr = new FakeXhr(); xhr.open('GET', 'https://tiles.test/old'); xhr.open('GET', 'https://tiles.test/current'); xhr.send();
  assert.deepEqual(facts, [{ type: 'resource', hostname: 'tiles.test', pathname: '/current', initiatorType: 'xmlhttprequest' }]);
  globalThis.XMLHttpRequest = saved;
});

test('inventories only sanitized images inside Leaflet containers', () => {
  const images = [
    { currentSrc: 'https://tiles.test/16/1/2.png?token=secret#x', naturalWidth: 256, naturalHeight: 256, classList: { contains: name => name === 'leaflet-tile' }, closest: selector => selector === '.leaflet-container' ? {} : null },
    { currentSrc: 'https://other.test/outside.png?token=secret', naturalWidth: 10, naturalHeight: 10, classList: { contains: () => false }, closest: () => null }
  ];
  assert.deepEqual(leafletImages(images, 'https://carto.monterritoire.fr/'), [{ hostname: 'tiles.test', pathname: '/16/1/2.png', width: 256, height: 256, class: 'leaflet-tile' }]);
});
