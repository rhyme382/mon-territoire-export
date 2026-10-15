// MVP-03B, MAIN world. Pure geometry: tile-local pixel parts -> viewport pixels, rectangle clipping,
// fragment merging and de-duplication. No DOM, no Leaflet, no network. Feature keys (ids, cadastral
// values) enter vcgAssemble as opaque strings, are used to group fragments and never leave it.
const VCG_EPS = 0.15; // px: tolerance when matching the two sides of a tile seam
const VCG_AXIS = 1e-6;
const VCG_COLLINEAR = 0.05; // px
const VCG_MAX_MERGE_EDGES = 5_000;

export function vcgSignedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) { const [x1, y1] = ring[i]; const [x2, y2] = ring[(i + 1) % ring.length]; sum += x1 * y2 - x2 * y1; }
  return sum / 2;
}
const vcgPoint = p => {
  if (Array.isArray(p) && p.length >= 2 && typeof p[0] === 'number' && typeof p[1] === 'number') return Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [p[0], p[1]] : null;
  if (p && typeof p === 'object' && typeof p.x === 'number' && typeof p.y === 'number') return Number.isFinite(p.x) && Number.isFinite(p.y) ? [p.x, p.y] : null;
  return null;
};
const vcgIsPoint = p => Array.isArray(p) ? typeof p[0] === 'number' : Boolean(p) && typeof p === 'object' && 'x' in p && 'y' in p;

// Leaflet `_parts` is a list of rings of {x,y} points (a flat evenodd compound); nested lists (MultiPolygon-like) are flattened.
export function vcgNormalizeParts(parts, depth = 0) {
  if (!Array.isArray(parts) || depth > 4) return [];
  if (parts.length && parts.every(vcgIsPoint)) {
    const ring = parts.map(vcgPoint);
    if (ring.some(p => !p)) return [];
    if (ring.length > 1 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]) ring.pop();
    return ring.length >= 3 ? [ring] : [];
  }
  return parts.flatMap(item => vcgNormalizeParts(item, depth + 1));
}

export function vcgTileToViewport(rings, origin, scale) {
  return rings.map(ring => ring.map(([x, y]) => [origin.x + x * scale, origin.y + y * scale]));
}

// Sutherland-Hodgman against an axis-aligned rectangle. Orientation is preserved; vertices created on an edge get that edge's exact coordinate.
export function vcgClipRing(ring, rect) {
  const sides = [
    { inside: p => p[0] >= rect.minX, cut: (a, b) => [rect.minX, a[1] + (b[1] - a[1]) * (rect.minX - a[0]) / (b[0] - a[0])] },
    { inside: p => p[0] <= rect.maxX, cut: (a, b) => [rect.maxX, a[1] + (b[1] - a[1]) * (rect.maxX - a[0]) / (b[0] - a[0])] },
    { inside: p => p[1] >= rect.minY, cut: (a, b) => [a[0] + (b[0] - a[0]) * (rect.minY - a[1]) / (b[1] - a[1]), rect.minY] },
    { inside: p => p[1] <= rect.maxY, cut: (a, b) => [a[0] + (b[0] - a[0]) * (rect.maxY - a[1]) / (b[1] - a[1]), rect.maxY] },
  ];
  let output = ring;
  for (const side of sides) {
    const input = output; output = [];
    for (let i = 0; i < input.length; i++) {
      const current = input[i]; const previous = input[(i + input.length - 1) % input.length];
      const currentIn = side.inside(current); const previousIn = side.inside(previous);
      if (currentIn) { if (!previousIn) output.push(side.cut(previous, current)); output.push(current); }
      else if (previousIn) output.push(side.cut(previous, current));
    }
    if (!output.length) return null;
  }
  const clean = output.filter((p, i) => { const q = output[(i + 1) % output.length]; return p[0] !== q[0] || p[1] !== q[1]; });
  return clean.length >= 3 && Math.abs(vcgSignedArea(clean)) > 1e-9 ? clean : null;
}
export function vcgClipRings(rings, rect) { return rings.map(ring => vcgClipRing(ring, rect)).filter(Boolean); }

