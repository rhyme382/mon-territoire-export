import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseGpkgHeader, parseGpkgGeometry, parseWkb } from '../core/gpkg-geometry.js';
import { openGeoPackage } from '../node/sqlite-reader.js';
import { convertGeoPackageToSvg } from '../node/convert.js';
import { computeBounds, createSvgTransform } from '../core/svg-transform.js';
import { webMercator } from '../core/projection.js';
import { GpkgSvgError } from '../core/errors.js';
import { createSyntheticGpkg, gpkgBlob, wkbPolygon, wkbMultiPolygon, wkbPoint, SQUARE, HOLE } from './fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'gpkg-svg-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const NOW = new Date('2026-01-02T03:04:05.000Z');
const gpkgPath = join(dir, 'synthetic.gpkg');
createSyntheticGpkg(gpkgPath);
const convert = (opts = {}) => convertGeoPackageToSvg(gpkgPath, { now: NOW, ...opts });

test('découvre la couche parcelle et la choisit par défaut', () => {
  const gpkg = openGeoPackage(gpkgPath);
  assert.deepEqual(gpkg.layers.map((l) => l.tableName), ['parcelle']);
  assert.equal(gpkg.resolveLayer().tableName, 'parcelle');
  assert.equal(gpkg.resolveLayer('parcelle').geometryType, 'MULTIPOLYGON');
  gpkg.close();
});

test('lit le CRS depuis gpkg_spatial_ref_sys', () => {
  const gpkg = openGeoPackage(gpkgPath);
  const srs = gpkg.getSrs(gpkg.resolveLayer().srsId);
  assert.equal(srs.authority, 'EPSG');
  assert.equal(srs.code, 4326);
  gpkg.close();
});

test('parse l’en-tête GeoPackage (LE, BE, enveloppe, vide)', () => {
  const wkb = wkbPolygon([SQUARE]);
  const le = parseGpkgHeader(gpkgBlob(wkb, { envelope: true }));
  assert.deepEqual([le.srsId, le.envelopeBytes, le.wkbOffset, le.littleEndian], [4326, 32, 40, true]);
  const be = parseGpkgHeader(gpkgBlob(wkb, { le: false, srsId: 2154 }));
  assert.deepEqual([be.srsId, be.littleEndian, be.wkbOffset], [2154, false, 8]);
  assert.equal(parseGpkgHeader(gpkgBlob(Buffer.alloc(0), { empty: true })).empty, true);
  assert.equal(parseGpkgGeometry(gpkgBlob(Buffer.alloc(0), { empty: true })), null);
  assert.throws(() => parseGpkgHeader(Buffer.from('XX000000')), GpkgSvgError);
});

test('parse WKB Polygon little endian avec trou', () => {
  const g = parseWkb(wkbPolygon([SQUARE, HOLE]));
  assert.equal(g.type, 'Polygon');
  assert.equal(g.polygons.length, 1);
  assert.equal(g.polygons[0].length, 2);
  assert.deepEqual(g.polygons[0][0][0], [2.0, 48.0]);
});

test('parse WKB big endian, MultiPolygon et Z', () => {
  const g = parseWkb(wkbMultiPolygon([[SQUARE], [SQUARE, HOLE]], { le: false }));
  assert.equal(g.type, 'MultiPolygon');
  assert.deepEqual(g.polygons.map((p) => p.length), [1, 2]);
  const z = parseWkb(wkbPolygon([SQUARE], { z: true }));
  assert.deepEqual(z.polygons[0][0][1], [2.01, 48.0]);
});

test('WKB tronqué -> erreur explicite', () => {
  assert.throws(() => parseWkb(wkbPolygon([SQUARE]).subarray(0, 30)), /tronqué/);
});

test('emprise et inversion Y', () => {
  const polys = [[[[0, 0], [10, 0], [10, 5], [0, 5], [0, 0]]]];
  const b = computeBounds(polys);
  assert.deepEqual(b, { minX: 0, minY: 0, maxX: 10, maxY: 5 });
  const t = createSvgTransform(b, { width: 120, padding: 10 });
  assert.deepEqual(t.apply([0, 5]), [10, 10]); // haut gauche cartographique -> haut SVG
  assert.deepEqual(t.apply([10, 0]), [110, 60]); // bas droite -> bas SVG
});

test('proportions conservées et padding appliqué', () => {
  const b = { minX: 0, minY: 0, maxX: 10, maxY: 5 };
  const t = createSvgTransform(b, { width: 220, padding: 10 });
  assert.equal(t.width, 220);
  assert.equal(t.height, 100 + 20);
  const [x0, y0] = t.apply([0, 5]);
  const [x1, y1] = t.apply([10, 0]);
  assert.equal(x0, 10);
  assert.equal(y0, 10);
  assert.equal(t.width - x1, 10);
  assert.equal(t.height - y1, 10);
  assert.equal((x1 - x0) / (y1 - y0), 2);
  assert.throws(() => createSvgTransform(b, { width: 100, padding: 50 }), /padding/);
});

test('Web Mercator : X linéaire, Y étiré par latitude (pas de plan lon/lat brut)', () => {
  const [x1, y1] = webMercator([1, 0]);
  assert.ok(Math.abs(y1) < 1e-9);
  assert.ok(Math.abs(x1 - 111319.49) < 0.1);
  const [, yLow] = webMercator([0, 0.1]);
  const [, yHigh] = webMercator([0, 60.1]);
  const [, y60] = webMercator([0, 60]);
  assert.ok((yHigh - y60) > 1.9 * yLow);
  assert.throws(() => webMercator([0, 89]), GpkgSvgError);
});

