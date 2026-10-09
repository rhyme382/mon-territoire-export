import test from 'node:test';
import assert from 'node:assert/strict';
import { createObservedFetch, installXhr, summarizeObservedMvt, sanitizeMvtPath } from '../main-observer.js';
import { makeSyntheticCadastralMvt } from './fixtures/synthetic-mvt.js';

test('T00-D fetch is transparent, clones only a strong MVT candidate, and adds no request', async () => {
  let requests = 0;
  const facts = [];
  const original = async () => {
    requests++;
    return new Response(makeSyntheticCadastralMvt(), { headers: { 'content-type': 'application/vnd.mapbox-vector-tile' } });
  };
  const wrapped = createObservedFetch(original, fact => facts.push(fact));
  const response = await wrapped('https://tiles.test/vector/17/66000/44000.pbf?token=synthetic');
  assert.equal(await response.arrayBuffer() instanceof ArrayBuffer, true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests, 1);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].bodyReadable, true);
  assert.equal(facts[0].decoded, true);
  assert.equal(facts[0].pathname, '/vector/{z}/{x}/{y}.pbf');
  assert.equal(JSON.stringify(facts[0]).includes('66000'), false);
});

test('T00-D XHR leaves open and send untouched and analyzes the existing ArrayBuffer once', () => {
  const saved = globalThis.XMLHttpRequest;
  class FakeXhr extends EventTarget {
    constructor() { super(); this.responseType = 'arraybuffer'; this.response = makeSyntheticCadastralMvt(); this.calls = []; }
    open(...args) { this.calls.push(['open', args]); }
    send(...args) { this.calls.push(['send', args]); this.dispatchEvent(new Event('load')); }
    getResponseHeader(name) { return name === 'content-type' ? 'application/x-protobuf' : null; }
  }
  globalThis.XMLHttpRequest = FakeXhr;
  const facts = []; installXhr(fact => facts.push(fact));
  const xhr = new FakeXhr(); xhr.open('GET', 'https://tiles.test/cadastre/17/66000/44000.pbf?token=synthetic'); xhr.send('unchanged');
  assert.deepEqual(xhr.calls, [['open', ['GET', 'https://tiles.test/cadastre/17/66000/44000.pbf?token=synthetic']], ['send', ['unchanged']]]);
  assert.equal(facts.length, 1); assert.equal(facts[0].bodyReadable, true); assert.equal(facts[0].decoded, true);
  globalThis.XMLHttpRequest = saved;
});

test('T00-D summarizes only MVT metadata and never property values or geometry coordinates', () => {
  const fact = summarizeObservedMvt('https://tiles.test/cadastre/17/66000/44000.pbf?access_token=synthetic', 'fetch', 'application/x-protobuf', makeSyntheticCadastralMvt());
  assert.deepEqual(fact.layers[0].propertyNames, ['idu', 'insee', 'section']);
  assert.equal(fact.layers[0].featureCount, 2);
  assert.equal(fact.layers[0].geometryTypes.Polygon, 2);
  const text = JSON.stringify(fact);
  for (const forbidden of ['synthetic-idu-value', 'synthetic-insee-value', 'synthetic-section-value', '66000', '44000', 'token', 'ArrayBuffer', 'base64']) assert.equal(text.includes(forbidden), false);
});

test('T00-D sanitizes tile coordinates, query, and fragment', () => {
  assert.deepEqual(sanitizeMvtPath('https://tiles.test/a/17/66000/44000.mvt?token=synthetic#fragment'), { hostname: 'tiles.test', pathname: '/a/{z}/{x}/{y}.mvt', tileCoordinatesPresent: true });
});

test('T00-D records inaccessible bodies without retrying and ignores ordinary non-MVT resources', async () => {
  const facts = [];
  const wrapped = createObservedFetch(async () => new Response('ordinary page response', { headers: { 'content-type': 'text/plain' } }), fact => facts.push(fact));
  await wrapped('https://tiles.test/assets/app.js');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(facts.some(fact => fact.type === 'mvt'), false);
  const inaccessible = summarizeObservedMvt('https://tiles.test/cadastre/17/1/2.pbf', 'fetch', 'application/x-protobuf', null);
  assert.equal(inaccessible.bodyReadable, false); assert.equal(inaccessible.decoded, false);
});
