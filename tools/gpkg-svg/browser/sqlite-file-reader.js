import { GpkgSvgError } from '../core/errors.js';
import { GeoPackage } from '../core/geopackage.js';

// Browser adapter: minimal, read-only SQLite file-format reader working on an
// in-memory Uint8Array. No WASM, no Node API, no dependency.
//
// Scope (enough for GeoPackage): rowid tables stored as table b-trees, with
// overflow pages. Only the columns explicitly requested are decoded; every
// other column of a record (i.e. all cadastral attributes) is skipped by its
// serial-type length and never turned into a JS value.
// Not supported: WITHOUT ROWID tables, virtual tables (never needed here).

const MAGIC = 'SQLite format 3\u0000';
const MAX_DEPTH = 24;
const PAGE_LEAF_TABLE = 0x0d;
const PAGE_INTERIOR_TABLE = 0x05;

const invalid = (message = 'Fichier invalide : base SQLite corrompue ou tronquée.') => new GpkgSvgError('INVALID_GPKG', message);

export function openGeoPackageFromBytes(bytes) {
  return new GeoPackage(new SqliteFileReader(bytes));
}

export class SqliteFileReader {
  constructor(bytes) {
    if (!(bytes instanceof Uint8Array)) throw invalid("Fichier invalide : contenu binaire attendu.");
    if (bytes.length === 0) throw new GpkgSvgError('EMPTY_FILE', 'Le fichier est vide.');
    if (bytes.length < 100 || !hasMagic(bytes)) {
      throw new GpkgSvgError('NOT_GPKG', "Ce fichier n'est pas un GeoPackage (en-tête SQLite absent).");
    }
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const rawPageSize = this.view.getUint16(16, false);
    this.pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    if (this.pageSize < 512 || (this.pageSize & (this.pageSize - 1)) !== 0) throw invalid();
    this.usable = this.pageSize - bytes[20];
    this.pageCount = Math.floor(bytes.length / this.pageSize);
    if (this.pageCount < 1 || this.usable < 480) throw invalid();
    const encoding = this.view.getUint32(56, false);
    this.textDecoder = new TextDecoder(encoding === 2 ? 'utf-16le' : encoding === 3 ? 'utf-16be' : 'utf-8');
    this.tables = this.#readSchema();
  }

  close() {
    this.bytes = null;
    this.view = null;
  }

  listFeatureLayers() {
    const contents = this.#table('gpkg_contents');
    const geomCols = this.#table('gpkg_geometry_columns');
    if (!contents || !geomCols) {
      throw invalid('Fichier invalide : tables système GeoPackage (gpkg_contents / gpkg_geometry_columns) absentes.');
    }
    const features = new Set();
    for (const row of this.#rows(contents, ['table_name', 'data_type'])) {
      if (row.data_type === 'features' && typeof row.table_name === 'string') features.add(row.table_name);
    }
    const layers = [];
    for (const row of this.#rows(geomCols, ['table_name', 'column_name', 'geometry_type_name', 'srs_id'])) {
      if (features.has(row.table_name)) {
        layers.push({ tableName: row.table_name, geometryColumn: row.column_name, geometryType: row.geometry_type_name, srsId: row.srs_id });
      }
    }
    return layers.sort((a, b) => (a.tableName < b.tableName ? -1 : a.tableName > b.tableName ? 1 : 0));
  }

  getSrsRow(srsId) {
    const table = this.#table('gpkg_spatial_ref_sys');
    if (!table) throw invalid('Fichier invalide : table gpkg_spatial_ref_sys absente.');
    for (const row of this.#rows(table, ['srs_id', 'organization', 'organization_coordsys_id', 'definition'])) {
      if (row.srs_id === srsId) {
        return { srsId: row.srs_id, organization: row.organization, coordsysId: row.organization_coordsys_id, definition: row.definition };
      }
    }
    return null;
  }

  // Only the geometry column is decoded.
  *readGeometryBlobs(layer) {
    const table = this.#table(layer.tableName);
    if (!table) throw invalid('Fichier invalide : table de features absente.');
    for (const row of this.#rows(table, [layer.geometryColumn], true)) {
      const value = row[layer.geometryColumn];
      yield value instanceof Uint8Array ? value : null;
    }
  }

  // ---- schema -----------------------------------------------------------

