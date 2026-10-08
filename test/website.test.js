/*
 * The website layer: one policy, written in five places, and a site that is exactly the files
 * the page loads. Netlify and Cloudflare Pages read web/_headers, Apache web/.htaccess, nginx
 * deploy/nginx.conf, and a host that sends no headers (GitHub Pages) gets the policy from the
 * <meta> of web/index.html and web/404.html. A header changed in one of them and not the others
 * is a site protected on one host and not on the next, so each is read out of its file here and
 * they are held equal. What the policy allows is measured, not assumed: test/e2e/site.js serves
 * the built site under these headers at a sub-path and drives the checker in Chromium.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const site = require('../scripts/build-site.js');

const root = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
/** A page without its comments, which may name the elements they describe. */
const page = (p) => read(p).replace(/<!--[\s\S]*?-->/g, '');

/** web/_headers as { path: { Header: value } }. */
function netlifyHeaders() {
  const rules = {};
  let current = null;
  for (const line of read('web/_headers').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) { current = rules[line.trim()] = {}; continue; }
    const m = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
    assert.ok(m && current, '_headers: a header line under a path: ' + line);
    assert.ok(!Object.prototype.hasOwnProperty.call(current, m[1]), '_headers: ' + m[1] + ' is set once per path');
    current[m[1]] = m[2].trim();
  }
  return rules;
}

/** Every `Header always set` in web/.htaccess, as { Header: value }. */
function apacheHeaders() {
  const conf = read('web/.htaccess');
  const out = {};
  for (const m of conf.matchAll(/^\s*Header\s+always\s+set\s+([A-Za-z-]+)\s+"([^"]*)"(?:\s+env=HTTPS)?\s*$/gm)) {
    assert.ok(!Object.prototype.hasOwnProperty.call(out, m[1]), '.htaccess: ' + m[1] + ' is set once');
    out[m[1]] = m[2];
  }
  assert.equal([...conf.matchAll(/^\s*Header\b/gm)].length, Object.keys(out).length, '.htaccess sets every header with `Header always set` and a quoted value');
  return out;
}

/** Every `add_header` in deploy/nginx.conf, as { Header: value }. Each must carry `always`, or
 *  nginx leaves it off the 404 page and every other error response. */
