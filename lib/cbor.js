/* lib/cbor.js — minimal CBOR (RFC 8949) decoder, enough for C2PA claims,
 * assertions and COSE_Sign1 structures. Tags are unwrapped; byte strings are
 * returned as Uint8Array; maps become plain objects keyed by String(key). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.cbor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const utf8 = new TextDecoder('utf-8', { fatal: false });

  function decode(bytes, offset = 0, opts = {}) {
    const st = { b: bytes, p: offset, depth: 0, max: opts.maxDepth || 64 };
    const value = readItem(st);
    return { value, offset: st.p };
  }

  function decodeValue(bytes) {
    try { return decode(bytes).value; } catch (e) { return undefined; }
  }

  function readItem(st) {
    if (st.depth > st.max) throw new Error('cbor: nesting too deep');
    if (st.p >= st.b.length) throw new Error('cbor: unexpected end');
    const ib = st.b[st.p++];
    const major = ib >> 5;
    const info = ib & 0x1f;
    switch (major) {
      case 0: return readLen(st, info);
      case 1: return -1 - readLen(st, info);
      case 2: return readBytes(st, info);
      case 3: return utf8.decode(readBytes(st, info));
      case 4: {
        const out = [];
        st.depth++;
        if (info === 31) { while (!atBreak(st)) out.push(readItem(st)); st.p++; }
        else { const n = readLen(st, info); for (let i = 0; i < n; i++) out.push(readItem(st)); }
        st.depth--;
        return out;
      }
      case 5: {
        const out = {};
        st.depth++;
        const put = () => { const k = readItem(st); const v = readItem(st); out[typeof k === 'string' ? k : String(k)] = v; };
        if (info === 31) { while (!atBreak(st)) put(); st.p++; }
        else { const n = readLen(st, info); for (let i = 0; i < n; i++) put(); }
        st.depth--;
        return out;
      }
      case 6: { readLen(st, info); return readItem(st); }
      case 7: {
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        if (info === 24) return st.b[st.p++];
        if (info === 25) { const v = readF16(st.b, st.p); st.p += 2; return v; }
        if (info === 26) { const v = new DataView(st.b.buffer, st.b.byteOffset + st.p, 4).getFloat32(0); st.p += 4; return v; }
        if (info === 27) { const v = new DataView(st.b.buffer, st.b.byteOffset + st.p, 8).getFloat64(0); st.p += 8; return v; }
        if (info === 31) throw new Error('cbor: unexpected break');
        return info;
      }
      default: throw new Error('cbor: bad major type');
    }
  }

  function atBreak(st) {
    if (st.p >= st.b.length) throw new Error('cbor: unexpected end');
    return st.b[st.p] === 0xff;
  }

  function readLen(st, info) {
    if (info < 24) return info;
    const b = st.b;
    if (info === 24) { need(st, 1); return b[st.p++]; }
    if (info === 25) { need(st, 2); const v = (b[st.p] << 8) | b[st.p + 1]; st.p += 2; return v; }
    if (info === 26) { need(st, 4); const v = ((b[st.p] << 24) >>> 0) + (b[st.p + 1] << 16) + (b[st.p + 2] << 8) + b[st.p + 3]; st.p += 4; return v; }
    if (info === 27) {
      need(st, 8);
      let v = 0;
      for (let i = 0; i < 8; i++) v = v * 256 + b[st.p + i];
      st.p += 8;
      return v;
    }
    if (info === 31) return -1;
    throw new Error('cbor: reserved length');
  }

  function readBytes(st, info) {
    if (info === 31) {
      const parts = [];
      let total = 0;
      while (!atBreak(st)) {
        const ib = st.b[st.p++];
        const chunk = readBytes(st, ib & 0x1f);
        parts.push(chunk); total += chunk.length;
      }
      st.p++;
      const out = new Uint8Array(total);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    }
    const n = readLen(st, info);
    need(st, n);
    const out = st.b.subarray(st.p, st.p + n);
    st.p += n;
    return out;
  }

  function need(st, n) {
    if (st.p + n > st.b.length) throw new Error('cbor: truncated');
  }

  function readF16(b, p) {
    const h = (b[p] << 8) | b[p + 1];
    const s = (h & 0x8000) ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  }

  /* Tiny encoder used by tests to build fixtures (not needed at runtime). */
  function encode(value) {
    const out = [];
    write(value, out);
    return Uint8Array.from(out);
  }
  function writeHead(major, n, out) {
    const m = major << 5;
    if (n < 24) out.push(m | n);
    else if (n < 0x100) out.push(m | 24, n);
    else if (n < 0x10000) out.push(m | 25, n >> 8, n & 0xff);
    else out.push(m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
  }
  function write(v, out) {
    if (v === null) out.push(0xf6);
    else if (v === undefined) out.push(0xf7);
    else if (v === true) out.push(0xf5);
    else if (v === false) out.push(0xf4);
    else if (typeof v === 'number') {
      if (Number.isInteger(v)) { if (v >= 0) writeHead(0, v, out); else writeHead(1, -1 - v, out); }
      else { const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v); out.push(0xfb); for (let i = 0; i < 8; i++) out.push(dv.getUint8(i)); }
    } else if (typeof v === 'string') { const b = new TextEncoder().encode(v); writeHead(3, b.length, out); for (const x of b) out.push(x); }
    else if (v instanceof Uint8Array) { writeHead(2, v.length, out); for (const x of v) out.push(x); }
    else if (Array.isArray(v)) { writeHead(4, v.length, out); for (const x of v) write(x, out); }
    else if (typeof v === 'object') {
      const keys = Object.keys(v);
      writeHead(5, keys.length, out);
      for (const k of keys) { const nk = /^-?\d+$/.test(k) ? parseInt(k, 10) : k; write(nk, out); write(v[k], out); }
    } else throw new Error('cbor encode: unsupported ' + typeof v);
  }

  return { decode, decodeValue, encode };
});
