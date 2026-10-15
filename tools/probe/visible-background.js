// MVP-04, MAIN world. The visible basemap, rebuilt ONLY from the tile images the page already loaded for display.
// It never requests, replays or re-fetches anything: a tile whose pixels the browser refuses to expose to a canvas
// (cross-origin without CORS) is reported as unreadable and the basemap is simply not embedded. Nothing is bypassed.
// Only counters and class names leave this file besides the composed viewport image: never a URL, a tile x/y or a coordinate.
const VBG_MAX_TILES = 512;
const VBG_MAX_PIXELS = 2 ** 25; // 33.5 Mpx: keeps the temporary canvas (and its PNG) in a sane memory range
const VBG_MAX_DATA_URI = 2 ** 26; // 64 Mi characters
const VBG_MIN_COVERAGE = 0.999; // share of the viewport the readable tiles must cover for the basemap to count as complete
const VBG_PANE_BASEMAP = /^(?:raster|tile|tilePane|basemap|base|fond)s?$/i;

// Data properties only for Leaflet objects: a page getter is never invoked.
function vbgGet(target, key) {
  try {
    for (let node = target, depth = 0; node && (typeof node === 'object' || typeof node === 'function') && depth < 8; depth++, node = Object.getPrototypeOf(node)) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
    }
  } catch {}
  return undefined;
}
// DOM elements expose native accessors (tagName, naturalWidth, complete, currentSrc): read them plainly.
function vbgDom(element, key) { try { return element[key]; } catch { return undefined; } }
function vbgKeys(target, limit) { try { return target && typeof target === 'object' ? Object.keys(target).slice(0, limit) : []; } catch { return []; } }
const vbgPoint = value => (value && Number.isFinite(value.x) && Number.isFinite(value.y) ? { x: value.x, y: value.y } : null);
const vbgRound = (value, places = 1000) => Math.round(value * places) / places;

// ---- placement: pure geometry -------------------------------------------------------------------------------
// rect: tile rectangle in viewport CSS pixels. Snapping both edges to the output grid keeps neighbours seamless.
// Returns the destination rectangle clipped to the canvas and the matching source rectangle, or null when invisible.
export function vbgTilePlacement(rect, ratio, canvasWidth, canvasHeight, natural) {
  const left = Math.round(rect.x * ratio); const right = Math.round((rect.x + rect.w) * ratio);
  const top = Math.round(rect.y * ratio); const bottom = Math.round((rect.y + rect.h) * ratio);
  const width = right - left; const height = bottom - top;
  if (!(width > 0) || !(height > 0)) return null;
  const dx = Math.max(0, left); const dy = Math.max(0, top); const dRight = Math.min(canvasWidth, right); const dBottom = Math.min(canvasHeight, bottom);
  if (dRight <= dx || dBottom <= dy) return null;
  return {
    dx, dy, dw: dRight - dx, dh: dBottom - dy,
    sx: (dx - left) / width * natural.width, sy: (dy - top) / height * natural.height,
    sw: (dRight - dx) / width * natural.width, sh: (dBottom - dy) / height * natural.height,
  };
}
function vbgIntersect(rect, width, height) {
  const x0 = Math.max(0, rect.x); const y0 = Math.max(0, rect.y); const x1 = Math.min(width, rect.x + rect.w); const y1 = Math.min(height, rect.y + rect.h);
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null;
}
// Output resolution: the source resolution when the tiles carry more pixels than they display (up to 2x), never an upsampling.
export function vbgPixelRatio(tiles, width, height) {
  let ratio = 1;
  for (const tile of tiles) if (tile.natural.width > 0 && tile.rect.w > 0) ratio = Math.max(ratio, tile.natural.width / tile.rect.w);
  ratio = Math.min(2, Math.max(1, Math.round(ratio * 2) / 2));
  while (ratio > 1 && Math.round(width * ratio) * Math.round(height * ratio) > VBG_MAX_PIXELS) ratio -= 0.5;
  return Math.round(width * ratio) * Math.round(height * ratio) > VBG_MAX_PIXELS ? 0 : ratio;
}

// ---- passive pixel access ---------------------------------------------------------------------------------
// Drawing an already decoded element into a canvas performs no request. If the browser marks the canvas as tainted the
// read below throws SecurityError: that tile is unreadable, and nothing tries to get around it.
export function vbgProbeReadable(element, createCanvas) {
  try {
    const canvas = createCanvas(1, 1); const context = canvas.getContext('2d');
    context.drawImage(element, 0, 0, 1, 1); context.getImageData(0, 0, 1, 1);
    return { readable: true };
  } catch (error) { return { readable: false, reason: error && error.name === 'SecurityError' ? 'cors' : 'other' }; }
}
function vbgElementKind(element) {
  const tag = String(vbgDom(element, 'tagName') || '').toUpperCase();
  if (tag === 'CANVAS') return { family: 'canvas-element', width: Number(vbgDom(element, 'width')) || 0, height: Number(vbgDom(element, 'height')) || 0, ready: true };
  if (tag !== 'IMG') return null;
  const src = String(vbgDom(element, 'currentSrc') || vbgDom(element, 'src') || '');
  const family = src.startsWith('data:') ? 'data-uri' : src.startsWith('blob:') ? 'blob' : 'image-element'; // scheme only; the source itself is never kept
  const width = Number(vbgDom(element, 'naturalWidth')) || 0; const height = Number(vbgDom(element, 'naturalHeight')) || 0;
  return { family, width, height, ready: vbgDom(element, 'complete') !== false && width > 0 && height > 0 };
}

