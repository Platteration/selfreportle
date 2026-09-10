/* Builds the fixture site used by run.js: synthetic images with real
 * provenance metadata plus an HTML page exercising every analyser. */
const fs = require('fs');
const path = require('path');
const H = require('../helpers.js');

const DST = 'http://cv.iptc.org/newscodes/digitalsourcetype/';

async function build(out) {
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'sd.png'), H.png([H.tEXt('parameters', 'a lighthouse at dusk\nSteps: 28, Sampler: DPM++ 2M, CFG scale: 6, Seed: 991, Size: 768x768, Model hash: 31e35c80fc')]));
  const manifest = H.c2paManifest({ generator: 'ChatGPT', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia', softwareAgent: { name: 'GPT-4o' } }], signerCN: 'OpenAI' });
  fs.writeFileSync(path.join(out, 'c2pa.jpg'), H.jpeg([H.app11Jumbf(manifest, 300)]));
  fs.writeFileSync(path.join(out, 'camera.jpg'), H.jpeg([H.app1Exif(H.tiff([{ tag: 0x010f, type: 2, value: 'Nikon' }, { tag: 0x0110, type: 2, value: 'Z 8' }]))]));
  fs.writeFileSync(path.join(out, 'plain.png'), H.png([]));
  const xml = H.xmpPacket(`<rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmp:CreatorTool="Adobe Firefly"><Iptc4xmpExt:DigitalSourceType>${DST}compositeWithTrainedAlgorithmicMedia</Iptc4xmpExt:DigitalSourceType></rdf:Description>`);
  fs.writeFileSync(path.join(out, 'firefly.webp'), H.webp([H.webpChunk('XMP ', H.str(xml))]));
  fs.writeFileSync(path.join(out, 'index.html'), PAGE);
  fs.writeFileSync(path.join(out, 'feed.html'), FEED);
  // Video whose index, and so its credentials, sits at the end of the file.
  const videoManifest = H.c2paManifest({ generator: 'Sora', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia' }], signerCN: 'OpenAI' });
  fs.writeFileSync(path.join(out, 'clip.mp4'), H.mp4(videoManifest, { placement: 'tail', mdatSize: 900 * 1024 }));
  fs.writeFileSync(path.join(out, 'media.html'), MEDIA);
  // Genuinely signed credentials, and the same asset with the signature broken.
  // `good` carries a real hard binding over its own bytes, which is what the
  // extension has to recompute before it may call anything verified.
  const good = await H.signedC2paAsset({ container: 'png', generator: 'Adobe Firefly', cn: 'Fixture Signer', chain: 'full', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia' }] });
  const bad = await H.signedC2paManifest({ generator: 'Adobe Firefly', cn: 'Fixture Signer', tamper: 'signature', actions: [{ action: 'c2pa.created', digitalSourceType: DST + 'trainedAlgorithmicMedia' }] });
  // The same signed manifest, byte for byte, inside a different picture: every
  // signature still verifies and the hard binding is the only thing that does not.
  const transplanted = H.png([H.pngChunk('caBX', good.manifest), H.tEXt('Comment', 'a different picture entirely')]);
  fs.writeFileSync(path.join(out, 'signed.png'), good.bytes);
  fs.writeFileSync(path.join(out, 'tampered.png'), H.png([H.pngChunk('caBX', bad)]));
  fs.writeFileSync(path.join(out, 'transplanted.png'), transplanted);
  fs.writeFileSync(path.join(out, 'signed.html'), SIGNED);
  fs.writeFileSync(path.join(out, 'hostile.html'), HOSTILE);
  fs.writeFileSync(path.join(out, 'de.html'), GERMAN);
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Lovable App</title>
<!-- Built with Lovable -->
<script src="https://cdn.gpteng.co/gptengineer.js" type="module"></script>
<style>img{width:200px;height:150px;object-fit:cover;background:#ccc;display:inline-block} body{font-family:sans-serif;max-width:900px;margin:40px auto}</style>
</head>
<body>
<main>
<h1 data-lov-id="src/App.tsx:1">Welcome to Acme Roofing</h1>
<p>In today's fast-paced digital landscape, homeowners must navigate the complexities of an ever-evolving roofing market. It is important to note that leveraging cutting-edge materials is paramount. Moreover, a robust warranty serves as a testament to our commitment. Furthermore, clients who embark on this journey unlock the true potential of their homes. Ultimately, the tapestry of craftsmanship is multifaceted, and it is worth noting that seamless installation fosters a vibrant community. In conclusion, let's dive into the key takeaways: delve deeper, harness the power of quality, and elevate your home. Additionally, stakeholders should underscore the pivotal role of holistic maintenance. Whether you're a first-time buyer or a seasoned landlord, this comprehensive guide will streamline your decision.</p>
<p>Call us at (555) 123-4567 or email info@yourcompany.com. Our office is at 123 Main Street.</p>
<p>Secret note&#xE0049;&#xE0047;&#xE004E;&#xE004F;&#xE0052;&#xE0045; that looks normal.</p>
<p>Certainly! Here's a 300-word description of our services. We fix roofs.</p>
<p>This paragraph is written with the help of ChatGPT and reviewed by our team.</p>
<p>Honest human note: we had a rough week. The truck broke down twice, and Dave forgot the ladder on Tuesday. Still, we got both jobs done and nobody fell off anything, which counts as a win around here.</p>
<figure><img src="sd.png" alt="Lighthouse"><figcaption>Our lighthouse project</figcaption></figure>
<figure><img src="c2pa.jpg" alt="Roof render"><figcaption>Roof render</figcaption></figure>
<figure><img src="camera.jpg" alt="Site photo"><figcaption>Site photo</figcaption></figure>
<figure><img src="plain.png" alt="Plain"><figcaption>Plain</figcaption></figure>
<figure><img src="firefly.webp" alt="Banner"><figcaption>Banner</figcaption></figure>
<figure><img src="https://cdn.midjourney.com/abc/0_0.png" alt="Remote"><figcaption>Illustration generated with Midjourney</figcaption></figure>
<figure><img id="blob" alt="Blob"><figcaption>Blob image</figcaption></figure>
<div id="late"></div>
</main>
<script>
  fetch('sd.png').then((r) => r.blob()).then((b) => { document.getElementById('blob').src = URL.createObjectURL(b); });
  setTimeout(() => {
    const f = document.createElement('figure');
    f.innerHTML = '<img src="c2pa.jpg?late=1" alt="Late"><figcaption>Added later</figcaption><p>Late paragraph generated by AI for testing.</p>';
    document.getElementById('late').appendChild(f);
  }, 1200);
</script>
</body>
</html>`;

/* Mimics a social feed: platform-applied AI labels, no embedded metadata.
 * Served under a mapped hostname so the platform matcher fires. */
const FEED = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Feed</title>
<style>img{width:320px;height:240px;object-fit:cover;background:#bbb}article{margin:24px;font-family:sans-serif}</style>
</head><body>
<article data-testid="post">
  <img src="plain.png" alt="Post one">
  <span>Made with AI</span>
  <p>Look at this sunset.</p>
</article>
<article data-testid="post">
  <img src="plain.png" alt="Post two">
  <span>AI info</span>
  <p>Holiday photo.</p>
</article>
<article data-testid="post">
  <img src="plain.png" alt="Post three">
  <p>We made this with AI tools and a lot of help from our editorial team over several weeks, so the caption is long.</p>
</article>
</body></html>`;

const MEDIA = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Clip</title></head><body>
<video src="clip.mp4" poster="sd.png" width="480" height="270" controls></video>
<p>A short clip.</p>
</body></html>`;

const SIGNED = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Credentials</title>
<style>img{width:300px;height:200px;background:#ccc}</style></head><body>
<figure><img src="signed.png" alt="Signed"><figcaption>Signed</figcaption></figure>
<figure><img src="tampered.png" alt="Tampered"><figcaption>Tampered</figcaption></figure>
<figure><img src="transplanted.png" alt="Transplanted"><figcaption>Transplanted</figcaption></figure>
</body></html>`;

/* Every input a hostile page can use to make an analyser throw, on one page.
 * Each of these once aborted the whole content script: the malformed escape
 * in an image URL, the unparseable video poster, and the Replit fingerprint
 * that reached an undeclared variable. The summary still has to appear. */
const HOSTILE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hostile</title>
<script src="https://replit.com/public/js/replit-dev-banner.js"></script>
<style>img{width:200px;height:150px;background:#ccc}</style></head><body>
<h1>Nothing to see</h1>
<img src="/%" width="100" height="100" alt="Broken escape">
<img src="/%E0%A4" width="100" height="100" alt="Truncated escape">
<video poster="http://[" width="480" height="270"></video>
<video poster="http://a b" width="480" height="270"></video>
<!-- A poster on a video the page never shows: an attribute nobody loaded is
     not a URL the extension fetches on the page's behalf. -->
<video poster="camera.jpg" style="display:none"></video>
<figure><img src="sd.png" alt="Lighthouse"><figcaption>Our lighthouse project</figcaption></figure>
<p>Certainly! Here's a 300-word description of our services. We fix roofs.</p>
</body></html>`;

const GERMAN = `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>Dachdecker Berlin</title></head><body>
<main>
<h1>Willkommen bei Acme Dachdecker</h1>
<p>In der heutigen schnelllebigen digitalen Welt ist es wichtig zu beachten, dass Hausbesitzer ganzheitliche Lösungen benötigen. Darüber hinaus spielt eine nahtlose Installation eine entscheidende Rolle. Zudem ist maßgeschneiderte Beratung unverzichtbar für den Erfolg. Zusammenfassend lässt sich sagen, dass bahnbrechende Materialien die Landschaft der Branche revolutionieren werden. Letztendlich ist ein facettenreicher Ansatz nicht nur sinnvoll, sondern auch notwendig für nachhaltiges Wachstum.</p>
<p>Dieser Text wurde mit Hilfe von KI erstellt und redaktionell geprüft.</p>
<p>Unsere Bildergalerie ist KI-generiert.</p>
<p>Gestern hat der Transporter wieder gestreikt. Der Kollege hat die Leiter vergessen, und trotzdem sind beide Dächer fertig geworden. Niemand ist runtergefallen, das zählt hier als guter Tag.</p>
</main>
</body></html>`;

module.exports = { build };
if (require.main === module) build(process.argv[2] || path.join(__dirname, 'site'));
