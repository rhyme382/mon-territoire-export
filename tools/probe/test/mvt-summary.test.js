import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS, summarizeMvt } from '../lib/mvt-summary.js';
import { makeSyntheticMvt } from './fixtures/synthetic-mvt.js';

test('summarizes synthetic MVT without returning a property value or coordinate', () => {
  const result = summarizeMvt(makeSyntheticMvt(), DEFAULT_LIMITS);
  assert.deepEqual(result.layers[0].propertyNames, ['parcel_key']);
  assert.equal(JSON.stringify(result).includes('secret-cadastral-value'), false);
  assert.equal(JSON.stringify(result).includes('123456'), false);
  assert.equal(result.layers[0].geometryTypes.Polygon, 1);
});

test('returns a bounded unreadable diagnostic for truncated input', () => {
  assert.deepEqual(summarizeMvt(Uint8Array.of(26, 9, 1).buffer, DEFAULT_LIMITS), { status: 'unreadable', reason: 'truncated' });
});
