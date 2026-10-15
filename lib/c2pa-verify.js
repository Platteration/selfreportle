/*
 * lib/c2pa-verify.js — cryptographic checks on a C2PA manifest.
 *
 * Four separate questions, reported separately because they mean different
 * things:
 *
 *   1. Is the signature valid?  The COSE_Sign1 signature is checked with
 *      WebCrypto against the public key in the embedded leaf certificate.
 *      A valid signature proves the claim has not been altered since it was
 *      signed. It proves nothing about who signed it.
 *
 *   2. Do the assertions match the claim?  Each assertion's JUMBF box is
 *      hashed and compared with the hash the claim recorded. This is what
 *      stops someone swapping "made by a camera" for "made by AI" while
 *      leaving the signature intact.
 *
 *   3. Does the certificate chain mean anything?  The chain is checked for
 *      internal consistency (each certificate signed by the next), for
 *      validity dates, and for whether any certificate on it is a trust
 *      anchor this build knows. TRUST_ANCHORS is empty here, so the answer
 *      is always "not anchored" — and an unanchored chain may not vouch for
 *      an exculpatory claim, because minting a certificate that says
 *      "Leica Camera AG" costs one key generation.
 *
 *   4. Does the manifest describe THIS file?  The claim must carry a hard
 *      binding — a digest over the asset's own bytes with the credential
 *      store excluded — and that digest is recomputed here. Without this a
 *      genuine, fully verifying manifest can be lifted out of a real
 *      photograph and dropped into a generated image: every other answer
 *      stays "yes" while the credentials describe a different file. The
 *      exclusions must be the credential store exactly, whole, and nothing
 *      else; a PNG must walk cleanly from IHDR to an IEND that ends the
 *      file. Anything short of that, a capped fetch or a binding form this
 *      reader cannot recompute is reported as unchecked, never as a pass.
 *
 *   4. Does the credential belong to these asset bytes? Authenticated data
 *      hashes are checked with their exclusions. Missing complete bytes or
 *      unsupported binding formats are reported as unchecked.
 *
 * Nothing here reaches the network. A missing answer is reported as unknown,
 * never as a pass.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.c2paVerify = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const isNode = typeof module === 'object' && typeof require === 'function';
  const CBOR = isNode ? require('./cbor.js') : root.SRL.cbor;
  const X509 = isNode ? require('./x509.js') : root.SRL.x509;

  const subtle = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle
    : (isNode ? require('crypto').webcrypto.subtle : null);

  /* COSE algorithm labels (RFC 9053) mapped to WebCrypto parameters. */
  const COSE_ALGS = {
    '-7': { name: 'ES256', hash: 'SHA-256', kind: 'ec', size: 32 },
    '-35': { name: 'ES384', hash: 'SHA-384', kind: 'ec', size: 48 },
    '-36': { name: 'ES512', hash: 'SHA-512', kind: 'ec', size: 66 },
    '-37': { name: 'PS256', hash: 'SHA-256', kind: 'pss' },
    '-38': { name: 'PS384', hash: 'SHA-384', kind: 'pss' },
    '-39': { name: 'PS512', hash: 'SHA-512', kind: 'pss' },
    '-257': { name: 'RS256', hash: 'SHA-256', kind: 'pkcs1' },
    '-258': { name: 'RS384', hash: 'SHA-384', kind: 'pkcs1' },
    '-259': { name: 'RS512', hash: 'SHA-512', kind: 'pkcs1' },
    '-8': { name: 'EdDSA', kind: 'ed25519' },
  };

  /* Certificate signature algorithm OIDs, for checking the chain itself. */
  const CERT_SIG_ALGS = {
    '1.2.840.10045.4.3.2': { kind: 'ec', hash: 'SHA-256', der: true },
    '1.2.840.10045.4.3.3': { kind: 'ec', hash: 'SHA-384', der: true },
    '1.2.840.10045.4.3.4': { kind: 'ec', hash: 'SHA-512', der: true },
    '1.2.840.113549.1.1.11': { kind: 'pkcs1', hash: 'SHA-256' },
    '1.2.840.113549.1.1.12': { kind: 'pkcs1', hash: 'SHA-384' },
    '1.2.840.113549.1.1.13': { kind: 'pkcs1', hash: 'SHA-512' },
    '1.2.840.113549.1.1.10': { kind: 'pss', hash: 'SHA-256' },
    '1.3.101.112': { kind: 'ed25519' },
  };

  const CURVES = { '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 }, '1.3.132.0.34': { name: 'P-384', size: 48 }, '1.3.132.0.35': { name: 'P-521', size: 66 } };
  const HASH_BY_NAME = { 'sha256': 'SHA-256', 'sha384': 'SHA-384', 'sha512': 'SHA-512' };

  /*
   * Trust anchors: the SHA-256 of each trusted certificate's DER, lower-case
   * hex. A chain is anchored when any certificate on it is in this set.
   *
   * The set is EMPTY in this build, deliberately. Anchoring is the whole of
   * the difference between "this manifest is intact" and "this manifest is
   * from Leica", and which roots a reader should trust is a distribution
   * question — the C2PA conformance list, plus whatever the reader imports —
   * not something this file may decide. Until it is populated every chain is
   * unanchored, and an unanchored chain does not vouch for a claim of
   * capture or human origin (lib/image-metadata.js deriveSignals): a
   * self-signed certificate carrying any name at all costs one key
   * generation, so a badge that rests on the name alone is free to forge.
   *
   * setTrustAnchors is how a bundled list or a reader's own import fills it;
   * nothing calls it yet.
   */
  const TRUST_ANCHORS = new Set();

  function setTrustAnchors(list) {
    TRUST_ANCHORS.clear();
    for (const h of Array.isArray(list) ? list : []) {
      if (typeof h === 'string' && /^[0-9a-f]{64}$/i.test(h)) TRUST_ANCHORS.add(h.toLowerCase());
    }
    return TRUST_ANCHORS.size;
  }

  const UNANCHORED_NOTE = 'This build ships no C2PA trust list, so the chain is not checked against known signers. '
    + 'A valid signature therefore shows the manifest is intact, not that the signer is who the name suggests, '
    + 'and a claim that a camera or a human made this file is not read as provenance on that basis.';

  /*
   * manifest: the parsed manifest from image-metadata.js, carrying
   *   cose      — the decoded COSE_Sign1 array
   *   claimRaw  — the claim's CBOR bytes (the detached payload)
   *   claim     — the decoded claim
   *   assertionBoxes — [{ label, raw }] full JUMBF box bytes per assertion
   *
   * opts:
   *   asset       — the bytes of the file the manifest was found in
   *   assetRanges — [{ start, end }] where the credential store sits in those
   *                 bytes, so an exclusion range that reaches beyond it can
   *                 be refused
   *   truncated   — the fetch was byte-capped, so `asset` is a prefix
   */
  async function verifyManifest(manifest, opts = {}) {
    const out = {
      signature: 'unknown', algorithm: null, signedBy: null,
      assertions: { checked: 0, matched: 0, mismatched: [], missing: [], unhashed: [], duplicateLabels: [], unreferenced: false, inconclusive: false, truncated: false, convention: null, note: null, trustedLabels: [] },
      chain: null,
      assetBinding: { status: 'unchecked', note: 'Asset binding unchecked: no supported authenticated hard-binding assertion was checked.' },
      notes: [],
    };
    if (!subtle) { out.notes.push('No WebCrypto available in this context.'); return out; }
    if (!manifest || !Array.isArray(manifest.cose) || manifest.cose.length < 4) {
      out.signature = 'absent';
      out.notes.push('No COSE signature structure was found in the manifest.');
      return out;
    }

    const [protectedBstr, unprotected, payload, signature] = manifest.cose;
    const prot = protectedBstr instanceof Uint8Array && protectedBstr.length ? CBOR.decodeValue(protectedBstr) : {};
    const algLabel = String(pick(prot, '1', unprotected && unprotected['1']));
    const alg = COSE_ALGS[algLabel];
    out.algorithm = alg ? alg.name : 'unrecognised (COSE alg ' + algLabel + ')';

    const chainDer = collectChain(prot, unprotected);
    if (!chainDer.length) {
      out.signature = 'unknown';
      out.notes.push('The manifest carries no certificate, so its signature cannot be checked.');
    }

    /* Parse each certificate on its own: one unreadable certificate higher up
     * the chain must not stop the leaf's signature from being checked. */
    const certs = [];
    const certDer = [];
    for (let i = 0; i < chainDer.length; i++) {
      try { certs.push(X509.parseCertificate(chainDer[i])); certDer.push(chainDer[i]); }
      catch (e) { out.notes.push('Certificate ' + (i + 1) + ' of ' + chainDer.length + ' could not be parsed: ' + e.message); }
    }
    if (certs.length) {
      out.signedBy = { cn: certs[0].subject.cn, o: certs[0].subject.o, subject: certs[0].subject.text, issuer: certs[0].issuer.text };
      out.chain = await checkChain(certs, opts.at || new Date(), certDer);
    }

    /*
     * 1. Signature over the COSE Sig_structure.
     *
     * The body must be the claim this reader goes on to report, which is the
     * one in the c2pa.claim box. A COSE payload carried inline is only
     * accepted when it is byte-identical to that claim; otherwise a genuine
     * signature over some other claim can be replayed next to an attacker's
     * claim box and the whole verification means nothing.
     */
    if (certs.length && alg) {
      const detached = payload == null || (payload instanceof Uint8Array && payload.length === 0);
      const body = manifest.claimRaw;
      if (!body) {
        out.signature = 'unknown';
        out.notes.push('The claim bytes were not available, so the signature could not be checked against them.');
      } else if (!detached && !equalBytes(payload, body)) {
        out.signature = 'invalid';
        out.payloadMismatch = true;
        out.notes.push('The bytes carried inside the signature are not the claim stored in this manifest. A signature over different content has been attached to this claim; treat every statement in it as unverified.');
      } else {
        const sigStructure = CBOR.encode(['Signature1', protectedBstr || new Uint8Array(0), new Uint8Array(0), body]);
        try {
          const key = await importPublicKey(certs[0], alg);
          const ok = await subtle.verify(verifyParams(alg, certs[0]), key, normalizeSig(signature, alg), sigStructure);
          out.signature = ok ? 'valid' : 'invalid';
          if (!ok) out.notes.push('The signature did not verify against the embedded certificate. The manifest may have been altered, or this reader may not handle this signing profile.');
        } catch (e) {
          out.signature = 'unsupported';
          out.notes.push('Signature could not be checked: ' + e.message);
        }
      }
    } else if (certs.length && !alg) {
      out.signature = 'unsupported';
    }

    /* 2. Assertions against the hashes the claim recorded. */
    if (manifest.claim && manifest.assertionBoxes) {
      out.assertions.truncated = !!opts.truncated;
      await checkAssertions(manifest, out.assertions);
      out.trustedAssertionLabels = out.assertions.trustedLabels;
    } else {
      out.assertions = null;
    }

    out.assetBinding = await checkAssetBinding(manifest, out, opts);

    return out;
  }

  function pick(a, key, fallback) {
    if (a && Object.prototype.hasOwnProperty.call(a, key)) return a[key];
    return fallback;
  }

  /* x5chain sits at COSE header label 33, in either header bucket, and may be
   * a single certificate or an array of them, leaf first. */
  function collectChain(prot, unprot) {
    const raw = pick(prot, '33', undefined) !== undefined ? prot['33'] : (unprot ? unprot['33'] : undefined);
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.filter((x) => x instanceof Uint8Array && x.length > 40);
  }

  async function importPublicKey(cert, alg) {
    if (alg.kind === 'ec') {
      const curve = CURVES[cert.spkiCurveOid];
      if (!curve) throw new Error('unsupported curve ' + cert.spkiCurveOid);
      return subtle.importKey('spki', cert.spkiDer, { name: 'ECDSA', namedCurve: curve.name }, false, ['verify']);
    }
    if (alg.kind === 'pss') return subtle.importKey('spki', cert.spkiDer, { name: 'RSA-PSS', hash: alg.hash }, false, ['verify']);
    if (alg.kind === 'pkcs1') return subtle.importKey('spki', cert.spkiDer, { name: 'RSASSA-PKCS1-v1_5', hash: alg.hash }, false, ['verify']);
    if (alg.kind === 'ed25519') return subtle.importKey('spki', cert.spkiDer, { name: 'Ed25519' }, false, ['verify']);
    throw new Error('unsupported algorithm ' + alg.name);
  }

  function verifyParams(alg, cert) {
    if (alg.kind === 'ec') return { name: 'ECDSA', hash: alg.hash };
    if (alg.kind === 'pss') return { name: 'RSA-PSS', saltLength: { 'SHA-256': 32, 'SHA-384': 48, 'SHA-512': 64 }[alg.hash] };
    if (alg.kind === 'pkcs1') return { name: 'RSASSA-PKCS1-v1_5' };
    if (alg.kind === 'ed25519') return { name: 'Ed25519' };
    throw new Error('unsupported algorithm');
  }

  /* COSE carries raw r||s already; a DER-wrapped signature is tolerated. */
  function normalizeSig(sig, alg) {
    if (!(sig instanceof Uint8Array)) throw new Error('signature is not a byte string');
    if (alg.kind !== 'ec') return sig;
    if (sig.length === alg.size * 2) return sig;
    if (sig[0] === 0x30) return X509.derEcdsaToRaw(sig, alg.size);
    return sig;
  }

  async function checkChain(certs, at, certDer) {
    const now = at instanceof Date ? at : new Date(at);
    const chain = {
      length: certs.length,
      certificates: certs.map((c) => ({
        subject: c.subject.text, issuer: c.issuer.text, cn: c.subject.cn, o: c.subject.o,
        notBefore: c.notBefore ? c.notBefore.toISOString() : null,
        notAfter: c.notAfter ? c.notAfter.toISOString() : null,
        selfSigned: c.selfSigned, isCA: c.isCA, keyUsage: c.keyUsage,
      })),
      linked: null, linkErrors: [], timeValid: null, expired: [], notYetValid: [], unreadableDates: [],
      anchored: false, anchoredBy: null, anchorNote: UNANCHORED_NOTE,
    };

    /* Anchoring, such as it is: a certificate on the chain whose DER this
     * build knows. With TRUST_ANCHORS empty this never fires, and the note
     * says so rather than leaving the reader to assume a root was checked. */
    if (TRUST_ANCHORS.size && subtle) {
      for (let i = 0; i < (certDer || []).length; i++) {
        const fp = await sha256Hex(certDer[i]);
        if (!TRUST_ANCHORS.has(fp)) continue;
        chain.anchored = true;
        chain.anchoredBy = (certs[i].subject && (certs[i].subject.cn || certs[i].subject.text)) || fp;
        chain.anchorNote = 'The chain reaches "' + chain.anchoredBy + '", a certificate on this build\'s trust list.';
        break;
      }
    }

    for (const c of certs) {
      const who = (c.subject && (c.subject.cn || c.subject.text)) || 'certificate';
      // A date this reader cannot read is an unanswered question, never a pass.
      if (!c.notBefore || !c.notAfter) { chain.unreadableDates.push(who); continue; }
      if (now > c.notAfter) chain.expired.push(who);
      else if (now < c.notBefore) chain.notYetValid.push(who);
    }
    chain.timeValid = (chain.expired.length === 0 && chain.notYetValid.length === 0 && chain.unreadableDates.length === 0)
      ? true
      : (chain.unreadableDates.length && !chain.expired.length && !chain.notYetValid.length ? null : false);

    if (certs.length < 2) {
      chain.linked = null;
      chain.linkErrors.push(certs.length === 1 && certs[0].selfSigned ? 'Single self-signed certificate; there is no chain to check.' : 'Only the leaf certificate was embedded, so the chain above it cannot be checked.');
      return chain;
    }

    let linked = true;
    for (let i = 0; i + 1 < certs.length; i++) {
      const child = certs[i];
      const parent = certs[i + 1];
      if (child.issuer.text !== parent.subject.text) {
        linked = false;
        chain.linkErrors.push('"' + (child.subject.cn || 'certificate ' + i) + '" names an issuer that is not the next certificate in the chain.');
        continue;
      }
      const spec = CERT_SIG_ALGS[child.sigAlgOid];
      if (!spec) { chain.linkErrors.push('Signature algorithm ' + child.sigAlgOid + ' on "' + (child.subject.cn || i) + '" is not supported by this reader.'); continue; }
      try {
        const curve = CURVES[parent.spkiCurveOid];
        const alg = spec.kind === 'ec' ? { kind: 'ec', hash: spec.hash, size: curve ? curve.size : 32 } : { kind: spec.kind, hash: spec.hash };
        const key = await importPublicKey(parent, alg);
        const sig = spec.der && spec.kind === 'ec' ? X509.derEcdsaToRaw(child.sigValue, alg.size) : child.sigValue;
        const ok = await subtle.verify(verifyParams(alg, parent), key, sig, child.tbsDer);
        if (!ok) { linked = false; chain.linkErrors.push('"' + (child.subject.cn || i) + '" was not signed by "' + (parent.subject.cn || 'its stated issuer') + '".'); }
      } catch (e) {
        chain.linkErrors.push('Could not check the link to "' + (parent.subject.cn || 'the issuer') + '": ' + e.message);
      }
    }
    chain.linked = chain.linkErrors.length ? (linked ? null : false) : linked;
    return chain;
  }

  /* The claim records a hash per assertion. Recomputing them is what stops a
   * swapped assertion from riding along under a valid signature.
   *
   * Producers differ over whether the hash covers the whole JUMBF box or only
   * its content, so both are tried. If neither convention matches anything,
   * the result is reported as inconclusive rather than as tampering: a false
   * accusation would be worse than an unanswered question.
   */
  async function checkAssertions(manifest, out) {
    const claim = manifest.claim || {};
    const refs = [].concat(claim.assertions || [], claim.created_assertions || [], claim.gathered_assertions || []).filter((x) => x && typeof x === 'object');
    const all = manifest.assertionBoxes || [];
    /* A claim that names no assertion covers none of the boxes travelling
     * with it, however many there are. Said out loud, because the assertion
     * clause below is counted per reference and would otherwise be silent. */
    out.unreferenced = !refs.length && all.length > 0;
    const boxes = new Map();
    const duplicates = [];
    /* C2PA requires an assertion label to be unique within a manifest. Two
     * boxes sharing one means the hash check settles on whichever this map
     * keeps while the reader downstream tags both with that label and reads
     * both — so content no hash covers is reported as hash-verified. There is
     * no safe way to pick; the manifest is reported as broken instead. */
    for (const box of all) {
      if (boxes.has(box.label)) duplicates.push(box.label);
      boxes.set(box.label, box);
    }
    out.duplicateLabels = [...new Set(duplicates)];

    const rows = [];
    for (const ref of refs) {
      const label = String(ref.url || '').split('/').pop();
      const expected = ref.hash;
      /* Count it first. C2PA requires a hash on every assertion reference,
       * so one that carries none — or carries it as text — is a reference
       * this reader cannot check, not one it may quietly ignore. Skipping it
       * before the count left checked at 0, which made the whole assertion
       * clause disappear from the summary and let a claim pass on its
       * signature alone with none of its assertions verified. */
      out.checked++;
      if (!(expected instanceof Uint8Array)) {
        out.inconclusive = true;
        out.unhashed.push(label);
        continue;
      }
      const box = boxes.get(label) || boxes.get(label.replace(/\.v\d+$/, ''));
      if (!box) { out.missing.push(label); continue; }
      const hashName = HASH_BY_NAME[String(ref.alg || claim.alg || 'sha256').toLowerCase()] || 'SHA-256';
      let asBox = null;
      let asContent = null;
      try {
        asBox = equalBytes(new Uint8Array(await subtle.digest(hashName, box.raw)), expected);
        // The bare payload, without the inner box's own 8-byte header: the
        // other convention producers use.
        asContent = box.content ? equalBytes(new Uint8Array(await subtle.digest(hashName, box.content)), expected) : false;
      } catch (e) {
        out.missing.push(label);
        continue;
      }
      rows.push({ label, box, asBox, asContent });
    }

    const boxWins = rows.filter((r) => r.asBox).length;
    const contentWins = rows.filter((r) => r.asContent).length;
    if (!rows.length) {
      /* The claim named assertions and not one of them could be hashed. That
       * is an unanswered question, never a pass. */
      if (out.checked && !out.missing.length) {
        out.inconclusive = true;
        out.note = 'The claim names assertions but records no hash this reader can use for any of them, so none of them could be checked.';
      }
      return;
    }
    if (boxWins === 0 && contentWins === 0) {
      out.inconclusive = true;
      out.note = 'None of the recorded assertion hashes matched either hashing convention, so this reader cannot confirm or deny that the assertions are intact.';
      return;
    }
    const useBox = boxWins >= contentWins;
    out.convention = useBox ? 'whole JUMBF box' : 'box content';
    for (const r of rows) {
      if (useBox ? r.asBox : r.asContent) { out.matched++; out.trustedLabels.push(r.label); }
      else out.mismatched.push(r.label);
    }
  }

  async function sha256Hex(bytes) {
    const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
    let hex = '';
    for (const b of d) hex += b.toString(16).padStart(2, '0');
    return hex;
  }

  function equalBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
  }

  // A signed exclusion list is not permission to omit image content. Only
  // complete C2PA PNG chunks may be excluded by this reader. Other formats
  // need their own validated metadata layout before a data hash can pass.
  function safePngExclusions(bytes, ranges) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((byte, i) => bytes[i] === byte)) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const credentials = new Map();
    let offset = 8;
    let first = true;
    let imageData = false;
    let ended = false;
    while (offset <= bytes.length - 12) {
      const length = view.getUint32(offset);
      if (length > bytes.length - offset - 12) return false;
      const end = offset + length + 12;
      const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
      if (!/^[A-Za-z]{4}$/.test(type)) return false;
      if (first && (type !== 'IHDR' || length !== 13)) return false;
      if (!first && type === 'IHDR') return false;
      first = false;
      if (type === 'caBX') credentials.set(offset, end);
      if (type === 'IDAT') imageData = true;
      offset = end;
      if (type === 'IEND') {
        if (length !== 0 || offset !== bytes.length) return false;
        ended = true;
        break;
      }
    }
    if (!ended || !imageData) return false;
    for (const range of ranges) {
      if (range.length === 0) continue;
      let cursor = range.start;
      const end = cursor + range.length;
      while (cursor < end) {
        const next = credentials.get(cursor);
        if (next === undefined || next > end) return false;
        cursor = next;
      }
    }
    return true;
  }

  // Format-specific BMFF/box bindings remain explicitly unchecked instead
  // of guessing at their canonicalization or trusting arbitrary exclusions.
  async function checkAssetBinding(manifest, verification, opts) {
    const unchecked = (note) => ({ status: 'unchecked', note: 'Asset binding unchecked: ' + note });
    if (opts.truncated || !(opts.assetBytes instanceof Uint8Array)) return unchecked('the complete asset bytes were not available.');
    if (verification.signature !== 'valid' || !verification.assertions || verification.assertions.inconclusive) return unchecked('the signature and assertion hashes were not verified.');
    const trusted = new Set(verification.assertions.trustedLabels);
    const bindings = (manifest.assertionBoxes || []).filter((box) => trusted.has(box.label) && /^c2pa\.hash\./.test(box.label));
    if (bindings.length !== 1 || !/^c2pa\.hash\.data(?:\.v[12])?$/.test(bindings[0].label)) return unchecked('no single supported c2pa.hash.data binding was found.');
    const binding = bindings[0].value;
    const hashName = binding && HASH_BY_NAME[String(binding.alg || (manifest.claim && manifest.claim.alg) || 'sha256').toLowerCase()];
    if (!binding || !hashName || !(binding.hash instanceof Uint8Array) || !Array.isArray(binding.exclusions) || binding.exclusions.length > 512) return unchecked('the hard-binding parameters are unsupported.');
    const bytes = opts.assetBytes;
    const ranges = binding.exclusions.map((range) => ({ start: range && range.start, length: range && range.length })).sort((a, b) => a.start - b.start);
    let cursor = 0;
    let total = bytes.length;
    for (const range of ranges) {
      if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.length) || range.start < cursor || range.length < 0 || range.start > bytes.length || range.length > bytes.length - range.start) return unchecked('the exclusion ranges are invalid or overlap.');
      cursor = range.start + range.length;
      total -= range.length;
    }
    if (!total) return unchecked('the binding excludes the entire asset.');
    if (!safePngExclusions(bytes, ranges)) return unchecked('exclusions are not validated complete C2PA-only PNG chunks; this format or layout is unsupported.');
    const included = new Uint8Array(total);
    let offset = 0;
    cursor = 0;
    for (const range of ranges) {
      const part = bytes.subarray(cursor, range.start);
      included.set(part, offset); offset += part.length;
      cursor = range.start + range.length;
    }
    included.set(bytes.subarray(cursor), offset);
    const matches = equalBytes(new Uint8Array(await subtle.digest(hashName, included)), binding.hash);
    return { status: matches ? 'verified' : 'mismatch', note: matches ? 'Asset bytes match the authenticated data hash.' : 'Asset bytes do not match the authenticated data hash; these credentials belong to different or altered media.' };
  }

  /* A short, honest reading of the result for the interface.
   *
   * Three outcomes, deliberately distinct:
   *   ok       — signature verified, the assertions hash as the claim says,
   *              and the claim's hard binding matches this file's bytes
   *   broken   — something verifiably does not add up
   *   caution  — the signature is good but something could not be reconciled:
   *              the assertion hashes, or the hard binding. Both are worth
   *              saying out loud; neither is worth calling fraud.
   *
   * A pass requires all four answers. A manifest that verifies perfectly but
   * is not bound to these bytes is not this file's manifest.
   */
  function summarize(v) {
    if (!v) return null;
    const a = v.assertions;
    const b = v.binding || null;
    const parts = [];
    if (v.signature === 'valid') parts.push('Signature valid (' + v.algorithm + ')');
    else if (v.signature === 'invalid') parts.push(v.payloadMismatch ? 'Signature covers different content than this claim' : 'Signature did NOT verify');
    else if (v.signature === 'absent') parts.push('No signature present');
    else parts.push('Signature not checked');
    const unhashed = (a && a.unhashed) ? a.unhashed.length : 0;
    if (a && a.duplicateLabels && a.duplicateLabels.length) parts.push(a.duplicateLabels.length + ' assertion label(s) appear twice, so one box is hashed and another of the same name is not');
    if (a && a.unreferenced) parts.push('the claim names no assertions, so nothing in this manifest is covered by its signature');
    if (a && a.checked) {
      if (a.mismatched.length) parts.push(a.mismatched.length + ' assertion(s) do not match the signed claim');
      else if (a.inconclusive && !unhashed) parts.push('assertion hashes did not match any convention this reader knows');
      else if (a.missing.length) parts.push(a.matched + '/' + a.checked + ' assertions verified, ' + a.missing.length + (a.truncated ? ' beyond the bytes fetched' : ' named by the claim but not present'));
      else if (a.matched) parts.push(a.matched === a.checked ? 'all ' + a.matched + ' assertions match the signed claim' : a.matched + '/' + a.checked + ' assertions match the signed claim');
      /* Said alongside whatever else was found, not instead of it. */
      if (unhashed) parts.push(unhashed + ' assertion(s) record no hash this reader can use, so they were not checked');
    }
    if (b) {
      /* A binding that hashed a sliver of the file is not the same claim as
       * one that hashed the file, and the difference belongs in the line the
       * reader sees rather than only in the collapsed detail. */
      if (b.status === 'valid') parts.push(b.assetLength && b.hashed != null
        ? 'bound to this file\'s bytes (' + b.hashed + ' of ' + b.assetLength + ' hashed)'
        : 'bound to this file\'s bytes');
      else if (b.status === 'mismatch') parts.push('does NOT match this file\'s bytes');
      else if (b.status === 'absent') parts.push('no hard binding to any file');
      else if (b.status === 'unsupported') parts.push('hard binding (' + b.kind + ') not checkable by this reader');
      else parts.push('hard binding not checked');
    }
    if (v.chain) {
      if (v.chain.linked === true) parts.push('chain internally consistent');
      else if (v.chain.linked === false) parts.push('chain is broken');
      if (v.chain.timeValid === false) parts.push(v.chain.expired.length ? 'certificate expired' : 'certificate not yet valid');
      else if (v.chain.timeValid === null) parts.push('certificate validity dates could not be read');
      parts.push('root not anchored to a trust list');
    }
    const binding = v.assetBinding;
    parts.push(binding ? binding.note : 'Asset binding unchecked');
    const mismatched = !!(a && a.mismatched.length);
    /* Two boxes under one label is a fact about the manifest, not a puzzle:
     * whichever hashed, the other rides along unhashed under the same name. */
    const duplicated = !!(a && a.duplicateLabels && a.duplicateLabels.length);
    const unreferenced = !!(a && a.unreferenced);
    const inconclusive = !!(a && a.checked && a.inconclusive);
    /* An assertion the signed claim names but that is not here is only
     * incomplete evidence when the fetch was capped; otherwise something was
     * removed after signing, and the claim cannot be taken at face value. */
    const missing = !!(a && a.missing.length);
    const broken = v.signature === 'invalid' || mismatched || (v.chain && v.chain.linked === false) || (missing && !a.truncated) || (binding && binding.status === 'mismatch');
    const caution = !broken && v.signature === 'valid' && (inconclusive || (missing && a.truncated));
    return {
      /* Nothing passes without all four answers, the binding included. */
      ok: v.signature === 'valid' && !!b && b.status === 'valid' && !broken && !caution,
      broken,
      caution,
      /* Whether any certificate on the chain is a signer this build knows.
       * Separate from `ok`, because an intact manifest under an unknown
       * certificate is exactly the shape a forgery takes. */
      anchored: !!(v.chain && v.chain.anchored),
      duplicated,
      unreferenced,
      payloadMismatch: !!v.payloadMismatch,
      assetVerified: !!(binding && binding.status === 'verified'),
      text: parts.join(' · '),
    };
  }

  return { verifyManifest, summarize, COSE_ALGS, CERT_SIG_ALGS, CURVES, _internal: { collectChain, checkChain, equalBytes, checkAssetBinding } };
});
