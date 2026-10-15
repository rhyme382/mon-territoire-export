import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const extensionFiles = ['tools/probe/engine-inspector.js', 'tools/probe/visible-map-inspector.js', 'tools/probe/visible-map-report.js', 'tools/probe/visible-selection-report.js', 'tools/probe/visible-cadastre-geometry.js', 'tools/probe/visible-background.js', 'tools/probe/visible-cadastre-export.js', 'tools/gpkg-svg/core/viewport-export.js', 'tools/probe/pci-contour-observer.js', 'tools/probe/main-observer.js', 'tools/probe/render-inspector.js', 'tools/probe/mask-control.js', 'tools/probe/content-ui.js'];

test('manifest does not request privileged or persistent capabilities', async () => {
  const manifest = JSON.parse(await readFile('tools/probe/manifest.json', 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab']);
  assert.equal(JSON.stringify(manifest).match(/cookies|debugger|webRequest|storage|downloads|<all_urls>/i), null);
  assert.deepEqual(manifest.content_scripts.flatMap(item => item.matches), ['https://carto.monterritoire.fr/*', 'https://carto.monterritoire.fr/*']);
  // MVP-06: a service worker exists for the single privileged call (captureVisibleTab). It adds no permission.
  assert.deepEqual(manifest.background, { service_worker: 'service-worker.js' });
  const icons = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' };
  assert.deepEqual(manifest.action, { default_title: 'Mon Territoire Export', default_popup: 'popup.html', default_icon: icons });
  assert.deepEqual(manifest.icons, icons);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.permissions.includes('tabs'), false);
});

test('extension code contains no persistence, telemetry, request construction, or raw response serialization', async () => {
  // The product UI talks to the extension through chrome.runtime.id / onMessage only (MVP-06 messaging); the sending side lives in rendered-basemap.js.
  const source = (await Promise.all(extensionFiles.map(file => readFile(file, 'utf8')))).join('\n').replaceAll('globalThis.chrome.runtime.id', '').replaceAll('globalThis.chrome?.runtime', 'runtime-ref');
  assert.equal(source.match(/localStorage|sessionStorage|chrome\.storage|sendBeacon|WebSocket|EventSource|chrome\.runtime|new\s+XMLHttpRequest|\.open\(['"]/i), null);
  assert.equal(source.match(/JSON\.stringify\(\s*(response|.*propertyValues)/i), null);
  assert.equal(source.match(/\.har\b/i), null);
  assert.equal(source.match(/(?:^|[.\s])fetch\s*\(/im), null);
});

test('MAIN-world facts are closed-schema validated before they can be aggregated', async () => {
  const source = await readFile('tools/probe/content-ui.js', 'utf8');
  assert.match(source, /function validatePageFact\(value\)/);
  assert.match(source, /const fact = validatePageFact\(event\?\.detail\); if \(!fact\) \{ if \(event\?\.detail\?\.type === 'resource'\)/);
  assert.match(source, /resources\.push\(fact\)/);
  assert.match(source, /FORBIDDEN/);
  assert.match(source, /exactKeys/);
});

test('report schema excludes forbidden sensitive fields and raw response serialization', async () => {
  const source = (await Promise.all(extensionFiles.map(file => readFile(file, 'utf8')))).join('\n');
  assert.equal(source.match(/JSON\.stringify\(\s*(?:this\.)?response\b/i), null);
  assert.equal(source.match(/JSON\.stringify\([^)]*(?:cookie|authorization|token|body|propertyValues)/i), null);
  assert.match(source, /response-derived values cross the boundary/);
  assert.match(source, /new Set\(\['type', 'hostname', 'pathname', 'zxy', 'initiatorType', 'transferSize', 'encodedBodySize', 'decodedBodySize', 'leaflet', 'probeDiagnostics'\]\)/);
  assert.match(source, /new Set\(\['hostname', 'pathname', 'width', 'height', 'class'\]\)/);
  assert.match(source, /pathname\(value\.pathname\)/);
});

test('T00-C render inspector excludes pixels, DOM text, raw path data and geographic fields', async () => {
  const source = await readFile('tools/probe/render-inspector.js', 'utf8');
  assert.equal(source.match(/(?:toDataURL|getImageData|drawImage|textContent|innerText|innerHTML|latitude|longitude|latlng)/i), null);
  assert.match(source, /function pathStats\(element\)/);
  assert.match(source, /MAX_EXAMPLES_PER_SIGNATURE = 10/);
  assert.match(source, /MAX_EXAMPLES = 100/);
  assert.match(source, /sanitizeRasterUrl/);
  assert.match(source, /passive-dom-render-only/);
});

test('T00-E never creates requests, workers, worker messages, or service worker registrations', async () => {
  const source = await readFile('tools/probe/engine-inspector.js', 'utf8');
  assert.equal(source.match(/(?:\bfetch\s*\(|new\s+XMLHttpRequest|\.register\s*\(|\.unregister\s*\(|\.update\s*\(|\.postMessage\s*\()/i), null);
  assert.match(source, /Reflect\.construct\(Original, args/);
  assert.equal(source.match(/getRegistrations\s*\(/i), null);
});

test('T00-G contour observer never reads credentials, persists, serializes coordinates, or builds PCI requests', async () => {
  const source = await readFile('tools/probe/pci-contour-observer.js', 'utf8');
  const code = source.replace(/\/\/.*$/gm, '');
  assert.equal(code.match(/cookie|authorization|chrome\.|debugger|webRequest|localStorage|sessionStorage|indexedDB|caches\b|sendBeacon|WebSocket|EventSource|navigator\./i), null);
  assert.equal(code.match(/JSON\.stringify|structuredClone|postMessage|console\./), null);
  assert.equal(code.match(/(?:\$|jQuery)\s*\.\s*(?:ajax|get|post|getJSON)\s*\(|\bfetch\s*\(|new\s+XMLHttpRequest|getParcelleContourPCI|PluginSogefiRequests|isAllowed|user_data|insees/), null);
  assert.equal(code.match(/\.(?:coordinates|bbox)\s*=[^=]|coordinates\s*:/), null);
  assert.equal(code.match(/setRequestHeader|\.headers|getAllResponseHeaders|getResponseHeader/), null);
  assert.match(code, /original\.apply\(this, args\)/);
});

test('T00-G report schema has no field able to carry coordinates or property values', async () => {
  const source = await readFile('tools/probe/content-ui.js', 'utf8');
  assert.match(source, /function pciContour\(value\)/);
  assert.match(source, /coordinates: 'not-retained', propertyValues: 'not-retained'/);
  assert.equal(source.match(/new Set\([^)]*'(?:coordinates|bbox|geometry|properties|features)'/), null);
});

test('MVP-03A modules never request, persist, mutate the map or serialize coordinates', async () => {
  for (const file of ['tools/probe/visible-map-inspector.js', 'tools/probe/visible-map-report.js']) {
    const code = (await readFile(file, 'utf8')).replace(/\/\/.*$/gm, '');
    assert.equal(code.match(/\bfetch\s*\(|new\s+XMLHttpRequest|new\s+(?:Shared)?Worker|sendBeacon|WebSocket|new\s+Image|\.postMessage\s*\(|cookie|authorization|localStorage|sessionStorage|indexedDB|chrome\./i), null, file);
    assert.equal(code.match(/\.(?:addLayer|removeLayer|setView|setZoom|panTo|panBy|flyTo|fitBounds|invalidateSize|redraw|setOpacity|setStyle|setUrl|remove|eachLayer)\s*\(/), null, file);
    assert.equal(code.match(/\.(?:getCenter|getBounds|getPixelBounds|getBoundsZoom|getLatLng|toGeoJSON)\s*\(/), null, file);
    if (file.endsWith('inspector.js')) assert.equal(code.match(/JSON\.stringify|console\./), null, file);
  }
});

test('MVP-03A UI only dispatches capture requests and never toggles a layer or the viewport', async () => {
  const source = await readFile('tools/probe/content-ui.js', 'utf8');
  assert.match(source, /VISIBLE_MAP_REQUEST_EVENT, \{ detail: slot \}/);
  assert.equal(source.match(/addLayer|removeLayer|setView|fitBounds|\.click\(\)\s*;?\s*\/\/ cadastre/), null);
});

test('MVP-03B modules never request, persist, move the map, read geography or serialize identifiers', async () => {
  for (const file of ['tools/probe/visible-cadastre-geometry.js', 'tools/probe/visible-cadastre-export.js', 'tools/probe/visible-map-inspector.js', 'tools/gpkg-svg/core/viewport-export.js']) {
    const code = (await readFile(file, 'utf8')).replace(/\/\/.*$/gm, '');
    assert.equal(code.match(/\bfetch\s*\(|new\s+XMLHttpRequest|new\s+(?:Shared)?Worker|sendBeacon|WebSocket|new\s+Image|\.postMessage\s*\(|cookie|authorization|localStorage|sessionStorage|indexedDB|chrome\.|webRequest|debugger/i), null, file);
    assert.equal(code.match(/\.(?:addLayer|removeLayer|setView|setZoom|panTo|panBy|flyTo|fitBounds|invalidateSize|redraw|setOpacity|setStyle|setUrl|eachLayer|loadTile|createTile|_tileCoordsToKey|getTileUrl)\s*\(/), null, file);
    assert.equal(code.match(/\.(?:getCenter|getBounds|getPixelBounds|getBoundsZoom|getLatLng|toGeoJSON|unproject|containerPointToLatLng|layerPointToLatLng)\s*\(/), null, file);
    assert.equal(code.match(/JSON\.stringify|console\./), null, file);
  }
});

test('MVP-03B UI only dispatches availability/export requests and downloads a local Blob', async () => {
  const source = await readFile('tools/probe/content-ui.js', 'utf8');
  assert.match(source, /VISIBLE_CADASTRE_REQUEST_EVENT, \{ detail: mode \}/);
  assert.match(source, /if \(!exportPending\) return; exportPending = false;/, 'a geometry fact without a click never downloads');
  assert.match(source, /if \(object\(value\) && value\.type === 'visible-cadastre'\) return globalThis\.MonTerritoireVisibleCadastre/);
});

test('MVP-03C selection modules inspect memory only: no API, replay, authorization hook, mutation, geography or identifier output', async () => {
  for (const file of ['tools/probe/visible-selection-report.js', 'tools/probe/visible-map-inspector.js', 'tools/probe/visible-cadastre-geometry.js', 'tools/probe/visible-cadastre-export.js', 'tools/gpkg-svg/core/viewport-export.js']) {
    const code = (await readFile(file, 'utf8')).replace(/\/\/.*$/gm, '');
    assert.equal(code.match(/getParcelleContourPCI|getGpkFile|showParcelles|PluginSogefiRequests|isAllowed|user_data|insees|majic|proprietaire|\$\s*\.\s*(?:ajax|get|post)\s*\(/i), null, file);
    assert.equal(code.match(/\bfetch\s*\(|new\s+XMLHttpRequest|sendBeacon|WebSocket|new\s+(?:Shared)?Worker|\.postMessage\s*\(|localStorage|sessionStorage|indexedDB|cookie|chrome\./i), null, file);
    assert.equal(code.match(/\.(?:addLayer|removeLayer|setView|setZoom|panTo|panBy|flyTo|fitBounds|invalidateSize|redraw|setOpacity|setStyle|setUrl|setParams|eachLayer|getLatLng|getLatLngs|getBounds|getCenter|toGeoJSON|unproject|containerPointToLatLng|layerPointToLatLng)\s*\(/), null, file);
    assert.equal(code.match(file.endsWith('-report.js') ? /console\./ : /JSON\.stringify|console\./), null, file);
  }
});

test('MVP-03C UI: the selection test only dispatches capture requests; the user selects parcels, never the probe', async () => {
  const source = await readFile('tools/probe/content-ui.js', 'utf8');
  assert.match(source, /VISIBLE_SELECTION_REQUEST_EVENT, \{ detail: slot \}/);
  assert.equal(source.match(/showParcelles|getParcelleContourPCI|addLayer|\.select\s*\(|selectParcel/), null);
  const observer = await readFile('tools/probe/main-observer.js', 'utf8');
  assert.match(observer, /if \(slot !== 'A' && slot !== 'B'\) return;\n {4}try \{ const capture = globalThis\.MonTerritoireVisibleMapInspector\?\.selectionCapture/);
});
