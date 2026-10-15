import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createMaskControl, MASK_PANE_SELECTOR, MASK_LABELS } from '../mask-control.js';

// Fake document that records every property write on the targeted pane.
function fakeDocument({ withMask = true, inline = '' } = {}) {
  const writes = []; const queries = [];
  const style = new Proxy({ display: inline }, { set(target, key, value) { writes.push(key); target[key] = value; return true; } });
  const pane = { style, className: 'leaflet-mask-pane' };
  return { pane, writes, queries, querySelector(selector) { queries.push(selector); return withMask ? pane : null; } };
}

test('hides then shows the mask pane through style.display only', () => {
  const doc = fakeDocument(); const control = createMaskControl(doc);
  assert.equal(control.state(), 'visible'); assert.equal(control.label(), 'Masquer le masque');
  assert.equal(control.toggle(), 'hidden'); assert.equal(doc.pane.style.display, 'none');
  assert.equal(control.label(), 'Afficher le masque');
  assert.equal(control.toggle(), 'visible'); assert.equal(doc.pane.style.display, '');
  assert.equal(control.label(), 'Masquer le masque');
});

test('restores a pre-existing inline display value', () => {
  const doc = fakeDocument({ inline: 'block' }); const control = createMaskControl(doc);
  control.toggle(); control.toggle();
  assert.equal(doc.pane.style.display, 'block');
});

test('targets only .leaflet-mask-pane and writes only style.display', () => {
  const doc = fakeDocument(); const control = createMaskControl(doc);
  control.toggle(); control.toggle();
  assert.equal(MASK_PANE_SELECTOR, '.leaflet-mask-pane');
  assert.deepEqual([...new Set(doc.queries)], ['.leaflet-mask-pane']);
  assert.deepEqual([...new Set(doc.writes)], ['display']);
  assert.deepEqual(Object.keys(doc.pane).sort(), ['className', 'style']);
});

test('missing mask is reported as absent and nothing is simulated', () => {
  const doc = fakeDocument({ withMask: false }); const control = createMaskControl(doc);
  assert.equal(control.state(), 'absent'); assert.equal(control.toggle(), 'absent');
  assert.equal(control.label(), MASK_LABELS.absent);
  assert.deepEqual(doc.writes, []);
});

test('state follows the DOM, so a reload or external change cannot desynchronise the label', () => {
  const doc = fakeDocument(); const control = createMaskControl(doc);
  control.toggle(); doc.pane.style.display = '';
  assert.equal(control.label(), 'Masquer le masque');
});

test('mask control has no persistence, network, authorization or permission surface', async () => {
  const source = await readFile('tools/probe/mask-control.js', 'utf8');
  assert.equal(source.match(/localStorage|sessionStorage|chrome\.|indexedDB|cookie|fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|isAllowed|insees|user_data|setAttribute|classList|removeChild|\.remove\(/i), null);
  const manifest = JSON.parse(await readFile('tools/probe/manifest.json', 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab']);
  assert.equal(manifest.host_permissions, undefined);
});

test('MVP-07B: the mask command comes from the popup port; the page has no mask button', async () => {
  const ui = await readFile('tools/probe/content-ui.js', 'utf8');
  const popup = await readFile('tools/probe/popup.js', 'utf8');
  const html = await readFile('tools/probe/popup.html', 'utf8');
  assert.match(ui, /message\?\.type === 'mte:mask-toggle'/);
  assert.match(ui, /maskControl\?\.toggle\(\)/);
  assert.doesNotMatch(ui, /id="toggle-mask"/);
  assert.match(popup, /type: 'mte:mask-toggle'/);
  assert.match(popup, /maskButton\.textContent = message\.label/);
  assert.match(html, /id="toggle-mask"/);
  assert.ok(html.indexOf('Carte visible') < html.indexOf('Affichage') && html.indexOf('Affichage') < html.indexOf('GeoPackage'));
});
