import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../lib/sanitize.js';

test('removes query and fragment while retaining tile coordinates', () => {
  assert.deepEqual(normalizeUrl('https://tiles.example.test/a/17/66000/44000.pbf?token=secret#x'), {
    hostname: 'tiles.example.test',
    pathname: '/a/17/66000/44000.pbf',
    zxy: { z: 17, x: 66000, y: 44000 }
  });
});

test('rejects non-http URLs and never retains credentials', () => {
  assert.equal(normalizeUrl('data:text/plain,secret'), null);
  assert.deepEqual(normalizeUrl('https://user:password@tiles.example.test/1/2/3'), {
    hostname: 'tiles.example.test', pathname: '/1/2/3', zxy: { z: 1, x: 2, y: 3 }
  });
});

test('rejects an encoded query delimiter in the pathname', () => {
  assert.equal(normalizeUrl('https://x.test/tiles%3Fsession%3Dsynthetic'), null);
});
