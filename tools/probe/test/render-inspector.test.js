import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLeafletRender, sanitizeRasterUrl } from '../render-inspector.js';

function node(tagName, options = {}) {
  return {
    tagName, className: options.className || '', attributes: options.attributes || {},
    width: options.width || 0, height: options.height || 0, src: options.src || '', currentSrc: options.currentSrc || '',
    getAttribute(name) { return this.attributes[name] ?? null; },
    getBoundingClientRect() { return options.rect || { left: 0, top: 0, width: 0, height: 0 }; },
    querySelectorAll(selector) { return (options.queries || {})[selector] || []; }
  };
}
function fixture() {
  const longD = `M0 0 ${'L1 1 '.repeat(600)}`;
  const svg = node('svg', { attributes: { viewBox: '0 0 256 256', width: '256', height: '256' }, rect: { left: 10.4, top: 20.6, width: 256.1, height: 256.9 }, queries: {
    'path,polyline,polygon,circle,rect': [
      node('path', { attributes: { d: 'M0 0 L4 4', fill: '#fff', stroke: '#000', 'stroke-width': '2' }, rect: { left: 11.4, top: 22.6, width: 10.2, height: 11.7 } }),
      node('path', { attributes: { d: longD, fill: '#fff', stroke: '#000', 'stroke-width': '2' }, rect: { left: 12.4, top: 23.6, width: 10.2, height: 11.7 } }),
      node('path', { attributes: { fill: '#fff' }, rect: { left: 13, top: 24, width: 1, height: 1 } }),
      ...Array.from({ length: 12 }, () => node('polygon', { attributes: { points: '0,0 1,1' } }))
    ]
  } });
  const canvas = node('canvas', { width: 512, height: 256 });
  const image = node('img', { className: 'leaflet-tile', currentSrc: 'https://tiles.example.test/base/17/66000/44000.png?token=secret#x' });
  const overlay = node('div', { className: 'leaflet-overlay-pane', queries: { 'svg': [svg], 'canvas': [canvas], 'img': [image] } });
  const mask = node('div', { className: 'leaflet-mask-pane', queries: { 'svg': [], 'canvas': [], 'img': [] } });
  const tiles = node('div', { className: 'leaflet-tile-pane', queries: { 'svg': [], 'canvas': [], 'img': [image] } });
  const container = node('div', { className: 'leaflet-container', rect: { left: 10, top: 20, width: 500, height: 400 }, queries: { '.leaflet-pane': [overlay, mask, tiles] } });
  const document = { querySelectorAll: selector => selector === '.leaflet-container' ? [container] : [] };
  return { document, longD };
}
const styles = element => ({ transform: element.className.includes('overlay') ? 'matrix(1, 0, 0, 1, 12, 24)' : 'none', opacity: '0.8', display: 'block', visibility: 'visible', zIndex: '400' });

test('inspects overlay SVG paths, transforms, and local rounded boxes without raw d', () => {
  const report = inspectLeafletRender(fixture().document, styles);
  const overlay = report.containers[0].panes.find(p => p.name === 'overlay');
  assert.equal(overlay.counts.svg, 1); assert.equal(overlay.counts.path, 3); assert.equal(overlay.transform, 'matrix(1, 0, 0, 1, 12, 24)');
  assert.deepEqual(overlay.svg[0].paths[0].bbox, { x: 1, y: 3, width: 10, height: 12 });
  assert.equal(JSON.stringify(report).includes('M0 0'), false);
});
test('marks an observed mask pane without changing it and inventories raster and canvas metadata', () => {
  const report = inspectLeafletRender(fixture().document, styles);
  assert.equal(report.containers[0].maskPanePresent, true);
  assert.equal(report.containers[0].panes.find(p => p.name === 'tile').counts.img, 1);
  assert.deepEqual(report.containers[0].panes.find(p => p.name === 'overlay').canvas, [{ width: 512, height: 256 }]);
  assert.equal(JSON.stringify(report).match(/getImageData|toDataURL|secret/), null);
});
test('path statistics work without d and retain only statistics for very long d', () => {
  const report = inspectLeafletRender(fixture().document, styles);
  const paths = report.containers[0].panes.find(p => p.name === 'overlay').svg[0].paths;
  assert.equal(paths[1].d.present, true); assert.equal(paths[1].d.length > 512, true);
  assert.deepEqual(paths[2].d, { present: false, length: 0, commands: 0 });
  assert.equal(JSON.stringify(paths[1]).includes(fixture().longD), false);
});
test('sanitizes raster URLs by removing query, fragment and tile x/y', () => {
  assert.deepEqual(sanitizeRasterUrl('https://tiles.example.test/base/17/66000/44000.png?token=secret#x'), { hostname: 'tiles.example.test', pathname: '/base/{tile}.png' });
});
test('never exports text, business identifiers or geographic coordinates', () => {
  const report = inspectLeafletRender(fixture().document, styles);
  const json = JSON.stringify({ ...report, hostile: undefined });
  assert.equal(/cadastre|parcel|123456|48\.8|2\.3/i.test(json), false);
  assert.equal(json.includes('token'), false);
});
test('bounds samples to ten per signature and one hundred total', () => {
  const report = inspectLeafletRender(fixture().document, styles);
  assert.ok(report.candidateGroups.every(group => group.examples.length <= 10));
  assert.ok(report.candidateGroups.reduce((sum, group) => sum + group.examples.length, 0) <= 100);
});
