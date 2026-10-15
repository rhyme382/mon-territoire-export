// MVP-03C, isolated world. Closed-schema validation of the MAIN-world selection snapshots, the A/B delta,
// the deterministic classification of the selection mechanism and the sanitized report.
// Pure data in, pure data out: no DOM, no network. Counters, class families and opaque hashes only:
// hashes are used to detect that something changed and are never copied into the report.
const VSR_KINDS = new Set(['raster', 'wms', 'vectorgrid', 'vectortilelayer', 'geojson-vector', 'mask', 'unknown']);
const VSR_ROLES = new Set(['wms', 'vectorgrid', 'tile', 'renderer', 'path', 'group', 'other']);
const VSR_FAMILIES = new Set(['Canvas', 'SVG', 'Unknown']);
const VSR_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;
const VSR_MAX_LAYERS = 200;
const VSR_LAYER_COUNTS = ['leafletId', 'tileCacheCount', 'vectorTileCacheCount', 'childCount', 'pathCount', 'polygonCount', 'vertexCount', 'styleOverrides', 'paramKeyCount'];
const VSR_PATH_COUNTS = ['count', 'polygons', 'rings', 'vertices', 'parented', 'parentless', 'styleVariants'];
const VSR_CONCLUSIONS = ['LEAFLET_VECTOR_SELECTION', 'LEAFLET_GROUP_SELECTION', 'WMS_SELECTION', 'RENDERER_SELECTION', 'DOM_SELECTION', 'NO_SELECTION_LAYER_FOUND', 'INSUFFICIENT_EVIDENCE'];
const VSR_EXPORTABLE = new Set(['LEAFLET_VECTOR_SELECTION', 'LEAFLET_GROUP_SELECTION']);

const vsrObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const vsrExact = (value, keys) => vsrObject(value) && Object.keys(value).every(key => keys.includes(key));
const vsrInt = (value, maximum = 1e9) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const vsrSig = value => vsrInt(value, 0xffffffff);
function vsrCountMap(value, limit = 32) {
  if (!vsrObject(value) || Object.keys(value).length > limit) return null;
  const out = {};
  for (const key of Object.keys(value)) { if (!VSR_TOKEN.test(key) || !vsrInt(value[key], 1e7)) return null; out[key] = value[key]; }
  return out;
}

function vsrLayer(value) {
  const keys = [...VSR_LAYER_COUNTS, 'kind', 'role', 'pane', 'rendererFamily', 'styleSig', 'paramsSig'];
  if (!vsrExact(value, keys) || !VSR_LAYER_COUNTS.every(key => vsrInt(value[key])) || !vsrSig(value.styleSig) || !vsrSig(value.paramsSig)) return null;
  if (!VSR_KINDS.has(value.kind) || !VSR_ROLES.has(value.role) || (value.pane !== undefined && !(typeof value.pane === 'string' && VSR_TOKEN.test(value.pane))) || (value.rendererFamily !== undefined && !VSR_FAMILIES.has(value.rendererFamily))) return null;
  return { ...Object.fromEntries(VSR_LAYER_COUNTS.map(key => [key, value[key]])), kind: value.kind, role: value.role, ...(value.pane ? { pane: value.pane } : {}), ...(value.rendererFamily ? { rendererFamily: value.rendererFamily } : {}), styleSig: value.styleSig, paramsSig: value.paramsSig };
}
export function vsrValidateCapture(value) {
  if (!vsrExact(value, ['schemaVersion', 'inspection', 'no-additional-network-requests', 'slot', 'map', 'layers', 'layersTruncated', 'paths', 'renderers', 'dom'])) return null;
  if (value.schemaVersion !== 1 || value.inspection !== 'visible-selection' || value['no-additional-network-requests'] !== true || (value.slot !== undefined && !['A', 'B'].includes(value.slot))) return null;
  const map = value.map;
  if (!vsrExact(map, ['status', 'zoom', 'width', 'height', 'layerCount']) || !['found', 'not-found'].includes(map.status) || !vsrInt(map.layerCount, 1e7) || (map.zoom !== undefined && !(Number.isFinite(map.zoom) && map.zoom >= 0 && map.zoom <= 30)) || ['width', 'height'].some(key => map[key] !== undefined && !vsrInt(map[key], 100_000))) return null;
  if (!Array.isArray(value.layers) || value.layers.length > VSR_MAX_LAYERS || typeof value.layersTruncated !== 'boolean') return null;
  const layers = value.layers.map(vsrLayer); if (layers.includes(null)) return null;
  const paths = value.paths;
  if (!vsrExact(paths, [...VSR_PATH_COUNTS, 'styleSig', 'byPane']) || !VSR_PATH_COUNTS.every(key => vsrInt(paths[key], 1e8)) || !vsrSig(paths.styleSig)) return null;
  const byPane = vsrCountMap(paths.byPane, 16); if (!byPane) return null;
  const renderers = value.renderers;
  if (!vsrExact(renderers, ['count', 'families', 'paneRenderers', 'defaultRenderer']) || !vsrInt(renderers.count, 1e6) || !vsrInt(renderers.paneRenderers, 1e6) || typeof renderers.defaultRenderer !== 'boolean') return null;
  const families = vsrCountMap(renderers.families, 3); if (!families || !Object.keys(families).every(key => VSR_FAMILIES.has(key))) return null;
  const dom = value.dom;
  if (!vsrExact(dom, ['svgCount', 'canvasCount', 'svgPathCount', 'panes']) || !['svgCount', 'canvasCount', 'svgPathCount'].every(key => vsrInt(dom[key], 1e7))) return null;
  const panes = vsrCountMap(dom.panes, 32); if (!panes) return null;
  return {
    schemaVersion: 1, inspection: 'visible-selection', 'no-additional-network-requests': true, ...(value.slot ? { slot: value.slot } : {}),
    map: { status: map.status, ...(map.zoom !== undefined ? { zoom: map.zoom } : {}), ...(map.width !== undefined ? { width: map.width } : {}), ...(map.height !== undefined ? { height: map.height } : {}), layerCount: map.layerCount },
    layers, layersTruncated: value.layersTruncated,
    paths: { ...Object.fromEntries(VSR_PATH_COUNTS.map(key => [key, paths[key]])), styleSig: paths.styleSig, byPane },
    renderers: { count: renderers.count, families, paneRenderers: renderers.paneRenderers, defaultRenderer: renderers.defaultRenderer },
    dom: { svgCount: dom.svgCount, canvasCount: dom.canvasCount, svgPathCount: dom.svgPathCount, panes }
  };
}

