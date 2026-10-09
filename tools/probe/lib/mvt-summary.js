export const DEFAULT_LIMITS = Object.freeze({ maxBytes: 1_000_000, maxLayers: 32, maxFeatures: 10_000, maxTags: 20_000, maxPropertyNames: 128, maxGeometryCommands: 100_000 });

class Reader {
  constructor(bytes) { this.bytes = bytes; this.pos = 0; }
  varint() { let value = 0; for (let shift = 0; shift < 35; shift += 7) { if (this.pos >= this.bytes.length) throw new Error('truncated'); const byte = this.bytes[this.pos++]; value += (byte & 127) * 2 ** shift; if (!(byte & 128)) return value; } throw new Error('invalid-varint'); }
  bytesField() { const length = this.varint(); if (!Number.isSafeInteger(length) || length < 0 || this.pos + length > this.bytes.length) throw new Error('truncated'); const result = this.bytes.subarray(this.pos, this.pos + length); this.pos += length; return result; }
  skip(wire) { if (wire === 0) { this.varint(); return; } if (wire === 2) { this.bytesField(); return; } if (wire === 1) { this.pos += 8; } else if (wire === 5) { this.pos += 4; } else throw new Error('unsupported-wire'); if (this.pos > this.bytes.length) throw new Error('truncated'); }
}
function field(reader) { const tag = reader.varint(); return { number: tag >>> 3, wire: tag & 7 }; }
function text(bytes) { const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); return value.length <= 96 && /^[\x20-\x7e]+$/.test(value) ? value : null; }
function packed(reader, limit) { const nested = new Reader(reader.bytesField()); const values = []; while (nested.pos < nested.bytes.length) { if (values.length >= limit) throw new Error('limit-tags'); values.push(nested.varint()); } return values; }
function countGeometry(bytes, limit) { const reader = new Reader(bytes); let commands = 0; let vertices = 0; while (reader.pos < reader.bytes.length) { const command = reader.varint(); const id = command & 7; const count = command >>> 3; if (!count || ![1, 2, 7].includes(id) || commands + count > limit) throw new Error('invalid-geometry'); commands += count; if (id === 1 || id === 2) { for (let i = 0; i < count; i++) { reader.varint(); reader.varint(); vertices++; } } } return vertices; }
function parseFeature(bytes, limits) { const reader = new Reader(bytes); let type = 0; let vertices = 0; let tags = 0; while (reader.pos < reader.bytes.length) { const entry = field(reader); if (entry.number === 2 && entry.wire === 2) tags += packed(reader, limits.maxTags).length; else if (entry.number === 3 && entry.wire === 0) type = reader.varint(); else if (entry.number === 4 && entry.wire === 2) vertices += countGeometry(reader.bytesField(), limits.maxGeometryCommands); else reader.skip(entry.wire); } if (tags > limits.maxTags || tags % 2) throw new Error('invalid-tags'); return { type, vertices }; }
function parseLayer(bytes, limits) { const reader = new Reader(bytes); let name = null; let extent; let featureCount = 0; let vertexCount = 0; const propertyNames = []; const geometryTypes = { Point: 0, LineString: 0, Polygon: 0 }; while (reader.pos < reader.bytes.length) { const entry = field(reader); if (entry.number === 1 && entry.wire === 2) name = text(reader.bytesField()); else if (entry.number === 2 && entry.wire === 2) { if (++featureCount > limits.maxFeatures) throw new Error('limit-features'); const feature = parseFeature(reader.bytesField(), limits); vertexCount += feature.vertices; const type = ({ 1: 'Point', 2: 'LineString', 3: 'Polygon' })[feature.type]; if (type) geometryTypes[type]++; } else if (entry.number === 3 && entry.wire === 2) { if (propertyNames.length >= limits.maxPropertyNames) throw new Error('limit-properties'); const key = text(reader.bytesField()); if (key) propertyNames.push(key); } else if (entry.number === 5 && entry.wire === 0) extent = reader.varint(); else reader.skip(entry.wire); }
  if (!name) throw new Error('invalid-layer');
  return { name, ...(Number.isSafeInteger(extent) ? { extent } : {}), featureCount, propertyNames, geometryTypes, vertexCount };
}

export function summarizeMvt(buffer, options = DEFAULT_LIMITS) {
  const limits = { ...DEFAULT_LIMITS, ...options };
  try {
    if (!(buffer instanceof ArrayBuffer) || buffer.byteLength > limits.maxBytes) throw new Error('input-limit');
    const reader = new Reader(new Uint8Array(buffer)); const layers = []; let featureCount = 0; let vertexCount = 0;
    while (reader.pos < reader.bytes.length) { const entry = field(reader); if (entry.number === 3 && entry.wire === 2) { if (layers.length >= limits.maxLayers) throw new Error('limit-layers'); const layer = parseLayer(reader.bytesField(), limits); layers.push({ name: layer.name, ...(layer.extent !== undefined ? { extent: layer.extent } : {}), propertyNames: layer.propertyNames, geometryTypes: layer.geometryTypes }); featureCount += layer.featureCount; vertexCount += layer.vertexCount; } else reader.skip(entry.wire); }
    return { status: 'ok', byteCount: buffer.byteLength, layers, featureCount, vertexCount };
  } catch (error) { return { status: 'unreadable', reason: error instanceof Error ? error.message : 'invalid' }; }
}
