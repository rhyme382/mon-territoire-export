import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CADASTRE_VIEWPORT_STYLE, prepareViewportDocument, renderViewportDocument, viewportSvgFileName } from '../core/viewport-export.js';
import { exportVisibleCadastre } from '../browser/api.js';

const capture = {
  viewport: { width: 1000, height: 700 }, zoom: 17,
  features: [{ rings: [[[10, 10], [100, 10], [100, 90], [10, 90]], [[30, 30], [30, 50], [50, 50], [50, 30]]] }, { rings: [[[200, 200], [300, 200], [300, 300]]] }],
};
const NOW = new Date(2026, 9, 9, 12);

test('ExportDocument is multi-layer: a vector "Cadastre" layer with neutral id prefix and no cadastral data', () => {
  const doc = prepareViewportDocument(capture);
  assert.equal(doc.layers.length, 1);
  const [layer] = doc.layers;
  assert.deepEqual({ id: layer.id, label: layer.label, type: layer.type, idPrefix: layer.idPrefix }, { id: 'layer-cadastre', label: 'Cadastre', type: 'vector', idPrefix: 'cadastre-visible' });
  assert.equal(layer.features.length, 2);
  assert.deepEqual(layer.style, CADASTRE_VIEWPORT_STYLE);
  assert.deepEqual(Object.keys(layer.features[0]), ['polygons']);
});

test('SVG dimensions and viewBox equal the viewport, coordinates are kept as viewport pixels (Y down)', () => {
  const svg = renderViewportDocument(prepareViewportDocument(capture), { now: NOW });
  assert.match(svg, /width="1000" height="700" viewBox="0 0 1000 700"/);
  assert.match(svg, /d="M10 10L100 10L100 90L10 90ZM30 30L30 50L50 50L50 30Z"/);
});

test('Inkscape Cadastre layer, neutral ids, one path per feature, evenodd, centralized style', () => {
  const svg = renderViewportDocument(prepareViewportDocument(capture), { now: NOW });
  assert.match(svg, /<g inkscape:groupmode="layer"\s+inkscape:label="Cadastre"\s+id="layer-cadastre">/);
  assert.deepEqual([...svg.matchAll(/<path id="([^"]+)"/g)].map(m => m[1]), ['cadastre-visible-1', 'cadastre-visible-2']);
  assert.equal([...svg.matchAll(/<path /g)].length, 2);
  assert.match(svg, /fill="none"/); assert.match(svg, /fill-rule="evenodd"/); assert.match(svg, /vector-effect="non-scaling-stroke"/);
});

test('metadata is limited to generator, schema, source, zoom, viewport size, feature count and datetime', () => {
  const svg = renderViewportDocument(prepareViewportDocument(capture), { now: NOW });
  const meta = svg.match(/<mte:export([^>]*)\/>/s)[1];
  const keys = [...meta.matchAll(/(\w+)="/g)].map(m => m[1]).sort();
  assert.deepEqual(keys, ['converterSchema', 'exportDatetime', 'featureCount', 'generator', 'source', 'viewportHeight', 'viewportWidth', 'zoom']);
  assert.match(meta, /source="Leaflet runtime \/ VectorGrid"/);
  assert.match(meta, /featureCount="2"/);
});

test('SVG carries no geographic or tile data', () => {
  const svg = renderViewportDocument(prepareViewportDocument(capture), { now: NOW });
  assert.equal(svg.match(/lat|lng|lon|EPSG|idu|insee|section|https?:\/\/(?!www\.w3\.org|www\.inkscape\.org|mon-territoire-export\.local)/i), null);
});

test('file name has the date only', () => {
  assert.equal(viewportSvgFileName(NOW), 'mon-territoire-cadastre-visible-20261009.svg');
});

test('rejects malformed captures instead of writing a partial SVG', () => {
  for (const bad of [{ ...capture, viewport: { width: 0, height: 5 } }, { ...capture, features: [] }, { ...capture, features: [{ rings: [[[NaN, 1], [2, 2], [3, 3]]] }] }]) assert.throws(() => prepareViewportDocument(bad));
});

test('browser API produces file name + svg + non-sensitive summary', () => {
  const result = exportVisibleCadastre(capture, { now: NOW });
  assert.equal(result.fileName, 'mon-territoire-cadastre-visible-20261009.svg');
  assert.match(result.svg, /^<\?xml/);
  assert.deepEqual(result.summary, { features: 2, width: 1000, height: 700 });
});

test('viewport export makes no network call and reads no storage', async () => {
  const code = (await readFile(new URL('../core/viewport-export.js', import.meta.url), 'utf8')).replace(/\/\/.*$/gm, '');
  assert.equal(code.match(/\bfetch\b|XMLHttpRequest|localStorage|sessionStorage|navigator|window\./), null);
});
