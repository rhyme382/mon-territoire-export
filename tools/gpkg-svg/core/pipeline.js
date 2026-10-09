import { GpkgSvgError } from './errors.js';
import { createCadastreLayer, createExportDocument } from './export-document.js';
import { resolveProjection } from './projection.js';
import { computeBounds, createSvgTransform } from './svg-transform.js';
import { buildSvg } from './svg-writer.js';

export const CONVERTER_SCHEMA = 'gpkg-to-svg/1';
export const GENERATOR = 'mon-territoire-export';

// Step 1: GeoPackage -> ExportDocument (+ non-sensitive summary).
export function prepareCadastreDocument(gpkg, { layer, style } = {}) {
  const layerInfo = gpkg.resolveLayer(layer);
  const srs = gpkg.getSrs(layerInfo.srsId);
  const projection = resolveProjection(srs);
  const { geometries, skipped } = gpkg.readGeometries(layerInfo);
  if (geometries.length === 0) {
    throw new GpkgSvgError('EMPTY_LAYER', 'Aucune géométrie exploitable dans la couche.');
  }
  const features = geometries.map((g) => ({
    polygons: g.polygons.map((rings) => rings.map((ring) => ring.map(projection.project))),
  }));
  const document = createExportDocument({
    meta: {
      layerName: layerInfo.tableName,
      declaredGeometryType: layerInfo.geometryType,
      sourceCrs: projection.sourceCrs,
      featureCount: features.length,
      transformation: projection.transformation,
    },
    layers: [createCadastreLayer(features, style)],
  });
  return {
    document,
    summary: {
      layer: layerInfo.tableName,
      geometry: layerInfo.geometryType,
      features: features.length,
      skipped,
      crs: projection.sourceCrs,
    },
  };
}

// Step 2: ExportDocument -> SVG text.
export function renderExportDocument(document, { width = 1200, padding = 20, now = new Date() } = {}) {
  const bounds = computeBounds(document.layers.flatMap((l) => l.features.flatMap((f) => f.polygons)));
  const transform = createSvgTransform(bounds, { width, padding });
  const metadata = {
    generator: GENERATOR,
    converterSchema: CONVERTER_SCHEMA,
    sourceFormat: 'GeoPackage',
    layerName: document.meta.layerName,
    declaredGeometryType: document.meta.declaredGeometryType,
    sourceCrs: document.meta.sourceCrs,
    featureCount: document.meta.featureCount,
    exportDatetime: now.toISOString(),
    transformation: document.meta.transformation,
  };
  return buildSvg({ layers: document.layers, transform, metadata });
}

export function convertGeoPackage(gpkg, { layer, width, padding, style, now } = {}) {
  const { document, summary } = prepareCadastreDocument(gpkg, { layer, style });
  return { svg: renderExportDocument(document, { width, padding, now }), summary };
}

export function defaultSvgFileName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `mon-territoire-cadastre-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}.svg`;
}
