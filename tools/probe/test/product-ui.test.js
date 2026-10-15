import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// MVP-07B: the extension injects NO visible interface into Mon Territoire. The product controls live in the extension popup
// (popup.html); internal diagnostics stay in a detached element that is never attached to the document.
const source = await readFile(new URL('../content-ui.js', import.meta.url), 'utf8');

// A minimal DOM that records every node that gets attached anywhere under the document.
function run({ ready = true } = {}) {
  const created = []; const attached = []; let shadowRoots = 0; const listeners = new Map();
  const makeElement = tag => {
    const element = { tag, innerHTML: '', textContent: '', id: '', style: {}, children: [], attributes: {}, setAttribute(key, value) { this.attributes[key] = value; }, getAttribute(key) { return this.attributes[key] ?? null; },
      append(...nodes) { for (const node of nodes) { attached.push(node); this.children.push(node); } }, appendChild(node) { attached.push(node); this.children.push(node); return node; }, prepend(...nodes) { for (const node of nodes) { attached.push(node); this.children.unshift(node); } }, insertBefore(node) { attached.push(node); this.children.push(node); return node; },
      attachShadow() { shadowRoots++; return { innerHTML: '', querySelector: () => null }; }, querySelector(selector) { return this.innerHTML.includes(`id="${selector.slice(1)}"`) ? { addEventListener() {}, textContent: '', hidden: false, disabled: false } : null; } };
    created.push(element); return element;
  };
  const documentElement = makeElement('html');
  const document = { documentElement: ready ? documentElement : null, createElement: makeElement, addEventListener(type, fn) { listeners.set(type, fn); }, dispatchEvent() {}, hidden: false, querySelector: () => null, body: makeElement('body') };
  const context = vm.createContext({ document, console, URL, CustomEvent: class {}, location: { href: 'https://carto.monterritoire.fr/' }, chrome: undefined, setTimeout, performance: { getEntriesByType: () => [] }, getComputedStyle: () => ({}) });
  context.window = context;
  vm.runInContext(source.replace(/^export /gm, ''), context, { filename: 'content-ui.js' });
  if (!ready) { document.documentElement = documentElement; listeners.get('DOMContentLoaded')?.(); }
  return { created, attached, documentElement, document, shadowRoots: () => shadowRoots };
}
const subtree = element => [element, ...element.children.flatMap(subtree)];
const visibleMarkup = document => subtree(document.documentElement).concat(subtree(document.body)).map(node => `${node.id} ${node.innerHTML} ${node.textContent}`).join('\n');

test('no visible extension element is attached to the page, immediately or after DOMContentLoaded (fails if MON TERRITOIRE EXPORT comes back)', () => {
  for (const ready of [true, false]) {
    const { attached, documentElement, document, shadowRoots } = run({ ready });
    assert.equal(attached.length, 0, 'nothing is appended anywhere');
    assert.equal(shadowRoots(), 0, 'no shadow root is attached');
    assert.equal(documentElement.children.length, 0);
    const markup = visibleMarkup(document);
    assert.doesNotMatch(markup, /MON TERRITOIRE EXPORT|mon-territoire-probe-ui|Exporter la carte visible|Masquer le masque|Export cadastre depuis GeoPackage|GeoPackage|Diagnostic/i);
    assert.equal(Object.keys(documentElement.attributes).some(key => key === 'data-mon-territoire-export-ui'), false);
  }
});

test('content script source carries no product UI markup and the manifest injects no CSS', async () => {
  assert.doesNotMatch(source, /MON TERRITOIRE EXPORT|attachShadow|id="export-visible"|id="toggle-mask"|id="gpkg-file"|mon-territoire-probe-ui/);
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  for (const entry of manifest.content_scripts) assert.equal('css' in entry, false);
});

test('internal diagnostics survive in a detached element that is never attached to the page', () => {
  const { created, attached } = run();
  const detached = created.find(element => element.innerHTML.includes('id="vc-diagnostic"'));
  assert.ok(detached, 'diagnostic markup exists');
  for (const id of ['vb-diagnostic', 'vs-capture-a', 'vm-capture-a', 'capture-engine', 'download']) assert.ok(detached.innerHTML.includes(`id="${id}"`), id);
  assert.equal(attached.includes(detached), false);
});

test('popup commands are accepted only from the extension itself, over the mte-popup port', () => {
  assert.match(source, /port\?\.name !== 'mte-popup' \|\| port\.sender\?\.id !== globalThis\.chrome\.runtime\.id/);
  assert.doesNotMatch(source, /mte:export-request/);
});

test('no product status message uses diagnostic wording', async () => {
  const messages = await readFile(new URL('../visible-cadastre-export.js', import.meta.url), 'utf8');
  const block = messages.match(/const VCX_MESSAGES = \{[\s\S]*?\n\};/)[0];
  assert.doesNotMatch(block, /Cadastre visible|Cadastre :|Sélection :/);
  assert.doesNotMatch(source, /stateLines/);
});
