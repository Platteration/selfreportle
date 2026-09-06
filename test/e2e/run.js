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
  build(site);

  const server = http.createServer((req, res) => {
    const f = path.join(site, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('not found'); }
    const ext = path.extname(f);
    res.setHeader('content-type', { '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' }[ext] || 'application/octet-stream');
    res.end(fs.readFileSync(f));
  }).listen(0);
  const port = server.address().port;

  const ctx = await chromium.launchPersistentContext(path.join(work, 'profile'), {
    headless: false,
    executablePath: process.env.PW_CHROMIUM || undefined,
    args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--no-sandbox', '--headless=new'],
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

    const hasOverlay = await page.evaluate(() => !!document.querySelector('srl-overlay') && document.querySelectorAll('[data-srl-text]').length >= 4);
    assert.ok(hasOverlay, 'overlay and text markers rendered');
    console.log('e2e OK:', JSON.stringify({ overall: result.overall, site: result.site.verdict, text: result.text.verdict, images: result.images.counts }));
  } finally {
    await ctx.close();
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((e) => { console.error('e2e FAILED:', e.message); process.exit(1); });
