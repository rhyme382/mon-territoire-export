import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('generated content UI starts when browser location is already globally bound', async () => {
  const listeners = new Map();
  let readyEvents = 0;
  const document = {
    documentElement: null,
    addEventListener(type, listener) { listeners.set(type, listener); },
    dispatchEvent(event) { if (event.type === 'mon-territoire-probe:ready') readyEvents++; }
  };
  const context = vm.createContext({ document, CustomEvent: class { constructor(type) { this.type = type; } } });
  vm.runInContext('const location = { href: "https://carto.monterritoire.fr/" };', context);

  const generatedScript = await readFile('tools/probe/dist/content-ui.js', 'utf8');
  assert.doesNotThrow(() => vm.runInContext(generatedScript, context));
  assert.equal(readyEvents, 1);
  assert.ok(listeners.has('mon-territoire-probe:ready-request'));
});
