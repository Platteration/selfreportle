const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers.js');
const M = require('../lib/image-metadata.js');
const X = require('../lib/x509.js');
const CV = require('../lib/c2pa-verify.js');

const DST = 'http://cv.iptc.org/newscodes/digitalsourcetype/';
const AI_ACTION = [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia' }];

async function analyse(opts) {
  const manifest = await H.signedC2paManifest({ actions: AI_ACTION, ...opts });
  const r = await M.analyzeImageBytes(H.jpeg([H.app11Jumbf(manifest, 400)]));
  return { r, v: r.metadata.c2pa.verification, ids: r.signals.map((s) => s.id) };
}

test('a genuine signature verifies, with its assertions and chain', async () => {
  const { v, ids } = await analyse({ chain: 'full' });
  assert.equal(v.signature, 'valid');
  assert.equal(v.algorithm, 'ES256');
  assert.equal(v.signedBy.cn, 'Test Signer');
  assert.equal(v.assertions.matched, 1);
  assert.deepEqual(v.assertions.mismatched, []);
  assert.equal(v.chain.linked, true);
  assert.equal(v.chain.timeValid, true);
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
  assert.equal(v.assertions.matched, 0);
  const s = CV.summarize(v);
  assert.equal(s.ok, false);
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
