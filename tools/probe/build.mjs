import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { bundleModules } from './bundle-modules.mjs';

const source = new URL('./', import.meta.url);
const destination = new URL('./dist/', source);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(new URL('./lib/', source), new URL('./lib/', destination), { recursive: true });
for (const name of ['popup.html', 'popup.css', 'popup.js']) await cp(new URL(`./${name}`, source), new URL(`./${name}`, destination));
await cp(new URL('./icons/', source), new URL('./icons/', destination), { recursive: true });
for (const name of ['engine-inspector.js', 'visible-cadastre-geometry.js', 'visible-background.js', 'visible-cadastre-export.js', 'rendered-basemap.js', 'visible-capture-isolation.js', 'service-worker.js', 'visible-map-inspector.js', 'visible-map-report.js', 'visible-selection-report.js', 'pci-contour-observer.js', 'main-observer.js', 'render-inspector.js', 'mask-control.js', 'content-ui.js']) {
  const code = await readFile(new URL(`./${name}`, source), 'utf8');
  await writeFile(new URL(`./${name}`, destination), code.replace(/^export /gm, ''));
}
// Browser GeoPackage -> SVG engine (pure JS, no WASM, no Node API).
await writeFile(new URL('./gpkg-svg.js', destination), await bundleModules(new URL('../gpkg-svg/browser/api.js', source), 'MonTerritoireGpkgSvg'));
await writeFile(new URL('./manifest.json', destination), await readFile(new URL('./manifest.json', source)));
