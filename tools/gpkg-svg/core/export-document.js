// Lightweight export model. An ExportDocument is a list of independent layers
// rendered as Inkscape layers; today only "Cadastre" exists, but the SVG writer
// and the pipeline iterate over `layers` so more can be appended later without
// touching the engine.
//
//   ExportDocument = { meta, layers: ExportLayer[] }
//   ExportLayer    = { id, label, idPrefix, features: [{ polygons }], style? }
//
// `features[].polygons` hold projected (planar, Y-up) coordinates only.

export const CADASTRE_LAYER = Object.freeze({ id: 'layer-cadastre', label: 'Cadastre', idPrefix: 'cadastre' });

export function createCadastreLayer(features, style) {
  return { ...CADASTRE_LAYER, features, ...(style ? { style } : {}) };
}

export function createExportDocument({ meta, layers }) {
  return { meta, layers };
}
