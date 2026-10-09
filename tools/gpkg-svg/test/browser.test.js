import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { openGeoPackageFromBytes, parseColumns } from '../browser/sqlite-file-reader.js';
import { createExportController, describeError, exportDocumentToSvg, loadGeoPackageBytes, GENERIC_CONVERSION_ERROR } from '../browser/api.js';
import { convertGeoPackageToSvg } from '../node/convert.js';
import { openGeoPackage } from '../node/sqlite-reader.js';
import { convertGeoPackage, defaultSvgFileName } from '../core/pipeline.js';
import { GpkgSvgError } from '../core/errors.js';
import { createSyntheticGpkg, gpkgBlob, wkbPoint, wkbPolygon, SQUARE } from './fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'gpkg-svg-browser-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const NOW = new Date('2026-01-02T03:04:05.000Z');
const path = (name) => join(dir, name);
const bytesOf = (file) => new Uint8Array(readFileSync(file));
const make = (name, options) => { createSyntheticGpkg(path(name), options); return path(name); };
const main = make('main.gpkg');
const norm = (geometries) => JSON.stringify(geometries);
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

test('reader navigateur : couche, géométrie, CRS, nombre de features', () => {
  const { summary } = loadGeoPackageBytes(bytesOf(main));
  assert.deepEqual(summary, { layer: 'parcelle', geometry: 'MULTIPOLYGON', features: 3, skipped: 0, crs: 'EPSG:4326' });
});

test('même fixture Node / navigateur -> même géométrie normalisée', () => {
  const node = openGeoPackage(main);
  const browser = openGeoPackageFromBytes(bytesOf(main));
  assert.deepEqual(browser.layers, node.layers);
  assert.deepEqual(browser.getSrs(4326), node.getSrs(4326));
  assert.equal(norm(browser.readGeometries(browser.resolveLayer()).geometries), norm(node.readGeometries(node.resolveLayer()).geometries));
  node.close();
});

test('SVG navigateur identique au SVG de la CLI/Node (même contrat)', () => {
  const viaNode = convertGeoPackageToSvg(main, { now: NOW }).svg;
  const viaBrowser = exportDocumentToSvg(loadGeoPackageBytes(bytesOf(main)).document, { now: NOW }).svg;
  assert.equal(viaBrowser, viaNode);
});

test('SVG navigateur : Polygon, MultiPolygon, trous, evenodd, calque Cadastre, viewBox, Y inversé', () => {
  const { svg } = exportDocumentToSvg(loadGeoPackageBytes(bytesOf(main)).document, { now: NOW });
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /xmlns:inkscape="http:\/\/www\.inkscape\.org\/namespaces\/inkscape"/);
  assert.match(svg, /<g inkscape:groupmode="layer" inkscape:label="Cadastre" id="layer-cadastre">/);
  assert.match(svg, /viewBox="0 0 1200 [\d.]+"/);
  const paths = [...svg.matchAll(/<path [^>]*\bd="([^"]+)"[^>]*>/g)];
  assert.deepEqual(paths.map((m) => m[1].split('Z').filter(Boolean).length), [2, 2, 2]); // Polygon+trou, MultiPolygon, MultiPolygon+trou
  assert.ok(paths.every((m) => /fill-rule="evenodd"/.test(m[0])));
  // Y inversé : le premier sommet (lat la plus basse) a le Y le plus grand.
  const [first, , third] = paths[0][1].match(/M([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)L([\d.]+) ([\d.]+)/).slice(1).map(Number).reduce((a, n, i) => (i % 2 ? (a[a.length - 1].push(n), a) : [...a, [n]]), []);
  assert.ok(first[1] > third[1]);
});

