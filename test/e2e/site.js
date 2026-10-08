/*
 * The website, end to end. Builds the site the way a deploy does (scripts/build-site.js),
 * serves it at a sub-path — as GitHub Pages serves a project site — from a server that answers
 * as Netlify reads the folder: every response carries the headers web/_headers gives its path,
 * web/_redirects' forced rules apply, and a missing address gets 404.html. Then it drives the
 * checker in Chromium under that policy: every kind of file it reads, a hostile saved page,
 * the not-found page at depth, a framing attempt from another origin, JavaScript off, a script
 * that fails to load, and the same site from a host that sends no headers at all, where only
 * the pages' <meta> policy protects it.
 *
 * It fails on any Content-Security-Policy or Trusted Types violation, any Permissions-Policy
 * complaint, any page error or console error, and any request outside the site, so a policy
 * that blocks something the checker really does fails here and not on a visitor's screen.
 *
 *   npm run test:e2e  (after the extension's own run), or node test/e2e/site.js
 */
const path = require('path');
const http = require('http');
const fs = require('fs');
const os = require('os');
const site = require('../../scripts/build-site.js');
const H = require('../helpers.js');
const { build: buildFixtures } = require('./fixtures.js');

function loadPlaywright() {
  try { return require('playwright'); } catch (e) { /* try global */ }
  const globalRoot = require('child_process').execSync('npm root -g').toString().trim();
  return require(path.join(globalRoot, 'playwright'));
}

const BASE = '/selfreportle/';
let failures = 0;
function check(ok, msg) {
  console.log((ok ? 'ok   ' : 'FAIL ') + msg);
  if (!ok) failures++;
}

/** A folder's _headers as [{ pattern, headers }] in file order, and its forced _redirects. */
function hostRules(dir) {
  const rules = [];
  const file = path.join(dir, '_headers');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      if (!/^\s/.test(line)) { rules.push({ pattern: line.trim(), headers: {} }); continue; }
      const m = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
      rules[rules.length - 1].headers[m[1]] = m[2].trim();
    }
  }
  const redirects = [];
  const rfile = path.join(dir, '_redirects');
  if (fs.existsSync(rfile)) {
    for (const line of fs.readFileSync(rfile, 'utf8').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const [from, to, status] = line.trim().split(/\s+/);
      redirects.push({ from, to, status: parseInt(status, 10), force: /!$/.test(status) });
    }
  }
  return { rules, redirects };
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};

/** A static host for one built folder at BASE: Netlify's reading of _headers and _redirects
 *  when `headers` is true, a host that sends no headers (GitHub Pages) when it is false. Every
 *  path asked for is recorded, and anything outside BASE is answered 404 and recorded too. */
function host(dir, headers) {
  const { rules, redirects } = hostRules(dir);
  const headersFor = (sitePath) => {
    const out = {};
    if (!headers) return out;
    for (const { pattern, headers: h } of rules) {
      const hit = pattern.endsWith('/*') ? sitePath.startsWith(pattern.slice(0, -1)) : sitePath === pattern;
      if (hit) Object.assign(out, h);
    }
    return out;
  };
  const seen = { paths: [], outside: [] };
  const notFound = (res, sitePath) => {
    res.writeHead(404, { 'Content-Type': TYPES['.html'], ...headersFor(sitePath) });
    res.end(fs.readFileSync(path.join(dir, '404.html')));
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.paths.push(url.pathname);
    if (!url.pathname.startsWith(BASE)) { seen.outside.push(url.pathname); res.writeHead(404); res.end(); return; }
    let rel;
    try { rel = decodeURIComponent(url.pathname.slice(BASE.length)); } catch (e) { rel = '\0'; }
    const sitePath = '/' + rel;
    const forced = redirects.find((r) => r.force && r.from === sitePath);
    if (forced) return notFound(res, sitePath);
    if (rel === '') rel = 'index.html';
    const file = path.resolve(dir, rel);
    const inside = !rel.includes('\0') && file.startsWith(dir + path.sep);
    if (!inside || !fs.existsSync(file) || !fs.statSync(file).isFile()) return notFound(res, sitePath);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || (path.basename(file) === 'LICENSE' ? 'text/plain; charset=utf-8' : 'application/octet-stream'), ...headersFor(sitePath) });
    res.end(fs.readFileSync(file));
  });
  return { server, seen, headersFor };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + server.address().port)));
}