function nginxHeaders() {
  const conf = read('deploy/nginx.conf');
  const out = {};
  for (const m of conf.matchAll(/^\s*add_header\s+([A-Za-z-]+)\s+"([^"]*)"\s+always;\s*$/gm)) {
    assert.ok(!Object.prototype.hasOwnProperty.call(out, m[1]), 'nginx.conf: ' + m[1] + ' is set once');
    out[m[1]] = m[2];
  }
  assert.equal([...conf.matchAll(/^\s*add_header\b/gm)].length, Object.keys(out).length, 'nginx.conf: every add_header is quoted and `always`');
  // add_header in a location replaces every inherited one there, so they all live at server level
  assert.doesNotMatch(conf.replace(/^\s*#.*$/gm, ''), /location[^{]*\{[^}]*add_header/, 'nginx.conf: no location sets a header of its own');
  return out;
}

/** A page's <meta> policy and referrer policy. */
function metaOf(file) {
  const html = page(file);
  const csp = [...html.matchAll(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/g)].map((m) => m[1]);
  const referrer = [...html.matchAll(/<meta name="referrer" content="([^"]+)">/g)].map((m) => m[1]);
  assert.equal(csp.length, 1, file + ' carries one Content-Security-Policy <meta>');
  assert.equal(referrer.length, 1, file + ' carries one referrer <meta>');
  // a <meta> policy governs only what comes after it
  assert.ok(html.indexOf('http-equiv="Content-Security-Policy"') < html.search(/<(script|link|style)\b/), file + ': the policy comes before anything it governs');
  return { csp: csp[0], referrer: referrer[0] };
}

/** A policy as an ordered list of [directive, ...sources]. */
const directives = (policy) => policy.split(';').map((d) => d.trim()).filter(Boolean).map((d) => d.split(/\s+/));
/** What a <meta> cannot carry of a header policy: browsers ignore frame-ancestors there. */
const META_LEAVES_OUT = ['frame-ancestors'];

const HEADERS = netlifyHeaders()['/*'];
const SITE_PAGES = ['web/index.html', 'web/404.html'];
const SITE_SCRIPTS = ['web/app.js', 'web/guard.js'];

test('one policy: _headers, .htaccess and nginx.conf send the same headers with the same values', () => {
  assert.ok(HEADERS, '_headers has a /* rule');
  assert.deepEqual(apacheHeaders(), HEADERS, '.htaccess sends exactly what _headers does');
  assert.deepEqual(nginxHeaders(), HEADERS, 'deploy/nginx.conf sends exactly what _headers does');
});

test('one policy: both pages carry the header policy in their <meta>, less what a <meta> cannot say', () => {
  const header = directives(HEADERS['Content-Security-Policy']);
  const want = header.filter(([name]) => !META_LEAVES_OUT.includes(name)).map((d) => d.join(' ')).join('; ');
  for (const name of META_LEAVES_OUT) assert.ok(header.some(([d]) => d === name), 'the header policy sets ' + name);
  for (const file of SITE_PAGES) {
    const meta = metaOf(file);
    assert.equal(meta.csp, want, file + "'s <meta> policy is the header's, directive for directive");
    assert.equal(meta.referrer, HEADERS['Referrer-Policy'], file + "'s referrer <meta> is the header's");
  }
});

test('the policy starts from nothing and allows only what the checker loads', () => {
  const list = directives(HEADERS['Content-Security-Policy']);
  const d = Object.fromEntries(list.map(([name, ...sources]) => [name, sources]));
  assert.equal(list.length, Object.keys(d).length, 'each directive once');
  assert.deepEqual(d['default-src'], ["'none'"]);
  assert.deepEqual(d['script-src'], ["'self'"], "scripts are the site's own files: nothing inline, nothing evaluated");
  assert.deepEqual(d['style-src'], ["'self'"], 'one stylesheet, no inline style');
  assert.deepEqual(d['img-src'], ["'self'", 'blob:'], 'the favicon, and the preview drawn from the picked file');
  assert.deepEqual(d['connect-src'], ["'none'"], 'the checker talks to nobody: the file is read with the File API');
  assert.deepEqual(d['object-src'], ["'none'"]);
  assert.deepEqual(d['base-uri'], ["'none'"]);
  assert.deepEqual(d['form-action'], ["'none'"]);
  assert.deepEqual(d['frame-ancestors'], ["'none'"], 'no other site may frame the checker (clickjacking)');
  assert.deepEqual(d['require-trusted-types-for'], ["'script'"]);
  assert.deepEqual(d['upgrade-insecure-requests'], []);
  assert.deepEqual(Object.keys(d).sort(), ['base-uri', 'connect-src', 'default-src', 'form-action', 'frame-ancestors', 'img-src', 'object-src', 'require-trusted-types-for', 'script-src', 'style-src', 'trusted-types', 'upgrade-insecure-requests'], 'nothing else is allowed');
  for (const [name, sources] of Object.entries(d)) {
    for (const bad of ["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'wasm-unsafe-eval'", "'strict-dynamic'", "'allow-duplicates'", '*', 'data:', 'http:', 'https:']) {
      assert.ok(!sources.includes(bad), name + ' allows ' + bad);
    }
  }
});

test('nothing on either page is inline: no script, no style, no handler', () => {
  for (const file of SITE_PAGES) {
    const html = page(file);
    assert.deepEqual([...html.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\ssrc="[^"]+"/.test(m[1])).map((m) => m[0]), [], file + ' has no inline script');
    assert.doesNotMatch(html, /<style\b/i, file + ' has no <style>');
    assert.doesNotMatch(html, /<[^>]*\son[a-z]+\s*=/i, file + ' has no inline event handler');
    assert.doesNotMatch(html, /<[^>]*\sstyle\s*=/i, file + ' has no style attribute');
    assert.doesNotMatch(html, /\b(?:href|src)\s*=\s*["']?\s*(?:javascript|data):/i, file + ' has no javascript: or data: address');
  }
});

/* Under require-trusted-types-for every HTML string sink throws. This names the line before a
 * browser does, and holds the one string-to-document call to the one place it is meant for. */
test('Trusted Types: the policy names exactly the policy the checker creates, and no script writes HTML', () => {
  const names = directives(HEADERS['Content-Security-Policy']).find(([name]) => name === 'trusted-types').slice(1);
  const sources = SITE_SCRIPTS.map((f) => [f, read(f)]);
  const created = sources.flatMap(([, src]) => [...src.matchAll(/createPolicy\('([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...names].sort(), [...created].sort(), 'trusted-types lists each createPolicy name, once, and nothing else');
  assert.deepEqual(created, ['selfreportle-saved-page']);
  const SINKS = /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\.srcdoc\s*=|\beval\(|new Function\(|createContextualFragment|parseHTMLUnsafe|setHTMLUnsafe|DOMParser/;
  const hits = [];
  for (const [file, src] of sources) {
    src.split('\n').forEach((line, i) => {
      if (SINKS.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) hits.push(file + ':' + (i + 1) + ': ' + line.trim());
    });
  }
  assert.equal(hits.length, 1, 'one line turns a string into a document:\n' + hits.join('\n'));
  assert.match(hits[0], /^web\/app\.js:\d+: return new DOMParser\(\)\.parseFromString\(inertPolicy \? inertPolicy\.createHTML\(quiet\) : quiet, 'text\/html'\);$/, 'and it is parseSavedPage, through the policy');
  const app = read('web/app.js');
  assert.equal([...app.matchAll(/inertPolicy\.createHTML\(/g)].length, 1, 'the policy is used for that parse and nothing else');
  assert.equal([...app.matchAll(/parseSavedPage\(/g)].length, 2, 'parseSavedPage is defined once and called once');
});

test('the other headers: no sniffing, no framing, no referrer, no features, HTTPS remembered, nothing cached unasked', () => {
  assert.equal(HEADERS['X-Content-Type-Options'], 'nosniff');
  assert.equal(HEADERS['X-Frame-Options'], 'DENY', "the old browsers' half of frame-ancestors 'none'");
  // The checker links out to its source and nothing else, and has nothing to tell anyone.
  assert.equal(HEADERS['Referrer-Policy'], 'no-referrer');
  assert.equal(HEADERS['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(HEADERS['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(HEADERS['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  // No file name carries a version or a hash, so nothing may be cached without asking.
  assert.equal(HEADERS['Cache-Control'], 'no-cache');
  const features = HEADERS['Permissions-Policy'].split(',').map((f) => f.trim().split('='));
  for (const [name, allow] of features) assert.equal(allow, '()', name + ' is denied: the checker uses no browser feature a policy governs');
  for (const name of ['camera', 'microphone', 'geolocation', 'display-capture', 'payment', 'usb', 'clipboard-read', 'clipboard-write', 'browsing-topics']) {
    assert.ok(features.some(([f]) => f === name), 'Permissions-Policy names ' + name);
  }
  assert.deepEqual(netlifyHeaders()['/LICENSE'], { 'Content-Type': 'text/plain; charset=utf-8' }, 'the licence is served as text');
  assert.deepEqual(Object.keys(netlifyHeaders()), ['/*', '/LICENSE'], 'one rule for everything, so no host joins two values for one header');
});

/** The repository's files: tracked, plus new ones not yet added, so a file is checked before
 *  its first commit; every file on disk outside node_modules and .git where there is no work
 *  tree (a `git archive` extract). */
function repositoryFiles() {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').filter(Boolean).filter((f) => fs.existsSync(path.join(root, f)));
  } catch (e) {
    const out = [];
    const walk = (rel) => {
      for (const ent of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        const p = rel ? rel + '/' + ent.name : ent.name;
        if (ent.name === 'node_modules' || ent.name === '.git') continue;
        if (ent.isDirectory()) walk(p); else out.push(p);
      }
    };
    walk('');
    return out;
  }
}

const EXCLUDED_MODULES = ['lib/settings.js', 'lib/history.js', 'lib/fetch-policy.js', 'lib/platform-labels.js'];

test('the site is the checker, the lib/ modules it names, and the files every site has', () => {
  assert.deepEqual(site.siteFiles(), [
    '.well-known/security.txt', '404.html', 'LICENSE', 'app.js', 'guard.js', 'icons/icon32.png', 'index.html',
    'lib/attribution.js', 'lib/c2pa-verify.js', 'lib/cbor.js', 'lib/image-hints.js', 'lib/image-metadata.js', 'lib/legitimacy.js',
    'lib/lexicons.js', 'lib/signals.js', 'lib/site-analyzer.js', 'lib/text-analyzer.js', 'lib/verdicts.js', 'lib/x509.js',
    'robots.txt', 'site.css',
  ]);
  for (const [to, from] of Object.entries(site.siteMap())) assert.ok(fs.existsSync(path.join(root, from)), to + ' comes from ' + from + ', which exists');
  // Every lib/ module on disk is either loaded by the page or named here with its reason
  // (web/app.js's header): a new one is a decision, not an accident.
  const libs = fs.readdirSync(path.join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => 'lib/' + f).sort();
  assert.deepEqual([...site.pageModules(), ...EXCLUDED_MODULES].sort(), libs, 'each lib/ module is loaded by the page or left out on purpose');
  for (const m of site.pageModules()) assert.doesNotMatch(read(m), /\bchrome\.(?:storage|runtime|tabs|action|contextMenus)\b/, m + ' reaches no extension API');
  for (const m of EXCLUDED_MODULES) assert.ok(read('web/app.js').includes(path.basename(m)), 'web/app.js says why ' + m + ' is not loaded');
  // Each module the page loads is loaded after what it reads off the shared global.
  const order = site.pageModules().map((m) => path.basename(m));
  for (const m of site.pageModules()) {
    for (const dep of [...read(m).matchAll(/require\('\.\/([a-z0-9-]+\.js)'\)/g)].map((x) => x[1])) {
      assert.ok(order.indexOf(dep) !== -1 && order.indexOf(dep) < order.indexOf(path.basename(m)), m + ' needs ' + dep + ' loaded before it');
    }
  }
  assert.ok(read('web/index.html').indexOf('<script src="app.js">') > read('web/index.html').lastIndexOf('<script src="lib/'), 'app.js comes after every module');
  assert.ok(read('web/index.html').indexOf('<script src="guard.js">') < read('web/index.html').indexOf('<link rel="stylesheet"'), 'the safety net loads before anything it watches');
  const NOT_SITE = /(^|\/)[A-Z-]+\.md$|^(test|scripts|deploy|node_modules|\.github|\.claude|background|content|popup|options|publisher)\/|(^|\/)(_headers|_redirects|\.htaccess|package(-lock)?\.json|manifest\.json)$/;
  assert.deepEqual(site.siteFiles().filter((f) => NOT_SITE.test(f)), [], 'no notes, tests, scripts, extension pages or hosting configs');
  assert.deepEqual(site.siteFiles().filter((f) => f.split('/').some((part) => part.startsWith('.')) && f !== '.well-known/security.txt'), [], 'no dotfile but the security contact');
});

/* The allowlist Apache and nginx answer from: every site path passes, and every other file of
 * the repository — the extension's own scripts, the notes, the tests, .git, the configs — is a
 * 404, so a server pointed at a checkout by mistake still publishes only the site. */
test('Apache and nginx serve the site and refuse everything else in the repository', () => {
  const apache = read('web/.htaccess').match(/^\s*RewriteRule !\^(.+)\?\$ - \[R=404,L\]$/m);
  const nginx = read('deploy/nginx.conf').match(/^\s*location ~ \^\/(.+)\$ \{$/m);
  assert.ok(apache, '.htaccess has the allowlist rule');
  assert.ok(nginx, 'nginx.conf has the allowlist location');
  assert.equal(apache[1], nginx[1], 'the two allowlists are the same pattern');
  const allowed = new RegExp('^' + apache[1] + '$');
  const served = (p) => p === '' || allowed.test(p);
  for (const f of site.siteFiles()) assert.ok(served(f), f + ' is served');
  const outside = [...repositoryFiles(), '.git/config', '.git/HEAD', '.htaccess', '_headers', '_redirects', 'lib/', 'icons/', '.well-known/', 'deploy/nginx.conf', 'web/index.html', 'lib/settings.js', 'icons/icon128.png']
    .filter((f) => !site.siteFiles().includes(f));
  assert.ok(outside.length > 60, 'the walk found the repository');
  assert.deepEqual(outside.filter(served), [], 'served although not part of the site');
  assert.match(read('web/.htaccess'), /^Options -Indexes$/m);
  assert.match(read('web/.htaccess'), /^ErrorDocument 404 %BASE%404\.html$/m);
  assert.match(read('web/.htaccess'), /^ErrorDocument 403 %BASE%404\.html$/m);
  const conf = read('deploy/nginx.conf');
  for (const line of ['server_tokens off;', 'autoindex off;', 'error_page 403 404 =404 /404.html;', 'return 301 https://$host$request_uri;', 'location / {']) {
    assert.ok(conf.includes(line), 'nginx.conf: ' + line);
  }
});

test('Netlify refuses its own configs, forced', () => {
  const rules = read('web/_redirects').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).map((l) => l.trim().split(/\s+/));
  assert.deepEqual(rules, [['/_headers', '/404.html', '404!'], ['/_redirects', '/404.html', '404!']]);
});

test('each host gets its own config, and a folder holding anything else is refused', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(site.HOST_FILES).map(([h, f]) => [h, Object.keys(f)])), {
    pages: [], nginx: [], netlify: ['_headers', '_redirects'], cloudflare: ['_headers'], apache: ['.htaccess'],
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srl-site-'));
  try {
    const out = path.join(tmp, 'site');
    const written = site.build(out, { host: 'apache', base: '/selfreportle/' });
    assert.deepEqual(written.sort(), [...site.siteFiles(), '.htaccess'].sort());
    const notFound = fs.readFileSync(path.join(out, '404.html'), 'utf8');
    assert.doesNotMatch(notFound, /%BASE%/, 'the base path is written into the not-found page');
    assert.match(notFound, /<link rel="stylesheet" href="\/selfreportle\/site\.css">/);
    assert.match(notFound, /<a class="btn" href="\/selfreportle\/">/);
    assert.match(fs.readFileSync(path.join(out, '.htaccess'), 'utf8'), /^ErrorDocument 404 \/selfreportle\/404\.html$/m);
    assert.equal(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), read('web/index.html'), 'the page goes out as written');
    assert.throws(() => site.build(out, { host: 'apache' }), /not empty/, 'a folder that already holds something is refused');
    assert.throws(() => site.build(path.join(tmp, 'x'), { host: 'iis' }), /unknown host/);
    assert.throws(() => site.build(root, {}), /not empty/, 'the checkout itself is never a publish folder');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  for (const good of ['/', '/selfreportle/', '/a/b-c_d.e~/']) assert.equal(site.checkBase(good), good);
  // The base is written into a link, a stylesheet address and an Apache directive.
  for (const bad of ['', 'selfreportle/', '/selfreportle', '//evil.example/', '/../', '/a/./', '/a b/', '/a"/', '/a\n/', 'javascript:alert(1)//', '/%2e%2e/']) {
    assert.throws(() => site.checkBase(bad), /--base/, JSON.stringify(bad) + ' is refused');
  }
});

test('the files every site has: robots.txt, the security contact, the not-found page, the version', () => {
  assert.match(read('web/robots.txt'), /^User-agent: \*$/m);
  const sec = read('web/.well-known/security.txt');
  const field = (name) => (sec.match(new RegExp('^' + name + ': (.+)$', 'm')) || [])[1];
  assert.equal(field('Contact'), 'https://github.com/Platteration/selfreportle/security/advisories/new', 'the private route SECURITY.md asks for');
  assert.equal(field('Policy'), 'https://github.com/Platteration/selfreportle/blob/HEAD/SECURITY.md');
  assert.equal(field('Preferred-Languages'), 'en');
  const expires = Date.parse(field('Expires'));
  assert.ok(expires > Date.now(), 'security.txt has expired: renew Expires, a year ahead at most');
  assert.ok(expires - Date.now() <= 366 * 24 * 3600 * 1000, 'security.txt Expires is at most a year ahead (RFC 9116)');
  const notFound = read('web/404.html');
  assert.match(notFound, /<meta name="robots" content="noindex">/);
  assert.doesNotMatch(page('web/404.html'), /<script\b/, 'the not-found page runs nothing');
  // Answered at any depth, so its addresses start from the site's root, never from the page.
  for (const m of page('web/404.html').matchAll(/\s(?:href|src)="([^"]*)"/g)) assert.match(m[1], /^%BASE%/, 'the not-found page links from the base: ' + m[1]);
  const manifest = JSON.parse(read('manifest.json'));
  assert.match(read('web/index.html'), new RegExp('<span id="version">' + manifest.version.replace(/\./g, '\\.') + '</span>'), 'the page shows the version the extension ships');
  assert.ok(read('web/index.html').includes('<a href="https://github.com/Platteration/selfreportle" rel="noopener noreferrer">MIT licence · source</a>'), 'the licence and source link');
  assert.match(read('web/index.html'), /<html lang="en" class="no-js">/, 'the page starts as no-js, which the safety net takes off');
});

/* A saved page chooses its own shape, up to the 8 MB the checker reads. Asking closest() of every
 * candidate walked each one's ancestors — 512 of them on a page nested as deep as the parser
 * allows, two minutes on 8 MB — and looking <main> up again for every block scanned the whole
 * document 600 times (38 s). test/e2e/site.js times each such page beside a control; this keeps
 * the unit suite from going green on a revert. */
test('a saved page is walked once: no closest() per candidate, no lookup per block', () => {
  const app = read('web/app.js');
  assert.ok(!/\.closest\(SKIP_SEL\)\) continue/.test(app), 'no candidate asks its ancestors whether to skip it');
  assert.match(app, /for \(const elm of unskipped\(doc, BLOCK_SEL\)\)/);
  assert.match(app, /for \(const elm of unskipped\(doc, 'div, span, section, article'\)\)/);
  assert.match(app, /acceptNode: \(node\) => \(DOM\.matches\(node, SKIP_SEL\) \? NodeFilter\.FILTER_REJECT : DOM\.matches\(node, sel\) \? NodeFilter\.FILTER_ACCEPT : NodeFilter\.FILTER_SKIP\)/,
    'a skipped subtree is stepped over whole');
  assert.match(app, /const mainEl = doc\.querySelector\('main, article, \[role="main"\]'\);\n\s+return combineBlocks\(blocks, opts, \(b\) => !mainEl \|\| DOM\.contains\(mainEl, b\.el\)\);/,
    '<main> is looked up once, before the blocks are filtered');
});
