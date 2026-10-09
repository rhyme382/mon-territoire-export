import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const extensionFiles = ['tools/probe/engine-inspector.js', 'tools/probe/pci-contour-observer.js', 'tools/probe/main-observer.js', 'tools/probe/render-inspector.js', 'tools/probe/mask-control.js', 'tools/probe/content-ui.js', 'tools/probe/probe.css'];

test('manifest does not request privileged or persistent capabilities', async () => {
  const manifest = JSON.parse(await readFile('tools/probe/manifest.json', 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab']);
  assert.equal(JSON.stringify(manifest).match(/cookies|debugger|webRequest|storage|downloads|<all_urls>/i), null);
  assert.deepEqual(manifest.content_scripts.flatMap(item => item.matches), ['https://carto.monterritoire.fr/*', 'https://carto.monterritoire.fr/*']);
  assert.equal(manifest.background, undefined);
});

test('extension code contains no persistence, telemetry, request construction, or raw response serialization', async () => {
  const source = (await Promise.all(extensionFiles.map(file => readFile(file, 'utf8')))).join('\n');
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