// ---- tiles of one layer, in viewport pixels (same transform as the cadastre) ---------------------------------
function vbgLayerTiles(layer, view) {
  const cache = vbgGet(layer, '_tiles'); const tileZoom = vbgGet(layer, '_tileZoom');
  const size = vbgGet(layer, 'getTileSize') ? vbgCall(layer, 'getTileSize') : vbgGet(vbgGet(layer, 'options'), 'tileSize');
  const tileSize = vbgPoint(size) || (Number.isFinite(size) ? { x: size, y: size } : { x: 256, y: 256 });
  const out = { cached: vbgKeys(cache, 1e6).length, tileZoom: Number.isFinite(tileZoom) ? tileZoom : null, tileSize, scale: null, tiles: [] };
  if (out.tileZoom === null || !(tileSize.x > 0) || !(tileSize.y > 0)) return out;
  const scale = view.zoomScale(out.tileZoom); if (!Number.isFinite(scale) || scale <= 0) return out;
  out.scale = scale;
  for (const key of vbgKeys(cache, VBG_MAX_TILES)) {
    const entry = vbgGet(cache, key); const coords = vbgGet(entry, 'coords'); const element = vbgGet(entry, 'el');
    if (!coords || coords.z !== out.tileZoom || !Number.isFinite(coords.x) || !Number.isFinite(coords.y) || !element) continue; // tiles kept from another zoom level are not on screen
    const origin = view.toContainer({ x: coords.x * tileSize.x * scale - view.pixelOrigin.x, y: coords.y * tileSize.y * scale - view.pixelOrigin.y });
    if (!origin) return { ...out, tiles: [], broken: true };
    out.tiles.push({ element, rect: { x: origin.x, y: origin.y, w: tileSize.x * scale, h: tileSize.y * scale } });
  }
  return out;
}
function vbgCall(target, name) { const fn = vbgGet(target, name); if (typeof fn !== 'function') return undefined; try { return fn.call(target); } catch { return undefined; } }

function vbgPaneZ(layer) { try { const value = Number(layer.getPane?.()?.style?.zIndex); return Number.isFinite(value) ? value : null; } catch { return null; } }

// ---- basemap identification ----------------------------------------------------------------------------------
// candidates: [{ layer, record }] where record.kind === 'raster' (a plain TileLayer: WMS, VectorGrid and masks are classified elsewhere).
// Being raster is not enough: the layer must hold decoded tile elements for the current zoom, and it must be the lowest raster.
export function vbgIdentify(candidates, view) {
  const found = [];
  for (const { layer, record } of candidates) {
    if (record.kind !== 'raster') continue;
    const inspected = vbgLayerTiles(layer, view);
    const elements = inspected.tiles.filter(tile => vbgElementKind(tile.element));
    if (!elements.length) continue; // no tile image in its cache: nothing structural proves it is a displayed basemap
    const evidence = ['class:TileLayer', 'tile-cache:images'];
    if (record.pane && VBG_PANE_BASEMAP.test(record.pane)) evidence.push('pane:basemap-like');
    if (!vbgGet(layer, 'wmsParams')) evidence.push('not-wms');
    const zIndex = Number.isFinite(record.zIndex) ? record.zIndex : 0; const paneZ = vbgPaneZ(layer);
    found.push({ layer, record, inspected, evidence, order: [paneZ ?? 0, zIndex], strongClass: record.confidence === 'high' });
  }
  if (!found.length) return { status: 'not-found', confidence: 'low', evidence: ['no-raster-layer-with-tile-images'], chosen: null };
  found.sort((a, b) => a.order[0] - b.order[0] || a.order[1] - b.order[1]);
  if (found.length > 1 && found[0].order[0] === found[1].order[0] && found[0].order[1] === found[1].order[1]) return { status: 'ambiguous', confidence: 'low', evidence: ['several-raster-layers-same-order'], chosen: null };
  const chosen = found[0];
  const unique = found.length === 1;
  chosen.evidence.push(unique ? 'single-raster-layer' : 'lowest-raster-layer');
  const confidence = unique && chosen.strongClass && chosen.evidence.includes('pane:basemap-like') ? 'high' : chosen.strongClass ? 'medium' : 'low';
  return { status: 'found', confidence, evidence: chosen.evidence, chosen };
}

