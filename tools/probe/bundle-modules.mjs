import { readFile } from 'node:fs/promises';

// Minimal ES-module -> classic-script bundler (no dependency). Content scripts
// cannot be ES modules, so the browser entry point and its relative imports are
// concatenated into a single IIFE that publishes the entry's exports on
// globalThis.<globalName>. Only relative imports are allowed: a bare or node:
// specifier is a build error, which keeps Node adapters out of the bundle.

const IMPORT = /^import\s[^;]*?from\s+['"]([^'"]+)['"];?[ \t]*\n?/gm;
const REEXPORT = /^export\s*\{[^}]*\}\s*from\s+['"]([^'"]+)['"];?[ \t]*\n?/gm;
const EXPORT_DECL = /^export\s+(?=(?:async\s+)?(?:function|class|const|let)\b)/gm;
const TOP_LEVEL = /^(?:export\s+)?(?:async\s+)?(?:function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;

export async function bundleModules(entryUrl, globalName) {
  const ordered = [];
  const seen = new Set();
  const names = new Map();

  async function visit(url) {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = await readFile(url, 'utf8');
    for (const re of [IMPORT, REEXPORT]) {
      for (const match of source.matchAll(re)) {
        const specifier = match[1];
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
          throw new Error(`bundle: non-relative import "${specifier}" in ${url.pathname}`);
        }
        await visit(new URL(specifier, url));
      }
    }
    for (const match of source.matchAll(TOP_LEVEL)) {
      const previous = names.get(match[1]);
      if (previous) throw new Error(`bundle: top-level name "${match[1]}" declared in both ${previous} and ${url.pathname}`);
      names.set(match[1], url.pathname);
    }
    const code = source.replace(IMPORT, '').replace(REEXPORT, '').replace(EXPORT_DECL, '');
    if (/^export\s/m.test(code)) throw new Error(`bundle: unsupported export form in ${url.pathname}`);
    ordered.push({ url, code });
  }

  await visit(entryUrl);
  const entrySource = await readFile(entryUrl, 'utf8');
  const exported = [...entrySource.matchAll(/^export\s+(?:async\s+)?(?:function\*?|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
  const body = ordered.map(({ url, code }) => `// --- ${url.pathname.split('/tools/')[1]}\n${code}`).join('\n');
  return `(function () {\n'use strict';\n${body}\nglobalThis.${globalName} = Object.freeze({ ${exported.join(', ')} });\n})();\n`;
}
