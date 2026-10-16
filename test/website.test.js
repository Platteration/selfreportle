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

/** Every `Header always set` in web/.htaccess, as { Header: value }. A condition after the value
 *  (`env=HTTPS` left HSTS off everything a TLS-terminating proxy forwarded) fails the count below. */
function apacheHeaders() {
  const conf = read('web/.htaccess');
  const out = {};
  for (const m of conf.matchAll(/^Header always set ([A-Za-z-]+) "([^"]*)"$/gm)) {
    assert.ok(!Object.prototype.hasOwnProperty.call(out, m[1]), '.htaccess: ' + m[1] + ' is set once');
    out[m[1]] = m[2];
  }
  assert.equal([...conf.matchAll(/^\s*Header\b/gm)].length, Object.keys(out).length, '.htaccess sets every header with `Header always set` and a quoted value');
  return out;
}

/** deploy/nginx.conf without its comments, and the block of the one location that proxies the
 *  site's API (`location ^~ /api/`), apart. */
function nginxParts() {
  const conf = read('deploy/nginx.conf').replace(/^\s*#.*$/gm, '');
  const api = [...conf.matchAll(/^ {2}location \^~ \/api\/ \{\n([^}]*)^ {2}\}\n/gm)];
  assert.equal(api.length, 1, 'nginx.conf: one `location ^~ /api/` block');
  return { site: conf.replace(api[0][0], ''), api: api[0][1] };
}

/** Every `add_header` in deploy/nginx.conf outside the API's location, as { Header: value }.
 *  Each must carry `always`, or nginx leaves it off the 404 page and every other error response. */