function vcgBounds(rings) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const ring of rings) for (const [x, y] of ring) { if (x < b.minX) b.minX = x; if (x > b.maxX) b.maxX = x; if (y < b.minY) b.minY = y; if (y > b.maxY) b.maxY = y; }
  return b;
}
const vcgIntersects = (a, b) => a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
const vcgIntersection = (a, b) => { const r = { minX: Math.max(a.minX, b.minX), minY: Math.max(a.minY, b.minY), maxX: Math.min(a.maxX, b.maxX), maxY: Math.min(a.maxY, b.maxY) }; return r.minX < r.maxX && r.minY < r.maxY ? r : null; };
const vcgWithin = (inner, outer) => inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY;

// Deterministic, rotation-invariant hash of a set of rings (0.1 px grid). Used as an in-memory key only.
export function vcgFingerprint(rings) {
  const parts = rings.map(ring => {
    const q = ring.map(([x, y]) => [Math.round(x * 10), Math.round(y * 10)]);
    let start = 0; for (let i = 1; i < q.length; i++) if (q[i][0] < q[start][0] || (q[i][0] === q[start][0] && q[i][1] < q[start][1])) start = i;
    return q.slice(start).concat(q.slice(0, start)).map(p => p.join(',')).join(';');
  }).sort().join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) { hash ^= parts.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return `${hash.toString(16)}.${parts.length}`;
}

// --- fragment merging: remove the cut edges two tiles share, relink what remains into rings.
// Parts of `edge` outside the shared interval [lo, hi] along its axis; direction is kept.
function vcgSplitEdge(edge, lo, hi, axis) {
  const along = axis === 'x' ? 1 : 0; // vertical edges run along y
  const forward = edge.b[along] >= edge.a[along];
  const min = Math.min(edge.a[along], edge.b[along]); const max = Math.max(edge.a[along], edge.b[along]);
  const pieces = [];
  for (const [from, to] of [[min, lo], [hi, max]]) {
    if (to - from <= VCG_EPS) continue;
    const start = edge.a.slice(); const end = edge.b.slice();
    start[along] = forward ? from : to; end[along] = forward ? to : from;
    pieces.push({ a: start, b: end });
  }
  return pieces;
}
function vcgAxisOf(edge) { if (Math.abs(edge.a[0] - edge.b[0]) <= VCG_AXIS) return 'x'; if (Math.abs(edge.a[1] - edge.b[1]) <= VCG_AXIS) return 'y'; return null; }
function vcgCancelSeams(edges) {
  let changed = false;
  for (let guard = 0; guard < VCG_MAX_MERGE_EDGES; guard++) {
    let hit = null;
    search: for (let i = 0; i < edges.length; i++) {
      const axis = vcgAxisOf(edges[i]); if (!axis) continue;
      const line = axis === 'x' ? 0 : 1; const along = 1 - line;
      for (let j = i + 1; j < edges.length; j++) {
        if (vcgAxisOf(edges[j]) !== axis || Math.abs(edges[i].a[line] - edges[j].a[line]) > VCG_EPS) continue;
        if ((edges[i].b[along] - edges[i].a[along]) * (edges[j].b[along] - edges[j].a[along]) >= 0) continue; // must be opposite
        const lo = Math.max(Math.min(edges[i].a[along], edges[i].b[along]), Math.min(edges[j].a[along], edges[j].b[along]));
        const hi = Math.min(Math.max(edges[i].a[along], edges[i].b[along]), Math.max(edges[j].a[along], edges[j].b[along]));
        if (hi - lo > VCG_EPS) { hit = { i, j, lo, hi, axis }; break search; }
      }
    }
    if (!hit) break;
    const { i, j, lo, hi, axis } = hit; changed = true;
    const rest = [...vcgSplitEdge(edges[i], lo, hi, axis), ...vcgSplitEdge(edges[j], lo, hi, axis)];
    edges.splice(j, 1); edges.splice(i, 1); edges.push(...rest);
  }
  return changed;
}
function vcgSimplifyRing(ring) {
  let points = ring.slice(); let again = true;
  while (again && points.length >= 3) {
    again = false;
    for (let i = 0; i < points.length; i++) {
      const prev = points[(i + points.length - 1) % points.length]; const cur = points[i]; const next = points[(i + 1) % points.length];
      const length = Math.hypot(next[0] - prev[0], next[1] - prev[1]);
      const distance = length === 0 ? Math.hypot(cur[0] - prev[0], cur[1] - prev[1]) : Math.abs((next[0] - prev[0]) * (prev[1] - cur[1]) - (prev[0] - cur[0]) * (next[1] - prev[1])) / length;
      if (distance <= VCG_COLLINEAR) { points.splice(i, 1); again = true; break; }
    }
  }
  return points.length >= 3 ? points : null;
}
function vcgLink(edges) {
  const used = new Array(edges.length).fill(false); const rings = [];
  const close = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= VCG_EPS;
  for (let s = 0; s < edges.length; s++) {
    if (used[s]) continue;
    used[s] = true; const points = [edges[s].a]; let current = edges[s];
    for (let guard = 0; ; guard++) {
      if (guard > edges.length) return null;
      if (close(current.b, edges[s].a)) break;
      let best = -1; let bestDistance = Infinity;
      for (let k = 0; k < edges.length; k++) { if (used[k]) continue; const d = Math.hypot(edges[k].a[0] - current.b[0], edges[k].a[1] - current.b[1]); if (d <= VCG_EPS && d < bestDistance) { best = k; bestDistance = d; } }
      if (best < 0) return null;
      used[best] = true; points.push(edges[best].a); current = edges[best];
    }
    const ring = vcgSimplifyRing(points); if (ring) rings.push(ring);
  }
  return rings;
}
// fragments: array of ring lists (one per tile). Falls back to the untouched rings whenever relinking is not provably clean.
export function vcgMergeFragments(fragments) {
  const all = fragments.flat();
  if (fragments.length < 2) return all;
  const edges = all.flatMap(ring => ring.map((p, i) => ({ a: p, b: ring[(i + 1) % ring.length] })));
  if (edges.length > VCG_MAX_MERGE_EDGES) return all;
  if (!vcgCancelSeams(edges)) return all;
  const linked = vcgLink(edges);
  return linked && linked.length ? linked : all;
}

