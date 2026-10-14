@AGENTS.md

# Selfreportle

Manifest V3 browser extension (Chromium 116 or newer) that reads AI-provenance and
disclosure signals from a page's code, text and images — C2PA Content Credentials
verified in the browser, IPTC/XMP metadata, generator fingerprints, hidden Unicode
watermarks — in the context of EU AI Act Article 50. Plain scripts: no build step, no
bundler, no dependencies (the website's `scripts/build-site.js` copies files into a folder
as written, and writes the base path into the not-found page, Apache's config and
Cloudflare's `_routes.json`, nothing more). The website's optional API (sign in with Google
and "Support this app", off until the owner sets it up: see Website) is the shared kit in
`server/kit/`, plain ES modules with no dependencies either. See README.md for what it looks
at and what it cannot tell.

- `npm test` runs the node:test suites in `test/`, built on synthetic JPEG/PNG/WebP/C2PA
  fixtures from `test/helpers.js`, the website's API (`test/api.test.mjs`) and the kit's own
  self-test (`server/kit/selftest.mjs`); `npm run lint` is `node --check` over every script,
  and that is all the linting there is by design (it leaves out `functions/api/[[path]].js`,
  an ES module in a folder with no `"type"`, on which `node --check` passes anything, a syntax
  error included: `test/api.test.mjs` holds that file to its three lines instead);
  `npm run test:e2e` loads the unpacked extension into Chromium via Playwright against a
  fixture site it serves itself; `npm run check` is the gate before a push. `test:e2e` runs
  `test/e2e/runner.js` (the Playwright `ci.yml` pins, asked through its own `install --dry-run`
  whether it has a Chromium build for the Ubuntu release CI's check job names; passes with a note
  where another Playwright resolves, unless `CI` is set), the extension's suite
  (`test/e2e/run.js`), then the website's (`test/e2e/site.js`), then the website's host configs
  in the nginx and Apache installed where it runs (`test/e2e/hosts.js`, which skips where they
  are missing unless `CI` is set). CI's check job runs on `ubuntu-24.04`, never `ubuntu-latest`,
  which becomes Ubuntu 26.04 from 2026-10-19, for which Playwright 1.56.1 has no Chromium:
  `test/ci.test.js` holds the job to a named release.
- Two suites are guards, not examples: `test/redos.test.js` runs every regex literal in
  `lib/` and `web/` against hostile input at 2 KB and 16 KB and holds each to a flat budget,
  and again against near misses derived from the pattern itself (its own opening token,
  repeated and never closed) at 4 KB and 64 KB, because the patterns run on the page's own
  thread over text the page chose (on the website, over a file a hostile site may have
  written for the purpose); a pattern built with `new RegExp` is out of its sight and is
  held through its analyser's entry point instead. And
  `test/false-positives.test.js` keeps every page an earlier version wrongly accused.
  Do not widen either bound to make a pattern pass.
- Every `lib/*.js` is a plain script in the extension and a CommonJS module under Node
  (the wrapper at the top of each file), which is what makes the analysers testable at
  all. A new module keeps that wrapper and is listed in `manifest.json` (content
  scripts) or the `importScripts` line of `background/service-worker.js` (the worker), and
  in `web/index.html` or the website test's list of modules left out (see Website).
- `lib/` holds the analysers and parsers; `background/service-worker.js` fetches image
  bytes cross-origin, caches them and stores per-tab results; `content/` runs the
  analyses on the page and draws the overlay; `popup/`, `options/` and `publisher/` are
  the UI pages; `test/e2e/` is the Playwright run. The README's project layout names
  every file.

## Invariants worth not breaking

Each came from a reproduced finding in REVIEW.md, SECURITY-AUDIT.md or the commit that
added it; a change that undoes one passes every test it did not add.

- **The worker fetches with `<all_urls>`, outside the page's CSP, mixed-content and
  Private Network Access checks, from URLs the page wrote.** `lib/fetch-policy.js`
  decides what it may reach: a page may read its own address space or a less private
  one, never a more private one; a page that is not itself local gets no redirect
  following at all; anything unrecognised fails closed. The policy cannot resolve DNS,
  so it is the second line, not the first — the content script only hands over a URL
  the page's own loader already fetched. What one tab may spend is a budget charged
  where the fetch is issued and where its bytes are read (chunk by chunk, through
  `lib/byte-budget.js`, which stops a body at its cap and refuses a tail longer than
  asked), refilled by the clock alone; and the parsers carry their own ceilings (256 KB
  of PNG text inflated or kept per image, keys included, out of at most 100 text chunks
  with keys of at most 79 bytes; XMP; the JUMBF scan's 25 ms) rather than trusting a
  caller's cap, because the worker is shared by every tab. A key once went uncharged: a
  4 MB PNG of empty text chunks kept 198,429 of them, and one of tiny compressed chunks
  held the worker 21 s.
- **An exculpatory verdict has to be earned.** A valid COSE signature proves only that
  the claim was not altered since it was signed. The camera badge needs, separately:
  every assertion hashed against the claim; a chain anchored in `TRUST_ANCHORS`, which
  ships empty, so no manifest earns the badge until a trust list is chosen; a hard
  binding recomputed over the file's own bytes, with the excluded extent checked rather
  than taken from the manifest (exactly the credential store, whole; one binding per
  claim; and in a PNG whole `caBX` chunks of a file that walks cleanly to its final
  `IEND`); and `rendered` — the bytes the worker verified decode
  to the picture the element is showing, compared pixel for pixel in the page.
  Everything that cannot answer answers no, and the saved report says what was not
  checked rather than implying it was.
- **A page's forms can rename what a walk reads.** A `<form>` answers a property lookup
  with its own control of that name first — `<input name="attributes">` makes
  `form.attributes` that input — in the content script's world and in the document
  DOMParser builds for the website, and the page chooses the names: one such control
  stopped the whole analysis. The walks in `content/content.js` and `web/app.js`, and the
  overlay's reads of a marker's element, go through the prototype (`DOM`, `PAGE_EL`), and
  `test/e2e/run.js` and `test/e2e/site.js` drive each read against a real form. A
  document's own named elements (`<img name="title">`) reach neither a content script nor a
  DOMParser document (measured), so `document.*` is read directly.

## Website

The analysers are also a website (README, "The website"): `web/index.html` loads twelve
`lib/` modules, `web/app.js`, which runs them on one file the visitor picks, and
`web/account.js` (sign-in and "Support this app", below) — media through
`analyzeImageBytes`, a saved page through the site, text, trader and image-hint analysers on
the content script's snapshot shape, text through the text analyser. The extension stays as it
is; nothing in `lib/` knows about the page. `scripts/build-site.js` writes the site into an
empty folder (`--host` adds that host's config, `--base` the sub-path the not-found page,
Apache's `ErrorDocument` and Cloudflare's `_routes.json` are stamped with), and the site's
module list is read out of `index.html`'s `<script>` tags, so a module added there is published
without a second edit.

- **One policy, five places**: `web/_headers`, `web/.htaccess`, `deploy/nginx.conf`, and the
  `<meta>` of `web/index.html` and `web/404.html` (less `frame-ancestors`).
  `test/website.test.js` holds them equal, pins every source, the site's file list, the
  allowlist Apache and nginx answer from (every other repository file is a 404), the security
  contact's `Expires` (the test fails once it passes: renew it, a year ahead at most) and the
  version against `manifest.json`. `test/e2e/site.js` serves the built site at a sub-path
  under the headers and fails on any violation, console error, page error or request outside
  the site; every source was measured there by removing it. Change one copy and change all five.
- **The host configs are run, not only read.** `test/e2e/hosts.js` loads `deploy/nginx.conf`
  into a real nginx and the built `.htaccess` into a real Apache, with checkout files planted
  beside the site. Each was found doing something other than it said: `http2 on;` made nginx
  1.24 (Ubuntu 24.04) refuse the file, so HTTP/2 is asked for on the `listen` lines; the
  `.htaccess` rules sat in `<IfModule>`, so a stock Apache, with `mod_rewrite` and
  `mod_headers` off, served `.git/` and every file with no header and logged nothing, and now
  nothing is wrapped (a missing module is a 500 and a log line), which `test/website.test.js`
  holds by reading the file whole; and HSTS under `env=HTTPS` was left off behind a
  TLS-terminating proxy, so it is sent unconditionally, as `_headers` and nginx send it.
- **Trusted Types are enforced**, and the one policy, `selfreportle-saved-page`, exists for
  `parseSavedPage` alone: the test allows exactly one line that turns a string into a
  document. Everything else is `createElement` and `textContent`.
- **A saved page is data.** DOMParser builds it a document with no window, so its scripts,
  handlers, meta refresh, meta policy and every fetching element stay inert (the e2e's hostile
  page proves each). Chromium still checks that document's `<style>`, `style=""` and `<base>`
  against this site's policy and reports every one as a violation, so `quietStyles` renames
  them first (`<noframes>`, `data-srl-style`, `<meta data-srl-base>`, each parsed where the
  original would be). Addresses in the page are read as attributes and resolved against the
  address the file says it was saved from, never against this site.
- **A saved page chooses its own shape**, up to 8 MB of it. A walk over it is one pass
  (`unskipped` steps over a skipped subtree whole), never a `closest()` per candidate nor a
  whole-document lookup per block: 8 MB of `<span>`s nested as deep as the parser allows
  (512) held the checker two minutes the first way, 600 paragraphs and no `<main>` 38 s the
  second. `test/e2e/site.js` reads each such page beside a control with as many elements and
  fails when it costs over four times as much. (Nested `<blockquote>`s are slow in Chromium's
  own parser, opened as a tab or through DOMParser alike, which is not the checker's to fix.)
- **Sign in with Google and "Support this app" are the website's alone, and off until keyed.**
  `server/kit/` is the kit every app of this account carries, copied byte for byte but for its
  eight `.d.ts` declaration files: never edit it here (`diff -r` against the canonical copy
  lists exactly those eight; a change goes to the canonical copy and is copied everywhere), and
  its `README.md` is the owner's guide. The declaration files are left out because the shared
  conventions test counts any tracked `.d.ts` as a TypeScript source that `npm run typecheck`
  must reach, which needs `typescript` installed, so devDependencies, a lockfile, `npm ci` and
  an audit job in CI and a `.claude/` session hook: tooling this repository's no-dependency
  posture rules out, for files nothing here reads (they are types for the TypeScript apps that
  import the kit). Copy them in once the shared conventions test stops counting declaration
  files. `server/catalogue.js` sells one product, `supporter`; `functions/api/[[path]].js` is
  the Cloudflare Pages entry (`--host=cloudflare` writes `_routes.json` from `web/_routes.json`,
  base path stamped); `server/start.mjs` is the Node entry behind `deploy/nginx.conf`'s
  `location ^~ /api/`, the one location allowed a header (HSTS, as the server block writes it:
  an `add_header` there drops every inherited one, which is what keeps the site's policy off the
  API's answers); with the process not running, that location hands nginx's own 502/503/504 to
  `location @api-off`, which serves the folder's `api/config` and the not-found page with the
  server block's headers (it used to be nginx's 502 page with HSTS alone; `test/e2e/hosts.js`
  stops the API to check). Apache takes a `ProxyPass` in the virtual host, which `.htaccess` can
  only describe, once the process runs (with it and no process, Apache answers 503). The site
  publishes `web/api/config`, the kit's "nothing on" byte for byte, so a host with no API answers
  the page's one question instead of logging a 404. `web/account.js` (loaded after `app.js`, so
  its failure never stops the checker) asks `api/config` once, and draws the
  "Account and support" section and swaps the privacy line only when sign-in is on (then it asks
  `api/me` once per load, signed in or not); server text is drawn as text; Buy follows only
  `https://checkout.stripe.com`. The kit's flags (`?signin=failed`, `?purchase=`) leave the
  address on arrival on every host. The kit copy (7f4e583) makes a new payable Checkout Session
  for every Buy until the webhook records the purchase, so after `?purchase=success`, for a
  signed-in visitor, the product reads "Payment received — processing" where Buy was until
  `api/me` reports it: for the life of the page, and across a reload within `PENDING_MS` (ten
  minutes) through the page's one record, `selfreportle.purchasePending.v1` in the tab's
  sessionStorage (`{ at }`), dropped once the purchase is reported or the account signs out or is
  deleted. A 409 `payment_pending` (the canonical kit's answer from b575aee on) is drawn the same
  way. A `?purchase=success` link opened signed out says nothing and asks nothing more. The
  privacy line says Stripe is told the account id with a payment, and the thank-you is "Thank
  you for supporting Selfreportle." (it unlocks nothing). The policy's `connect-src`
  is `'self'` for it, measured in Chromium (with `'none'` every load is a violation). The
  extension never calls the API and its manifest gained nothing: `test/website.test.js` reads
  every extension file and pins the manifest's permissions, and `test/e2e/run.js` fails if the
  fixture site is asked for `api/`. `test/api.test.mjs` runs the catalogue through both entries
  with a fake Google and Stripe injected through the kit's `fetch` (`test/api-fakes.mjs`; never
  a variable naming another host); `test/account.test.js` drives `account.js` against a fake
  fetch; `test/e2e/site.js` runs the whole flow in Chromium under the site's headers, answering
  Google's and Stripe's pages in the browser through the DevTools protocol's Fetch domain
  (Playwright's `page.route` does not see a redirect's next hop); `test/e2e/hosts.js` runs the
  API behind the real nginx and an Apache `ProxyPass`.
- **Five modules are left out on purpose** — `settings.js`, `history.js` (chrome.storage),
  `fetch-policy.js` (the worker's fetches), `byte-budget.js` (streamed reads; the site
  slices the picked file instead), `platform-labels.js` (needs layout) — and the
  website test fails when a new `lib/` module is neither loaded nor added to that list.

## Settings

Every key the extension writes is named in `lib/settings.js` (`KEYS`): `chrome.storage.sync`
holds `selfreportle.settings.v1`, one object with every field of `DEFAULTS` but the host
list, and `selfreportle.disabledHosts.v1`, the paused hosts as their own item so that the
browser's per-item quota bounds that list alone; `chrome.storage.local` holds the domain
memory at `srl:domains`, which `lib/history.js` reads from the table; the per-tab results
under `tab:<id>` in `chrome.storage.session` are a cache that ends with the tab, not a
record. Every reader goes through `S.settings.load()`, which only reads: the namespaced
record where present, else the flat items earlier builds wrote (`LEGACY_KEYS`, one sync
item per field), and validates either through `cleanSettings` — each field by the type of
its default, enums through own-property tables (`has`, never `in` — every name on
`Object.prototype` is truthy on a plain table), numbers within `RANGES`, falling back field
by field, never as a whole. The one-time copy of the flat items under the namespaced keys
is `migrate()`, run from the worker's `onInstalled` and not from `load()`, because a reader
that writes can land a stale copy over a save that completed in between. It writes the two
records in two `set()` calls: sync refuses a whole call when one item is past
`QUOTA_BYTES_PER_ITEM`, the namespaced host-list key is sixteen bytes longer than the flat
one, so a list that fitted before can be exactly what is refused and must not take the
settings object with it (`save()` writes the same way, rewrites the list only when it
changed, and names the list in the error, code `hosts`, once the rest is stored). The flat
items are never removed: sync storage is one store per browser profile, a device still on
the old build re-creates them on every save and reads only them, so both present is the
normal state and the namespaced record wins. `test/settings.test.js` walks
`Object.getOwnPropertyNames(Object.prototype)` through `JSON.parse`, drives the copy against
an in-memory `chrome.storage` with the per-item quota, and stages the read-against-save
race; `test/settings-contract.test.js` pins the keys, the fields, the enum tables and the
options page's rows as literals, and that no key string is spelled outside `lib/settings.js`
(the worker's `tab:<id>` session cache is one stated exemption; the website's one record,
`selfreportle.purchasePending.v1` in the tab's sessionStorage, written by `web/account.js`
alone, is the other, pinned there as a literal). Reset to defaults writes the
defaults under the two records and removes nothing — not the flat items, never the domain
memory; it and Clear domain memory are confirmed with `window.confirm`, Clear image cache is
not. About reads the version from `chrome.runtime.getManifest()`, which the contract test
holds equal to `package.json`. There is no onboarding flag to preserve.

## Conventions

This repository follows `CONVENTIONS.md`, which is identical in every platteration
repository and pinned by the conventions test (`npm run test:conventions`, or
`tests/test_conventions.py` in a Python repository): the script set (`test`,
`typecheck`, `lint`, `check`, `test:e2e`, `test:all`), Node 22 via `.nvmrc`, one
`.editorconfig`, ESLint per stack, the `ci.yml` shape, the documents every repository
carries and the README skeleton. The repository's check command (`npm run check`, or
`ruff check .` then `pytest -q` in a Python repository) is the gate before a push. To
change a convention, change it in every repository in one pass and update the hashes in
the test.
