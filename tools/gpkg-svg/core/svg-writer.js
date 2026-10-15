import { GpkgSvgError } from './errors.js';

export const DEFAULT_STYLE = Object.freeze({
  fill: 'none',
  stroke: '#000000',
  strokeWidth: 1,
  vectorEffect: 'non-scaling-stroke',
  fillRule: 'evenodd',
});

const fmt = (n) => {
  if (!Number.isFinite(n)) throw new GpkgSvgError('NON_FINITE', 'Valeur non finie lors de la génération du SVG.');
  return String(Math.round(n * 100) / 100);
};

export function ringToPath(ring, transform) {
  const points = ring.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 1 && first[0] === last[0] && first[1] === last[1]) points.pop();
  if (points.length < 3) return '';
  const coords = points.map((p) => transform.apply(p));
  return `M${coords.map(([x, y]) => `${fmt(x)} ${fmt(y)}`).join('L')}Z`;
}

export function polygonsToPathData(polygons, transform) {
  return polygons.flatMap((rings) => rings.map((ring) => ringToPath(ring, transform))).filter(Boolean).join('');
}

const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Only self-contained rasters are written: a remote or relative link would make the SVG depend on the network.
const EMBEDDED_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

function rasterLayerToSvg(layer) {
  const { rect, image } = layer;
  if (!image || typeof image.dataUri !== 'string' || !EMBEDDED_IMAGE.test(image.dataUri)) throw new GpkgSvgError('INVALID_RASTER_LAYER', 'Image embarquée invalide.');
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) throw new GpkgSvgError('INVALID_RASTER_LAYER', 'Dimensions du raster invalides.');
  return `  <g inkscape:groupmode="layer" inkscape:label="${esc(layer.label)}" id="${esc(layer.id)}">
    <image id="${esc(layer.idPrefix)}-image" x="${fmt(rect.x)}" y="${fmt(rect.y)}" width="${fmt(rect.width)}" height="${fmt(rect.height)}" preserveAspectRatio="none" xlink:href="${image.dataUri}"/>
  </g>`;
}

function layerToSvg(layer, defaults, transform) {
  if (layer.type === 'raster') return rasterLayerToSvg(layer);
  if (layer.type !== undefined && layer.type !== 'vector') throw new GpkgSvgError('UNSUPPORTED_LAYER_TYPE', 'Type de calque non supporté.');
  const st = { ...defaults, ...layer.style };
  const paths = layer.features
    .map((feature, i) => {
      const d = polygonsToPathData(feature.polygons, transform);
      if (!d) return null;
      return `    <path id="${esc(layer.idPrefix)}-${i + 1}" d="${d}" fill="${esc(st.fill)}"${st.fillOpacity === undefined ? '' : ` fill-opacity="${fmt(st.fillOpacity)}"`} fill-rule="${esc(st.fillRule)}" stroke="${esc(st.stroke)}" stroke-width="${fmt(st.strokeWidth)}" vector-effect="${esc(st.vectorEffect)}"/>`;
    })
    .filter(Boolean);
  return `  <g inkscape:groupmode="layer" inkscape:label="${esc(layer.label)}" id="${esc(layer.id)}">
${paths.join('\n')}
  </g>`;
}

export function buildSvg({ layers, transform, metadata, style = DEFAULT_STYLE }) {
  const defaults = { ...DEFAULT_STYLE, ...style };
  const w = fmt(transform.width);
  const h = fmt(transform.height);
  const metaAttrs = Object.entries(metadata)
    .map(([key, value]) => `${key}="${esc(value)}"`)
    .join('\n        ');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"
     xmlns:xlink="http://www.w3.org/1999/xlink"
     xmlns:mte="https://mon-territoire-export.local/ns/1"
     width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" version="1.1">
  <metadata id="metadata-mon-territoire-export">
    <mte:export
        ${metaAttrs}/>
  </metadata>
${layers.map((layer) => layerToSvg(layer, defaults, transform)).join('\n')}
</svg>
`;
}
