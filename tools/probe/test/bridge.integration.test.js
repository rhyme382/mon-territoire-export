import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

class EventBus {
  #listeners = new Map();
  addEventListener(type, listener) { this.#listeners.set(type, [...(this.#listeners.get(type) || []), listener]); }
  dispatchEvent(event) { for (const listener of this.#listeners.get(event.type) || []) listener(event); return true; }
}

function createSharedDocument() {
  const bus = new EventBus();
  const attributes = new Map();
  const nodes = new Map();
  const shadow = { querySelector: selector => {
    if (!nodes.has(selector)) nodes.set(selector, { addEventListener() {}, textContent: '' });
    return nodes.get(selector);
  }, innerHTML: '' };
  const element = {
    ...bus,
    getAttribute: key => attributes.get(key) || null,
    setAttribute: (key, value) => attributes.set(key, value),
    append() {},
    querySelector: selector => shadow.querySelector(selector)
  };
  return { ...bus, root: shadow, documentElement: element, createElement: () => element, addEventListener: bus.addEventListener.bind(bus), dispatchEvent: bus.dispatchEvent.bind(bus) };
}

function createDocumentWithoutRoot() {
  const bus = new EventBus();
  const attributes = new Map();
  const nodes = new Map();
  const shadow = { querySelector: selector => {
    if (!nodes.has(selector)) nodes.set(selector, { addEventListener() {}, textContent: '' });
    return nodes.get(selector);
  }, innerHTML: '' };
  const root = {
    getAttribute: key => attributes.get(key) || null,
    setAttribute: (key, value) => attributes.set(key, value),
    append() {}
  };
  const document = {
    ...bus,
    documentElement: null,
    createElement: () => ({ id: '', querySelector: selector => shadow.querySelector(selector) }),
    addEventListener: bus.addEventListener.bind(bus),
    dispatchEvent: bus.dispatchEvent.bind(bus)
  };
  return { document, root, shadow };
}

function context(bus, document, performance) {
  const sandbox = {
    document,
    location: { href: 'https://carto.monterritoire.fr/' },
    performance,
    fetch: () => Promise.resolve({}),
    EventTarget,
    URL,
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    MutationObserver: class { observe() {} },
    getComputedStyle: () => ({ transform: 'none' }),
    innerWidth: 0,
    innerHeight: 0,
    setTimeout,
    addEventListener: bus.addEventListener.bind(bus),
    dispatchEvent: bus.dispatchEvent.bind(bus)
  };
  sandbox.window = sandbox;
  return vm.createContext(sandbox);
}

async function runScript(file, sandbox, suffix = '') {
  const source = (await readFile(new URL(`../${file}`, import.meta.url), 'utf8')).replace(/^export /gm, '') + suffix;
  vm.runInContext(source, sandbox, { filename: file });
}

test('bridges initial Resource Timing facts from MAIN to the isolated aggregator', async () => {
  const document = createSharedDocument();
  const isolated = context(new EventBus(), document, { getEntriesByType: () => [] });
  const main = context(new EventBus(), document, {
    getEntriesByType: () => Array.from({ length: 3 }, (_, x) => ({
      name: `https://tiles.test/16/${x}/2.png?token=secret#fragment`, initiatorType: 'img', transferSize: 256, encodedBodySize: 200, decodedBodySize: 256
    }))
  });

  await runScript('content-ui.js', isolated);
  await runScript('main-observer.js', main);

  const report = JSON.parse(document.root.querySelector('#summary').textContent);
  assert.equal(report.totals.resourceCount, 3);
  assert.equal(report.probeDiagnostics.performanceInitialScanCompleted, true);
  assert.equal(report.probeDiagnostics.performanceObserverAvailable, false);
  assert.equal(report.probeDiagnostics.performanceObserverStarted, false);
  assert.equal(report.probeDiagnostics.resourceFactsEmitted, 3);
  assert.equal(report.probeDiagnostics.resourceFactsAccepted, 3);
  assert.equal(report.probeDiagnostics.resourceFactsRejected, 0);
  assert.equal(report.probeDiagnostics.resourceFactsPending, 0);
  assert.equal(
    report.probeDiagnostics.resourceFactsEmitted,
    report.probeDiagnostics.resourceFactsAccepted + report.probeDiagnostics.resourceFactsRejected + report.probeDiagnostics.resourceFactsPending
  );
});

test('starts the bridge before documentElement and defers only UI creation', async () => {
  const { document, root, shadow } = createDocumentWithoutRoot();
  let readyEvents = 0;
  let resourceEventsBeforeDomContentLoaded = 0;
  document.addEventListener('mon-territoire-probe:ready', () => { readyEvents++; });
  document.addEventListener('mon-territoire-probe:fact', event => {
    if (event.detail?.type === 'resource' && !document.documentElement) resourceEventsBeforeDomContentLoaded++;
  });
  const isolated = context(new EventBus(), document, { getEntriesByType: () => [] });
  const main = context(new EventBus(), document, {
    getEntriesByType: () => Array.from({ length: 3 }, (_, x) => ({
      name: `https://tiles.test/16/${x}/2.png?token=secret#fragment`, initiatorType: 'img', transferSize: 256, encodedBodySize: 200, decodedBodySize: 256
    }))
  });

  await runScript('content-ui.js', isolated, '\nglobalThis.__collectorReport = collector.report;');
  assert.equal(readyEvents, 1);
  assert.equal(document.documentElement, null);
  await runScript('main-observer.js', main);
  assert.equal(resourceEventsBeforeDomContentLoaded, 3);
  const reportBeforeDomContentLoaded = isolated.__collectorReport();
  assert.equal(reportBeforeDomContentLoaded.resources.length, 3);
  assert.equal(reportBeforeDomContentLoaded.probeDiagnostics.resourceFactsAccepted, 3);
  assert.equal(reportBeforeDomContentLoaded.probeDiagnostics.resourceFactsPending, 0);
  assert.equal(shadow.querySelector('#summary').textContent, '');

  document.documentElement = root;
  document.dispatchEvent(new (isolated.CustomEvent || class { constructor(type) { this.type = type; } })('DOMContentLoaded'));

  const report = JSON.parse(shadow.querySelector('#summary').textContent);
  assert.equal(report.totals.resourceCount, 3);
  assert.equal(report.probeDiagnostics.resourceFactsEmitted, 3);
  assert.equal(report.probeDiagnostics.resourceFactsAccepted, 3);
  assert.equal(report.probeDiagnostics.resourceFactsRejected, 0);
  assert.equal(report.probeDiagnostics.resourceFactsPending, 0);
  assert.equal(
    report.probeDiagnostics.resourceFactsEmitted,
    report.probeDiagnostics.resourceFactsAccepted + report.probeDiagnostics.resourceFactsRejected + report.probeDiagnostics.resourceFactsPending
  );
});
