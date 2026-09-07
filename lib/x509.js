/*
 * lib/x509.js — just enough DER and X.509 to check a C2PA signing chain.
 *
 * No trust decisions are made here. This reads structure: who a certificate
 * says it is, who signed it, when it is valid, and the public key needed to
 * check a signature. Whether that identity means anything is a separate
 * question, answered by an anchor list, not by parsing.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.x509 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const utf8 = new TextDecoder('utf-8', { fatal: false });
  const utf16be = new TextDecoder('utf-16be');

  /* ---- DER ---------------------------------------------------------------
   * Every value is tag, length, content. `end` is where the next value starts. */

  function readTLV(b, pos) {
    if (pos + 2 > b.length) throw new Error('der: truncated');
    const tag = b[pos];
    let p = pos + 1;
    let len = b[p++];
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n === 0 || n > 4) throw new Error('der: unsupported length');
      len = 0;
      for (let i = 0; i < n; i++) len = (len << 8) | b[p++];
    }
    const contentStart = p;
    const contentEnd = p + len;
    if (contentEnd > b.length) throw new Error('der: length past end');
    return { tag, len, contentStart, contentEnd, end: contentEnd, raw: b.subarray(pos, contentEnd) };
  }

  function children(b, tlv, limit = 64) {
    const out = [];
    let p = tlv.contentStart;
    while (p < tlv.contentEnd && out.length < limit) {
      const c = readTLV(b, p);
      out.push(c);
      p = c.end;
    }
    return out;
  }

  function oidOf(b, tlv) {
    if (tlv.tag !== 0x06) return null;
    const c = b.subarray(tlv.contentStart, tlv.contentEnd);
    if (!c.length) return null;
    const parts = [Math.floor(c[0] / 40), c[0] % 40];
    let v = 0;
    for (let i = 1; i < c.length; i++) {
      v = v * 128 + (c[i] & 0x7f);
      if (!(c[i] & 0x80)) { parts.push(v); v = 0; }
    }
    return parts.join('.');
  }

  function stringOf(b, tlv) {
    const raw = b.subarray(tlv.contentStart, tlv.contentEnd);
    return (tlv.tag === 0x1e ? utf16be : utf8).decode(raw).trim();
  }

  /*
   * The tag decides the year width: UTCTime (0x17) is two digits, where 50 and
   * above mean the twentieth century; GeneralizedTime (0x18) is four. Guessing
   * from the string instead misreads a seconds-less GeneralizedTime such as
   * "202001010000Z" as year 20, month 20, which rolls over into August 2021.
   */
  function timeOf(b, tlv) {
    const s = utf8.decode(b.subarray(tlv.contentStart, tlv.contentEnd)).trim();
    const generalized = tlv.tag === 0x18;
    const re = generalized
      ? /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z?$/
      : /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z?$/;
    const m = re.exec(s);
    if (!m) return null;
    let year = parseInt(m[1], 10);
    if (!generalized) year += year >= 50 ? 1900 : 2000;
    const month = parseInt(m[2], 10);
    const day = parseInt(m[3], 10);
    const hour = parseInt(m[4], 10);
    const min = parseInt(m[5], 10);
    const sec = parseInt(m[6] || '0', 10);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 60) return null;
    return new Date(Date.UTC(year, month - 1, day, hour, min, sec));
  }

  /* ---- names ------------------------------------------------------------ */

  const ATTR_NAMES = {
    '2.5.4.3': 'CN', '2.5.4.10': 'O', '2.5.4.11': 'OU', '2.5.4.6': 'C',
    '2.5.4.7': 'L', '2.5.4.8': 'ST', '1.2.840.113549.1.9.1': 'E',
  };

  function parseName(b, tlv) {
    const attrs = [];
    for (const rdn of children(b, tlv, 32)) {
      if (rdn.tag !== 0x31) continue;
      for (const pair of children(b, rdn, 8)) {
        const kv = children(b, pair, 2);
        if (kv.length < 2) continue;
        const oid = oidOf(b, kv[0]);
        attrs.push({ oid, name: ATTR_NAMES[oid] || oid, value: stringOf(b, kv[1]) });
      }
    }
    return {
      attrs,
      text: attrs.map((a) => a.name + '=' + a.value).join(', '),
      cn: (attrs.find((a) => a.oid === '2.5.4.3') || {}).value || null,
      o: (attrs.find((a) => a.oid === '2.5.4.10') || {}).value || null,
    };
  }

  /* ---- certificate ------------------------------------------------------ */

  const EXT_KEY_USAGE = '2.5.29.15';
  const EXT_BASIC_CONSTRAINTS = '2.5.29.19';
  const EXT_EXT_KEY_USAGE = '2.5.29.37';

  function parseCertificate(der) {
    const b = der instanceof Uint8Array ? der : new Uint8Array(der);
    const cert = readTLV(b, 0);
    const top = children(b, cert, 3);
    if (top.length < 3) throw new Error('x509: not a certificate');
    const [tbs, sigAlg, sigVal] = top;
    const t = children(b, tbs, 10);
    let i = 0;
    let version = 1;
    if (t[0] && t[0].tag === 0xa0) { const v = children(b, t[0], 1)[0]; version = (b[v.contentStart] || 0) + 1; i = 1; }
    const serial = t[i++];
    const innerSigAlg = t[i++];
    const issuer = parseName(b, t[i++]);
    const validity = children(b, t[i++], 2);
    const subject = parseName(b, t[i++]);
    const spki = t[i++];

    let keyUsage = null;
    let isCA = null;
    let ekus = [];
    for (; i < t.length; i++) {
      if (t[i].tag !== 0xa3) continue;
      const seq = children(b, t[i], 1)[0];
      for (const ext of children(b, seq, 40)) {
        const parts = children(b, ext, 3);
        const oid = oidOf(b, parts[0]);
        const octet = parts[parts.length - 1];
        if (octet.tag !== 0x04) continue;
        const inner = readTLV(b, octet.contentStart);
        if (oid === EXT_KEY_USAGE && inner.tag === 0x03) {
          const unused = b[inner.contentStart];
          const bits = b.subarray(inner.contentStart + 1, inner.contentEnd);
          keyUsage = decodeKeyUsage(bits, unused);
        } else if (oid === EXT_BASIC_CONSTRAINTS && inner.tag === 0x30) {
          const bc = children(b, inner, 2);
          isCA = !!(bc[0] && bc[0].tag === 0x01 && b[bc[0].contentStart] !== 0);
        } else if (oid === EXT_EXT_KEY_USAGE && inner.tag === 0x30) {
          ekus = children(b, inner, 12).map((x) => oidOf(b, x)).filter(Boolean);
        }
      }
    }

    const spkiParts = children(b, spki, 2);
    const spkiAlgParts = children(b, spkiParts[0], 2);
    const spkiAlgOid = oidOf(b, spkiAlgParts[0]);
    const spkiCurveOid = spkiAlgParts[1] ? oidOf(b, spkiAlgParts[1]) : null;

    return {
      version,
      serial: hex(b.subarray(serial.contentStart, serial.contentEnd)),
      issuer, subject,
      notBefore: timeOf(b, validity[0]),
      notAfter: timeOf(b, validity[1]),
      tbsDer: tbs.raw,
      spkiDer: spki.raw,
      spkiAlgOid, spkiCurveOid,
      sigAlgOid: oidOf(b, children(b, sigAlg, 2)[0]),
      innerSigAlgOid: oidOf(b, children(b, innerSigAlg, 2)[0]),
      sigValue: bitString(b, sigVal),
      keyUsage, isCA, ekus,
      selfSigned: issuer.text === subject.text,
    };
  }

  function decodeKeyUsage(bits, unusedBits) {
    const names = ['digitalSignature', 'nonRepudiation', 'keyEncipherment', 'dataEncipherment', 'keyAgreement', 'keyCertSign', 'cRLSign', 'encipherOnly', 'decipherOnly'];
    const out = [];
    const total = bits.length * 8 - (unusedBits || 0);
    for (let i = 0; i < Math.min(names.length, total); i++) {
      if (bits[i >> 3] & (0x80 >> (i & 7))) out.push(names[i]);
    }
    return out;
  }

  function bitString(b, tlv) {
    if (tlv.tag !== 0x03) return b.subarray(tlv.contentStart, tlv.contentEnd);
    return b.subarray(tlv.contentStart + 1, tlv.contentEnd);
  }

  function hex(bytes) {
    let s = '';
    for (const x of bytes) s += x.toString(16).padStart(2, '0');
    return s;
  }

  /* ECDSA signatures are DER SEQUENCE { r INTEGER, s INTEGER }; WebCrypto
   * wants fixed-width r || s. Certificates use the DER form, COSE the raw one. */
  function derEcdsaToRaw(der, size) {
    const b = der instanceof Uint8Array ? der : new Uint8Array(der);
    const seq = readTLV(b, 0);
    if (seq.tag !== 0x30) throw new Error('ecdsa: not a sequence');
    const [r, s] = children(b, seq, 2);
    const out = new Uint8Array(size * 2);
    out.set(trimInt(b.subarray(r.contentStart, r.contentEnd), size), 0);
    out.set(trimInt(b.subarray(s.contentStart, s.contentEnd), size), size);
    return out;
  }

  function trimInt(v, size) {
    let start = 0;
    while (start < v.length - 1 && v[start] === 0) start++;
    const trimmed = v.subarray(start);
    if (trimmed.length > size) throw new Error('ecdsa: integer too large');
    const out = new Uint8Array(size);
    out.set(trimmed, size - trimmed.length);
    return out;
  }

  return { readTLV, children, oidOf, stringOf, timeOf, parseName, parseCertificate, derEcdsaToRaw, hex };
});