/* A saved page that tries everything a page can try when a file is read: its own policy, a
 * refresh to another site, a <base>, styles in every place a parser puts them, every element
 * that fetches, inline handlers and a javascript: link. Read as a file, none of it may run,
 * load, navigate, change this site's policy or raise a violation against it. */
const HOSTILE = `<!-- saved from url=(0028)http://shop.example/offers -->
<!doctype html><html lang="en"><head>
<meta http-equiv="Content-Security-Policy" content="img-src 'none'; style-src 'none'">
<meta http-equiv="refresh" content="0;url=https://evil.example/">
<base href="https://evil.example/">
<STYLE>p{color:red}</STYLE><style media="x">a{}</style >
<link rel="stylesheet" href="https://evil.example/x.css"><link rel="preload" href="https://evil.example/p.js" as="script">
<link rel="prefetch" href="https://evil.example/f"><link rel="icon" href="/fav.ico"><link rel="dns-prefetch" href="//evil.example">
<title>Mega Sale</title></head>
<body><p style="color:blue" onclick="alert(1)">Only 3 left in stock! Add to cart now, checkout in seconds.</p>
<p
style=color:red>Prices from €19.99, buy now and save 90% off today only.</p><div STYLE = 'a:b'>This text was generated by ChatGPT.</div>
<svg><style>circle{}</style><circle style="fill:red" onload="alert(1)"/></svg>
<img src="https://evil.example/i.png" srcset="https://evil.example/2.png 2x" onerror="alert(1)"><img src="rel.png" alt="AI-generated illustration">
<picture><source srcset="https://evil.example/s.png"></picture><iframe src="https://evil.example/"></iframe><object data="https://evil.example/o"></object><embed src="https://evil.example/e">
<video src="https://evil.example/v.mp4" poster="https://evil.example/poster.png"></video><audio src="https://evil.example/a.mp3"></audio>
<script src="https://evil.example/s.js"></script><script>alert(1)</script>
<template><style>x{}</style><img src="https://evil.example/t.png"></template><noscript><img src="https://evil.example/n.png"></noscript>
<a href="javascript:alert(1)">deal</a><form action="https://evil.example/f"><input type="image" src="https://evil.example/in.png"></form>
<table><style>t{}</style><tr><td background="https://evil.example/bg.png">c</td></tr></table>
</body></html>`;

/* A saved page whose forms carry controls named after the DOM properties the checker reads. A
 * <form> answers a property lookup with its own control of that name first, and DOMParser's
 * document is no exception: name="attributes", "matches" (the body walk and a list item's own
 * text) and "contains" (a form that is the page's role="main") each made the whole report
 * fail; name="nodeType" let a hidden form's text into the body and wrote "null" into a list
 * item's; name="tagName" took a form's line break away, so text either side of it ran
 * together. Each is measured below by what the report says. */
const FORMS = `<!doctype html><html lang="en"><head><title>Form controls</title></head><body>
<form role="main" action="/search"><input name="contains">
<p>As an AI language model, I cannot browse the internet, but here is a comprehensive overview of our bakery. Certainly! Here is the text you asked for.</p></form>
<ul><li>As an AI language model, I hope this helps you delve into the rich tapestry of our seasonal flavours. <form><input name="matches"></form></li>
<li>As an AI language model, I hope this overview of our opening hours and our bakery helps you plan your visit. <form><input name="nodeType"></form></li></ul>
<form><input name="attributes"></form>
<p>This text was generated by</p><form>ChatGPT<input name="tagName"></form>
<form hidden>This page was written with Gemini.<input name="nodeType"></form>
</body></html>`;