test('métadonnées non sensibles, sans attributs ni coordonnées source', () => {
  const { svg } = exportDocumentToSvg(loadGeoPackageBytes(bytesOf(main)).document, { now: NOW });
  const meta = svg.match(/<mte:export[\s\S]*?\/>/)[0];
  for (const expected of ['layerName="parcelle"', 'declaredGeometryType="MULTIPOLYGON"', 'sourceCrs="EPSG:4326"', 'featureCount="3"', 'exportDatetime="2026-01-02T03:04:05.000Z"']) assert.ok(meta.includes(expected), expected);
  assert.doesNotMatch(svg, /SYNTH-|\bidu\b|48\.0|2\.0[0-9]|\.gpkg|NaN|Infinity/);
  assert.doesNotMatch(meta, /\b48\.|\b2\.0/);
});

test('nom de téléchargement par défaut', () => {
  assert.equal(defaultSvgFileName(new Date(2026, 9, 9, 12)), 'mon-territoire-cadastre-20261009.svg');
  assert.equal(defaultSvgFileName(new Date(2026, 0, 2)), 'mon-territoire-cadastre-20260102.svg');
});

test('reader navigateur == node:sqlite sur grosse table (pages intérieures, débordement, alias rowid)', () => {
  const p = path('big.gpkg');
  const rows = [];
  for (let i = 0; i < 300; i += 1) {
    // anneau de ~700 points => blob ~11 Ko : pages de débordement
    const ring = Array.from({ length: i % 7 === 0 ? 700 : 5 }, (_, k) => [2 + (k % 50) * 1e-4 + i * 1e-3, 48 + Math.floor(k / 50) * 1e-4]);
    ring.push(ring[0]);
    rows.push({ attr: `ATTR-${'x'.repeat(i % 40)}-${i}`, geom: gpkgBlob(wkbPolygon([ring])) });
  }
  createSyntheticGpkg(p, { layers: [{ name: 'parcelle', type: 'POLYGON', rows }] });
  const node = openGeoPackage(p);
  const browser = openGeoPackageFromBytes(bytesOf(p));
  const a = node.reader.readGeometryBlobs(node.layers[0]).map((b) => Buffer.from(b).toString('hex'));
  const b = [...browser.reader.readGeometryBlobs(browser.layers[0])].map((x) => Buffer.from(x).toString('hex'));
  assert.equal(b.length, 300);
  assert.deepEqual(b, a);
  assert.ok(statSync(p).size > 4096 * 10);
  node.close();
});

test('parseColumns : types, guillemets, parenthèses, INTEGER PRIMARY KEY', () => {
  const cols = parseColumns('CREATE TABLE "t x" (fid INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, "geo,m" BLOB, d DECIMAL(10,2), [é] TEXT DEFAULT (1), CHECK (d > 0))');
  assert.deepEqual(cols.map((c) => c.name), ['fid', 'geo,m', 'd', 'é']);
  assert.deepEqual(cols.map((c) => c.rowidAlias), [true, false, false, false]);
  assert.equal(parseColumns('CREATE TABLE t (a INTEGER, b TEXT, PRIMARY KEY (a))')[0].rowidAlias, true);
  assert.equal(code(() => parseColumns('CREATE TABLE t (a) WITHOUT ROWID')), 'INVALID_GPKG');
});

test('fichier invalide : vide, non GeoPackage, SQLite sans tables GPKG, tronqué', () => {
  assert.equal(code(() => loadGeoPackageBytes(new Uint8Array(0))), 'EMPTY_FILE');
  assert.equal(code(() => loadGeoPackageBytes(new TextEncoder().encode('ceci n’est pas un geopackage'.repeat(10)))), 'NOT_GPKG');
  const plain = path('plain.sqlite');
  const db = new DatabaseSync(plain); db.exec('CREATE TABLE t (a)'); db.close();
  assert.equal(code(() => loadGeoPackageBytes(bytesOf(plain))), 'INVALID_GPKG');
  const truncated = bytesOf(main).subarray(0, 4096 + 100);
  assert.throws(() => loadGeoPackageBytes(truncated), GpkgSvgError);
  const corrupt = bytesOf(main).slice(); corrupt.fill(0xff, 100, 4096);
  assert.throws(() => loadGeoPackageBytes(corrupt), GpkgSvgError);
});

