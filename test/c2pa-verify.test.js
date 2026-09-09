const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers.js');
const M = require('../lib/image-metadata.js');
const X = require('../lib/x509.js');
const CV = require('../lib/c2pa-verify.js');
const CBOR = require('../lib/cbor.js');
const V = require('../lib/verdicts.js');

const DST = 'http://cv.iptc.org/newscodes/digitalsourcetype/';
const AI_ACTION = [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia' }];

/* A whole JPEG whose manifest is bound to its own bytes, so the four checks
 * all have something real to answer. `opts` breaks exactly one thing. */
async function analyse(opts = {}) {
  const { hints, ...rest } = opts;
  const { bytes } = await H.signedC2paAsset({ container: 'jpeg', segment: 400, actions: AI_ACTION, ...rest });
  const r = await M.analyzeImageBytes(bytes, hints || {});
  return { r, v: r.metadata.c2pa.verification, ids: r.signals.map((s) => s.id) };
}

test('a genuine signature verifies, with its assertions, chain and hard binding', async () => {
  const { v, ids } = await analyse({ chain: 'full' });
  assert.equal(v.signature, 'valid');
  assert.equal(v.algorithm, 'ES256');
  assert.equal(v.signedBy.cn, 'Test Signer');
  assert.equal(v.assertions.matched, 2, 'the actions assertion and the hard binding');
  assert.deepEqual(v.assertions.mismatched, []);
  assert.equal(v.chain.linked, true);
  assert.equal(v.chain.timeValid, true);
  assert.equal(v.binding.status, 'valid');
  assert.equal(v.summary.ok, true);
  assert.ok(ids.includes('c2pa-verified'));
  assert.ok(ids.includes('c2pa-ai-created'), 'the claim is still read');
});

test('the root is never reported as anchored, because no trust list ships', async () => {
  const { v } = await analyse({ chain: 'full' });
  assert.equal(v.chain.anchored, false);
  assert.match(v.chain.anchorNote, /not checked against known signers/);
  assert.match(CV.summarize(v).text, /root not anchored/);
});

test('a tampered signature is reported as broken', async () => {
  const { v, ids } = await analyse({ tamper: 'signature' });
  assert.equal(v.signature, 'invalid');
  assert.equal(CV.summarize(v).broken, true);
  assert.ok(ids.includes('c2pa-broken'));
  assert.ok(!ids.includes('c2pa-verified'));
});

test('an assertion swapped after signing is not silently accepted', async () => {
  const { v, ids } = await analyse({ tamper: 'assertion' });
  assert.equal(v.signature, 'valid', 'the claim itself is untouched');
  // The hard binding still hashes as the claim recorded it, which settles the
  // convention, so the swapped assertion is a mismatch and not a puzzle.
  assert.deepEqual(v.assertions.mismatched, ['c2pa.actions.v2']);
  const s = CV.summarize(v);
  assert.equal(s.ok, false);
  assert.equal(s.broken, true);
  assert.ok(ids.includes('c2pa-broken'));
  assert.ok(!ids.includes('c2pa-verified'));
});

test('assertion hashes in a convention this reader does not know are inconclusive, not fraud', async () => {
  const { v, ids } = await analyse({ tamper: 'hashes' });
  assert.equal(v.signature, 'valid');
  assert.equal(v.assertions.inconclusive, true);
  assert.equal(v.binding.status, 'valid', 'the binding itself still recomputes');
  const s = CV.summarize(v);
  assert.equal(s.ok, false);
  assert.equal(s.broken, false, 'an unknown convention is not an accusation');
  assert.equal(s.caution, true);
  assert.ok(ids.includes('c2pa-caution'));
});

test('a chain whose leaf was signed by an unrelated key is reported broken', async () => {
  const { v, ids } = await analyse({ chain: 'broken' });
  assert.equal(v.signature, 'valid', 'the COSE signature is still the leaf key');
  assert.equal(v.chain.linked, false);
  assert.ok(v.chain.linkErrors.some((e) => /was not signed by/.test(e)));
  assert.ok(ids.includes('c2pa-broken'));
});

test('expired certificates are reported without failing the signature', async () => {
  const past = new Date(Date.now() - 86400000 * 10);
  const alsoPast = new Date(Date.now() - 86400000 * 5);
  const { v } = await analyse({ notBefore: past, notAfter: alsoPast });
  assert.equal(v.signature, 'valid');
  assert.equal(v.chain.timeValid, false);
  assert.deepEqual(v.chain.expired, ['Test Signer']);
  assert.match(CV.summarize(v).text, /certificate expired/);
});

test('a manifest with no signature says so rather than passing', async () => {
  const manifest = H.c2paManifest({ generator: 'Anon', actions: AI_ACTION });
  const r = await M.analyzeImageBytes(H.jpeg([H.app11Jumbf(manifest, 400)]));
  const v = r.metadata.c2pa.verification;
  assert.equal(v.signature, 'absent');
  assert.equal(CV.summarize(v).ok, false);
  assert.ok(r.signals.map((s) => s.id).includes('c2pa-unverified'));
});

test('raw verification inputs never leave the metadata module', async () => {
  const { r } = await analyse({});
  const json = JSON.stringify(r.metadata);
  assert.ok(!('claimRaw' in r.metadata.c2pa), 'claim bytes are not exported');
  assert.ok(!('assertionBoxes' in r.metadata.c2pa), 'assertion bytes are not exported');
  assert.ok(!('cose' in r.metadata.c2pa), 'COSE structure is not exported');
  assert.ok(json.length < 20000, 'exported metadata stays small (' + json.length + ' bytes)');
});

test('x509 reads names, validity, key usage and self-signing', async () => {
  const keys = await H.makeKeyPair();
  const name = { '2.5.4.3': 'Root CA', '2.5.4.10': 'Example Org' };
  const der = await H.makeCertificate({
    subject: name, issuer: name, subjectPublicKey: keys.publicKey, issuerPrivateKey: keys.privateKey,
    notBefore: new Date('2026-01-01T00:00:00Z'), notAfter: new Date('2027-01-01T00:00:00Z'), isCA: true,
  });
  const cert = X.parseCertificate(der);
  assert.equal(cert.subject.cn, 'Root CA');
  assert.equal(cert.subject.o, 'Example Org');
  assert.equal(cert.selfSigned, true);
  assert.equal(cert.isCA, true);
  assert.deepEqual(cert.keyUsage, ['keyCertSign']);
  assert.equal(cert.notBefore.toISOString(), '2026-01-01T00:00:00.000Z');
  assert.equal(cert.sigAlgOid, '1.2.840.10045.4.3.2');
});

test('DER ECDSA signatures convert to the raw form WebCrypto expects', () => {
  const der = Uint8Array.from([0x30, 0x08, 0x02, 0x02, 0x00, 0x7f, 0x02, 0x02, 0x00, 0x01]);
  const raw = X.derEcdsaToRaw(der, 4);
  assert.deepEqual([...raw], [0, 0, 0, 0x7f, 0, 0, 0, 1]);
});

test('malformed certificates are rejected rather than trusted', () => {
  assert.throws(() => X.parseCertificate(new Uint8Array([0x30, 0x02, 0x00, 0x00])));
  assert.throws(() => X.parseCertificate(new Uint8Array(0)));
});

/*
 * Attacks on the verification itself. Each keeps a genuine signature and
 * changes exactly one thing around it, which is what a real forger would do:
 * signing keys are the hard part, so everything else is the soft target.
 */

test('a signature replayed over a different claim is rejected, not shown as verified', async () => {
  // Honest baseline: an inline payload that does match the stored claim.
  const honest = await H.signedC2paManifest({ actions: AI_ACTION, inlinePayload: true });
  const okr = await M.analyzeImageBytes(H.png([H.pngChunk('caBX', honest)]));
  assert.equal(okr.metadata.c2pa.verification.signature, 'valid', 'an honest inline payload still verifies');

  // The attack: keep the genuine signature and its payload, swap the claim.
  const forged = await H.signedC2paManifest({
    actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' }],
    cn: 'Honest Camera Co',
    forgedClaim: { 'dc:title': 'photo', claim_generator: 'Totally Real Camera', alg: 'sha256', assertions: [] },
  });
  const r = await M.analyzeImageBytes(H.png([H.pngChunk('caBX', forged)]));
  const v = r.metadata.c2pa.verification;
  assert.equal(v.signature, 'invalid', 'a signature over other content must not read as valid');
  assert.equal(v.payloadMismatch, true);
  assert.equal(v.summary.ok, false);
  assert.equal(v.summary.broken, true);
  assert.match(v.notes.join(' '), /not the claim stored in this manifest/);
  // And the forged claim must not survive to the verdict.
  assert.equal(V.combineImageSignals(r.signals).verdict, 'suspected');
});

test('a broken manifest stops speaking: no claim survives it', async () => {
  const manifest = await H.signedC2paManifest({ actions: AI_ACTION, tamper: 'signature' });
  const r = await M.analyzeImageBytes(H.png([H.pngChunk('caBX', manifest)]));
  const ids = r.signals.map((s) => s.id);
  assert.ok(ids.includes('c2pa-broken'));
  assert.ok(!ids.some((id) => /^c2pa-(ai-created|ai-edited|capture|human|algo|ai-generator|verified)$/.test(id)), 'claims suppressed, saw ' + ids.join(','));
  // And the finding must actually reach the verdict rather than being dropped.
  assert.equal(V.combineImageSignals(r.signals).verdict, 'suspected');
});

test('a benign claim cannot outrank broken credentials', async () => {
  const CAPTURE = [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' }];
  const manifest = await H.signedC2paManifest({ actions: CAPTURE, tamper: 'signature' });
  const r = await M.analyzeImageBytes(H.png([H.pngChunk('caBX', manifest)]));
  assert.notEqual(V.combineImageSignals(r.signals).verdict, 'captured', 'a broken manifest must not yield a green verdict');
  assert.equal(V.combineImageSignals(r.signals).verdict, 'suspected');
});

test('an assertion the signed claim never referenced does not speak for the asset', async () => {
  const { bytes } = await H.signedC2paAsset({
    actions: AI_ACTION,
    injectAssertion: ['c2pa.actions.injected', { actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' }] }],
  });
  const r = await M.analyzeImageBytes(bytes);
  const ids = r.signals.map((s) => s.id);
  assert.ok(ids.includes('c2pa-ai-created'), 'the signed claim is still read');
  assert.ok(!ids.includes('c2pa-capture'), 'the injected capture claim is ignored');
  assert.equal(V.combineImageSignals(r.signals).verdict, 'ai-generated');
});

test('an assertion removed after signing is reported, not passed over', async () => {
  const manifest = await H.signedC2paManifest({ actions: AI_ACTION, dropAssertion: true });
  const r = await M.analyzeImageBytes(H.png([H.pngChunk('caBX', manifest)]));
  const v = r.metadata.c2pa.verification;
  assert.equal(v.signature, 'valid', 'the claim itself is intact');
  assert.deepEqual(v.assertions.missing, ['c2pa.actions.v2']);
  assert.equal(v.summary.ok, false, 'a claim whose assertions are gone is not "verified"');
  assert.equal(v.summary.broken, true);
});

test('a byte-capped fetch is incomplete evidence, not tampering', async () => {
  const manifest = await H.signedC2paManifest({ actions: AI_ACTION, dropAssertion: true });
  const r = await M.analyzeImageBytes(H.png([H.pngChunk('caBX', manifest)]), { truncated: true });
  const v = r.metadata.c2pa.verification;
  assert.equal(v.assertions.truncated, true);
  assert.equal(v.summary.broken, false, 'a capped fetch must not be called tampering');
  assert.equal(v.summary.caution, true);
  assert.match(v.summary.text, /beyond the bytes fetched/);
});

test('one unreadable certificate in the chain does not stop the leaf being checked', async () => {
  const manifest = await H.signedC2paManifest({ actions: AI_ACTION, chain: 'full' });
  const bytes = H.png([H.pngChunk('caBX', corruptSecondCertificate(manifest))]);
  const r = await M.analyzeImageBytes(bytes);
  const v = r.metadata.c2pa.verification;
  assert.equal(v.signature, 'valid', 'the leaf signature is still verified');
  assert.ok(v.notes.some((n) => /could not be parsed/.test(n)), 'and the unreadable certificate is reported');
});

test('certificate validity dates that cannot be read are not treated as valid', async () => {
  const CV2 = require('../lib/c2pa-verify.js');
  const chain = await CV2._internal.checkChain([{
    subject: { text: 'CN=X', cn: 'X' }, issuer: { text: 'CN=X' }, notBefore: null, notAfter: null,
    selfSigned: true, isCA: true, keyUsage: null, spkiCurveOid: null,
  }], new Date());
  assert.notEqual(chain.timeValid, true, 'unreadable dates must not read as valid');
});




/* Flips a byte inside the second certificate of the x5chain. */
function corruptSecondCertificate(manifest) {
  const out = manifest.slice();
  // The two DER certificates start with 0x30 0x82; corrupt the second one's
  // header so it cannot be parsed while leaving the first intact.
  let seen = 0;
  for (let i = 0; i < out.length - 1; i++) {
    if (out[i] === 0x30 && out[i + 1] === 0x82) {
      seen++;
      if (seen === 2) { out[i + 2] = 0xff; out[i + 3] = 0xff; break; }
    }
  }
  return out;
}

/*
 * The hard binding. Everything above answers "was this manifest altered?".
 * This answers the separate question "is this manifest about THIS file?" —
 * the one that stands between a genuine camera signature and someone else's
 * picture, and the one that has no cryptographic difficulty at all for a
 * forger: copying bytes is free.
 */

test('a manifest is bound to the bytes it travels in', async () => {
  const { bytes, exclusions } = await H.signedC2paAsset({ container: 'png', actions: AI_ACTION });
  const r = await M.analyzeImageBytes(bytes);
  const v = r.metadata.c2pa.verification;
  assert.equal(v.binding.status, 'valid');
  assert.equal(v.binding.kind, 'c2pa.hash.data');
  assert.ok(v.binding.hashed > 0, 'something outside the credential store was actually hashed');
  assert.equal(v.summary.ok, true);
  assert.match(v.summary.text, /bound to this file/);
  assert.equal(exclusions.length, 1);
});

test('a genuine manifest moved onto a different image is rejected, not merely unverified', async () => {
  const CAPTURE = [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' }];
  const real = await H.signedC2paAsset({ container: 'png', chain: 'full', generator: 'Leica M11-P', cn: 'Leica Camera AG', actions: CAPTURE });
  assert.equal((await M.analyzeImageBytes(real.bytes)).metadata.c2pa.verification.summary.ok, true, 'baseline: the original does verify');

  // The attack: the same manifest bytes, at the same offset, inside another
  // picture. Nothing about the signature, the assertions or the chain changes.
  const transplant = H.png([H.pngChunk('caBX', real.manifest), H.tEXt('Comment', 'an entirely different picture')]);
  const r = await M.analyzeImageBytes(transplant);
  const v = r.metadata.c2pa.verification;
  assert.equal(v.signature, 'valid', 'the stolen signature really is genuine');
  assert.equal(v.assertions.mismatched.length, 0, 'and every assertion still hashes as the claim says');
  assert.equal(v.chain.linked, true);
  assert.equal(v.binding.status, 'mismatch', 'only the binding catches it');
  assert.equal(v.summary.ok, false);
  assert.equal(v.summary.broken, true, 'a manifest describing another file is invalid, not unverified');
  const ids = r.signals.map((s) => s.id);
  assert.ok(ids.includes('c2pa-broken'), 'saw ' + ids.join(','));
  assert.ok(!ids.includes('c2pa-capture'), 'and the camera claim never speaks');
  assert.notEqual(V.combineImageSignals(r.signals).verdict, 'captured');
  assert.equal(V.combineImageSignals(r.signals).verdict, 'suspected');
});

test('one changed byte of the asset breaks the binding while the signature stays valid', async () => {
  const { bytes } = await H.signedC2paAsset({ container: 'png', actions: AI_ACTION });
  const edited = bytes.slice();
  // The last byte of the file: outside the credential store, so the manifest
  // is untouched and every other check still passes.
  edited[edited.length - 1] ^= 0xff;
  const v = (await M.analyzeImageBytes(edited)).metadata.c2pa.verification;
  assert.equal(v.signature, 'valid');
  assert.equal(v.binding.status, 'mismatch');
  assert.equal(v.summary.ok, false);
  assert.equal(v.summary.broken, true);
});

test('a validly signed claim carrying no hard binding is invalid, not verified', async () => {
  const manifest = await H.signedC2paManifest({ actions: AI_ACTION, chain: 'full' });
  const r = await M.analyzeImageBytes(H.png([H.pngChunk('caBX', manifest)]));
  const v = r.metadata.c2pa.verification;
  assert.equal(v.signature, 'valid');
  assert.equal(v.assertions.mismatched.length, 0);
  assert.equal(v.binding.status, 'absent');
  assert.equal(v.summary.ok, false, 'a claim about no particular file cannot pass');
  assert.equal(v.summary.broken, true);
  assert.ok(r.signals.map((s) => s.id).includes('c2pa-broken'));
});

/*
 * The exclusion ranges are written by whoever wrote the manifest. If a
 * validator applies them blindly, a forger simply excludes the whole file:
 * the digest is then over nothing and matches whatever they put in. So the
 * ranges have to sit inside the credential store and nowhere else.
 */
test('a binding may only exclude the credentials, never the picture', async () => {
  const asset = new Uint8Array(512).map((_, i) => i & 0xff);
  const store = [{ start: 100, end: 200 }];
  const bind = async (exclusions, ranges) => {
    const content = CBOR.encode({ exclusions, alg: 'sha256', hash: new Uint8Array(32) });
    const manifest = {
      claim: { alg: 'sha256', assertions: [{ url: 'self#jumbf=c2pa.assertions/c2pa.hash.data' }] },
      assertionBoxes: [{ label: 'c2pa.hash.data', raw: new Uint8Array(0), content, contentType: 'cbor' }],
    };
    return CV._internal.checkHardBinding(manifest, { assertions: null }, { asset, assetRanges: ranges === undefined ? store : ranges });
  };
  assert.equal((await bind([{ start: 0, length: asset.length }])).status, 'unchecked', 'excluding the whole file proves nothing');
  assert.equal((await bind([{ start: 100, length: 150 }])).status, 'unchecked', 'nor may it spill past the store');
  assert.equal((await bind([{ start: 100, length: 100 }])).status, 'mismatch', 'the honest range is applied and the digest actually checked');
  assert.equal((await bind([{ start: 100, length: 100 }], [])).status, 'unchecked', 'and without knowing where the store is, nothing is confirmed');
  // Malformed range sets are refused rather than guessed at.
  assert.equal((await bind([{ start: 0, length: 10 }, { start: 5, length: 10 }])).status, 'unchecked');
  assert.equal((await bind([{ start: 0, length: 10000 }])).status, 'unchecked');
  assert.equal((await bind([{ start: -1, length: 4 }])).status, 'unchecked');
  assert.equal((await bind('all of it')).status, 'unchecked');
});

test('a binding this reader cannot recompute is never a pass', async () => {
  const manifest = {
    claim: { alg: 'sha256', assertions: [{ url: 'self#jumbf=c2pa.assertions/c2pa.hash.bmff.v3' }] },
    assertionBoxes: [{ label: 'c2pa.hash.bmff.v3', raw: new Uint8Array(0), content: CBOR.encode({ hash: new Uint8Array(32) }), contentType: 'cbor' }],
  };
  const b = await CV._internal.checkHardBinding(manifest, { assertions: null }, { asset: new Uint8Array(64), assetRanges: [{ start: 0, end: 8 }] });
  assert.equal(b.status, 'unsupported');
  const s = CV.summarize({ signature: 'valid', assertions: null, chain: null, binding: b });
  assert.equal(s.ok, false);
  assert.equal(s.caution, true);
});

test('an unknown digest algorithm fails closed', async () => {
  const manifest = {
    claim: { assertions: [{ url: 'self#jumbf=c2pa.assertions/c2pa.hash.data' }] },
    assertionBoxes: [{ label: 'c2pa.hash.data', raw: new Uint8Array(0), content: CBOR.encode({ exclusions: [], alg: 'blake3', hash: new Uint8Array(32) }), contentType: 'cbor' }],
  };
  const b = await CV._internal.checkHardBinding(manifest, { assertions: null }, { asset: new Uint8Array(64), assetRanges: [{ start: 0, end: 8 }] });
  assert.equal(b.status, 'unchecked');
  assert.match(b.reason, /blake3/);
});

test('a binding that excludes nothing describes a sidecar, not this file', async () => {
  const manifest = {
    claim: { alg: 'sha256', assertions: [{ url: 'self#jumbf=c2pa.assertions/c2pa.hash.data' }] },
    assertionBoxes: [{ label: 'c2pa.hash.data', raw: new Uint8Array(0), content: CBOR.encode({ exclusions: [], hash: new Uint8Array(32) }), contentType: 'cbor' }],
  };
  const b = await CV._internal.checkHardBinding(manifest, { assertions: null }, { asset: new Uint8Array(64), assetRanges: [{ start: 0, end: 8 }] });
  assert.equal(b.status, 'unchecked', 'no pass, and no accusation either');
  assert.equal(CV.summarize({ signature: 'valid', assertions: null, chain: null, binding: b }).ok, false);
});

test('a hard binding the signed claim never referenced is not a binding', async () => {
  const manifest = {
    claim: { alg: 'sha256', assertions: [{ url: 'self#jumbf=c2pa.assertions/c2pa.actions.v2' }] },
    assertionBoxes: [{ label: 'c2pa.hash.data', raw: new Uint8Array(0), content: CBOR.encode({ exclusions: [], hash: new Uint8Array(32) }), contentType: 'cbor' }],
  };
  const b = await CV._internal.checkHardBinding(manifest, { assertions: null }, { asset: new Uint8Array(64), assetRanges: [{ start: 0, end: 8 }] });
  assert.equal(b.status, 'absent', 'anyone can add an unreferenced box');
});

test('a byte-capped fetch cannot confirm a binding, so it is caution rather than a pass', async () => {
  // A camera claim, because that is the one being withheld: most photographs
  // large enough to be capped are exactly this case.
  const { bytes } = await H.signedC2paAsset({ container: 'png', generator: 'Leica M11-P', cn: 'Leica Camera AG', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' }] });
  const r = await M.analyzeImageBytes(bytes, { truncated: true });
  const v = r.metadata.c2pa.verification;
  assert.equal(v.binding.status, 'unchecked');
  assert.equal(v.summary.ok, false);
  assert.equal(v.summary.broken, false);
  assert.equal(v.summary.caution, true);
  const ids = r.signals.map((s) => s.id);
  assert.ok(ids.includes('c2pa-unbound'), 'the reader is told why, saw ' + ids.join(','));
  assert.ok(!ids.includes('c2pa-verified'));
  // A capped fetch is an unanswered question about a very ordinary large
  // photograph. It withholds the badge; it must not accuse anyone.
  assert.equal(V.combineImageSignals(r.signals).verdict, 'no-signal');
});

test('an unsigned manifest never earns the badge a signed and bound one does', async () => {
  const CAPTURE = [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' }];
  const signed = await H.signedC2paAsset({ container: 'png', chain: 'full', generator: 'Leica M11-P', cn: 'Leica Camera AG', actions: CAPTURE });
  const signedR = await M.analyzeImageBytes(signed.bytes);
  assert.equal(V.combineImageSignals(signedR.signals).verdict, 'captured');

  const unsigned = H.c2paManifest({ generator: 'Leica M11-P', actions: CAPTURE });
  const unsignedR = await M.analyzeImageBytes(H.png([H.pngChunk('caBX', unsigned)]));
  assert.equal(unsignedR.metadata.c2pa.verification.signature, 'absent');
  assert.notEqual(V.combineImageSignals(unsignedR.signals).verdict, 'captured');
});
