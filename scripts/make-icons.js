'use strict';
/**
 * Generates the PWA icons (public/icons/icon-192.png, icon-512.png) with no
 * dependencies: a red rounded square with a white play triangle. Run once:
 *   node scripts/make-icons.js
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

function png(size, pixelAt) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelAt(x, y);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Red (#ff0033) rounded square filling the canvas, white triangle in the middle. */
function iconPixel(size, maskable) {
  const pad = maskable ? 0 : size * 0.08;
  const radius = size * 0.22;
  const inside = (x, y) => {
    const l = pad, t = pad, r = size - pad, b = size - pad;
    if (x < l || x >= r || y < t || y >= b) return false;
    const cx = x < l + radius ? l + radius : x > r - radius ? r - radius : x;
    const cy = y < t + radius ? t + radius : y > b - radius ? b - radius : y;
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
  };
  // Triangle: pointing right, centred, ~44% of the size wide.
  const tw = size * 0.40, th = size * 0.44;
  const tx = size / 2 - tw / 2 + size * 0.04, ty = size / 2 - th / 2;
  const inTri = (x, y) => {
    if (x < tx || x > tx + tw) return false;
    const frac = (x - tx) / tw; // 0 at left edge, 1 at the tip
    const half = (th / 2) * (1 - frac);
    return Math.abs(y - (ty + th / 2)) <= half;
  };
  return (x, y) => {
    const px = x + 0.5, py = y + 0.5;
    if (!inside(px, py)) return [0, 0, 0, 0];
    if (inTri(px, py)) return [255, 255, 255, 255];
    return [255, 0, 51, 255];
  };
}

const out = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const size of [192, 512]) {
  fs.writeFileSync(path.join(out, `icon-${size}.png`), png(size, iconPixel(size, false)));
  fs.writeFileSync(path.join(out, `maskable-${size}.png`), png(size, iconPixel(size, true)));
}
console.log('icons written to', out);
