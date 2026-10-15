import test from 'node:test';
import assert from 'node:assert/strict';
import loose from 'node:assert';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// MVP-07: the readiness barrier only reads tiles the page already owns. Everything below is synthetic.
async function load() {
  const context = vm.createContext({ console }); context.window = undefined;
  vm.runInContext((await readFile(new URL('../visible-capture-isolation.js', import.meta.url), 'utf8')).replace(/^export /gm, '') + '\n;globalThis.__x = { createBasemapReadiness, vciTileState, vciReadTiles, vciReadyMode };', context, { filename: 'visible-capture-isolation.js' });
  return context.__x;
}
const MAP = { left: 0, top: 0, width: 400, height: 300 };
// A tile <img>. `src` is a trap: assigning it would be a request made by the extension.
function tile({ complete = true, naturalWidth = 256, opacity = '', at = [10, 10], currentSrc = 'https://tiles.test/t.png' } = {}) {
  const node = { tagName: 'IMG', complete, naturalWidth, currentSrc, style: { opacity }, srcAssigned: false, getAttribute: name => (name === 'src' ? currentSrc : null), getBoundingClientRect: () => ({ left: at[0], top: at[1], width: 256, height: 256 }) };
  Object.defineProperty(node, 'src', { get: () => currentSrc, set() { node.srcAssigned = true; } });
  return node;
}
function container(tiles) { const listeners = new Map(); return { tiles, querySelectorAll: () => container.list(tiles), addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type), listeners, getBoundingClientRect: () => MAP, clientLeft: 0, clientTop: 0, clientWidth: 400, clientHeight: 300 }; }
container.list = tiles => [...tiles];
function scene({ basemapTiles = [], thematicTiles = [], signature = () => 'sig', noBasemap = false } = {}) {
  const base = container(basemapTiles); const thematic = container(thematicTiles);
  const timers = new Map(); let id = 0; let clock = 0;
  const targets = { container: base, basemap: noBasemap ? [] : [base], thematic: thematicTiles.length ? [thematic] : [], signature: () => signature() };
  const global = { MonTerritoireVisibleMapInspector: { captureTargets: () => targets }, setTimeout: (fn, ms) => { timers.set(++id, { fn, at: clock + ms }); return id; }, clearTimeout: handle => timers.delete(handle) };
  const advance = ms => { clock += ms; let fired = true; while (fired) { fired = false; for (const [handle, timer] of [...timers]) if (timer.at <= clock) { timers.delete(handle); timer.fn(); fired = true; } } };
  return { base, thematic, global, advance, now: () => clock, timers };
}
const settle = () => new Promise(resolve => setImmediate(resolve));
const counts = (visible, ready, loading, error) => ({ visible, ready, loading, error });

test('tile state: ready / loading / error from complete, naturalWidth and fade', async () => {
  const { vciTileState } = await load();
  assert.equal(vciTileState(tile()), 'ready');
  assert.equal(vciTileState(tile({ complete: false, naturalWidth: 0 })), 'loading');            // 8. present but img.complete false
  assert.equal(vciTileState(tile({ complete: true, naturalWidth: 0 })), 'error');               // 9. complete but nothing decoded
  assert.equal(vciTileState(tile({ complete: true, naturalWidth: 0, currentSrc: '' })), 'loading'); // no src yet: nothing requested
  assert.equal(vciTileState(tile({ opacity: '0.4' })), 'loading');                              // Leaflet fade-in in progress
  assert.equal(vciTileState(tile({ opacity: '1' })), 'ready');
});

test('tiles outside the map rectangle are ignored; thematic errors never block', async () => {
  const { vciReadTiles } = await load();
  const inside = tile(); const outsideLoading = tile({ complete: false, naturalWidth: 0, at: [900, 900] });
  loose.deepEqual(vciReadTiles({ basemap: [container([inside, outsideLoading])], thematic: [], rect: MAP }), counts(1, 1, 0, 0)); // 7
  const thematicError = tile({ naturalWidth: 0 }); const thematicLoading = tile({ complete: false, naturalWidth: 0 });
  loose.deepEqual(vciReadTiles({ basemap: [container([inside])], thematic: [container([thematicError, thematicLoading])], rect: MAP }), counts(2, 1, 1, 0));
});

test('all visible tiles ready → resolves at once, no timer left', async () => {
  const { createBasemapReadiness } = await load(); const s = scene({ basemapTiles: [tile(), tile({ at: [200, 10] })] });
  const fact = await createBasemapReadiness(s.global, { now: s.now }).wait('tx-1');       // 1
  assert.equal(fact.verdict, 'ready'); loose.deepEqual(fact.counts, counts(2, 2, 0, 0)); assert.equal(fact.waitMs, 0); assert.equal(fact.timedOut, false);
  assert.equal(s.timers.size, 0);
});

test('a loading tile becomes ready → waits passively, resolves on its load event', async () => {
  const { createBasemapReadiness } = await load(); const late = tile({ complete: false, naturalWidth: 0 }); const s = scene({ basemapTiles: [tile(), late] });
  let done = null; createBasemapReadiness(s.global, { now: s.now }).wait('tx-1').then(fact => { done = fact; });   // 2, 3
  await settle(); assert.equal(done, null);
  s.advance(250); await settle(); assert.equal(done, null);
  late.complete = true; late.naturalWidth = 256; s.base.listeners.get('load')(); s.advance(40); await settle();
  assert.equal(done.verdict, 'ready'); assert.ok(done.waitMs >= 250 && done.waitMs <= 400); assert.equal(late.srcAssigned, false);
});