  #readSchema() {
    const tables = new Map();
    // sqlite_master: type, name, tbl_name, rootpage, sql
    for (const cells of this.#scan(1, new Set([0, 1, 3, 4]))) {
      if (cells[0] !== 'table' || typeof cells[1] !== 'string' || typeof cells[4] !== 'string') continue;
      if (/^\s*CREATE\s+VIRTUAL\s/i.test(cells[4])) continue;
      tables.set(cells[1].toLowerCase(), { name: cells[1], root: cells[3], sql: cells[4], columns: null });
    }
    return tables;
  }

  #table(name) {
    const table = this.tables.get(String(name).toLowerCase());
    if (!table) return null;
    table.columns ??= parseColumns(table.sql);
    return table;
  }

  // Decodes the named columns of every row. Rowid aliases (INTEGER PRIMARY
  // KEY) are stored as NULL in the record and are substituted by the rowid.
  *#rows(table, names, geometryOnly = false) {
    const wanted = new Map();
    for (const name of names) {
      const index = table.columns.findIndex((c) => c.name.toLowerCase() === String(name).toLowerCase());
      if (index < 0) {
        if (geometryOnly) throw invalid('Fichier invalide : colonne géométrie absente de la table.');
        continue;
      }
      wanted.set(index, name);
    }
    const aliasIndex = table.columns.findIndex((c) => c.rowidAlias);
    for (const cells of this.#scan(table.root, new Set(wanted.keys()), aliasIndex)) {
      const row = {};
      for (const [index, name] of wanted) row[name] = cells[index] ?? null;
      yield row;
    }
  }

  // ---- b-tree traversal ---------------------------------------------------

  // Yields, per row, a sparse array holding only the requested column indexes.
  *#scan(rootPage, wanted, aliasIndex = -1) {
    if (!Number.isInteger(rootPage) || rootPage < 1 || rootPage > this.pageCount) throw invalid();
    const visited = new Set();
    const self = this;
    function* walk(page, depth) {
      if (depth > MAX_DEPTH || visited.has(page) || page < 1 || page > self.pageCount) throw invalid();
      visited.add(page);
      const base = (page - 1) * self.pageSize;
      const hdr = base + (page === 1 ? 100 : 0);
      const type = self.bytes[hdr];
      const cellCount = self.view.getUint16(hdr + 3, false);
      if (type === PAGE_INTERIOR_TABLE) {
        const pointers = hdr + 12;
        if (pointers + cellCount * 2 > base + self.pageSize) throw invalid();
        for (let i = 0; i < cellCount; i += 1) {
          const cell = base + self.view.getUint16(pointers + i * 2, false);
          if (cell + 4 > base + self.pageSize) throw invalid();
          yield* walk(self.view.getUint32(cell, false), depth + 1);
        }
        yield* walk(self.view.getUint32(hdr + 8, false), depth + 1);
      } else if (type === PAGE_LEAF_TABLE) {
        const pointers = hdr + 8;
        if (pointers + cellCount * 2 > base + self.pageSize) throw invalid();
        for (let i = 0; i < cellCount; i += 1) {
          const cell = base + self.view.getUint16(pointers + i * 2, false);
          if (cell >= base + self.pageSize) throw invalid();
          yield self.#decodeLeafCell(cell, base, wanted, aliasIndex);
        }
      } else {
        throw invalid('Fichier invalide : structure de table SQLite non supportée.');
      }
    }
    yield* walk(rootPage, 0);
  }

  #decodeLeafCell(cell, pageBase, wanted, aliasIndex) {
    const end = pageBase + this.pageSize;
    let pos = cell;
    const payload = this.#varint(pos, end);
    pos = payload.next;
    const rowid = this.#varint(pos, end);
    pos = rowid.next;
    const total = payload.value;
    const maxLocal = this.usable - 35;
    let record;
    if (total <= maxLocal) {
      if (pos + total > end) throw invalid();
      record = this.bytes.subarray(pos, pos + total);
    } else {
      const minLocal = Math.floor(((this.usable - 12) * 32) / 255) - 23;
      const k = minLocal + ((total - minLocal) % (this.usable - 4));
      const local = k <= maxLocal ? k : minLocal;
      if (pos + local + 4 > end) throw invalid();
      record = new Uint8Array(total);
      record.set(this.bytes.subarray(pos, pos + local), 0);
      let filled = local;
      let next = this.view.getUint32(pos + local, false);
      const seen = new Set();
      while (filled < total) {
        if (next < 1 || next > this.pageCount || seen.has(next)) throw invalid();
        seen.add(next);
        const at = (next - 1) * this.pageSize;
        const chunk = Math.min(this.usable - 4, total - filled);
        record.set(this.bytes.subarray(at + 4, at + 4 + chunk), filled);
        filled += chunk;
        next = this.view.getUint32(at, false);
      }
    }
    const cells = this.#decodeRecord(record, wanted);
    if (aliasIndex >= 0 && wanted.has(aliasIndex)) cells[aliasIndex] = rowid.value;
    return cells;
  }

  #decodeRecord(record, wanted) {
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    const header = readVarint(record, 0, record.length);
    const headerEnd = header.value;
    if (headerEnd > record.length) throw invalid();
    const types = [];
    for (let p = header.next; p < headerEnd; ) {
      const t = readVarint(record, p, headerEnd);
      types.push(t.value);
      p = t.next;
    }
    const cells = [];
    let body = headerEnd;
    for (let i = 0; i < types.length; i += 1) {
      const t = types[i];
      const size = serialSize(t);
      if (body + size > record.length) throw invalid();
      if (wanted.has(i)) cells[i] = this.#decodeValue(t, record, view, body, size);
      body += size;
    }
    return cells;
  }

  #decodeValue(t, record, view, at, size) {
    if (t === 0) return null;
    if (t >= 1 && t <= 6) {
      if (t === 1) return view.getInt8(at);
      if (t === 2) return view.getInt16(at, false);
      if (t === 3) return ((view.getInt8(at) << 16) | view.getUint16(at + 1, false)) | 0;
      if (t === 4) return view.getInt32(at, false);
      if (t === 5) return view.getInt16(at, false) * 4294967296 + view.getUint32(at + 2, false);
      return Number(view.getBigInt64(at, false));
    }
    if (t === 7) return view.getFloat64(at, false);
    if (t === 8) return 0;
    if (t === 9) return 1;
    if (t >= 12 && t % 2 === 0) return record.subarray(at, at + size);
    if (t >= 13) return this.textDecoder.decode(record.subarray(at, at + size));
    throw invalid();
  }

  #varint(pos, end) {
    return readVarint(this.bytes, pos, end);
  }
}

