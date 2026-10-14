/*
 * The website on real hosts: deploy/nginx.conf loaded into the nginx installed here, and the
 * built site's .htaccess read by the Apache installed here, each serving the folder
 * scripts/build-site.js wrote, with the repository's own files planted in it as if a checkout had
 * been copied over it. test/website.test.js reads both files and holds them equal to web/_headers;
 * only the servers show what the files do. Each was found doing something other than what it said:
 * nginx before 1.25.1 refused the whole file over `http2 on;`, Apache without mod_rewrite and
 * mod_headers served .git/ and every other file with none of the headers (the rules sat in
 * <IfModule>), and Apache sent no HSTS behind a TLS-terminating proxy (`env=HTTPS`).
 *
 * The site's API (server/start.mjs, server/kit) runs here too, in this process with a fake Google
 * and a fake Stripe injected into the kit: behind nginx's `location ^~ /api/`, which must hand it
 * every address under /api/ with its own headers and none of the site's but HSTS (one add_header
 * in a location drops every inherited one), and behind the Apache ProxyPass that .htaccess and
 * README.md tell an owner to put in the virtual host, since .htaccess cannot proxy.
 *
 * Needs nginx, Apache as Debian and Ubuntu lay it out (/usr/sbin/apache2, its modules in
 * /usr/lib/apache2/modules) and openssl. GitHub's ubuntu-24.04 runner has all of them, at the
 * versions Ubuntu 24.04 ships (nginx 1.24.0, Apache 2.4.58). Where one is missing this says so and
 * passes, unless CI is set: skipped there, it would read as passed.
 *
 *   npm run test:e2e  (after the extension's run and the site's), or node test/e2e/hosts.js
 */
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');
const site = require('../../scripts/build-site.js');

const root = path.resolve(__dirname, '..', '..');
const BASE = '/selfreportle/';
const NOT_FOUND = 'That page isn’t here';
const MODULES = '/usr/lib/apache2/modules';

const which = (name, fallback) => {
  const found = spawnSync('sh', ['-c', 'command -v ' + name], { encoding: 'utf8' }).stdout.trim();
  return found || (fs.existsSync(fallback) ? fallback : null);
};
const NGINX = which('nginx', '/usr/sbin/nginx');
const APACHE = fs.existsSync(path.join(MODULES, 'mod_rewrite.so')) ? which('apache2', '/usr/sbin/apache2') : null;
const OPENSSL = which('openssl', '/usr/bin/openssl');
const missing = [
  ...(NGINX && fs.existsSync('/etc/nginx/mime.types') ? [] : ['nginx (and /etc/nginx/mime.types)']),
  ...(APACHE ? [] : ['Apache (apache2 and ' + MODULES + ')']),
  ...(OPENSSL ? [] : ['openssl']),
  ...(fs.existsSync('/etc/mime.types') ? [] : ['/etc/mime.types']),
];
if (missing.length) {
  const note = 'hosts: not installed here: ' + missing.join(', ');
  if (process.env.CI) {
    console.error(note + '. CI runs this on a runner that has them, so this is a failure.');
    process.exit(1);
  }
  console.log(note + '. SKIPPED: the real nginx and Apache were not run; CI runs them.');
  process.exit(0);
}

/** web/_headers' rules, which every host must match: the site-wide set, and the licence's type. */
function headerRules() {
  const rules = {};
  let current = null;
  for (const line of fs.readFileSync(path.join(root, 'web/_headers'), 'utf8').split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) { current = rules[line.trim()] = {}; continue; }
    const m = line.match(/^\s+([A-Za-z-]+):\s*(.+)$/);
    current[m[1].toLowerCase()] = m[2].trim();
  }
  return rules;
}
const RULES = headerRules();
const SITE_HEADERS = RULES['/*'];
assert.ok(SITE_HEADERS && Object.keys(SITE_HEADERS).length >= 9, 'web/_headers has its site-wide rule');

