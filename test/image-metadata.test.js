const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers.js');
const M = require('../lib/image-metadata.js');
const V = require('../lib/verdicts.js');
const CV = require('../lib/c2pa-verify.js');
const { webcrypto } = require('crypto');

const DST = 'http://cv.iptc.org/newscodes/digitalsourcetype/';

async function verdictOf(bytes, hints) {
  const r = await M.analyzeImageBytes(bytes, hints);
  return { ...V.combineImageSignals(r.signals), r };
}

/* The fingerprint a trust list would carry for a certificate, derived from
 * the certificate the fixture actually issued rather than written down. */
async function fingerprint(der) {
  const d = new Uint8Array(await webcrypto.subtle.digest('SHA-256', der));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

test('PNG with Stable Diffusion parameters chunk is AI-generated', async () => {
  const bytes = H.png([H.tEXt('parameters', 'a cat wearing a hat\nNegative prompt: blurry\nSteps: 30, Sampler: DPM++ 2M Karras, CFG scale: 7, Seed: 12345, Size: 512x512, Model hash: abcd1234')]);
  const { verdict, r } = await verdictOf(bytes);
  assert.equal(r.format, 'png');
  assert.equal(verdict, 'ai-generated');
  assert.ok(r.signals.some((s) => s.id === 'png-sd'));
});

test('PNG with compressed iTXt ComfyUI workflow is AI-generated', async () => {
  const workflow = JSON.stringify({ 3: { class_type: 'KSampler', inputs: { seed: 1 } } });
  const bytes = H.png([H.iTXt('prompt', workflow, true)]);
  const { verdict, r } = await verdictOf(bytes);
  assert.equal(verdict, 'ai-generated');
  assert.ok(r.signals.some((s) => s.id === 'png-comfy'));
});

test('PNG with XMP DigitalSourceType trainedAlgorithmicMedia', async () => {
  const xml = H.xmpPacket(`<rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Adobe Firefly 1.0"><Iptc4xmpExt:DigitalSourceType>${DST}trainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType></rdf:Description>`);
  const bytes = H.png([H.iTXt('XML:com.adobe.xmp', xml)]);
  const { verdict, r } = await verdictOf(bytes);
  assert.equal(verdict, 'ai-generated');
  assert.ok(r.signals.some((s) => s.id === 'xmp-dst'));
  assert.ok(r.signals.some((s) => s.id === 'xmp-tool'));
  assert.equal(r.metadata.xmp.creatorTool, 'Adobe Firefly 1.0');
});

test('PNG with no metadata has no signal', async () => {
  const { verdict, r } = await verdictOf(H.png([]));
  assert.equal(verdict, 'no-signal');
  assert.equal(r.signals.length, 0);
});

test('JPEG with camera EXIF reads as the file\'s own claim, not as capture provenance', async () => {
  const t = H.tiff([{ tag: 0x010f, type: 2, value: 'Canon' }, { tag: 0x0110, type: 2, value: 'Canon EOS R5' }, { tag: 0x0131, type: 2, value: 'Adobe Lightroom' }]);
  const { verdict, r } = await verdictOf(H.jpeg([H.app1Exif(t)]));
  assert.equal(r.format, 'jpeg');
  assert.equal(r.metadata.exif.make, 'Canon');
  assert.equal(r.metadata.exif.model, 'Canon EOS R5');
  assert.equal(verdict, 'self-claimed');
  // Shown, not suppressed: the EXIF is real evidence and stays in the report.
  assert.ok(r.signals.some((s) => s.id === 'exif-camera'), 'the evidence is still reported');
  assert.notEqual(V.IMAGE[verdict].color, V.IMAGE.captured.color, 'but not in the colour a verified capture earns');
});

test('JPEG with EXIF UserComment SD parameters is AI-generated', async () => {
  const comment = H.concat([H.str('UNICODE\0'), new Uint8Array(Buffer.from('cat\nSteps: 20, Sampler: Euler a, CFG scale: 7, Seed: 42', 'utf16le'))]);
  const t = H.tiff([{ tag: 0x9286, type: 7, value: comment }]);
  const { verdict, r } = await verdictOf(H.jpeg([H.app1Exif(t)]));
  assert.equal(verdict, 'ai-generated');
  assert.ok(r.signals.some((s) => s.id === 'exif-sd-params'));
});

test('JPEG with Midjourney-style XMP description', async () => {
  const xml = H.xmpPacket(`<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">a red bicycle in the rain --ar 16:9 --v 6 Job ID: 1b2c3d4e-5f60-7a8b-9c0d-1e2f3a4b5c6d</rdf:li></rdf:Alt></dc:description></rdf:Description>`);
  const { verdict, r } = await verdictOf(H.jpeg([H.app1Xmp(xml)]));
  assert.equal(verdict, 'ai-generated');
  assert.ok(r.signals.some((s) => s.id === 'xmp-mj-prompt'));
});

test('JPEG with XMP digitalCapture (rdf:resource form) reads as the file\'s own claim', async () => {
  const xml = H.xmpPacket(`<rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"><Iptc4xmpExt:DigitalSourceType rdf:resource="${DST}digitalCapture"/></rdf:Description>`);
  const { verdict, r } = await verdictOf(H.jpeg([H.app1Xmp(xml)]));
  assert.equal(verdict, 'self-claimed');
  assert.equal(r.signals[0].id, 'xmp-dst-claim');
  assert.match(r.signals[0].label, /says of itself/, 'worded as a claim, not as a finding');
});

/* An AI claim in the same field is a declaration against interest: nobody
 * forges one to look better, so it is still read at full strength. */
test('an XMP DigitalSourceType of trainedAlgorithmicMedia is still read as AI', async () => {
  const xml = H.xmpPacket(`<rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"><Iptc4xmpExt:DigitalSourceType rdf:resource="${DST}trainedAlgorithmicMedia"/></rdf:Description>`);
  const { verdict, r } = await verdictOf(H.jpeg([H.app1Xmp(xml)]));
  assert.equal(verdict, 'ai-generated');
  assert.ok(r.signals.some((s) => s.id === 'xmp-dst' && s.hard));
});

test('JPEG with C2PA manifest (AI created action, split APP11) is AI-generated with signer name', async () => {
  const manifest = H.c2paManifest({
    generator: 'ChatGPT',
    actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia', softwareAgent: { name: 'GPT-4o' } }],
    signerCN: 'OpenAI',
  });
  const bytes = H.jpeg([H.app11Jumbf(manifest, 200)]);
  const { verdict, r } = await verdictOf(bytes);
  assert.equal(verdict, 'ai-generated');
  const sig = r.signals.find((s) => s.id === 'c2pa-ai-created');
  assert.ok(sig, 'expected c2pa-ai-created signal');
  assert.match(sig.detail, /ChatGPT/);
  assert.match(sig.detail, /OpenAI/);
  assert.equal(r.metadata.c2pa.claimGenerator, 'ChatGPT');
  assert.deepEqual(r.metadata.c2pa.signerNames, ['OpenAI']);
});

test('PNG caBX C2PA manifest with generative edit is AI-edited', async () => {
  const manifest = H.c2paManifest({
    generator: 'Adobe Photoshop 25.0',
    actions: [
      { action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' },
      { action: 'c2pa.edited', digitalSourceType: DST + 'compositeWithTrainedAlgorithmicMedia', softwareAgent: 'Adobe Firefly' },
    ],
  });
  const pngBytes = H.png([H.pngChunk('caBX', manifest)]);
  const { verdict, r } = await verdictOf(pngBytes);
  assert.equal(verdict, 'ai-edited');
  assert.ok(r.signals.some((s) => s.id === 'c2pa-ai-edited'));
});

/*
 * A camera claim is the one worth forging, and every question the verifier
 * asks — signature, assertions, chain, binding — is answered yes by a
 * certificate the forger minted this morning with "Leica Camera AG" typed
 * into the subject. So the badge needs two more things than a pass: a chain
 * that reaches a signer this build knows, and bytes the page itself loaded
 * rather than a second fetch the server could answer differently.
 */
test('C2PA manifest from a camera is captured once it verifies, binds, anchors and is the page\'s own bytes', async () => {
  const { bytes, signer } = await H.signedC2paAsset({
    container: 'jpeg', segment: 400, chain: 'full', generator: 'Leica M11-P', cn: 'Leica Camera AG',
    actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' }],
  });
  CV.setTrustAnchors([await fingerprint(signer.certs[signer.certs.length - 1])]);
  try {
    const { verdict, r } = await verdictOf(bytes, { rendered: true });
    assert.equal(r.metadata.c2pa.verification.summary.ok, true);
    assert.equal(r.metadata.c2pa.verification.chain.anchored, true);
    assert.equal(verdict, 'captured');
    assert.ok(r.signals.some((s) => s.id === 'c2pa-capture' && s.hard));
  } finally {
    CV.setTrustAnchors([]);
  }
});

/*
 * L5-1. The same asset, the same signature, the same hard binding — and a
 * self-signed certificate is all it took, because nothing checked the root
 * against anything. An unanchored chain may not produce the green badge.
 */
test('a signature that verifies but anchors nowhere earns no capture verdict', async () => {
  const { bytes } = await H.signedC2paAsset({
    container: 'jpeg', segment: 400, chain: 'leaf', generator: 'Leica M11-P', cn: 'Leica Camera AG',
    actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' }],
  });
  const { verdict, r } = await verdictOf(bytes, { rendered: true });
  const v = r.metadata.c2pa.verification;
  assert.equal(v.summary.ok, true, 'all four questions still answer yes');
  assert.equal(v.chain.anchored, false, 'but nobody vouches for the signer');
  const ids = r.signals.map((s) => s.id);
  assert.ok(ids.includes('c2pa-capture-unverified'), 'the claim is shown, saw ' + ids.join(','));
  assert.ok(!r.signals.some((s) => s.hard && s.verdict === 'captured'));
  assert.notEqual(verdict, 'captured');
  assert.equal(V.overall({ site: {}, text: {}, images: { counts: { [verdict]: 1 } }, disclosures: [] }), 'none', 'and no page-level provenance tick');
});

/*
 * L5-3. The worker re-fetches the URL itself: no cookies, a Range header, no
 * Referer. A server that tells the two requests apart can hand the reader an
 * AI picture and the extension a signed photograph, and the badge lands on
 * the picture nobody hashed. Credentials read out of bytes the page did not
 * load say nothing about the picture on the page.
 */
test('a fully anchored manifest still earns no badge when the bytes are not the ones the page loaded', async () => {
  const { bytes, signer } = await H.signedC2paAsset({
    container: 'jpeg', segment: 400, chain: 'full', generator: 'Leica M11-P', cn: 'Leica Camera AG',
    actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' }],
  });
  CV.setTrustAnchors([await fingerprint(signer.certs[signer.certs.length - 1])]);
  try {
    const { verdict, r } = await verdictOf(bytes, {});
    assert.equal(r.metadata.c2pa.verification.summary.ok, true);
    assert.equal(r.metadata.c2pa.verification.chain.anchored, true);
    assert.ok(!r.signals.some((s) => s.hard && s.verdict === 'captured'));
    assert.notEqual(verdict, 'captured');
    assert.ok(r.signals.some((s) => s.id === 'c2pa-capture-unverified'));
  } finally {
    CV.setTrustAnchors([]);
  }
});

/*
 * The cheapest forgery of camera provenance is not a stolen key: it is a
 * hand-written JUMBF box with no signature at all. Nothing may be exculpatory
 * for free — a claim of capture has to be paid for cryptographically.
 */
test('an unsigned C2PA camera claim earns no capture verdict and no provenance badge', async () => {
  const manifest = H.c2paManifest({ generator: 'Leica M11-P', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' }] });
  const { verdict, r } = await verdictOf(H.jpeg([H.app11Jumbf(manifest)]));
  assert.equal(r.metadata.c2pa.verification.signature, 'absent');
  assert.equal(r.metadata.c2pa.verification.summary.ok, false);
  const ids = r.signals.map((s) => s.id);
  assert.ok(ids.includes('c2pa-capture-unverified'), 'the claim is shown, saw ' + ids.join(','));
  assert.ok(!r.signals.some((s) => s.hard && s.verdict === 'captured'), 'but never as a hard capture signal');
  assert.notEqual(verdict, 'captured');
  assert.equal(V.overall({ site: {}, text: {}, images: { counts: { [verdict]: 1 } }, disclosures: [] }), 'none', 'and no page-level provenance tick');
});

test('an unsigned C2PA "human made this" claim is not exculpatory either', async () => {
  const manifest = H.c2paManifest({ generator: 'Scanner Co', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCreation' }] });
  const { verdict, r } = await verdictOf(H.jpeg([H.app11Jumbf(manifest)]));
  assert.ok(!r.signals.some((s) => s.hard && (s.verdict === 'human-created' || s.verdict === 'captured')));
  assert.notEqual(verdict, 'human-created');
});

/* A claim of AI generation is a disclosure against interest: nobody forges
 * one to look better, so it is still read from an unsigned manifest. */
test('an unsigned C2PA AI-generation claim is still read', async () => {
  const manifest = H.c2paManifest({ generator: 'Anon Tool', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia' }] });
  const { verdict } = await verdictOf(H.jpeg([H.app11Jumbf(manifest)]));
  assert.equal(verdict, 'ai-generated');
});

test('WebP with C2PA chunk and EXIF', async () => {
  const manifest = H.c2paManifest({ generator: 'Google Imagen', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia' }] });
  const bytes = H.webp([H.webpChunk('C2PA', manifest), H.webpChunk('EXIF', H.tiff([{ tag: 0x0131, type: 2, value: 'Imagen 3' }]))]);
  const { verdict, r } = await verdictOf(bytes);
  assert.equal(r.format, 'webp');
  assert.equal(verdict, 'ai-generated');
});

test('Generic JUMBF scan finds C2PA in unknown container', async () => {
  const manifest = H.c2paManifest({ generator: 'DALL-E 3', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia' }] });
  const bytes = H.concat([new Uint8Array(64).fill(7), H.str('junkjunkjunk'), manifest, new Uint8Array(10)]);
  const { verdict, r } = await verdictOf(bytes);
  assert.equal(r.format, 'unknown');
  assert.equal(verdict, 'ai-generated');
});

test('Truncated / garbage input does not throw', async () => {
  for (const bytes of [new Uint8Array(0), new Uint8Array([0xff, 0xd8, 0xff]), new Uint8Array(200).fill(0xff), H.png([]).subarray(0, 20)]) {
    const r = await M.analyzeImageBytes(bytes);
    assert.ok(Array.isArray(r.signals));
  }
});

test('MP4 with C2PA nested in moov/udta is read as AI-generated video', async () => {
  const manifest = H.c2paManifest({ generator: 'Sora', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia' }], signerCN: 'OpenAI' });
  const { verdict, r } = await verdictOf(H.mp4(manifest));
  assert.equal(r.format, 'isobmff-av');
  assert.equal(verdict, 'ai-generated');
  assert.equal(r.metadata.c2pa.claimGenerator, 'Sora');
});

test('M4A audio with C2PA is read', async () => {
  const manifest = H.c2paManifest({ generator: 'ElevenLabs', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia' }] });
  const { verdict, r } = await verdictOf(H.mp4(manifest, { brand: 'M4A ' }));
  assert.equal(r.format, 'isobmff-av');
  assert.equal(verdict, 'ai-generated');
});

test('AVIF keeps its still-image format label', async () => {
  const manifest = H.c2paManifest({ generator: 'Google Imagen', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia' }] });
  const { r } = await verdictOf(H.mp4(manifest, { brand: 'avif' }));
  assert.equal(r.format, 'isobmff');
});

test('a file whose index sits at the end is reported as needing its tail', async () => {
  const manifest = H.c2paManifest({ generator: 'Veo', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia' }] });
  const whole = H.mp4(manifest, { placement: 'tail', mdatSize: 8192 });
  const head = whole.subarray(0, 2048);
  assert.equal(M.isobmffNeedsTail(head), true, 'head alone is not enough');
  assert.equal(M.isobmffNeedsTail(whole), false, 'the whole file has its index');
  const headOnly = await M.analyzeImageBytes(head);
  assert.equal(headOnly.metadata.c2pa, undefined, 'no credentials in the head');
  const full = await verdictOf(whole);
  assert.equal(full.verdict, 'ai-generated', 'credentials found once the tail is present');
});

/*
 * L1-1. A zlib stream of one repeated byte inflates about 1000:1, so half a
 * megabyte of PNG zTXt became half a gigabyte in the one service worker every
 * tab shares — four at a time, retriggered on every navigation. A ceiling per
 * chunk is not enough on its own: chunks that are each well under it still
 * add up, so what one image may keep is budgeted too. The bound is derived
 * from what the worker will actually fetch, not from the constant under test.
 */
test('compressed PNG text is bounded, per chunk and per image', async () => {
  const zlib = require('zlib');
  const CAP = require('../lib/settings.js').DEFAULTS.maxImageBytes;
  const zTXt = (key, size) => H.pngChunk('zTXt', H.concat([H.str(key + '\0'), Uint8Array.from([0]), new Uint8Array(zlib.deflateSync(Buffer.alloc(size, 0x41), { level: 9 }))]));

  // One chunk that inflates to far more than the worker would ever fetch.
  const one = await M.analyzeImageBytes(H.png([zTXt('Comment', 64 * CAP)]), {});
  assert.ok(one.signals.some((s) => /too large to inspect/.test(s.label)), 'the reader says why it stopped');
  assert.deepEqual(one.metadata.pngText, undefined, 'and keeps none of it');

  // Chunks that are each modest, and together exceed the whole fetch.
  const piece = 512 * 1024;
  const chunks = Array.from({ length: Math.ceil(CAP / piece) + 4 }, (_, i) => zTXt('C' + i, piece));
  const spread = await M.analyzeImageBytes(H.png(chunks), {});
  assert.ok(spread.signals.some((s) => /too large to inspect/.test(s.label)),
    'a per-chunk ceiling alone lets ' + chunks.length + ' chunks keep ' + Math.round(chunks.length * piece / (1 << 20)) + ' MB out of a ' + Math.round(CAP / (1 << 20)) + ' MB fetch');
});

/*
 * The same defect as L5-1 reached by a shorter path.
 *
 * Making a Content Credentials capture claim count now takes a manifest that
 * verified, bound, anchored to a signer this build knows, and came out of the
 * bytes the page itself loaded. An attacker who cannot manage any of that
 * writes one XMP attribute instead, or an EXIF Make — and the badge a reader
 * actually looks at is the per-image one. So the free spellings must not land
 * where the paid one lands. Every expectation below is read from the anchored
 * run in the same test rather than written down beside it.
 */
test('a forgeable metadata attribute never reaches the badge an anchored manifest earns', async () => {
  const CAPTURE = [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' }];
  const { bytes, signer } = await H.signedC2paAsset({
    container: 'jpeg', segment: 400, chain: 'full', generator: 'Leica M11-P', cn: 'Leica Camera AG', actions: CAPTURE,
  });
  CV.setTrustAnchors([await fingerprint(signer.certs[signer.certs.length - 1])]);
  let earned;
  try {
    earned = await verdictOf(bytes, { rendered: true });
  } finally {
    CV.setTrustAnchors([]);
  }
  const page = (got) => V.overall({ site: {}, text: {}, images: { counts: { [got.verdict]: 1 }, proven: V.provenCount([got.r.signals]) }, disclosures: [] });
  assert.equal(earned.r.metadata.c2pa.verification.chain.anchored, true, 'the fixture really did anchor');
  assert.equal(V.provenCount([earned.r.signals]), 1);
  assert.equal(page(earned), 'provenance', 'and the paid path really does earn the tick, so this test is not vacuous');

  // Every way a file can say "a camera made me" for nothing.
  const free = {
    'an XMP DigitalSourceType attribute': H.jpeg([H.app1Xmp(H.xmpPacket(`<rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"><Iptc4xmpExt:DigitalSourceType rdf:resource="${DST}digitalCapture"/></rdf:Description>`))]),
    'an EXIF camera make': H.jpeg([H.app1Exif(H.tiff([{ tag: 0x010f, type: 2, value: 'Leica Camera AG' }, { tag: 0x0110, type: 2, value: 'M11-P' }]))]),
    'a hand-written C2PA manifest saying the same thing': H.jpeg([H.app11Jumbf(H.c2paManifest({ generator: 'Leica M11-P', actions: CAPTURE }))]),
  };
  for (const [name, b] of Object.entries(free)) {
    const got = await verdictOf(b, { rendered: true });
    assert.notEqual(got.verdict, earned.verdict, name + ' reached the verdict an anchored manifest earns');
    assert.notEqual(V.IMAGE[got.verdict].color, V.IMAGE[earned.verdict].color, name + ' is drawn in the colour an anchored manifest earns');
    assert.ok(V.IMAGE[got.verdict].rank >= V.IMAGE[earned.verdict].rank, name + ' is ranked as more trustworthy than an anchored manifest');
    assert.equal(V.provenCount([got.r.signals]), 0, name + ' counted as proven provenance');
    assert.equal(page(got), 'none', name + ' lit the page-level provenance tick');
    // Refusing the badge must not mean hiding the claim: it is real evidence.
    assert.ok(got.r.signals.some((s) => s.label && /says of itself|claim/i.test(s.label)), name + ' left the reader nothing to see, saw ' + got.r.signals.map((s) => s.label).join(' | '));
  }
});