test('several loading tiles: ready only when all are', async () => {
  const { createBasemapReadiness } = await load(); const a = tile({ complete: false, naturalWidth: 0 }); const b = tile({ complete: false, naturalWidth: 0, at: [200, 10] }); const fading = tile({ opacity: '0.2', at: [10, 150] });
  const s = scene({ basemapTiles: [a, b, fading] }); let done = null;
  createBasemapReadiness(s.global, { now: s.now }).wait('tx-1').then(fact => { done = fact; });                      // 4
  const finish = (t, opacity) => { t.complete = true; t.naturalWidth = 256; if (opacity) t.style.opacity = opacity; };
  finish(a); s.advance(150); await settle(); assert.equal(done, null);
  finish(b); s.advance(150); await settle(); assert.equal(done, null);                                                  // fading still counts
  finish(fading, '1'); s.advance(150); await settle(); assert.equal(done.verdict, 'ready');
});

test('timeout: bounded, reported, never waits forever', async () => {
  const { createBasemapReadiness } = await load(); const stuck = tile({ complete: false, naturalWidth: 0 }); const s = scene({ basemapTiles: [tile(), stuck] });
  let done = null; createBasemapReadiness(s.global, { now: s.now, timeoutMs: 4000 }).wait('tx-1').then(fact => { done = fact; }); // 5
  s.advance(3900); await settle(); assert.equal(done, null);
  s.advance(200); await settle();
  assert.equal(done.verdict, 'timeout'); assert.equal(done.timedOut, true); loose.deepEqual(done.counts, counts(2, 1, 1, 0)); assert.ok(done.waitMs >= 4000 && done.waitMs < 4500);
  assert.equal(s.timers.size, 0); assert.equal(s.base.listeners.size, 0);
});

test('tile in error → stops at once with an error verdict, no retry loop', async () => {
  const { createBasemapReadiness } = await load(); const broken = tile({ naturalWidth: 0 }); const s = scene({ basemapTiles: [tile(), broken] });
  const fact = await createBasemapReadiness(s.global, { now: s.now }).wait('tx-1');                                    // 6
  assert.equal(fact.verdict, 'error'); loose.deepEqual(fact.counts, counts(2, 1, 0, 1)); assert.equal(s.timers.size, 0); assert.equal(broken.srcAssigned, false);
});

test('the view changes while waiting → view-changed (no stale raster)', async () => {
  const { createBasemapReadiness } = await load(); let sig = 'a'; const s = scene({ basemapTiles: [tile({ complete: false, naturalWidth: 0 })], signature: () => sig });
  let done = null; createBasemapReadiness(s.global, { now: s.now }).wait('tx-1').then(fact => { done = fact; });          // 10
  s.advance(150); await settle(); assert.equal(done, null);
  sig = 'b'; s.advance(150); await settle();
  assert.equal(done.verdict, 'view-changed'); assert.equal(done.viewUnchanged, false);
});

test('check: immediate verdict, compares the view with the wait of the same transaction', async () => {
  const { createBasemapReadiness } = await load(); let sig = 'a'; const t = tile(); const s = scene({ basemapTiles: [t], signature: () => sig });
  const readiness = createBasemapReadiness(s.global, { now: s.now }); await readiness.wait('tx-1');
  assert.equal(readiness.check('tx-1').verdict, 'ready'); assert.equal(readiness.check('tx-1').viewUnchanged, true);
  assert.equal(readiness.check('tx-other').viewUnchanged, false);
  t.complete = false; t.naturalWidth = 0; assert.equal(readiness.check('tx-1').verdict, 'loading');
  sig = 'b'; assert.equal(readiness.check('tx-1').viewUnchanged, false);
});

test('no basemap / no tile evidence → unavailable or loading, never "ready"', async () => {
  const { createBasemapReadiness } = await load();
  assert.equal((await createBasemapReadiness(scene({ noBasemap: true }).global).wait('tx-1')).verdict, 'unavailable');
  const empty = scene({ basemapTiles: [] }); let done = null;
  createBasemapReadiness(empty.global, { now: empty.now, timeoutMs: 500 }).wait('tx-1').then(fact => { done = fact; });
  empty.advance(600); await settle(); assert.equal(done.verdict, 'timeout');
});

test('facts carry counters only and requests use a strict grammar', async () => {
  const { createBasemapReadiness, vciReadyMode } = await load(); const s = scene({ basemapTiles: [tile()] });
  const fact = await createBasemapReadiness(s.global, { now: s.now }).wait('tx-1');
  assert.deepEqual(Object.keys(fact).sort(), ['counts', 'mode', 'timedOut', 'transaction', 'type', 'verdict', 'viewUnchanged', 'waitMs']);
  assert.equal(JSON.stringify(fact).includes('tiles.test'), false);
  loose.deepEqual(vciReadyMode('wait:tx-1-abc'), { mode: 'wait', transaction: 'tx-1-abc' });
  assert.equal(vciReadyMode('refetch:tx-1'), null); assert.equal(vciReadyMode('wait:'), null); assert.equal(vciReadyMode({}), null);
});

test('the readiness code creates no request and sets no src', async () => {                                             // 11
  const source = await readFile(new URL('../visible-capture-isolation.js', import.meta.url), 'utf8');
  const part = source.slice(source.indexOf('MVP-07: basemap readiness barrier'));
  assert.equal(part.match(/fetch\s*\(|XMLHttpRequest|new Image|createElement|\.src\s*=|sendBeacon|WebSocket|decode\s*\(|getImageData|toDataURL|drawImage|crossOrigin/), null);
});
