import test from 'node:test';
import assert from 'node:assert/strict';
import { vcgAssemble, vcgClipRing, vcgClipRings, vcgFingerprint, vcgMergeFragments, vcgNormalizeParts, vcgSignedArea, vcgTileToViewport } from '../visible-cadastre-geometry.js';

const RECT = { minX: 0, minY: 0, maxX: 100, maxY: 80 };
const square = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const inside = (rings, rect = RECT) => rings.every(ring => ring.every(([x, y]) => x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY));
const bbox = ring => ({ minX: Math.min(...ring.map(p => p[0])), maxX: Math.max(...ring.map(p => p[0])), minY: Math.min(...ring.map(p => p[1])), maxY: Math.max(...ring.map(p => p[1])) });

test('normalizes Leaflet pixel parts: {x,y} points, closing duplicate removed, tiny rings dropped', () => {
  const rings = vcgNormalizeParts([[{ x: 1, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 9 }, { x: 1, y: 2 }], [{ x: 0, y: 0 }, { x: 1, y: 1 }]]);
  assert.deepEqual(rings, [[[1, 2], [8, 2], [8, 9]]]);
});

test('normalizes [x,y] pairs and flattens nested MultiPolygon-like parts', () => {
  const rings = vcgNormalizeParts([[square(0, 0, 4, 4)], [square(10, 10, 14, 14), square(11, 11, 12, 12)]]);
  assert.equal(rings.length, 3);
  assert.deepEqual(rings[0], square(0, 0, 4, 4));
});

