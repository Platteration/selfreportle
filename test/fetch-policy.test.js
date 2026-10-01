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

/*
 * A trailing dot is the fully qualified spelling of the same name: the
 * resolver sends `localhost.` to loopback and `router.local.` to the same
 * mDNS responder, and Blink keeps the dot in the URL the page hands the
 * worker. `new URL` keeps it too — only an IPv4 literal is canonicalised by
 * the parser — so every rule written against a name was walked past by that
 * one character, and `<img src="http://localhost.:11434/api/tags">` on a
 * public page reached the reader's own machine exactly as before the policy
 * existed. One case per rule, so no rule can be left behind again.
 */
test('a trailing dot is the same host, and gets past no name rule', () => {
  const sameHost = [
    ['http://localhost.:11434/api/tags', 'http://localhost:11434/api/tags'],
    ['http://ip6-localhost./x', 'http://ip6-localhost/x'],
    ['http://ip6-loopback./x', 'http://ip6-loopback/x'],
    ['http://api.localhost./x', 'http://api.localhost/x'],
    ['http://printer.local./x', 'http://printer.local/x'],
    ['http://box.home.arpa./x', 'http://box.home.arpa/x'],
    ['http://intra.internal./x', 'http://intra.internal/x'],
    ['http://foo.LOCAL./x', 'http://foo.LOCAL/x'],
    ['http://localhost../x', 'http://localhost/x'],
  ];
  for (const [dotted, plain] of sameHost) {
    assert.equal(P.addressSpace(plain), 'local', plain);
    assert.equal(P.addressSpace(dotted), 'local', dotted + ' names the same host as ' + plain);
    const r = P.mayFetch(dotted, PUBLIC_PAGE);
    assert.equal(r.ok, false, dotted + ' must be refused for a public page');
    assert.match(r.reason, /page is public/);
  }
  assert.equal(P.canonicalHost('LOCALHOST..'), 'localhost', 'the host is lower-cased and de-dotted once');
  // The IP half was never affected — the URL parser canonicalises a literal —
  // and an ordinary public name is not blocked for carrying a dot either.
  assert.equal(P.addressSpace('http://127.0.0.1./x'), 'local');
  assert.equal(P.addressSpace('http://192.168.1.1./x'), 'private');
  assert.equal(P.addressSpace('https://cdn.example./a.jpg'), 'public');
  assert.equal(P.mayFetch('https://cdn.example./a.jpg', PUBLIC_PAGE).ok, true, 'and it is still fetched');
});

/*
 * The fetch gate is not the only rule keyed on a hostname, and the dot gets
 * past a name rule wherever one is written: the reader's paused-host list,
 * the platform whose labels are read, the builder fingerprints, the image
 * host patterns. A host reached by its fully qualified name is the same
 * host, so all of them have to see the same canonical form.
 */
test('the same dot gets past no other rule keyed on a hostname either', () => {
  const settings = require('../lib/settings.js');
  const s = settings.normalize({ disabledHosts: ['Example.com.'] });
  assert.deepEqual(s.disabledHosts, ['example.com'], 'a stored host is canonicalised on the way in');
  assert.equal(settings.isHostDisabled(s, 'example.com.'), true, 'a paused host stays paused when named fully qualified');
  assert.equal(settings.isHostDisabled(s, 'www.example.com.'), true, 'subdomains included');
  assert.equal(settings.isHostDisabled(s, 'notexample.com'), false, 'and the suffix match is still a label boundary');

  const labels = require('../lib/platform-labels.js');
  assert.equal((labels.platformFor('www.tiktok.com.') || {}).name, 'TikTok', 'a platform is recognised either way');

  const site = require('../lib/site-analyzer.js');
  const fingerprints = (host) => site.analyzeSite({ hostname: host, metas: [], scripts: [], comments: [], attrNames: [], inlineScripts: [] })
    .signals.map((x) => x.id);
  assert.ok(fingerprints('demo.bolt.host').length, 'the host fingerprint really does fire');
  assert.deepEqual(fingerprints('demo.bolt.host.'), fingerprints('demo.bolt.host'));

  const hints = require('../lib/image-hints.js');
  const hostSignal = (u) => (hints.analyzeImageHints({ url: u }).find((x) => x.id === 'host') || {}).label;
  assert.equal(hostSignal('https://cdn.midjourney.com/a.png'), 'Served from Midjourney CDN');
  assert.equal(hostSignal('https://cdn.midjourney.com./a.png'), 'Served from Midjourney CDN');

  /* The page's own host reaches all of those from one place. */
  const content = fs.readFileSync(path.join(__dirname, '..', 'content', 'content.js'), 'utf8');
  assert.match(content, /const pageHost = \(\) => S\.settings\.canonicalHost\(location\.hostname\)/);
  const code = content.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal((code.match(/location\.hostname/g) || []).length, 1, 'and nothing else reads it raw');
});

