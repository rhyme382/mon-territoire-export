import test from 'node:test';
import assert from 'node:assert/strict';
import { copyEngineReport, copyMvtReport, copyReport, copyRenderReport, validatePageFact } from '../content-ui.js';

test('copy action writes the sanitized report text, not an observed body', async () => {
  let written = '';
  const fakeClipboard = { writeText: async text => { written = text; } };
  const copied = await copyReport({ resources: [{ type: 'resource', hostname: 'x.test', pathname: '/1/2/3.pbf', initiatorType: 'fetch' }] }, fakeClipboard);
  assert.match(copied, /x\.test/);
  assert.doesNotMatch(copied, /token|authorization|cookie/i);
  assert.equal(written, copied);
});

test('render copy writes only the already-sanitized local snapshot', async () => {
  let written = '';
  const report = { schemaVersion: 1, inspection: 'passive-dom-render-only', containers: [], candidateGroups: [] };
  await copyRenderReport(report, { writeText: async text => { written = text; } });
  assert.equal(written, JSON.stringify(report, null, 2));
});

test('rebuilds zxy and discards injected coordinate fields', async () => {
  const text = await copyReport({ resources: [{ type: 'resource', hostname: 'x.test', pathname: '/1/2/3.pbf', zxy: { z: 3, x: 2, y: 1, precise: [45.1] } }] }, { writeText: async () => {} });
  assert.doesNotMatch(text, /precise|45\.1/);
});

test('rejects hostile MAIN-world event details before aggregation', () => {
  const valid = { type: 'resource', hostname: 'tiles.test', pathname: '/16/1/2.pbf', zxy: { z: 16, x: 1, y: 2 }, initiatorType: 'fetch', transferSize: 12, encodedBodySize: 10, decodedBodySize: 20 };
  assert.deepEqual(validatePageFact(valid), valid);
  for (const hostile of [
    { ...valid, cookie: 'session=secret' },
    { ...valid, authorization: 'Bearer secret' },
    { ...valid, token: 'secret' },
    { ...valid, body: 'raw response' },
    { ...valid, propertyValues: { parcel: 'secret' } },
    { ...valid, html: '<script>alert(1)</script>' },
    { ...valid, pathname: '/tiles?token=secret' },
    { ...valid, extra: 'not in the schema' },
    { ...valid, zxy: { z: 16, x: 1, y: 2, cadastral: [48.1, 2.3] } },
    { ...valid, huge: Array.from({ length: 10_001 }, () => 'x') }
  ]) assert.equal(validatePageFact(hostile), null);
});

test('accepts only a bounded DOM diagnostic schema', () => {
  const fact = { type: 'dom', leaflet: { containers: 1, viewport: { width: 1024, height: 768 }, panes: [{ name: 'tile', transform: 'translate3d(12px, 24px, 0px)' }], svgCount: 1, canvasCount: 2, imageCount: 3, images: [{ hostname: 'tiles.test', pathname: '/16/1/2.png', width: 256, height: 256, class: 'leaflet-tile' }], maskPane: true } };
  assert.deepEqual(validatePageFact(fact), fact);
  assert.equal(validatePageFact({ ...fact, leaflet: { ...fact.leaflet, pageText: 'parcel 123' } }), null);
});

test('accepts bounded pipeline diagnostics and rejects sensitive diagnostic data', () => {
  const diagnostic = { type: 'diagnostic', probeDiagnostics: { mainObserverStarted: true, fetchWrapped: true, xhrWrapped: true, performanceInitialScanCompleted: true, performanceObserverAvailable: true, performanceObserverStarted: true, resourceFactsEmitted: 2, resourceFactsAccepted: 0, resourceFactsRejected: 0, resourceFactsPending: 0, performanceResourcesSeen: 2, initiatorTypes: { img: 2 } } };
  assert.deepEqual(validatePageFact(diagnostic), diagnostic);
  assert.equal(validatePageFact({ ...diagnostic, probeDiagnostics: { ...diagnostic.probeDiagnostics, token: 'secret' } }), null);
});

