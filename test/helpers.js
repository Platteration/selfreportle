/* Builders for synthetic image fixtures. */
const zlib = require('zlib');
const CBOR = require('../lib/cbor.js');

const te = new TextEncoder();

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function u32be(n) { return Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
function u32le(n) { return Uint8Array.from([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }
function u16be(n) { return Uint8Array.from([(n >>> 8) & 255, n & 255]); }
function str(s) { return te.encode(s); }

/* ---- PNG ---- */
function pngChunk(type, data) {
  const t = str(type);
  const crc = zlib.crc32 ? u32be(zlib.crc32(concat([t, data]))) : u32be(0);
  return concat([u32be(data.length), t, data, crc]);
}
function png(chunks) {
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = pngChunk('IHDR', concat([u32be(1), u32be(1), Uint8Array.from([8, 2, 0, 0, 0])]));
  const idat = pngChunk('IDAT', new Uint8Array(zlib.deflateSync(Buffer.from([0, 0, 0, 0]))));
  return concat([sig, ihdr, ...chunks, idat, pngChunk('IEND', new Uint8Array(0))]);
}
function tEXt(key, text) { return pngChunk('tEXt', concat([str(key), Uint8Array.from([0]), str(text)])); }
function iTXt(key, text, compressed = false) {
  const body = compressed ? new Uint8Array(zlib.deflateSync(Buffer.from(text, 'utf8'))) : str(text);
  return pngChunk('iTXt', concat([str(key), Uint8Array.from([0, compressed ? 1 : 0, 0, 0, 0]), body]));
}

/* ---- TIFF / EXIF ---- */
function tiff(entries) {
  // entries: [{tag, type, value:string|Uint8Array}] — ASCII (2) or UNDEFINED (7)
  const n = entries.length;
  const header = concat([str('MM'), u16be(42), u32be(8)]);
  let dataOffset = 8 + 2 + n * 12 + 4;
  const ifd = [u16be(n)];
  const blobs = [];
  for (const e of entries) {
    const val = typeof e.value === 'string' ? str(e.value + '\0') : e.value;
    ifd.push(u16be(e.tag), u16be(e.type), u32be(val.length));
    if (val.length <= 4) { const pad = new Uint8Array(4); pad.set(val); ifd.push(pad); }
    else { ifd.push(u32be(dataOffset)); blobs.push(val); dataOffset += val.length; }
  }
  ifd.push(u32be(0));
  return concat([header, ...ifd, ...blobs]);
}

/* ---- JPEG ---- */
function jpegSegment(marker, payload) {
  return concat([Uint8Array.from([0xff, marker]), u16be(payload.length + 2), payload]);
}
function jpeg(segments) {
  return concat([Uint8Array.from([0xff, 0xd8]), ...segments, Uint8Array.from([0xff, 0xda, 0, 2, 0xff, 0xd9])]);
}
function xmpPacket(inner) {
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">${inner}</rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}
function app1Xmp(xml) { return jpegSegment(0xe1, concat([str('http://ns.adobe.com/xap/1.0/\0'), str(xml)])); }
function app1Exif(tiffBytes) { return jpegSegment(0xe1, concat([str('Exif\0\0'), tiffBytes])); }
function app11Jumbf(box, segmentSize = 60000) {
  const out = [];
  let z = 1;
  for (let off = 0; off < box.length; off += segmentSize) {
    const part = box.subarray(off, Math.min(off + segmentSize, box.length));
    const body = z === 1 ? part : concat([box.subarray(0, 8), part]);
    out.push(jpegSegment(0xeb, concat([str('JP'), u16be(1), u32be(z), body])));
    z++;
  }
  return concat(out);
}

/* ---- JUMBF / C2PA ---- */
function box(type, payload) { return concat([u32be(8 + payload.length), str(type), payload]); }
function jumd(uuidHex, label) {
  const uuid = Uint8Array.from(uuidHex.match(/../g).map((h) => parseInt(h, 16)));
  return box('jumd', concat([uuid, Uint8Array.from([0x03]), str(label + '\0')]));
}
function jumb(uuidHex, label, children) { return box('jumb', concat([jumd(uuidHex, label), ...children])); }
const UUID = {
  store: '6332706100110010800000aa00389b71',
  manifest: '63326d6100110010800000aa00389b71',
  assertions: '6332617300110010800000aa00389b71',
  claim: '6332636c00110010800000aa00389b71',
  signature: '6332637300110010800000aa00389b71',
  cbor: '6332626f00110010800000aa00389b71',
};
function cborBox(value) { return box('cbor', CBOR.encode(value)); }
function c2paManifest({ generator = 'OpenAI', actions = [], signerCN = null, extraAssertions = [] } = {}) {
  const assertionBoxes = [
    jumb(UUID.cbor, 'c2pa.actions.v2', [cborBox({ actions })]),
    ...extraAssertions.map(([label, val]) => jumb(UUID.cbor, label, [cborBox(val)])),
  ];
  const children = [
    jumb(UUID.assertions, 'c2pa.assertions', assertionBoxes),
    jumb(UUID.claim, 'c2pa.claim', [cborBox({ 'dc:title': 'image.png', claim_generator: generator, claim_generator_info: [{ name: generator, version: '1.0' }], assertions: [] })]),
  ];
  if (signerCN) {
    const cn = str(signerCN);
    const der = concat([Uint8Array.from([0x06, 0x03, 0x55, 0x04, 0x03, 0x0c, cn.length]), cn]);
    children.push(jumb(UUID.signature, 'c2pa.signature', [cborBox([new Uint8Array(0), { 33: [der] }, null, new Uint8Array([1, 2, 3])])]));
  }
  return jumb(UUID.store, 'c2pa', [jumb(UUID.manifest, 'urn:uuid:12345678-1234-1234-1234-123456789abc', children)]);
}

/* ---- WebP ---- */
function webp(chunks) {
  const vp8 = concat([str('VP8L'), u32le(4), Uint8Array.from([0x2f, 0, 0, 0])]);
  const body = concat([str('WEBP'), vp8, ...chunks]);
  return concat([str('RIFF'), u32le(body.length), body]);
}
function webpChunk(fourcc, data) {
  const pad = data.length & 1 ? Uint8Array.from([0]) : new Uint8Array(0);
  return concat([str(fourcc), u32le(data.length), data, pad]);
}

module.exports = { concat, str, png, pngChunk, tEXt, iTXt, tiff, jpeg, jpegSegment, xmpPacket, app1Xmp, app1Exif, app11Jumbf, c2paManifest, jumb, box, cborBox, UUID, webp, webpChunk };