test('rejects non-finite and malformed parts without throwing', () => {
  assert.deepEqual(vcgNormalizeParts(undefined), []);
  assert.deepEqual(vcgNormalizeParts([[{ x: NaN, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]]), []);
  assert.deepEqual(vcgNormalizeParts([[{ x: '1', y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }]]), []);
});

test('tile-local points land in viewport pixels: origin + local * scale', () => {
  assert.deepEqual(vcgTileToViewport([[[0, 0], [256, 0], [256, 256]]], { x: -40, y: 10 }, 1), [[[-40, 10], [216, 10], [216, 266]]]);
  assert.deepEqual(vcgTileToViewport([[[10, 20]]], { x: 100, y: 200 }, 2), [[[120, 240]]]);
});

test('clip: polygon fully inside is kept unchanged', () => {
  assert.deepEqual(vcgClipRing(square(10, 10, 50, 50), RECT), square(10, 10, 50, 50));
});

test('clip: polygon fully outside is removed', () => {
  assert.equal(vcgClipRing(square(200, 200, 300, 300), RECT), null);
  assert.equal(vcgClipRing(square(-50, 10, -10, 50), RECT), null);
});

for (const [name, ring, expected] of [
  ['left', square(-20, 10, 40, 50), { minX: 0, maxX: 40, minY: 10, maxY: 50 }],
  ['right', square(60, 10, 140, 50), { minX: 60, maxX: 100, minY: 10, maxY: 50 }],
  ['top', square(10, -30, 50, 40), { minX: 10, maxX: 50, minY: 0, maxY: 40 }],
  ['bottom', square(10, 40, 50, 200), { minX: 10, maxX: 50, minY: 40, maxY: 80 }],
]) {
  test(`clip: polygon crossing the ${name} edge is cut exactly on the edge`, () => {
    const clipped = vcgClipRing(ring, RECT);
    assert.deepEqual(bbox(clipped), expected);
    assert.equal(clipped.length, 4);
  });
}

test('clip: polygon crossing two edges (corner) keeps a closed 4-vertex region', () => {
  const clipped = vcgClipRing(square(-10, -10, 30, 30), RECT);
  assert.deepEqual(bbox(clipped), { minX: 0, maxX: 30, minY: 0, maxY: 30 });
  assert.equal(Math.abs(vcgSignedArea(clipped)), 900);
});

test('clip: polygon straddling opposite edges becomes a band', () => {
  const clipped = vcgClipRing(square(-50, 20, 150, 40), RECT);
  assert.deepEqual(bbox(clipped), { minX: 0, maxX: 100, minY: 20, maxY: 40 });
});

test('clip: polygon enclosing the whole viewport clips to the viewport rectangle', () => {
  const clipped = vcgClipRing(square(-500, -500, 500, 500), RECT);
  assert.deepEqual(bbox(clipped), { minX: 0, maxX: 100, minY: 0, maxY: 80 });
  assert.equal(Math.abs(vcgSignedArea(clipped)), 8000);
});

test('clip: concave triangle-ish polygon is really cut (not just points filtered)', () => {
  const clipped = vcgClipRing([[-50, 40], [50, -20], [50, 100]], RECT);
  assert.ok(clipped.length >= 4);
  assert.ok(inside([clipped]));
  assert.ok(clipped.some(([x, y]) => x === 0 && y > 0 && y < 80), 'new vertex on the left edge');
});

test('clip: orientation of every ring is preserved', () => {
  const clockwise = square(-10, 10, 40, 50); const counter = clockwise.slice().reverse();
  assert.equal(Math.sign(vcgSignedArea(vcgClipRing(clockwise, RECT))), Math.sign(vcgSignedArea(clockwise)));
  assert.equal(Math.sign(vcgSignedArea(vcgClipRing(counter, RECT))), Math.sign(vcgSignedArea(counter)));
});

test('clip: result is closed-compatible (>= 3 distinct vertices, no repeated closing point) and never leaves the viewport', () => {
  for (const ring of [square(-20, -20, 50, 50), square(90, 70, 150, 150), [[-30, 40], [40, -30], [130, 40], [40, 130]]]) {
    const clipped = vcgClipRing(ring, RECT);
    assert.ok(clipped.length >= 3);
    assert.notDeepEqual(clipped[0], clipped.at(-1));
    assert.ok(inside([clipped]));
  }
});

test('clip: a hole stays a hole and a hole crossing the edge is cut', () => {
  const rings = vcgClipRings([square(10, 10, 90, 70), square(-10, 20, 30, 40).reverse()], RECT);
  assert.equal(rings.length, 2);
  assert.ok(inside(rings));
  assert.deepEqual(bbox(rings[1]), { minX: 0, maxX: 30, minY: 20, maxY: 40 });
  assert.equal(Math.sign(vcgSignedArea(rings[1])), -Math.sign(vcgSignedArea(rings[0])));
});

test('clip: a MultiPolygon (several outer rings) keeps every visible part', () => {
  const rings = vcgClipRings([square(10, 10, 20, 20), square(300, 300, 310, 310), square(90, 60, 120, 90)], RECT);
  assert.equal(rings.length, 2);
  assert.ok(inside(rings));
});

test('fingerprint is deterministic, order of ring start does not matter, different shapes differ', () => {
  const a = vcgFingerprint([square(0, 0, 10, 10)]);
  assert.equal(a, vcgFingerprint([square(0, 0, 10, 10)]));
  assert.equal(a, vcgFingerprint([[[10, 0], [10, 10], [0, 10], [0, 0]]]));
  assert.notEqual(a, vcgFingerprint([square(0, 0, 10, 11)]));
});

test('merge: two adjacent fragments cut on a seam become one ring without the seam', () => {
  const left = square(0, 0, 50, 40); const right = square(50, 0, 100, 40);
  const merged = vcgMergeFragments([[left], [right]]);
  assert.equal(merged.length, 1);
  assert.deepEqual(bbox(merged[0]), { minX: 0, maxX: 100, minY: 0, maxY: 40 });
  assert.equal(merged[0].length, 4, 'collinear seam vertices removed');
  assert.equal(Math.abs(vcgSignedArea(merged[0])), 4000);
});

test('merge: seam endpoints differing by sub-pixel rounding still merge', () => {
  const left = [[0, 0], [50, 0], [50, 40.04], [0, 40]]; const right = [[50, 0.03], [100, 0], [100, 40], [50, 40]];
  const merged = vcgMergeFragments([[left], [right]]);
  assert.equal(merged.length, 1);
  assert.deepEqual(bbox(merged[0]).maxX, 100);
});

test('merge: four fragments around a tile corner become one ring', () => {
  const merged = vcgMergeFragments([[square(0, 0, 50, 50)], [square(50, 0, 100, 50)], [square(0, 50, 50, 100)], [square(50, 50, 100, 100)]]);
  assert.equal(merged.length, 1);
  assert.equal(Math.abs(vcgSignedArea(merged[0])), 10000);
});

test('merge: fragments that do not touch are all kept (nothing is lost)', () => {
  const merged = vcgMergeFragments([[square(0, 0, 10, 10)], [square(50, 50, 60, 60)]]);
  assert.equal(merged.length, 2);
});

test('merge: a hole fully inside one fragment survives', () => {
  const merged = vcgMergeFragments([[square(0, 0, 50, 50), square(10, 10, 20, 20).reverse()], [square(50, 0, 100, 50)]]);
  assert.equal(merged.length, 2);
  assert.equal(merged.reduce((sum, ring) => sum + vcgSignedArea(ring), 0), 5000 - 100);
});

const viewport = { width: 100, height: 80 };
const tile = (origin, features, size = 50) => ({ origin, tileSize: { x: size, y: size }, scale: 1, features });
const feature = (key, rings) => ({ key: key === null ? null : { tier: 'id', value: key }, rings });

test('assemble: the same feature present in two tiles with overlapping buffers is exported once', () => {
  // parcel spans x 30..70; tile A (0..50) and tile B (50..100) both carry the full parcel (buffer).
  const full = local => [square(30 - local, 10, 70 - local, 30)];
  const result = vcgAssemble({ viewport, tiles: [tile({ x: 0, y: 0 }, [feature('P1', full(0))]), tile({ x: 50, y: 0 }, [feature('P1', full(50))])] });
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].rings.length, 1);
  assert.deepEqual(bbox(result.features[0].rings[0]), { minX: 30, maxX: 70, minY: 10, maxY: 30 });
  assert.equal(Math.abs(vcgSignedArea(result.features[0].rings[0])), 800);
  assert.equal(result.counts.uniqueFeatures, 1);
  assert.equal(result.counts.duplicatesHandled, 1);
});

