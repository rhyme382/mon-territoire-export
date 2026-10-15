// Reproducible packaging: build -> verify dist -> release/mon-territoire-export-<version>.zip (manifest.json at the zip root).
// The file list is derived from the manifest (runtime files only) and the archive is deterministic: sorted entries, fixed
// timestamps, fixed attributes, no extra fields. Run: npm run package
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const FIXED_DOS_TIME = 0; const FIXED_DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01 00:00
const FORBIDDEN = [/(^|\/)node_modules\//, /(^|\/)src\//, /(^|\/)tests?\//, /(^|\/)docs?\//, /\.(?:har|log|map|gpkg|svg|md|env|test\.js)$/i, /(^|\/)\.git/, /(^|\/)\.env/, /(^|\/)fixtures?\//, /~$|\.tmp$|\.swp$/i];

export function runtimeFiles(manifest, popupBase = new URL('./dist/', import.meta.url)) {
  const files = new Set(['manifest.json']);
  for (const entry of manifest.content_scripts || []) for (const file of [...(entry.js || []), ...(entry.css || [])]) files.add(file);
  if (manifest.background?.service_worker) files.add(manifest.background.service_worker);
  if (manifest.action?.default_popup) {
    files.add(manifest.action.default_popup);
    const html = readFileSync(new URL(manifest.action.default_popup, popupBase), 'utf8');
    for (const [, reference] of html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)) { if (/^[a-z]+:|^\/\//i.test(reference)) throw new Error(`remote resource in popup: ${reference}`); files.add(reference); }
  }
  for (const icon of [...Object.values(manifest.icons || {}), ...Object.values(manifest.action?.default_icon || {})]) files.add(icon);
  return [...files].sort();
}

// Minimal ZIP writer (deflate, no zip64). entries: [{ name, data: Buffer }] in the order given.
export function createZip(entries) {
  const locals = []; const centrals = []; let offset = 0;
  for (const { name, data } of entries) {
    const nameBuffer = Buffer.from(name, 'utf8'); const compressed = deflateRawSync(data, { level: 9 }); const crc = crc32(data);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(FIXED_DOS_TIME, 10); local.writeUInt16LE(FIXED_DOS_DATE, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuffer.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(FIXED_DOS_TIME, 12); central.writeUInt16LE(FIXED_DOS_DATE, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28); central.writeUInt32LE(0o100644 << 16 >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuffer, compressed); centrals.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }
  const directory = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// Reads a ZIP produced by createZip (or any zip without zip64): [{ name, data }]. Used by the package audit.
export function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error('not a zip archive');
  const count = buffer.readUInt16LE(end + 10); let cursor = buffer.readUInt32LE(end + 16); const entries = [];
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(cursor + 10); const size = buffer.readUInt32LE(cursor + 20); const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30); const commentLength = buffer.readUInt16LE(cursor + 32); const local = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const raw = buffer.subarray(start, start + size);
    entries.push({ name, data: method === 8 ? inflateRawSync(raw) : Buffer.from(raw) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}


export async function collectPackage(distDirectory) {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', distDirectory), 'utf8'));
  const names = runtimeFiles(manifest, distDirectory);
  const entries = [];
  for (const name of names) {
    if (FORBIDDEN.some(pattern => pattern.test(name)) && name !== 'manifest.json') throw new Error(`forbidden file in manifest: ${name}`);
    entries.push({ name, data: await readFile(new URL(name, distDirectory)).catch(() => { throw new Error(`missing runtime file in dist: ${name}`); }) });
  }
  return { manifest, entries };
}

export async function buildPackage({ root = new URL('./', import.meta.url), build = true } = {}) {
  const distDirectory = new URL('./dist/', root);
  if (build) execFileSync(process.execPath, [fileURLToPath(new URL('./build.mjs', root))], { stdio: 'inherit' });
  const { manifest, entries } = await collectPackage(distDirectory);
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error(`unexpected version: ${manifest.version}`);
  const releaseDirectory = new URL('../../release/', root);
  await mkdir(releaseDirectory, { recursive: true });
  const target = new URL(`./mon-territoire-export-${manifest.version}.zip`, releaseDirectory);
  await writeFile(target, createZip(entries));
  return { target, version: manifest.version, files: entries.map(entry => entry.name) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await buildPackage();
  console.log(`${fileURLToPath(result.target)}\n${result.files.map(name => `  ${name}`).join('\n')}`);
}
