/*
 * End-to-end check: loads the unpacked extension into Chromium via Playwright,
 * serves the fixture site, and asserts the stored page result.
 *
 *   npm run e2e            (needs `playwright` resolvable and a Chromium build)
 *   PW_CHROMIUM=/path/to/chrome npm run e2e   to pin the browser binary
 */
const path = require('path');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const assert = require('node:assert/strict');
const { build } = require('./fixtures.js');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* try global */ }
  const globalRoot = require('child_process').execSync('npm root -g').toString().trim();
  return require(path.join(globalRoot, 'playwright'));
}

/* One request, written to the socket exactly as given: no URL parsing, no
 * normalisation, nothing between the string and the server. */
function rawGet(port, target, host) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('GET ' + target + ' HTTP/1.1\r\nHost: ' + (host || '127.0.0.1:' + port) + '\r\nConnection: close\r\n\r\n');
    });
    let out = '';
    sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('timed out asking for ' + target)); });
    sock.on('data', (d) => { out += d.toString('latin1'); });
    sock.on('end', () => resolve(out));
    sock.on('error', reject);
  });
}

(async () => {
  const { chromium } = loadPlaywright();
  const EXT = path.resolve(__dirname, '..', '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'srl-e2e-'));
  const site = path.join(work, 'site');
  await build(site);

  const TYPES = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };
  /* SEC-3: a redirector, and the loopback URL behind it. Requests to each are
   * counted so the test can say whether the worker made the hop, rather than
   * whether it read what came back. */
  const hits = { redirector: 0, loopback: 0, swap: 0 };

  /*
   * X5. A fixture server is still a server. This one used to hand out
   * whatever `path.join(site, req.url)` reached, from a socket bound to
   * every interface, for the length of a test run on a developer's machine
   * and on every CI runner: `/../../../../etc/hostname` and the checkout's
   * own `.git/config` both came back 200. A browser and node's own fetch
   * normalise `..` away before it reaches here, which is why nobody saw it,
   * so the suite asks with a raw socket instead (see rawGet below).
   *
   * The two rules its sibling repositories settled on: resolve the path and
   * refuse anything that is not inside the fixture root, and refuse any
   * segment beginning with a dot. Both answer 403, which no legitimate
   * request reaches — everything the fixtures actually ask for still lands
   * on a file, or on the same 404 as before.
   */
  const ROOT = fs.realpathSync(site);
  function resolveFixture(urlPath) {
    let decoded;
    try { decoded = decodeURIComponent(urlPath); } catch (e) { return null; }
    if (decoded.includes('\0')) return null;
    const rel = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    if (rel.split('/').some((seg) => seg.startsWith('.'))) return null;
    const f = path.resolve(ROOT, rel);
    if (f !== ROOT && !f.startsWith(ROOT + path.sep)) return null;
    return f;
  }

  const server = http.createServer((req, res) => {
    const requested = req.url.split('?')[0];
    if (requested === '/redirect-to-loopback.png') {
      hits.redirector++;
      res.statusCode = 302;
      res.setHeader('location', 'http://127.0.0.1:' + server.address().port + '/loopback-probe.png');
      return res.end();
    }
    if (requested === '/loopback-probe.png') {
      hits.loopback++;
      res.statusCode = 404;
      return res.end('probe');
    }
    /* P-1: one URL, two pictures, so the test can say which one the
     * extension hashed. The first hit is what the <img> decodes; the page
     * then replaces the cache entry for the same URL itself. */
    if (requested === '/swap.png') {
      hits.swap++;
      res.statusCode = 200;
      res.setHeader('content-type', 'image/png');
      res.setHeader('cache-control', 'max-age=300');
      return res.end(fs.readFileSync(path.join(site, hits.swap === 1 ? 'shown.png' : 'camera.png')));
    }
    const f = resolveFixture(requested);
    if (f === null) { res.statusCode = 403; return res.end('forbidden'); }
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) { res.statusCode = 404; return res.end('not found'); }
    const body = fs.readFileSync(f);
    res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream');
    res.setHeader('accept-ranges', 'bytes');
    // The one fixture whose point is that the browser holds a copy of it.
    if (requested === '/camera.png') res.setHeader('cache-control', 'max-age=300');
    // Real byte-range support, including suffix ranges, so the tail fetch
    // used for media files is exercised rather than stubbed.
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      const [, rawStart, rawEnd] = range;
      let start; let end;
      if (rawStart === '') { start = Math.max(0, body.length - parseInt(rawEnd, 10)); end = body.length - 1; }
      else { start = parseInt(rawStart, 10); end = rawEnd === '' ? body.length - 1 : Math.min(parseInt(rawEnd, 10), body.length - 1); }
      if (start >= body.length || start > end) { res.statusCode = 416; return res.end(); }
      res.statusCode = 206;
      res.setHeader('content-range', 'bytes ' + start + '-' + end + '/' + body.length);
      return res.end(body.subarray(start, end + 1));
    }
    res.end(body);
  }).listen(0, '127.0.0.1');
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  /* `listen(0, cb)` passes the callback as the host, which is how a sibling
   * repository's harness ended up on 0.0.0.0 while looking correct. */
  assert.equal(server.address().address, '127.0.0.1', 'the fixture server must not leave loopback');
  const port = server.address().port;

  /*
   * Raw sockets, because every normal client normalises the request away.
   * The first two were served 200, with contents, before the containment
   * above; the dotfile rule is what keeps the fixture root's own dot
   * directories out if one is ever created there.
   */
  for (const [name, target] of [
    ['traversal to an absolute path', '/../../../../../../etc/hostname'],
    ['traversal into the checkout', '/../../../../../..' + path.resolve(EXT, '.git', 'config')],
    ['encoded traversal', '/%2e%2e/%2e%2e/etc/hostname'],
    ['a dotfile under the root', '/.git/config'],
  ]) {
    const answer = await rawGet(port, target);
    assert.match(answer.split('\r\n')[0], /^HTTP\/1\.1 (?:403|404) /, name + ' must be refused, got: ' + answer.split('\r\n')[0]);
    assert.ok(!/repositoryformatversion|root:/.test(answer), name + ' leaked a file the fixture root does not contain');
  }
  // ...and the refusal is invisible to everything the fixtures actually ask for.
  assert.match((await rawGet(port, '/index.html')).split('\r\n')[0], /^HTTP\/1\.1 200 /);
  assert.match((await rawGet(port, '/')).split('\r\n')[0], /^HTTP\/1\.1 200 /);
  assert.match((await rawGet(port, '/nope.png')).split('\r\n')[0], /^HTTP\/1\.1 404 /);

  const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), {
    headless: false,
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: [
      '--disable-extensions-except=' + EXT,
      '--load-extension=' + EXT,
      '--no-sandbox',
      '--headless=new',
      // Lets the platform-label fixture be served under a real platform host.
      '--host-resolver-rules=MAP www.instagram.com 127.0.0.1:' + port + ',MAP *.instagram.com 127.0.0.1:' + port,
    ],
  });
  try {
    let sw = ctx.serviceWorkers()[0];
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://localhost:' + port + '/');
    await page.waitForTimeout(5000);

    const result = await sw.evaluate(async (p) => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.startsWith('http://localhost:' + p));
      return (await chrome.storage.session.get('tab:' + t.id))['tab:' + t.id];
    }, port);
    assert.ok(result, 'page result stored');
    assert.equal(result.site.verdict, 'ai-built');
    assert.equal(result.site.builder.name, 'Lovable');
    assert.ok(result.site.trustNotes.length >= 3, 'placeholder trust notes');
    assert.equal(result.text.verdict, 'ai');
    const ids = new Set(result.text.flagged.flatMap((f) => f.signals.map((s) => s.id)));
    for (const id of ['unicode-tags', 'self-reference', 'disclosure-assisted', 'lexicon']) assert.ok(ids.has(id), 'text signal ' + id);
    const byName = Object.fromEntries(result.images.items.map((i) => [i.url.split('/').pop().split('?')[0].replace(/^blob:.*$/, 'blob'), i.verdict]));
    const blob = result.images.items.find((i) => i.url.startsWith('blob:'));
    assert.equal(byName['sd.png'], 'ai-generated');
    assert.equal(byName['c2pa.jpg'], 'ai-generated');
    /* Camera EXIF and nothing else: the file's own claim, shown as one. The
     * green capture badge is what an anchored, bound, page-loaded manifest
     * earns, and no build ships a trust list, so nothing here may reach it. */
    assert.equal(byName['camera.jpg'], 'self-claimed');
    assert.ok(!Object.values(byName).includes('captured'), 'nothing on this page earned a verified capture badge');
    assert.equal(byName['firefly.webp'], 'ai-edited');
    assert.equal(byName['0_0.png'], 'ai-disclosed');
    assert.ok(blob && blob.verdict === 'ai-generated', 'blob: image inspected via content script');
    assert.ok(result.images.total >= 8, 'late-added image picked up (' + result.images.total + ')');
    assert.equal(result.overall, 'undisclosed-ai');
    const systems = Object.fromEntries((result.aiSystems || []).map((x) => [x.id, x]));
    assert.equal(systems.lovable && systems.lovable.confidence, 'confirmed', 'site attributed to Lovable');
    assert.ok(systems.openai && systems.openai.layers.includes('image'), 'C2PA image attributed to OpenAI');
    assert.ok(systems.openai.layers.includes('text'), 'ChatGPT disclosure attributed to OpenAI');
    assert.equal(systems.stability && systems.stability.confidence, 'confirmed', 'SD parameters attributed');
    assert.equal(systems.midjourney && systems.midjourney.confidence, 'declared', 'Midjourney caption attributed');
    assert.equal(systems.adobe && systems.adobe.confidence, 'confirmed', 'Firefly XMP attributed');
    assert.deepEqual(errors, []);

    assert.ok(result.trader, 'trader analysis present');
    assert.ok(result.trader.missingCritical.includes('imprint'), 'missing imprint reported');
    assert.equal(result.trader.checks.find((c) => c.id === 'https').status, 'concern', 'plain http flagged');

    const hasOverlay = await page.evaluate(() => !!document.querySelector('srl-overlay') && document.querySelectorAll('[data-srl-text]').length >= 4);
    assert.ok(hasOverlay, 'overlay and text markers rendered');

    // Platform labels: same bytes, no embedded metadata, but a platform marker.
    const feed = await ctx.newPage();
    await feed.goto('http://www.instagram.com/feed.html');
    await feed.waitForTimeout(3000);
    const feedResult = await sw.evaluate(async () => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.includes('instagram.com/feed'));
      return (await chrome.storage.session.get('tab:' + t.id))['tab:' + t.id];
    });
    assert.ok(feedResult, 'feed result stored');
    const labelled = (feedResult.images.items || []).filter((i) => i.platformLabel);
    assert.ok(labelled.some((i) => i.platformLabel.text === 'Made with AI' && i.verdict === 'ai-disclosed'), 'Made with AI label read');
    const info = labelled.find((i) => i.platformLabel.text === 'AI info');
    assert.ok(info, 'AI info marker read');
    assert.equal(info.verdict, 'no-signal', 'an informational marker does not inflate the verdict');
    assert.ok(!labelled.some((i) => /editorial team/.test(i.platformLabel.text)), 'long prose is not treated as a label');

    // Video: credentials live past the prefix fetch, so the tail is requested.
    const media = await ctx.newPage();
    await media.goto('http://localhost:' + port + '/media.html');
    await media.waitForTimeout(4000);
    const mediaResult = await sw.evaluate(async () => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.endsWith('/media.html'));
      return (await chrome.storage.session.get('tab:' + t.id))['tab:' + t.id];
    });
    const clip = (mediaResult.images.items || []).find((i) => i.url.endsWith('clip.mp4'));
    assert.ok(clip, 'video inspected');
    assert.equal(clip.kind, 'av');
    assert.equal(clip.verdict, 'ai-generated', 'C2PA read from the end of the file');
    assert.equal(clip.metadata.c2pa.claimGenerator, 'Sora');
    const poster = (mediaResult.images.items || []).find((i) => i.kind === 'poster');
    assert.ok(poster && poster.verdict === 'ai-generated', 'poster frame inspected separately');

    // Cryptographic verification runs inside the extension, not just in tests.
    const creds = await ctx.newPage();
    await creds.goto('http://localhost:' + port + '/signed.html');
    await creds.waitForTimeout(3500);
    const credResult = await sw.evaluate(async () => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.endsWith('/signed.html'));
      return (await chrome.storage.session.get('tab:' + t.id))['tab:' + t.id];
    });
    const signed = (credResult.images.items || []).find((i) => i.url.endsWith('signed.png'));
    const tampered = (credResult.images.items || []).find((i) => i.url.endsWith('tampered.png'));
    assert.equal(signed.metadata.c2pa.verification.signature, 'valid', 'genuine signature verified in the browser');
    assert.equal(signed.metadata.c2pa.verification.summary.ok, true);
    assert.equal(signed.metadata.c2pa.verification.chain.linked, true);
    assert.equal(signed.metadata.c2pa.verification.chain.anchored, false, 'never claims an anchored root');
    assert.equal(tampered.metadata.c2pa.verification.signature, 'invalid', 'tampered signature rejected');
    assert.equal(tampered.metadata.c2pa.verification.summary.broken, true);
    assert.ok(tampered.signals.some((s) => s.id === 'c2pa-broken'), 'broken credentials surfaced as a signal');
    // The same signed manifest inside another picture: signature still valid,
    // hard binding is what catches it.
    const moved = (credResult.images.items || []).find((i) => i.url.endsWith('transplanted.png'));
    assert.equal(moved.metadata.c2pa.verification.signature, 'valid', 'the transplanted signature really is genuine');
    assert.equal(moved.metadata.c2pa.verification.binding.status, 'mismatch');
    assert.equal(moved.metadata.c2pa.verification.summary.ok, false, 'a manifest from another file must never read as verified');
    assert.equal(moved.metadata.c2pa.verification.summary.broken, true);
    assert.notEqual(moved.verdict, 'captured');

    /*
     * P-1. What is verified has to be what is displayed, and reading the
     * page's own HTTP cache does not establish that: `only-if-cached`
     * returns whatever the cache holds for the URL now, and a same-origin
     * page can overwrite its own entry after the <img> has decoded. The
     * fixture does exactly that — renders a Stable Diffusion picture, then
     * replaces its cache entry with a genuinely signed camera capture — so
     * the extension is handed real, valid, hard-bound credentials that
     * describe a picture nobody on the page is looking at.
     *
     * The credentials are still read and shown; what they may not do is
     * speak for the picture. `rendered` is one of the three conditions of
     * the exculpatory gate, and it is now earned by decoding the bytes in
     * the page and matching them against the element, not by the cache
     * having answered at all.
     */
    const swap = await ctx.newPage();
    await swap.goto('http://localhost:' + port + '/swap.html');
    await swap.waitForTimeout(7000);
    const swapResult = await sw.evaluate(async () => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.includes('/swap.html'));
      return (await chrome.storage.session.get('tab:' + t.id))['tab:' + t.id];
    });
    assert.ok(swapResult, 'swap page result stored');
    assert.ok(hits.swap >= 2, 'the page really did request the same URL a second time (' + hits.swap + ')');
    const swapItems = swapResult.images.items || [];
    const swapped = swapItems.find((i) => i.url.endsWith('swap.png'));
    const straight = swapItems.find((i) => i.url.endsWith('camera.png'));
    const disclaimed = (i) => (i.signals || []).some((x) => x.id === 'note' && /separate fetch/.test(x.label));
    assert.ok(swapped, 'the swapped image was inspected');
    // The desync is real: these are the credentials from the other picture.
    assert.ok((swapped.metadata.c2pa.signerNames || []).includes('Fixture Camera AG'), 'the extension was handed the swapped-in photograph');
    assert.equal(swapped.metadata.c2pa.verification.signature, 'valid', 'whose signature is genuine');
    assert.equal(swapped.metadata.c2pa.verification.binding.status, 'valid', 'and genuinely bound to its own bytes');
    // And it is refused as evidence about the picture on the page.
    assert.ok(disclaimed(swapped), 'bytes that do not decode to the picture must be marked as a separate fetch');
    assert.notEqual(swapped.verdict, 'captured');
    assert.ok(!swapItems.some((i) => i.verdict === 'captured'), 'nothing on this page earned a capture badge');
    assert.notEqual(swapResult.overall, 'provenance');
    /* The control: the same signed photograph, served honestly at its own
     * URL and never swapped. Its bytes do decode to what the element is
     * showing, so nothing disclaims them — the leg still works where it can
     * be earned, rather than having been quietly switched off. */
    assert.ok(straight, 'the unswapped copy was inspected');
    assert.ok(straight.metadata && straight.metadata.c2pa, 'and carries the same credentials');
    assert.ok(!disclaimed(straight), 'bytes that do decode to the picture are not disclaimed');

    /*
     * P-2. The per-view inspection budget has to be refilled by what leaves
     * the view. Charging a set nothing refills blinded the extension on any
     * page that outlives sixty distinct images: the fixture fills the budget
     * with one route's worth of tiles, changes route in the client, and
     * shows three AI pictures. The volume is bounded by the worker's
     * per-minute request and byte budget, which no page can re-arm.
     */
    const spa = await ctx.newPage();
    await spa.goto('http://localhost:' + port + '/spa.html');
    await spa.waitForTimeout(11000);
    const spaResult = await sw.evaluate(async () => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.includes('/spa.html'));
      return (await chrome.storage.session.get('tab:' + t.id))['tab:' + t.id];
    });
    assert.ok(spaResult, 'SPA result stored');
    const routeTwo = (spaResult.images.items || []).filter((i) => /route=2/.test(i.url));
    assert.equal(routeTwo.length, 3, 'every image of the second route was inspected (' + routeTwo.length + ' of 3)');
    for (const i of routeTwo) assert.ok(['ai-generated', 'ai-edited'].includes(i.verdict), i.url.split('/').pop() + ' after the route change read as ' + i.verdict);
    assert.equal(spaResult.overall, 'undisclosed-ai', 'and the page verdict says so');

    /*
     * SEC-3. The worker fetches with <all_urls> host permissions, so its
     * requests are not subject to the page's CSP, its mixed-content rules or
     * Chrome's Private Network Access checks. The fixture site is on
     * localhost and reads its own images (asserted above, so the guard does
     * not simply block everything); a page on the public internet must not
     * be able to point the extension at the reader's own network.
     */
    const policy = await sw.evaluate(() => {
      const p = self.SRL && self.SRL.fetchPolicy;
      if (!p) return { loaded: false };
      const from = 'https://news.example/article';
      return {
        loaded: true,
        loopback: p.mayFetch('http://127.0.0.1:11434/api/tags', from).ok,
        privateNet: p.mayFetch('http://192.168.1.1/', from).ok,
        metadata: p.mayFetch('http://169.254.169.254/latest/meta-data/', from).ok,
        mdns: p.mayFetch('http://nas.local/photo.jpg', from).ok,
        /* The same two hosts named fully qualified: one trailing dot used to
         * be past every rule written against a name. */
        dottedLoopback: p.mayFetch('http://localhost.:11434/api/tags', from).ok,
        dottedMdns: p.mayFetch('http://nas.local./photo.jpg', from).ok,
        localFile: p.mayFetch('file:///etc/passwd', from).ok,
        publicImage: p.mayFetch('https://cdn.example/a.jpg', from).ok,
        ownSpace: p.mayFetch('http://localhost:9/a.png', 'http://localhost:8/b.html').ok,
      };
    });
    assert.ok(policy.loaded, 'the fetch policy is loaded in the service worker');
    assert.equal(policy.loopback, false, 'a public page may not reach loopback');
    assert.equal(policy.privateNet, false, 'nor a private network');
    assert.equal(policy.metadata, false, 'nor the cloud metadata address');
    assert.equal(policy.mdns, false, 'nor a .local name');
    assert.equal(policy.dottedLoopback, false, 'nor loopback written as a fully qualified name');
    assert.equal(policy.dottedMdns, false, 'nor a .local name written the same way');
    assert.equal(policy.localFile, false, 'nor a local file');
    assert.equal(policy.publicImage, true, 'ordinary images still load');
    assert.equal(policy.ownSpace, true, 'and a page may read its own address space');

    /*
     * SEC-3, second half. Refusing to read what a redirect returned is not
     * the same as not making the request: with redirect:'follow' the browser
     * performs every hop before the fetch settles, so a page naming a
     * redirector it controls still gets the GET delivered to loopback. The
     * URL below is a public name (www.instagram.com resolves to this server)
     * whose response is a 302 to 127.0.0.1, asked for on behalf of a public
     * page — the redirector must be reached and the address behind it must
     * not be.
     */
    const hitsBefore = { ...hits };
    const redirected = await sw.evaluate(async (u) => {
      const r = await analyzeImages([{ id: 'redir', url: u }], {}, 'https://news.example/article');
      return r.results[0];
    }, 'http://www.instagram.com/redirect-to-loopback.png');
    assert.equal(hits.redirector, hitsBefore.redirector + 1, 'the redirector itself was fetched');
    assert.equal(hits.loopback, hitsBefore.loopback, 'but the loopback address behind it was never requested');
    const refusal = (redirected.signals || []).find((s) => s.id === 'unavailable');
    assert.ok(refusal, 'and the image is reported as not fetched');
    assert.match(refusal.detail, /redirects/, 'for the redirect, not for whatever the address behind it answered');

    /* SEC-1. No extension page is offered to web content any more, so a site
     * cannot frame the publisher view with a tab id of its choosing. */
    const extUrl = await sw.evaluate(() => chrome.runtime.getURL('publisher/publisher.html'));
    const reachable = await page.evaluate(async (u) => {
      try { const r = await fetch(u); return r.ok; } catch (e) { return false; }
    }, extUrl);
    assert.equal(reachable, false, 'publisher.html must not be reachable from a web page');

    /* A page cannot silence the extension with one bad attribute. */
    const hostile = await ctx.newPage();
    await hostile.goto('http://localhost:' + port + '/hostile.html');
    await hostile.waitForTimeout(3500);
    const hostileResult = await sw.evaluate(async () => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.endsWith('/hostile.html'));
      return (await chrome.storage.session.get('tab:' + t.id))['tab:' + t.id];
    });
    assert.ok(hostileResult, 'a page full of malformed URLs is still analysed');
    assert.ok(!hostileResult.error, 'and no analyser threw: ' + (hostileResult.error || ''));
    assert.equal(hostileResult.text.verdict, 'ai', 'text analysis still ran');
    const lighthouse = (hostileResult.images.items || []).find((i) => i.url.endsWith('sd.png'));
    assert.ok(lighthouse && lighthouse.verdict === 'ai-generated', 'image analysis still ran past the broken tags');
    /* The poster of a hidden video is an attribute, not a resource the page
     * loaded. The video's own source has always had a rendered-size floor;
     * the poster had none, which made `<video poster="…" style="display:none">`
     * the cheapest way to hand the extension a URL to fetch. */
    assert.ok(!(hostileResult.images.items || []).some((i) => i.url.endsWith('camera.jpg')),
      'a poster on a hidden video is not fetched');

    // Language awareness: a German page is read with the German lexicon.
    const de = await ctx.newPage();
    await de.goto('http://localhost:' + port + '/de.html');
    await de.waitForTimeout(3000);
    const deResult = await sw.evaluate(async () => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.endsWith('/de.html'));
      return (await chrome.storage.session.get('tab:' + t.id))['tab:' + t.id];
    });
    assert.equal(deResult.text.language.code, 'de', 'German page detected');
    assert.equal(deResult.text.language.lexicon, 'German');
    const deLevels = deResult.disclosures.map((d) => d.level);
    assert.ok(deLevels.includes('assisted'), 'German assistance disclosure read');
    assert.ok(deLevels.includes('generated'), 'German generation disclosure read');
    const deVerdicts = deResult.text.flagged.map((f) => f.verdict);
    assert.ok(deVerdicts.includes('ai-assisted-disclosed'), 'assistance clause not upgraded');
    assert.ok(deResult.text.flagged.some((f) => f.signals.some((s) => s.id === 'lexicon')), 'German stylometry fired');

    // The pill must actually be dismissible, and the badges toggleable.
    const pillVisible = () => page.evaluate(() => {
      const host = document.querySelector('srl-overlay');
      // Closed shadow root: measure through the host's own painted area.
      return host && host.getBoundingClientRect().height >= 0
        ? window.getComputedStyle(host).display !== 'none' : false;
    });
    assert.ok(await pillVisible(), 'overlay present before toggling');
    const beforeToggle = await page.evaluate(() => document.querySelectorAll('[data-srl-text]').length);
    assert.ok(beforeToggle > 0, 'text markers present');
    await sw.evaluate(async () => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.endsWith(':' + new URL(x.url).port + '/'));
      await chrome.tabs.sendMessage(t.id, { type: 'srl:toggle-overlay' });
    });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-srl-text]').length), 0, 'toggling hides text markers');
    await sw.evaluate(async () => {
      const t = (await chrome.tabs.query({})).find((x) => x.url && x.url.endsWith(':' + new URL(x.url).port + '/'));
      await chrome.tabs.sendMessage(t.id, { type: 'srl:toggle-overlay' });
    });
    await page.waitForTimeout(400);
    assert.ok(await page.evaluate(() => document.querySelectorAll('[data-srl-text]').length) > 0, 'toggling restores them');

    // Pausing a host stops the work and clears what was stored for the tab.
    await sw.evaluate(async () => chrome.storage.sync.set({ disabledHosts: ['localhost'] }));
    await page.waitForTimeout(1200);
    const afterPause = await sw.evaluate(async (p) => {
      const t = (await chrome.tabs.query({})).find((x) => x.url === 'http://localhost:' + p + '/');
      return { stored: (await chrome.storage.session.get('tab:' + t.id))['tab:' + t.id] || null };
    }, port);
    assert.equal(afterPause.stored, null, 'a paused host leaves no stored report');
    assert.equal(await page.evaluate(() => document.querySelectorAll('[data-srl-text]').length), 0, 'paused host has no markers');
    await sw.evaluate(async () => chrome.storage.sync.set({ disabledHosts: [] }));
    await page.waitForTimeout(1500);

    /* Navigating a tab must not leave the previous page's report attached to
     * it. Checked in the window right after navigation, before the new page
     * has been analysed, which is exactly where a stale report would show. */
    const navTabId = await sw.evaluate(async (p) => (await chrome.tabs.query({})).find((x) => x.url === 'http://localhost:' + p + '/').id, port);
    const before = await sw.evaluate(async (id) => ((await chrome.storage.session.get('tab:' + id))['tab:' + id] || {}).url, navTabId);
    assert.equal(before, 'http://localhost:' + port + '/', 'the tab has a report to go stale');
    await page.goto('http://localhost:' + port + '/de.html');
    await page.waitForTimeout(250);
    const during = await sw.evaluate(async (id) => {
      const r = (await chrome.storage.session.get('tab:' + id))['tab:' + id];
      return r ? r.url : null;
    }, navTabId);
    assert.notEqual(during, 'http://localhost:' + port + '/', 'the previous page\'s report must not survive navigation');
    await page.waitForTimeout(2500);
    const after = await sw.evaluate(async (id) => ((await chrome.storage.session.get('tab:' + id))['tab:' + id] || {}).url, navTabId);
    assert.equal(after, 'http://localhost:' + port + '/de.html', 'and the new page gets its own');

    // Domain memory: a second visit accumulates counters locally.
    await page.reload();
    await page.waitForTimeout(3000);
    const mem = await sw.evaluate(async () => (await chrome.storage.local.get('srl:domains'))['srl:domains']);
    assert.ok(mem && mem.localhost, 'domain record kept for localhost');
    assert.ok(mem.localhost.pages >= 2, 'repeat visits counted (' + mem.localhost.pages + ')');
    assert.ok(mem.localhost.aiPages >= 2, 'AI pages counted');
    assert.ok(mem.localhost.tools.lovable >= 1, 'tools counted per domain');
    console.log('e2e OK:', JSON.stringify({ overall: result.overall, site: result.site.verdict, text: result.text.verdict, images: result.images.counts }));
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((e) => { console.error('e2e FAILED:', e.message); process.exit(1); });