function hasMagic(bytes) {
  for (let i = 0; i < MAGIC.length; i += 1) if (bytes[i] !== MAGIC.charCodeAt(i)) return false;
  return true;
}

function serialSize(t) {
  if (t <= 4) return t; // 0 -> 0, 1..4 -> 1..4
  if (t === 5) return 6;
  if (t === 6 || t === 7) return 8;
  if (t === 8 || t === 9) return 0;
  if (t === 10 || t === 11) throw invalid();
  return t % 2 === 0 ? (t - 12) / 2 : (t - 13) / 2;
}

function readVarint(bytes, pos, end) {
  let value = 0;
  for (let i = 0; i < 9; i += 1) {
    if (pos + i >= end) throw invalid();
    const byte = bytes[pos + i];
    if (i === 8) return { value: value * 256 + byte, next: pos + 9 };
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return { value, next: pos + i + 1 };
  }
  throw invalid();
}

// ---- CREATE TABLE parsing (column names + INTEGER PRIMARY KEY detection) ----

export function parseColumns(sql) {
  if (/\bWITHOUT\s+ROWID\b/i.test(sql.slice(sql.lastIndexOf(')')))) {
    throw new GpkgSvgError('INVALID_GPKG', 'Fichier invalide : table WITHOUT ROWID non supportée.');
  }
  const open = sql.indexOf('(');
  if (open < 0) throw invalid();
  const defs = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (let i = open + 1; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '[') quote = ']';
    if (quote) {
      current += ch;
      continue;
    }
    if (ch === '(') depth += 1;
    if (ch === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    if (ch === ',' && depth === 0) {
      defs.push(current);
      current = '';
    } else current += ch;
  }
  defs.push(current);
  const columns = [];
  let tablePk = null;
  for (const raw of defs) {
    const def = raw.trim();
    if (!def) continue;
    if (/^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN)\b/i.test(def)) {
      const pk = def.match(/^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\s*\(\s*([^,)]+?)\s*\)/i);
      if (pk) tablePk = unquote(pk[1]).toLowerCase();
      continue;
    }
    const nameMatch = def.match(/^("(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|'[^']+'|[^\s]+)\s*([\s\S]*)$/);
    if (!nameMatch) continue;
    const rest = nameMatch[2];
    const type = rest.match(/^([A-Za-z]+)/)?.[1]?.toUpperCase() ?? '';
    columns.push({ name: unquote(nameMatch[1]), rowidAlias: type === 'INTEGER' && /\bPRIMARY\s+KEY\b/i.test(rest) && !/\bPRIMARY\s+KEY\s+DESC\b/i.test(rest) });
  }
  if (tablePk && !columns.some((c) => c.rowidAlias)) {
    const col = columns.find((c) => c.name.toLowerCase() === tablePk);
    const type = col && defs.map((d) => d.trim()).find((d) => unquote(d.split(/\s+/)[0]).toLowerCase() === tablePk)?.match(/^\S+\s+([A-Za-z]+)/)?.[1];
    if (col && type?.toUpperCase() === 'INTEGER') col.rowidAlias = true;
  }
  return columns;
}

function unquote(name) {
  const first = name[0];
  if (first === '"') return name.slice(1, -1).replaceAll('""', '"');
  if (first === '`' || first === "'") return name.slice(1, -1);
  if (first === '[') return name.slice(1, -1);
  return name;
}