function nginxHeaders() {
  const { site: conf } = nginxParts();
  const out = {};
  for (const m of conf.matchAll(/^\s*add_header\s+([A-Za-z-]+)\s+"([^"]*)"\s+always;\s*$/gm)) {
    assert.ok(!Object.prototype.hasOwnProperty.call(out, m[1]), 'nginx.conf: ' + m[1] + ' is set once');
    out[m[1]] = m[2];
  }
  assert.equal([...conf.matchAll(/^\s*add_header\b/gm)].length, Object.keys(out).length, 'nginx.conf: every add_header is quoted and `always`');
  // add_header in a location replaces every inherited one there, so they all live at server level,
  // but for the API's location, whose one header the next test holds
  assert.doesNotMatch(conf, /location[^{]*\{[^}]*add_header/, 'nginx.conf: no location but the API\'s sets a header of its own');
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
const SITE_SCRIPTS = ['web/app.js', 'web/account.js', 'web/guard.js'];

test('one policy: _headers, .htaccess and nginx.conf send the same headers with the same values', () => {
  assert.ok(HEADERS, '_headers has a /* rule');
  assert.deepEqual(apacheHeaders(), HEADERS, '.htaccess sends exactly what _headers does');
  assert.deepEqual(nginxHeaders(), HEADERS, 'deploy/nginx.conf sends exactly what _headers does');
});

/* The site's API (server/kit) sends its own headers: a policy of its own, no-store, no referrer.
 * In nginx a location with one add_header inherits none of the server block's, which is what
 * keeps the site's policy and Cache-Control from being sent beside the API's (a browser reads the
 * last of two Referrer-Policy values); its one header is HSTS, as the server block writes it. */
test("nginx hands everything under /api/ to the site's API, and sends nothing of its own there but HSTS", () => {
  const { api } = nginxParts();
  const lines = api.split('\n').map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines, [
    'proxy_pass http://127.0.0.1:8788;',
    'proxy_http_version 1.1;',
    'proxy_set_header Connection "";',
    'client_max_body_size 1m;',
    'proxy_read_timeout 30s;',
    'add_header Strict-Transport-Security "' + HEADERS['Strict-Transport-Security'] + '" always;',
    'error_page 502 503 504 = @api-off;',
    'recursive_error_pages on;',
  ], 'proxy_pass with no URI (the path reaches the API unchanged), to the loopback port server/start.mjs listens on, HSTS as the server block sends it, and nginx\'s own errors handed to @api-off');
  const conf = read('deploy/nginx.conf').replace(/^\s*#.*$/gm, '');
  assert.ok(conf.indexOf('location ^~ /api/ {') > conf.indexOf('listen 443 ssl http2;'), 'in the https server block');
  assert.equal([...conf.matchAll(/\bproxy_pass\b/g)].length, 1, 'nothing else is proxied');
  assert.doesNotMatch(conf, /proxy_intercept_errors/, "the API's own answers (its 404, 401 and 409) go out as it sends them");
  // With the API not running, nginx answers as a site with no API (test/e2e/hosts.js runs it): the
  // folder's api/config, typed, and the not-found page for the rest. The location adds no header,
  // so it sends the server block's, all of them (nginxHeaders holds that no location but the
  // API's adds one).
  const off = [...conf.matchAll(/^ {2}location @api-off \{\n([^}]*)^ {2}\}\n/gm)];
  assert.equal(off.length, 1, 'nginx.conf has one `location @api-off`');
  assert.ok(conf.indexOf('location @api-off {') > conf.indexOf('listen 443 ssl http2;'), 'in the https server block');
  assert.deepEqual(off[0][1].split('\n').map((l) => l.trim()).filter(Boolean), ['default_type application/json;', 'try_files $uri =404;']);
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
  assert.deepEqual(d['connect-src'], ["'self'"], "the site's own api/ (account.js) and nothing else: the file is read with the File API and never sent");
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

const EXCLUDED_MODULES = ['lib/settings.js', 'lib/history.js', 'lib/fetch-policy.js', 'lib/byte-budget.js', 'lib/platform-labels.js', 'lib/text-display.js'];

test('the site is the checker, the lib/ modules it names, and the files every site has', () => {
  assert.deepEqual(site.siteFiles(), [
    '.well-known/security.txt', '404.html', 'LICENSE', 'account.js', 'api/config', 'app.js', 'guard.js', 'icons/icon32.png', 'index.html',
    'lib/attribution.js', 'lib/c2pa-verify.js', 'lib/cbor.js', 'lib/image-hints.js', 'lib/image-metadata.js', 'lib/legitimacy.js',
    'lib/lexicons.js', 'lib/model-catalog.js', 'lib/research.js', 'lib/signals.js', 'lib/site-analyzer.js', 'lib/text-analyzer.js', 'lib/verdicts.js', 'lib/x509.js',
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
  // account.js comes after app.js, which marks the page started: a failure of the account's (the
  // file missing, a throw) then leaves the checker working and the safety net quiet.
  assert.ok(page('web/index.html').indexOf('<script src="account.js">') > page('web/index.html').indexOf('<script src="app.js">'), 'account.js comes after app.js');
  assert.equal([...page('web/index.html').matchAll(/<script src="account\.js"><\/script>/g)].length, 1);
  assert.ok(read('web/index.html').indexOf('<script src="guard.js">') < read('web/index.html').indexOf('<link rel="stylesheet"'), 'the safety net loads before anything it watches');
  const NOT_SITE = /(^|\/)[A-Z-]+\.md$|^(test|scripts|deploy|node_modules|\.github|\.claude|background|content|popup|options|publisher|server|functions)\/|(^|\/)(_headers|_redirects|_routes\.json|\.htaccess|package(-lock)?\.json|manifest\.json)$/;
  assert.deepEqual(site.siteFiles().filter((f) => NOT_SITE.test(f)), [], "no notes, tests, scripts, extension pages, hosting configs or the API's code");
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

/* Apache reads .htaccess whole, and so does this: a line it does not know fails here. Each
 * line is one of these forms, with nothing wrapped round it and nothing after a header's value.
 * The rules sat in <IfModule> once, and Debian and Ubuntu ship mod_rewrite and mod_headers off:
 * there the folder was served whole, .git/ included, with none of the headers and nothing in the
 * log. test/e2e/hosts.js runs the file in a real Apache with and without the modules. */
test('.htaccess wraps nothing in <IfModule> and holds only the lines this test reads', () => {
  const lines = read('web/.htaccess').split('\n').filter((l) => l.trim() && !l.trimStart().startsWith('#'));
  const KNOWN = [
    /^Options -Indexes$/, /^ServerSignature Off$/, /^AddDefaultCharset utf-8$/, /^DirectoryIndex index\.html$/,
    /^ErrorDocument 40[34] %BASE%404\.html$/, /^AddType [a-z]+\/[a-z]+ \.[a-z]+$/,
    /^<Files "LICENSE">$/, /^ {2}ForceType text\/plain$/, /^<\/Files>$/,
    /^RewriteEngine On$/, /^RewriteCond /, /^RewriteRule /, /^Header always set [A-Za-z-]+ "[^"]*"$/,
  ];
  assert.deepEqual(lines.filter((l) => !KNOWN.some((re) => re.test(l))), [], 'every line is one this test knows');
  assert.deepEqual(lines.filter((l) => /<\/?IfModule/i.test(l)), [], 'no <IfModule>');
  // the redirect's two conditions, then the redirect, then the allowlist the test above reads
  assert.deepEqual(lines.filter((l) => /^Rewrite/.test(l)).map((l) => l.replace(/^(RewriteRule !\^).*$/, '$1…')), [
    'RewriteEngine On',
    'RewriteCond %{HTTPS} !=on',
    'RewriteCond %{HTTP:X-Forwarded-Proto} !=https',
    'RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [R=301,L]',
    'RewriteRule !^…',
  ]);
});

/* `http2 on;` is nginx 1.25.1 and later; 1.24, which Ubuntu 24.04 ships, refused the whole file
 * over it. test/e2e/hosts.js loads the file into the nginx installed where it runs. */
test('nginx.conf asks for HTTP/2 the way nginx 1.22 and 1.24 read it', () => {
  const conf = read('deploy/nginx.conf').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(conf, /^\s*http2\b/m, 'no `http2` directive');
  assert.deepEqual([...conf.matchAll(/^\s*listen\b.*$/gm)].map((m) => m[0].trim()), ['listen 80;', 'listen [::]:80;', 'listen 443 ssl http2;', 'listen [::]:443 ssl http2;']);
});

test('Netlify refuses its own configs, forced', () => {
  const rules = read('web/_redirects').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).map((l) => l.trim().split(/\s+/));
  assert.deepEqual(rules, [['/_headers', '/404.html', '404!'], ['/_redirects', '/404.html', '404!']]);
});

test('each host gets its own config, and a folder holding anything else is refused', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(site.HOST_FILES).map(([h, f]) => [h, Object.keys(f)])), {
    pages: [], nginx: [], netlify: ['_headers', '_redirects'], cloudflare: ['_headers', '_routes.json'], apache: ['.htaccess'],
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

/* The extension and the website's API never meet. Only the website (web/account.js) talks to the
 * site's api/; the extension reads the pages a reader browses and keeps what it finds on the
 * device, so none of its files may reach for the API, Google's sign-in or Stripe, and its manifest
 * asks for exactly what it asked for before the website had an API: no new permission, no new
 * host, no OAuth client of its own. */
test('the extension never calls the website\'s API, and its manifest asks for nothing new', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.deepEqual(manifest.permissions, ['storage', 'contextMenus'], 'the permissions it has always had, and no identity');
  assert.deepEqual(manifest.host_permissions, ['<all_urls>'], 'the media fetches: no host added for the API');
  for (const key of ['optional_permissions', 'optional_host_permissions', 'oauth2', 'key', 'externally_connectable', 'web_accessible_resources']) {
    assert.equal(manifest[key], undefined, 'no ' + key);
  }
  const DIRS = ['lib', 'background', 'content', 'popup', 'options', 'publisher'];
  const files = DIRS.flatMap((d) => fs.readdirSync(path.join(root, d)).map((f) => d + '/' + f)).filter((f) => /\.(js|html|css)$/.test(f));
  assert.ok(files.length > 25 && files.includes('background/service-worker.js') && files.includes('content/content.js'), 'the walk finds the extension');
  const BACKEND = /\bapi\/(?:config|me|checkout|portal|auth|webhooks)\b|accounts\.google\.com|googleapis\.com|stripe\.com|chrome\.identity|\baccount\.js\b|SRL\.account\b|server\/kit|functions\/api/;
  assert.deepEqual(['manifest.json', ...files].filter((f) => BACKEND.test(read(f))), [], 'no extension file names the API, Google sign-in or Stripe');
  // What the extension loads is its own: nothing of the website's, the API's or the tests'.
  const loaded = [
    manifest.background.service_worker,
    ...manifest.content_scripts.flatMap((c) => [...c.js, ...(c.css || [])]),
    ...[...read(manifest.background.service_worker).matchAll(/importScripts\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/'\.\.\/([^']+)'/g)].map((x) => x[1])),
    manifest.action.default_popup, manifest.options_ui.page,
  ];
  assert.ok(loaded.length > 15);
  assert.deepEqual(loaded.filter((f) => !DIRS.some((d) => f.startsWith(d + '/'))), [], 'every file the manifest loads lives in the extension\'s own folders');
});

/* What leaves the visitor's device, said exactly for each case: with no API (every static host),
 * the page asks api/config once and nothing else; where sign-in is offered, account.js swaps in
 * the line that says what Google and Stripe are told and what the site keeps. */
test('the page says exactly what leaves the device, with the API and without it', () => {
  const html = page('web/index.html');
  const p = (id) => (html.match(new RegExp('<p class="privacy" id="' + id + '"( hidden)?>([^<]+)</p>')) || []).slice(1);
  assert.deepEqual(p('privacyLocal'), [undefined, 'Everything runs in this page. The file you pick is read by your browser and never uploaded; once the page has loaded, it asks this site only whether it offers sign-in, and sends nothing about you or your file.']);
  assert.deepEqual(p('privacyAccount'), [' hidden', "Everything runs in this page. The file you pick is read by your browser and never uploaded. Nothing else leaves your device unless you sign in or buy: then Google tells this site an account id and your email address, and Stripe handles the payment and is told that account id with it. The site keeps the account id, what was bought and Stripe's customer id, and your email address while you are signed in."]);
  assert.match(html, /<section class="account" id="account" aria-labelledby="account-heading" hidden>/, 'the account section starts hidden, and only account.js shows it');
  for (const id of ['account', 'accountBody', 'accountNote', 'privacyLocal', 'privacyAccount']) {
    assert.equal([...html.matchAll(new RegExp('\\sid="' + id + '"', 'g'))].length, 1, 'the page has #' + id + ' once');
    assert.ok(read('web/account.js').includes("$('" + id + "')"), 'account.js finds #' + id);
  }
  assert.match(html, /<p id="accountNote" class="account-note" role="status" aria-live="polite"><\/p>/, 'notes are announced');
});