const vsrSummary = layer => ({ leafletId: layer.leafletId, kind: layer.kind, role: layer.role, ...(layer.pane ? { pane: layer.pane } : {}) });
function vsrDeltas(before, after) {
  const out = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) { const delta = (after[key] || 0) - (before[key] || 0); if (delta) out[key] = delta; }
  return out;
}
function vsrLayerChanges(a, b) {
  const changes = [];
  if (a.childCount !== b.childCount) changes.push('children');
  if (a.pathCount !== b.pathCount) changes.push('paths');
  if (a.polygonCount !== b.polygonCount) changes.push('polygons');
  if (a.vertexCount !== b.vertexCount) changes.push('vertices');
  if (a.styleSig !== b.styleSig) changes.push('style');
  if (a.styleOverrides !== b.styleOverrides) changes.push('style-overrides');
  if (a.paramsSig !== b.paramsSig || a.paramKeyCount !== b.paramKeyCount) changes.push('wms-params');
  if (a.tileCacheCount !== b.tileCacheCount || a.vectorTileCacheCount !== b.vectorTileCacheCount) changes.push('tile-cache');
  if (a.rendererFamily !== b.rendererFamily) changes.push('renderer');
  return changes;
}

const VSR_UNAVAILABLE = { available: false, summary: 'comparison unavailable', conclusion: { code: 'INSUFFICIENT_EVIDENCE', exportable: false, evidence: ['capture-missing'] } };
export function vsrCompare(a, b) {
  if (!a || !b) return { ...VSR_UNAVAILABLE };
  const sameViewport = a.map.status === 'found' && b.map.status === 'found' && a.map.zoom === b.map.zoom && a.map.width === b.map.width && a.map.height === b.map.height;
  const before = new Map(a.layers.map(layer => [layer.leafletId, layer])); const after = new Map(b.layers.map(layer => [layer.leafletId, layer]));
  const added = b.layers.filter(layer => !before.has(layer.leafletId)); const removed = a.layers.filter(layer => !after.has(layer.leafletId));
  const layersChanged = []; const groupsChanged = [];
  for (const layer of b.layers) {
    const old = before.get(layer.leafletId); if (!old) continue;
    const changes = vsrLayerChanges(old, layer);
    if (changes.length) layersChanged.push({ ...vsrSummary(layer), changes });
    if (layer.role === 'group' && (old.childCount !== layer.childCount || old.pathCount !== layer.pathCount || old.polygonCount !== layer.polygonCount || old.vertexCount !== layer.vertexCount)) {
      groupsChanged.push({ ...vsrSummary(layer), childDelta: layer.childCount - old.childCount, pathDelta: layer.pathCount - old.pathCount, polygonDelta: layer.polygonCount - old.polygonCount, vertexDelta: layer.vertexCount - old.vertexCount });
    }
  }
  const rendererChanges = {
    countDelta: b.renderers.count - a.renderers.count, familyDelta: vsrDeltas(a.renderers.families, b.renderers.families), paneRendererDelta: b.renderers.paneRenderers - a.renderers.paneRenderers,
    defaultRendererChanged: a.renderers.defaultRenderer !== b.renderers.defaultRenderer,
    layersAdded: added.filter(layer => layer.role === 'renderer').length, layersRemoved: removed.filter(layer => layer.role === 'renderer').length
  };
  const geometryChanges = {
    pathDelta: b.paths.count - a.paths.count, polygonDelta: b.paths.polygons - a.paths.polygons, ringDelta: b.paths.rings - a.paths.rings, vertexDelta: b.paths.vertices - a.paths.vertices,
    parentedDelta: b.paths.parented - a.paths.parented, parentlessDelta: b.paths.parentless - a.paths.parentless, paneDelta: vsrDeltas(a.paths.byPane, b.paths.byPane),
    styleChanged: a.paths.count > 0 && b.paths.count > 0 && a.paths.styleSig !== b.paths.styleSig,
    styleOverridesDelta: b.layers.reduce((total, layer) => total + layer.styleOverrides, 0) - a.layers.reduce((total, layer) => total + layer.styleOverrides, 0)
  };
  const wmsAfter = b.layers.filter(layer => layer.role === 'wms');
  const wmsChanges = { layers: wmsAfter.length, added: added.filter(layer => layer.role === 'wms').length, paramsChanged: layersChanged.filter(layer => layer.role === 'wms' && layer.changes.includes('wms-params')).length };
  wmsChanges.unchanged = wmsAfter.filter(layer => before.has(layer.leafletId) && !layersChanged.some(item => item.leafletId === layer.leafletId && item.changes.includes('wms-params'))).length;
  const domChanges = { svgPathDelta: b.dom.svgPathCount - a.dom.svgPathCount, canvasDelta: b.dom.canvasCount - a.dom.canvasCount, svgDelta: b.dom.svgCount - a.dom.svgCount, paneDeltas: vsrDeltas(a.dom.panes, b.dom.panes) };

  const evidence = []; let code; let likely = null;
  const mutated = groupsChanged.filter(group => group.pathDelta > 0).sort((x, y) => y.pathDelta - x.pathDelta);
  const newGroups = added.filter(layer => layer.role === 'group' && layer.pathCount > 0).sort((x, y) => y.pathCount - x.pathCount);
  const rendererChanged = rendererChanges.countDelta || Object.keys(rendererChanges.familyDelta).length || rendererChanges.paneRendererDelta || rendererChanges.defaultRendererChanged || rendererChanges.layersAdded || rendererChanges.layersRemoved;
  const domChanged = domChanges.svgPathDelta || domChanges.canvasDelta || domChanges.svgDelta || Object.keys(domChanges.paneDeltas).length;
  if (!sameViewport) { code = 'INSUFFICIENT_EVIDENCE'; evidence.push(a.map.status === 'found' && b.map.status === 'found' ? 'viewport-changed-between-captures' : 'map-not-found'); }
  else if (mutated.length) {
    code = 'LEAFLET_GROUP_SELECTION'; evidence.push('existing-group-gained-paths');
    likely = { ...vsrSummary(mutated[0]), existedInA: true, change: 'children-added', evidence: ['group-existed-in-A', 'path-count-increased'] };
  } else if (newGroups.length || geometryChanges.pathDelta > 0 || geometryChanges.polygonDelta > 0) {
    code = 'LEAFLET_VECTOR_SELECTION'; evidence.push(newGroups.length ? 'new-group-with-paths' : 'new-path-layers');
    const pane = Object.entries(geometryChanges.paneDelta).filter(([, delta]) => delta > 0).sort((x, y) => y[1] - x[1])[0]?.[0];
    likely = newGroups.length ? { ...vsrSummary(newGroups[0]), existedInA: false, change: 'layer-added', evidence: ['group-absent-in-A', 'contains-paths'] } : { role: 'path', ...(pane ? { pane } : {}), existedInA: false, change: 'paths-added', evidence: ['path-count-increased'] };
  } else if (wmsChanges.paramsChanged || wmsChanges.added) {
    code = 'WMS_SELECTION'; evidence.push(wmsChanges.paramsChanged ? 'wms-params-changed' : 'wms-layer-added');
    const layer = wmsChanges.paramsChanged ? layersChanged.find(item => item.role === 'wms' && item.changes.includes('wms-params')) : added.find(item => item.role === 'wms');
    likely = { ...vsrSummary(layer), existedInA: wmsChanges.paramsChanged > 0, change: wmsChanges.paramsChanged ? 'params-changed' : 'layer-added', evidence: [wmsChanges.paramsChanged ? 'wms-params-signature-changed' : 'wms-layer-absent-in-A'] };
  } else if (rendererChanged) {
    code = 'RENDERER_SELECTION'; evidence.push('renderer-delta');
    const layer = added.find(item => item.role === 'renderer');
    likely = { ...(layer ? vsrSummary(layer) : { role: 'renderer' }), existedInA: !layer, change: 'renderer-changed', evidence: ['renderer-count-or-family-changed'] };
  } else if (domChanged) {
    code = 'DOM_SELECTION'; evidence.push('dom-delta');
    const pane = Object.entries(domChanges.paneDeltas).sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))[0]?.[0];
    likely = { role: 'dom', ...(pane ? { pane } : {}), existedInA: true, change: 'dom-changed', evidence: ['svg-or-canvas-delta'] };
  } else { code = 'NO_SELECTION_LAYER_FOUND'; evidence.push('no-structural-delta'); }
  if (code !== 'INSUFFICIENT_EVIDENCE' && geometryChanges.styleOverridesDelta > 0) evidence.push('vectorgrid-style-overrides-increased');

  return {
    available: true, sameViewport,
    layersAdded: added.map(vsrSummary), layersRemoved: removed.map(vsrSummary), layersChanged, groupsChanged, rendererChanges, geometryChanges, wmsChanges, domChanges,
    likelySelectionLayer: likely,
    conclusion: { code, exportable: VSR_EXPORTABLE.has(code), evidence }
  };
}