test('T00-D accepts only aggregated MVT facts and labels the report passive', async () => {
  const fact = { type: 'mvt', hostname: 'tiles.test', pathname: '/cadastre/{z}/{x}/{y}.pbf', tileCoordinatesPresent: true, transport: 'fetch', contentType: 'application/x-protobuf', byteLength: 100, bodyReadable: true, decoded: true, layers: [{ name: 'cadastre_parcelle', extent: 4096, featureCount: 2, featuresWithId: 2, propertyNames: ['idu', 'insee', 'section'], geometryTypes: { Point: 0, LineString: 0, Polygon: 2 } }] };
  assert.deepEqual(validatePageFact(fact), fact);
  assert.equal(validatePageFact({ ...fact, propertyValues: ['real-value'] }), null);
  let written = '';
  const text = await copyMvtReport({ candidates: [fact], diagnostics: { candidatesObserved: 1, bodiesReadable: 1, bodiesUnreadable: 0, decodeSuccess: 1, decodeFailure: 0, sanitizedFactsEmitted: 1, sanitizedFactsAccepted: 1, sanitizedFactsRejected: 0, sanitizedFactsPending: 0 } }, { writeText: async value => { written = value; } });
  assert.match(text, /passive-mvt-runtime-only/);
  assert.match(text, /no-additional-network-requests/);
  assert.equal(written, text);
  assert.doesNotMatch(text, /real-value|66000|token/i);
});

test('T00-E accepts only technical metadata and labels worker payloads and cadastral data unobserved', async () => {
  const snapshot = { schemaVersion: 1, inspection: 'passive-engine-worker-identification', 'no-additional-network-requests': true, runtime: { libraries: [{ libraryDetected: true, libraryName: 'Leaflet', version: '1.9.4', classes: ['Map', 'VectorGrid.Protobuf'], prototypeMethods: [] }] }, primaryMap: { containers: 1, index: 0, reason: 'largest-container', dimensions: { width: 800, height: 600 }, engine: 'Leaflet', mapObjectReachable: true }, layerAggregates: [{ constructorName: 'VectorGrid.Protobuf', count: 1, hasUrlTemplate: true, sanitizedUrlPattern: { hostname: 'tiles.test', pathname: '/cadastre/{z}/{x}/{y}.pbf' }, hasTileLayerSemantics: true, hasVectorGridSemantics: true, hasCanvasRenderer: false, hasSvgRenderer: false, technicalPropertyNames: ['_url'] }], workers: [{ type: 'Worker', scriptLocation: { hostname: 'cdn.test', pathname: '/worker.js' }, workerType: 'module', hasName: true }], serviceWorker: { apiAvailable: true, controllerPresent: true, controllerScript: { hostname: 'carto.test', pathname: '/sw.js' } }, iframes: { count: 0, sameOriginCount: 0, crossOriginCount: 0, frames: [] }, scriptSignatures: [{ hostname: 'cdn.test', pathname: '/leaflet.js', category: 'leaflet' }], diagnostics: { runtimeInspectionCompleted: true, leafletDetected: true, mapLibreDetected: false, mapboxDetected: false, openLayersDetected: false, primaryMapReachable: true, workerConstructorWrapped: true, workersObserved: 1, sharedWorkersObserved: 0, serviceWorkerControllerPresent: true, iframesObserved: 0, scriptSignaturesObserved: 1, canvasCount: 0, svgCount: 0, containerCount: 1 } };
  assert.equal(validatePageFact({ type: 'engine-snapshot', snapshot: { ...snapshot, workers: [{ ...snapshot.workers[0], payload: 'secret' }] } }), null);
  const text = await copyEngineReport([snapshot], { available: false, summary: 'comparison unavailable' }, { writeText: async () => {} });
  for (const forbidden of ['Authorization', 'Cookie', 'Set-Cookie', 'idu', 'insee', '66000', 'worker message']) assert.equal(text.includes(forbidden), false);
  assert.match(text, /workerMessages/); assert.match(text, /not-observed/);
});
