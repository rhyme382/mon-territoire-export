// Generates the extension icons (16/32/48/128 px) from vector shapes: no external asset, no dependency, deterministic.
// Design: a map tile with two adjacent cadastral parcels, one of them selected. Run: node tools/probe/make-icons.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;
const COLORS = { background: [21, 34, 56], parcel: [226, 236, 248], selected: [0, 180, 216], outline: [21, 34, 56] };
// Shapes in a 0..1 unit square, painted in order.
const SHAPES = [
  { color: 'parcel', polygon: [[0.16, 0.20], [0.50, 0.14], [0.54, 0.84], [0.18, 0.80]] },
  { color: 'selected', polygon: [[0.54, 0.14], [0.84, 0.22], [0.82, 0.78], [0.54, 0.84]] },
];

function inside(polygon, x, y) {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]; const [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}
function insideRoundedSquare(x, y, radius = 0.18) {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - radius), 0); const dy = Math.max(Math.abs(y - 0.5) - (0.5 - radius), 0);
  return dx * dx + dy * dy <= radius * radius;
}
function sample(x, y) {
  if (!insideRoundedSquare(x, y)) return null;
  let color = COLORS.background;
  for (const shape of SHAPES) if (inside(shape.polygon, x, y)) color = COLORS[shape.color];
  return color;
}
function render(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0; let g = 0; let b = 0; let a = 0;
    for (let sy = 0; sy < SUPERSAMPLE; sy++) for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const color = sample((px + (sx + 0.5) / SUPERSAMPLE) / size, (py + (sy + 0.5) / SUPERSAMPLE) / size);
      if (color) { r += color[0]; g += color[1]; b += color[2]; a++; }
    }
    const total = SUPERSAMPLE * SUPERSAMPLE; const o = (py * size + px) * 4;
    if (a) { rgba[o] = Math.round(r / a); rgba[o + 1] = Math.round(g / a); rgba[o + 2] = Math.round(b / a); rgba[o + 3] = Math.round((255 * a) / total); }
  }
  return rgba;
}
const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = buffer => { let c = 0xffffffff; for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
export function encodePng(size, rgba) {
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6; // 8-bit RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { rows[y * (size * 4 + 1)] = 0; rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4); }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const directory = new URL('./icons/', import.meta.url);
  await mkdir(directory, { recursive: true });
  for (const size of SIZES) await writeFile(new URL(`./icon-${size}.png`, directory), encodePng(size, render(size)));
}
