const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * This project is mostly regular expressions run over whatever text a page
 * happens to contain, in the content script, on the page's own thread. A
 * pattern that backtracks quadratically is therefore a denial of service that
 * any site can trigger: one long run of the wrong character and the tab
 * freezes. One shipped that way (an unbounded, unanchored compound-street
 * prefix), so this guard is permanent.
 *
 * Every regex literal in lib/ is run against inputs designed to make a
 * backtracking engine work hard, at two sizes. A pattern is flagged when it
 * exceeds a flat budget, or when quadrupling the input makes it more than
 * ~8x slower, which is the signature of superlinear behaviour.
 */

const LIB = path.join(__dirname, '..', 'lib');

/* Tolerant JS regex-literal scanner: good enough for this codebase, and any
 * literal it cannot compile is skipped rather than guessed at. */
function regexLiterals(source, file) {
  const out = [];
  const re = /(^|[=(,[:!&|?{}\n;]|=>|return)\s*(\/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n[])+\/[gimsuyd]*)/g;
  let m;
  while ((m = re.exec(source))) {
    const literal = m[2];
    let compiled;
    try { compiled = eval(literal); } catch (e) { continue; }
    if (!(compiled instanceof RegExp)) continue;
    const line = source.slice(0, m.index).split('\n').length;
    out.push({ re: compiled, where: file + ':' + line, src: literal.slice(0, 90) });
  }
  return out;
}

/* Shapes chosen to defeat common patterns: long runs of one class, runs that
 * nearly satisfy a pattern then fail at the end, and repeated near-matches. */
function adversarialInputs(n) {
  return {
    letters: 'a'.repeat(n),
    upper: 'A'.repeat(n),
    digits: '1'.repeat(n),
    alnum: 'a1'.repeat(n / 2),
    words: 'ab '.repeat(n / 3),
    accented: 'ä'.repeat(n),
    spaces: ' '.repeat(n),
    dots: 'a.'.repeat(n / 2),
    dashes: 'a-'.repeat(n / 2),
    tags: '<a>'.repeat(n / 3),
    quotes: 'a"'.repeat(n / 2),
    stars: '*'.repeat(n),
    slashes: 'a/'.repeat(n / 2),
    'letters+bang': 'a'.repeat(n - 1) + '!',
    'digits+bang': '1'.repeat(n - 1) + '!',
    'words+bang': 'ab '.repeat((n - 1) / 3) + '!',
    'colons': 'a:'.repeat(n / 2),
    'newlines': 'ab\n'.repeat(n / 3),
    'mixed': 'aA1. '.repeat(n / 5),
  };
}

function timeRun(re, text) {
  // A fresh regex each time: a /g literal carries lastIndex between calls.
  const r = new RegExp(re.source, re.flags.replace('g', ''));
  const t0 = process.hrtime.bigint();
  r.test(text);
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

const SMALL = 2000;
const LARGE = 16000;     // 8x the input
const BUDGET_MS = 120;   // flat ceiling at 16 KB
const GROWTH = 16;       // 8x input should cost ~8x, not 64x
const NOISE_MS = 0.1;    // below this the small measurement is jitter

test('no regex in lib/ backtracks superlinearly on hostile input', () => {
  const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js'));
  const small = adversarialInputs(SMALL);
  const large = adversarialInputs(LARGE);
  const findings = [];
  let checked = 0;

  for (const file of files) {
    const source = fs.readFileSync(path.join(LIB, file), 'utf8');
    for (const { re, where, src } of regexLiterals(source, file)) {
      checked++;
      for (const shape of Object.keys(small)) {
        const a = timeRun(re, small[shape]);
        // Below the noise floor the ratio is meaningless, and a pattern that
        // fast at 2 KB cannot become dangerous at the 300 KB body cap.
        if (a < NOISE_MS) continue;
        const b = timeRun(re, large[shape]);
        if (b > BUDGET_MS || b / a > GROWTH) {
          findings.push(`${where} on "${shape}": ${a.toFixed(1)}ms at ${SMALL} → ${b.toFixed(1)}ms at ${LARGE}\n    ${src}`);
          break;
        }
      }
    }
  }

  assert.ok(checked > 150, 'expected to find the pattern catalogue, only saw ' + checked);
  assert.deepEqual(findings, [], 'superlinear regexes:\n  ' + findings.join('\n  '));
});

test('whole-page analysis stays fast on a hostile body of text', () => {
  const T = require('../lib/text-analyzer.js');
  const L = require('../lib/legitimacy.js');
  const S = require('../lib/site-analyzer.js');
  // The content script caps body text at 300 000 characters, so that is the
  // worst case a page can actually present.
  const CAP = 300000;
  const bodies = {
    'one long word': 'x'.repeat(CAP),
    'digits': '9'.repeat(CAP),
    'no spaces, mixed': 'aA1'.repeat(CAP / 3),
    'many short sentences': 'Ok. '.repeat(CAP / 4),
    'markup soup': '<a>'.repeat(CAP / 3),
    'invisible characters': '​'.repeat(CAP),
  };
  for (const [name, body] of Object.entries(bodies)) {
    for (const [label, run] of [
      ['text', () => T.analyzeText(body, { mode: 'page' })],
      ['legitimacy', () => L.analyzeLegitimacy({ url: 'https://a/', hostname: 'a', bodyText: body, links: [] })],
      ['site', () => S.analyzeSite({ hostname: 'a', lang: 'en', bodyText: body })],
    ]) {
      const t0 = Date.now();
      run();
      const ms = Date.now() - t0;
      assert.ok(ms < 4000, label + ' took ' + ms + 'ms on ' + name + ' (' + body.length + ' chars)');
    }
  }
});
