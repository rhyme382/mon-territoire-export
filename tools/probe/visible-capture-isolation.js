// MVP-06, MAIN world. Purely visual, local and reversible preparation of the page for a rendered-basemap capture.
// It only overrides `visibility` of DOM elements (no layout change, so the map rectangle stays put) and puts the exact
// previous inline value back. It never calls application code: selection, layers, basemap and authorizations are untouched.
// Two safety nets guarantee the restoration: the isolated world asks for it in a `finally`, and a watchdog does it anyway.
const VCI_WATCHDOG_MS = 3000;
const VCI_PROPERTY = 'visibility';

// Records what is needed to put one element back exactly: the previous value and priority of the property and whether the
// inline style attribute existed at all.
export function vciHide(elements) {
  const records = [];
  try {
    for (const element of elements) {
      const style = element?.style; if (!style || typeof style.setProperty !== 'function') continue;
      if (records.some(record => record.element === element)) continue;
      records.push({ element, hadAttribute: element.hasAttribute('style'), value: style.getPropertyValue(VCI_PROPERTY), priority: style.getPropertyPriority(VCI_PROPERTY) });
      style.setProperty(VCI_PROPERTY, 'hidden', 'important');
    }
  } catch (error) { vciRestore(records); throw error; }
  return records;
}
// Idempotent: a record is consumed once restored.
export function vciRestore(records) {
  let failures = 0;
  for (const record of records.splice(0)) {
    try {
      const { element, hadAttribute, value, priority } = record;
      if (value) element.style.setProperty(VCI_PROPERTY, value, priority); else element.style.removeProperty(VCI_PROPERTY);
      if (!hadAttribute && !element.getAttribute('style')) element.removeAttribute('style');
    } catch { failures++; }
  }
  return failures === 0;
}


// ---- positive isolation plan --------------------------------------------------------------------------------------
// Pure and testable: decides, from structure only (tags, classes, geometry, computed style - never text), which elements
// must be hidden so that the screenshot of the map rectangle contains the basemap (and reliable thematic rasters) only.
//   KEEP     basemap / thematic tile layer containers, plus their ancestors (structural, never hidden) and descendants.
//   HIDE     everything else that is explicitly known (vector overlays, markers, controls, minimap, extension UI) and,
//            at document level, every other element that intersects the map rectangle.
// A parent that holds both KEEP and HIDE is never hidden itself: only its HIDE descendants are.
const VCI_SKIP_TAGS = new Set(['HEAD', 'SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'BASE']);
const VCI_UI_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'A', 'SUMMARY', 'FORM', 'NAV', 'HEADER', 'ASIDE', 'DIALOG', 'FOOTER', 'MENU']);
const VCI_UI_ROLES = /^(?:button|menu|menubar|menuitem|search|searchbox|toolbar|navigation|dialog|banner|complementary|tablist|combobox|textbox|tooltip|alert)$/i;
const VCI_MAX_NODES = 20000;
const VCI_MAX_LEAK_NODES = 5000;
const VCI_EXTENSION_ATTRIBUTE = 'data-mon-territoire-export-ui';
const VCI_EXTENSION_SELECTOR = `[${VCI_EXTENSION_ATTRIBUTE}], #mon-territoire-probe-ui`;

const vciAttr = (element, name) => { try { const value = element.getAttribute?.(name); return typeof value === 'string' ? value : ''; } catch { return ''; } };
const vciTag = element => String(element?.tagName || '').toUpperCase();
function vciRect(element) { try { const r = element.getBoundingClientRect?.(); return r && [r.left, r.top, r.width, r.height].every(Number.isFinite) ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; } catch { return null; } }
function vciIntersects(rect, map) { return !!rect && rect.width > 0 && rect.height > 0 && rect.left < map.left + map.width && rect.left + rect.width > map.left && rect.top < map.top + map.height && rect.top + rect.height > map.top; }
function vciStyle(win, element) { try { return win?.getComputedStyle?.(element) || null; } catch { return null; } }

