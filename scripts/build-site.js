#!/usr/bin/env node
/*
 * The website: the files a visitor's browser loads, and nothing else from the repository.
 *
 *   node scripts/build-site.js <folder> [--host=<name>] [--base=/<path>/]
 *                                   write the site into <folder> (absent or empty)
 *   node scripts/build-site.js --list   print the site's published paths, one per line
 *
 * The site is the checker page and what it loads (web/), the lib/ modules the page names in
 * its <script> tags (read out of web/index.html rather than restated here, so a module added
 * to the page is published without a second edit), the favicon, the not-found page,
 * robots.txt, the security contact (RFC 9116) and the licence the scripts are published
 * under. Nothing else is published: not the extension's other scripts, the notes, the tests or
 * the hosting configs, which a host reads but would otherwise serve. `--host` adds the config
 * that host reads from the folder it publishes; `--base` is the path the site is served under
 * (a project site on GitHub Pages is /<repository>/), which the not-found page and Apache's
 * ErrorDocument need because they are answered at any depth.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

/* Published path → source path, beside the lib/ modules the page names. */
const PAGE_FILES = {
  'index.html': 'web/index.html',
  '404.html': 'web/404.html',
  'app.js': 'web/app.js',
  'guard.js': 'web/guard.js',
  'site.css': 'web/site.css',
  'robots.txt': 'web/robots.txt',
  '.well-known/security.txt': 'web/.well-known/security.txt',
  'icons/icon32.png': 'icons/icon32.png',
  LICENSE: 'LICENSE',
};

/* The config each header-capable host reads from the folder it publishes. GitHub Pages reads
 * none and would serve them as files, and nginx's lives in the server's own config
 * (deploy/nginx.conf), so those two get the site alone. Netlify reads _headers and _redirects;
 * Cloudflare Pages reads _headers and takes no 404 rule from _redirects, so there the folder
 * holding nothing else is the protection; Apache refuses to serve .htaccess in its default
 * configuration, and the file refuses it again. */
const HOST_FILES = {
  pages: {},
  nginx: {},
  netlify: { _headers: 'web/_headers', _redirects: 'web/_redirects' },
  cloudflare: { _headers: 'web/_headers' },
  apache: { '.htaccess': 'web/.htaccess' },
};

/* The files a base path is written into. */
const STAMPED = new Set(['404.html', '.htaccess']);

/** The lib/ modules web/index.html loads, in its order. */
function pageModules() {
  const html = fs.readFileSync(path.join(root, 'web/index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  return [...html.matchAll(/<script\s+src="(lib\/[a-z0-9-]+\.js)"><\/script>/g)].map((m) => m[1]);
}

/** Every published path of the site, with its source, sorted by path. */
function siteMap() {
  const map = { ...PAGE_FILES };
  for (const p of pageModules()) map[p] = p;
  return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function siteFiles() { return Object.keys(siteMap()); }

/** A base path: "/" or "/a/b/", nothing a URL or a config line could be broken out of. */
function checkBase(base) {
  if (!/^\/(?:[A-Za-z0-9._~-]+\/)*$/.test(base) || /(^|\/)\.\.?\//.test(base)) throw new Error(`--base must look like / or /path/ (got '${base}')`);
  return base;
}

/** Write the site, and the config `host` reads, into `out`, which must be absent or empty: a
 *  folder holding something else would be published with it. Returns the paths written. */
function build(out, { host = 'pages', base = '/' } = {}) {
  if (!Object.prototype.hasOwnProperty.call(HOST_FILES, host)) throw new Error(`unknown host '${host}': one of ${Object.keys(HOST_FILES).join(', ')}`);
  checkBase(base);
  const target = path.resolve(out);
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error(`${out} is not empty`);
  const files = { ...siteMap(), ...HOST_FILES[host] };
  for (const [to, from] of Object.entries(files)) {
    const dest = path.join(target, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (STAMPED.has(to)) {
      const text = fs.readFileSync(path.join(root, from), 'utf8');
      if (!text.includes('%BASE%')) throw new Error(`${from} has no %BASE% to fill in`);
      fs.writeFileSync(dest, text.split('%BASE%').join(base));
    } else {
      fs.copyFileSync(path.join(root, from), dest);
    }
  }
  return Object.keys(files);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const usage = 'usage: node scripts/build-site.js <folder> [--host=pages|nginx|netlify|cloudflare|apache] [--base=/path/] | --list';
  if (args.length === 1 && args[0] === '--list') {
    process.stdout.write(siteFiles().join('\n') + '\n');
  } else if (args.length >= 1 && !args[0].startsWith('-') && args.slice(1).every((a) => /^--(host|base)=/.test(a))) {
    const opt = (name, fallback) => { const a = args.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : fallback; };
    try {
      const written = build(args[0], { host: opt('host', 'pages'), base: opt('base', '/') });
      console.log(`Selfreportle: ${written.length} files written to ${args[0]}`);
    } catch (e) {
      console.error(`Selfreportle: ${e.message}`);
      process.exit(1);
    }
  } else {
    console.error(usage);
    process.exit(2);
  }
}

module.exports = { PAGE_FILES, HOST_FILES, STAMPED, pageModules, siteMap, siteFiles, checkBase, build };
