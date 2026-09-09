const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers.js');
const M = require('../lib/image-metadata.js');
const V = require('../lib/verdicts.js');

const DST = 'http://cv.iptc.org/newscodes/digitalsourcetype/';

async function verdictOf(bytes) {
  const r = await M.analyzeImageBytes(bytes);
  return { ...V.combineImageSignals(r.signals), r };
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

test('JPEG with camera EXIF is captured (weak)', async () => {
  const t = H.tiff([{ tag: 0x010f, type: 2, value: 'Canon' }, { tag: 0x0110, type: 2, value: 'Canon EOS R5' }, { tag: 0x0131, type: 2, value: 'Adobe Lightroom' }]);
  const { verdict, r } = await verdictOf(H.jpeg([H.app1Exif(t)]));
  assert.equal(r.format, 'jpeg');
  assert.equal(r.metadata.exif.make, 'Canon');
  assert.equal(r.metadata.exif.model, 'Canon EOS R5');
  assert.equal(verdict, 'captured');
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

test('JPEG with XMP digitalCapture (rdf:resource form) is captured', async () => {
  const xml = H.xmpPacket(`<rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/"><Iptc4xmpExt:DigitalSourceType rdf:resource="${DST}digitalCapture"/></rdf:Description>`);
  const { verdict, r } = await verdictOf(H.jpeg([H.app1Xmp(xml)]));
  assert.equal(verdict, 'captured');
  assert.equal(r.signals[0].id, 'xmp-dst');
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

test('C2PA manifest from a camera is captured once it verifies and binds', async () => {
  const { bytes } = await H.signedC2paAsset({
    container: 'jpeg', segment: 400, chain: 'full', generator: 'Leica M11-P', cn: 'Leica Camera AG',
    actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'digitalCapture' }],
  });
  const { verdict, r } = await verdictOf(bytes);
  assert.equal(r.metadata.c2pa.verification.summary.ok, true);
  assert.equal(verdict, 'captured');
  assert.ok(r.signals.some((s) => s.id === 'c2pa-capture' && s.hard));
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
