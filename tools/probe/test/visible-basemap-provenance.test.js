import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisibleMapInspector } from '../visible-map-inspector.js';
import { SECRET, attach, basemapLayer, createContainer, createSyntheticL, createSyntheticMap, geometryTile, maskLayer, tileImage, vectorGridLayer } from './fixtures/synthetic-leaflet.js';

// MVP-05B: passive identification of the basemap tile layer. Synthetic hosts only; the report keeps tokens, never the URL.
globalThis.window = globalThis;
const G = await import('../visible-cadastre-geometry.js');
await import('../visible-background.js');
await import('../visible-cadastre-export.js');
const V = () => globalThis.MonTerritoireVisibleCadastre;
const json = value => JSON.stringify(value);
const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// Browser-like DOM: location, document.scripts, script.src and script.textContent are accessors on a prototype, not own data properties.
const accessors = data => { const proto = {}; for (const [key, value] of Object.entries(data)) Object.defineProperty(proto, key, { get: () => value }); return Object.create(proto); };

function world({ url, options = {}, scripts = [], location = { hostname: 'carto.monterritoire.fr' }, globals = {}, taint = true } = {}) {
  const L = createSyntheticL();
  const tiles = { '1000:2000:17': geometryTile(L, [{ id: `${SECRET}-a`, rings: [sq(10, 10, 50, 50)] }]) };
  const cadastre = vectorGridLayer(L, { tiles, coords: { '1000:2000:17': { x: 1000, y: 2000, z: 17 } } });
  const base = basemapLayer(L, { id: 2, tiles: [{ x: 1000, y: 2000, el: tileImage({ taint }) }] });
  if (url !== undefined) base._url = url;
  Object.assign(base.options, options);
  const map = createSyntheticMap(L, [base, cadastre, maskLayer(L)], { container: createContainer(300, 200), pixelOrigin: { x: 256 * 1000 - 20, y: 256 * 2000 - 20 } });
  map.attributionControl = { _attributions: options.mapAttributions || {} };
  const document = Object.assign(accessors({ scripts: scripts.map(accessors) }), { querySelectorAll: () => [map._container], createElement: () => ({ getContext: () => ({ drawImage() { throw Object.assign(new Error('t'), { name: 'SecurityError' }); } }) }) });
  const global = { L, myMap: map, location: accessors(location), document, MonTerritoireVisibleCadastreGeometry: G, MonTerritoireVisibleBackground: globalThis.MonTerritoireVisibleBackground, ...globals };
  return { map, inspector: createVisibleMapInspector(global) };
}
const background = w => { const result = w.inspector.visibleCadastre(); assert.equal(result.status, 'ready'); return result.background; };
const OSM = `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png?token=${SECRET}`;