const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer().once('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

/** One request: status, headers and body. A self-signed certificate is accepted. */
const get = (url, headers = {}) => new Promise((resolve, reject) => {
  const lib = url.startsWith('https:') ? https : http;
  const req = lib.get(url, { headers, rejectUnauthorized: false, agent: false }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.setTimeout(10000, () => req.destroy(new Error(url + ': no answer in 10 s')));
});

/** One POST with an empty JSON body: status, headers and body. */
const post = (url, headers = {}) => new Promise((resolve, reject) => {
  const req = https.request(url, { method: 'POST', headers, rejectUnauthorized: false, agent: false }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.setTimeout(10000, () => req.destroy(new Error(url + ': no answer in 10 s')));
  req.end('{}');
});

async function waitFor(url, headers, log) {
  for (let i = 0; i < 100; i++) {
    try { return await get(url, headers); } catch (e) { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error(url + ' never answered:\n' + log());
}

/* Under the system's temporary folder and readable by everyone, because a server started as root
 * reads it as an unprivileged user. */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'srl-hosts-'));
fs.chmodSync(work, 0o755);
const asRoot = process.getuid && process.getuid() === 0;

/* What a checkout copied over the site brings: none of it may be served. Each holds the word
 * PLANTED, which no file of the site does, so a body that has it is one of these handed out. */
const PLANTED = ['README.md', '.git/config', '.git/HEAD', '.env', 'manifest.json', 'lib/settings.js', 'background/service-worker.js', 'test/helpers.js', 'deploy/nginx.conf', '_headers'];
function siteFor(label, host, base) {
  const dir = path.join(work, label, 'site');
  site.build(dir, { host, base });
  for (const file of PLANTED) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), 'PLANTED ' + file + '\n');
  }
  spawnSync('chmod', ['-R', 'a+rX', work]);
  return dir;
}

/** Every site path is a 200; the planted files, the folders and a missing page the not-found page. */
const SERVED = ['', ...site.siteFiles()];
/** What the API (server/kit) sends on every answer, and what it never does: the site's own
 *  headers, which a location that inherited them would send beside its own. */
const KIT_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'";
const SITE_ONLY = ['permissions-policy', 'x-frame-options', 'cross-origin-opener-policy'];

/** The API as server/start.mjs runs it, on a loopback port of its own, with the fakes injected. */
async function startApi(appUrl) {
  const { start } = await import('../../server/start.mjs');
  const F = await import('../api-fakes.mjs');
  const fakes = await F.createFakes();
  const dataDir = fs.mkdtempSync(path.join(work, 'api-'));
  const log = [];
  const api = await start({ env: F.envFor(appUrl), dataDir, port: 0, fetch: fakes.fetch, log: (level, message) => log.push(level + ': ' + message) });
  return { api, fakes, log, port: new URL(api.url).port };
}

/** The API's answers through a host that proxies `apiBase` (the site's api/ path) to it. */
async function apiThrough(label, origin, apiBase, appUrl) {
  const problems = [];
  const config = await get(origin + apiBase + 'config');
  let body = null;
  try { body = JSON.parse(config.body); } catch (e) { problems.push('api/config is not JSON: ' + config.body.slice(0, 80)); }
  if (config.status !== 200 || !body || body.auth.google !== true || !body.shop.products.some((x) => x.id === 'supporter' && x.price)) problems.push('api/config answered ' + config.status + ' ' + config.body.slice(0, 120));
  for (const [name, want] of [['content-security-policy', KIT_CSP], ['cache-control', 'public, max-age=60'], ['referrer-policy', 'no-referrer'], ['x-content-type-options', 'nosniff'], ['cross-origin-resource-policy', 'same-origin'], ['strict-transport-security', SITE_HEADERS['strict-transport-security']]]) {
    if (config.headers[name] !== want) problems.push('api/config ' + name + ': ' + config.headers[name] + ', not ' + want);
  }
  for (const name of SITE_ONLY) if (config.headers[name] !== undefined) problems.push("api/config carries the site's " + name);
  const start = await get(origin + apiBase + 'auth/google/start?return=%2F');
  const google = start.headers.location ? new URL(start.headers.location) : null;
  if (start.status !== 302 || !google || google.origin + google.pathname !== 'https://accounts.google.com/o/oauth2/v2/auth' || google.searchParams.get('redirect_uri') !== appUrl + 'api/auth/google/callback') problems.push('api/auth/google/start answered ' + start.status + ' ' + start.headers.location);
  if (!/^__Host-selfreportle-oauth=[^;]+; /.test([].concat(start.headers['set-cookie'] || [])[0] || '')) problems.push('no sign-in cookie: ' + start.headers['set-cookie']);
  if (start.headers['referrer-policy'] !== 'no-referrer') problems.push('the redirect to Google carries Referrer-Policy ' + start.headers['referrer-policy']);
  const unknown = await get(origin + apiBase + 'nothing');
  if (unknown.status !== 404 || !/^application\/json/.test(unknown.headers['content-type'] || '') || unknown.body.includes(NOT_FOUND)) problems.push("api/nothing is not the API's JSON 404: " + unknown.status + ' ' + unknown.headers['content-type']);
  check(problems.length === 0, label + ": everything under api/ is the API's, with its own headers and HSTS, and none of the site's" + (problems.length ? '\n  ' + problems.join('\n  ') : ''));
}
const REFUSED = [...PLANTED, '.htaccess', 'lib/', 'icons/', '.well-known/', 'no/such/page'];

