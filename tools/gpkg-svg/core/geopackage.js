import { GpkgSvgError } from './errors.js';
import { parseGpkgGeometry } from './gpkg-geometry.js';

// Reader-agnostic GeoPackage model. A "reader" is the only part that knows how
// to open SQLite (built-in SQLite module under Node, a pure-JS file reader in the browser):
//
//   listFeatureLayers() -> [{ tableName, geometryColumn, geometryType, srsId }]
//   getSrsRow(srsId)    -> { srsId, organization, coordsysId, definition } | null
//   readGeometryBlobs(layer) -> Iterable<Uint8Array | null>   (geometry column ONLY)
//   close()
//
// Attribute columns are never requested through this interface.

const SUPPORTED_DECLARED = new Set(['POLYGON', 'MULTIPOLYGON', 'GEOMETRY']);
export const DEFAULT_LAYER = 'parcelle';

export class GeoPackage {
  constructor(reader) {
    this.reader = reader;
    this.layers = reader.listFeatureLayers().map((row) => ({
      tableName: row.tableName,
      geometryColumn: row.geometryColumn,
      geometryType: String(row.geometryType).toUpperCase(),
      srsId: row.srsId,
    }));
  }

  close() {
    this.reader.close?.();
  }

  resolveLayer(requested) {
    if (requested) {
      const layer = this.layers.find((l) => l.tableName === requested);
      if (!layer) {
        throw new GpkgSvgError('LAYER_NOT_FOUND', `Couche "${requested}" introuvable. Couches disponibles : ${this.#names()}.`);
      }
      return layer;
    }
    const preferred = this.layers.find((l) => l.tableName === DEFAULT_LAYER);
    if (preferred) return preferred;
    if (this.layers.length === 1) return this.layers[0];
    if (this.layers.length === 0) {
      throw new GpkgSvgError('NO_FEATURE_LAYER', 'Aucune couche de features dans ce GeoPackage.');
    }
    throw new GpkgSvgError('LAYER_REQUIRED', `Plusieurs couches sans "${DEFAULT_LAYER}" : précisez --layer. Couches disponibles : ${this.#names()}.`);
  }

  #names() {
    return this.layers.map((l) => l.tableName).join(', ') || '(aucune)';
  }

  getSrs(srsId) {
    const row = this.reader.getSrsRow(srsId);
    if (!row) return { srsId, authority: null, code: null, definition: '' };
    const org = row.organization && row.organization.toUpperCase() !== 'NONE' ? row.organization.toUpperCase() : null;
    return {
      srsId: row.srsId,
      authority: org,
      code: org ? row.coordsysId : null,
      definition: String(row.definition ?? ''),
    };
  }

  // Decoded geometries only (never attributes). Null/empty geometries are
  // counted in `skipped`.
  readGeometries(layer) {
    if (!SUPPORTED_DECLARED.has(layer.geometryType)) {
      throw new GpkgSvgError('UNSUPPORTED_GEOMETRY', `Type géométrique déclaré ${layer.geometryType} non supporté (POLYGON / MULTIPOLYGON uniquement).`);
    }
    const geometries = [];
    let skipped = 0;
    for (const blob of this.reader.readGeometryBlobs(layer)) {
      const geometry = blob == null ? null : parseGpkgGeometry(blob);
      if (geometry) geometries.push(geometry);
      else skipped += 1;
    }
    return { geometries, skipped };
  }
}
