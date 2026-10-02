// Genera images/icon.png (256×256) e images/icon.svg sin ninguna dependencia.
//
// Diseño: baldosa azul marino de Argalla con dos flechas opuestas —la petición
// que sale, la respuesta que vuelve—. No se hereda ningún activo del proyecto
// original: su icono es suyo, aunque el código sea MIT.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PNG = path.join(RAIZ, 'images', 'icon.png');
const OUT_SVG = path.join(RAIZ, 'images', 'icon.svg');

const SIZE = 256;
const UNIT = 128;
const K = SIZE / UNIT;
const SS = 4;
const NAVY = [0x0f, 0x1a, 0x24];
const TURQ = [0x4e, 0xc5, 0xbe];
const AZUL = [0x3b, 0x82, 0xf6];

const RADIO = 28;
const GROSOR = 11;
// Flecha de ida (arriba, hacia la derecha) y de vuelta (abajo, hacia la izquierda).
const IDA = { a: [30, 47], b: [92, 47] };
const IDA_P = [[76, 33], [92, 47], [76, 61]];
const VUELTA = { a: [98, 81], b: [36, 81] };
const VUELTA_P = [[52, 67], [36, 81], [52, 95]];

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
const sdPolyline = (px, py, puntos) => {
  let d = Infinity;
  for (let i = 0; i < puntos.length - 1; i++) d = Math.min(d, sdSegment(px, py, puntos[i], puntos[i + 1]));
  return d;
};

const W = SIZE * SS;
const rgba = new Uint8ClampedArray(W * W * 4);
for (let j = 0; j < W; j++) {
  for (let i = 0; i < W; i++) {
    const x = (i + 0.5) / SS / K, y = (j + 0.5) / SS / K;
    let r = 0, g = 0, b = 0, a = 0;
    if (sdRoundRect(x, y, UNIT, UNIT, RADIO) <= 0) {
      [r, g, b] = NAVY; a = 255;
      const dIda = Math.min(sdSegment(x, y, IDA.a, IDA.b), sdPolyline(x, y, IDA_P));
      if (dIda <= GROSOR / 2) [r, g, b] = TURQ;
      const dVuelta = Math.min(sdSegment(x, y, VUELTA.a, VUELTA.b), sdPolyline(x, y, VUELTA_P));
      if (dVuelta <= GROSOR / 2) [r, g, b] = AZUL;
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
const line = (p, color) => `  <polyline points="${p.map(q => q.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="${GROSOR}" stroke-linecap="round" stroke-linejoin="round"/>`;
fs.writeFileSync(OUT_SVG, [
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${UNIT} ${UNIT}" width="${SIZE}" height="${SIZE}">`,
  `  <rect width="${UNIT}" height="${UNIT}" rx="${RADIO}" fill="${hex(NAVY)}"/>`,
  line([IDA.a, IDA.b], hex(TURQ)),
  line(IDA_P, hex(TURQ)),
  line([VUELTA.a, VUELTA.b], hex(AZUL)),
  line(VUELTA_P, hex(AZUL)),
  '</svg>', ''
].join('\n'));
console.log(`icono escrito: ${OUT_PNG} (${png.length} bytes)`);