export function vsrNotExportableNote(code) { return ['WMS_SELECTION', 'RENDERER_SELECTION', 'DOM_SELECTION'].includes(code) ? code : undefined; }

const VSR_EXPORT_COUNTS = ['selectedFeaturesDetected', 'selectedFeaturesVisible', 'selectedPathsExported', 'selectedFeaturesClipped'];
export function vsrBuildReport({ captureA, captureB, comparison, lastExport } = {}) {
  const compared = comparison || vsrCompare(captureA, captureB);
  return {
    schemaVersion: 1, inspection: 'visible-selection',
    privacy: { coordinates: 'not-retained', identifiers: 'not-retained', propertyValues: 'not-retained', wmsParameterValues: 'not-retained', networkRequests: 'none-added' },
    captures: { A: Boolean(captureA), B: Boolean(captureB) },
    selectionComparison: compared,
    ...(lastExport ? { lastExport: Object.fromEntries(VSR_EXPORT_COUNTS.map(key => [key, lastExport[key]])) } : {})
  };
}

// A/B state for the Diagnostic UI. Captures only come from explicit user clicks; nothing here selects anything.
export function vsrCreateSession() {
  const state = { A: null, B: null }; let comparison; let lastExport = null;
  return {
    state,
    record(slot, capture) {
      if (slot !== 'A' && slot !== 'B') return false;
      const safe = vsrValidateCapture({ ...capture, slot }); if (!safe) return false;
      state[slot] = safe; comparison = undefined; return true;
    },
    compare() { comparison = vsrCompare(state.A, state.B); return comparison; },
    conclusionCode() { return comparison?.conclusion?.code; },
    recordExport(counts) { if (counts && VSR_EXPORT_COUNTS.every(key => vsrInt(counts[key], 1e7))) lastExport = Object.fromEntries(VSR_EXPORT_COUNTS.map(key => [key, counts[key]])); },
    report() { return vsrBuildReport({ captureA: state.A, captureB: state.B, comparison, lastExport }); }
  };
}
export async function vsrCopyReport(report, clipboard = navigator.clipboard) { const text = JSON.stringify(report, null, 2); await clipboard.writeText(text); return text; }
globalThis.MonTerritoireVisibleSelection = { validateCapture: vsrValidateCapture, compare: vsrCompare, createSession: vsrCreateSession, buildReport: vsrBuildReport, copyReport: vsrCopyReport, notExportableNote: vsrNotExportableNote, CONCLUSIONS: VSR_CONCLUSIONS };
