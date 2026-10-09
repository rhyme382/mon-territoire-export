import { GpkgSvgError } from './errors.js';

// Decodes a GeoPackage geometry blob (GP header + WKB) into plain coordinate
// arrays. Only Polygon and MultiPolygon are supported; anything else throws.
//
// Result shape: { type: 'Polygon'|'MultiPolygon', polygons: Ring[][] }
// where polygons[i][0] is the outer ring and polygons[i][1..] are holes.
// Rings are arrays of [x, y]; Z/M ordinates are read and dropped.

const ENVELOPE_BYTES = [0, 32, 48, 48, 64];
const WKB_POLYGON = 3;
const WKB_MULTIPOLYGON = 6;
const EWKB_Z = 0x80000000;
const EWKB_M = 0x40000000;
const EWKB_SRID = 0x20000000;

export function parseGpkgHeader(blob) {
  const bytes = toBytes(blob);
  if (bytes.length < 8 || bytes[0] !== 0x47 || bytes[1] !== 0x50) {
    throw new GpkgSvgError('INVALID_GEOMETRY', 'Blob géométrique invalide : en-tête GeoPackage "GP" absent.');
  }
  const version = bytes[2];
  if (version !== 0) {
    throw new GpkgSvgError('INVALID_GEOMETRY', `Version d'en-tête GeoPackage non supportée : ${version}.`);
  }
  const flags = bytes[3];
  if (flags & 0x20) {
    throw new GpkgSvgError('UNSUPPORTED_GEOMETRY', 'Géométrie GeoPackage étendue (ExtendedGeoPackageBinary) non supportée.');
  }
  const envelopeIndicator = (flags >> 1) & 0x07;
  if (envelopeIndicator > 4) {
    throw new GpkgSvgError('INVALID_GEOMETRY', `Indicateur d'enveloppe invalide : ${envelopeIndicator}.`);
  }
  const littleEndian = (flags & 0x01) === 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    srsId: view.getInt32(4, littleEndian),
    empty: (flags & 0x10) !== 0,
    littleEndian,
    envelopeBytes: ENVELOPE_BYTES[envelopeIndicator],
    wkbOffset: 8 + ENVELOPE_BYTES[envelopeIndicator],
  };
}

export function parseGpkgGeometry(blob) {
  const bytes = toBytes(blob);
  const header = parseGpkgHeader(bytes);
  if (header.empty) return null;
  if (bytes.length <= header.wkbOffset) {
    throw new GpkgSvgError('INVALID_GEOMETRY', 'Blob géométrique tronqué : WKB absent.');
  }
  return parseWkb(bytes.subarray(header.wkbOffset));
}

export function parseWkb(input) {
  const bytes = toBytes(input);
  const reader = new Reader(bytes);
  const geometry = readGeometry(reader);
  return geometry;
}

function readGeometry(reader) {
  const { type, dims, littleEndian } = reader.readHeader();
  if (type === WKB_POLYGON) {
    return { type: 'Polygon', polygons: [readPolygonBody(reader, dims, littleEndian)] };
  }
  if (type === WKB_MULTIPOLYGON) {
    const count = reader.u32(littleEndian);
    const polygons = [];
    for (let i = 0; i < count; i += 1) {
      const child = reader.readHeader();
      if (child.type !== WKB_POLYGON) {
        throw new GpkgSvgError('UNSUPPORTED_GEOMETRY', `MultiPolygon contenant un sous-type WKB ${child.type} non supporté.`);
      }
      polygons.push(readPolygonBody(reader, child.dims, child.littleEndian));
    }
    return { type: 'MultiPolygon', polygons };
  }
  throw new GpkgSvgError('UNSUPPORTED_GEOMETRY', `Type géométrique WKB ${type} non supporté (Polygon et MultiPolygon uniquement).`);
}

function readPolygonBody(reader, dims, littleEndian) {
  const ringCount = reader.u32(littleEndian);
  const rings = [];
  for (let r = 0; r < ringCount; r += 1) {
    const pointCount = reader.u32(littleEndian);
    reader.assertAvailable(pointCount * dims * 8);
    const ring = [];
    for (let p = 0; p < pointCount; p += 1) {
      const x = reader.f64(littleEndian);
      const y = reader.f64(littleEndian);
      for (let extra = 2; extra < dims; extra += 1) reader.f64(littleEndian);
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        throw new GpkgSvgError('INVALID_GEOMETRY', 'Coordonnée non finie dans la géométrie.');
      }
      ring.push([x, y]);
    }
    rings.push(ring);
  }
  return rings;
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }

  assertAvailable(count) {
    if (count < 0 || this.offset + count > this.bytes.length) {
      throw new GpkgSvgError('INVALID_GEOMETRY', 'WKB tronqué ou corrompu.');
    }
  }

  u8() {
    this.assertAvailable(1);
    return this.bytes[this.offset++];
  }

  u32(le) {
    this.assertAvailable(4);
    const value = this.view.getUint32(this.offset, le);
    this.offset += 4;
    return value;
  }

  f64(le) {
    this.assertAvailable(8);
    const value = this.view.getFloat64(this.offset, le);
    this.offset += 8;
    return value;
  }

  // Handles ISO (1000/2000/3000 offsets) and EWKB (flag bits) type codes.
  readHeader() {
    const order = this.u8();
    if (order !== 0 && order !== 1) {
      throw new GpkgSvgError('INVALID_GEOMETRY', `Octet d'ordre WKB invalide : ${order}.`);
    }
    const littleEndian = order === 1;
    let raw = this.u32(littleEndian);
    let hasZ = false;
    let hasM = false;
    if (raw & EWKB_Z) hasZ = true;
    if (raw & EWKB_M) hasM = true;
    if (raw & EWKB_SRID) this.u32(littleEndian);
    raw &= 0x0fffffff;
    const isoClass = Math.floor(raw / 1000);
    if (isoClass === 1 || isoClass === 3) hasZ = true;
    if (isoClass === 2 || isoClass === 3) hasM = true;
    if (isoClass > 3) {
      throw new GpkgSvgError('UNSUPPORTED_GEOMETRY', `Type WKB ${raw} non supporté.`);
    }
    return { type: raw % 1000, dims: 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0), littleEndian };
  }
}

function toBytes(blob) {
  if (blob instanceof Uint8Array) return blob;
  throw new GpkgSvgError('INVALID_GEOMETRY', 'Géométrie absente ou de type inattendu (blob binaire attendu).');
}