/* The rule is 192.0.0.0/24 (IETF protocol assignments) plus 192.0.2.0/24
 * (TEST-NET-1). Testing the first two octets alone swept up the whole of
 * 192.0.0.0/16, which is allocated, routed space — an image served from a
 * bare IP literal there was reported 'Not fetched' for no reason. */
test('the 192.0 rule covers the two reserved /24s, not the whole /16', () => {
  for (const url of ['http://192.0.0.1/x', 'http://192.0.0.170/x', 'http://192.0.2.5/x']) {
    assert.equal(P.addressSpace(url), 'private', url + ' is reserved');
  }
  for (const url of ['http://192.0.1.1/x', 'http://192.0.66.5/x', 'http://192.0.255.255/x']) {
    assert.equal(P.addressSpace(url), 'public', url + ' is ordinary routed space');
    assert.equal(P.mayFetch(url, PUBLIC_PAGE).ok, true, url + ' must still be fetched');
  }
  assert.equal(P.addressSpace('http://192.1.0.1/x'), 'public', 'and the neighbouring /16 is untouched');
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
 * SEC-3, second half. Checking where a fetch landed runs after the fetch has
 * settled, so with redirect:'follow' the request to the private address has
 * already been delivered and only the read of the body is refused — a page
 * naming a redirector it controls still reaches loopback. What the request is
 * or is not made is decided by the redirect mode: 'manual' does not perform
 * the hop at all, and yields an opaque response there is nothing to read in,
 * so it is refused. Following is kept only for a page that is itself in the
 * most private space, which the policy lets reach every space anyway.
 *
 * This is a source check because the mode is the browser's behaviour, not
 * ours; test/e2e/run.js points the worker at a real redirector on a public
 * host and asserts the loopback URL behind it is never requested.
 */
test('a redirect is not followed on a public page\'s behalf', () => {
  const SW = fs.readFileSync(path.join(__dirname, '..', 'background', 'service-worker.js'), 'utf8');
  /* Comments out: the mode they describe is not the mode the code passes. */
  const code = SW.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/redirect: 'follow'/.test(code), 'no fetch follows redirects unconditionally any more');
  assert.equal((code.match(/redirect: redirectMode\(pageUrl\)/g) || []).length, 2,
    'both the head fetch and the tail fetch choose the mode from the page');
  /* callerSpace, not addressSpace: a .local name is filed as loopback when it
   * is the target (conservative) and as the LAN when it is the caller, and it
   * is the caller that this grants a privilege to. */
  assert.match(code, /function redirectMode\(pageUrl\) \{\s*return S\.fetchPolicy\.callerSpace\(pageUrl\) === 'local' \? 'follow' : 'manual';/,
    'and only a page already in the most private space may follow');
  assert.equal((code.match(/res\.type === 'opaqueredirect'/g) || []).length, 2,
    'a redirect that was not followed is refused, not read as an empty body');
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

/*
 * L3-2. Several IPv6 forms carry an IPv4 address inside them, and on a network
 * that runs the matching transition mechanism the packet is delivered to that
 * IPv4 address: a NAT64/DNS64 network — ordinary on mobile carriers and on
 * IPv6-only corporate and cloud networks — turns [64:ff9b::c0a8:101] into
 * 192.168.1.1. Every one of these was classified public and fetched, while
 * the spellings the function already knew were correctly refused.
 */
test('IPv6 forms that carry an IPv4 address inside them are classified by that address', () => {
  // The embedded address is written as the same literal the v4 rules already
  // refuse, so the expectation comes from those rules, not from a table here.
  const cases = [
    ['NAT64 well-known prefix', (v) => '[64:ff9b::' + v + ']'],
    ['6to4', (v) => '[2002:' + v + '::]'],
    ['IPv4-translated ::ffff:0:0/96', (v) => '[::ffff:0:' + v + ']'],
    ['IPv4-mapped', (v) => '[::ffff:' + v + ']'],
  ];
  const addresses = [['7f00:1', '127.0.0.1'], ['c0a8:101', '192.168.1.1'], ['a9fe:a9fe', '169.254.169.254'], ['0a00:1', '10.0.0.1']];
  for (const [name, wrap] of cases) {
    for (const [hex, dotted] of addresses) {
      const want = P.addressSpace('http://' + dotted + '/x');
      assert.equal(P.addressSpace('http://' + wrap(hex) + '/x'), want, name + ' carrying ' + dotted);
    }
  }
  // Teredo hides the client's IPv4 as its ones-complement.
  const flip = (a, b) => (((a << 8) | b) ^ 0xffff).toString(16);
  assert.equal(P.addressSpace('http://[2001:0:1:2:3:4:' + flip(192, 168) + ':' + flip(1, 1) + ']/x'), 'private', 'Teredo carrying 192.168.1.1');
  assert.equal(P.addressSpace('http://[64:ff9b:1::1]/x'), 'private', '64:ff9b:1::/48 is the local-use NAT64 prefix');
  assert.equal(P.addressSpace('http://[fec0::1]/x'), 'private', 'deprecated site-local');
  // And the default fails closed: only 2000::/3 is globally routable unicast.
  assert.equal(P.addressSpace('http://[0100::1]/x'), 'private', 'an unallocated prefix is not assumed public');
  assert.equal(P.addressSpace('http://[4000::1]/x'), 'private');
  assert.equal(P.addressSpace('http://[2606:4700::1111]/x'), 'public', 'but ordinary global unicast still is');
  for (const url of ['http://[64:ff9b::7f00:1]/x', 'http://[2002:c0a8:101::]/x', 'http://[fec0::1]/x']) {
    assert.equal(P.mayFetch(url, PUBLIC_PAGE).ok, false, url + ' from a public page');
  }
});

/*
 * L3-1. A name is not resolved here and cannot be, so the ones that only ever
 * resolve on a local network are the ones this file can still answer for:
 * .lan, .corp, an intranet search-domain single label. A public name pointed
 * at 127.0.0.1 by its own owner is not in that set, which is why
 * content/content.js only hands over URLs the page's own loader already
 * fetched — see test/content-script.test.js.
 */
test('names that only resolve on a local network are not public', () => {
  for (const url of ['http://nas.lan/x', 'http://wiki/x', 'http://intranet.corp/x', 'http://host.intranet/x',
    'http://box.private/x', 'http://nas.home/x', 'http://thing.internal/x']) {
    assert.notEqual(P.addressSpace(url), 'public', url);
    assert.equal(P.mayFetch(url, PUBLIC_PAGE).ok, false, url + ' from a public page');
  }
  assert.equal(P.addressSpace('http://example.com/x'), 'public', 'an ordinary name still is');
});

/*
 * L3-3. The tier a page is granted is the address space it actually occupies.
 * mDNS is unauthenticated — any host on the segment can answer for any .local
 * name it likes — and a .local name resolves to a LAN address, not to
 * loopback. Ranking such a page 'local' handed a machine on the reader's
 * Wi-Fi the one space a LAN page is supposed to be refused: the reader's own
 * 127.0.0.1, plus redirect-following that every other non-loopback page is
 * denied. As a target the name stays conservative; as the caller it does not.
 */
test('a page on a LAN name is ranked on the LAN, not in the loopback tier', () => {
  for (const page of ['http://printer.local/ui', 'http://box.home.arpa/ui', 'http://nas.lan/ui', 'http://thing.internal/ui']) {
    assert.equal(P.callerSpace(page), 'private', page);
    // The same device by its address is refused loopback; by its name it must be too.
    assert.equal(P.mayFetch('http://127.0.0.1:11434/api/tags', page).ok, P.mayFetch('http://127.0.0.1:11434/api/tags', PRIVATE_PAGE).ok, page);
    assert.equal(P.mayFetch('http://127.0.0.1:11434/api/tags', page).ok, false);
    assert.equal(P.addressSpace(page), 'local', 'but as a target it stays in the conservative tier');
  }
  // A real loopback caller keeps what it had: the fixtures and file:// albums.
  assert.equal(P.callerSpace(LOCAL_PAGE), 'local');
  assert.equal(P.callerSpace('http://127.0.0.1:8080/x'), 'local');
  assert.equal(P.callerSpace('file:///home/a/album.html'), 'local');
  assert.equal(P.mayFetch('http://127.0.0.1:8080/a.jpg', LOCAL_PAGE).ok, true);
  assert.equal(P.callerSpace(PUBLIC_PAGE), 'public');
});

/*
 * L3-4. The per-page cap counted live <img> elements, so rewriting src on the
 * same sixty re-armed it forever, and nothing in the worker metered the
 * caller at all: twenty ordinary content-script batches from one tab pulled
 * 640 requests and 2.6 GB with the reader's IP on them.
 */
test('the worker meters what one tab may fetch', () => {
  const SW = fs.readFileSync(path.join(__dirname, '..', 'background', 'service-worker.js'), 'utf8');
  const code = SW.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(code, /const BUDGET_REQUESTS = \d+;/, 'a request ceiling per tab');
  assert.match(code, /const BUDGET_BYTES = [\d *]+;/, 'and a byte ceiling');
  assert.match(code, /if \(!chargeRequest\(tabId\)\)/, 'charged before the fetch is issued, not after');
  // Three call sites, plus the definition: the streamed chunk, the last
  // partial chunk at the cap, and the tail range request.
  assert.equal((code.match(/(?<!function )chargeBytes\(tabId, /g) || []).length, 3, 'and charged for every byte read, head and tail');
  // Spent budget is released by navigating or closing, the two places a page
  // stops being the same page — not by sending another message.
  assert.match(code, /function clearTab\(tabId\) \{[\s\S]*?budgets\.delete\(tabId\)/);
  assert.match(code, /onRemoved\.addListener\(\(tabId\) => \{[\s\S]*?budgets\.delete\(tabId\)/);
  assert.ok(!/budgets\.clear\(\)/.test(code), 'nothing refills every tab at once');
});
