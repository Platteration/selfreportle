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
function c2paManifest({ generator = 'OpenAI', actions = [], signerCN = null, extraAssertions = [], referenceAssertions = true } = {}) {
  const labels = ['c2pa.actions.v2', ...extraAssertions.map(([label]) => label)];
  const assertionBoxes = [
    jumb(UUID.cbor, 'c2pa.actions.v2', [cborBox({ actions })]),
    ...extraAssertions.map(([label, val]) => jumb(UUID.cbor, label, [cborBox(val)])),
  ];
  // Real producers list their assertions in the claim; hashes are absent here
  // because this helper builds deliberately unsigned manifests.
  const refs = referenceAssertions ? labels.map((l) => ({ url: 'self#jumbf=c2pa.assertions/' + l })) : [];
  const children = [
    jumb(UUID.assertions, 'c2pa.assertions', assertionBoxes),
    jumb(UUID.claim, 'c2pa.claim', [cborBox({ 'dc:title': 'image.png', claim_generator: generator, claim_generator_info: [{ name: generator, version: '1.0' }], assertions: refs })]),
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

/* ---- ISOBMFF (MP4 / M4A / AVIF) ---- */
function isoBox(type, payload) { return concat([u32be(8 + payload.length), str(type), payload]); }
function c2paUuidBox(manifest) {
  const uuid = Uint8Array.from('d8fec3d61b0e483c92975828877ec481'.match(/../g).map((h) => parseInt(h, 16)));
  return isoBox('uuid', concat([uuid, u32be(0), manifest]));
}
/* placement: 'front' puts the index and credentials first; 'tail' puts a big
 * mdat first and the moov (with the credentials inside udta) at the end. */
function mp4(manifest, { brand = 'mp42', placement = 'front', mdatSize = 4096 } = {}) {
  const ftyp = isoBox('ftyp', concat([str(brand), u32be(512), str('isomavc1')]));
  const mdat = isoBox('mdat', new Uint8Array(mdatSize));
  const moov = isoBox('moov', concat([isoBox('mvhd', new Uint8Array(100)), isoBox('udta', c2paUuidBox(manifest))]));
  return placement === 'front' ? concat([ftyp, moov, mdat]) : concat([ftyp, mdat, moov]);
}

/* ---- DER / X.509: builds a real, self-consistent certificate so the
 * verifier is exercised against actual cryptography, not a stub. ---- */
const { webcrypto } = require('crypto');
const subtle = webcrypto.subtle;

function derLen(n) {
  if (n < 0x80) return Uint8Array.from([n]);
  const bytes = [];
  let v = n;
  while (v > 0) { bytes.unshift(v & 0xff); v >>= 8; }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}
function der(tag, content) { return concat([Uint8Array.from([tag]), derLen(content.length), content]); }
function derSeq(...parts) { return der(0x30, concat(parts)); }
function derSet(...parts) { return der(0x31, concat(parts)); }
function derInt(n) {
  const bytes = [];
  let v = BigInt(n);
  if (v === 0n) bytes.push(0);
  while (v > 0n) { bytes.unshift(Number(v & 0xffn)); v >>= 8n; }
  if (bytes[0] & 0x80) bytes.unshift(0);
  return der(0x02, Uint8Array.from(bytes));
}
function derIntRaw(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let v = bytes.subarray(i);
  if (v[0] & 0x80) v = concat([Uint8Array.from([0]), v]);
  return der(0x02, v);
}
function derOid(dotted) {
  const p = dotted.split('.').map(Number);
  const out = [p[0] * 40 + p[1]];
  for (const n of p.slice(2)) {
    const chunk = [];
    let v = n;
    do { chunk.unshift(v & 0x7f); v >>= 7; } while (v > 0);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80;
    out.push(...chunk);
  }
  return der(0x06, Uint8Array.from(out));
}
function derUtf8(text) { return der(0x0c, str(text)); }
function derBitString(bytes) { return der(0x03, concat([Uint8Array.from([0]), bytes])); }
function derUtcTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  return der(0x17, str(p(date.getUTCFullYear() % 100) + p(date.getUTCMonth() + 1) + p(date.getUTCDate()) + p(date.getUTCHours()) + p(date.getUTCMinutes()) + p(date.getUTCSeconds()) + 'Z'));
}
function derName(attrs) {
  return derSeq(...Object.entries(attrs).map(([oid, value]) => derSet(derSeq(derOid(oid), derUtf8(value)))));
}
const OID_CN = '2.5.4.3';
const OID_O = '2.5.4.10';
const ECDSA_SHA256 = derSeq(derOid('1.2.840.10045.4.3.2'));

function rawEcdsaToDer(raw) {
  const half = raw.length / 2;
  return derSeq(derIntRaw(raw.subarray(0, half)), derIntRaw(raw.subarray(half)));
}

/* Issues a certificate for `subjectKey`, signed by `issuerKey`. Self-signed
 * when the two are the same and the names match. */
async function makeCertificate({ subject, issuer, subjectPublicKey, issuerPrivateKey, notBefore, notAfter, isCA = false, serial = 1 }) {
  const spki = new Uint8Array(await subtle.exportKey('spki', subjectPublicKey));
  const exts = [];
  if (isCA) exts.push(derSeq(derOid('2.5.29.19'), der(0x04, derSeq(der(0x01, Uint8Array.from([0xff]))))));
  exts.push(derSeq(derOid('2.5.29.15'), der(0x04, derBitString(Uint8Array.from([isCA ? 0x04 : 0x80])))));
  const tbs = derSeq(
    der(0xa0, derInt(2)),
    derInt(serial),
    ECDSA_SHA256,
    derName(issuer),
    derSeq(derUtcTime(notBefore), derUtcTime(notAfter)),
    derName(subject),
    spki,
    der(0xa3, derSeq(...exts)),
  );
  const rawSig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, issuerPrivateKey, tbs));
  return derSeq(tbs, ECDSA_SHA256, derBitString(rawEcdsaToDer(rawSig)));
}

