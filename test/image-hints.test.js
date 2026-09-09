const test = require('node:test');
const assert = require('node:assert/strict');
const IH = require('../lib/image-hints.js');

/*
 * Both of these read strings the page itself wrote, so both are attacker
 * input. Each one used to throw, and because the call sits inside the
 * per-image loop of the content script's analyse pass — with no catch
 * anywhere up to main() — a single tag stopped image analysis, the platform
 * label pass, the mutation observer and the SPA poller for the rest of the
 * page's life. The reader was left with a stale partial verdict, which is
 * worse than none. A hostile page must not be able to silence the extension
 * with one attribute.
 */

test('a malformed percent-escape in an image URL does not throw', () => {
  for (const url of [
    'https://evil.test/%',
    'https://evil.test/%E0%A4',
    'https://evil.test/a/%zz.png',
    'https://evil.test/%FF%FE',
    'https://evil.test/dir%/file.png',
  ]) {
    assert.doesNotThrow(() => IH.analyzeImageHints({ url }), url);
    assert.ok(Array.isArray(IH.analyzeImageHints({ url })), url);
  }
});

test('a broken escape does not cost the filename hint on the rest of the URL', () => {
  // Still decoded when it can be.
  const decoded = IH.analyzeImageHints({ url: 'https://x.test/midjourney%5Fimage.png' });
  assert.ok(decoded.some((s) => s.id === 'filename'), 'a valid escape is still decoded');
  // And an undecodable name is matched raw rather than dropped.
  const raw = IH.analyzeImageHints({ url: 'https://x.test/stable-diffusion-%E0.png' });
  assert.ok(raw.some((s) => s.id === 'filename' || s.id === 'path'), 'the raw name is still read');
});

test('resolveUrl answers null for a URL that cannot be parsed, never throws', () => {
  const base = 'https://page.test/x/';
  for (const bad of ['http://[', 'http://a b', 'https://:@', 'http://%', 'http://', null, undefined, '', 42]) {
    assert.doesNotThrow(() => IH.resolveUrl(bad, base), String(bad));
    assert.equal(IH.resolveUrl(bad, base), null, String(bad));
  }
  assert.equal(IH.resolveUrl('poster.jpg', base), 'https://page.test/x/poster.jpg');
  assert.equal(IH.resolveUrl('/p.jpg', base), 'https://page.test/p.jpg');
  assert.equal(IH.resolveUrl('https://cdn.test/p.jpg', base), 'https://cdn.test/p.jpg');
});
