const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'content', 'content.js'), 'utf8');

/*
 * The content script runs analysers over whatever a page happens to contain,
 * and the page chooses that content. Three separate defects — an undeclared
 * variable on the Replit branch, a malformed percent-escape in an image URL,
 * and an unparseable <video poster> — each aborted analyze() before `result`
 * was assigned, so nothing was posted to the worker, the mutation observer
 * and the SPA poller never started, and the popup said "nothing analysed yet"
 * for the rest of the page's life. Fixing the three inputs is not enough: the
 * next one must not be able to do it either, so analyze() itself has to hold.
 *
 * These are structural checks on the source because the content script needs
 * a browser to run; test/e2e/run.js exercises the same property for real
 * against a fixture page carrying all three inputs at once.
 */

test('analyze() cannot throw out into main(), whatever an analyser does', () => {
  assert.match(SRC, /async function analyze\(full\)\s*\{\s*try\s*\{\s*await runAnalysis\(full\);\s*\}\s*catch/,
    'analyze() must wrap the analysis rather than being it');
  assert.match(SRC, /result\.error\s*=/, 'and a failure has to be recorded, not swallowed');
});

test('one unreadable image does not cost the page the rest of them', () => {
  const body = SRC.slice(SRC.indexOf('async function processImages'));
  const loop = body.slice(body.indexOf('for (const item of list)'), body.indexOf('for (const entry of toFetch)'));
  assert.match(loop, /try\s*\{/, 'the per-item body is guarded');
  assert.match(loop, /catch \(e\)/);
});

test('no page-supplied string is handed to a bare new URL()', () => {
  assert.ok(!/new URL\(/.test(SRC), 'use imageHints.resolveUrl, which answers null instead of throwing');
  assert.match(SRC, /resolveUrl\(poster, location\.href\)/);
});

/*
 * L3-1. The address-space policy reads the URL's text and cannot resolve it,
 * so a hostname the attacker owns pointed at 127.0.0.1 was classified public
 * and fetched by a worker that is exempt from mixed-content blocking, from
 * the page's CSP and from Private Network Access. An earlier pass skipped
 * this gate on the reasoning that the address rule already closed the hole;
 * it does not, and this is the structural fix: if the page's own loader
 * fetched it, the browser has already applied all three to that exact
 * request, and the extension is re-reading something already permitted
 * rather than minting a new capability.
 */
test('only a URL the page itself loaded is handed to the worker', () => {
  assert.match(SRC, /function pageLoaded\(item\)/, 'the gate exists');
  assert.match(SRC, /observe\(\{ type: 'resource', buffered: true \}\)/, 'what the browser actually requested');
  assert.match(SRC, /fetchedByPage\.has\(item\.url\)/, 'is what the gate asks');
  assert.match(SRC, /performance\.getEntriesByType\('resource'\)/, 'including whatever landed before the observer');
  assert.match(SRC, /el\.complete && \(el\.naturalWidth > 0 \|\| el\.naturalHeight > 0\)/,
    'with the element\'s own state as the fallback: a failed image completes with no intrinsic size at all');
  assert.match(SRC, /el\.readyState >= 1/, 'and media needs its metadata');
  assert.match(SRC, /const fetchable = [^;]*pageLoaded\(item\)/, 'and nothing is fetched without it');
  // Still loading is not the same as failed: the element is re-collected when
  // the browser's own request settles, so a slow image is not simply dropped.
  assert.match(SRC, /function retryWhenLoaded\(item, st\)/);
  assert.match(SRC, /addEventListener\(kind === 'av' \? 'loadedmetadata' : 'load'/);
  assert.match(SRC, /\{ st\.done = true; retryWhenLoaded\(item, st\); \}/);
});

/*
 * L3-4. `imageState.size <= settings.maxImages` counted live <img> elements,
 * and a src rewrite deletes the entry and re-inserts it under the same Map
 * key, so the cap was never consumed: the page rewrote sixty srcs, waited for
 * the mutation observer, and did it again indefinitely.
 */
test('the per-page fetch cap is spent, not surveyed', () => {
  assert.ok(!/imageState\.size <= settings\.maxImages/.test(SRC), 'counting live elements re-arms on every src rewrite');
  assert.match(SRC, /const submittedUrls = new Set\(\);/, 'a budget, held for the document');
  assert.match(SRC, /submittedUrls\.has\(item\.url\) \|\| submittedUrls\.size < settings\.maxImages/);
  assert.match(SRC, /submittedUrls\.add\(item\.url\);/, 'charged where the URL is handed over');
  // A same-document href change continues the page rather than starting one.
  const reset = SRC.slice(SRC.indexOf('if (full) {'), SRC.indexOf('const snapshot = collectSnapshot()'));
  assert.ok(!/submittedUrls/.test(reset), 'analyze(true) must not refill it');
});

/*
 * L5-3. The worker's fetch is a second, distinguishable request — no cookies,
 * a Range header, no Referer — so a server that tells the two apart can hand
 * the reader an AI picture and the extension a signed photograph, and the
 * badge lands on the picture nobody hashed. Where the browser already holds
 * the response, those are the bytes inspected.
 */
test('the bytes inspected are the bytes the page has, where it has them', () => {
  assert.match(SRC, /cache: 'only-if-cached'/, 'reads what the browser already holds');
  assert.match(SRC, /mode: 'same-origin'/, 'which is the only mode that permits it');
  assert.ok(!/credentials: 'include'/.test(SRC), 'and still sends no cookies, as the privacy note says');
  assert.match(SRC, /msg\.rendered = true;/, 'the worker is told which bytes these are');
  // Both paths that submit a URL go through it, the context menu included.
  assert.equal((SRC.match(/await addPageBytes\(/g) || []).length, 2);
});