async function makeKeyPair() {
  return subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
}

/*
 * A manifest with a genuine COSE_Sign1 over the claim, real assertion hashes
 * and a real certificate chain. `tamper` lets a test break exactly one thing.
 */
async function signedC2paManifest({ generator = 'ChatGPT', actions = [], cn = 'Test Signer', org = 'Test Org', chain = 'leaf', tamper = null, notBefore, notAfter, injectAssertion = null, dropAssertion = false, inlinePayload = false, forgedClaim = null } = {}) {
  const leafKeys = await makeKeyPair();
  const now = new Date();
  const nb = notBefore || new Date(now.getTime() - 86400000);
  const na = notAfter || new Date(now.getTime() + 86400000);

  let certs;
  if (chain === 'full') {
    const rootKeys = await makeKeyPair();
    const rootName = { [OID_CN]: 'Test Root', [OID_O]: org };
    const root = await makeCertificate({ subject: rootName, issuer: rootName, subjectPublicKey: rootKeys.publicKey, issuerPrivateKey: rootKeys.privateKey, notBefore: nb, notAfter: na, isCA: true, serial: 1 });
    const leaf = await makeCertificate({ subject: { [OID_CN]: cn, [OID_O]: org }, issuer: rootName, subjectPublicKey: leafKeys.publicKey, issuerPrivateKey: rootKeys.privateKey, notBefore: nb, notAfter: na, serial: 2 });
    certs = [leaf, root];
  } else if (chain === 'broken') {
    const rootKeys = await makeKeyPair();
    const otherKeys = await makeKeyPair();
    const rootName = { [OID_CN]: 'Test Root', [OID_O]: org };
    const root = await makeCertificate({ subject: rootName, issuer: rootName, subjectPublicKey: rootKeys.publicKey, issuerPrivateKey: rootKeys.privateKey, notBefore: nb, notAfter: na, isCA: true, serial: 1 });
    // Leaf claims the root as issuer but was signed by an unrelated key.
    const leaf = await makeCertificate({ subject: { [OID_CN]: cn, [OID_O]: org }, issuer: rootName, subjectPublicKey: leafKeys.publicKey, issuerPrivateKey: otherKeys.privateKey, notBefore: nb, notAfter: na, serial: 2 });
    certs = [leaf, root];
  } else {
    const selfName = { [OID_CN]: cn, [OID_O]: org };
    certs = [await makeCertificate({ subject: selfName, issuer: selfName, subjectPublicKey: leafKeys.publicKey, issuerPrivateKey: leafKeys.privateKey, notBefore: nb, notAfter: na, serial: 1 })];
  }

  // Assertions first, so the claim can record their real hashes.
  const assertionValues = [['c2pa.actions.v2', { actions }]];
  const assertionBoxes = assertionValues.map(([label, value]) => jumb(UUID.cbor, label, [cborBox(value)]));
  const hashes = [];
  for (let i = 0; i < assertionBoxes.length; i++) {
    hashes.push({ url: 'self#jumbf=c2pa.assertions/' + assertionValues[i][0], alg: 'sha256', hash: new Uint8Array(await subtle.digest('SHA-256', assertionBoxes[i])) });
  }
  if (tamper === 'assertion') {
    // Swap the assertion after its hash was recorded.
    assertionBoxes[0] = jumb(UUID.cbor, 'c2pa.actions.v2', [cborBox({ actions: [{ action: 'c2pa.created', digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture' }] })]);
  }

  const claim = { 'dc:title': 'asset', claim_generator: generator, claim_generator_info: [{ name: generator, version: '1.0' }], alg: 'sha256', assertions: hashes };
  const claimRaw = CBOR.encode(claim);
  const protectedHeader = CBOR.encode({ 1: -7 });
  const sigStructure = CBOR.encode(['Signature1', protectedHeader, new Uint8Array(0), claimRaw]);
  const signature = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, leafKeys.privateKey, sigStructure));
  if (tamper === 'signature') signature[0] ^= 0xff;

  // A replay: the signature and its inline payload stay genuine, but the
  // claim box carries something the signature never covered.
  const cose = [protectedHeader, { 33: certs }, (inlinePayload || forgedClaim) ? claimRaw : null, signature];
  const storedClaim = forgedClaim ? CBOR.encode(forgedClaim) : claimRaw;
  // An assertion the signed claim never referenced: added after the fact,
  // without disturbing the signature.
  const present = dropAssertion ? [] : assertionBoxes.slice();
  if (injectAssertion) present.push(jumb(UUID.cbor, injectAssertion[0], [cborBox(injectAssertion[1])]));
  const children = [
    jumb(UUID.assertions, 'c2pa.assertions', present),
    jumb(UUID.claim, 'c2pa.claim', [box('cbor', storedClaim)]),
    jumb(UUID.signature, 'c2pa.signature', [cborBox(cose)]),
  ];
  return jumb(UUID.store, 'c2pa', [jumb(UUID.manifest, 'urn:uuid:11111111-2222-3333-4444-555555555555', children)]);
}

module.exports = { makeKeyPair, makeCertificate, signedC2paManifest, der, derSeq, derOid, derName, derUtcTime, derBitString, derInt, isoBox, c2paUuidBox, mp4, concat, str, png, pngChunk, tEXt, iTXt, tiff, jpeg, jpegSegment, xmpPacket, app1Xmp, app1Exif, app11Jumbf, c2paManifest, jumb, box, cborBox, UUID, webp, webpChunk };
