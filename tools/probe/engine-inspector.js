const MAX_ITEMS = 64;
const MAX_NAMES = 16;
const MAX_PATH = 512;

function safeUrl(input, base) {
  try {
    const url = new URL(String(input), base || globalThis.location?.href);
    if (!/^https?:$/.test(url.protocol)) return null;
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith('/') || pathname.length > MAX_PATH || /[?#\u0000-\u001f\u007f]/.test(pathname)) return null;
    return { hostname: url.hostname.toLowerCase(), pathname: pathname.replace(/\/(\d+)\/(\d+)\/(\d+)(?=\.[a-z0-9]+$|$)/i, '/{z}/{x}/{y}') };
  } catch { return null; }
}
export function sanitizeEngineUrl(input, base) { return safeUrl(input, base); }
function dimension(value) { return Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100_000 ? Math.round(Number(value)) : 0; }
function functionName(value) { return (typeof value === 'function' || (value && typeof value === 'object')) && typeof value.name === 'string' && /^[A-Za-z_$][\w$]{0,95}$/.test(value.name) ? value.name : undefined; }
function propertyNames(value) { try { return Object.keys(value || {}).filter(name => /^_?(?:url|tiles|tileZoom|renderer|container|map|layers|leaflet_id|pane|canvas|svg|bounds|levels|zoomAnimated)$/i.test(name)).slice(0, MAX_NAMES); } catch { return []; } }
function isVector(layer, name) { return /(?:vectorgrid|protobuf|vector)/i.test(name || '') || Boolean(layer?.options?.vectorTileLayerStyles); }
function isTile(layer, name) { return /(?:tile|grid|vectorgrid|protobuf)/i.test(name || '') || typeof layer?._url === 'string'; }
function hasRenderer(layer, name) { return /canvas/i.test(name || '') || Boolean(layer?._renderer?._ctx); }
function rendererType(layer) { const name = functionName(layer?._renderer?.constructor); return name || (/svg/i.test(functionName(layer?.constructor) || '') ? 'SVG' : /canvas/i.test(functionName(layer?.constructor) || '') ? 'Canvas' : undefined); }
function layerAggregate(map) {
  const groups = new Map();
  let values = [];
  try { values = Object.values(map?._layers || {}).slice(0, 10_000); } catch {}
  for (const layer of values) {
    const constructorName = functionName(layer?.constructor) || 'Unknown';
    const key = `${constructorName}|${layer?.options?.pane || ''}|${rendererType(layer) || ''}`;
    let group = groups.get(key);
    if (!group) {
      const url = typeof layer?._url === 'string' ? safeUrl(layer._url) : null;
      group = { constructorName, count: 0, ...(typeof layer?.options?.pane === 'string' ? { paneName: layer.options.pane.slice(0, 96) } : {}), ...(rendererType(layer) ? { rendererType: rendererType(layer) } : {}), ...(typeof layer?._container?.tagName === 'string' ? { containerTagName: layer._container.tagName.toUpperCase() } : {}), hasUrlTemplate: typeof layer?._url === 'string', ...(url ? { sanitizedUrlPattern: url } : {}), hasTileLayerSemantics: isTile(layer, constructorName), hasVectorGridSemantics: isVector(layer, constructorName), hasCanvasRenderer: hasRenderer(layer, constructorName), hasSvgRenderer: /svg/i.test(constructorName) || /svg/i.test(rendererType(layer) || ''), technicalPropertyNames: propertyNames(layer) };
      groups.set(key, group);
    }
    group.count++;
  }
  return [...groups.values()].sort((a, b) => a.constructorName.localeCompare(b.constructorName));
}
function libraries(global) {
  const result = []; const L = global.L;
  if (L && typeof L === 'object') result.push({ libraryDetected: true, libraryName: 'Leaflet', ...(typeof L.version === 'string' ? { version: L.version.slice(0, 48) } : {}), classes: ['Map', 'TileLayer', 'GridLayer', 'Canvas', 'SVG', 'VectorGrid', 'VectorGrid.Protobuf'].filter(path => path.split('.').reduce((value, key) => value?.[key], L)), prototypeMethods: propertyNames(L.Map?.prototype) });
  for (const [name, value, label] of [['maplibregl', global.maplibregl, 'MapLibre GL'], ['mapboxgl', global.mapboxgl, 'Mapbox GL'], ['ol', global.ol, 'OpenLayers'], ['deck', global.deck, 'deck.gl']]) if (value) result.push({ libraryDetected: true, libraryName: label, ...(typeof value.version === 'string' ? { version: value.version.slice(0, 48) } : {}), classes: Object.keys(value).filter(key => /^(?:Map|MapGL|Source|Layer|Vector|Tile|Canvas|SVG)$/i.test(key)).slice(0, MAX_NAMES), prototypeMethods: propertyNames(value.Map?.prototype || value.MapGL?.prototype) });
  return result;
}
function candidates(global, containers) {
  const L = global.L; const found = new Set(); const maps = [];
  const add = map => { if (!map || typeof map !== 'object' || found.has(map) || !map._container) return; found.add(map); maps.push(map); };
  try { Object.values(L?._instances || {}).forEach(add); } catch {}
  try { Object.keys(global).filter(key => /map/i.test(key)).slice(0, 200).forEach(key => { try { const value = global[key]; if (value?._container && value?._layers) add(value); } catch {} }); } catch {}
  // Container-side stamps are evidence only; they cannot recover a map object by themselves.
  return maps.map(map => ({ map, index: containers.indexOf(map._container) })).filter(item => item.index >= 0);
}
function primary(global, document) {
  let containers = []; try { containers = Array.from(document?.querySelectorAll?.('.leaflet-container') || []).slice(0, MAX_ITEMS); } catch {}
  const maps = candidates(global, containers); const sizes = containers.map((node, index) => ({ index, width: dimension(node?.clientWidth), height: dimension(node?.clientHeight) }));
  if (!containers.length) return { containers: 0, index: null, reason: 'no-leaflet-container', mapObjectReachable: false };
  const selected = sizes.reduce((best, item) => item.width * item.height > best.width * best.height ? item : best, sizes[0]);
  const map = maps.find(item => item.index === selected.index)?.map;
  return { containers: containers.length, index: selected.index, reason: 'largest-container', dimensions: { width: selected.width, height: selected.height }, engine: global.L ? 'Leaflet' : undefined, mapObjectReachable: Boolean(map), _map: map };
}
function iframes(global, document) {
  let frames = []; try { frames = Array.from(document?.querySelectorAll?.('iframe') || []).slice(0, MAX_ITEMS); } catch {}
  const records = frames.map(frame => {
    const safe = safeUrl(frame?.src || '', global.location?.href); let same = false;
    try { same = Boolean(frame?.contentDocument); } catch {}
    let contains = false; if (same) try { contains = Boolean(frame.contentDocument.querySelector?.('.leaflet-container')); } catch {}
    return { ...(safe || {}), width: dimension(frame?.clientWidth), height: dimension(frame?.clientHeight), containsLeafletContainer: contains, _same: same };
  });
  const sameOriginCount = records.filter(item => item._same).length;
  return { count: records.length, sameOriginCount, crossOriginCount: records.length - sameOriginCount, frames: records.map(({ _same, ...item }) => item) };
}
export function classifyScript(pathname) { const path = String(pathname).toLowerCase(); if (/vectorgrid/.test(path)) return 'vectorgrid'; if (/maplibre/.test(path)) return 'maplibre'; if (/mapbox/.test(path)) return 'mapbox'; if (/(?:openlayers|\/ol[.-])/.test(path)) return 'openlayers'; if (/(?:protobuf|pbf)/.test(path)) return 'protobuf-pbf'; if (/leaflet/.test(path)) return 'leaflet'; if (/worker/.test(path)) return 'worker-bundle'; return 'other'; }
function scripts(global, document) {
  const values = []; try { values.push(...Array.from(document?.querySelectorAll?.('script[src]') || []).map(item => item.src)); } catch {}
  try { values.push(...(global.performance?.getEntriesByType?.('resource') || []).filter(item => item.initiatorType === 'script').map(item => item.name)); } catch {}
  const seen = new Set(); return values.map(value => safeUrl(value, global.location?.href)).filter(Boolean).filter(item => { const key = `${item.hostname}${item.pathname}`; if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, MAX_ITEMS).map(item => ({ ...item, category: classifyScript(item.pathname) }));
}
function serviceWorker(global) { const api = global.navigator?.serviceWorker; const controller = api?.controller; const safe = typeof controller?.scriptURL === 'string' ? safeUrl(controller.scriptURL, global.location?.href) : null; return { apiAvailable: Boolean(api), controllerPresent: Boolean(controller), ...(safe ? { controllerScript: safe } : {}) }; }
export function compareSnapshots(previous, current) {
  if (!previous || !current) return { available: false, summary: 'comparison unavailable' };
  const counts = list => new Map((list || []).map(item => [item.constructorName, item.count])); const old = counts(previous.layerAggregates), next = counts(current.layerAggregates);
  const newLayerTypes = [...next].filter(([name, count]) => count > (old.get(name) || 0)).map(([constructorName, count]) => ({ constructorName, count: count - (old.get(constructorName) || 0) }));
  const workerDelta = (current.workers?.length || 0) - (previous.workers?.length || 0); const iframeDelta = (current.iframes?.count || 0) - (previous.iframes?.count || 0); const scriptDelta = (current.scriptSignatures?.length || 0) - (previous.scriptSignatures?.length || 0); const diagnostics = ['canvasCount', 'svgCount', 'containerCount'].reduce((out, key) => ({ ...out, [key]: (current.diagnostics?.[key] || 0) - (previous.diagnostics?.[key] || 0) }), {});
  const changed = newLayerTypes.length || workerDelta || iframeDelta || scriptDelta || Object.values(diagnostics).some(Boolean);
  return { available: true, newLayerTypes, workerDelta, iframeDelta, scriptDelta, rendererDelta: diagnostics, summary: changed ? 'structural delta detected' : 'no structural delta' };
}
export function createEngineInspector(global = globalThis) {
  const workers = []; let installed = false;
  const observe = (kind, args) => { const safe = safeUrl(args[0], global.location?.href); const options = args[1] && typeof args[1] === 'object' ? args[1] : {}; workers.push({ type: kind, ...(safe ? { scriptLocation: safe } : {}), ...(options.type === 'module' || options.type === 'classic' ? { workerType: options.type } : {}), ...(typeof options.name === 'string' ? { hasName: true } : {}) }); };
  const wrap = key => { const Original = global[key]; if (typeof Original !== 'function' || Original.__mtEngineProbeWrapped) return false; function ObservedWorker(...args) { const instance = Reflect.construct(Original, args, new.target === ObservedWorker ? Original : new.target); try { observe(key, args); } catch {} return instance; } Object.setPrototypeOf(ObservedWorker, Original); ObservedWorker.prototype = Original.prototype; Object.defineProperty(ObservedWorker, '__mtEngineProbeWrapped', { value: true }); global[key] = ObservedWorker; return true; };
  return {
    runtime: () => ({ libraries: libraries(global) }),
    installWorkerObservation() { if (installed) return; installed = true; wrap('Worker'); wrap('SharedWorker'); },
    capture() {
      const main = primary(global, global.document); const layerAggregates = main._map ? layerAggregate(main._map) : []; delete main._map;
      let canvasCount = 0; let svgCount = 0; try { canvasCount = global.document?.querySelectorAll?.('canvas').length || 0; svgCount = global.document?.querySelectorAll?.('svg').length || 0; } catch {}
      const runtime = this.runtime(); const names = runtime.libraries.map(item => item.libraryName);
      return { schemaVersion: 1, inspection: 'passive-engine-worker-identification', 'no-additional-network-requests': true, runtime, primaryMap: main, layerAggregates, workers: workers.slice(0, MAX_ITEMS), serviceWorker: serviceWorker(global), iframes: iframes(global, global.document), scriptSignatures: scripts(global, global.document), diagnostics: { runtimeInspectionCompleted: true, leafletDetected: names.includes('Leaflet'), mapLibreDetected: names.includes('MapLibre GL'), mapboxDetected: names.includes('Mapbox GL'), openLayersDetected: names.includes('OpenLayers'), primaryMapReachable: main.mapObjectReachable, workerConstructorWrapped: installed, workersObserved: workers.filter(item => item.type === 'Worker').length, sharedWorkersObserved: workers.filter(item => item.type === 'SharedWorker').length, serviceWorkerControllerPresent: Boolean(global.navigator?.serviceWorker?.controller), iframesObserved: global.document?.querySelectorAll?.('iframe').length || 0, scriptSignaturesObserved: scripts(global, global.document).length, canvasCount, svgCount, containerCount: main.containers } };
    }
  };
}
if (typeof window !== 'undefined') { globalThis.MonTerritoireEngineInspector = createEngineInspector(globalThis); globalThis.MonTerritoireEngineInspector.installWorkerObservation(); }
