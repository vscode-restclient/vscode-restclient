// Generates images/icon.png (256x256) and images/icon.svg with no dependency.
//
// Design: Argalla's navy tile with two opposite arrows, the request going out
// and the response coming back. No asset of the original project is inherited:
// its icon is theirs, MIT code or not.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PNG = path.join(ROOT, 'images', 'icon.png');
const OUT_SVG = path.join(ROOT, 'images', 'icon.svg');

const SIZE = 256;
const UNIT = 128;
const K = SIZE / UNIT;
const SS = 4;
const NAVY = [0x0f, 0x1a, 0x24];
const TURQ = [0x4e, 0xc5, 0xbe];
const BLUE = [0x3b, 0x82, 0xf6];

const RADIUS = 28;
const STROKE = 11;
// Outbound arrow (top, pointing right) and return arrow (bottom, pointing left).
const OUT = { a: [30, 47], b: [92, 47] };
const OUT_HEAD = [[76, 33], [92, 47], [76, 61]];
const BACK = { a: [98, 81], b: [36, 81] };
const BACK_HEAD = [[52, 67], [36, 81], [52, 95]];

const sdRoundRect = (x, y, w, h, r) => {
  const qx = Math.abs(x - w / 2) - (w / 2 - r);
  const qy = Math.abs(y - h / 2) - (h / 2 - r);
  return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
};
const sdSegment = (px, py, [ax, ay], [bx, by]) => {
  const vx = bx - ax, vy = by - ay, wx = px - ax, wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  return Math.hypot(wx - t * vx, wy - t * vy);
};
const sdPolyline = (px, py, points) => {
  let d = Infinity;
  for (let i = 0; i < points.length - 1; i++) d = Math.min(d, sdSegment(px, py, points[i], points[i + 1]));
  return d;
};

const W = SIZE * SS;
const rgba = new Uint8ClampedArray(W * W * 4);
for (let j = 0; j < W; j++) {
  for (let i = 0; i < W; i++) {
    const x = (i + 0.5) / SS / K, y = (j + 0.5) / SS / K;
    let r = 0, g = 0, b = 0, a = 0;
    if (sdRoundRect(x, y, UNIT, UNIT, RADIUS) <= 0) {
      [r, g, b] = NAVY; a = 255;
      const dOut = Math.min(sdSegment(x, y, OUT.a, OUT.b), sdPolyline(x, y, OUT_HEAD));
      if (dOut <= STROKE / 2) [r, g, b] = TURQ;
      const dBack = Math.min(sdSegment(x, y, BACK.a, BACK.b), sdPolyline(x, y, BACK_HEAD));
      if (dBack <= STROKE / 2) [r, g, b] = BLUE;
    }
    const o = (j * W + i) * 4;
    rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = a;
  }
}

const px = new Uint8Array(SIZE * SIZE * 4);
for (let j = 0; j < SIZE; j++) {
  for (let i = 0; i < SIZE; i++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sj = 0; sj < SS; sj++) for (let si = 0; si < SS; si++) {
      const o = ((j * SS + sj) * W + (i * SS + si)) * 4;
      const al = rgba[o + 3] / 255;
      r += rgba[o] * al; g += rgba[o + 1] * al; b += rgba[o + 2] * al; a += al;
    }
    const n = SS * SS;
    const o = (j * SIZE + i) * 4;
    if (a > 0) { px[o] = Math.round(r / a); px[o + 1] = Math.round(g / a); px[o + 2] = Math.round(b / a); }
    px[o + 3] = Math.round((a / n) * 255);
  }
}

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6;
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let j = 0; j < SIZE; j++) {
  raw[j * (SIZE * 4 + 1)] = 0;
  Buffer.from(px.buffer, j * SIZE * 4, SIZE * 4).copy(raw, j * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
]);
fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
fs.writeFileSync(OUT_PNG, png);

const hex = ([r, g, b]) => '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
const line = (p, color) => `  <polyline points="${p.map(q => q.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`;
fs.writeFileSync(OUT_SVG, [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UNIT} ${UNIT}" width="${SIZE}" height="${SIZE}">`,
  `  <rect width="${UNIT}" height="${UNIT}" rx="${RADIUS}" fill="${hex(NAVY)}"/>`,
  line([OUT.a, OUT.b], hex(TURQ)),
  line(OUT_HEAD, hex(TURQ)),
  line([BACK.a, BACK.b], hex(BLUE)),
  line(BACK_HEAD, hex(BLUE)),
  '</svg>', ''
].join('\n'));
console.log(`icon written: ${OUT_PNG} (${png.length} bytes)`);
