/*
 * lib/image-metadata.js — provenance metadata embedded in image bytes.
 *
 * Reads, without any network or native dependency:
 *   • JPEG APP1 EXIF (Make/Model/Software/ImageDescription/UserComment)
 *   • XMP packets (JPEG APP1, PNG iTXt, WebP "XMP ", generic scan) including
 *     IPTC Iptc4xmpExt:DigitalSourceType, xmp:CreatorTool, history agents
 *   • PNG text chunks written by Stable Diffusion front-ends, ComfyUI,
 *     NovelAI, InvokeAI, Fooocus …
 *   • C2PA Content Credentials (JUMBF in JPEG APP11, PNG caBX, WebP C2PA,
 *     ISOBMFF uuid boxes): claim generator, actions with digitalSourceType,
 *     software agents, ingredients, signer certificate names.
 *
 * C2PA manifests are handed to lib/c2pa-verify.js, which checks the COSE
 * signature against the embedded certificate, re-hashes each assertion
 * against the signed claim and recomputes the claim's hard binding over
 * these bytes. Limitations (stated in the UI): no trust list is shipped, so
 * the certificate chain is never anchored to a known signer; and invisible
 * pixel-domain watermarks (SynthID, Stable Signature …) need vendor keys and
 * are not detected.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.imageMeta = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const isNode = typeof module === 'object' && typeof require === 'function';
  const S = isNode ? require('./signals.js') : root.SRL.signals;
  const CBOR = isNode ? require('./cbor.js') : root.SRL.cbor;
  const VERIFY = isNode ? require('./c2pa-verify.js') : root.SRL.c2paVerify;

  const utf8 = new TextDecoder('utf-8', { fatal: false });
  const latin1 = new TextDecoder('latin1');
  const utf16be = new TextDecoder('utf-16be');
  const utf16le = new TextDecoder('utf-16le');

  const C2PA_UUID = 'd8fec3d61b0e483c92975828877ec481';

  /*
   * Ceilings on attacker-chosen sizes. Every one of these bounds something a
   * page controls the bytes of, in the single service worker that every tab
   * shares: a parse that costs gigabytes or tens of seconds there is a denial
   * of the extension for the whole browser, and a hostile page can retrigger
   * it on every navigation.
   */
  const MAX_INFLATED = 1 << 20;        // 1 MB out of any one compressed chunk
  const MAX_PNG_TEXT = 4 << 20;        // 4 MB of text chunks kept per image
  const MAX_XMP = 256 * 1024;          // the XMP packet handed to the parser
  const MAX_COMMENTS = 100;            // embedded comments kept per image

  /* ---- entry point ------------------------------------------------------ */

  async function analyzeImageBytes(input, hints = {}) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    /* c2paRanges: where the credential store physically sits in this file.
     * The hard binding is a digest over the asset with those bytes taken out,
     * so without them the binding cannot be recomputed — and an exclusion
     * range that reaches outside them is excluding the picture itself. */
    const meta = { format: detectFormat(bytes), exif: null, xmp: null, png: null, c2pa: null, c2paRanges: [], comments: [], notes: [], rendered: !!hints.rendered };
    try {
      if (meta.format === 'jpeg') await parseJpeg(bytes, meta);
      else if (meta.format === 'png') await parsePng(bytes, meta);
      else if (meta.format === 'webp') await parseWebp(bytes, meta);
      else if (meta.format === 'isobmff' || meta.format === 'isobmff-av') await parseIsobmff(bytes, meta);
      else if (meta.format === 'svg') parseSvg(bytes, meta);
      else if (meta.format === 'gif') meta.notes.push('GIF carries no provenance metadata');
      else meta.notes.push('Unrecognised format; generic scan only');
      if (!meta.xmp) { const x = scanForXmp(bytes); if (x) meta.xmp = parseXmp(x); }
      if (!meta.c2pa) {
        /* Found by looking for the bytes "jumb" anywhere in the file, so its
         * extent comes from a length field inside the blob itself and from
         * nothing else — no chunk, no segment, no box header a decoder also
         * honours. Inflating that field made the declared store swallow the
         * picture, and the binding then hashed 41 bytes of 1728 and reported
         * "valid". The credentials are still read and shown; they just do not
         * get to say where they end, so the binding stays unchecked. */
        const j = scanForJumbf(bytes);
        if (j) { const c = extractC2pa(j); if (c) meta.c2pa = c; }
      }
    } catch (e) {
      meta.notes.push('Parse error: ' + (e && e.message ? e.message : String(e)));
    }
    if (hints.truncated) meta.notes.push('Only the first ' + Math.round(bytes.length / 1024) + ' KB were inspected');
    /* Whether these are the bytes the page rendered or the answer a server
     * gave to the worker's own, different request. See deriveSignals. */
    if (meta.c2pa && !meta.rendered) meta.notes.push('These credentials were checked against a separate fetch of this URL, which the server need not have answered with the picture on the page');
    if (meta.c2pa && meta.c2pa.active && VERIFY) {
      try {
        meta.c2pa.active.verification = await VERIFY.verifyManifest(meta.c2pa.active, {
          truncated: !!hints.truncated, asset: bytes, assetRanges: meta.c2paRanges,
        });
      } catch (e) {
        meta.c2pa.active.verification = { signature: 'unknown', binding: { status: 'unchecked', reason: 'Verification did not run.' }, notes: ['Verification failed: ' + (e && e.message)] };
      }
    }
    const signals = deriveSignals(meta);
    return { format: meta.format, metadata: summarize(meta), signals };
  }

  /* ---- format detection ------------------------------------------------- */

  function detectFormat(b) {
    if (b.length < 12) return 'unknown';
    if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
    if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
    if (ascii(b, 4, 4) === 'ftyp') {
      const brand = ascii(b, 8, 4);
      if (/^(?:avif|avis|mif1|heic|heix|hevc|msf1)$/.test(brand)) return 'isobmff';
      if (/^(?:M4A |M4B |mp42|mp41|isom|iso2|dash|qt  |M4V |mmp4|avc1)$/.test(brand)) return 'isobmff-av';
      return 'isobmff';
    }
    if (ascii(b, 0, 3) === 'GIF') return 'gif';
    const head = latin1.decode(b.subarray(0, Math.min(512, b.length)));
    if (/^\s*(?:<\?xml|<!--|<svg)/i.test(head) && /<svg/i.test(head)) return 'svg';
    return 'unknown';
  }

  /* ---- JPEG ------------------------------------------------------------- */

  async function parseJpeg(b, meta) {
    let p = 2;
    const jumbf = new Map();
    const extXmp = new Map();
    while (p + 4 <= b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const marker = b[p + 1];
      if (marker === 0xff) { p++; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      if (marker === 0xd9 || marker === 0xda) break;
      const len = (b[p + 2] << 8) | b[p + 3];
      if (len < 2) break;
      const seg = b.subarray(p + 4, Math.min(p + 2 + len, b.length));
      if (marker === 0xe1) {
        if (startsWith(seg, 'Exif\0\0')) meta.exif = parseTiff(seg.subarray(6)) || meta.exif;
        else if (startsWith(seg, 'http://ns.adobe.com/xap/1.0/\0')) meta.xmp = parseXmp(utf8.decode(seg.subarray(29)));
        else if (startsWith(seg, 'http://ns.adobe.com/xmp/extension/\0')) {
          const off = u32be(seg, 35 + 32 + 4);
          extXmp.set(off, seg.subarray(35 + 32 + 8));
        }
      } else if (marker === 0xeb && seg.length > 8 && seg[0] === 0x4a && seg[1] === 0x50) {
        const en = (seg[2] << 8) | seg[3];
        const z = u32be(seg, 4);
        const entry = jumbf.get(en) || [];
        // The whole APP11 marker segment, which is what a JPEG hard binding
        // excludes from its digest.
        entry.push({ z, body: seg.subarray(8), start: p, end: Math.min(p + 2 + len, b.length) });
        jumbf.set(en, entry);
      } else if (marker === 0xfe && meta.comments.length < MAX_COMMENTS) {
        meta.comments.push(latin1.decode(seg).replace(/\0+$/, ''));
      }
      p += 2 + len;
    }
    if (extXmp.size) {
      const parts = [...extXmp.entries()].sort((a, b2) => a[0] - b2[0]).map((e) => e[1]);
      const joined = concat(parts);
      const ext = parseXmp(utf8.decode(joined));
      if (ext) meta.xmp = mergeXmp(meta.xmp, ext);
    }
    for (const parts of jumbf.values()) {
      parts.sort((a, b2) => a.z - b2.z);
      const chunks = parts.map((part, i) => (i === 0 ? part.body : part.body.subarray(8)));
      const box = concat(chunks);
      const boxes = parseJumbfBoxes(box, 0, box.length);
      const c2pa = extractC2pa(boxes);
      if (c2pa) {
        meta.c2pa = c2pa;
        // The run of APP11 segments carries the store and nothing else; a run
        // holding more than the boxes that parsed is not an extent to exclude.
        if (storeFills(boxes, box.length, b.length, b.length)) meta.c2paRanges = parts.map((part) => ({ start: part.start, end: part.end }));
        break;
      }
    }
  }

  /* ---- PNG -------------------------------------------------------------- */

  async function parsePng(b, meta) {
    let p = 8;
    const text = {};
    /* One budget for everything decompressed out of this file, so a run of
     * individually-legal zTXt chunks cannot add up to the same bomb. */
    let budget = MAX_PNG_TEXT;
    let overflowed = false;
    const keep = (key, value) => {
      text[key] = value.length > budget ? value.slice(0, Math.max(0, budget)) : value;
      budget -= text[key].length;
    };
    while (p + 8 <= b.length) {
      const len = u32be(b, p);
      const type = ascii(b, p + 4, 4);
      const data = b.subarray(p + 8, Math.min(p + 8 + len, b.length));
      if (type === 'IEND') break;
      if (type === 'tEXt') {
        const z = data.indexOf(0);
        if (z > 0) keep(latin1.decode(data.subarray(0, z)), latin1.decode(data.subarray(z + 1)));
      } else if (type === 'zTXt') {
        const z = data.indexOf(0);
        if (z > 0) {
          const { out, overflow } = await inflate(data.subarray(z + 2), Math.min(MAX_INFLATED, budget));
          if (out) keep(latin1.decode(data.subarray(0, z)), latin1.decode(out));
          else if (overflow) overflowed = true;
        }
      } else if (type === 'iTXt') {
        const z = data.indexOf(0);
        if (z > 0) {
          const key = latin1.decode(data.subarray(0, z));
          const compressed = data[z + 1] === 1;
          let q = z + 3;
          const langEnd = data.indexOf(0, q); q = langEnd + 1;
          const transEnd = data.indexOf(0, q); q = transEnd + 1;
          const body = data.subarray(q);
          let raw = body;
          if (compressed) {
            const inflated = await inflate(body, Math.min(MAX_INFLATED, budget));
            raw = inflated.out;
            if (inflated.overflow) overflowed = true;
          }
          if (raw) keep(key, utf8.decode(raw));
        }
      } else if (type === 'eXIf') {
        meta.exif = parseTiff(startsWith(data, 'Exif\0\0') ? data.subarray(6) : data) || meta.exif;
      } else if (type === 'caBX') {
        const boxes = parseJumbfBoxes(data, 0, data.length);
        const c2pa = extractC2pa(boxes);
        // The whole chunk, length and CRC included: its CRC covers the digest
        // itself, so a producer can only exclude the chunk entire.
        if (c2pa) {
          meta.c2pa = c2pa;
          if (storeFills(boxes, data.length, p + 12 + len, b.length)) meta.c2paRanges = [{ start: p, end: p + 12 + len }];
        }
      }
      p += 12 + len;
    }
    meta.png = { text };
    if (overflowed || budget <= 0) meta.notes.push('Compressed text in this PNG was too large to inspect and was skipped');
    if (text['XML:com.adobe.xmp']) meta.xmp = parseXmp(text['XML:com.adobe.xmp']);
  }

  /* ---- WebP ------------------------------------------------------------- */

  async function parseWebp(b, meta) {
    let p = 12;
    while (p + 8 <= b.length) {
      const type = ascii(b, p, 4);
      const len = u32le(b, p + 4);
      const data = b.subarray(p + 8, Math.min(p + 8 + len, b.length));
      if (type === 'EXIF') meta.exif = parseTiff(startsWith(data, 'Exif\0\0') ? data.subarray(6) : data) || meta.exif;
      else if (type === 'XMP ') meta.xmp = parseXmp(utf8.decode(data));
      else if (type === 'C2PA') {
        const boxes = parseJumbfBoxes(data, 0, data.length);
        const c = extractC2pa(boxes);
        if (c) {
          meta.c2pa = c;
          const end = p + 8 + len + (len & 1);
          if (storeFills(boxes, data.length, end, b.length)) meta.c2paRanges = [{ start: p, end }];
        }
      }
      p += 8 + len + (len & 1);
    }
  }

  /* ---- ISOBMFF (AVIF / HEIC / MP4 / M4A / MOV) -------------------------- */

  /* Boxes that hold other boxes. `skip` is the fixed header a container puts
   * before its children (a FullBox spends 4 bytes on version and flags). */
  const ISO_CONTAINERS = {
    moov: 0, trak: 0, mdia: 0, minf: 0, stbl: 0, udta: 0, edts: 0, dinf: 0,
    moof: 0, traf: 0, mvex: 0, mfra: 0, skip: 0, wide: 0, ilst: 0,
    meta: 4, iprp: 0, ipco: 0,
  };

  const ISO_SKIP = new Set(['mdat', 'free', 'ftyp', 'styp', 'sidx']);

  async function parseIsobmff(bytes, meta) {
    walkIso(bytes, 0, bytes.length, meta, 0);
    if (!meta.exif) {
      const exifIdx = indexOf(bytes, 'Exif\0\0');
      if (exifIdx >= 0) meta.exif = parseTiff(bytes.subarray(exifIdx + 6)) || meta.exif;
    }
    if (!meta.c2pa) {
      // As above: a store found by byte-scan has no box header to attest its
      // extent, so it supplies credentials but no exclusion range.
      const scanned = scanForJumbf(bytes);
      if (scanned) {
        const c = extractC2pa(scanned);
        if (c) meta.c2pa = c;
      }
    }
  }

  function walkIso(b, start, end, meta, depth) {
    if (depth > 8) return;
    let p = start;
    while (p + 8 <= end) {
      let len = u32be(b, p);
      const type = ascii(b, p + 4, 4);
      let hdr = 8;
      if (len === 1) { len = u32be(b, p + 12) + u32be(b, p + 8) * 4294967296; hdr = 16; }
      if (len === 0) len = end - p;
      if (len < hdr || !/^[\w\- ]{4}$/.test(type)) return;
      const bodyStart = p + hdr;
      const bodyEnd = Math.min(p + len, end);
      if (type === 'uuid' && hex(b, bodyStart, 16) === C2PA_UUID) {
        // 16-byte UUID, then a FullBox version/flags word, then the JUMBF store.
        const data = b.subarray(bodyStart + 16 + 4, bodyEnd);
        const boxes = parseJumbfBoxes(data, 0, data.length);
        const c = extractC2pa(boxes);
        if (c && !meta.c2pa) {
          meta.c2pa = c;
          if (storeFills(boxes, data.length, p + len, b.length)) meta.c2paRanges = [{ start: p, end: bodyEnd }];
        }
      } else if (Object.prototype.hasOwnProperty.call(ISO_CONTAINERS, type)) {
        walkIso(b, bodyStart + ISO_CONTAINERS[type], bodyEnd, meta, depth + 1);
      } else if (!ISO_SKIP.has(type)) {
        if (type === 'xml ' || type === 'XMP_') {
          const x = parseXmp(utf8.decode(b.subarray(bodyStart, bodyEnd)));
          if (x && !meta.xmp) meta.xmp = x;
        }
      }
      p += len;
    }
  }

  /* True when the file's index has not been seen yet, which means the C2PA
   * box may live past the bytes we fetched. */
  function isobmffNeedsTail(bytes) {
    let p = 0;
    let sawMoov = false;
    while (p + 8 <= bytes.length) {
      let len = u32be(bytes, p);
      const type = ascii(bytes, p + 4, 4);
      let hdr = 8;
      if (len === 1) { len = u32be(bytes, p + 12) + u32be(bytes, p + 8) * 4294967296; hdr = 16; }
      if (len === 0) return !sawMoov;
      if (len < hdr) return !sawMoov;
      if (type === 'moov') sawMoov = true;
      p += len;
    }
    return !sawMoov;
  }

  /* ---- SVG -------------------------------------------------------------- */

  function parseSvg(b, meta) {
    const text = utf8.decode(b.subarray(0, Math.min(b.length, 256 * 1024)));
    /* indexOf rather than /<!--([\s\S]*?)-->/g: on a run of unclosed "<!--"
     * that regex rescans to the end of the document from every one of them,
     * which is ten seconds of the shared worker for a 256 KB file. */
    for (let q = text.indexOf('<!--'); q >= 0 && meta.comments.length < MAX_COMMENTS;) {
      const end = text.indexOf('-->', q + 4);
      if (end < 0) break;
      meta.comments.push(text.slice(q + 4, end).trim().slice(0, 300));
      q = text.indexOf('<!--', end + 3);
    }
    const gen = text.match(/<(?:dc:)?(?:creator|generator|title)[^>]{0,1000}>([^<]{2,120})</i);
    if (gen) meta.comments.push(gen[1]);
  }

  /* ---- TIFF / EXIF ------------------------------------------------------ */

  const TIFF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
  const TAG_NAMES = { 0x010f: 'make', 0x0110: 'model', 0x0131: 'software', 0x010e: 'imageDescription', 0x013b: 'artist', 0x8298: 'copyright', 0x9286: 'userComment', 0xa430: 'ownerName', 0x9c9c: 'xpComment', 0x9c9b: 'xpTitle', 0x9c9e: 'xpKeywords', 0xa433: 'lensMake', 0xa434: 'lensModel', 0x9003: 'dateTimeOriginal', 0x0132: 'dateTime' };

  function parseTiff(t) {
    if (t.length < 8) return null;
    const le = t[0] === 0x49 && t[1] === 0x49;
    if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return null;
    const r16 = (o) => (o + 2 <= t.length ? (le ? t[o] | (t[o + 1] << 8) : (t[o] << 8) | t[o + 1]) : 0);
    const r32 = (o) => (o + 4 <= t.length ? (le ? (t[o] | (t[o + 1] << 8) | (t[o + 2] << 16)) + t[o + 3] * 16777216 : ((t[o] << 24) >>> 0) + (t[o + 1] << 16) + (t[o + 2] << 8) + t[o + 3]) : 0);
    const out = {};
    const seen = new Set();
    const readIfd = (off, depth) => {
      if (depth > 3 || off < 8 || off + 2 > t.length || seen.has(off)) return;
      seen.add(off);
      const n = r16(off);
      if (n > 500) return;
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > t.length) return;
        const tag = r16(e); const type = r16(e + 2); const count = r32(e + 4);
        const size = (TIFF_TYPE_SIZE[type] || 1) * count;
        if (size > 1e7) continue;
        const valOff = size <= 4 ? e + 8 : r32(e + 8);
        if (valOff + size > t.length) continue;
        if (tag === 0x8769 || tag === 0xa005) { readIfd(size <= 4 ? r32(e + 8) : valOff, depth + 1); continue; }
        const name = TAG_NAMES[tag];
        if (!name) continue;
        const raw = t.subarray(valOff, valOff + size);
        if (type === 2) out[name] = latin1.decode(raw).replace(/\0+$/, '').trim();
        else if (type === 7 && name === 'userComment') out[name] = decodeUserComment(raw);
        else if (type === 1 && name.startsWith('xp')) out[name] = utf16le.decode(raw).replace(/\0+$/, '').trim();
        else if (type === 3 || type === 4) out[name] = type === 3 ? r16(valOff) : r32(valOff);
      }
    };
    readIfd(r32(4), 0);
    return Object.keys(out).length ? out : null;
  }

  function decodeUserComment(raw) {
    const head = latin1.decode(raw.subarray(0, 8));
    if (head.startsWith('UNICODE')) {
      const body = raw.subarray(8);
      const looksLE = body.length > 1 && body[1] === 0 && body[0] !== 0;
      return (looksLE ? utf16le : utf16be).decode(body).replace(/\0+$/, '').trim();
    }
    if (head.startsWith('ASCII') || head.startsWith('JIS') || /^\0+$/.test(head)) return latin1.decode(raw.subarray(8)).replace(/\0+$/, '').trim();
    return utf8.decode(raw).replace(/\0+/g, ' ').trim();
  }

  /* ---- XMP -------------------------------------------------------------- */

  function scanForXmp(b) {
    const start = indexOf(b, '<x:xmpmeta');
    if (start < 0) return null;
    const end = indexOf(b, '</x:xmpmeta>', start);
    return utf8.decode(b.subarray(start, end > 0 ? end + 12 : Math.min(b.length, start + 200000)));
  }

  /*
   * The body of the first <local>…</local>, found without backtracking.
   *
   * `<local\b[^>]*>([\s\S]*?)</local>` reads the same, but on a packet that
   * opens the element and never closes it the lazy middle rescans to the end
   * of the packet from every opening position: 1 MB of "<CreatorTool>" took
   * 29 s in the shared service worker, and the regex is built with
   * `new RegExp`, so the literal scanner in test/redos.test.js never saw it.
   * The lazy form always settles on the first open that has a close after it,
   * and on the nearest such close — which is what these two searches are,
   * each pass over the packet made once.
   */
  function elementBody(xml, local, prefix = '(?:[\\w-]+:)?') {
    const open = new RegExp('<' + prefix + local + '\\b([^>]{0,1000})>', 'gi');
    const close = new RegExp('</' + prefix + local + '>', 'gi');
    const o = open.exec(xml);
    if (!o) return null;
    close.lastIndex = o.index + o[0].length;
    const c = close.exec(xml);
    if (!c) return null;
    return { attrs: o[1], body: xml.slice(o.index + o[0].length, c.index) };
  }

  function xmpValue(xml, local) {
    const attr = new RegExp('(?:^|[\\s<"])(?:[\\w-]+:)?' + local + '\\s*=\\s*"([^"]{0,4096})"', 'i').exec(xml);
    if (attr) return attr[1].trim();
    const el = elementBody(xml, local);
    if (el) {
      const li = elementBody(el.body, 'li', 'rdf:');
      const inner = li ? li.body : el.body;
      const res = /rdf:resource\s*=\s*"([^"]{0,4096})"/i.exec(inner) || /rdf:resource\s*=\s*"([^"]{0,4096})"/i.exec(el.attrs);
      const textVal = inner.replace(/<[^>]{1,1000}>/g, '').trim();
      return textVal || (res ? res[1].trim() : '');
    }
    const self = new RegExp('<(?:[\\w-]+:)?' + local + '\\b[^>]{0,1000}rdf:resource\\s*=\\s*"([^"]{0,4096})"[^>]{0,1000}/>', 'i').exec(xml);
    return self ? self[1].trim() : '';
  }

  function parseXmp(xml) {
    if (!xml) return null;
    /* Bounded here rather than at each of the four call sites — JPEG APP1,
     * reassembled extended XMP, PNG iTXt and the WebP "XMP " chunk all hand
     * over a chunk the page chose the size of, and only the generic scan
     * capped itself. A packet this reader will not read past is one it cannot
     * be made to spend the worker's whole budget on. */
    if (xml.length > MAX_XMP) xml = xml.slice(0, MAX_XMP);
    const x = {
      digitalSourceType: xmpValue(xml, 'DigitalSourceType'),
      creatorTool: xmpValue(xml, 'CreatorTool'),
      creator: xmpValue(xml, 'creator'),
      description: xmpValue(xml, 'description'),
      title: xmpValue(xml, 'title'),
      credit: xmpValue(xml, 'Credit'),
      source: xmpValue(xml, 'Source'),
      rights: xmpValue(xml, 'rights'),
      make: xmpValue(xml, 'Make'),
      model: xmpValue(xml, 'Model'),
      softwareAgents: unique([...xml.matchAll(/softwareAgent\s*=\s*"([^"]+)"/gi)].map((m) => m[1]).concat([...xml.matchAll(/<stEvt:softwareAgent>([^<]+)</gi)].map((m) => m[1]))),
      aiFlags: unique([...xml.matchAll(/<[\w-]+:(?:AIGenerated|ai[-_]?generated|GenAI\w*|AiGenerated)\b[^>]{0,1000}>([^<]{0,4096})</gi)].map((m) => m[0].slice(0, 80))),
      length: xml.length,
    };
    return x;
  }

  function mergeXmp(a, b) {
    if (!a) return b;
    const out = { ...a };
    for (const k of Object.keys(b)) if (!out[k] || (Array.isArray(out[k]) && !out[k].length)) out[k] = b[k];
    return out;
  }

  /* ---- JUMBF / C2PA ----------------------------------------------------- */

  function parseJumbfBoxes(b, start, end, depth = 0) {
    const boxes = [];
    let p = start;
    while (p + 8 <= end && depth < 12) {
      let len = u32be(b, p);
      const type = ascii(b, p + 4, 4);
      let hdr = 8;
      if (len === 1) { len = u32be(b, p + 12) + u32be(b, p + 8) * 4294967296; hdr = 16; }
      if (len === 0) len = end - p;
      if (len < hdr || !/^[\w ]{4}$/.test(type)) break;
      const bodyStart = p + hdr;
      const bodyEnd = Math.min(p + len, end);
      const box = { type, start: p, end: bodyEnd, raw: b.subarray(p, bodyEnd), data: b.subarray(bodyStart, bodyEnd), children: [], label: null, uuid: null };
      if (type === 'jumb') {
        const children = parseJumbfBoxes(b, bodyStart, bodyEnd, depth + 1);
        const desc = children.find((c) => c.type === 'jumd');
        if (desc) {
          box.uuid = hex(desc.data, 0, 16);
          const toggles = desc.data[16];
          let q = 17;
          if (toggles & 2) { const z = desc.data.indexOf(0, q); box.label = utf8.decode(desc.data.subarray(q, z < 0 ? desc.data.length : z)); q = z + 1; }
        }
        box.children = children.filter((c) => c.type !== 'jumd');
      }
      boxes.push(box);
      p += len;
    }
    return boxes;
  }

  /*
   * Whether a container box may be used as the credential store's extent.
   *
   * The hard binding is a digest over the file with the store taken out, so
   * whatever the reader calls "the store" is what a claim is allowed to
   * exclude. Two ways that goes wrong, both reproduced: a declared length
   * that runs past the end of the file used to be clamped to the file's end,
   * so the declared store swallowed the picture; and a box padded out past
   * the JUMBF boxes inside it does the same without overrunning anything.
   * Neither shape is a conformant embedding, and neither has an extent worth
   * anything, so the range is refused and the binding comes out unchecked
   * rather than valid over a sliver of the header.
   */
  function storeFills(boxes, payloadLength, boxEnd, fileLength) {
    if (boxEnd > fileLength) return false;
    return !!boxes.length && boxes[boxes.length - 1].end === payloadLength;
  }

  function scanForJumbf(b) {
    let from = 0;
    for (let i = 0; i < 64; i++) {
      const idx = indexOf(b, 'jumb', from);
      if (idx < 4) return null;
      if (ascii(b, idx + 8, 4) === 'jumd') {
        const boxes = parseJumbfBoxes(b, idx - 4, b.length);
        if (boxes.length && boxes[0].label) return boxes;
      }
      from = idx + 4;
    }
    return null;
  }

  function findBox(boxes, pred) {
    for (const bx of boxes) {
      if (pred(bx)) return bx;
      const inner = findBox(bx.children, pred);
      if (inner) return inner;
    }
    return null;
  }

  function contentOf(box) {
    const cb = box.children.find((c) => c.type === 'cbor');
    if (cb) return CBOR.decodeValue(cb.data);
    const js = box.children.find((c) => c.type === 'json');
    if (js) { try { return JSON.parse(utf8.decode(js.data)); } catch (e) { return null; } }
    return null;
  }

  function extractC2pa(boxes) {
    if (!boxes || !boxes.length) return null;
    const store = findBox(boxes, (bx) => bx.type === 'jumb' && bx.label === 'c2pa');
    const manifestBoxes = store ? store.children.filter((c) => c.type === 'jumb') : boxes.filter((c) => c.type === 'jumb' && /^urn:/i.test(c.label || ''));
    if (!manifestBoxes.length) return null;
    const manifests = manifestBoxes.map(parseManifest);
    const active = manifests[manifests.length - 1];
    return { manifestCount: manifests.length, active, manifests };
  }

  function parseManifest(box) {
    const m = { label: box.label, claimGenerator: null, claimGeneratorInfo: [], title: null, actions: [], assertions: [], ingredients: [], signerNames: [], digitalSourceTypes: [], softwareAgents: [] };
    const claimBox = box.children.find((c) => c.type === 'jumb' && /^c2pa\.claim/.test(c.label || ''));
    const claim = claimBox ? contentOf(claimBox) : null;
    // Raw bytes the verifier needs; stripped before the result leaves here.
    m.claim = claim && typeof claim === 'object' ? claim : null;
    /* Only assertions the signed claim names may speak for the asset. An
     * unreferenced box can be added by anyone without disturbing a signature. */
    const refs = m.claim
      ? [].concat(m.claim.assertions || [], m.claim.created_assertions || [], m.claim.gathered_assertions || [])
        .filter((x) => x && typeof x === 'object' && x.url)
        .map((x) => String(x.url).split('/').pop())
      : [];
    /* An empty list when there is a claim, null only when there is none. A
     * claim that references nothing covers nothing, and reading that as "no
     * basis to restrict" let every box in the manifest speak under a
     * signature that named none of them. */
    m.referencedAssertions = m.claim ? refs : null;
    const claimCbor = claimBox ? claimBox.children.find((c) => c.type === 'cbor') : null;
    m.claimRaw = claimCbor ? claimCbor.data : null;
    m.assertionBoxes = [];
    if (claim && typeof claim === 'object') {
      if (typeof claim.claim_generator === 'string') m.claimGenerator = claim.claim_generator;
      const infos = Array.isArray(claim.claim_generator_info) ? claim.claim_generator_info : [];
      m.claimGeneratorInfo = infos.map((i) => (i && typeof i === 'object' ? [i.name, i.version].filter(Boolean).join(' ') : String(i))).filter(Boolean);
      if (!m.claimGenerator && m.claimGeneratorInfo.length) m.claimGenerator = m.claimGeneratorInfo.join(', ');
      if (typeof claim['dc:title'] === 'string') m.title = claim['dc:title'];
    }
    const assertionsBox = box.children.find((c) => c.type === 'jumb' && c.label === 'c2pa.assertions');
    for (const a of (assertionsBox ? assertionsBox.children : []).filter((c) => c.type === 'jumb')) {
      const label = a.label || '';
      m.assertions.push(label);
      const inner = a.children.find((c) => c.type === 'cbor' || c.type === 'json');
      // `data` is the payload without the inner box's own 8-byte header, which
      // is the other convention producers hash. `raw` would never match it.
      m.assertionBoxes.push({ label, raw: a.raw, content: inner ? inner.data : null, contentType: inner ? inner.type : null });
      const content = contentOf(a);
      if (!content || typeof content !== 'object') continue;
      if (/^c2pa\.actions/.test(label)) {
        for (const act of Array.isArray(content.actions) ? content.actions : []) {
          if (!act || typeof act !== 'object') continue;
          const agent = typeof act.softwareAgent === 'string' ? act.softwareAgent : act.softwareAgent && act.softwareAgent.name ? [act.softwareAgent.name, act.softwareAgent.version].filter(Boolean).join(' ') : null;
          const entry = { action: act.action || null, digitalSourceType: act.digitalSourceType || null, softwareAgent: agent, when: act.when || null, description: act.description || null, from: label };
          m.actions.push(entry);
          if (entry.digitalSourceType) m.digitalSourceTypes.push({ value: entry.digitalSourceType, from: label });
          if (agent) m.softwareAgents.push(agent);
        }
        for (const t of Array.isArray(content.templates) ? content.templates : []) {
          if (t && t.digitalSourceType) m.digitalSourceTypes.push({ value: t.digitalSourceType, from: label });
          if (t && t.softwareAgent) m.softwareAgents.push(typeof t.softwareAgent === 'string' ? t.softwareAgent : t.softwareAgent.name);
        }
      } else if (/^c2pa\.ingredient/.test(label)) {
        m.ingredients.push(content['dc:title'] || content.title || label);
      } else {
        const flat = JSON.stringify(content, (k, v) => (v instanceof Uint8Array ? undefined : v)) || '';
        const dst = flat.match(/digitalsourcetype\/(\w+)/i);
        if (dst) m.digitalSourceTypes.push({ value: S.IPTC_DST_PREFIX + dst[1], from: label });
        const gen = flat.match(/"(?:CreatorTool|Software|softwareAgent|xmp:CreatorTool|exif:Software)"\s*:\s*"([^"]{2,80})"/i);
        if (gen) m.softwareAgents.push(gen[1]);
      }
    }
    const sigBox = box.children.find((c) => c.type === 'jumb' && /^c2pa\.signature/.test(c.label || ''));
    if (sigBox) {
      const cose = contentOf(sigBox);
      m.cose = Array.isArray(cose) ? cose : null;
      m.signerNames = extractCertNames(cose);
    }
    m.softwareAgents = unique(m.softwareAgents);
    return m;
  }

  function extractCertNames(cose) {
    if (!Array.isArray(cose) || cose.length < 4) return [];
    const names = [];
    const headers = [];
    if (cose[0] instanceof Uint8Array) { const p = CBOR.decodeValue(cose[0]); if (p && typeof p === 'object') headers.push(p); }
    if (cose[1] && typeof cose[1] === 'object') headers.push(cose[1]);
    for (const h of headers) {
      const chain = h['33'];
      const certs = Array.isArray(chain) ? chain : chain instanceof Uint8Array ? [chain] : [];
      for (const cert of certs) {
        if (!(cert instanceof Uint8Array)) continue;
        const cn = derNames(cert, [0x55, 0x04, 0x03]);
        const org = derNames(cert, [0x55, 0x04, 0x0a]);
        // Issuer appears before subject in a certificate; take the subject (last) names.
        if (cn.length) names.push(cn[cn.length - 1]);
        if (org.length) names.push(org[org.length - 1]);
        break; // leaf certificate only
      }
    }
    return unique(names);
  }

  function derNames(cert, oid) {
    const out = [];
    for (let i = 0; i + 5 + oid.length < cert.length; i++) {
      if (cert[i] !== 0x06 || cert[i + 1] !== oid.length) continue;
      let ok = true;
      for (let k = 0; k < oid.length; k++) if (cert[i + 2 + k] !== oid[k]) { ok = false; break; }
      if (!ok) continue;
      let q = i + 2 + oid.length;
      const tag = cert[q];
      if (![0x0c, 0x13, 0x14, 0x16, 0x1e].includes(tag)) continue;
      let len = cert[q + 1];
      q += 2;
      if (len & 0x80) { const n = len & 0x7f; len = 0; for (let k = 0; k < n; k++) len = (len << 8) | cert[q + k]; q += n; }
      if (q + len > cert.length || len > 200) continue;
      const raw = cert.subarray(q, q + len);
      out.push((tag === 0x1e ? utf16be : utf8).decode(raw));
    }
    return out;
  }

  /* ---- signal derivation ------------------------------------------------ */

  function deriveSignals(meta) {
    const signals = [];
    const push = (s) => signals.push(s);

    /* C2PA */
    if (meta.c2pa && meta.c2pa.active) {
      const a = meta.c2pa.active;
      const gen = [a.claimGenerator, ...a.claimGeneratorInfo].filter(Boolean).join(' ');
      /*
       * Which assertions may speak for this asset. Hash-verified ones when
       * verification reached a conclusion; otherwise the ones the claim at
       * least names. An assertion nobody referenced was added by someone
       * without touching the signature, so it says nothing.
       */
      const trusted = trustedLabels(a);
      const allowed = (label) => trusted === null || trusted.has(label);
      const actions = a.actions.filter((x) => allowed(x.from));
      const created = actions.filter((x) => x.action === 'c2pa.created' || x.action === 'c2pa.placed');
      const dstAll = a.digitalSourceTypes.filter((x) => allowed(x.from)).map((x) => S.digitalSourceType(x.value)).filter(Boolean);
      const createdDst = created.map((x) => S.digitalSourceType(x.digitalSourceType)).filter(Boolean);
      const aiCreated = createdDst.find((d) => d.verdict === 'ai-generated') || (dstAll.find((d) => d.verdict === 'ai-generated') && created.length === 0 ? dstAll.find((d) => d.verdict === 'ai-generated') : null);
      const aiEdited = dstAll.find((d) => d.verdict === 'ai-edited');
      const agentAI = actions.map((x) => x.softwareAgent).filter(Boolean).find((x) => S.AI_GENERATOR_RE.test(x)) || a.softwareAgents.find((x) => S.AI_GENERATOR_RE.test(x));
      const genAI = gen && S.AI_GENERATOR_RE.test(gen);
      const v = a.verification;
      const vs = v ? VERIFY.summarize(v) : null;
      const signer = a.signerNames.length ? ' Signed by: ' + a.signerNames.join(', ') + '.' : '';
      const base = 'Content Credentials (C2PA) manifest' + (gen ? ' by ' + gen : '') + '.';
      /* Broken credentials are their own finding: someone signed this, and
       * then it changed. That matters more than what the claim says. */
      if (vs && vs.broken) {
        const brokenLabel = vs.bindingMismatch ? 'Content Credentials do not describe this file'
          : vs.bindingAbsent ? 'Content Credentials are not bound to any file'
            : vs.payloadMismatch ? 'Content Credentials carry a signature over different content'
              : 'Content Credentials do not verify';
        push({ id: 'c2pa-broken', hard: true, verdict: 'suspected', strength: 0.7, label: brokenLabel, detail: base + signer + ' ' + vs.text + '. ' + (vs.bindingNote && (vs.bindingMismatch || vs.bindingAbsent) ? vs.bindingNote + ' ' : '') + 'Treat every claim inside this manifest as unreliable.' });
        if (a.ingredients.length) push({ id: 'c2pa-ingredients', hard: false, verdict: 'no-signal', strength: 0, label: 'Content Credentials list ingredients', detail: a.ingredients.slice(0, 5).join(', ') });
        for (const n of meta.notes) push({ id: 'note', hard: false, verdict: 'no-signal', strength: 0, label: n, detail: '' });
        return signals;   // nothing else in this manifest is worth reporting
      } else if (vs && vs.caution) {
        /* Two different unanswered questions, and only one of them is odd.
         * Assertions that will not reconcile under a valid signature are an
         * anomaly worth a weak flag. A hard binding that could not be
         * recomputed usually means the fetch was byte-capped, which is true of
         * most large photographs and says nothing at all about the file — so
         * it withholds the provenance badge without accusing anyone. */
        const assertionsOdd = !!(v.assertions && v.assertions.checked && (v.assertions.inconclusive || v.assertions.missing.length));
        if (assertionsOdd) {
          push({ id: 'c2pa-caution', hard: false, verdict: 'suspected', strength: 0.3, label: 'Content Credentials signed, but their assertions could not be reconciled', detail: base + signer + ' ' + vs.text + '. Either an assertion was replaced after signing, or this reader does not know the hashing convention used.' });
        } else {
          push({ id: 'c2pa-unbound', hard: false, verdict: 'no-signal', strength: 0, label: 'Content Credentials signed, but they could not be tied to this file', detail: base + signer + ' ' + vs.text + '. ' + (vs.bindingNote || '') + ' Until that is recomputed the manifest is not read as provenance for this file.' });
        }
      } else if (vs && vs.ok) {
        push({ id: 'c2pa-verified', hard: false, verdict: 'no-signal', strength: 0, label: 'Content Credentials signature verified and bound to this file', detail: vs.text + '. A valid signature shows the manifest is intact since signing and its hard binding shows it describes these bytes; it does not by itself prove who signed it.' });
      } else if (v) {
        push({ id: 'c2pa-unverified', hard: false, verdict: 'no-signal', strength: 0, label: 'Content Credentials signature not verified', detail: (vs ? vs.text : 'Verification did not run') + '.' });
      }

      if (aiCreated) push({ id: 'c2pa-ai-created', hard: true, verdict: 'ai-generated', strength: 0.98, label: 'Content Credentials: created by generative AI', detail: base + ' Action ' + (created[0] ? created[0].action : 'assertion') + ' = ' + aiCreated.key + (agentAI ? ' via ' + agentAI : '') + '.' + signer });
      else if (aiEdited) push({ id: 'c2pa-ai-edited', hard: true, verdict: 'ai-edited', strength: 0.95, label: 'Content Credentials: edited with generative AI', detail: base + ' ' + aiEdited.label + (agentAI ? ' via ' + agentAI : '') + '.' + signer });
      else if (genAI || agentAI) push({ id: 'c2pa-ai-generator', hard: true, verdict: 'ai-generated', strength: 0.9, label: 'Content Credentials issued by a generative-AI system', detail: base + (agentAI ? ' Software agent: ' + agentAI + '.' : '') + signer });
      else {
        const capture = dstAll.find((d) => d.verdict === 'captured');
        const human = dstAll.find((d) => d.verdict === 'human-created');
        const algo = dstAll.find((d) => d.verdict === 'algorithmic');
        /*
         * A claim of AI generation is a disclosure against interest, so it is
         * read whatever its cryptographic state. An exculpatory claim — "a
         * camera made this", "a human made this" — is the one worth forging,
         * and forging it costs nothing when nobody checks. Three things have
         * to be true before one is read as provenance, and each was a way of
         * getting the green badge for nothing:
         *
         *   ok       — the signature verified, its assertions hash as the
         *              claim says, and the claim is bound to these bytes. A
         *              hand-written JUMBF box has none of that.
         *   anchored — some certificate on the chain is a signer this build
         *              knows. Without it, "CN=Leica Camera AG" is a name the
         *              forger typed into a key pair they made this morning,
         *              and every question the verifier asks is answered yes.
         *   rendered — these are the bytes the page itself loaded. The
         *              worker's own fetch is a second, distinguishable
         *              request (no cookies, a Range header, no Referer), so a
         *              server can hand the reader an AI picture and the
         *              extension a signed photograph and have the badge
         *              land on the one nobody hashed.
         *
         * Falling short of any of them is not an accusation; the claim is
         * still shown, as the unverified assertion it is.
         */
        const proven = !!(vs && vs.ok && vs.anchored && meta.rendered);
        const why = !vs || !vs.ok ? (vs && vs.text ? vs.text + '.' : 'The manifest was not verified.')
          : !vs.anchored ? 'The signature verified, but no certificate on its chain is a signer this build knows, so the name on it vouches for nothing.'
            : 'These are not the bytes the page loaded: they came from a separate fetch of the same URL, which the server need not have answered the same way.';
        const state = !vs || !vs.ok ? ', unverified' : !vs.anchored ? ', signer not vouched for' : ', not checked against the picture shown';
        /* 'self-claimed' rather than 'no-signal': the claim is still evidence a
         * reader should see, and at 'no-signal' the image dropped out of the
         * page report altogether — refusing the badge is right, hiding what
         * was refused is not. */
        const unproven = (id, d) => push({
          id, hard: false, verdict: 'self-claimed', strength: 0,
          label: 'Content Credentials claim ' + d + state,
          detail: base + signer + ' ' + why + ' Nothing here ties the claim to the picture on the page under a signer this build can vouch for, so it is not read as provenance.',
        });
        if (capture) {
          if (proven) push({ id: 'c2pa-capture', hard: true, verdict: 'captured', strength: capture.strength, label: 'Content Credentials: ' + capture.label, detail: base + signer });
          else unproven('c2pa-capture-unverified', capture.label.toLowerCase());
        } else if (human) {
          if (proven) push({ id: 'c2pa-human', hard: true, verdict: 'human-created', strength: human.strength, label: 'Content Credentials: ' + human.label, detail: base + signer });
          else unproven('c2pa-human-unverified', human.label.toLowerCase());
        } else if (algo) {
          if (proven) push({ id: 'c2pa-algo', hard: true, verdict: 'algorithmic', strength: algo.strength, label: 'Content Credentials: ' + algo.label, detail: base + signer });
          else unproven('c2pa-algo-unverified', algo.label.toLowerCase());
        } else if (gen && S.CAPTURE_GENERATOR_RE.test(gen)) {
          if (proven) push({ id: 'c2pa-capture-device', hard: true, verdict: 'captured', strength: 0.75, label: 'Content Credentials from a capture device / app', detail: base + signer });
          else unproven('c2pa-capture-device-unverified', 'a capture device or app');
        } else {
          push({ id: 'c2pa-present', hard: false, verdict: 'no-signal', strength: 0, label: 'Content Credentials present (no AI action declared)', detail: base + ' Assertions: ' + a.assertions.join(', ') + '.' + signer });
        }
      }
      if (a.ingredients.length) push({ id: 'c2pa-ingredients', hard: false, verdict: 'no-signal', strength: 0, label: 'Content Credentials list ingredients', detail: a.ingredients.slice(0, 5).join(', ') });
    }

    /* XMP / IPTC */
    const x = meta.xmp;
    if (x) {
      const dst = S.digitalSourceType(x.digitalSourceType);
      if (dst) {
        if (dst.verdict === 'unknown') push({ id: 'xmp-dst-other', hard: false, verdict: 'no-signal', strength: 0, label: 'IPTC digital source type: ' + dst.key, detail: dst.label });
        /* The same rule the Content Credentials above are held to, and for the
         * same reason — only cheaper to break. An Iptc4xmpExt:DigitalSourceType
         * of digitalCapture is one attribute in an XMP packet: no certificate,
         * no key, no hash. It says what the file says about itself, so it is
         * reported as that and never as the badge a verified manifest earns. */
        else if (S.EXCULPATORY_VERDICTS.has(dst.verdict)) push({ id: 'xmp-dst-claim', hard: false, verdict: 'self-claimed', strength: 0, label: 'This file says of itself: ' + dst.label, detail: 'Iptc4xmpExt:DigitalSourceType = ' + dst.key + '. Nothing signs an XMP attribute and nothing ties it to these bytes, so it is read as the file\'s own claim rather than as provenance.' });
        else push({ id: 'xmp-dst', hard: true, verdict: dst.verdict, strength: dst.strength, label: 'IPTC metadata: ' + dst.label, detail: 'Iptc4xmpExt:DigitalSourceType = ' + dst.key });
      }
      if (x.aiFlags.length) push({ id: 'xmp-ai-flag', hard: true, verdict: 'ai-generated', strength: 0.85, label: 'XMP carries an AI-generated flag', detail: x.aiFlags.join('; ') });
      const toolFields = [x.creatorTool, ...x.softwareAgents, x.credit, x.source].filter(Boolean).join(' | ');
      const tool = toolFields && S.matchTools(S.AI_IMAGE_TOOLS, toolFields);
      const editedByDst = dst && dst.verdict === 'ai-edited';
      if (tool && tool.length && S.GENERATOR_SOFTWARE_RE.test(toolFields)) push({ id: 'xmp-tool', hard: true, verdict: editedByDst ? 'ai-edited' : 'ai-generated', strength: 0.9, label: editedByDst ? 'XMP creator tool is a generative-AI application (composite)' : 'XMP creator tool is a generative-AI application', detail: toolFields.slice(0, 160) });
      else if (tool && tool.length && /generative/i.test(toolFields)) push({ id: 'xmp-tool-edit', hard: true, verdict: 'ai-edited', strength: 0.85, label: 'XMP history records a generative-AI edit', detail: toolFields.slice(0, 160) });
      if (x.description && /\s--(?:ar|v|s|stylize|niji|chaos|q|seed|style|sref|cref)\s+[\w:.]+|\bJob ID:\s*[0-9a-f-]{8,}/i.test(x.description)) push({ id: 'xmp-mj-prompt', hard: true, verdict: 'ai-generated', strength: 0.92, label: 'Midjourney prompt / job ID embedded in description', detail: x.description.slice(0, 160) });
      const disc = S.findDisclosures([x.description, x.title, x.rights, x.credit].filter(Boolean).join(' · ')).find((d) => d.level === 'generated' || d.level === 'assisted');
      if (disc) push({ id: 'xmp-disclosure', hard: false, verdict: 'ai-disclosed', strength: 0.85, label: 'Embedded description discloses AI ' + (disc.level === 'generated' ? 'generation' : 'assistance'), detail: '"' + disc.context + '"' });
    }

    /* EXIF */
    const e = meta.exif;
    if (e) {
      const soft = [e.software, e.imageDescription, e.userComment, e.xpComment, e.xpTitle, e.artist].filter(Boolean).join(' | ');
      if (soft && S.GENERATOR_SOFTWARE_RE.test(soft)) push({ id: 'exif-software', hard: true, verdict: 'ai-generated', strength: 0.88, label: 'EXIF names a generative-AI application', detail: soft.slice(0, 160) });
      if (e.userComment && /Steps:\s*\d+.*(?:Sampler|CFG scale|Seed):/is.test(e.userComment)) push({ id: 'exif-sd-params', hard: true, verdict: 'ai-generated', strength: 0.97, label: 'Stable Diffusion generation parameters in EXIF UserComment', detail: e.userComment.slice(0, 160) });
      if (e.imageDescription && /\s--(?:ar|v|s|stylize|niji|chaos)\s+[\w:.]+|\bJob ID:/i.test(e.imageDescription)) push({ id: 'exif-mj', hard: true, verdict: 'ai-generated', strength: 0.92, label: 'Midjourney prompt embedded in EXIF description', detail: e.imageDescription.slice(0, 160) });
      // Written by whatever wrote the file: copied from a real photograph, or
      // simply typed. Shown, because it is real evidence; not exculpatory,
      // because it is free.
      if (e.make && S.CAMERA_MAKE_RE.test(e.make) && !signals.some((s) => s.verdict === 'ai-generated')) push({ id: 'exif-camera', hard: false, verdict: 'self-claimed', strength: 0, label: 'This file says of itself: made by a camera (EXIF)', detail: [e.make, e.model, e.lensModel].filter(Boolean).join(' ') + (e.dateTimeOriginal ? ', ' + e.dateTimeOriginal : '') + ' (EXIF can be forged or inherited)' });
    }

    /* PNG text chunks */
    const png = meta.png && meta.png.text;
    if (png) {
      const keys = Object.keys(png);
      const params = png.parameters || png.Parameters;
      if (params && /Steps:\s*\d+|Sampler:|CFG scale:|Seed:\s*\d+|Model hash:/i.test(params)) push({ id: 'png-sd', hard: true, verdict: 'ai-generated', strength: 0.98, label: 'Stable Diffusion generation parameters (PNG "parameters")', detail: params.slice(0, 160) });
      else if (params && /fooocus|"prompt"|"base_model"/i.test(params)) push({ id: 'png-fooocus', hard: true, verdict: 'ai-generated', strength: 0.95, label: 'Generator parameters (PNG "parameters", JSON)', detail: params.slice(0, 160) });
      if ((png.prompt && /class_type|KSampler|CheckpointLoader/i.test(png.prompt)) || (png.workflow && /"nodes"|class_type/i.test(png.workflow))) push({ id: 'png-comfy', hard: true, verdict: 'ai-generated', strength: 0.98, label: 'ComfyUI workflow embedded in PNG', detail: (png.prompt || png.workflow).slice(0, 160) });
      if (png.Comment && /"(?:uc|sampler|steps|seed|scale)"\s*:/i.test(png.Comment)) push({ id: 'png-novelai', hard: true, verdict: 'ai-generated', strength: 0.95, label: 'Generation parameters in PNG "Comment" (NovelAI style)', detail: png.Comment.slice(0, 160) });
      for (const k of ['invokeai_metadata', 'sd-metadata', 'Dream', 'invokeai_graph', 'generation_data', 'sd_metadata']) {
        if (png[k]) { push({ id: 'png-' + k.toLowerCase(), hard: true, verdict: 'ai-generated', strength: 0.95, label: 'Generator metadata in PNG "' + k + '"', detail: String(png[k]).slice(0, 160) }); break; }
      }
      const soft = [png.Software, png.software, png.Source, png.Description, png.Title, png.Author, png.Comment].filter(Boolean).join(' | ');
      if (soft && S.GENERATOR_SOFTWARE_RE.test(soft) && !signals.some((s) => s.id.startsWith('png-'))) push({ id: 'png-software', hard: true, verdict: 'ai-generated', strength: 0.88, label: 'PNG text chunk names a generative-AI application', detail: soft.slice(0, 160) });
      const disc = soft && S.findDisclosures(soft).find((d) => d.level === 'generated' || d.level === 'assisted');
      if (disc && !signals.some((s) => s.id.startsWith('png-'))) push({ id: 'png-disclosure', hard: false, verdict: 'ai-disclosed', strength: 0.85, label: 'PNG text discloses AI use', detail: '"' + disc.context + '"' });
      if (keys.length && !signals.some((s) => s.id.startsWith('png-'))) push({ id: 'png-text', hard: false, verdict: 'no-signal', strength: 0, label: 'PNG text chunks present', detail: keys.slice(0, 6).join(', ') });
    }

    /* JPEG / SVG comments */
    for (const c of meta.comments) {
      if (S.GENERATOR_SOFTWARE_RE.test(c)) { push({ id: 'comment-generator', hard: true, verdict: 'ai-generated', strength: 0.85, label: 'Embedded comment names a generative-AI application', detail: c.slice(0, 160) }); break; }
      const disc = S.findDisclosures(c).find((d) => d.level === 'generated' || d.level === 'assisted');
      if (disc) { push({ id: 'comment-disclosure', hard: false, verdict: 'ai-disclosed', strength: 0.8, label: 'Embedded comment discloses AI use', detail: '"' + disc.context + '"' }); break; }
    }

    for (const n of meta.notes) push({ id: 'note', hard: false, verdict: 'no-signal', strength: 0, label: n, detail: '' });
    return signals;
  }

  /* null means "no basis to restrict", which is the no-claim case. A claim
   * that references nothing gives an empty set, which admits nothing. */
  function trustedLabels(active) {
    const v = active.verification;
    if (v && v.trustedAssertionLabels && v.trustedAssertionLabels.length) return new Set(v.trustedAssertionLabels);
    if (active.referencedAssertions) return new Set(active.referencedAssertions);
    return null;
  }

  function summarize(meta) {
    const out = { format: meta.format };
    if (meta.exif) out.exif = meta.exif;
    if (meta.xmp) {
      const { length, ...rest } = meta.xmp;
      out.xmp = Object.fromEntries(Object.entries(rest).filter(([, v]) => v && (!Array.isArray(v) || v.length)));
    }
    if (meta.png && Object.keys(meta.png.text).length) out.pngText = Object.fromEntries(Object.entries(meta.png.text).map(([k, v]) => [k, String(v).slice(0, 300)]));
    if (meta.c2pa) {
      const a = meta.c2pa.active || {};
      out.c2pa = {
        manifestCount: meta.c2pa.manifestCount, label: a.label, claimGenerator: a.claimGenerator,
        claimGeneratorInfo: a.claimGeneratorInfo, title: a.title, actions: a.actions, assertions: a.assertions,
        ingredients: a.ingredients, signerNames: a.signerNames, digitalSourceTypes: (a.digitalSourceTypes || []).map((x) => x.value),
        softwareAgents: a.softwareAgents, referencedAssertions: a.referencedAssertions,
        verification: a.verification ? { ...a.verification, summary: VERIFY ? VERIFY.summarize(a.verification) : null } : null,
      };
    }
    if (meta.comments.length) out.comments = meta.comments.slice(0, 5).map((c) => c.slice(0, 200));
    return out;
  }

  /* ---- helpers ---------------------------------------------------------- */

  /*
   * Inflate, with a ceiling on the output.
   *
   * A deflate stream of one repeated byte inflates about 1000:1, so half a
   * megabyte of PNG zTXt becomes half a gigabyte — four at a time, in the one
   * service worker every tab shares, until Chrome kills it. The cap is read
   * as the stream is read, so nothing over it is ever allocated.
   *
   * `overflow` distinguishes "bigger than this reader inspects" from "not a
   * deflate stream at all": the first is worth a note, the second is not.
   */
  async function inflate(bytes, max) {
    try {
      if (typeof DecompressionStream === 'function') {
        const ds = new DecompressionStream('deflate');
        const writer = ds.writable.getWriter();
        writer.write(bytes).catch(() => {}); writer.close().catch(() => {});
        const reader = ds.readable.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > max) {
            try { await reader.cancel(); } catch (e) { /* ignore */ }
            return { out: null, overflow: true };
          }
          chunks.push(value);
        }
        return { out: concat(chunks), overflow: false };
      }
    } catch (e) { /* fall through */ }
    try {
      if (isNode) return { out: new Uint8Array(require('zlib').inflateSync(Buffer.from(bytes), { maxOutputLength: max })), overflow: false };
    } catch (e) {
      if (e && /maxOutputLength|buffer|ERR_BUFFER_TOO_LARGE/i.test(String(e.message))) return { out: null, overflow: true };
    }
    return { out: null, overflow: false };
  }

  function ascii(b, o, n) {
    if (o + n > b.length) return '';
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]);
    return s;
  }
  function hex(b, o, n) {
    let s = '';
    for (let i = 0; i < n && o + i < b.length; i++) s += b[o + i].toString(16).padStart(2, '0');
    return s;
  }
  function u32be(b, o) { return o + 4 <= b.length ? ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3] : 0; }
  function u32le(b, o) { return o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216 : 0; }
  function startsWith(b, s) {
    if (b.length < s.length) return false;
    for (let i = 0; i < s.length; i++) if (b[i] !== s.charCodeAt(i)) return false;
    return true;
  }
  function indexOf(b, s, from = 0) {
    const first = s.charCodeAt(0);
    outer: for (let i = from; i <= b.length - s.length; i++) {
      if (b[i] !== first) continue;
      for (let k = 1; k < s.length; k++) if (b[i + k] !== s.charCodeAt(k)) continue outer;
      return i;
    }
    return -1;
  }
  function concat(parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function unique(list) { return [...new Set(list.filter(Boolean))]; }

  return { analyzeImageBytes, detectFormat, isobmffNeedsTail, parseTiff, parseXmp, parseJumbfBoxes, extractC2pa, deriveSignals, scanForXmp, scanForJumbf, _internal: { concat, u32be } };
});
