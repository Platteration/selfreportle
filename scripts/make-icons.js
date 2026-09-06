/* Generates icons/icon{16,32,48,128}.png with no dependencies (zlib only). */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x + 0.5, y + 0.5, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* Design: rounded blue square, white "eye" ring with a green pupil, and a
 * small amber check-mark notch — a "provenance lens". Anti-aliased by
 * 4x supersampling. */
function shade(x, y, s) {
  const cx = s / 2, cy = s / 2;
  const R = s * 0.22; // corner radius
  const inside = (px, py) => {
    const dx = Math.max(Math.abs(px - cx) - (s / 2 - R), 0);
    const dy = Math.max(Math.abs(py - cy) - (s / 2 - R), 0);
    return Math.hypot(dx, dy) <= R - 0.5;
  };
  if (!inside(x, y)) return [0, 0, 0, 0];
  const d = Math.hypot(x - cx, y - cy) / s;
  const ring = d > 0.22 && d < 0.30;
  const pupil = d < 0.13;
  const t = (y / s);
  const base = [Math.round(38 + 20 * t), Math.round(96 + 30 * t), Math.round(200 + 10 * t)];
  if (pupil) return [47, 158, 95, 255];
  if (ring) return [255, 255, 255, 255];
  // check notch bottom-right
  const nx = x - s * 0.72, ny = y - s * 0.72;
  if (Math.hypot(nx, ny) < s * 0.14) {
    const onCheck = (Math.abs(ny - (-nx * 0.0)) < s * 0.03 && nx > -s * 0.06 && nx < s * 0.02) || (Math.abs((ny + s * 0.0) - (-nx * 1.4 + s * 0.03)) < s * 0.03 && nx >= s * 0.0 && nx < s * 0.07);
    return onCheck ? [255, 255, 255, 255] : [201, 154, 0, 255];
  }
  return [base[0], base[1], base[2], 255];
}
function pixel(x, y, s) {
  let r = 0, g = 0, b = 0, a = 0;
  const n = 4;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const [pr, pg, pb, pa] = shade(x - 0.5 + (i + 0.5) / n, y - 0.5 + (j + 0.5) / n, s);
    r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
  }
  if (!a) return [0, 0, 0, 0];
  return [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / (n * n))];
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dir, 'icon' + size + '.png'), png(size, pixel));
  console.log('wrote icons/icon' + size + '.png');
}