const vcgRound = value => Math.round(value * 100) / 100;

// tiles: [{ origin:{x,y}, tileSize:{x,y}, scale, features:[{ key:{tier,value}|null, rings }] }] with rings in tile-local pixels.
export function vcgAssemble({ viewport, tiles }) {
  const rect = { minX: 0, minY: 0, maxX: viewport.width, maxY: viewport.height };
  const groups = new Map();
  const counts = { cachedFeatures: 0, uniqueFeatures: 0, visibleFeatures: 0, exportedPaths: 0, clippedFeatures: 0, duplicatesHandled: 0, keyTiers: { id: 0, property: 0, geometry: 0 } };
  for (const tile of tiles) {
    const tileRect = { minX: tile.origin.x, minY: tile.origin.y, maxX: tile.origin.x + tile.tileSize.x * tile.scale, maxY: tile.origin.y + tile.tileSize.y * tile.scale };
    const visible = vcgIntersection(tileRect, rect);
    const seen = new Set();
    for (const feature of tile.features) {
      counts.cachedFeatures++;
      const raw = vcgTileToViewport(feature.rings, tile.origin, tile.scale);
      const fingerprint = vcgFingerprint(raw);
      const tier = feature.key ? feature.key.tier : 'geometry';
      counts.keyTiers[tier]++;
      const key = feature.key ? `${tier}:${feature.key.value}` : `geometry:${fingerprint}`;
      let group = groups.get(key); if (!group) groups.set(key, group = { fragments: [], clipped: false });
      const identity = `${key}|${fingerprint}`;
      if (seen.has(identity)) { counts.duplicatesHandled++; continue; }
      seen.add(identity);
      if (!visible || !raw.length) continue;
      const bounds = vcgBounds(raw);
      if (!vcgIntersects(bounds, visible)) continue;
      const rings = vcgClipRings(raw, visible);
      if (!rings.length) continue;
      group.fragments.push(rings);
      if (!vcgWithin(bounds, rect)) group.clipped = true;
    }
  }
  counts.uniqueFeatures = groups.size;
  const features = [];
  for (const group of groups.values()) {
    if (!group.fragments.length) continue;
    const rings = vcgMergeFragments(group.fragments).map(ring => ring.map(([x, y]) => [vcgRound(x), vcgRound(y)])).filter(ring => ring.length >= 3);
    if (!rings.length) continue;
    features.push({ rings });
    counts.duplicatesHandled += group.fragments.length - 1;
    if (group.clipped) counts.clippedFeatures++;
  }
  counts.visibleFeatures = features.length; counts.exportedPaths = features.length;
  return { features, counts };
}

