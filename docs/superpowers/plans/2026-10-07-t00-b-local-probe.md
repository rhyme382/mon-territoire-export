# T00-B Local Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a temporary, unpacked MV3 Chromium extension that passively records a sanitized diagnostic of a normal Mon Territoire Carto session.

**Architecture:** A `document_start` MAIN-world observer wraps only the page's own `fetch` and `XMLHttpRequest`, observes resource timing and DOM mutations, and emits bounded, sanitized facts through `CustomEvent`. An isolated content script owns the visible probe badge and report UI, keeps an in-memory session ledger, and forwards no data anywhere. Pure report, URL, PBF-summary, and DOM-summary helpers are shared as ES modules and tested in Node with synthetic inputs.

**Tech Stack:** Browser-native ES modules, Manifest V3, Node's built-in `node:test` runner; no runtime dependency.

**Spec:** `docs/mvp-01.md`, `docs/architecture.md`, `docs/security-boundaries.md`, `docs/adr/0001-mv3-observation-de-page.md`, `docs/adr/0003-raster-best-effort.md`

## Global Constraints

- The probe is temporary and is not MVP-01.
- It installs at `document_start` in MAIN world and is passive: no URL replay, fetch initiated by the probe, request/response mutation, CORS bypass, authorization change, debugger API, cookies permission, HAR capture, telemetry, or persistent storage.
- The output keeps only hostname, normalized pathname, resource type, z/x/y, MIME/type, byte counts, generic DOM/Leaflet facts, MVT layer/property names and aggregate geometry statistics.
- The output removes query strings, fragments, headers, credentials, identifier/session/token-like fields, precise coordinates and every property value.
- Observed bodies stay only in the MAIN-world session memory long enough to derive a summary, then are discarded.
- No commit is made in this tranche.

## Review Focus

- A URL with signed query parameters and a fragment must never expose either in the report.
- `fetch` failure/rejection and XHR errors must still be recorded as transport observations without changing page-visible behavior.
- A CORS-opaque or unreadable response must be reported as unreadable, never retried or read through a workaround.
- A malformed or enormous PBF must produce a bounded diagnostic, no property values and no exception that disrupts the host page.
- A page with no public Leaflet map must report only DOM fallback facts and must not claim exact bounds, CRS, or pixel origin.

---

### Task 1: Manifest and test harness

**Files:**
- Create: `package.json`
- Create: `tools/probe/manifest.json`
- Create: `tools/probe/lib/sanitize.js`
- Test: `tools/probe/test/sanitize.test.js`

**Interfaces:**
- Produces `normalizeUrl(input: string): SanitizedUrl`, `sanitizeHeaderName(name: string): string | null`, and a `npm test` command.
- Consumes no page or extension APIs.

- [ ] **Step 1: Write the failing test**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl } from '../lib/sanitize.js';