const children = [];
let failures = 0;
function check(ok, msg) {
  console.log((ok ? 'ok   ' : 'FAIL ') + msg);
  if (!ok) failures++;
}
/** Every header _headers gives every path, on a response the server sent. */
function headerProblems(response) {
  return Object.entries(SITE_HEADERS).filter(([name, value]) => response.headers[name] !== value).map(([name, value]) => name + ': ' + response.headers[name] + ', not ' + value);
}

async function nginx() {
  const dir = path.join(work, 'nginx');
  const folder = siteFor('nginx', 'nginx', '/');
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  spawnSync(OPENSSL, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
  const [plain, tls] = [await freePort(), await freePort()];
  const origin = 'https://127.0.0.1:' + tls + '/';
  const backend = await startApi(origin);
  /* deploy/nginx.conf as its header says to install it: root and the certificate paths set, and
   * here the ports. Each edit has to find its line exactly once, so a file that has moved on fails
   * here rather than being tested as something it no longer is. The listen lines keep whatever
   * else they ask for. */
  let conf = fs.readFileSync(path.join(root, 'deploy/nginx.conf'), 'utf8');
  const edit = (from, to) => {
    const found = typeof from === 'string' ? conf.split(from).length - 1 : [...conf.matchAll(new RegExp(from.source, 'gm'))].length;
    assert.equal(found, 1, 'deploy/nginx.conf: ' + from + ' once');
    conf = conf.replace(from, to);
  };
  edit('  listen 80;\n', '  listen 127.0.0.1:' + plain + ';\n');
  edit('  listen [::]:80;\n', '');
  edit(/^ {2}listen 443 ([^;\n]*);$/m, '  listen 127.0.0.1:' + tls + ' $1;');
  edit(/^ {2}listen \[::\]:443 [^;\n]*;\n/m, '');
  edit('  root /var/www/selfreportle;\n', '  root ' + folder + ';\n');
  edit('/etc/letsencrypt/live/example.com/fullchain.pem', path.join(dir, 'cert.pem'));
  edit('/etc/letsencrypt/live/example.com/privkey.pem', path.join(dir, 'key.pem'));
  edit('    proxy_pass http://127.0.0.1:8788;\n', '    proxy_pass http://127.0.0.1:' + backend.port + ';\n');
  fs.writeFileSync(path.join(dir, 'site.conf'), conf);
  // The http {} block a stock Debian or Ubuntu nginx.conf includes it from, less the logging.
  const temp = ['client_body', 'proxy', 'fastcgi', 'uwsgi', 'scgi'].map((t) => '  ' + t + '_temp_path ' + path.join(dir, t + '_temp') + ';');
  fs.writeFileSync(path.join(dir, 'nginx.conf'), [
    ...(asRoot ? ['user www-data;'] : []),
    'worker_processes 1;',
    'pid ' + path.join(dir, 'nginx.pid') + ';',
    'events {}',
    'http {',
    '  include /etc/nginx/mime.types;',
    '  default_type application/octet-stream;',
    '  access_log off;',
    ...temp,
    '  include ' + path.join(dir, 'site.conf') + ';',
    '}',
    '',
  ].join('\n'));
  const args = ['-p', dir, '-e', path.join(dir, 'logs', 'error.log'), '-c', path.join(dir, 'nginx.conf')];
  const version = spawnSync(NGINX, ['-v'], { encoding: 'utf8' }).stderr.trim().replace(/^nginx version: /, '');

  const loaded = spawnSync(NGINX, ['-t', ...args], { encoding: 'utf8' });
  check(loaded.status === 0 && !/\[emerg\]/.test(loaded.stderr), version + ' loads deploy/nginx.conf' + (loaded.status === 0 ? '' : ':\n' + loaded.stderr));
  if (loaded.status !== 0) return;

  const server = spawn(NGINX, [...args, '-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (d) => { output += d; });
  server.stderr.on('data', (d) => { output += d; });
  children.push(server);
  await waitFor(origin, {}, () => output + fs.readFileSync(path.join(dir, 'logs', 'error.log'), 'utf8'));

  const served = [];
  // Everything under api/ is the API's (below), api/config included: the folder's copy is for a
  // host that runs no API.
  for (const p of SERVED.filter((x) => !x.startsWith('api/'))) {
    const r = await get(origin + p);
    if (r.status !== 200) served.push('/' + p + ' answered ' + r.status);
    served.push(...headerProblems(r).map((x) => '/' + p + ' ' + x));
  }
  check(served.length === 0, 'nginx: every path of the site answers 200, with every header _headers gives it' + (served.length ? '\n  ' + served.join('\n  ') : ''));
  check((await get(origin + 'LICENSE')).headers['content-type'] === RULES['/LICENSE']['content-type'], 'nginx: the licence is text, as _headers says');
  check(/^(text|application)\/javascript/.test((await get(origin + 'app.js')).headers['content-type']), 'nginx: a script is served as one');

  const refused = [];
  for (const p of REFUSED) {
    const r = await get(origin + p);
    if (r.status !== 404 || !r.body.includes(NOT_FOUND)) refused.push('/' + p + ' answered ' + r.status + (r.body.includes(NOT_FOUND) ? '' : ' without the not-found page'));
    refused.push(...headerProblems(r).map((x) => '/' + p + ' ' + x));
  }
  check(refused.length === 0, "nginx: the repository's files, the host configs and the folders answer the not-found page, with every header" + (refused.length ? '\n  ' + refused.join('\n  ') : ''));

  const redirect = await get('http://127.0.0.1:' + plain + '/a/b?x=1');
  check(redirect.status === 301 && redirect.headers.location === 'https://127.0.0.1/a/b?x=1', 'nginx: port 80 redirects to https');

  await apiThrough('nginx', origin, 'api/', origin);
  const logout = await new Promise((resolve, reject) => {
    const req = https.request(origin + 'api/auth/logout', { method: 'POST', headers: { origin: origin.replace(/\/$/, '') }, rejectUnauthorized: false, agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
  check(logout === 204, "nginx: a POST from the site's own origin reaches the API with its Origin (" + logout + ')');
  check(backend.log.length === 0 && backend.fakes.unexpected.length === 0, 'nginx: the API logged nothing and asked the fakes nothing unexpected' + (backend.log.length ? ': ' + backend.log.join(' | ') : ''));
  await backend.api.close();
  /* With the API stopped, nginx answers as a site with no API does (@api-off): the folder's
   * api/config, typed, so the page reads "nothing on" with nothing on its console, and the
   * not-found page at every other address under api/, each with every header _headers gives. It
   * used to send nginx's own 502 page with HSTS alone. */
  const off = [];
  const down = await get(origin + 'api/config');
  const folderConfig = fs.readFileSync(path.join(folder, 'api', 'config'), 'utf8');
  if (down.status !== 200 || down.body !== folderConfig || !/^application\/json\b/.test(down.headers['content-type'] || '')) off.push('/api/config answered ' + down.status + ' ' + down.headers['content-type'] + ' ' + JSON.stringify(down.body.slice(0, 80)));
  off.push(...headerProblems(down).map((x) => '/api/config ' + x));
  const answers = [];
  for (const p of ['api/me', 'api/auth/google/start?return=%2F', 'api/auth/google/callback?code=x&state=y', 'api/nothing', 'api/', 'api/.git/config']) answers.push(['GET /' + p, await get(origin + p)]);
  for (const p of ['api/checkout', 'api/auth/logout', 'api/webhooks/stripe']) answers.push(['POST /' + p, await post(origin + p, { origin: origin.replace(/\/$/, ''), 'content-type': 'application/json' })]);
  for (const [what, r] of answers) {
    if (r.status !== 404 || !r.body.includes(NOT_FOUND)) off.push(what + ' answered ' + r.status + (r.body.includes(NOT_FOUND) ? '' : ' without the not-found page'));
    off.push(...headerProblems(r).map((x) => what + ' ' + x));
  }
  check(off.length === 0, "nginx: with the API stopped, api/ answers as a site with no API: the folder's api/config, typed, and the not-found page at every other address, all with every header" + (off.length ? '\n  ' + off.join('\n  ') : ''));
}

/*
 * Apache as a stock Debian or Ubuntu install has it (its default modules, its <FilesMatch "^\.ht">
 * denial, `Options Indexes FollowSymLinks` on the folder), with the modules in `modules` on top and
 * the least AllowOverride .htaccess's header asks for. The site is under BASE, as it was built,
 * through an Alias.
 */
async function apache(label, modules, extra = []) {
  const dir = path.join(work, label);
  const folder = siteFor(label, 'apache', BASE);
  const port = await freePort();
  const stock = ['mpm_event', 'authz_core', 'authz_host', 'mime', 'dir', 'alias', 'autoindex', 'negotiation', 'env', 'setenvif', 'filter', 'deflate'];
  fs.writeFileSync(path.join(dir, 'httpd.conf'), [
    'ServerRoot ' + dir,
    'DefaultRuntimeDir ' + dir,
    'PidFile ' + path.join(dir, 'httpd.pid'),
    'ErrorLog ' + path.join(dir, 'error.log'),
    'LogLevel warn',
    'Listen 127.0.0.1:' + port,
    'ServerName localhost',
    ...(asRoot ? ['User www-data', 'Group www-data'] : []),
    ...[...stock, ...modules].map((m) => 'LoadModule ' + m + '_module ' + path.join(MODULES, 'mod_' + m + '.so')),
    'TypesConfig /etc/mime.types',
    'DirectoryIndex index.html',
    '<Directory />',
    '  AllowOverride None',
    '  Require all denied',
    '</Directory>',
    '<FilesMatch "^\\.ht">',
    '  Require all denied',
    '</FilesMatch>',
    'Alias ' + BASE.replace(/\/$/, '') + ' ' + folder,
    '<Directory ' + folder + '>',
    '  Options Indexes FollowSymLinks',
    '  AllowOverride FileInfo Indexes Options',
    '  Require all granted',
    '</Directory>',
    ...extra,
    '',
  ].join('\n'));
  const server = spawn(APACHE, ['-f', path.join(dir, 'httpd.conf'), '-DFOREGROUND'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  server.stdout.on('data', (d) => { output += d; });
  server.stderr.on('data', (d) => { output += d; });
  children.push(server);
  const log = () => output + (fs.existsSync(path.join(dir, 'error.log')) ? fs.readFileSync(path.join(dir, 'error.log'), 'utf8') : '');
  const origin = 'http://127.0.0.1:' + port + BASE;
  await waitFor(origin, {}, log);
  return { origin, log, version: spawnSync(APACHE, ['-v'], { encoding: 'utf8' }).stdout.split('\n')[0].replace(/^Server version: /, '') };
}

async function apacheChecks() {
  const { origin, version } = await apache('apache', ['rewrite', 'headers']);
  // Behind a TLS-terminating proxy, which is what the redirect's X-Forwarded-Proto is for: this
  // Apache speaks plain http, and the proxy says the visitor used https.
  const proxied = { 'X-Forwarded-Proto': 'https' };

  const served = [];
  for (const p of SERVED) {
    const r = await get(origin + p, proxied);
    if (r.status !== 200) served.push(BASE + p + ' answered ' + r.status);
    served.push(...headerProblems(r).map((x) => BASE + p + ' ' + x));
  }
  check(served.length === 0, version + ', mod_rewrite and mod_headers on: every path of the site answers 200 behind a proxy, with every header _headers gives it, HSTS included' + (served.length ? '\n  ' + served.join('\n  ') : ''));
  check((await get(origin + 'LICENSE', proxied)).headers['content-type'] === RULES['/LICENSE']['content-type'], 'Apache: the licence is text, as _headers says');
  check(/^text\/javascript\b/.test((await get(origin + 'app.js', proxied)).headers['content-type']), 'Apache: a script is served as one');

  const refused = [];
  for (const p of REFUSED) {
    const r = await get(origin + p, proxied);
    // A stock install refuses .ht* itself, with a 403 before .htaccess is read; ErrorDocument 403
    // answers it with the same page.
    const want = p === '.htaccess' ? 403 : 404;
    if (r.status !== want || !r.body.includes(NOT_FOUND)) refused.push(BASE + p + ' answered ' + r.status + (r.body.includes(NOT_FOUND) ? '' : ' without the not-found page'));
    refused.push(...headerProblems(r).map((x) => BASE + p + ' ' + x));
  }
  check(refused.length === 0, "Apache: the repository's files, this file and the folders answer the not-found page, with every header" + (refused.length ? '\n  ' + refused.join('\n  ') : ''));

  const redirect = await get(origin + 'a?x=1');
  check(redirect.status === 301 && new RegExp('^https://127\\.0\\.0\\.1:\\d+' + BASE + 'a\\?x=1$').test(redirect.headers.location || ''), 'Apache: plain http redirects to https');

  /* The API behind Apache: the ProxyPass .htaccess and README.md give for the virtual host, with
   * HSTS set there, since a proxied answer never reads the folder's .htaccess. The site is under
   * BASE, so the API's APP_URL is too. */
  const appUrl = 'https://127.0.0.1' + BASE;
  const backend = await startApi(appUrl);
  const proxied2 = await apache('apache-proxy', ['rewrite', 'headers', 'proxy', 'proxy_http'], [
    'ProxyPass "' + BASE + 'api/" "http://127.0.0.1:' + backend.port + BASE + 'api/"',
    '<Location "' + BASE + 'api/">',
    '  Header always set Strict-Transport-Security "' + SITE_HEADERS['strict-transport-security'] + '"',
    '</Location>',
  ]);
  await apiThrough('Apache with the ProxyPass in its virtual host', proxied2.origin.replace(BASE, '/'), BASE.slice(1) + 'api/', appUrl);
  const page = await get(proxied2.origin, proxied);
  check(page.status === 200 && headerProblems(page).length === 0, 'Apache with the ProxyPass: the site itself is served as before, with every header');
  await backend.api.close();
  // README says to add the ProxyPass once the API runs: with it and no process, Apache answers 503.
  const gone = await get(proxied2.origin + 'api/config', proxied);
  check(gone.status === 503, 'Apache with the ProxyPass and the API stopped answers 503, as README says (' + gone.status + ')');

  const bare = await apache('apache-bare', []);
  /* Debian and Ubuntu ship with both off. A site served without them would hand out .git/ and
   * every other file with none of the headers; refusing everything is the safe way to fail. */
  const bareProblems = [];
  for (const p of ['', '.git/config', 'README.md', 'lib/settings.js']) {
    const r = await get(bare.origin + p, proxied);
    if (r.status !== 500) bareProblems.push(BASE + p + ' answered ' + r.status);
    if (/PLANTED/.test(r.body)) bareProblems.push(BASE + p + ' handed out the file');
  }
  check(bareProblems.length === 0, 'Apache without mod_rewrite and mod_headers refuses to serve the site at all' + (bareProblems.length ? '\n  ' + bareProblems.join('\n  ') : ''));
  check(/Invalid command '(RewriteEngine|Header)'/.test(bare.log()), "and its log says why");
}

(async () => {
  try {
    await nginx();
    await apacheChecks();
  } catch (e) {
    console.error(e);
    failures++;
  } finally {
    for (const child of children) child.kill('SIGTERM');
    await Promise.all(children.map((child) => (child.exitCode === null && child.signalCode === null ? new Promise((resolve) => child.once('exit', resolve)) : null)));
    fs.rmSync(work, { recursive: true, force: true });
  }
  if (failures) {
    console.error('hosts: ' + failures + ' check(s) failed');
    process.exit(1);
  }
  console.log('hosts OK: nginx and Apache');
})();