// MVP-03C: objects already projected into viewport pixels (Leaflet path layers). items: [{ key:{tier,value}|null, rings }].
// Same key + same geometry = the same parcel held twice (dropped); same key + different geometry = complementary fragments (kept together).
export function vcgAssemblePaths({ viewport, items }) {
  const rect = { minX: 0, minY: 0, maxX: viewport.width, maxY: viewport.height };
  const groups = new Map(); const seen = new Set();
  const counts = { candidatePolygons: 0, selectedFeaturesDetected: 0, selectedFeaturesVisible: 0, selectedPathsExported: 0, selectedFeaturesClipped: 0, duplicatesHandled: 0, keyTiers: { id: 0, property: 0, geometry: 0 } };
  for (const item of items) {
    counts.candidatePolygons++;
    if (!item.rings.length) continue;
    const fingerprint = vcgFingerprint(item.rings);
    const tier = item.key ? item.key.tier : 'geometry';
    const key = item.key ? `${tier}:${item.key.value}` : `geometry:${fingerprint}`;
    let group = groups.get(key); if (!group) { groups.set(key, group = { fragments: [], clipped: false }); counts.keyTiers[tier]++; }
    const identity = `${key}|${fingerprint}`;
    if (seen.has(identity)) { counts.duplicatesHandled++; continue; }
    seen.add(identity);
    const bounds = vcgBounds(item.rings);
    if (!vcgIntersects(bounds, rect)) continue;
    const rings = vcgClipRings(item.rings, rect);
    if (!rings.length) continue;
    group.fragments.push(rings);
    if (!vcgWithin(bounds, rect)) group.clipped = true;
  }
  counts.selectedFeaturesDetected = groups.size;
  const features = [];
  for (const group of groups.values()) {
    if (!group.fragments.length) continue;
    const rings = group.fragments.flat().map(ring => ring.map(([x, y]) => [vcgRound(x), vcgRound(y)])).filter(ring => ring.length >= 3);
    if (!rings.length) continue;
    features.push({ rings });
    if (group.clipped) counts.selectedFeaturesClipped++;
  }
  counts.selectedFeaturesVisible = features.length; counts.selectedPathsExported = features.length;
  return { features, counts };
}

// ---- MVP-05A: individual selected parcels. The aggregate selection polygon is the PROOF of which cadastre features are selected;
// the geometry itself comes from the cadastre tiles (same engine as vcgAssemble), one object per feature.
const VCG_PROBE_TOLERANCE = 1; // px: narrower chords are not trusted as interior points
const VCG_COVERAGE_MIN = 0.95;
const VCG_BOUNDARY_BAND = 1.5; // px: the MVT tile and the projected GeoJSON never agree to the pixel; samples this close to the aggregate outline are not judged
const VCG_MIN_FRAGMENT_AREA = 4; // px²: a seam or buffer sliver does not decide whether a parcel belongs to the selection
const VCG_MAX_SAMPLES = 2_500;

// Even-odd point-in-rings test (holes included).
export function vcgPointInRings(point, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i]; const [xj, yj] = ring[j];
      if ((yi > point[1]) !== (yj > point[1]) && point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}
