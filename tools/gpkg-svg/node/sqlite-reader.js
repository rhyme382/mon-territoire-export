import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { GpkgSvgError } from '../core/errors.js';
import { GeoPackage } from '../core/geopackage.js';

// Node adapter: reader on top of node:sqlite (built into Node >= 22.13, no
// dependency). Only gpkg_* system tables and the geometry column are read.

export function openGeoPackage(path) {
  if (!existsSync(path)) {
    throw new GpkgSvgError('INPUT_NOT_FOUND', 'Fichier GeoPackage introuvable.');
  }
  let db;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    db.prepare('SELECT 1 FROM sqlite_master LIMIT 1').get();
  } catch {
    db?.close();
    throw new GpkgSvgError('INVALID_GPKG', "Fichier invalide : ce n'est pas une base SQLite/GeoPackage.");
  }
  return new GeoPackage(new NodeSqliteReader(db));
}

export class NodeSqliteReader {
  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  listFeatureLayers() {
    try {
      return this.db
        .prepare(
          `SELECT c.table_name AS tableName, g.column_name AS geometryColumn,
                  g.geometry_type_name AS geometryType, g.srs_id AS srsId
             FROM gpkg_contents c
             JOIN gpkg_geometry_columns g ON g.table_name = c.table_name
            WHERE c.data_type = 'features'
            ORDER BY c.table_name`,
        )
        .all();
    } catch {
      throw new GpkgSvgError('INVALID_GPKG', 'Fichier invalide : tables système GeoPackage (gpkg_contents / gpkg_geometry_columns) absentes.');
    }
  }

  getSrsRow(srsId) {
    return (
      this.db
        .prepare('SELECT srs_id AS srsId, organization, organization_coordsys_id AS coordsysId, definition FROM gpkg_spatial_ref_sys WHERE srs_id = ?')
        .get(srsId) ?? null
    );
  }

  readGeometryBlobs(layer) {
    const sql = `SELECT ${quoteIdent(layer.geometryColumn)} AS geom FROM ${quoteIdent(layer.tableName)}`;
    return this.db.prepare(sql).all().map((row) => row.geom);
  }
}

function quoteIdent(name) {
  return `"${String(name).replaceAll('"', '""')}"`;
}
