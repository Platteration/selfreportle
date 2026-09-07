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

/* Design: a rounded "provenance lens" — a white eye ring on a blue field
 * with a coloured pupil. The pupil colour encodes the page verdict, so the
 * toolbar icon reads as a state even before the badge count is parsed.
 * Anti-aliased by 4x supersampling. */
const STATES = {
  neutral: { pupil: [90, 100, 114], field: [38, 96, 200] },        // slate pupil, idle
  'undisclosed-ai': { pupil: [196, 61, 15], field: [58, 66, 82] },
  'disclosed-ai': { pupil: [165, 98, 0], field: [58, 66, 82] },
  'weak-ai': { pupil: [138, 109, 0], field: [58, 66, 82] },
  provenance: { pupil: [11, 122, 91], field: [58, 66, 82] },
  none: { pupil: [107, 114, 128], field: [58, 66, 82] },
};

function shade(x, y, s, state) {
  const cx = s / 2, cy = s / 2;
  const R = s * 0.22;
  const dx = Math.max(Math.abs(x - cx) - (s / 2 - R), 0);
  const dy = Math.max(Math.abs(y - cy) - (s / 2 - R), 0);
  if (Math.hypot(dx, dy) > R - 0.5) return [0, 0, 0, 0];
  const d = Math.hypot(x - cx, y - cy) / s;
  if (d < 0.155) return [...state.pupil, 255];
  if (d > 0.235 && d < 0.325) return [255, 255, 255, 255];
  const t = y / s;
  return [
    Math.round(state.field[0] + 20 * t),
    Math.round(state.field[1] + 26 * t),
    Math.round(state.field[2] + 10 * t),
    255,
  ];
}

function pixel(state) {
  return (x, y, s) => {
    let r = 0, g = 0, b = 0, a = 0;
    const n = 4;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const [pr, pg, pb, pa] = shade(x - 0.5 + (i + 0.5) / n, y - 0.5 + (j + 0.5) / n, s, state);
      r += pr * pa; g += pg * pa; b += pb * pa; a += pa;
    }
    if (!a) return [0, 0, 0, 0];
    return [Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round(a / (n * n))];
  };
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(dir, 'icon' + size + '.png'), png(size, pixel(STATES.neutral)));
}
for (const [name, state] of Object.entries(STATES)) {
  if (name === 'neutral') continue;
  for (const size of [16, 32]) {
    fs.writeFileSync(path.join(dir, 'state-' + name + '-' + size + '.png'), png(size, pixel(state)));
  }
}
console.log('wrote ' + fs.readdirSync(dir).length + ' icons');
