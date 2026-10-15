import { GpkgSvgError } from '../core/errors.js';
import { defaultSvgFileName, prepareCadastreDocument, renderExportDocument } from '../core/pipeline.js';
import { prepareViewportDocument, renderViewportDocument, viewportSvgFileName } from '../core/viewport-export.js';
import { openGeoPackageFromBytes } from './sqlite-file-reader.js';

// Browser entry point. Everything below runs on an in-memory copy of the file
// chosen by the user: no network, no storage, no attribute decoding.
// Only the `export`ed names of this file are published by the extension bundle.

export const MAX_FILE_BYTES = 256 * 1024 * 1024;

// User-facing messages. Technical detail never reaches the UI.
const MESSAGES = {
  EMPTY_FILE: 'Le fichier est vide.',
  FILE_TOO_LARGE: 'Le fichier est trop volumineux pour être converti dans le navigateur.',
  NOT_GPKG: "Ce fichier n'est pas un GeoPackage. Choisissez le fichier .gpkg obtenu avec « Exporter les données au format SIG ».",
  INVALID_GPKG: 'GeoPackage invalide ou corrompu : impossible de lire ses couches.',
  NO_FEATURE_LAYER: 'Ce GeoPackage ne contient aucune couche vectorielle.',
  LAYER_REQUIRED: 'Ce GeoPackage contient plusieurs couches et aucune couche « parcelle » : sélection ambiguë, conversion impossible.',
  LAYER_NOT_FOUND: 'La couche « parcelle » est absente de ce GeoPackage.',
  UNSUPPORTED_CRS: "Système de coordonnées non supporté (EPSG:4326, EPSG:3857 ou CRS projeté attendus).",
  UNSUPPORTED_GEOMETRY: 'Type de géométrie non supporté : seules les parcelles Polygon / MultiPolygon sont converties.',
  EMPTY_LAYER: 'La couche ne contient aucune géométrie exploitable.',
  INVALID_GEOMETRY: 'Une géométrie du fichier est invalide ou corrompue.',
  INVALID_VIEWPORT_CAPTURE: 'Le cadastre visible n’a pas pu être converti.',
  INVALID_RASTER_LAYER: 'Le fond cartographique n’a pas pu être intégré au SVG.',
  COORD_OUT_OF_RANGE: 'Des coordonnées sont hors du domaine du système de coordonnées déclaré.',
};
export const GENERIC_CONVERSION_ERROR = 'Erreur de conversion : le fichier n’a pas pu être traité.';

export function describeError(error) {
  if (error instanceof GpkgSvgError && MESSAGES[error.code]) return MESSAGES[error.code];
  return GENERIC_CONVERSION_ERROR;
}

// Parses the GeoPackage bytes and returns a non-sensitive summary plus the
// in-memory ExportDocument (projected geometries only, no attributes).
export function loadGeoPackageBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new GpkgSvgError('INVALID_GPKG', 'Contenu binaire attendu.');
  if (bytes.length === 0) throw new GpkgSvgError('EMPTY_FILE', 'Le fichier est vide.');
  if (bytes.length > MAX_FILE_BYTES) throw new GpkgSvgError('FILE_TOO_LARGE', 'Fichier trop volumineux.');
  const gpkg = openGeoPackageFromBytes(bytes);
  try {
    const { document, summary } = prepareCadastreDocument(gpkg);
    return { document, summary };
  } finally {
    gpkg.close();
  }
}

export function exportDocumentToSvg(document, { now = new Date(), width, padding } = {}) {
  return { svg: renderExportDocument(document, { now, width, padding }), fileName: defaultSvgFileName(now) };
}

// Visible map (embedded basemap when complete + Cadastre + selected parcels when present, already in viewport pixels) -> SVG. Pure: no page, network or storage access.
export function exportVisibleCadastre(capture, { now = new Date() } = {}) {
  const document = prepareViewportDocument(capture);
  return { svg: renderViewportDocument(document, { now }), fileName: viewportSvgFileName(now), summary: { features: document.meta.featureCount, ...(document.meta.backgroundEmbedded ? { backgroundEmbedded: true } : {}), ...(document.meta.selectedFeatureCount > 0 ? { selectedFeatures: document.meta.selectedFeatureCount } : {}), width: document.meta.viewport.width, height: document.meta.viewport.height } };
}

// UI-independent state machine. Dependencies are injected (`save` performs the
// Blob download in the page; tests inject a fake) so the flow is testable.
export function createExportController({ save, now = () => new Date(), report = () => {} } = {}) {
  let state = { status: 'idle' };
  let document = null;
  let generation = 0;

  const fail = (error) => {
    document = null;
    // Technical detail: error class + code only, never messages or values.
    report({ name: error?.name, code: error?.code });
    state = { status: 'error', message: describeError(error) };
    return state;
  };

  return {
    get state() {
      return state;
    },
    reset() {
      generation += 1;
      document = null;
      state = { status: 'idle' };
      return state;
    },
    async selectFile(file) {
      const current = ++generation;
      document = null; // release the previous file's data
      state = { status: 'loading' };
      try {
        if (!file) return (state = { status: 'idle' });
        if (file.size === 0) throw new GpkgSvgError('EMPTY_FILE', 'Le fichier est vide.');
        if (file.size > MAX_FILE_BYTES) throw new GpkgSvgError('FILE_TOO_LARGE', 'Fichier trop volumineux.');
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (current !== generation) return state; // a newer selection superseded this one
        const loaded = loadGeoPackageBytes(bytes);
        document = loaded.document;
        state = { status: 'loaded', summary: { ...loaded.summary } };
      } catch (error) {
        if (current === generation) fail(error);
      }
      return state;
    },
    exportSvg() {
      if (!document) return (state = { status: 'error', message: 'Aucun GeoPackage chargé.' });
      try {
        const date = now();
        const { svg, fileName } = exportDocumentToSvg(document, { now: date });
        save(fileName, svg);
        state = { ...state, status: 'exported', fileName };
      } catch (error) {
        const summary = state.summary;
        fail(error);
        state = { ...state, summary };
      }
      return state;
    },
  };
}
