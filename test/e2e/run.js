/*
 * End-to-end check: loads the unpacked extension into Chromium via Playwright,
 * serves the fixture site, and asserts the stored page result.
 *
 *   npm run e2e            (needs `playwright` resolvable and a Chromium build)
 *   PW_CHROMIUM=/path/to/chrome npm run e2e   to pin the browser binary
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const assert = require('node:assert/strict');
const { build } = require('./fixtures.js');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* try global */ }
  const globalRoot = require('child_process').execSync('npm root -g').toString().trim();
  return require(path.join(globalRoot, 'playwright'));
}

(async () => {
  const { chromium } = loadPlaywright();
  const EXT = path.resolve(__dirname, '..', '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'srl-e2e-'));
  const site = path.join(work, 'site');
  await build(site);

  const TYPES = { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4' };
  const server = http.createServer((req, res) => {
    const f = path.join(site, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('not found'); }
    const body = fs.readFileSync(f);
    res.setHeader('content-type', TYPES[path.extname(f)] || 'application/octet-stream');
    res.setHeader('accept-ranges', 'bytes');
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
  }).listen(0);
  const port = server.address().port;

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
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://localhost:' + port + '/');
    await page.waitForTimeout(4000);

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
    assert.equal(byName['camera.jpg'], 'captured');
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
    assert.equal(policy.localFile, false, 'nor a local file');
    assert.equal(policy.publicImage, true, 'ordinary images still load');
    assert.equal(policy.ownSpace, true, 'and a page may read its own address space');

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
