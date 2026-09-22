# Selfreportle

Manifest V3 browser extension (Chromium 116 or newer) that reads AI-provenance and
disclosure signals from a page's code, text and images — C2PA Content Credentials
verified in the browser, IPTC/XMP metadata, generator fingerprints, hidden Unicode
watermarks — in the context of EU AI Act Article 50. Plain scripts: no build step, no
bundler, no dependencies. See README.md for what it looks at and what it cannot tell.

- `npm test` runs the node:test suites in `test/`, built on synthetic JPEG/PNG/WebP/C2PA
  fixtures from `test/helpers.js`; `npm run lint` is `node --check` over every script,
  and that is all the linting there is by design; `npm run test:e2e` loads the unpacked
  extension into Chromium via Playwright against a fixture site it serves itself;
  `npm run check` is the gate before a push.
- Two suites are guards, not examples: `test/redos.test.js` runs every regex literal in
  `lib/` against hostile input at 2 KB and 16 KB and holds each to a flat budget, because
  the patterns run on the page's own thread over text the page chose, and
  `test/false-positives.test.js` keeps every page an earlier version wrongly accused.
  Do not widen either bound to make a pattern pass.
- Every `lib/*.js` is a plain script in the extension and a CommonJS module under Node
  (the wrapper at the top of each file), which is what makes the analysers testable at
  all. A new module keeps that wrapper and is listed in `manifest.json` (content
  scripts) or the `importScripts` line of `background/service-worker.js` (the worker).
- `lib/` holds the analysers and parsers; `background/service-worker.js` fetches image
  bytes cross-origin, caches them and stores per-tab results; `content/` runs the
  analyses on the page and draws the overlay; `popup/`, `options/` and `publisher/` are
  the UI pages; `test/e2e/` is the Playwright run. The README's project layout names
  every file.

## Invariants worth not breaking

Each came from a reproduced finding in REVIEW.md or SECURITY-AUDIT.md; a change that
undoes one passes every test it did not add.

- **The worker fetches with `<all_urls>`, outside the page's CSP, mixed-content and
  Private Network Access checks, from URLs the page wrote.** `lib/fetch-policy.js`
  decides what it may reach: a page may read its own address space or a less private
  one, never a more private one; a page that is not itself local gets no redirect
  following at all; anything unrecognised fails closed. The policy cannot resolve DNS,
  so it is the second line, not the first — the content script only hands over a URL
  the page's own loader already fetched. What one tab may spend is a budget charged
  where the fetch is issued and where its bytes are read, refilled by the clock alone;
  and the parsers carry their own ceilings (inflate size, XMP, the JUMBF scan's 25 ms)
  rather than trusting a caller's cap, because the worker is shared by every tab.
- **An exculpatory verdict has to be earned.** A valid COSE signature proves only that
  the claim was not altered since it was signed. The camera badge needs, separately:
  every assertion hashed against the claim; a chain anchored in `TRUST_ANCHORS`, which
  ships empty, so no manifest earns the badge until a trust list is chosen; a hard
  binding recomputed over the file's own bytes, with the excluded extent checked rather
  than taken from the manifest; and `rendered` — the bytes the worker verified decode
  to the picture the element is showing, compared pixel for pixel in the page.
  Everything that cannot answer answers no, and the saved report says what was not
  checked rather than implying it was.

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
(the worker's `tab:<id>` session cache is the stated exemption). Reset to defaults writes the
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
carries and the README skeleton. `npm run check` is the gate before a push. To change a
convention, change it in every repository in one pass and update the hashes in the test.
