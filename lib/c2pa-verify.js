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
 *      internal consistency (each certificate signed by the next) and for
 *      validity dates. Whether the root is trustworthy needs a trust list,
 *      which this extension does not ship, so the result says "not anchored"
 *      rather than pretending otherwise.
 *
 *   4. Does the manifest describe THIS file?  The claim must carry a hard
 *      binding — a digest over the asset's own bytes with the credential
 *      store excluded — and that digest is recomputed here. Without this a
 *      genuine, fully verifying manifest can be lifted out of a real
 *      photograph and dropped into a generated image: every other answer
 *      stays "yes" while the credentials describe a different file.
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
      assertions: { checked: 0, matched: 0, mismatched: [], missing: [], inconclusive: false, truncated: false, convention: null, note: null, trustedLabels: [] },
      chain: null,
      binding: { status: 'unchecked', kind: null, reason: 'The hard binding was not reached.' },
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
    for (let i = 0; i < chainDer.length; i++) {
      try { certs.push(X509.parseCertificate(chainDer[i])); }
      catch (e) { out.notes.push('Certificate ' + (i + 1) + ' of ' + chainDer.length + ' could not be parsed: ' + e.message); }
    }
    if (certs.length) {
      out.signedBy = { cn: certs[0].subject.cn, o: certs[0].subject.o, subject: certs[0].subject.text, issuer: certs[0].issuer.text };
      out.chain = await checkChain(certs, opts.at || new Date());
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

    /* 4. The hard binding: does any of this describe the file it arrived in? */
    out.binding = await checkHardBinding(manifest, out, opts);

    return out;
  }

  /* ---- hard binding ------------------------------------------------------
   *
   * A C2PA claim is only about an asset because it carries a hard-binding
   * assertion: a digest over the asset's bytes with the credential store
   * itself excluded. Recomputing it is the only check that stops a genuine
   * manifest being transplanted onto someone else's picture.
   *
   * Outcomes:
   *   valid       — the digest matches these bytes
   *   mismatch    — it does not; the manifest belongs to a different file
   *   absent      — the claim carries no hard binding at all, which makes it
   *                 an invalid claim rather than an unverified one
   *   unsupported — a binding form this reader cannot recompute (BMFF Merkle
   *                 trees, box hashes)
   *   unchecked   — it could not be recomputed here: the fetch was capped,
   *                 the digest algorithm is unknown, or the exclusion ranges
   *                 do not fit the file or reach outside the credential store
   *
   * Only 'valid' may lead to a pass. Everything else fails closed.
   */
  const HARD_BINDING_RE = /^c2pa\.hash\./;
  const DATA_HASH_RE = /^c2pa\.hash\.data(?:\.|$)/;

  function baseLabel(label) { return String(label || '').replace(/\.v\d+$/, ''); }

  function referencedLabels(claim) {
    if (!claim || typeof claim !== 'object') return null;
    const refs = [].concat(claim.assertions || [], claim.created_assertions || [], claim.gathered_assertions || [])
      .filter((x) => x && typeof x === 'object' && x.url)
      .map((x) => baseLabel(String(x.url).split('/').pop()));
    return refs.length ? new Set(refs) : null;
  }

  async function checkHardBinding(manifest, out, opts) {
    const boxes = (manifest && manifest.assertionBoxes) || [];
    /* Which assertions may speak: the hash-verified ones once verification
     * reached a conclusion, otherwise the ones the claim at least names. A
     * binding assertion nobody referenced binds nothing — anyone can add one. */
    const verified = out.assertions && out.assertions.trustedLabels && out.assertions.trustedLabels.length
      ? new Set(out.assertions.trustedLabels.map(baseLabel))
      : null;
    const allowed = verified || referencedLabels(manifest && manifest.claim);
    const candidates = boxes.filter((b) => HARD_BINDING_RE.test(b.label || '') && (!allowed || allowed.has(baseLabel(b.label))));
    if (!candidates.length) {
      // A capped fetch may simply not have reached it; that is an unanswered
      // question, not a finding.
      if (opts.truncated) return { status: 'unchecked', kind: null, reason: 'No hard binding was found, but only the first part of the file was fetched, so it may lie beyond the bytes inspected.' };
      return { status: 'absent', kind: null, reason: 'This claim carries no hard binding, so nothing ties it to the bytes of the file it travels in. A C2PA claim without one is invalid; the same manifest would verify just as well inside any other file.' };
    }
    const box = candidates.find((b) => DATA_HASH_RE.test(b.label)) || candidates[0];
    if (!DATA_HASH_RE.test(box.label)) {
      return { status: 'unsupported', kind: box.label, reason: 'The hard binding is a "' + box.label + '" assertion, which this reader cannot recompute, so the manifest is not confirmed to describe this file.' };
    }
    try {
      const content = box.contentType === 'json'
        ? JSON.parse(new TextDecoder('utf-8', { fatal: false }).decode(box.content))
        : CBOR.decodeValue(box.content);
      if (!content || typeof content !== 'object') return unchecked(box, 'The hard-binding assertion could not be read.');

      const asset = opts.asset instanceof Uint8Array ? opts.asset : null;
      if (!asset || !asset.length) return unchecked(box, 'The file\'s own bytes were not available here, so the hard binding could not be recomputed.');
      if (opts.truncated) return unchecked(box, 'Only the first part of the file was fetched, so the digest the claim records over the whole file could not be recomputed.');

      const algName = String(content.alg || (manifest.claim && manifest.claim.alg) || 'sha256').toLowerCase();
      const hashName = HASH_BY_NAME[algName];
      if (!hashName) return unchecked(box, 'The hard binding uses hash algorithm "' + algName + '", which this reader does not implement.');

      const expected = content.hash;
      if (!(expected instanceof Uint8Array) || !expected.length) return unchecked(box, 'The hard-binding assertion records no digest.');

      const ranges = normalizeExclusions(content.exclusions, asset.length);
      if (!ranges) return unchecked(box, 'The hard binding declares exclusion ranges that do not fit this file, so it could not be recomputed.');
      const store = mergeRanges((opts.assetRanges || []).filter((r) => r && r.end > r.start));
      if (!store.length) return unchecked(box, 'Where the credentials sit in this file is not known here, so an exclusion range could not be checked for reaching beyond them.');
      /* A binding with nothing excluded describes a file that does not carry
       * the manifest — a sidecar. It cannot be about this embedded copy, and
       * saying "does not match" would read as an accusation it has not earned. */
      if (!ranges.length) return unchecked(box, 'The hard binding excludes nothing, so it describes a copy of the file without these credentials in it, not the file inspected here.');
      if (!ranges.every((r) => store.some((s) => r.start >= s.start && r.end <= s.end))) {
        return unchecked(box, 'The hard binding excludes bytes outside the credential store itself. Recomputing it would say nothing about the rest of the file, so it is not treated as a binding.');
      }
      const kept = joinExcluding(asset, ranges);
      if (!kept.length) return unchecked(box, 'The hard binding leaves no bytes of the file to hash.');
      const digest = new Uint8Array(await subtle.digest(hashName, kept));
      if (equalBytes(digest, expected)) {
        return { status: 'valid', kind: box.label, hashed: kept.length, reason: 'The digest the claim records over the file matches these bytes (' + kept.length + ' of ' + asset.length + ' hashed, the credential store excluded).' };
      }
      return { status: 'mismatch', kind: box.label, hashed: kept.length, reason: 'The digest the claim records over the file does not match this file\'s bytes. These credentials describe different content: either the file was altered after signing, or the manifest was taken from another file and put here.' };
    } catch (e) {
      return unchecked(box, 'The hard binding could not be recomputed: ' + (e && e.message ? e.message : String(e)));
    }
  }

  function unchecked(box, reason) {
    return { status: 'unchecked', kind: box ? box.label : null, reason };
  }

  /* Exclusion ranges as the assertion declares them: whole, in range, and not
   * overlapping. Anything else is refused rather than guessed at. */
  function normalizeExclusions(list, size) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const e of list) {
      if (!e || typeof e !== 'object') return null;
      const start = e.start;
      const length = e.length;
      if (!Number.isInteger(start) || !Number.isInteger(length)) return null;
      if (start < 0 || length <= 0 || start + length > size) return null;
      out.push({ start, end: start + length });
    }
    out.sort((a, b) => a.start - b.start);
    for (let i = 1; i < out.length; i++) if (out[i].start < out[i - 1].end) return null;
    return out;
  }

  /* Ranges that touch or abut become one: a JPEG store is written as a run of
   * consecutive APP11 segments, and producers exclude the run, not each part. */
  function mergeRanges(list) {
    const sorted = list.map((r) => ({ start: r.start, end: r.end })).sort((a, b) => a.start - b.start);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else out.push(r);
    }
    return out;
  }

  function joinExcluding(bytes, ranges) {
    let kept = bytes.length;
    for (const r of ranges) kept -= (r.end - r.start);
    const out = new Uint8Array(Math.max(0, kept));
    let o = 0;
    let p = 0;
    for (const r of ranges) {
      if (r.start > p) { out.set(bytes.subarray(p, r.start), o); o += r.start - p; }
      p = r.end;
    }
    if (p < bytes.length) out.set(bytes.subarray(p), o);
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

  async function checkChain(certs, at) {
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
      anchored: false, anchorNote: 'This build ships no C2PA trust list, so the root of the chain is not checked against known signers. A valid signature therefore shows the manifest is intact, not that the signer is who the name suggests.',
    };

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
    const boxes = new Map();
    for (const box of manifest.assertionBoxes || []) boxes.set(box.label, box);

    const rows = [];
    for (const ref of refs) {
      const label = String(ref.url || '').split('/').pop();
      const expected = ref.hash;
      if (!(expected instanceof Uint8Array)) continue;
      out.checked++;
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
    if (!rows.length) return;
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

  function equalBytes(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
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
    if (a && a.checked) {
      if (a.inconclusive) parts.push('assertion hashes did not match any convention this reader knows');
      else if (a.mismatched.length) parts.push(a.mismatched.length + ' assertion(s) do not match the signed claim');
      else if (a.missing.length) parts.push(a.matched + '/' + a.checked + ' assertions verified, ' + a.missing.length + (a.truncated ? ' beyond the bytes fetched' : ' named by the claim but not present'));
      else parts.push('all ' + a.matched + ' assertions match the signed claim');
    }
    if (b) {
      if (b.status === 'valid') parts.push('bound to this file\'s bytes');
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
    const mismatched = !!(a && a.mismatched.length);
    const inconclusive = !!(a && a.checked && a.inconclusive);
    /* An assertion the signed claim names but that is not here is only
     * incomplete evidence when the fetch was capped; otherwise something was
     * removed after signing, and the claim cannot be taken at face value. */
    const missing = !!(a && a.missing.length);
    /* A digest over the asset that does not match the asset is a fact, signed
     * or not. A validly signed claim with no hard binding at all is invalid
     * by the same rule: it describes no particular file. */
    const bindingMismatch = !!(b && b.status === 'mismatch');
    const bindingAbsent = !!(b && b.status === 'absent');
    const bindingUnchecked = !!(b && (b.status === 'unchecked' || b.status === 'unsupported'));
    const broken = v.signature === 'invalid' || mismatched || (v.chain && v.chain.linked === false) || (missing && !a.truncated)
      || bindingMismatch || (v.signature === 'valid' && bindingAbsent);
    const caution = !broken && v.signature === 'valid' && (inconclusive || (missing && a.truncated) || bindingUnchecked);
    return {
      /* Nothing passes without all four answers, the binding included. */
      ok: v.signature === 'valid' && !!b && b.status === 'valid' && !broken && !caution,
      broken,
      caution,
      payloadMismatch: !!v.payloadMismatch,
      bindingMismatch,
      bindingAbsent,
      binding: b ? b.status : null,
      bindingNote: b ? b.reason : null,
      text: parts.join(' · '),
    };
  }

  return { verifyManifest, summarize, COSE_ALGS, CERT_SIG_ALGS, CURVES, _internal: { collectChain, checkChain, equalBytes, checkHardBinding, normalizeExclusions, mergeRanges, joinExcluding } };
});
