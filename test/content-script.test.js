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
  const loop = body.slice(body.indexOf('for (const item of list)'), body.indexOf('// blob:'));
  assert.match(loop, /try\s*\{/, 'the per-item body is guarded');
  assert.match(loop, /catch \(e\)/);
});

test('no page-supplied string is handed to a bare new URL()', () => {
  assert.ok(!/new URL\(/.test(SRC), 'use imageHints.resolveUrl, which answers null instead of throwing');
  assert.match(SRC, /resolveUrl\(poster, location\.href\)/);
});