// Role of an element that is not part of the keep-set. Signals only: extension marker, Leaflet classes, tag, ARIA role,
// computed position. Never the displayed text.
export function vciClassify(element, { container, hints, win }) {
  if (element.hasAttribute?.(VCI_EXTENSION_ATTRIBUTE) || vciAttr(element, 'id') === 'mon-territoire-probe-ui') return 'extension';
  if (hints.cadastre.has(element) || hints.selection.has(element) || hints.mask.has(element)) return 'vector';
  const classes = ` ${vciAttr(element, 'class')} `;
  if (/\sleaflet-container\s/.test(classes) && element !== container) return 'minimap';
  if (/\sleaflet-control[\w-]*\s/.test(classes)) return 'control';
  if (/\sleaflet-(?:marker|popup|tooltip|shadow)[\w-]*\s/.test(classes)) return 'marker';
  if (/\sleaflet-(?:overlay|mask)-pane\s/.test(classes)) return 'vector';
  try { if (element.querySelector?.('.leaflet-container') && !element.contains?.(container)) return 'minimap'; } catch {}
  const tag = vciTag(element);
  if (tag === 'SVG' || tag === 'CANVAS') return 'vector';
  if (VCI_UI_TAGS.has(tag) || VCI_UI_ROLES.test(vciAttr(element, 'role')) || element.hasAttribute?.('tabindex') || element.hasAttribute?.('onclick')) return 'app';
  const position = vciStyle(win, element)?.position;
  if (position === 'fixed' || position === 'absolute' || position === 'sticky') return 'app';
  return 'unknown';
}

export function vciPlan({ document, win, container, rect, keep = { basemap: [], thematic: [] }, hints = {}, unknownRaster = [], extension = [], controls = [], markers = [], basemapStatus = 'found' }) {
  const set = value => new Set(value || []);
  const knownHints = { cadastre: set(hints.cadastre), selection: set(hints.selection), mask: set(hints.mask) };
  const all = [...keep.basemap, ...keep.thematic];
  const summary = { basemap: keep.basemap.length, thematic: keep.thematic.length, vector: 0, controls: 0, appUi: 0, extension: 0, minimaps: 0, markers: 0, unknown: 0 };
  const result = (ok, reason, hide = [], confidence = 'low') => ({ ok, reason, hide, summary, confidence });
  if (basemapStatus === 'ambiguous') return result(false, 'ambiguous-basemap');
  if (!keep.basemap.length) return result(false, 'no-basemap');
  for (const element of keep.basemap) { if (String(vciStyle(win, element)?.display).startsWith('none')) return result(false, 'basemap-hidden'); }
  const keepSet = set(all); const ancestors = new Set(); const root = document?.documentElement || null; const body = document?.body || null;
  for (const element of all) { let node = element?.parentElement; for (let i = 0; node && i < 256; i++, node = node.parentElement) ancestors.add(node); }
  if (container) { ancestors.add(container); let node = container.parentElement; for (let i = 0; node && i < 256; i++, node = node.parentElement) ancestors.add(node); }
  const inside = element => { let node = element; for (let i = 0; node && i < 256; i++, node = node.parentElement) if (keepSet.has(node)) return true; return false; };
  const hide = new Map(); // element -> role
  const protectedElement = element => element === root || element === body || keepSet.has(element) || ancestors.has(element) || inside(element);
  const add = (element, role) => { if (!element || hide.has(element) || protectedElement(element)) return; hide.set(element, role); };
  // 1. explicit members: known, no geometry needed.
  const roleOf = element => vciClassify(element, { container, hints: knownHints, win });
  for (const element of extension) add(element, 'extension');
  for (const element of [...knownHints.cadastre, ...knownHints.selection, ...knownHints.mask]) add(element, 'vector');
  for (const element of controls) add(element, 'control');
  for (const element of markers) add(element, 'marker');
  for (const element of unknownRaster) add(element, 'unknown-raster');
  // 2. document-level walk: every element that is not related to the keep-set and intersects the map rectangle.
  let budget = VCI_MAX_NODES; const stack = root ? [root] : [];
  while (stack.length && budget-- > 0) {
    const element = stack.pop();
    if (VCI_SKIP_TAGS.has(vciTag(element)) || keepSet.has(element)) continue;
    const related = element === root || element === body || ancestors.has(element);
    if (!related && !hide.has(element)) {
      const role = roleOf(element);
      const explicit = role !== 'app' && role !== 'unknown';
      if (explicit || vciIntersects(vciRect(element), rect)) { add(element, role); continue; }
    }
    if (related || !hide.has(element)) for (const child of Array.from(element.children || [])) stack.push(child);
  }
  // Nested members are already covered by their hidden ancestor: report and hide roots only.
  for (const element of [...hide.keys()]) { let node = element.parentElement; for (let i = 0; node && i < 256; i++, node = node.parentElement) if (hide.has(node)) { hide.delete(element); break; } }
  for (const [element, role] of hide) {
    if (role === 'extension') summary.extension++; else if (role === 'vector') summary.vector++; else if (role === 'control') summary.controls++;
    else if (role === 'minimap') summary.minimaps++; else if (role === 'marker') summary.markers++; else if (role === 'app') summary.appUi++; else summary.unknown++;
  }
  const confidence = summary.unknown === 0 ? 'high' : 'medium';
  return result(true, null, [...hide.keys()], confidence);
}

