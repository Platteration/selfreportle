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
  assert.match(SRC, /const wanted = [^;]*pageLoaded\(item\)/, 'and nothing is fetched without it');
  // Still loading is not the same as failed: the element is re-collected when
  // the browser's own request settles, so a slow image is not simply dropped.
  assert.match(SRC, /function retryWhenLoaded\(item, st\)/);
  assert.match(SRC, /addEventListener\(kind === 'av' \? 'loadedmetadata' : 'load'/);
  assert.match(SRC, /st\.done = true;\n\s*retryWhenLoaded\(item, st\);/);
});

/*
 * L3-4 / P-2. `imageState.size <= settings.maxImages` counted live <img>
 * elements, and a src rewrite deletes the entry and re-inserts it under the
 * same Map key, so the cap was never consumed: the page rewrote sixty srcs,
 * waited for the mutation observer, and did it again indefinitely.
 *
 * Charging a set that nothing refills stopped that and blinded the extension
 * instead: on a single-page app or an infinite feed the sixty-first distinct
 * image, and every image after it for the tab's life, was never fetched, with
 * no badge and no marker to say so. The volume is bounded by the worker's
 * per-minute request and byte budget, which no rewrite re-arms; the count
 * here only limits one view, so what the view gives back it gets back.
 */
test('the per-view fetch cap is spent, and refilled by what leaves the view', () => {
  assert.ok(!/imageState\.size <= settings\.maxImages/.test(SRC), 'counting live elements re-arms on every src rewrite');
  assert.ok(!/const submittedUrls/.test(SRC), 'and a set nothing refills goes blind on any page that outlives sixty images');
  assert.match(SRC, /function imageBudget\(\)/, 'the budget is a count, taken when it is needed');
  assert.match(SRC, /for \(const st of imageState\.values\(\)\) if \(st\.submitted\) spent\.add\(st\.url\);/, 'over what this document is still tracking');
  assert.match(SRC, /const spent = new Set\(inFlightUrls\.keys\(\)\);/, 'plus what is still in flight, so dropping an element mid-fetch frees nothing');
  assert.match(SRC, /spent\.has\(item\.url\) \|\| spent\.size < settings\.maxImages/);
  // Elements the page has removed are not in front of anyone, so they hold
  // neither a badge nor a share of the budget.
  assert.match(SRC, /function dropDetached\(\)/);
  assert.match(SRC, /st\.el\.isConnected === false/);
  const process = SRC.slice(SRC.indexOf('async function processImages'));
  assert.match(process.slice(0, 200), /dropDetached\(\);/, 'pruned before the budget is counted');
  const summary = SRC.slice(SRC.indexOf('function refreshSummary()'));
  assert.match(summary.slice(0, 200), /dropDetached\(\);/, 'and when a view is torn down without a new one arriving');
  // A skipped image is not a clean image, and a reader cannot tell a blank
  // badge from an inspected one.
  assert.match(SRC, /function overBudgetSignal\(\)/);
  assert.match(SRC, /if \(wanted\) st\.signals = \[\.\.\.st\.signals, overBudgetSignal\(\)\];/);
});

/*
 * L5-3 / P-1. The worker's fetch is a second, distinguishable request — no
 * cookies, a Range header, no Referer — so a server that tells the two apart
 * can hand the reader an AI picture and the extension a signed photograph,
 * and the badge lands on the picture nobody hashed. Reading the page's own
 * cache instead does not close that: `only-if-cached` returns whatever the
 * HTTP cache holds for the URL now, and a same-origin page can overwrite its
 * own entry after the <img> has decoded (`fetch(url, {cache: 'reload'})`, or
 * the same request from a frame or worker this script never sees). Verified
 * bytes therefore have to be shown to be the picture, not assumed to be.
 */
test('no bytes are called rendered until they are shown to be the picture', () => {
  assert.match(SRC, /cache: 'only-if-cached'/, 'reads what the browser already holds');
  assert.match(SRC, /mode: 'same-origin'/, 'which is the only mode that permits it');
  assert.ok(!/credentials: 'include'/.test(SRC), 'and still sends no cookies, as the privacy note says');
  // The stamp that made the cache the proof.
  assert.ok(!/msg\.rendered = true;/.test(SRC), 'the cache entry is not evidence of what an element decoded');
  assert.match(SRC, /msg\.rendered = !msg\.truncated && \(isBlob \? namesOneBlob\(el, msg\.url\) : await showsTheseBytes\(el, msg\.url, buf\)\);/);
  // What the proof is: the bytes decoded, and compared against the element.
  assert.match(SRC, /await createImageBitmap\(new Blob\(\[buf\]\)\)/);
  assert.match(SRC, /if \(va\[i\] !== vb\[i\]\) return false;/, 'pixel for pixel, not a size or a hash of the response');
  assert.match(SRC, /bmp\.width !== w \|\| bmp\.height !== h/);
  assert.match(SRC, /a\.drawImage\(el, 0, y, w, rows, 0, 0, w, rows\);/, 'against the element itself');
  // And it is asked again after every await: the element may have been given
  // something else while the bytes were decoding.
  assert.match(SRC, /if \(!showingStill\(el, url\) \|\| !carriesCredentials\(buf\)\) return false;/);
  assert.match(SRC, /if \(!showingStill\(el, url\) \|\| bmp\.width !== w \|\| bmp\.height !== h\) return false;/);
  assert.match(SRC, /return showingStill\(el, url\);/);
  assert.match(SRC, /\(el\.currentSrc \|\| el\.src\) === url/);
  // Both paths that submit a URL hand over the element they are speaking for.
  assert.equal((SRC.match(/await addPageBytes\(/g) || []).length, 2);
  assert.match(SRC, /await addPageBytes\(entry\.msg, entry\.st\.el\)/);
  assert.match(SRC, /await addPageBytes\(msg, target\)/);
});
