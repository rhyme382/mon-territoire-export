import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger } from '../lib/report.js';

test('aggregates sizes and never retains sensitive resource fields', () => {
  const ledger = createLedger();
  ledger.observeResource({ url: 'https://x.test/p/16/1/2.pbf?access_token=no', bytes: 12, authorization: 'no', propertyValues: { idu: 'no' } });
  assert.deepEqual(ledger.toSanitizedReport().resources[0], {
    hostname: 'x.test', pathname: '/p/16/1/2.pbf', zxy: { z: 16, x: 1, y: 2 }, bytes: 12
  });
});

test('uses a fixed bounded schema for unreadable and MVT facts', () => {
  const ledger = createLedger({ maxResources: 1 });
  ledger.observeResource({ url: 'https://x.test/one', bytes: 7, mime: 'application/x-protobuf', mvt: {
    featureCount: 2, vertexCount: 9, layers: [{ name: 'cadastre', extent: 4096, propertyNames: ['parcel_key'], geometryTypes: { Polygon: 2 } }]
  } });
  ledger.observeResource({ url: 'https://x.test/two', body: 'must not persist' });
  const report = ledger.toSanitizedReport();
  assert.equal(report.resources.length, 1);
  assert.equal(report.totals.knownBytes, 7);
  assert.equal(report.totals.pbfFeatures, 2);
  assert.equal(report.totals.vertices, 9);
  assert.equal(JSON.stringify(report).includes('must not persist'), false);
});