test('couche ambiguë, aucune couche, couche parcelle absente', () => {
  const amb = make('amb.gpkg', { layers: [{ name: 'a', type: 'POLYGON' }, { name: 'b', type: 'POLYGON' }] });
  assert.equal(code(() => loadGeoPackageBytes(bytesOf(amb))), 'LAYER_REQUIRED');
  assert.match(describeError(new GpkgSvgError('LAYER_REQUIRED', 'x --layer')), /ambiguë/);
  const none = make('none.gpkg', { layers: [] });
  assert.equal(code(() => loadGeoPackageBytes(bytesOf(none))), 'NO_FEATURE_LAYER');
  assert.match(describeError(new GpkgSvgError('NO_FEATURE_LAYER', 'x')), /aucune couche vectorielle/);
  assert.match(describeError(new GpkgSvgError('LAYER_NOT_FOUND', 'x')), /« parcelle » est absente/);
});

test('géométrie non supportée (déclarée et WKB)', () => {
  const declared = make('pt.gpkg', { layers: [{ name: 'parcelle', type: 'POINT', rows: [{ attr: 'x', geom: gpkgBlob(wkbPoint([2, 48])) }] }] });
  assert.equal(code(() => loadGeoPackageBytes(bytesOf(declared))), 'UNSUPPORTED_GEOMETRY');
  const mixed = make('mixed.gpkg', { layers: [{ name: 'parcelle', type: 'GEOMETRY', rows: [{ attr: 'x', geom: gpkgBlob(wkbPoint([2, 48])) }] }] });
  assert.equal(code(() => loadGeoPackageBytes(bytesOf(mixed))), 'UNSUPPORTED_GEOMETRY');
  assert.match(describeError(new GpkgSvgError('UNSUPPORTED_GEOMETRY', 'x')), /non supporté/);
});

test('CRS non supporté', () => {
  const p = make('crs.gpkg');
  const db = new DatabaseSync(p);
  db.exec("UPDATE gpkg_spatial_ref_sys SET organization='EPSG', organization_coordsys_id=4269, definition='GEOGCS[\"NAD83\"]'");
  db.close();
  assert.equal(code(() => loadGeoPackageBytes(bytesOf(p))), 'UNSUPPORTED_CRS');
  assert.match(describeError(new GpkgSvgError('UNSUPPORTED_CRS', 'x')), /Système de coordonnées non supporté/);
});

test('erreur inattendue : message générique, jamais de stack', () => {
  const message = describeError(new TypeError('boom at /secret/stack.js:1:1'));
  assert.equal(message, GENERIC_CONVERSION_ERROR);
  for (const c of ['EMPTY_FILE', 'FILE_TOO_LARGE', 'NOT_GPKG', 'INVALID_GPKG', 'NO_FEATURE_LAYER', 'LAYER_REQUIRED', 'LAYER_NOT_FOUND', 'UNSUPPORTED_CRS', 'UNSUPPORTED_GEOMETRY', 'EMPTY_LAYER', 'INVALID_GEOMETRY', 'COORD_OUT_OF_RANGE']) {
    assert.doesNotMatch(describeError(new GpkgSvgError(c, 'at x.js:1:2')), /\.js|\bat\b.*:\d/);
  }
});

const fakeFile = (file) => { const data = readFileSync(file); return { size: data.length, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.length) }; };

