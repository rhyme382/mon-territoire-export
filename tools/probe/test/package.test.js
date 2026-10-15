import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildPackage, readZip } from '../package.mjs';

// MVP-07: the produced archive is audited from the inside (build -> package -> open the zip).
const result = await buildPackage({ build: false }); // dist/ comes from `npm run build` (like the other dist audits)
const zip = await readFile(result.target);
const entries = readZip(zip);
const names = entries.map(entry => entry.name);
const manifest = JSON.parse(entries.find(entry => entry.name === 'manifest.json').data.toString('utf8'));
const sourceManifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

test('the zip exists, is named after the manifest version and has manifest.json at its root', async () => {
  assert.match(result.target.pathname, new RegExp(`/release/mon-territoire-export-${manifest.version.replaceAll('.', '\\.')}\\.zip$`));
  assert.ok((await stat(result.target)).size > 10_000);
  assert.ok(names.includes('manifest.json'));
  assert.equal(names.some(name => name.endsWith('/manifest.json')), false);
  assert.equal(names.some(name => name.startsWith('dist/') || name.startsWith('mon-territoire-export/') || name.startsWith('/')), false);
});

test('manifest in the zip: valid MV3, version policy, permissions exactly activeTab, no host access', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, 'Mon Territoire Export');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.version, sourceManifest.version);
  assert.ok(manifest.description.length > 20 && manifest.description.length <= 132);
  assert.deepEqual(manifest.permissions, ['activeTab']);
  for (const key of ['host_permissions', 'optional_permissions', 'optional_host_permissions', 'externally_connectable', 'web_accessible_resources', 'declarative_net_request', 'devtools_page', 'content_security_policy', 'update_url']) assert.equal(key in manifest, false, key);
  assert.equal(JSON.stringify(manifest).match(/<all_urls>|\*:\/\/\*|"tabs"|webRequest|debugger|storage|cookies|downloads/), null);
  assert.deepEqual(manifest.background, { service_worker: 'service-worker.js' });
  assert.deepEqual(manifest.content_scripts.flatMap(item => item.matches), ['https://carto.monterritoire.fr/*', 'https://carto.monterritoire.fr/*']);
});

test('every file the manifest references is in the zip, and nothing else is', () => {
  const referenced = new Set(['manifest.json', manifest.background.service_worker, manifest.action.default_popup, 'popup.css', 'popup.js', ...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]);
  for (const entry of manifest.content_scripts) for (const file of [...entry.js, ...(entry.css || [])]) referenced.add(file);
  assert.deepEqual([...names].sort(), [...referenced].sort());
  loose(names);
});
function loose(list) { assert.equal(new Set(list).size, list.length, 'no duplicate entry'); }

test('MVP-07B: the popup page and every local resource it loads are in the zip and in dist; nothing remote', async () => {
  assert.equal(manifest.action.default_popup, 'popup.html');
  const html = entries.find(entry => entry.name === 'popup.html').data.toString('utf8');
  const references = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(references.sort(), ['gpkg-svg.js', 'popup.css', 'popup.js']);
  for (const reference of references) { assert.ok(names.includes(reference), reference); assert.doesNotMatch(reference, /^[a-z]+:|^\/\//i); await stat(new URL(`../dist/${reference}`, import.meta.url)); }
  assert.equal('content_security_policy' in manifest, false);
});

test('icons are real PNG files of the Chromium sizes', () => {
  for (const size of [16, 32, 48, 128]) {
    const data = entries.find(entry => entry.name === `icons/icon-${size}.png`).data;
    assert.deepEqual([...data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(data.readUInt32BE(16), size); assert.equal(data.readUInt32BE(20), size);
  }
});

test('no development, user or sensitive file in the zip', () => {
  const forbidden = [/node_modules/, /(^|\/)src\//, /(^|\/)tests?\//, /(^|\/)docs?\//, /\.har$/i, /\.log$/i, /\.svg$/i, /\.gpkg$/i, /\.map$/i, /\.md$/i, /(^|\/)\.git/, /(^|\/)\.env/, /fixtures?/, /\.test\./, /\.tmp$|~$/, /package(-lock)?\.json$/, /^lib\//, /(^|\/)release\//];
  for (const name of names) for (const pattern of forbidden) assert.doesNotMatch(name, pattern, name);
});

test('the archived files are the built files, content-identical and free of ES module syntax and secrets', async () => {
  for (const entry of entries) {
    const built = await readFile(new URL(`../dist/${entry.name}`, import.meta.url));
    assert.equal(createHash('sha256').update(entry.data).digest('hex'), createHash('sha256').update(built).digest('hex'), entry.name);
    if (entry.name.endsWith('.js')) {
      const text = entry.data.toString('utf8');
      assert.equal(/^\s*(?:export|import)\s/m.test(text), false, `${entry.name} still has module syntax`);
      assert.equal(/sourceMappingURL|SECRET-|token=|Bearer\s/i.test(text), false, `${entry.name} contains a source map or secret marker`);
    }
  }
});

test('packaging is deterministic: same inputs, byte-identical archive', async () => {
  const again = await buildPackage({ build: false });
  assert.equal(createHash('sha256').update(await readFile(again.target)).digest('hex'), createHash('sha256').update(zip).digest('hex'));
});

test('repository hygiene: release/ and dist/ are ignored by git', async () => {
  const ignore = await readFile(new URL('../../../.gitignore', import.meta.url), 'utf8');
  assert.match(ignore, /^release\/$/m); assert.match(ignore, /^dist\/$/m);
  assert.ok((await readdir(new URL('../../../release/', import.meta.url))).some(name => name.endsWith('.zip')));
});