(async () => {
  const { chromium } = loadPlaywright();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'srl-site-'));
  const fx = path.join(work, 'fixtures');
  await buildFixtures(fx);
  fs.writeFileSync(path.join(fx, 'hostile.html'), HOSTILE);
  fs.writeFileSync(path.join(fx, 'forms.html'), FORMS);
  fs.writeFileSync(path.join(fx, 'chat.txt'), 'Certainly! Here is a summary of the quarterly results.\n\nAs an AI language model, I cannot verify these figures, but here they are anyway.\n\nRevenue grew by twelve percent.');
  fs.writeFileSync(path.join(fx, 'archive.bin'), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
  fs.writeFileSync(path.join(fx, 'midjourney_render_0_0.png'), H.png([]));
  // A page saved in the single-byte encoding it declares, as older sites still are.
  fs.writeFileSync(path.join(fx, 'latin.html'), Buffer.from('<!doctype html><html lang="de"><head><meta charset="windows-1252"><title>Über uns · Bäckerei Müller</title></head><body><p>Grüße aus der Backstube.</p></body></html>', 'latin1'));

  const netlify = path.join(work, 'netlify');
  site.build(netlify, { host: 'netlify', base: BASE });
  const pages = path.join(work, 'pages');
  site.build(pages, { host: 'pages', base: BASE });

  const main = host(netlify, true);
  const origin = await listen(main.server);
  const home = origin + BASE;
  const bare = host(pages, false);
  const bareOrigin = await listen(bare.server);
  // Another origin, to frame the checker from.
  const framer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': TYPES['.html'] });
    res.end('<!doctype html><title>framer</title><iframe id="f" src="' + home + '" width="800" height="600"></iframe>');
  });
  const framerOrigin = await listen(framer);

  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const inSite = (u, o) => u.startsWith(o + BASE) || u.startsWith('blob:' + o + '/');

  /** A page that records what the policy refused, what threw, what it logged and asked for. */
  async function watched(context, o, opts = {}) {
    const p = await context.newPage();
    const seen = { violations: [], errors: [], console: [], outside: [] };
    await p.exposeBinding('__srlViolation', (_, s) => seen.violations.push(s));
    await p.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        window.__srlViolation(e.effectiveDirective + ' ' + e.blockedURI + ' at ' + e.sourceFile + ':' + e.lineNumber + ' ' + e.sample);
      });
    });
    p.on('pageerror', (e) => seen.errors.push(String(e)));
    p.on('console', (m) => {
      const text = m.text();
      if (opts.expect404 && /Failed to load resource: the server responded with a status of 404/.test(text)) return;
      if (m.type() === 'error' || /Content.Security.Policy|Permissions-Policy|Trusted Type/i.test(text)) seen.console.push(m.type() + ': ' + text);
    });
    p.on('request', (r) => { if (!inSite(r.url(), o)) seen.outside.push(r.url()); });
    return { page: p, seen };
  }
  function clean(label, seen) {
    check(seen.violations.length === 0, label + ': no policy violation' + (seen.violations.length ? ' — ' + seen.violations.join(' | ') : ''));
    check(seen.errors.length === 0, label + ': no page error' + (seen.errors.length ? ' — ' + seen.errors.join(' | ') : ''));
    check(seen.console.length === 0, label + ': no console error or policy complaint' + (seen.console.length ? ' — ' + seen.console.join(' | ') : ''));
    check(seen.outside.length === 0, label + ': no request outside the site' + (seen.outside.length ? ' — ' + seen.outside.join(' | ') : ''));
  }

  /** Pick a file and wait for the report or the error it answers with. */
  async function pick(p, name) {
    await p.setInputFiles('#file', path.join(fx, name));
    await p.waitForFunction((n) => {
      const r = document.getElementById('report');
      const s = document.getElementById('status');
      return (r.children.length && r.querySelector('.file .name') && r.querySelector('.file .name').textContent === n) || s.classList.contains('error');
    }, name, { timeout: 20000 });
    // A preview loads from its blob: address after the report is drawn; wait until it has
    // either decoded or failed, so the check below reads an answer and not a race.
    await p.waitForFunction(() => { const i = document.querySelector('#report img.preview'); return !i || i.complete; }, null, { timeout: 10000 });
    return p.evaluate(() => ({
      banner: (document.querySelector('#report .overall') || {}).textContent || '',
      report: document.getElementById('report').innerText,
      status: document.getElementById('status').textContent,
      error: document.getElementById('status').classList.contains('error'),
      tags: [...document.querySelectorAll('#report .tag')].map((t) => t.textContent),
      preview: (() => { const i = document.querySelector('#report img.preview'); return i ? { loaded: i.complete && i.naturalWidth > 0, src: i.src } : null; })(),
    }));
  }

  /* Whether the policy is in force in a page: under require-trusted-types-for an HTML string
   * sink throws. The probe is itself a violation, so it runs in a page of its own whose
   * console and violations are not the ones under test. */
  async function trustedTypesEnforced(context, url) {
    const p = await context.newPage();
    try {
      await p.goto(url);
      return await p.evaluate(() => { try { document.createElement('div').innerHTML = '<b>probe</b>'; return 'assigned'; } catch (e) { return e.name; } });
    } finally { await p.close(); }
  }

  try {
    const context = await browser.newContext();

    // ---- the checker, under the headers ----------------------------------------------------
    const { page, seen } = await watched(context, origin);
    const resp = await page.goto(home);
    const want = main.headersFor('/');
    for (const name of Object.keys(want)) check(resp.headers()[name.toLowerCase()] === want[name], 'the page is served with ' + name + ' as _headers writes it');
    check(Object.keys(want).length >= 9, 'the server sends the whole header set');
    const state = await page.evaluate(() => ({
      cls: document.documentElement.className,
      note: getComputedStyle(document.getElementById('startNote')).display,
      app: getComputedStyle(document.getElementById('app')).display,
    }));
    check(state.cls === 'started', 'the checker started (html class "' + state.cls + '")');
    check(state.note === 'none' && state.app !== 'none', 'the safety note is hidden and the picker shown');
    check(await trustedTypesEnforced(context, home) === 'TypeError', 'Trusted Types are enforced: an HTML string sink throws');

    let r = await pick(page, 'sd.png');
    check(/AI-generated/.test(r.banner), 'Stable Diffusion PNG: AI-generated (' + r.banner.slice(0, 40) + ')');
    check(/Stability AI|Stable Diffusion/.test(r.report), 'Stable Diffusion PNG: the tool is named');
    check(r.preview && r.preview.loaded && r.preview.src.startsWith('blob:' + origin), 'the preview is drawn from the picked bytes (img-src blob:)');
    r = await pick(page, 'c2pa.jpg');
    check(/AI-generated/.test(r.banner), 'C2PA JPEG: AI-generated');
    check(/OpenAI/.test(r.report), 'C2PA JPEG: the signer is named');
    r = await pick(page, 'signed.png');
    check(r.tags.includes('!Signed by an unvouched signer, bound to this file'), 'genuinely signed PNG: signature and binding verified in the page, signer not vouched for (' + r.tags.join(' / ') + ')');
    r = await pick(page, 'tampered.png');
    check(/Signature did NOT verify/.test(r.report) && r.tags.some((t) => t.startsWith('✗')), 'tampered signature: refused (' + r.tags.join(' / ') + ')');
    r = await pick(page, 'transplanted.png');
    check(r.tags.includes('✗Credentials describe a different file'), 'manifest moved onto another picture: the binding catches it');
    r = await pick(page, 'camera.png');
    check(/Origin claimed by the file, not verified/.test(r.banner), 'a signed camera claim with no trust list stays a claim (' + r.banner.slice(0, 50) + ')');
    check(!/Camera-capture provenance/.test(r.report), 'and never earns the camera badge');
    r = await pick(page, 'firefly.webp');
    check(/AI-edited/.test(r.banner), 'Firefly XMP WebP: AI-edited');
    r = await pick(page, 'clip.mp4');
    check(/AI-generated/.test(r.banner) && /Sora/.test(r.report), 'MP4 with credentials at the end: AI-generated, Sora');
    check(r.preview === null, 'video is not previewed');
    r = await pick(page, 'midjourney_render_0_0.png');
    check(/Possible AI/.test(r.banner) && /File name hints at a generator/.test(r.report), 'a generator-style file name is a weak hint, as on a page');

    r = await pick(page, 'index.html');
    check(/AI signals without disclosure/.test(r.banner), 'saved Lovable page: AI signals without disclosure (' + r.banner.slice(0, 40) + ')');
    check(/Built with an AI site\/app generator/.test(r.report) && /Lovable/.test(r.report), 'saved Lovable page: the generator is named');
    check(/Strong AI indicators/.test(r.report), 'saved Lovable page: the text is flagged');
    check(/Imprint \/ legal notice/.test(r.report) && /expected disclosures? not found/.test(r.report), 'saved Lovable page: the missing imprint is reported');
    check(/does not say which address it was saved from/.test(r.report) && !/Served over HTTPS/.test(r.report), 'no address in the file: the HTTPS check is left out, and the report says so');
    check(/Midjourney/.test(r.report), "saved Lovable page: a picture's caption names its tool");

    const before = main.seen.paths.length;
    r = await pick(page, 'hostile.html');
    await page.waitForTimeout(1500); // anything the parse might have started has time to show
    check(/saved from http:\/\/shop\.example\/offers/.test(r.report), 'hostile page: the address the file names is reported as the file states it');
    check(/Served over HTTPS/.test(r.report) && /not served over HTTPS/.test(r.report), 'hostile page: and its plain http is a concern');
    check(/Pressure and urgency patterns/i.test(r.report) && /Very large discount claim/.test(r.report), 'hostile page: pressure patterns are listed');
    check(/AI use is disclosed/.test(r.banner) && /generated by ChatGPT/.test(r.report), 'hostile page: its own disclosure is read');
    check(/AI-generated illustration|Caption\/alt text discloses AI/.test(r.report), 'hostile page: an alt-text disclosure is read');
    check(main.seen.paths.length === before, 'hostile page: the parse asked this site for nothing (' + main.seen.paths.slice(before).join(', ') + ')');
    check(page.url() === home, 'hostile page: its meta refresh navigated nowhere');
    r = await pick(page, 'sd.png');
    check(r.preview && r.preview.loaded, "hostile page: its own policy did not reach this page's (a blob: preview still loads)");
    check(await page.evaluate(() => document.documentElement.className) === 'started', 'hostile page: the checker is still running');

    r = await pick(page, 'forms.html');
    check(!r.error && /Strong AI indicators/.test(r.report), 'forms whose controls are named attributes, matches and contains stop nothing (' + (r.status || r.banner.slice(0, 40)) + ')');
    check(/AI use is disclosed/.test(r.banner), "a form is still a line break: the disclosure either side of it is read (" + r.banner.slice(0, 40) + ')');
    check(!/Gemini/.test(r.report), "a hidden form's text stays out of the report though its nodeType is renamed");
    check(!/\bnull\b/.test(r.report), "and no form's nodeValue is written into a list item's text");

    r = await pick(page, 'latin.html');
    check(/Title: Über uns · Bäckerei Müller/.test(r.report), 'a saved page is read in the encoding it declares');
    r = await pick(page, 'chat.txt');
    check(/Strong AI indicators/.test(r.banner), 'text with chat-transcript leakage: strong AI indicators');
    r = await pick(page, 'archive.bin');
    check(r.error && /not one Selfreportle reads/.test(r.status), 'a file it cannot read is said so, in the page');

    // Dropping a file does what picking it does.
    const dropped = await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['Certainly! Here is the text you asked for. As an AI language model, I hope this helps.'], 'dropped.txt', { type: 'text/plain' }));
      document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
      return true;
    });
    await page.waitForFunction(() => { const n = document.querySelector('#report .file .name'); return n && n.textContent === 'dropped.txt'; }, null, { timeout: 10000 }).catch(() => {});
    check(dropped && await page.evaluate(() => /Strong AI indicators/.test((document.querySelector('#report .overall') || {}).textContent || '')), 'a dropped file is read like a picked one');
    clean('the checker', seen);

    // ---- the not-found page, at depth, and the files that are not the site -------------------
    const nf = await watched(context, origin, { expect404: true });
    const deep = await nf.page.goto(home + 'no/such/page.html');
    check(deep.status() === 404, 'a missing address answers 404');
    check(await nf.page.title() === 'Page not found · Selfreportle', 'with the site\'s not-found page');
    check(await nf.page.evaluate(() => getComputedStyle(document.querySelector('.btn')).display) === 'inline-block', 'whose stylesheet loads two folders deep');
    check(await nf.page.evaluate(() => document.querySelector('.btn').getAttribute('href')) === BASE, 'and whose link leads to the checker');
    check(deep.headers()['content-security-policy'] === want['Content-Security-Policy'], 'the not-found page is sent the policy too');
    for (const p of ['README.md', 'lib/settings.js', 'lib/history.js', 'manifest.json', 'background/service-worker.js', '_headers', '_redirects', '.git/config', 'deploy/nginx.conf', 'web/index.html']) {
      const res = await nf.page.request.get(home + p);
      check(res.status() === 404, p + ' is not part of the site (' + res.status() + ')');
    }
    for (const p of site.siteFiles()) {
      const res = await nf.page.request.get(home + p);
      check(res.status() === 200, p + ' is served');
    }
    clean('the not-found page', nf.seen);

    // ---- another site may not frame the checker ---------------------------------------------
    const fr = await context.newPage();
    const frameConsole = [];
    fr.on('console', (m) => frameConsole.push(m.text()));
    await fr.goto(framerOrigin + '/');
    await fr.waitForTimeout(1500);
    const child = fr.frames().find((f) => f !== fr.mainFrame());
    const framed = child ? await child.evaluate(() => !!document.getElementById('file')).catch(() => false) : false;
    check(!framed, 'framed by another origin, the checker does not render');
    check(frameConsole.some((t) => /frame-ancestors|X-Frame-Options/.test(t)), 'and the browser says the policy refused it');
    await fr.close();

    // ---- JavaScript off: the note, not dead controls ----------------------------------------
    const noJs = await browser.newContext({ javaScriptEnabled: false });
    const nj = await noJs.newPage();
    await nj.goto(home);
    const noteShown = await nj.locator('#startNote').isVisible();
    const pickerShown = await nj.locator('#drop').isVisible();
    check(noteShown && !pickerShown, 'with JavaScript off the note shows and the picker does not');
    check(/needs JavaScript to be on/.test(await nj.locator('#startNote').innerText()), 'and says why');
    await noJs.close();

    // ---- a script that does not load: the safety net -----------------------------------------
    const broken = await browser.newContext();
    await broken.route('**/lib/image-metadata.js', (route) => route.abort());
    const bp = await broken.newPage();
    await bp.goto(home);
    await bp.waitForFunction(() => document.documentElement.classList.contains('start-failed'), null, { timeout: 10000 }).catch(() => {});
    check(await bp.evaluate(() => document.documentElement.className) === 'start-failed', 'a module that fails to load stops the start');
    check(await bp.locator('#startNote').isVisible() && !(await bp.locator('#drop').isVisible()), 'and the note replaces the picker');
    check(/did not load/.test(await bp.locator('#startNote').innerText()), 'saying what happened');
    await broken.close();

    // ---- a host that sends no headers: the <meta> policy alone -------------------------------
    const bareHome = bareOrigin + BASE;
    const bw = await watched(context, bareOrigin);
    const bareResp = await bw.page.goto(bareHome);
    check(!bareResp.headers()['content-security-policy'], 'the header-less host sends no policy header');
    check(await trustedTypesEnforced(context, bareHome) === 'TypeError', 'Trusted Types are still enforced, by the <meta>');
    check(await bw.page.evaluate(() => document.documentElement.className) === 'started', 'the checker starts under the <meta> policy');
    r = await pick(bw.page, 'sd.png');
    check(/AI-generated/.test(r.banner) && r.preview && r.preview.loaded, 'and reads a picture');
    r = await pick(bw.page, 'hostile.html');
    check(/AI use is disclosed/.test(r.banner), 'and a hostile saved page');
    r = await pick(bw.page, 'signed.png');
    check(r.tags.includes('!Signed by an unvouched signer, bound to this file'), 'and verifies credentials');
    clean('the header-less host', bw.seen);
    check(bare.seen.outside.length === 0 && main.seen.outside.length === 0, 'no request reached either server outside ' + BASE);

    await context.close();
  } finally {
    await browser.close();
    main.server.close();
    bare.server.close();
    framer.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
  if (failures) {
    console.error('site e2e: ' + failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('site e2e OK');
})().catch((e) => { console.error(e); process.exit(1); });