// Overrides can leak: a descendant of a hidden element that sets `visibility: visible` itself would still be painted.
// Hide those too (after the first hiding, so that computed values reflect it).
export function vciLeaks(roots, win) {
  const leaks = []; let budget = VCI_MAX_LEAK_NODES;
  for (const root of roots) {
    let nodes = []; try { nodes = Array.from(root.querySelectorAll?.('*') || []); } catch {}
    for (const node of nodes) { if (budget-- <= 0) return leaks; if (vciStyle(win, node)?.visibility === 'visible') leaks.push(node); }
  }
  return leaks;
}

export function createCaptureIsolation(global = globalThis) {
  let active = null; let last = null;
  const finish = (watchdog) => {
    const state = active; if (!state) return null;
    active = null; global.clearTimeout?.(state.timer);
    const restored = vciRestore(state.records);
    let viewUnchanged = false; try { viewUnchanged = state.signature !== null && state.targets.signature() === state.signature; } catch {}
    last = { transaction: state.transaction, restored, viewUnchanged, watchdog };
    return last;
  };
  return {
    isolate(transaction) {
      if (active) return { status: 'unavailable', reason: 'busy' };
      const inspector = global.MonTerritoireVisibleMapInspector;
      let targets = null; try { targets = inspector?.captureTargets?.() || null; } catch {}
      if (!targets) return { status: 'unavailable', reason: 'no-map' };
      const signature = targets.signature(); if (signature === null) return { status: 'unavailable', reason: 'no-view' };
      const { container, groups } = targets;
      const document = global.document;
      const extension = [];
      try { for (const node of Array.from(document?.querySelectorAll?.(VCI_EXTENSION_SELECTOR) || [])) extension.push(node); } catch {}
      try { const host = document?.getElementById?.('mon-territoire-probe-ui'); if (host && !extension.includes(host)) extension.push(host); } catch {}
      let rect; try { rect = container.getBoundingClientRect(); } catch { return { status: 'unavailable', reason: 'no-rect' }; }
      const clientWidth = Number(container.clientWidth) || 0; const clientHeight = Number(container.clientHeight) || 0;
      const left = rect.left + (Number(container.clientLeft) || 0); const top = rect.top + (Number(container.clientTop) || 0);
      const offsetWidth = Number(container.offsetWidth) || clientWidth; const offsetHeight = Number(container.offsetHeight) || clientHeight;
      const transformed = Math.abs(rect.width - offsetWidth) > 0.5 || Math.abs(rect.height - offsetHeight) > 0.5;
      const mapRect = { left, top, width: clientWidth, height: clientHeight };
      const plan = vciPlan({
        document, win: global, container, rect: mapRect,
        keep: { basemap: targets.basemap || [], thematic: targets.thematic || [] },
        hints: { cadastre: groups.cadastre, selection: groups.selection, mask: [...groups.mask] },
        unknownRaster: targets.unknownRaster || [],
        extension, controls: groups.controls, markers: groups.overlays, basemapStatus: targets.basemapStatus,
      });
      if (!plan.ok) return { status: 'unavailable', reason: plan.reason };
      let records;
      try {
        records = vciHide(plan.hide);
        const leaks = vciLeaks(plan.hide, global);
        if (leaks.length) records.push(...vciHide(leaks.filter(node => !records.some(record => record.element === node))));
      } catch { return { status: 'unavailable', reason: 'hide-failed' }; }
      const timer = global.setTimeout?.(() => finish(true), VCI_WATCHDOG_MS);
      active = { transaction, records, signature, targets, timer };
      return { status: 'isolated', rect: mapRect, transformed, counts: plan.summary, confidence: plan.confidence };
    },
    // `transaction` ties a restore request to its isolation: a stale one never touches a newer transaction.
    restore(transaction) {
      if (active && active.transaction === transaction) return finish(false);
      if (!active && last && last.transaction === transaction) return { ...last };
      return { transaction, restored: !active, viewUnchanged: false, watchdog: false };
    },
    get active() { return active !== null; },
  };
}

