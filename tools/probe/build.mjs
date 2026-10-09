import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { bundleModules } from './bundle-modules.mjs';

const source = new URL('./', import.meta.url);
const destination = new URL('./dist/', source);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(new URL('./lib/', source), new URL('./lib/', destination), { recursive: true });
await cp(new URL('./probe.css', source), new URL('./probe.css', destination));
for (const name of ['engine-inspector.js', 'pci-contour-observer.js', 'main-observer.js', 'render-inspector.js', 'mask-control.js', 'content-ui.js']) {
  const code = await readFile(new URL(`./${name}`, source), 'utf8');
  await writeFile(new URL(`./${name}`, destination), code.replace(/^export /gm, ''));
}
// Browser GeoPackage -> SVG engine (pure JS, no WASM, no Node API).
await writeFile(new URL('./gpkg-svg.js', destination), await bundleModules(new URL('../gpkg-svg/browser/api.js', source), 'MonTerritoireGpkgSvg'));
await writeFile(new URL('./manifest.json', destination), await readFile(new URL('./manifest.json', source)));
