// Lightweight export model. An ExportDocument is a list of independent layers
// rendered as Inkscape layers; today only "Cadastre" exists, but the SVG writer
// and the pipeline iterate over `layers` so more can be appended later without
// touching the engine.
//
//   ExportDocument = { meta, layers: ExportLayer[] }
//   ExportLayer    = vector: { id, label, type: 'vector', idPrefix, features: [{ polygons }], style? }
//                  | raster: { id, label, type: 'raster', idPrefix, rect: { x, y, width, height }, image: { dataUri } }
//
// Layers are listed bottom to top (SVG painter's order). A raster layer always embeds its pixels as a data: URI.
//
// `features[].polygons` hold projected (planar, Y-up) coordinates only.

export const CADASTRE_LAYER = Object.freeze({ id: 'layer-cadastre', label: 'Cadastre', type: 'vector', idPrefix: 'cadastre' });

// Layer drawn above the Cadastre. Ids are neutral (`selection-1`, …): no cadastral identifier ever reaches the SVG.
export const SELECTED_PARCELS_LAYER = Object.freeze({ id: 'layer-selected-parcels', label: 'Parcelles sélectionnées', type: 'vector', idPrefix: 'selection' });

// Layer drawn below the Cadastre: the visible basemap, embedded as raster pixels (never a remote link).
export const BACKGROUND_LAYER = Object.freeze({ id: 'layer-background', label: 'Fond cartographique', type: 'raster', idPrefix: 'background' });

export function createCadastreLayer(features, style) {
  return { ...CADASTRE_LAYER, features, ...(style ? { style } : {}) };
}

export function createExportDocument({ meta, layers }) {
  return { meta, layers };
}
