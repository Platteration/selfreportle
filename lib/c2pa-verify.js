/*
 * lib/c2pa-verify.js — cryptographic checks on a C2PA manifest.
 *
 * Three separate questions, reported separately because they mean different
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
   */
  async function verifyManifest(manifest, opts = {}) {
    const out = {
      signature: 'unknown', algorithm: null, signedBy: null,
      assertions: { checked: 0, matched: 0, mismatched: [], missing: [], inconclusive: false, truncated: false, convention: null, note: null, trustedLabels: [] },
      chain: null,
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
   *   ok       — signature verified and the assertions hash as the claim says
   *   broken   — something verifiably does not add up
   *   caution  — the signature is good but the assertions could not be
   *              reconciled. Because a valid signature makes the recorded
   *              hashes authentic, this is either a swapped assertion or a
   *              hashing convention this reader does not know. Both are worth
   *              saying out loud; neither is worth calling fraud.
   */
  function summarize(v) {
    if (!v) return null;
    const a = v.assertions;
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
    const broken = v.signature === 'invalid' || mismatched || (v.chain && v.chain.linked === false) || (missing && !a.truncated);
    const caution = !broken && v.signature === 'valid' && (inconclusive || (missing && a.truncated));
    return {
      ok: v.signature === 'valid' && !broken && !caution,
      broken,
      caution,
      payloadMismatch: !!v.payloadMismatch,
      text: parts.join(' · '),
    };
  }

  return { verifyManifest, summarize, COSE_ALGS, CERT_SIG_ALGS, CURVES, _internal: { collectChain, checkChain, equalBytes } };
});
