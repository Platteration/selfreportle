const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const P = require('../lib/fetch-policy.js');

/*
 * SEC-3. The service worker fetches with <all_urls> host permissions, so its
 * requests skip the page's CSP, its mixed-content blocking and Chrome's
 * Private Network Access checks. The URLs come from img/video/audio src and
 * poster attributes the page wrote, and the only filter was a scheme test —
 * so an ordinary HTTPS page could have the extension read http://127.0.0.1,
 * a router on 192.168.x.x or the cloud metadata address on the reader's
 * behalf, from the reader's IP and inside the reader's network.
 *
 * The rule enforced here is the Private Network Access one: a page may reach
 * its own address space or a less private one, never a more private one.
 */

const PUBLIC_PAGE = 'https://news.example/article';
const LOCAL_PAGE = 'http://localhost:8080/index.html';
const PRIVATE_PAGE = 'http://192.168.1.10/admin';

test('address spaces are classified from the literal host', () => {
  for (const url of ['https://example.com/a.jpg', 'http://cdn.example.co.uk/x', 'http://8.8.8.8/x', 'http://[2606:4700::1111]/x']) {
    assert.equal(P.addressSpace(url), 'public', url);
  }
  for (const url of ['http://127.0.0.1:11434/x', 'http://127.1.2.3/x', 'http://localhost/x', 'http://LOCALHOST:99/x',
    'http://api.localhost/x', 'http://printer.local/x', 'http://box.home.arpa/x', 'http://[::1]:9/x', 'http://0.0.0.0/x']) {
    assert.equal(P.addressSpace(url), 'local', url);
  }
  for (const url of ['http://10.0.0.1/x', 'http://172.16.0.1/x', 'http://172.31.255.254/x', 'http://192.168.1.1/x',
    'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/x', 'http://[fd00::1]/x', 'http://[fe80::1]/x',
    'http://[::ffff:10.0.0.1]/x']) {
    assert.equal(P.addressSpace(url), 'private', url);
  }
  assert.equal(P.addressSpace('http://172.32.0.1/x'), 'public', 'the RFC1918 block ends at 172.31');
  assert.equal(P.addressSpace('http://172.15.0.1/x'), 'public', 'and starts at 172.16');
  assert.equal(P.addressSpace('data:image/png;base64,AAAA'), 'inline');
  for (const url of ['blob:https://example.com/abc', 'chrome-extension://abc/x', 'javascript:1', 'not a url', '']) {
    assert.equal(P.addressSpace(url), null, url);
  }
});

test('a public page may not have the extension read a private or local address', () => {
  for (const url of ['http://127.0.0.1:11434/api/tags', 'http://192.168.1.1/', 'http://10.0.0.5/x.png',
    'http://169.254.169.254/latest/meta-data/', 'http://[::1]/x', 'http://nas.local/photo.jpg']) {
    const r = P.mayFetch(url, PUBLIC_PAGE);
    assert.equal(r.ok, false, url + ' must be refused');
    assert.match(r.reason, /page is public/);
  }
});

test('a page may reach its own address space, which is how local fixtures work', () => {
  assert.equal(P.mayFetch('http://localhost:8080/a.png', LOCAL_PAGE).ok, true);
  assert.equal(P.mayFetch('http://127.0.0.1:8080/a.png', LOCAL_PAGE).ok, true);
  assert.equal(P.mayFetch('https://cdn.example/a.png', LOCAL_PAGE).ok, true, 'and anything less private');
  assert.equal(P.mayFetch('http://192.168.1.11/a.png', PRIVATE_PAGE).ok, true, 'one private host may reference another');
  assert.equal(P.mayFetch('http://127.0.0.1/a.png', PRIVATE_PAGE).ok, false, 'but not loopback, which is more private still');
  assert.equal(P.mayFetch('https://images.example/a.jpg', PUBLIC_PAGE).ok, true);
  assert.equal(P.mayFetch('data:image/png;base64,AAAA', PUBLIC_PAGE).ok, true, 'inline bytes touch no network');
});

test('a caller with no page of its own gets the least privilege', () => {
  for (const from of ['', null, undefined, 'not a url']) {
    assert.equal(P.mayFetch('http://127.0.0.1/x', from).ok, false);
    assert.equal(P.mayFetch('https://example.com/x.png', from).ok, true);
  }
});

/* file: is deliberately kept: the extension runs on file:///* pages, where
 * the images are the page's own resources. It is the page's own scheme that
 * earns it, not the extension's host permissions. */
test('file: resources are read only for a page that is itself a local file', () => {
  assert.equal(P.mayFetch('file:///home/u/photo.jpg', 'file:///home/u/album.html').ok, true);
  const r = P.mayFetch('file:///etc/passwd', PUBLIC_PAGE);
  assert.equal(r.ok, false);
  assert.match(r.reason, /itself a local file/);
  assert.equal(P.mayFetch('file:///etc/passwd', LOCAL_PAGE).ok, false, 'http://localhost is not a file: page');
});

test('unsupported schemes are refused rather than guessed at', () => {
  for (const url of ['ftp://example.com/a.png', 'chrome://settings', 'blob:https://example.com/x', 'javascript:alert(1)']) {
    const r = P.mayFetch(url, PUBLIC_PAGE);
    assert.equal(r.ok, false, url);
    assert.match(r.reason, /unsupported URL scheme/);
  }
});