// ---- MVP-07: basemap readiness barrier ---------------------------------------------------------------------------
// Passive: reads the state of tile <img> elements the page already owns (complete / naturalWidth / inline fade opacity) and
// listens to their existing load/error events. It never sets `src`, never creates an image and never touches the network.
// Only counters leave this module: no tile coordinate, URL or geometry.
const VCI_READY_TIMEOUT_MS = 4000;
const VCI_READY_POLL_MS = 100;
const VCI_READY_SETTLE_MS = 30; // let Leaflet's own load/error handlers (errorTileUrl swap, fade) run before judging
const VCI_MAX_TILES = 2000;
const VCI_MIN_FADE = 0.99;
const VCI_MODES = new Set(['wait', 'check']);

// 'ready'   decoded and fully opaque; 'loading' still in flight, not decoded yet or fading in; 'error' finished without an image.
export function vciTileState(element) {
  let complete; let width; let source; let opacity;
  try {
    complete = element.complete === true; width = Number(element.naturalWidth) || 0;
    source = element.currentSrc || (typeof element.getAttribute === 'function' ? element.getAttribute('src') : '') || '';
    opacity = Number.parseFloat(element.style?.opacity);
  } catch { return 'loading'; }
  if (!complete) return 'loading';
  if (width <= 0) return source ? 'error' : 'loading'; // an <img> without src is "complete" too: nothing was requested yet
  return Number.isFinite(opacity) && opacity < VCI_MIN_FADE ? 'loading' : 'ready';
}

// Tiles of the kept containers that really intersect the map rectangle. Basemap tiles can be loading or in error;
// thematic raster tiles only delay the capture (a missing thematic tile outside its coverage is normal, never blocking).
export function vciReadTiles({ basemap = [], thematic = [], rect }) {
  const counts = { visible: 0, ready: 0, loading: 0, error: 0 }; let budget = VCI_MAX_TILES;
  const scan = (containers, blocking) => {
    for (const container of containers) {
      let images = []; try { images = Array.from(container.querySelectorAll?.('img') || []); } catch {}
      for (const image of images) {
        if (budget-- <= 0) return;
        if (!vciIntersects(vciRect(image), rect)) continue;
        const state = vciTileState(image);
        if (!blocking && state !== 'loading') continue;
        counts.visible++; counts[state]++;
      }
    }
  };
  scan(basemap, true); scan(thematic, false);
  return counts;
}

function vciMapRect(container) {
  const rect = container.getBoundingClientRect();
  return { left: rect.left + (Number(container.clientLeft) || 0), top: rect.top + (Number(container.clientTop) || 0), width: Number(container.clientWidth) || 0, height: Number(container.clientHeight) || 0 };
}

