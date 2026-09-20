// Genera los íconos de la app (PNG) sin dependencias: un mini-plano de la oficina con las 4 salas.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web', 'icons');
fs.mkdirSync(out, { recursive: true });

const BG = [11, 14, 31], K = [8, 10, 22];
const ROOMS = [[91, 141, 239], [232, 106, 176], [242, 184, 75], [95, 209, 139]]; // backend, frontend, marketing, qa
const hex = (c) => c;

// Arte 16x16
function art() {
  const g = Array.from({ length: 16 }, () => Array(16).fill(BG));
  const rect = (x, y, w, h, c) => { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) g[j][i] = c; };
  rect(1, 1, 14, 14, K);
  [[2, 2], [9, 2], [2, 9], [9, 9]].forEach(([x, y], i) => {
    const c = ROOMS[i];
    rect(x, y, 5, 5, c);
    rect(x, y + 4, 5, 1, c.map((v) => Math.round(v * 0.7)));            // suelo más oscuro
    rect(x + 1, y + 2, 3, 1, [176, 122, 79]);                            // escritorio
    rect(x + 2, y, 1, 1, [255, 255, 255]);                                // cabeza del agente
    rect(x + 2, y + 1, 1, 1, [217, 119, 87]);                             // camiseta
  });
  return g;
}

function png(w, h, rgba) {
  const crcT = (buf) => zlib.crc32(buf) >>> 0;
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crcT(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// size = lado final; scale = píxeles por celda del arte; el arte va centrado sobre el fondo
function render(size, scale) {
  const g = art(), buf = Buffer.alloc(size * size * 4), off = Math.floor((size - 16 * scale) / 2);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const gx = Math.floor((x - off) / scale), gy = Math.floor((y - off) / scale);
    const c = gx >= 0 && gy >= 0 && gx < 16 && gy < 16 ? g[gy][gx] : BG;
    buf.set([...c, 255], (y * size + x) * 4);
  }
  return png(size, size, buf);
}

const files = {
  'icon-192.png': render(192, 12),
  'icon-512.png': render(512, 32),
  'icon-maskable-512.png': render(512, 22),   // ~69 % del lado: dentro de la zona segura de los íconos "maskable"
  'apple-touch-icon.png': render(180, 10),
};
for (const [name, buf] of Object.entries(files)) { fs.writeFileSync(path.join(out, name), buf); console.log(name, buf.length, 'bytes'); }