test('contrôleur : sélection, résumé non sensible, export, libération au changement de fichier', async () => {
  const saved = [];
  const reports = [];
  const controller = createExportController({ save: (name, svg) => saved.push({ name, svg }), now: () => NOW, report: (d) => reports.push(d) });
  let state = await controller.selectFile(fakeFile(main));
  assert.equal(state.status, 'loaded');
  assert.deepEqual(Object.keys(state.summary).sort(), ['crs', 'features', 'geometry', 'layer', 'skipped']);
  assert.doesNotMatch(JSON.stringify(state), /SYNTH|48\.0|2\.0[0-9]/);
  state = controller.exportSvg();
  assert.equal(state.status, 'exported');
  assert.equal(saved.length, 1);
  assert.match(saved[0].name, /^mon-territoire-cadastre-\d{8}\.svg$/);
  assert.equal(saved[0].svg, convertGeoPackageToSvg(main, { now: NOW }).svg);
  // fichier invalide ensuite -> l'ancien document est libéré
  const junk = path('junk.gpkg'); writeFileSync(junk, 'x'.repeat(500));
  state = await controller.selectFile(fakeFile(junk));
  assert.equal(state.status, 'error');
  assert.match(state.message, /n'est pas un GeoPackage/);
  assert.equal(controller.exportSvg().status, 'error');
  assert.equal(saved.length, 1);
  assert.deepEqual(reports.map((r) => r.code), ['NOT_GPKG']);
  assert.equal((await controller.selectFile({ size: 0, arrayBuffer: async () => new ArrayBuffer(0) })).message, 'Le fichier est vide.');
});

test('aucun appel réseau ni persistance pendant import/conversion', async () => {
  const trap = (name) => () => { throw new Error(`forbidden: ${name}`); };
  const names = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'chrome'];
  const calls = [];
  const saved = Object.fromEntries(names.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  for (const n of names) Object.defineProperty(globalThis, n, { configurable: true, get() { calls.push(n); throw new Error(`forbidden: ${n}`); }, set: trap(n) });
  try {
    const controller = createExportController({ save: () => {}, now: () => NOW });
    assert.equal((await controller.selectFile(fakeFile(main))).status, 'loaded');
    assert.equal(controller.exportSvg().status, 'exported');
  } finally {
    for (const n of names) saved[n] ? Object.defineProperty(globalThis, n, saved[n]) : delete globalThis[n];
  }
  assert.deepEqual(calls, []);
});

test('code navigateur : aucun module Node, réseau, stockage ni WASM (sources)', () => {
  const files = ['core', 'browser'].flatMap((d) => readdirSync(new URL(`../${d}/`, import.meta.url)).map((f) => new URL(`../${d}/${f}`, import.meta.url)));
  const source = files.map((f) => readFileSync(f, 'utf8')).join('\n');
  assert.equal(source.match(/\bnode:|require\(|process\.|\bfs\b|child_process|(?<![A-Za-z])Buffer\b/), null);
  assert.equal(source.match(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|import\(|WebAssembly|localStorage|sessionStorage|indexedDB|chrome\.|\bcaches\b|document\.cookie/), null);
  assert.equal(source.match(/https?:\/\/(?!www\.w3\.org|www\.inkscape\.org|mon-territoire-export\.local)/), null);
});

// ---- bundle de l'extension (dist/) ---------------------------------------

const dist = (file) => new URL(`../../probe/dist/${file}`, import.meta.url);

test('dist : assets du moteur GPKG présents, manifest cohérent, aucun WASM requis', () => {
  const manifest = JSON.parse(readFileSync(dist('manifest.json'), 'utf8'));
  for (const entry of manifest.content_scripts) {
    for (const file of [...entry.js, ...(entry.css ?? [])]) assert.ok(statSync(dist(file)).size > 0, file);
  }
  const isolated = manifest.content_scripts.find((s) => !s.world).js;
  assert.ok(isolated.indexOf('gpkg-svg.js') >= 0 && isolated.indexOf('gpkg-svg.js') < isolated.indexOf('content-ui.js'));
  assert.deepEqual(manifest.permissions, ['activeTab']);
  assert.equal(manifest.content_security_policy, undefined); // pas de 'wasm-unsafe-eval' nécessaire
  const all = readdirSync(new URL('../../probe/dist/', import.meta.url), { recursive: true });
  assert.deepEqual(all.filter((f) => /\.(wasm|map)$/i.test(f)), []);
  assert.deepEqual(all.filter((f) => /\.gpkg$/i.test(f)), []);
  assert.deepEqual(all.filter((f) => /t00-f|autopsy/i.test(f)), []);
});

test('dist/gpkg-svg.js : classique, sans import Node/CDN/réseau, un seul global', () => {
  const code = readFileSync(dist('gpkg-svg.js'), 'utf8');
  assert.doesNotThrow(() => new vm.Script(code));
  assert.equal(code.match(/^\s*(?:import|export)\s/m), null);
  assert.equal(code.match(/\bnode:|require\(|process\.|WebAssembly|\bfetch\s*\(|XMLHttpRequest|sendBeacon|localStorage|indexedDB|sourceMappingURL|https?:\/\/(?!www\.w3\.org|www\.inkscape\.org|mon-territoire-export\.local)/), null);
  assert.equal(code.match(/DatabaseSync/), null);
  const context = vm.createContext({ TextDecoder });
  vm.runInContext(code, context);
  assert.deepEqual(Object.keys(context).sort(), ['MonTerritoireGpkgSvg', 'TextDecoder']);
});

test('dist/gpkg-svg.js exécuté seul dans un contexte vierge : même SVG que la CLI', () => {
  const context = vm.createContext({ TextDecoder });
  vm.runInContext(readFileSync(dist('gpkg-svg.js'), 'utf8'), context);
  context.input = Array.from(bytesOf(main));
  context.nowIso = NOW.toISOString();
  const svg = vm.runInContext('const a = MonTerritoireGpkgSvg; a.exportDocumentToSvg(a.loadGeoPackageBytes(new Uint8Array(input)).document, { now: new Date(nowIso) }).svg', context);
  assert.equal(svg, convertGeoPackageToSvg(main, { now: NOW }).svg);
});

test('interface : section Export cadastre, input fichier local, Diagnostic secondaire', () => {
  const ui = readFileSync(dist('content-ui.js'), 'utf8');
  assert.match(ui, /MON TERRITOIRE EXPORT/);
  assert.match(ui, /Export cadastre/);
  assert.ok(ui.includes('accept=\\".gpkg,application/geopackage+sqlite3,application/octet-stream\\"') || ui.includes('accept=".gpkg,application/geopackage+sqlite3,application/octet-stream"'));
  assert.match(ui, /Exporter en SVG/);
  assert.ok(ui.indexOf('Export cadastre') < ui.indexOf('<summary>Diagnostic</summary>'));
  for (const id of ['copy', 'download', 'copy-mvt', 'inspect-render', 'capture-engine', 'download-engine']) assert.ok(ui.includes(`id="${id}"`), id);
});

// ---- validation locale facultative (fichier réel, jamais versionné) ----------

const REAL = '/tmp/MT_Carto_20261009_Resultat_SIG.gpkg';
test('fichier réel (si présent) : reader navigateur == MVP-01, structure seulement', { skip: !statSync(REAL, { throwIfNoEntry: false }) }, () => {
  const { summary, document } = loadGeoPackageBytes(bytesOf(REAL));
  const node = convertGeoPackageToSvg(REAL, { now: NOW });
  assert.deepEqual(summary, node.summary);
  assert.equal(exportDocumentToSvg(document, { now: NOW }).svg, node.svg);
  const svg = node.svg;
  console.log(`# real-gpkg: layer=${summary.layer} geometry=${summary.geometry} features=${summary.features} crs=${summary.crs} svgBytes=${svg.length} paths=${svg.match(/<path /g).length} cadastreLayer=${svg.includes('inkscape:label="Cadastre"')}`);
});
