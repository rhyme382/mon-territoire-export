import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { analyzeContourResponse, isContourRequest, createObservedAjax, installContourObserver, scheduleContourInstall } from '../pci-contour-observer.js';
import { copyReport, validatePageFact } from '../content-ui.js';

// Synthetic fixtures only: no real cadastral reference, coordinate or INSEE code.
const RING = [[7.123456, 43.654321], [7.123999, 43.654321], [7.123999, 43.654999], [7.123456, 43.654321]];
const polygon = () => ({ type: 'Polygon', coordinates: [RING] });
const multi = () => ({ type: 'MultiPolygon', coordinates: [[RING], [RING]] });
const feature = (geometry, id) => ({ type: 'Feature', geometry, properties: { id_par: id, commune_label: 'SYNTHETIC_NAME' } });
const collection = (...features) => ({ type: 'FeatureCollection', features });
const text = value => JSON.stringify(value);

test('FeatureCollection of Polygon features is summarized structurally', () => {
  const s = analyzeContourResponse(collection(feature(polygon(), 'SYN_A'), feature(polygon(), 'SYN_B')));
  assert.equal(s.status, 'observed');
  assert.equal(s.rootKind, 'object'); assert.equal(s.rootType, 'FeatureCollection');
  assert.equal(s.hasFeatures, true); assert.equal(s.featureCount, 2);
  assert.deepEqual(s.geometryTypes, ['Polygon']);
  assert.equal(s.coordinateShape.maxDepth, 3); assert.equal(s.coordinateShape.numericLeafPairs, true);
  assert.deepEqual(s.coordinateShape.depthByGeometryType, { Polygon: 3 });
});

test('MultiPolygon is reported with its own depth', () => {
  const s = analyzeContourResponse(collection(feature(multi(), 'SYN_A')));
  assert.deepEqual(s.geometryTypes, ['MultiPolygon']);
  assert.equal(s.coordinateShape.maxDepth, 4);
});

test('a non-FeatureCollection object is described, not assumed', () => {
  const s = analyzeContourResponse({ foo: 1, bar: { baz: 2 } });
  assert.equal(s.rootKind, 'object'); assert.equal(s.rootType, null);
  assert.equal(s.hasFeatures, false); assert.equal(s.featureCount, 0);
  assert.deepEqual(s.rootKeys, ['bar', 'foo']);
  assert.equal(s.parcelIdentity.propertyPresent, false);
});

test('an array response is handled as items', () => {
  const s = analyzeContourResponse([{ id_par: 'SYN_A', geometry: polygon() }, { id_par: 'SYN_B', geometry: polygon() }]);
  assert.equal(s.rootKind, 'array'); assert.equal(s.itemsSource, 'array');
  assert.equal(s.featureCount, 2); assert.deepEqual(s.geometryTypes, ['Polygon']);
  assert.deepEqual(s.parcelIdentity.candidateKeys, ['id_par']);
});

test('id_par in properties is detected by name only, with coverage and uniqueness', () => {
  const s = analyzeContourResponse(collection(feature(polygon(), 'SYN_A'), feature(polygon(), 'SYN_B')));
  assert.equal(s.hasProperties, true);
  assert.deepEqual(s.propertyKeys, ['commune_label', 'id_par']);
  assert.deepEqual(s.parcelIdentity, { propertyPresent: true, candidateKeys: ['id_par'], featureIdPresent: false, coverage: 'all', uniqueValues: true });
  const dup = analyzeContourResponse(collection(feature(polygon(), 'SYN_A'), feature(polygon(), 'SYN_A')));
  assert.equal(dup.parcelIdentity.uniqueValues, false);
});

test('absence of any identifier is reported without guessing', () => {
  const s = analyzeContourResponse(collection({ type: 'Feature', geometry: polygon(), properties: { surface: 12 } }));
  assert.deepEqual(s.parcelIdentity, { propertyPresent: false, candidateKeys: [], featureIdPresent: false, coverage: 'none', uniqueValues: null });
});