// A point inside the feature (holes respected): the middle of the widest even-odd chord of a horizontal scanline through its bounding box.
export function vcgInteriorPoint(rings) {
  const b = vcgBounds(rings); let best = null;
  for (const fraction of [0.5, 0.35, 0.65, 0.2, 0.8]) {
    const y = b.minY + (b.maxY - b.minY) * fraction; const xs = [];
    for (const ring of rings) for (let i = 0; i < ring.length; i++) {
      const [x1, y1] = ring[i]; const [x2, y2] = ring[(i + 1) % ring.length];
      if ((y1 > y) !== (y2 > y)) xs.push(x1 + (y - y1) * (x2 - x1) / (y2 - y1));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) if (!best || xs[k + 1] - xs[k] > best.width) best = { width: xs[k + 1] - xs[k], point: [(xs[k] + xs[k + 1]) / 2, y] };
    if (best && best.width > VCG_PROBE_TOLERANCE * 2) break;
  }
  return best ? best.point : null;
}
// aggregate: one ring list per selection polygon (each evenodd, holes included); the selection is their union.
const vcgInAggregate = (point, aggregate) => aggregate.some(rings => vcgPointInRings(point, rings));
export function vcgDistanceToRings(point, rings) {
  let best = Infinity;
  for (const ring of rings) for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i]; const [x2, y2] = ring[(i + 1) % ring.length]; const dx = x2 - x1; const dy = y2 - y1; const length2 = dx * dx + dy * dy;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((point[0] - x1) * dx + (point[1] - y1) * dy) / length2));
    best = Math.min(best, Math.hypot(point[0] - (x1 + t * dx), point[1] - (y1 + t * dy)));
  }
  return best;
}
const vcgNearAggregate = (point, aggregate, distance) => aggregate.some(rings => vcgDistanceToRings(point, rings) <= distance);
function vcgProbesInside(featureRings, aggregate) {
  const point = featureRings.length ? vcgInteriorPoint(featureRings) : null;
  return Boolean(point) && (vcgInAggregate(point, aggregate) || vcgNearAggregate(point, aggregate, VCG_PROBE_TOLERANCE));
}
function vcgCoverage(aggregate, selectedRings, viewport) {
  const rect = { minX: 0, minY: 0, maxX: viewport.width, maxY: viewport.height };
  const bounds = vcgIntersection(vcgBounds(aggregate.flat()), rect); if (!bounds) return null;
  const step = Math.max(1, Math.sqrt(((bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY)) / VCG_MAX_SAMPLES));
  const boxes = selectedRings.map(rings => ({ rings, box: vcgBounds(rings) }));
  let total = 0; let covered = 0;
  for (let y = bounds.minY + step / 2; y < bounds.maxY; y += step) for (let x = bounds.minX + step / 2; x < bounds.maxX; x += step) {
    if (!vcgInAggregate([x, y], aggregate) || vcgNearAggregate([x, y], aggregate, VCG_BOUNDARY_BAND)) continue;
    total++;
    if (boxes.some(({ rings, box }) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && vcgPointInRings([x, y], rings))) covered++;
  }
  return total ? covered / total : null;
}

