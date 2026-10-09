import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';

// Fully synthetic GeoPackage builder (deterministic). Coordinates are around
// an arbitrary fictitious spot; attributes are meaningless placeholders.

export function wkbPolygon(rings, { le = true, z = false } = {}) {
  const parts = [];
  const u32 = (n) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(n) : b.writeUInt32BE(n); return b; };
  const f64 = (n) => { const b = Buffer.alloc(8); le ? b.writeDoubleLE(n) : b.writeDoubleBE(n); return b; };
  parts.push(Buffer.from([le ? 1 : 0]), u32(z ? 1003 : 3), u32(rings.length));
  for (const ring of rings) {
    parts.push(u32(ring.length));
    for (const [x, y] of ring) parts.push(f64(x), f64(y), ...(z ? [f64(99)] : []));
  }
  return Buffer.concat(parts);
}

export function wkbMultiPolygon(polygons, opts = {}) {
  const le = opts.le ?? true;
  const u32 = (n) => { const b = Buffer.alloc(4); le ? b.writeUInt32LE(n) : b.writeUInt32BE(n); return b; };
  return Buffer.concat([Buffer.from([le ? 1 : 0]), u32(6), u32(polygons.length), ...polygons.map((p) => wkbPolygon(p, opts))]);
}

export function wkbPoint([x, y]) {
  const b = Buffer.alloc(21);
  b.writeUInt8(1, 0); b.writeUInt32LE(1, 1); b.writeDoubleLE(x, 5); b.writeDoubleLE(y, 13);
  return b;
}

export function gpkgBlob(wkb, { srsId = 4326, le = true, envelope = false, empty = false } = {}) {
  const header = Buffer.alloc(8 + (envelope ? 32 : 0));
  header.write('GP', 0, 'latin1');
  header.writeUInt8(0, 2);
  header.writeUInt8((le ? 1 : 0) | (envelope ? 1 << 1 : 0) | (empty ? 0x10 : 0), 3);
  le ? header.writeInt32LE(srsId, 4) : header.writeInt32BE(srsId, 4);
  return Buffer.concat([header, wkb]);
}

export const closed = (pts) => [...pts, pts[0]];
export const SQUARE = closed([[2.0, 48.0], [2.01, 48.0], [2.01, 48.01], [2.0, 48.01]]);
export const HOLE = closed([[2.004, 48.004], [2.004, 48.006], [2.006, 48.006], [2.006, 48.004]]);
export const HOLE_C = closed([[2.024, 48.024], [2.024, 48.026], [2.026, 48.026], [2.026, 48.024]]);
export const SQUARE_B = closed([[2.02, 48.0], [2.03, 48.0], [2.03, 48.01], [2.02, 48.01]]);
export const SQUARE_C = closed([[2.02, 48.02], [2.03, 48.02], [2.03, 48.03], [2.02, 48.03]]);

const SRS_4326 = 'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';

export function createSyntheticGpkg(path, {
  layers = [{ name: 'parcelle', type: 'MULTIPOLYGON' }],
  rows,
} = {}) {
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA application_id = 1196444487;
    CREATE TABLE gpkg_spatial_ref_sys (srs_name TEXT, srs_id INTEGER PRIMARY KEY, organization TEXT, organization_coordsys_id INTEGER, definition TEXT, description TEXT);
    CREATE TABLE gpkg_contents (table_name TEXT PRIMARY KEY, data_type TEXT, identifier TEXT, description TEXT, last_change TEXT, min_x REAL, min_y REAL, max_x REAL, max_y REAL, srs_id INTEGER);
    CREATE TABLE gpkg_geometry_columns (table_name TEXT, column_name TEXT, geometry_type_name TEXT, srs_id INTEGER, z TINYINT, m TINYINT);
  `);
  db.prepare('INSERT INTO gpkg_spatial_ref_sys VALUES (?,?,?,?,?,?)').run('WGS 84', 4326, 'EPSG', 4326, SRS_4326, null);
  const defaultRows = [
    { attr: 'SYNTH-AAA', geom: gpkgBlob(wkbPolygon([SQUARE, HOLE])) },
    { attr: 'SYNTH-BBB', geom: gpkgBlob(wkbMultiPolygon([[SQUARE_B], [SQUARE_C]]), { envelope: true }) },
    { attr: 'SYNTH-CCC', geom: gpkgBlob(wkbMultiPolygon([[SQUARE_C, HOLE_C]], { le: false }), { le: false }) },
  ];
  for (const layer of layers) {
    db.exec(`CREATE TABLE "${layer.name}" (fid INTEGER PRIMARY KEY, geom BLOB, idu TEXT)`);
    db.prepare('INSERT INTO gpkg_contents (table_name,data_type,identifier,srs_id) VALUES (?,?,?,4326)').run(layer.name, 'features', layer.name);
    db.prepare('INSERT INTO gpkg_geometry_columns VALUES (?,?,?,4326,0,0)').run(layer.name, 'geom', layer.type);
    for (const row of layer.rows ?? rows ?? defaultRows) db.prepare(`INSERT INTO "${layer.name}" (geom, idu) VALUES (?,?)`).run(row.geom, row.attr);
  }
  db.close();
}
