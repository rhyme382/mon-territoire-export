const MAX_CONTAINERS = 20;
const MAX_PANES = 32;
const MAX_SVGS_PER_PANE = 100;
const MAX_PATHS_PER_SVG = 1_000;
const MAX_EXAMPLES_PER_SIGNATURE = 10;
const MAX_EXAMPLES = 100;
const PANE_NAMES = ['tile', 'overlay', 'marker', 'shadow', 'map', 'popup', 'tooltip', 'mask'];
const ELEMENT_NAMES = ['path', 'polyline', 'polygon', 'circle', 'rect'];

function number(value, maximum = 100_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? Math.round(parsed) : undefined;
}
function localBox(element, container) {
  try {
    const box = element.getBoundingClientRect(); const root = container.getBoundingClientRect();
    return { x: Math.round(box.left - root.left), y: Math.round(box.top - root.top), width: Math.round(box.width), height: Math.round(box.height) };
  } catch { return undefined; }
}
function paneName(element) {
  const className = typeof element?.className === 'string' ? element.className : '';
  return PANE_NAMES.find(name => className.split(/\s+/).includes(`leaflet-${name}-pane`)) || 'other';
}
function style(element, getStyle) {
  try {
    const value = getStyle(element) || {};
    const transform = typeof value.transform === 'string' && /^(?:none|matrix\([-0-9.,\s]+\)|matrix3d\([-0-9.,\s]+\)|translate(?:3d)?\([-0-9.px,\s]+\))$/.test(value.transform) ? value.transform.slice(0, 160) : 'none';
    const opacity = /^0(?:\.\d+)?$|^1(?:\.0+)?$/.test(String(value.opacity)) ? String(value.opacity) : undefined;
    const display = ['block', 'inline', 'inline-block', 'none', 'flex'].includes(value.display) ? value.display : undefined;
    const visibility = ['visible', 'hidden', 'collapse'].includes(value.visibility) ? value.visibility : undefined;
    const zIndex = /^-?\d{1,8}$/.test(String(value.zIndex)) ? Number(value.zIndex) : undefined;
    return { transform, ...(opacity ? { opacity } : {}), ...(display ? { display } : {}), ...(visibility ? { visibility } : {}), ...(zIndex !== undefined ? { zIndex } : {}) };
  } catch { return { transform: 'none' }; }
}
function color(value) { return typeof value === 'string' && /^(?:none|transparent|#[0-9a-f]{3,8}|rgba?\([0-9.,\s]+\))$/i.test(value) ? value.slice(0, 32) : undefined; }
function pathStats(element) {
  const d = element.getAttribute?.('d');
  if (typeof d !== 'string') return { present: false, length: 0, commands: 0 };
  return { present: true, length: Math.min(d.length, 1_000_000), commands: (d.match(/[a-z]/gi) || []).length };
}
function signature(element, stats) {
  const tag = String(element.tagName || '').toLowerCase();
  const fill = color(element.getAttribute?.('fill')) || 'unspecified';
  const stroke = color(element.getAttribute?.('stroke')) || 'unspecified';
  const width = number(element.getAttribute?.('stroke-width'), 1_000) ?? 0;
  const bucket = stats.length === 0 ? 'empty' : stats.length <= 64 ? 'short' : stats.length <= 512 ? 'medium' : 'long';
  return `${tag}|fill:${fill}|stroke:${stroke}|width:${width}|d:${bucket}`;
}
function svgMetadata(svg) {
  const values = String(svg.getAttribute?.('viewBox') || '').trim().split(/[\s,]+/).map(value => number(value));
  const viewBox = values.length === 4 && values.every(value => value !== undefined) ? { width: values[2], height: values[3] } : undefined;
  const width = number(svg.getAttribute?.('width')); const height = number(svg.getAttribute?.('height'));
  return { ...(viewBox ? { viewBox } : {}), ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
}

export function sanitizeRasterUrl(input) {
  try {
    const url = new URL(input);
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
    const source = decodeURIComponent(url.pathname);
    if (!source.startsWith('/') || source.length > 512 || /[?#\u0000-\u001f\u007f]/.test(source)) return null;
    const pathname = source.replace(/\/\d+\/\d+\/\d+(?=\.[a-z0-9]+$|$)/i, '/{tile}');
    return { hostname: url.hostname.toLowerCase(), pathname };
  } catch { return null; }
}

export function inspectLeafletRender(document, getStyle = element => globalThis.getComputedStyle?.(element)) {
  const groups = new Map(); let exampleCount = 0;
  const addExample = (signatureValue, example) => {
    let group = groups.get(signatureValue);
    if (!group) { group = { signature: signatureValue, count: 0, evidence: ['rendered-element', 'pane-membership'], examples: [] }; groups.set(signatureValue, group); }
    group.count++;
    if (group.examples.length < MAX_EXAMPLES_PER_SIGNATURE && exampleCount < MAX_EXAMPLES) { group.examples.push(example); exampleCount++; }
  };
  const containers = Array.from(document?.querySelectorAll?.('.leaflet-container') || []).slice(0, MAX_CONTAINERS).map((container, containerIndex) => {
    const panes = Array.from(container.querySelectorAll?.('.leaflet-pane') || []).slice(0, MAX_PANES).map(pane => {
      const name = paneName(pane); const svg = []; const canvas = []; const images = [];
      const counts = { svg: 0, path: 0, polyline: 0, polygon: 0, circle: 0, rect: 0, canvas: 0, img: 0 };
      Array.from(pane.querySelectorAll?.('svg') || []).slice(0, MAX_SVGS_PER_PANE).forEach((item, svgIndex) => {
        counts.svg++; const paths = [];
        Array.from(item.querySelectorAll?.('path,polyline,polygon,circle,rect') || []).slice(0, MAX_PATHS_PER_SVG).forEach((element, elementIndex) => {
          const tag = String(element.tagName || '').toLowerCase(); if (Object.hasOwn(counts, tag)) counts[tag]++;
          const d = pathStats(element); const itemSignature = signature(element, d);
          const bbox = localBox(element, container); paths.push({ tag, d, ...(bbox ? { bbox } : {}), signature: itemSignature });
          addExample(itemSignature, { container: containerIndex, pane: name, svg: svgIndex, element: elementIndex, ...(bbox ? { bbox } : {}) });
        });
        svg.push({ ...svgMetadata(item), styles: style(item, getStyle), paths });
      });
      Array.from(pane.querySelectorAll?.('canvas') || []).forEach(item => { counts.canvas++; canvas.push({ width: number(item.width) || 0, height: number(item.height) || 0 }); });
      Array.from(pane.querySelectorAll?.('img') || []).forEach(item => { counts.img++; const value = sanitizeRasterUrl(item.currentSrc || item.src); if (value) images.push(value); });
      const styles = style(pane, getStyle);
      return { name, transform: styles.transform, styles, counts, svg, canvas, images };
    });
    return { index: containerIndex, panes, maskPanePresent: panes.some(pane => pane.name === 'mask') };
  });
  return { schemaVersion: 1, privacy: 'sanitized-local-render-report', inspection: 'passive-dom-render-only', containers, candidateGroups: Array.from(groups.values()) };
}

globalThis.MonTerritoireRenderInspector = { inspectLeafletRender, sanitizeRasterUrl };