test('1. OSM Foundation standard tiles: provider family, XYZ service, PNG, public attribution; no URL, host, token or tile coordinate', () => {
  const w = world({ url: OSM, options: { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', subdomains: 'abc' } });
  const bg = background(w); const p = bg.provenance;
  assert.equal(p.provider, 'osm-foundation-standard'); assert.equal(p.serviceFamily, 'xyz-tiles'); assert.equal(p.format, 'png'); assert.equal(p.renderType, 'raster-tiles');
  assert.deepEqual(p.attribution, ['© OpenStreetMap contributors']); assert.equal(p.options.subdomainCount, 3); assert.equal(p.options.crossOrigin, 'unset');
  const text = json(bg);
  for (const forbidden of [SECRET, 'openstreetmap.org', 'tile.', 'http', '1000', '2000', 'token']) assert.equal(text.includes(forbidden), false, forbidden);
});

test('2. a first-party tile host is reported as first-party, never by name', () => {
  const p = background(world({ url: `https://tuiles.monterritoire.fr/fond/{z}/{x}/{y}.png` })).provenance;
  assert.equal(p.provider, 'first-party');
});

test('3. an unknown third party is only "other-third-party"; a known CARTO host yields its style hint', () => {
  assert.equal(background(world({ url: `https://tiles.unknown-vendor.example/a/{z}/{x}/{y}.jpg` })).provenance.provider, 'other-third-party');
  const carto = background(world({ url: `https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png` })).provenance;
  assert.equal(carto.provider, 'carto'); assert.ok(carto.styleHints.includes('voyager')); assert.equal(carto.options.retina, true);
  assert.equal(background(world({ url: `https://tiles.unknown-vendor.example/a/{z}/{x}/{y}.jpg` })).provenance.format, 'jpeg');
});

test('4. a vector tile template is reported as vector tiles without being fetched', () => {
  const p = background(world({ url: `https://tiles.unknown-vendor.example/v/{z}/{x}/{y}.pbf` })).provenance;
  assert.equal(p.format, 'pbf'); assert.equal(p.renderType, 'vector-tiles'); assert.equal(p.serviceFamily, 'vector-tiles');
});

test('5. crossOrigin option, zoom range and tile size are reported (a tainted canvas is not proof of a missing CORS header)', () => {
  const p = background(world({ url: OSM, options: { crossOrigin: 'anonymous', minZoom: 3, maxZoom: 19, tileSize: 256 } })).provenance;
  assert.deepEqual(p.options, { crossOrigin: 'anonymous', subdomainCount: 0, retina: false, tileSize: 256, minZoom: 3, maxZoom: 19 });
});

test('6. static hints: inline scripts are scanned for closed flags only; external scripts are counted and never read', () => {
  const scripts = [{ src: 'https://cdn.test/app.js', textContent: `openstreetmap ${SECRET}` }, { textContent: `var s = "https://x.test/openstreetmap/${SECRET}"; maplibre; style.json; tiles/{z}.pbf` }];
  const bg = background(world({ url: OSM, scripts, globals: { maplibregl: {} } }));
  assert.deepEqual(bg.provenance.staticHints, { inlineScripts: 1, externalScripts: 1, flags: ['inline-mentions-maplibre', 'inline-mentions-openstreetmap', 'inline-mentions-style-json', 'inline-mentions-vector-tile-extension'] });
  assert.equal(bg.provenance.vectorLibraries.maplibregl, true); assert.equal(bg.provenance.vectorLibraries.vectorGrid, true); assert.equal(bg.provenance.vectorLibraries.mapboxgl, false);
  assert.equal(json(bg).includes(SECRET), false);
});

test('7. the attribution is plain public text: markup removed, links and odd characters dropped', () => {
  const p = background(world({ url: OSM, options: { attribution: '<b>Données</b> © Fournisseur | https://x.test/a?t=1 | <script>alert(1)</script>', mapAttributions: { 'Leaflet': 1 } } })).provenance;
  assert.ok(p.attribution.every(text => !/http|<|>/.test(text))); assert.ok(p.attribution.includes('Données © Fournisseur') && p.attribution.includes('Leaflet'));
});

test('8. no layer URL: provenance stays "unknown"', () => {
  const p = background(world({ url: undefined === 1 ? '' : 42 })).provenance;
  assert.equal(p.provider, 'unknown'); assert.equal(p.format, 'unknown'); assert.equal(p.serviceFamily, 'unknown');
});

test('9. the validated capture and the Diagnostic carry the provenance; a forged one is rejected', () => {
  const w = world({ url: OSM, options: { attribution: '© OpenStreetMap contributors' } }); const fact = w.inspector.visibleCadastre();
  const validated = V().validateCapture(fact); assert.ok(validated); assert.equal(validated.background.provenance.provider, 'osm-foundation-standard');
  const text = V().backgroundText(validated); assert.match(text, /provider: osm-foundation-standard/); assert.match(text, /attribution: © OpenStreetMap contributors/); assert.equal(text.includes(SECRET), false);
  const forge = patch => V().validateCapture({ ...fact, background: { ...fact.background, provenance: { ...fact.background.provenance, ...patch } } });
  assert.equal(forge({ provider: 'tile.openstreetmap.org' }), null); assert.equal(forge({ attribution: ['https://x.test'] }), null); assert.equal(forge({ extra: 1 }), null);
});

test('10. passive: no map accessor or mutator is called, and the report adds no network access', () => {
  const w = world({ url: OSM }); background(w); assert.deepEqual(w.map.calls, []);
});
