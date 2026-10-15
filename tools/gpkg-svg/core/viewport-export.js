import { GpkgSvgError } from './errors.js';
import { BACKGROUND_LAYER, CADASTRE_LAYER, SELECTED_PARCELS_LAYER, createExportDocument } from './export-document.js';
import { buildSvg } from './svg-writer.js';

// "Visible cadastre" export: geometries already in viewport pixels (X right, Y down), produced by the page
// reader from the Leaflet runtime. Same ExportDocument / writer as the GeoPackage path, other source.

export const VIEWPORT_CONVERTER_SCHEMA = 'visible-cadastre/1';
export const VIEWPORT_SOURCE = 'Leaflet runtime / VectorGrid';
export const VIEWPORT_LAYER_ID_PREFIX = 'cadastre-visible';
// Single place to restyle the visible cadastre.
export const CADASTRE_VIEWPORT_STYLE = Object.freeze({ fill: 'none', stroke: '#1a1a1a', strokeWidth: 1, vectorEffect: 'non-scaling-stroke', fillRule: 'evenodd' });
// Selected parcels: translucent fill + distinct outline over the thin unfilled Cadastre. Single place to restyle them.
export const SELECTION_VIEWPORT_STYLE = Object.freeze({ fill: '#00b4d8', fillOpacity: 0.25, stroke: '#0057b8', strokeWidth: 2.5, vectorEffect: 'non-scaling-stroke', fillRule: 'evenodd' });
const MAX_DIMENSION = 100_000;

function invalidCapture(message) { return new GpkgSvgError('INVALID_VIEWPORT_CAPTURE', message); }

function toLayerFeatures(features) {
  return features.map((feature) => {
    if (!feature || !Array.isArray(feature.rings) || feature.rings.length === 0) throw invalidCapture('Entité invalide.');
    const rings = feature.rings.map((ring) => {
      if (!Array.isArray(ring) || ring.length < 3 || !ring.every((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))) throw invalidCapture('Anneau invalide.');
      return ring.map(([x, y]) => [x, y]);
    });
    return { polygons: [rings] };
  });
}

// The basemap raster is only used when the page reader embedded the complete viewport; anything else means "vector only".
function toBackgroundLayer(background, viewport) {
  if (background?.status !== 'embedded') return null;
  const dataUri = background.image?.dataUri;
  if (typeof dataUri !== 'string' || !/^data:image\/(?:png|jpeg|webp);base64,/.test(dataUri)) throw invalidCapture('Fond cartographique invalide.');
  // The raster must have the viewport's aspect: otherwise it would need a manual realignment, so it is not embedded at all.
  const { pixelWidth, pixelHeight } = background.image;
  if (pixelWidth !== undefined || pixelHeight !== undefined) {
    if (!(pixelWidth > 0 && pixelHeight > 0) || Math.abs(pixelWidth * viewport.height - pixelHeight * viewport.width) > Math.max(viewport.width, viewport.height) * 1.01) return null;
  }
  return { ...BACKGROUND_LAYER, rect: { x: 0, y: 0, width: viewport.width, height: viewport.height }, image: { dataUri } };
}

// capture = { viewport:{width,height}, zoom, features:[{ rings:[[ [x,y], ... ], ...] }], selection?:{ features }, background?:{ status, image? } } -> ExportDocument
// Layers are listed bottom to top: Fond cartographique (when embedded), Cadastre, then the selected parcels (when there are any).
export function prepareViewportDocument(capture) {
  const { viewport, zoom, features, selection, background } = capture || {};
  const size = value => Number.isFinite(value) && value > 0 && value <= MAX_DIMENSION;
  if (!viewport || !size(viewport.width) || !size(viewport.height)) throw invalidCapture('Viewport invalide.');
  if (!Array.isArray(features) || features.length === 0) throw invalidCapture('Aucune géométrie visible.');
  const layerFeatures = toLayerFeatures(features);
  const backgroundLayer = toBackgroundLayer(background, viewport);
  const layers = [...(backgroundLayer ? [backgroundLayer] : []), { ...CADASTRE_LAYER, type: 'vector', idPrefix: VIEWPORT_LAYER_ID_PREFIX, features: layerFeatures, style: CADASTRE_VIEWPORT_STYLE }];
  const selectedFeatures = Array.isArray(selection?.features) && selection.features.length ? toLayerFeatures(selection.features) : [];
  if (selectedFeatures.length) layers.push({ ...SELECTED_PARCELS_LAYER, features: selectedFeatures, style: SELECTION_VIEWPORT_STYLE });
  return createExportDocument({
    meta: { source: VIEWPORT_SOURCE, viewport: { width: viewport.width, height: viewport.height }, zoom: Number.isFinite(zoom) ? zoom : undefined, featureCount: layerFeatures.length, selectedFeatureCount: selectedFeatures.length, backgroundEmbedded: Boolean(backgroundLayer) },
    layers,
  });
}

export function renderViewportDocument(document, { now = new Date() } = {}) {
  const { viewport, zoom, featureCount, selectedFeatureCount, backgroundEmbedded, source } = document.meta;
  const transform = { width: viewport.width, height: viewport.height, apply: ([x, y]) => [x, y] };
  const metadata = {
    generator: 'mon-territoire-export',
    converterSchema: VIEWPORT_CONVERTER_SCHEMA,
    source,
    ...(zoom !== undefined ? { zoom } : {}),
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    featureCount,
    ...(selectedFeatureCount > 0 ? { selectedFeatureCount } : {}),
    ...(backgroundEmbedded ? { backgroundEmbedded: true } : {}),
    exportDatetime: now.toISOString(),
  };
  return buildSvg({ layers: document.layers, transform, metadata, style: CADASTRE_VIEWPORT_STYLE });
}

export function viewportSvgFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `mon-territoire-cadastre-visible-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}.svg`;
}