test('requested ids are only compared as an aggregate count', () => {
  const s = analyzeContourResponse(collection(feature(polygon(), 'SYN_A'), feature(polygon(), 'SYN_X')), { requestedIds: ['SYN_A', 'SYN_B', 'SYN_C'] });
  assert.equal(s.requestedCount, 3); assert.equal(s.matchedRequestedCount, 1);
  assert.equal(text(s).includes('SYN_'), false);
});

test('explicit CRS is detected structurally and never inferred', () => {
  const root = analyzeContourResponse({ ...collection(feature(polygon(), 'SYN_A')), crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::2154' } } });
  assert.equal(root.explicitCrs, true); assert.deepEqual(root.crsLocations, ['root']); assert.equal(root.crsDeclared, 'EPSG:2154');
  const odd = analyzeContourResponse({ ...collection(), srs: 'whatever private text' });
  assert.equal(odd.explicitCrs, true); assert.equal(odd.crsDeclared, 'unrecognized'); assert.equal(text(odd).includes('private'), false);
});

test('no CRS member means explicitCrs false even for GeoJSON-looking data', () => {
  const s = analyzeContourResponse(collection(feature(polygon(), 'SYN_A')));
  assert.equal(s.explicitCrs, false); assert.deepEqual(s.crsLocations, []); assert.equal(s.crsDeclared, undefined);
});

test('an oversized response is diagnosed and not analyzed', () => {
  const s = analyzeContourResponse(collection(feature(polygon(), 'SYN_A')), { responseLength: 50_000_000 });
  assert.equal(s.status, 'too-large'); assert.equal(s.reason, 'response-too-large');
  assert.equal(s.featureCount, undefined);
});

test('depth and volume are bounded', () => {
  let deep = [1, 2]; for (let i = 0; i < 100; i++) deep = [deep];
  const d = analyzeContourResponse(collection({ type: 'Feature', geometry: { type: 'Polygon', coordinates: deep }, properties: {} }));
  assert.equal(d.status, 'observed'); assert.equal(d.truncated, true); assert.ok(d.coordinateShape.maxDepth <= 12);
  const many = analyzeContourResponse(collection(...Array.from({ length: 5000 }, () => feature(polygon(), 'SYN'))));
  assert.equal(many.featureCount, 5000); assert.equal(many.truncated, true);
  const keys = Object.fromEntries(Array.from({ length: 500 }, (_, i) => ['k' + String.fromCharCode(97 + i % 26) + i, 1]));
  const wide = analyzeContourResponse(keys);
  assert.ok(wide.rootKeys === undefined || wide.rootKeys.length <= 16); assert.equal(wide.rootKeyCount, 500);
});

test('invalid roots are classified', () => {
  assert.equal(analyzeContourResponse(null).status, 'invalid');
  assert.equal(analyzeContourResponse('x').rootKind, 'string');
  assert.equal(analyzeContourResponse(undefined).reason, 'no-json');
});

test('summary retains no coordinate and no property or key value', () => {
  const data = collection(feature(polygon(), 'SYN_PARCEL_VALUE'), { type: 'Feature', geometry: multi(), properties: { id_par: 'SYN_B', owner: 'SYNTHETIC_NAME' } });
  const out = text(analyzeContourResponse(data, { requestedIds: ['SYN_B'] }));
  for (const leak of ['7.123', '43.654', 'SYN_PARCEL_VALUE', 'SYN_B', 'SYNTHETIC_NAME']) assert.equal(out.includes(leak), false, leak);
});

test('data-like keys are redacted rather than reported', () => {
  const s = analyzeContourResponse({ '66000000AB0123': { type: 'Polygon', coordinates: [RING] }, features_note: 1 });
  assert.equal(text(s).includes('66000000AB0123'), false);
  assert.equal(s.redactedKeyCount, 1);
});

test('degree-looking values are only a structural range hint', () => {
  assert.equal(analyzeContourResponse(collection(feature(polygon(), 'A'))).coordinateShape.valueRange, 'within-degree-bounds');
  const projected = { type: 'Polygon', coordinates: [[[900000, 6600000], [900010, 6600000], [900010, 6600010], [900000, 6600000]]] };
  assert.equal(analyzeContourResponse(collection(feature(projected, 'A'))).coordinateShape.valueRange, 'exceeds-degree-bounds');
});

test('only the contour endpoint of the PCI geometries path is matched', () => {
  const base = 'https://api.sogefi.io/cadastre/v1.0/pci/parcelle/geometries';
  assert.equal(isContourRequest(`${base}?geometryType=contour`, 'https://carto.monterritoire.fr/'), true);
  assert.equal(isContourRequest({ url: `${base}?geometryType=contour` }, 'https://carto.monterritoire.fr/'), true);
  assert.equal(isContourRequest(`${base}?geometryType=default`, 'https://carto.monterritoire.fr/'), false);
  assert.equal(isContourRequest(`${base}`, 'https://carto.monterritoire.fr/'), false);
  assert.equal(isContourRequest('https://api.sogefi.io/cadastre/v1.0/pci/parcelle/search?geometryType=contour', 'https://carto.monterritoire.fr/'), false);
  assert.equal(isContourRequest(undefined, 'https://carto.monterritoire.fr/'), false);
});

function fakeXhr(body, status = 200) {
  const callbacks = [];
  return { status, responseJSON: body, responseText: text(body ?? ''), always(fn) { callbacks.push(fn); return this; }, finish() { callbacks.forEach(fn => fn()); } };
}
const contourUrl = 'https://api.sogefi.io/cadastre/v1.0/pci/parcelle/geometries?geometryType=contour';

test('a normal contour ajax call is observed after completion without altering anything', () => {
  const xhr = fakeXhr(collection(feature(polygon(), 'SYN_A')));
  const seen = []; const options = Object.freeze({ url: contourUrl, type: 'POST', data: Object.freeze({ parcelles: Object.freeze(['SYN_A']) }) });
  const self = { name: 'jq' }; let received;
  const original = function (...args) { received = { self: this, args }; return xhr; };
  const wrapped = createObservedAjax(original, fact => seen.push(fact), 'https://carto.monterritoire.fr/');
  assert.equal(wrapped.call(self, options), xhr);
  assert.equal(received.self, self); assert.equal(received.args.length, 1); assert.equal(received.args[0], options);
  assert.equal(seen.length, 0);
  xhr.finish();
  assert.equal(seen.length, 1); assert.equal(seen[0].type, 'pci-contour'); assert.equal(seen[0].status, 'observed');
  assert.equal(seen[0].matchedRequestedCount, 1);
});

test('wrapper preserves exceptions and arguments of the url+settings form', () => {
  const boom = new Error('page error');
  const wrapped = createObservedAjax(() => { throw boom; }, () => {}, 'https://x.test/');
  assert.throws(() => wrapped(contourUrl, {}), error => error === boom);
});

test('a non-contour endpoint and other ajax calls are ignored', () => {
  const seen = []; const xhr = fakeXhr(collection());
  let alwaysCalled = false; xhr.always = () => { alwaysCalled = true; return xhr; };
  const wrapped = createObservedAjax(() => xhr, fact => seen.push(fact), 'https://x.test/');
  assert.equal(wrapped({ url: 'https://api.sogefi.io/cadastre/v1.0/pci/parcelle/geometries?geometryType=default' }), xhr);
  assert.equal(wrapped({ url: 'https://other.test/api' }), xhr);
  assert.equal(wrapped('https://api.sogefi.io/cog/v1.0/sogefi/entities/search'), xhr);
  assert.equal(alwaysCalled, false); assert.deepEqual(seen, []);
});

test('observer failures never reach the page', () => {
  const xhr = fakeXhr(collection());
  xhr.always = () => { throw new Error('hostile'); };
  const wrapped = createObservedAjax(() => xhr, () => { throw new Error('emit'); }, 'https://x.test/');
  assert.equal(wrapped({ url: contourUrl }), xhr);
});

test('http error statuses are classified invalid', () => {
  const seen = []; const xhr = fakeXhr(null, 500);
  const wrapped = createObservedAjax(() => xhr, f => seen.push(f), 'https://x.test/');
  wrapped({ url: contourUrl }); xhr.finish();
  assert.equal(seen[0].status, 'invalid'); assert.equal(seen[0].reason, 'http-status');
});

test('installation is idempotent and does not wrap other jQuery functions', () => {
  const ajax = () => 'r'; const get = () => 'g';
  const jq = { ajax, get }; const global = { jQuery: jq, $: jq, location: { href: 'https://x.test/' } };
  assert.equal(installContourObserver(global, () => {}), true);
  const first = jq.ajax; assert.notEqual(first, ajax);
  assert.equal(installContourObserver(global, () => {}), true);
  assert.equal(jq.ajax, first); assert.equal(jq.get, get);
  assert.equal(jq.ajax(), 'r');
});

test('installation fails silently while jQuery is absent', () => {
  assert.equal(installContourObserver({}, () => {}), false);
  assert.equal(installContourObserver({ $: 'not jquery' }, () => {}), false);
});

test('late jQuery is picked up by a bounded retry, never an infinite poll', () => {
  const timers = []; const global = { location: { href: 'https://x.test/' } };
  const handle = scheduleContourInstall(global, () => {}, { setTimeoutFn: fn => { timers.push(fn); }, maxAttempts: 5 });
  assert.equal(timers.length, 1);
  timers.shift()(); assert.equal(timers.length, 1);
  global.jQuery = { ajax: () => 'r' };
  timers.shift()();
  assert.equal(global.jQuery.ajax.name, 'observedAjax'); assert.equal(timers.length, 0); assert.equal(handle.installed(), true);
  const never = []; scheduleContourInstall({}, () => {}, { setTimeoutFn: fn => { never.push(fn); }, maxAttempts: 3 });
  for (let i = 0; i < 10 && never.length; i++) never.shift()();
  assert.equal(never.length, 0);
});

test('page facts for contour summaries pass a closed schema and reach the report', async () => {
  const summary = analyzeContourResponse(collection(feature(polygon(), 'SYN_A')), { requestedIds: ['SYN_A'] });
  const fact = { type: 'pci-contour', ...summary };
  const valid = validatePageFact(fact);
  assert.ok(valid); assert.deepEqual(valid, fact);
  assert.equal(validatePageFact({ ...fact, coordinates: [[1, 2]] }), null);
  assert.equal(validatePageFact({ ...fact, geometryTypes: ['Polygon', 'SYN_A'] }), null);
  assert.equal(validatePageFact({ ...fact, propertyKeys: ['66000000AB0123'] }), null);
  let written = ''; const out = await copyReport({ pciContourObservations: [valid] }, { writeText: async t => { written = t; } });
  const report = JSON.parse(out);
  assert.equal(written, out); assert.equal(report.pciContour.status, 'observed');
  assert.equal(report.pciContour.observations.length, 1); assert.equal(report.pciContour.observations[0].rootType, 'FeatureCollection');
  assert.equal(JSON.parse(await copyReport({}, { writeText: async () => {} })).pciContour.status, 'waiting');
});

test('manifest permissions are unchanged in source and dist', async () => {
  for (const file of ['manifest.json', 'dist/manifest.json']) {
    const manifest = JSON.parse(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
    assert.deepEqual(manifest.permissions, ['activeTab']);
    assert.equal(manifest.host_permissions, undefined);
    assert.ok(manifest.content_scripts.some(item => item.world === 'MAIN' && item.js.includes('pci-contour-observer.js')));
  }
});
