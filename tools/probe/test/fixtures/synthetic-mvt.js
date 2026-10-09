function varint(value) { const out = []; do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; out.push(byte); } while (value); return out; }
function field(number, bytes) { return [number << 3 | 2, ...varint(bytes.length), ...bytes]; }
function text(number, value) { return field(number, [...new TextEncoder().encode(value)]); }
function packed(number, values) { return field(number, values.flatMap(varint)); }

export function makeSyntheticMvt() {
  const feature = [
    ...packed(2, [0, 0]), 3 << 3, 3,
    ...packed(4, [9, 20, 40, 26, 20, 0, 0, 20, 19, 0, 15])
  ];
  const value = text(1, 'secret-cadastral-value');
  const layer = [
    15 << 3, 2, ...text(1, 'cadastre'), ...field(2, feature), ...text(3, 'parcel_key'), ...field(4, value),
    5 << 3, ...varint(4096)
  ];
  return Uint8Array.from(field(3, layer)).buffer;
}

export function makeSyntheticCadastralMvt() {
  const feature = id => [
    1 << 3, ...varint(id), ...packed(2, [0, 0, 1, 1, 2, 2]), 3 << 3, 3,
    ...packed(4, [9, 20, 40, 26, 20, 0, 0, 20, 19, 0, 15])
  ];
  const values = ['synthetic-idu-value', 'synthetic-insee-value', 'synthetic-section-value'].flatMap(value => field(4, text(1, value)));
  const layer = [
    15 << 3, 2, ...text(1, 'cadastre_parcelle'), ...field(2, feature(1)), ...field(2, feature(2)),
    ...text(3, 'idu'), ...text(3, 'insee'), ...text(3, 'section'), ...values, 5 << 3, ...varint(4096)
  ];
  return Uint8Array.from(field(3, layer)).buffer;
}