// The biggest fragment (by bounding box) speaks for the parcel; slivers under a few px² are ignored unless nothing else exists.
function vcgDecisiveFragment(fragments) {
  const sized = fragments.map(rings => { const b = vcgBounds(rings); return { rings, area: (b.maxX - b.minX) * (b.maxY - b.minY) }; });
  const solid = sized.filter(item => item.area >= VCG_MIN_FRAGMENT_AREA);
  return (solid.length ? solid : sized).reduce((best, item) => (!best || item.area > best.area ? item : best), null)?.rings || [];
}
const VCG_NO_INDIVIDUAL = { features: [], counts: null };
// tiles: as vcgAssemble, each feature { key:{tier:'id',value}, rings, group } where `group` is the opaque style class of the VectorGrid override.
// aggregate: unclipped viewport ring lists, one per aggregate selection polygon, or null. basis: 'ab-delta' | 'all-overrides'.
// Returns { features, counts, individual } where `individual` is the closed-vocabulary report; features is empty when the evidence is insufficient.
export function vcgSelectIndividual({ viewport, tiles, aggregate, basis, overrideCount, candidateCount = overrideCount, unmatchedCount = 0, collisions = 0 }) {
  const report = (source, confidence, extra) => ({ source, confidence, basis, overrideCount, matchedFeatures: 0, uniqueGeometries: 0, exportedObjects: 0, unmatchedFeatures: unmatchedCount, styleGroups: 0, coverage: null, fallbackReason: 'none', evidence: [], ...extra });
  const fallback = (reason, extra = {}) => ({ ...VCG_NO_INDIVIDUAL, individual: report('none', 'low', { fallbackReason: reason, ...extra }) });
  if (!candidateCount) return fallback(overrideCount ? 'no-new-overrides' : 'no-overrides');
  if (!(aggregate && aggregate.length) && basis !== 'ab-delta') return fallback('no-selection-evidence');
  if (collisions > 0) return fallback('id-layer-collision');
  const probes = new Map(); // key -> { group, rings: [raw viewport rings per fragment] }
  for (const tile of tiles) for (const feature of tile.features) {
    const id = feature.key.value; if (!probes.has(id)) probes.set(id, { group: feature.group, fragments: [] });
    probes.get(id).fragments.push(vcgTileToViewport(feature.rings, tile.origin, tile.scale));
  }
  if (!probes.size) return fallback('no-matching-features');
  const evidence = [basis === 'ab-delta' ? 'override-keys-new-since-A' : 'all-override-keys'];
  let selectedIds;
  let coverage = null;
  if (aggregate && aggregate.length) {
    selectedIds = [...probes].filter(([, entry]) => vcgProbesInside(vcgDecisiveFragment(entry.fragments), aggregate)).map(([id]) => id);
    evidence.push('aggregate-geometry-membership');
    if (!selectedIds.length) return fallback('geometry-disagreement', { matchedFeatures: probes.size, evidence });
    const subset = selectedIds.flatMap(id => probes.get(id).fragments);
    coverage = vcgCoverage(aggregate, subset, viewport);
    if (coverage === null || coverage < VCG_COVERAGE_MIN) return fallback('incomplete-coverage', { matchedFeatures: probes.size, coverage: coverage === null ? null : Math.round(coverage * 1000) / 1000, evidence });
    if (selectedIds.length < probes.size) evidence.push('overrides-outside-selection-excluded');
  } else if (basis === 'ab-delta') {
    selectedIds = [...probes.keys()]; evidence.push('no-aggregate-geometry');
  } else return fallback('no-selection-evidence', { matchedFeatures: probes.size, evidence });
  const chosen = new Set(selectedIds);
  const groups = new Set(selectedIds.map(id => probes.get(id).group));
  if (groups.size > 1) return fallback('ambiguous-style-groups', { matchedFeatures: probes.size, styleGroups: groups.size, evidence });
  const selectedTiles = tiles.map(tile => ({ ...tile, features: tile.features.filter(feature => chosen.has(feature.key.value)) }));
  const { features, counts } = vcgAssemble({ viewport, tiles: selectedTiles });
  if (!features.length) return fallback('no-matching-features', { matchedFeatures: probes.size, evidence });
  features.sort((a, b) => { const p = vcgBounds(a.rings); const q = vcgBounds(b.rings); return p.minY - q.minY || p.minX - q.minX || vcgFingerprint(a.rings).localeCompare(vcgFingerprint(b.rings)); });
  const confidence = aggregate && aggregate.length && selectedIds.length === probes.size ? 'high' : 'medium';
  return {
    features, counts,
    individual: report('vectorgrid-overrides', confidence, { matchedFeatures: probes.size, uniqueGeometries: new Set(features.map(feature => vcgFingerprint(feature.rings))).size, exportedObjects: features.length, styleGroups: groups.size, coverage: coverage === null ? null : Math.round(coverage * 1000) / 1000, evidence }),
  };
}

if (typeof window !== 'undefined') globalThis.MonTerritoireVisibleCadastreGeometry = { vcgNormalizeParts, vcgTileToViewport, vcgClipRing, vcgClipRings, vcgFingerprint, vcgMergeFragments, vcgAssemble, vcgAssemblePaths, vcgSignedArea, vcgSelectIndividual, vcgPointInRings, vcgInteriorPoint, vcgDistanceToRings };
