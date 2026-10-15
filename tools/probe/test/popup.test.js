import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { bundleModules } from '../bundle-modules.mjs';
import { createSyntheticGpkg } from '../../gpkg-svg/test/fixture.js';

// MVP-07B: popup behaviour in a fake extension document (no browser). The popup is a separate extension page.
const popupSource = await readFile(new URL('../popup.js', import.meta.url), 'utf8');
const popupHtml = await readFile(new URL('../popup.html', import.meta.url), 'utf8');
const popupCss = await readFile(new URL('../popup.css', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
const bundle = await bundleModules(new URL('../../gpkg-svg/browser/api.js', import.meta.url), 'MonTerritoireGpkgSvg');
const ids = [...popupHtml.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
const flush = () => new Promise(resolve => setTimeout(resolve, 5));

function setup({ tabs = [{ id: 5 }], gpkg = true } = {}) {
  const elements = new Map(); const downloads = []; const sentToTab = [];
  for (const id of ids) { const handlers = {}; elements.set(id, { id, textContent: '', hidden: false, disabled: false, className: '', files: [], handlers, addEventListener(type, fn) { handlers[type] = fn; } }); }
  elements.get('toggle-mask').textContent = 'Masquer le masque';
  const portMessages = []; const portListeners = []; const disconnectListeners = []; const connects = [];
  const port = { postMessage: message => { portMessages.push(message); sentToTab.push(message); }, onMessage: { addListener: fn => portListeners.push(fn) }, onDisconnect: { addListener: fn => disconnectListeners.push(fn) } };
  const chrome = { runtime: {}, tabs: { query: async () => tabs, connect: (id, info) => { connects.push([id, info]); return port; } } };
  const document = { getElementById: id => elements.get(id), createElement: () => ({ click() { downloads.push({ name: this.download, href: this.href }); } }) };
  const context = vm.createContext({ document, chrome, console, setTimeout, Blob, TextDecoder, TextEncoder, URL: { createObjectURL: blob => { downloads.push({ blob }); return 'blob:popup'; }, revokeObjectURL() {} } });
  context.globalThis = context;
  if (gpkg) vm.runInContext(bundle, context, { filename: 'gpkg-svg.js' });
  vm.runInContext(popupSource, context, { filename: 'popup.js' });
  return { el: id => elements.get(id), port, portMessages, connects, send: message => { for (const fn of portListeners) fn(message); }, downloads, disconnect: () => { for (const fn of disconnectListeners) fn(); }, context };
}

test('popup document: product wording, one self-contained page, no remote resource, no inline script, no diagnostic wording', () => {
  assert.match(popupHtml, /MON TERRITOIRE EXPORT/);
  for (const text of ['Carte visible', 'Affichage', 'GeoPackage', 'Choisir un fichier', 'Masquer le masque']) assert.ok(popupHtml.includes(text), text);
  assert.equal((popupHtml.match(/Exporter en SVG/g) || []).length, 2);
  assert.doesNotMatch(popupHtml, /https?:\/\/|<script(?![^>]*\bsrc=)[^>]*>|\son[a-z]+=|<style|Diagnostic|A\/B|probe|activeTab|captureVisibleTab|VectorGrid|CORS/i);
  assert.deepEqual([...popupHtml.matchAll(/<script[^>]*src="([^"]+)"/g)].map(match => match[1]), ['gpkg-svg.js', 'popup.js']);
  assert.doesNotMatch(popupCss, /url\(|@import/);
  assert.match(popupCss, /width: 3[0-6]\dpx/);
});

test('manifest declares the popup and it is the only action entry point', () => {
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.deepEqual(manifest.permissions, ['activeTab']);
  assert.equal('host_permissions' in manifest, false);
  assert.equal(JSON.stringify(manifest).match(/"tabs"|webRequest|debugger|storage|<all_urls>/), null);
});

test('opening the popup connects to the active tab with the activeTab grant it just received, and asks for the mask state', async () => {
  const p = setup(); await flush();
  assert.equal(JSON.stringify(p.connects), JSON.stringify([[5, { name: 'mte-popup' }]]));
  assert.equal(JSON.stringify(p.portMessages), JSON.stringify([{ type: 'mte:mask-state' }]));
});

test('visible-map export: the click sends the command, phases are shown in plain words, the button is locked meanwhile', async () => {
  const p = setup(); await flush();
  p.el('export-visible').handlers.click();
  assert.equal(JSON.stringify(p.portMessages.at(-1)), JSON.stringify({ type: 'mte:export' }));
  assert.equal(p.el('visible-message').textContent, 'Préparation du fond…');
  assert.equal(p.el('export-visible').disabled, true);
  p.el('export-visible').handlers.click(); // double click while running
  assert.equal(p.portMessages.filter(message => message.type === 'mte:export').length, 1);
  p.send({ type: 'mte:status', phase: 'exporting', text: 'Export…' });
  assert.equal(p.el('visible-message').textContent, 'Export…');
  p.send({ type: 'mte:status', phase: 'done', text: 'Terminé.' });
  assert.equal(p.el('visible-message').textContent, 'Terminé.'); assert.equal(p.el('export-visible').disabled, false);
});

test('visible-map export: a simple user error is shown, then the button works again', async () => {
  const p = setup(); await flush();
  p.el('export-visible').handlers.click();
  p.send({ type: 'mte:status', phase: 'error', text: 'Activez la couche Cadastre.' });
  assert.equal(p.el('visible-message').textContent, 'Activez la couche Cadastre.'); assert.equal(p.el('visible-message').className, 'error');
  assert.equal(p.el('export-visible').disabled, false);
});

test('mask toggle: the command goes through the port and the label/message come back from the page', async () => {
  const p = setup(); await flush();
  p.el('toggle-mask').handlers.click();
  assert.equal(JSON.stringify(p.portMessages.at(-1)), JSON.stringify({ type: 'mte:mask-toggle' }));
  p.send({ type: 'mte:mask', state: 'hidden', label: 'Afficher le masque' });
  assert.equal(p.el('toggle-mask').textContent, 'Afficher le masque');
  p.send({ type: 'mte:mask', state: 'absent', label: 'Masquer le masque', message: 'Masque non détecté' });
  assert.equal(p.el('mask-message').textContent, 'Masque non détecté');
});

test('on a tab without the content script the popup says so in plain words and disables the page commands', async () => {
  const p = setup(); await flush();
  p.disconnect();
  assert.equal(p.el('visible-message').textContent, 'Ouvrez Mon Territoire dans cet onglet.');
  assert.equal(p.el('export-visible').disabled, true); assert.equal(p.el('toggle-mask').disabled, true);
  const none = setup({ tabs: [] }); await flush();
  assert.equal(none.el('visible-message').textContent, 'Ouvrez Mon Territoire dans cet onglet.');
});

test('GeoPackage: chosen file is parsed locally in the popup, shows only layer and parcel count, exports a download', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'popup-gpkg-'));
  try {
    createSyntheticGpkg(join(directory, 'a.gpkg'));
    const bytes = new Uint8Array(readFileSync(join(directory, 'a.gpkg')));
    const p = setup(); await flush();
    assert.match(popupHtml, /id="export-svg"[^>]*\sdisabled/, 'the GeoPackage export starts disabled');
    const file = { name: 'a.gpkg', size: bytes.length, arrayBuffer: async () => vm.runInContext(`new Uint8Array(${JSON.stringify([...bytes])}).buffer`, p.context) /* same realm as the popup */ };
    p.el('gpkg-file').files = [file];
    await p.el('gpkg-file').handlers.change(); await flush();
    assert.equal(p.el('gpkg-message').textContent, 'Fichier prêt.');
    assert.equal(p.el('sum-layer').textContent, 'parcelle'); assert.equal(p.el('sum-features').textContent, '3');
    assert.equal(p.el('gpkg-summary').hidden, false); assert.equal(p.el('export-svg').disabled, false);
    assert.equal(p.el('gpkg-name').textContent, 'a.gpkg');
    p.el('export-svg').handlers.click();
    assert.ok(p.downloads.some(item => item.blob), 'a blob download was created while the popup is open');
    assert.match(p.el('gpkg-message').textContent, /^SVG généré : .*\.svg$/);
    assert.equal(p.portMessages.some(message => message.type === 'mte:export'), false, 'the GeoPackage flow never touches the page port');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('GeoPackage: an invalid file gives a plain error and no export', async () => {
  const p = setup(); await flush();
  p.el('gpkg-file').files = [{ name: 'x.gpkg', size: 4, arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer }];
  await p.el('gpkg-file').handlers.change(); await flush();
  assert.equal(p.el('gpkg-message').className, 'error'); assert.ok(p.el('gpkg-message').textContent.length > 0);
  assert.equal(p.el('export-svg').disabled, true);
});

test('popup code: no persistence, no network, no extra permission API, no diagnostic wording', () => {
  assert.equal(popupSource.match(/localStorage|sessionStorage|indexedDB|chrome\.storage|chrome\.downloads|chrome\.debugger|chrome\.webRequest|fetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|new\s+Worker|chrome\.permissions|chrome\.scripting|cookie|import\s*\(|eval\s*\(/i), null);
  assert.equal(popupSource.match(/\bconsole\./), null);
  assert.deepEqual([...new Set(popupSource.match(/chrome\.[a-zA-Z]+\.[a-zA-Z]+/g))].sort(), ['chrome.runtime.lastError', 'chrome.tabs.connect', 'chrome.tabs.query']);
  const code = popupSource.replace(/\/\/.*$/gm, '');
  for (const wording of ['Diagnostic', 'diagnostic', 'activeTab', 'captureVisibleTab', 'VectorGrid', 'A/B', 'probe']) assert.equal(code.includes(wording), false, wording);
});