// ---- composition -------------------------------------------------------------------------------------------
export function vbgCompose({ width, height, tiles, ratio, createCanvas }) {
  const pixelWidth = Math.round(width * ratio); const pixelHeight = Math.round(height * ratio);
  const canvas = createCanvas(pixelWidth, pixelHeight); const context = canvas.getContext('2d');
  for (const tile of tiles) {
    const placement = vbgTilePlacement(tile.rect, ratio, pixelWidth, pixelHeight, tile.natural);
    if (placement) context.drawImage(tile.element, placement.sx, placement.sy, placement.sw, placement.sh, placement.dx, placement.dy, placement.dw, placement.dh);
  }
  const dataUri = canvas.toDataURL('image/png'); // lossless; throws only if a tainted tile slipped through, which is caught by the caller
  return { dataUri, pixelWidth, pixelHeight };
}

const VBG_NONE_TILES = { cached: 0, intersecting: 0, readable: 0, unreadable: 0, completeness: 'none', methods: {} };
function vbgUnavailable(reason, candidate, tiles = VBG_NONE_TILES, extra = {}) {
  return { status: 'unavailable', reason, candidate, tiles, composition: { method: 'none' }, ...extra };
}

// view: { size:{x,y}, zoomScale(tileZoom), pixelOrigin, toContainer(point), mapZoom }, built by the inspector from the same
// Leaflet primitives as the cadastre, so that background, cadastre and selection share one frame.
// mode 'status' probes readability only; mode 'export' also composes the image.
export function vbgCapture({ candidates, view, createCanvas, mode = 'status' }) {
  const identified = vbgIdentify(candidates, view);
  const emptyCandidate = { status: identified.status, kind: 'none', confidence: identified.confidence, evidence: identified.evidence, tileCount: 0, imageAccess: 'unavailable' };
  if (!identified.chosen) return vbgUnavailable(identified.status === 'ambiguous' ? 'ambiguous' : 'no-candidate', emptyCandidate);
  const { inspected, record } = identified.chosen;
  const width = view.size.x; const height = view.size.y;
  const tiles = inspected.tiles.map(tile => ({ ...tile, visible: vbgIntersect(tile.rect, width, height) })).filter(tile => tile.visible);
  const methods = {}; const readable = []; let cors = 0; let unreadable = 0;
  for (const tile of tiles) {
    const kind = vbgElementKind(tile.element);
    if (!kind || !kind.ready) { unreadable++; continue; }
    const probe = vbgProbeReadable(tile.element, createCanvas);
    if (!probe.readable) { unreadable++; if (probe.reason === 'cors') cors++; continue; }
    methods[kind.family] = (methods[kind.family] || 0) + 1;
    readable.push({ element: tile.element, rect: tile.rect, natural: { width: kind.width, height: kind.height }, visible: tile.visible });
  }
  const seen = new Set(); let covered = 0;
  for (const tile of readable) { const id = `${tile.rect.x.toFixed(2)},${tile.rect.y.toFixed(2)}`; if (seen.has(id)) continue; seen.add(id); covered += (tile.visible.x1 - tile.visible.x0) * (tile.visible.y1 - tile.visible.y0); }
  const complete = tiles.length > 0 && unreadable === 0 && covered >= VBG_MIN_COVERAGE * width * height;
  const imageAccess = !tiles.length ? 'unavailable' : readable.length === tiles.length ? 'readable' : readable.length === 0 ? (cors > 0 ? 'unavailable-cors' : 'unavailable') : 'partially-readable';
  const candidate = {
    status: 'found', kind: 'raster', confidence: identified.confidence, evidence: identified.evidence, tileCount: inspected.cached,
    tileSize: { width: inspected.tileSize.x, height: inspected.tileSize.y }, ...(Number.isFinite(view.mapZoom) ? { zoom: vbgRound(view.mapZoom, 100) } : {}), imageAccess,
  };
  const stats = { cached: inspected.cached, intersecting: tiles.length, readable: readable.length, unreadable, completeness: !tiles.length ? 'none' : complete ? 'complete' : 'incomplete', methods };
  if (!tiles.length) return vbgUnavailable('no-tiles', candidate, stats);
  // Partially readable = not embedded: a holed background is never presented as a complete one.
  if (!complete) return vbgUnavailable(readable.length ? 'incomplete' : cors > 0 ? 'cors' : unreadable ? 'unreadable' : 'incomplete', candidate, stats);
  if (mode !== 'export') return { status: 'embeddable', candidate, tiles: stats, composition: { method: 'canvas-2d-drawImage' } };
  const ratio = vbgPixelRatio(readable, width, height);
  if (!ratio) return vbgUnavailable('too-large', candidate, stats);
  try {
    const image = vbgCompose({ width, height, tiles: readable, ratio, createCanvas });
    if (image.dataUri.length > VBG_MAX_DATA_URI || !image.dataUri.startsWith('data:image/png;base64,')) return vbgUnavailable('too-large', candidate, stats);
    return { status: 'embedded', image, candidate, tiles: stats, composition: { method: 'canvas-2d-drawImage', pixelWidth: image.pixelWidth, pixelHeight: image.pixelHeight, pixelRatio: ratio } };
  } catch { return vbgUnavailable('canvas-error', candidate, stats); }
}

if (typeof window !== 'undefined') globalThis.MonTerritoireVisibleBackground = { vbgCapture, vbgIdentify, vbgCompose, vbgTilePlacement, vbgPixelRatio, vbgProbeReadable };