export function createBasemapReadiness(global = globalThis, { timeoutMs = VCI_READY_TIMEOUT_MS, pollMs = VCI_READY_POLL_MS, settleMs = VCI_READY_SETTLE_MS, now = () => Date.now() } = {}) {
  const signatures = new Map();
  const locate = () => {
    let targets = null; try { targets = global.MonTerritoireVisibleMapInspector?.captureTargets?.() || null; } catch {}
    if (!targets || !targets.container || typeof targets.signature !== 'function' || !(targets.basemap || []).length) return null;
    return targets;
  };
  const snapshot = targets => vciReadTiles({ basemap: targets.basemap, thematic: targets.thematic || [], rect: vciMapRect(targets.container) });
  const fact = (transaction, mode, verdict, counts, waitMs = 0, viewUnchanged = true) => ({ type: 'basemap-ready', transaction, mode, verdict, counts, waitMs, timedOut: verdict === 'timeout', viewUnchanged });
  const empty = { visible: 0, ready: 0, loading: 0, error: 0 };
  const verdictOf = counts => (counts.error > 0 ? 'error' : counts.loading > 0 || counts.visible === 0 ? 'loading' : 'ready');
  return {
    // Immediate verdict, no waiting. `viewUnchanged` compares with the view seen by the wait of the same transaction.
    check(transaction) {
      const targets = locate(); if (!targets) return fact(transaction, 'check', 'unavailable', empty);
      let signature = null; try { signature = targets.signature(); } catch {}
      let counts; try { counts = snapshot(targets); } catch { return fact(transaction, 'check', 'unavailable', empty); }
      const reference = signatures.get(transaction);
      return fact(transaction, 'check', verdictOf(counts), counts, 0, signature !== null && reference !== undefined && signature === reference);
    },
    // Resolves as soon as every visible tile is ready; at the latest after timeoutMs. Never rejects, never waits forever.
    wait(transaction) {
      return new Promise(resolve => {
        const targets = locate(); if (!targets) { resolve(fact(transaction, 'wait', 'unavailable', empty)); return; }
        let signature = null; try { signature = targets.signature(); } catch {}
        if (signature === null) { resolve(fact(transaction, 'wait', 'unavailable', empty)); return; }
        signatures.set(transaction, signature); while (signatures.size > 4) signatures.delete(signatures.keys().next().value);
        const started = now(); let finished = false; let timer = null; let counts = empty; const listened = [];
        const finish = verdict => {
          if (finished) return; finished = true; global.clearTimeout?.(timer);
          for (const target of listened) { try { target.removeEventListener('load', wake, true); target.removeEventListener('error', wake, true); } catch {} }
          resolve(fact(transaction, 'wait', verdict, counts, Math.max(0, Math.min(60_000, Math.round(now() - started))), verdict !== 'view-changed'));
        };
        const evaluate = () => {
          if (finished) return;
          let current = null; try { current = targets.signature(); } catch {}
          if (current !== signature) { finish('view-changed'); return; }
          try { counts = snapshot(targets); } catch { finish('unavailable'); return; }
          const verdict = verdictOf(counts);
          if (verdict === 'ready' || verdict === 'error') { finish(verdict); return; }
          if (now() - started >= timeoutMs) { finish('timeout'); return; }
          global.clearTimeout?.(timer); timer = global.setTimeout?.(evaluate, pollMs);
        };
        function wake() { if (finished) return; global.clearTimeout?.(timer); timer = global.setTimeout?.(evaluate, settleMs); }
        for (const target of [...targets.basemap, ...(targets.thematic || [])]) { try { target.addEventListener?.('load', wake, true); target.addEventListener?.('error', wake, true); listened.push(target); } catch {} }
        evaluate();
      });
    },
  };
}
export const vciReadyMode = value => { const [mode, transaction] = String(value ?? '').split(':'); return VCI_MODES.has(mode) && /^[a-z0-9-]{1,40}$/.test(transaction || '') ? { mode, transaction } : null; };

if (typeof window !== 'undefined') globalThis.MonTerritoireCaptureIsolation
 = createCaptureIsolation(globalThis);
if (typeof window !== 'undefined') { globalThis.MonTerritoireBasemapReadiness = createBasemapReadiness(globalThis); globalThis.MonTerritoireBasemapReadyMode = vciReadyMode; }