test('removes query and fragment while retaining tile coordinates', () => {
  assert.deepEqual(normalizeUrl('https://tiles.example.test/a/17/66000/44000.pbf?token=secret#x'), {
    hostname: 'tiles.example.test', pathname: '/a/17/66000/44000.pbf', zxy: { z: 17, x: 66000, y: 44000 }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tools/probe/test/sanitize.test.js`

Expected: failure because the module and `normalizeUrl` do not exist.

- [ ] **Step 3: Write minimal implementation**

Create a module that uses `new URL`, returns only `hostname`, a decoded-safe normalized `pathname`, and `{z,x,y}` only for a three-number path suffix. Declare a MV3 manifest with only a named content script, `world: "MAIN"`, `run_at: "document_start"`, an isolated UI script, a stylesheet, `activeTab`, and the narrowly documented Mon Territoire match patterns after confirming them at probe time. Do not declare cookies, debugger, storage, webRequest, downloads, or broad host permissions.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tools/probe/test/sanitize.test.js`

Expected: pass.

### Task 2: Pure resource ledger and report sanitizer

**Files:**
- Create: `tools/probe/lib/report.js`
- Test: `tools/probe/test/report.test.js`

**Interfaces:**
- Consumes `SanitizedUrl` from Task 1.
- Produces `createLedger()`, `observeResource(fact)`, and `toSanitizedReport()`.

- [ ] **Step 1: Write the failing test**

```js
test('aggregates sizes and never retains sensitive resource fields', () => {
  const ledger = createLedger();
  ledger.observeResource({ url: 'https://x.test/p/16/1/2.pbf?access_token=no', bytes: 12, authorization: 'no', propertyValues: { idu: 'no' } });
  assert.deepEqual(ledger.toSanitizedReport().resources[0], {
    hostname: 'x.test', pathname: '/p/16/1/2.pbf', zxy: { z: 16, x: 1, y: 2 }, bytes: 12
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tools/probe/test/report.test.js`

Expected: failure because the ledger module does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement a fixed-schema ledger that accepts only whitelisted facts, bounds entry counts and text length, retains no response body, request headers, credentials or arbitrary object keys, and aggregates resource count, known byte total, PBF feature count and vertices. Serialize a human-readable JSON object with a `privacy` section and explicit unavailable/unknown values.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tools/probe/test/report.test.js`

Expected: pass.

### Task 3: Bounded MVT/PBF structural parser

**Files:**
- Create: `tools/probe/lib/mvt-summary.js`
- Create: `tools/probe/test/fixtures/synthetic-mvt.js`
- Test: `tools/probe/test/mvt-summary.test.js`

**Interfaces:**
- Produces `summarizeMvt(buffer: ArrayBuffer, limit: Limits): MvtSummary | MvtDiagnostic`.
- The returned type includes only layers, extent, feature count, geometry-type counts, property-key names, vertex count and byte count.

- [ ] **Step 1: Write the failing test**

```js
test('summarizes synthetic MVT without returning a property value or coordinate', () => {
  const result = summarizeMvt(makeSyntheticMvt(), DEFAULT_LIMITS);
  assert.deepEqual(result.layers[0].propertyNames, ['parcel_key']);
  assert.equal(JSON.stringify(result).includes('secret-cadastral-value'), false);
  assert.equal(JSON.stringify(result).includes('123456'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tools/probe/test/mvt-summary.test.js`

Expected: failure because `summarizeMvt` does not exist.

- [ ] **Step 3: Write minimal implementation**

Write a small, defensive protobuf/MVT reader sufficient to skip unknown fields and count MVT Layer/Feature/Value structures. It must stop at configured input, layer, feature, tag, property-name and geometry-command limits. Decode geometry commands only to count command-derived vertices and Point/LineString/Polygon types; discard decoded coordinates immediately. On invalid/truncated data return `{ status: 'unreadable', reason: '...' }`, never raw bytes or values.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tools/probe/test/mvt-summary.test.js`

Expected: pass.

### Task 4: MAIN-world passive observer

**Files:**
- Create: `tools/probe/main-observer.js`
- Test: `tools/probe/test/main-observer.test.js`

**Interfaces:**
- Emits `CustomEvent('mon-territoire-probe:fact', { detail })` with fixed-schema facts only.
- Consumes `normalizeUrl` and `summarizeMvt` bundled/copied as browser-compatible modules.

- [ ] **Step 1: Write the failing test**

```js
test('fetch wrapper delegates the original request once and emits a sanitized fact', async () => {
  const calls = []; const original = async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'application/x-protobuf' } });
  const wrapped = createObservedFetch(original, fact => calls.push(fact));
  await wrapped('https://tiles.test/16/1/2.pbf?session=secret');
  assert.equal(calls[0].pathname, '/16/1/2.pbf');
  assert.equal(calls[0].url, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tools/probe/test/main-observer.test.js`

Expected: failure because the wrapper factory does not exist.

- [ ] **Step 3: Write minimal implementation**

Install wrappers once. `fetch` calls the original with unmodified arguments and returns its exact promise result; after resolution it may clone only an admissible response, use its existing `content-type`, apply a byte cap, summarize PBF in memory and discard the clone. XHR attaches load/error listeners, reads only the already-delivered `ArrayBuffer`/`Blob` response within caps and never changes `responseType`, request parameters or event ordering. Add a PerformanceObserver plus initial `performance.getEntriesByType('resource')`, recording timings/sizes only. Record public Leaflet candidates without creating/replacing a map; otherwise collect DOM fallback panes, CSS transforms, viewport dimensions, SVG/canvas/image counts and generic origins. The observer must catch every internal error.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tools/probe/test/main-observer.test.js`

Expected: pass.

### Task 5: Isolated-world indicator, report export, and instructions

**Files:**
- Create: `tools/probe/content-ui.js`
- Create: `tools/probe/probe.css`
- Create: `tools/probe/README.md`
- Test: `tools/probe/test/content-ui.test.js`

**Interfaces:**
- Consumes fixed-schema facts from `mon-territoire-probe:fact`.
- Produces an in-page fixed badge, a copy action, and a JSON `Blob` download generated only after a user click.

- [ ] **Step 1: Write the failing test**

```js
test('copy action writes the sanitized report text, not an observed body', async () => {
  const copied = await copyReport({ resources: [{ hostname: 'x.test', pathname: '/1/2/3.pbf' }] }, fakeClipboard);
  assert.match(copied, /x\.test/);
  assert.doesNotMatch(copied, /token|authorization|cookie/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tools/probe/test/content-ui.test.js`

Expected: failure because the UI module does not exist.

- [ ] **Step 3: Write minimal implementation**

Render a closed Shadow DOM badge labelled `Probe active`, resource/byte counters, an expandable read-only summary, `Copy sanitized report`, and `Download sanitized JSON`. Keep report state in the content script closure only. Do not use extension storage, service worker, alarms, or network APIs. Document exactly how to load unpacked, reload, pan/zoom, copy/download, and remove the extension; state that all reports must be reviewed before sharing.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tools/probe/test/content-ui.test.js`

Expected: pass.

### Task 6: Static privacy audit and full verification

**Files:**
- Create: `tools/probe/test/privacy-audit.test.js`
- Modify: `docs/mvp-01.md` only if real-observation wording needs correction after a local synthetic test.

**Interfaces:**
- Produces a test that reads the generated extension files and rejects forbidden extension capabilities and likely persistence/network code paths.

- [ ] **Step 1: Write the failing test**

```js
test('manifest does not request privileged or persistent capabilities', async () => {
  const manifest = JSON.parse(await readFile('tools/probe/manifest.json', 'utf8'));
  assert.equal(JSON.stringify(manifest).match(/cookies|debugger|webRequest|storage|<all_urls>/i), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tools/probe/test/privacy-audit.test.js`

Expected: failure until the manifest exists and its constraints are met.

- [ ] **Step 3: Write minimal implementation**

Add the audit assertions for forbidden permissions, `fetch(` calls outside wrapping/delegation code, `XMLHttpRequest` construction, `localStorage`, `chrome.storage`, HAR strings, and direct serialization of `response`/property values. Keep allowlists narrow enough that an accidental capability addition is caught.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`

Expected: all test files pass.

- [ ] **Step 5: Manually validate the unpacked extension**

Load `tools/probe` in Chromium, open a local synthetic page, reload it, inspect the badge and downloaded report, then verify that its resource URLs have no query/fragment and PBF summaries have no values/coordinates.