/*
 * MISSED-5. The cross-tab image cache keyed long URLs on `url.slice(0, 2000)
 * + '#' + url.length`, so two signed CDN URLs agreeing on their first 2000
 * characters and differing only in a trailing token of the same length shared
 * one entry — and the second image was answered with the first one's format,
 * metadata and C2PA verification. For a provenance tool that is the worst
 * available failure: image B reported under image A's credentials.
 */
test('two long URLs that differ only in a trailing token get different cache keys', async () => {
  const prefix = 'https://cdn.example/' + 'a'.repeat(2100) + '?sig=';
  const a = prefix + 'AAAAAAAAAAAAAAAA';
  const b = prefix + 'BBBBBBBBBBBBBBBB';
  assert.equal(a.length, b.length, 'same length');
  assert.equal(a.slice(0, 2000), b.slice(0, 2000), 'same 2000-character prefix: the old key collided');
  const [ka, kb] = [await P.cacheKey(a), await P.cacheKey(b)];
  assert.notEqual(ka, kb);
  assert.match(ka, /^sha256:[0-9a-f]{64}$/);
  assert.equal(await P.cacheKey(a), ka, 'and the key is stable for the same URL');
});

test('short URLs are their own key, and the key never grows without bound', async () => {
  assert.equal(await P.cacheKey('https://example.com/a.png'), 'https://example.com/a.png');
  const huge = 'data:image/png;base64,' + 'A'.repeat(500000);
  const key = await P.cacheKey(huge);
  assert.ok(key.length < 100, 'a megabyte data: URI does not become a megabyte cache key');
});

/* The policy is worth nothing if the worker does not consult it. */
test('the service worker routes every fetch through the policy', () => {
  const SW = fs.readFileSync(path.join(__dirname, '..', 'background', 'service-worker.js'), 'utf8');
  assert.match(SW, /importScripts\([^)]*fetch-policy\.js/, 'the module is loaded');
  assert.ok(!/\^\(https\?\|data\|file\):/.test(SW), 'the bare scheme test is gone');
  assert.match(SW, /S\.fetchPolicy\.mayFetch\(url, pageUrl\)/, 'the image fetch asks first');
  assert.match(SW, /landedSomewhereAllowed\(res, url, pageUrl\)/, 'and where a redirect landed is checked too');
  assert.match(SW, /S\.fetchPolicy\.cacheKey\(url\)/, 'the cache key is the digest, not a prefix');
  assert.ok(!/url\.slice\(0, 2000\)/.test(SW), 'the truncating cache key is gone');
});

/*
 * MISSED-4. analyzeImages applied a floor to the caller's byte caps and no
 * ceiling, although lib/settings.js already clamps them (32 MB / 8 MB) and is
 * imported right there. maxImageBytes: 1e10 made the worker buffer until it
 * was killed for memory, taking the per-tab results with it.
 */
test('the worker clamps the caps it is handed instead of trusting them', () => {
  const SW = fs.readFileSync(path.join(__dirname, '..', 'background', 'service-worker.js'), 'utf8');
  assert.match(SW, /S\.settings\.normalize\(settings \|\| \{\}\)/, 'the normaliser that owns the ceilings is used');
  assert.ok(!/Math\.max\(65536, settings\.max/.test(SW), 'the floor-only clamp is gone');
  assert.match(SW, /MAX_IMAGES_PER_MESSAGE/, 'and one message cannot queue unbounded fetches');
});

test('the settings normaliser really does cap what the worker now runs through it', () => {
  const settings = require('../lib/settings.js');
  const s = settings.normalize({ maxImageBytes: 1e10, maxMediaBytes: 1e10 });
  assert.equal(s.maxImageBytes, 32 * 1024 * 1024);
  assert.equal(s.maxMediaBytes, 8 * 1024 * 1024);
  const low = settings.normalize({ maxImageBytes: 1, maxMediaBytes: 0 });
  assert.equal(low.maxImageBytes, 64 * 1024, 'and the floor the worker used to apply is still there');
  assert.equal(low.maxMediaBytes, 64 * 1024);
});

/*
 * SEC-2. onMessage validated only that msg.type was a string: srl:get-result
 * handed back any tab id the caller named. Nothing outside this extension can
 * reach onMessage, but a content script has no business naming a tab other
 * than its own, and the pattern was already in use two cases further down.
 */
test('message handlers derive the tab from the sender when there is one', () => {
  const SW = fs.readFileSync(path.join(__dirname, '..', 'background', 'service-worker.js'), 'utf8');
  assert.match(SW, /sender\.id !== chrome\.runtime\.id/, 'the sender is checked');
  assert.match(SW, /getResult\(fromTab != null \? fromTab : msg\.tabId\)/,
    'a content script gets its own tab; only an extension page may name one');
  assert.ok(!/getResult\(msg\.tabId\)/.test(SW), 'the caller-named tab id is no longer taken on trust');
});

/*
 * SEC-1. publisher/publisher.html was offered to <all_urls> as a
 * web-accessible resource although the popup opens it with chrome.tabs.create
 * + runtime.getURL, which needs no such entry. It let any site frame a
 * privileged extension page with a chosen ?tabId= and clickjack it.
 */
test('no extension page is offered to web content', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  assert.equal(manifest.web_accessible_resources, undefined, 'nothing here needs to be web-accessible');
  assert.equal(manifest.externally_connectable, undefined);
  const pub = fs.readFileSync(path.join(__dirname, '..', 'publisher', 'publisher.js'), 'utf8');
  assert.match(pub, /window\.top !== window/, 'and the page refuses to run in a frame anyway');
});