test('SVG : groupe Inkscape Cadastre, viewBox, namespaces, un path par feature', () => {
  const { svg, summary } = convert();
  assert.match(svg, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /xmlns:inkscape="http:\/\/www\.inkscape\.org\/namespaces\/inkscape"/);
  assert.match(svg, /<g inkscape:groupmode="layer" inkscape:label="Cadastre" id="layer-cadastre">/);
  assert.match(svg, /viewBox="0 0 1200 [\d.]+"/);
  assert.equal(svg.match(/<path /g).length, 3);
  assert.deepEqual([summary.layer, summary.geometry, summary.features, summary.crs], ['parcelle', 'MULTIPOLYGON', 3, 'EPSG:4326']);
});

test('trou : path compound evenodd avec plusieurs sous-chemins ; MultiPolygon non aplati', () => {
  const { svg } = convert();
  const paths = [...svg.matchAll(/<path [^>]*\bd="([^"]+)"[^>]*>/g)].map((m) => m);
  assert.equal(paths.length, 3);
  const subpaths = (d) => d.split('Z').filter(Boolean).length;
  assert.deepEqual(paths.map((m) => subpaths(m[1])), [2, 2, 2]); // trou ; 2 parties ; partie + trou
  for (const m of paths) assert.match(m[0], /fill-rule="evenodd"/);
  assert.match(paths[0][0], /fill="none" fill-rule="evenodd" stroke="#000000" stroke-width="1" vector-effect="non-scaling-stroke"/);
});

test('métadonnées non sensibles', () => {
  const { svg } = convert();
  const meta = svg.match(/<mte:export[\s\S]*?\/>/)[0];
  for (const expected of ['generator="mon-territoire-export"', 'converterSchema="gpkg-to-svg/1"', 'sourceFormat="GeoPackage"', 'layerName="parcelle"', 'declaredGeometryType="MULTIPOLYGON"', 'sourceCrs="EPSG:4326"', 'featureCount="3"', 'exportDatetime="2026-01-02T03:04:05.000Z"', 'transformation="']) {
    assert.ok(meta.includes(expected), expected);
  }
  assert.doesNotMatch(meta, /synthetic\.gpkg|\/tmp|\.gpkg/i);
});

test('vie privée : ni attributs ni coordonnées source dans le SVG', () => {
  const { svg } = convert();
  assert.doesNotMatch(svg, /SYNTH-/);
  assert.doesNotMatch(svg, /\bidu\b/);
  assert.doesNotMatch(svg, /48\.0|2\.0[0-9]|NaN|Infinity/);
  const meta = svg.match(/<mte:export[\s\S]*?\/>/)[0];
  assert.doesNotMatch(meta, /\b48\.|\b2\.0/);
  assert.doesNotMatch(svg, new RegExp(dir.replaceAll('/', '\\/')));
});

test('couche absente / plusieurs couches sans parcelle -> demande --layer', () => {
  const p = join(dir, 'multi.gpkg');
  createSyntheticGpkg(p, { layers: [{ name: 'a', type: 'POLYGON' }, { name: 'b', type: 'POLYGON' }] });
  assert.throws(() => convertGeoPackageToSvg(p), /--layer/);
  assert.equal(convertGeoPackageToSvg(p, { layer: 'b' }).summary.layer, 'b');
  assert.throws(() => convertGeoPackageToSvg(p, { layer: 'zz' }), /introuvable/);
  const single = join(dir, 'single.gpkg');
  createSyntheticGpkg(single, { layers: [{ name: 'autre', type: 'POLYGON' }] });
  assert.equal(convertGeoPackageToSvg(single).summary.layer, 'autre');
});

test('type déclaré non supporté -> erreur explicite', () => {
  const p = join(dir, 'point.gpkg');
  createSyntheticGpkg(p, { layers: [{ name: 'parcelle', type: 'POINT', rows: [{ attr: 'x', geom: gpkgBlob(wkbPoint([2, 48])) }] }] });
  assert.throws(() => convertGeoPackageToSvg(p), /POINT.*non supporté/);
});

test('WKB non supporté dans une couche GEOMETRY -> erreur explicite', () => {
  const p = join(dir, 'mixed.gpkg');
  createSyntheticGpkg(p, { layers: [{ name: 'parcelle', type: 'GEOMETRY', rows: [{ attr: 'x', geom: gpkgBlob(wkbPoint([2, 48])) }] }] });
  assert.throws(() => convertGeoPackageToSvg(p), /non supporté/);
});

test('GPKG invalide -> erreur explicite', () => {
  const junk = join(dir, 'junk.gpkg');
  writeFileSync(junk, 'ceci n’est pas une base sqlite');
  assert.throws(() => convertGeoPackageToSvg(junk), /invalide/);
  assert.throws(() => convertGeoPackageToSvg(join(dir, 'absent.gpkg')), /introuvable/);
  const plain = join(dir, 'plain.sqlite');
  // SQLite valide mais sans tables GeoPackage
  const emptyDb = new (awaitableSqlite())(plain);
  emptyDb.exec('CREATE TABLE t (a)');
  emptyDb.close();
  assert.throws(() => convertGeoPackageToSvg(plain), /tables système GeoPackage/);
});

function awaitableSqlite() {
  return process.getBuiltinModule('node:sqlite').DatabaseSync;
}

test('CLI : succès, sortie concise, erreur -> code non nul', () => {
  const cli = new URL('../cli.js', import.meta.url).pathname;
  const out = join(dir, 'out.svg');
  const ok = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--input', gpkgPath, '--output', out, '--width', '800', '--padding', '5'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /layer: parcelle\ngeometry: MULTIPOLYGON\nfeatures: 3\ncrs: EPSG:4326\noutput: /);
  assert.doesNotMatch(ok.stdout, /SYNTH/);
  const bad = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', cli, '--input', join(dir, 'nope.gpkg'), '--output', out], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /Erreur : /);
});