test('assemble: complementary fragments of one feature are merged, none is lost', () => {
  const result = vcgAssemble({ viewport, tiles: [tile({ x: 0, y: 0 }, [feature('P1', [square(30, 10, 50, 30)])]), tile({ x: 50, y: 0 }, [feature('P1', [square(0, 10, 20, 30)])])] });
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].rings.length, 1);
  assert.equal(Math.abs(vcgSignedArea(result.features[0].rings[0])), 800);
});

test('assemble: distinct features sharing a tile seam are not merged', () => {
  const result = vcgAssemble({ viewport, tiles: [tile({ x: 0, y: 0 }, [feature('P1', [square(30, 10, 50, 30)])]), tile({ x: 50, y: 0 }, [feature('P2', [square(0, 10, 20, 30)])])] });
  assert.equal(result.features.length, 2);
});

test('assemble: features without id are grouped by geometry fingerprint', () => {
  const result = vcgAssemble({ viewport, tiles: [tile({ x: 0, y: 0 }, [feature(null, [square(10, 10, 30, 30)])]), tile({ x: 50, y: 0 }, [feature(null, [square(-40, 10, -20, 30)])])] });
  assert.equal(result.features.length, 1, 'same shape in both tiles is the same parcel');
  assert.equal(result.counts.keyTiers.geometry, 2);
});

test('assemble: the same tile listing the same feature twice does not double its contour', () => {
  const result = vcgAssemble({ viewport, tiles: [tile({ x: 0, y: 0 }, [feature('P1', [square(10, 10, 30, 30)]), feature('P1', [square(10, 10, 30, 30)])])] });
  assert.equal(result.features.length, 1);
  assert.equal(result.features[0].rings.length, 1);
});

test('assemble: tiles and parcels outside the viewport are dropped but counted as cached', () => {
  const result = vcgAssemble({ viewport, tiles: [tile({ x: 0, y: 0 }, [feature('IN', [square(10, 10, 30, 30)]), feature('OUT', [square(60, 60, 70, 70)])]), tile({ x: 500, y: 500 }, [feature('FAR', [square(1, 1, 9, 9)])])] });
  assert.deepEqual(result.features.length, 1);
  assert.equal(result.counts.cachedFeatures, 3);
  assert.equal(result.counts.uniqueFeatures, 3);
  assert.equal(result.counts.visibleFeatures, 1);
});

test('assemble: a parcel cut by the viewport is clipped and counted as clipped; output stays inside the viewport', () => {
  const result = vcgAssemble({ viewport, tiles: [tile({ x: 60, y: 40 }, [feature('EDGE', [square(10, 10, 80, 80)])], 120)] });
  assert.equal(result.features.length, 1);
  assert.ok(inside(result.features[0].rings));
  assert.equal(result.counts.clippedFeatures, 1);
});

test('assemble: output carries no key, id or tile data', () => {
  const result = vcgAssemble({ viewport, tiles: [tile({ x: 0, y: 0 }, [feature('SECRET-IDU-123', [square(10, 10, 30, 30)])])] });
  const text = JSON.stringify(result);
  assert.equal(text.includes('SECRET'), false);
  assert.deepEqual(Object.keys(result.features[0]), ['rings']);
  assert.deepEqual(Object.keys(result).sort(), ['counts', 'features']);
});

test('assemble: parity fixture — adjacent tiles, crossing parcel, viewport-cut parcel, outside parcel and a hole', () => {
  const tiles = [
    tile({ x: 0, y: 0 }, [feature('A', [square(5, 5, 20, 20)]), feature('CROSS', [square(35, 25, 50, 40)]), feature('HOLE', [square(10, 30, 45, 48), square(20, 36, 30, 42).reverse()])]),
    tile({ x: 50, y: 0 }, [feature('CROSS', [square(0, 25, 15, 40)]), feature('CUT', [square(30, 5, 80, 20)])]),
    tile({ x: 0, y: 50 }, [feature('GONE', [square(5, 40, 20, 50)])]),
  ];
  const result = vcgAssemble({ viewport, tiles });
  assert.equal(result.features.length, 4, 'A, CROSS (merged), HOLE, CUT');
  assert.equal(result.counts.cachedFeatures, 6);
  assert.equal(result.counts.uniqueFeatures, 5);
  assert.equal(result.counts.visibleFeatures, 4);
  assert.equal(result.counts.duplicatesHandled, 1);
  assert.ok(result.features.every(f => inside(f.rings)));
  const cross = result.features.find(f => f.rings.length === 1 && Math.abs(vcgSignedArea(f.rings[0])) === 30 * 15);
  assert.ok(cross, 'CROSS fragments merged into a single 30x15 ring');
  assert.deepEqual(vcgAssemble({ viewport, tiles }), result, 'deterministic');
});
