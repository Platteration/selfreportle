const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/*
 * This project is mostly regular expressions run over whatever text a page
 * happens to contain, in the content script, on the page's own thread. A
 * pattern that backtracks quadratically is therefore a denial of service that
 * any site can trigger: one long run of the wrong character and the tab
 * freezes. Three shipped that way — an unbounded compound-street prefix, an
 * unbounded e-mail local part, and an unbounded word class in the three-item
 * list detector — so this guard is permanent.
 *
 * Every regex literal in lib/ is run against inputs designed to make a
 * backtracking engine work hard, at 2 KB and again at 16 KB. Every pair is
 * held to a flat budget; the growth ratio is checked as well whenever the
 * small measurement is above the timer's noise floor, since 8x the input
 * costing more than 16x the time is the signature of superlinear behaviour.
 *
 * The flat budget must apply to every pair, not only to pairs that already
 * looked slow: pages present up to 300 KB of body text, which is 150x the
 * small sample, so a quadratic pattern measuring a mere 0.09 ms here would
 * cost around two seconds there.
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

/*
 * The fastest of three runs, not one run. A single measurement of a
 * sub-millisecond match picks up whatever else the machine was doing — a GC
 * pause or a scheduler slice lands entirely inside it — and a noisy small
 * measurement is what the growth ratio divides by, so the suite reported
 * linear patterns as superlinear on a loaded machine. The minimum is the run
 * that was not interrupted. It does not weaken the guard: a pattern that
 * really backtracks is slow on every run, which was confirmed by putting the
 * historical unbounded three-item-list pattern back and watching it still be
 * caught on every attempt.
 */
function timeRun(re, text) {
  // A fresh regex each time: a /g literal carries lastIndex between calls.
  const r = new RegExp(re.source, re.flags.replace('g', ''));
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = process.hrtime.bigint();
    r.test(text);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (ms < best) best = ms;
  }
  return best;
}

const SMALL = 2000;
const LARGE = 16000;     // 8x the input
const BUDGET_MS = 120;   // flat ceiling at 16 KB, applied to every pair
const GROWTH = 16;       // 8x input should cost ~8x, not 64x
const NOISE_MS = 0.1;    // below this the small measurement is jitter

test('no regex in lib/ backtracks superlinearly on hostile input', () => {
  const files = fs.readdirSync(LIB).filter((f) => f.endsWith('.js'));
  const small = adversarialInputs(SMALL);
  const large = adversarialInputs(LARGE);
  const findings = [];
  let checked = 0;
  let pairs = 0;

  for (const file of files) {
    const source = fs.readFileSync(path.join(LIB, file), 'utf8');
    for (const { re, where, src } of regexLiterals(source, file)) {
      checked++;
      for (const shape of Object.keys(small)) {
        const a = timeRun(re, small[shape]);
        const b = timeRun(re, large[shape]);
        pairs++;
        // Below the noise floor the ratio is meaningless, but the flat budget
        // still applies: every pair is checked against it.
        if (b > BUDGET_MS || (a >= NOISE_MS && b / a > GROWTH)) {
          findings.push(`${where} on "${shape}": ${a.toFixed(1)}ms at ${SMALL} → ${b.toFixed(1)}ms at ${LARGE}\n    ${src}`);
          break;
        }
      }
    }
  }

  assert.ok(checked > 150, 'expected to find the pattern catalogue, only saw ' + checked);
  assert.ok(pairs > 3000, 'every regex must be measured against every shape, only saw ' + pairs + ' pairs');
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
    // Not backtracking: findVat used to compile 29 country formats for every
    // one of these context words, which the growth-ratio check above cannot
    // see. test/legitimacy.test.js holds the bound that actually catches it.
    'VAT context words': 'vat '.repeat(CAP / 4),
    'NIP context words': 'nip '.repeat(CAP / 4),
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

/*
 * L1-1 / L1-2. The literal scanner above cannot see either of these: the XMP
 * element regex is built with `new RegExp` from the field name, and a zlib
 * bomb is not a regex at all. Both live in lib/image-metadata.js, which the
 * whole-page guard never loaded, and both cost the one service worker every
 * tab shares — measured at 29 s for a 1 MB XMP packet and a 1.1 GB resident
 * spike for a 512 KB PNG. The bound below is derived from the fetch cap the
 * worker actually enforces (lib/settings.js maxImageBytes), not from the
 * sizes that happened to reproduce it.
 */
test('image parsing stays fast and bounded on a hostile image', async () => {
  const M = require('../lib/image-metadata.js');
  const zlib = require('zlib');
  const H = require('./helpers.js');
  const CAP = require('../lib/settings.js').DEFAULTS.maxImageBytes;   // what the worker will fetch

  /* A run of sixteen-byte JUMBF boxes: the smallest shape that maximises how
   * many boxes a region declares, which is what the parser's cost is counted
   * in. Each unit is a `jumb` box eight bytes long holding an empty `jumd`,
   * so every one of them is found by the byte-scan and none of them yields a
   * label, which is what keeps the scan attempting. */
  const jumbfLattice = (n) => {
    const u32 = (v) => { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v); return a; };
    const unit = H.concat([u32(16), H.str('jumb'), u32(8), H.str('jumd')]);
    return H.concat(Array.from({ length: Math.floor(n / unit.length) }, () => unit));
  };

  const riff = (chunks) => {
    const body = H.concat([H.str('WEBP'), ...chunks]);
    const hdr = new Uint8Array(8);
    hdr.set(H.str('RIFF'), 0);
    new DataView(hdr.buffer).setUint32(4, body.length, true);
    return H.concat([hdr, body]);
  };

  /* A zTXt whose deflate stream inflates about 1000:1: at the fetch cap the
   * same shape is several gigabytes of output from megabytes of input. */
  const deflated = (n) => new Uint8Array(zlib.deflateSync(Buffer.alloc(n, 0x41), { level: 9 }));
  const ztxtOf = (n, key) => H.pngChunk('zTXt', H.concat([H.str(key + '\0'), Uint8Array.from([0]), deflated(n)]));
  const ztxt = ztxtOf(512 * 1024 * 1024, 'Comment');
  // The same bomb split across chunks, to catch a ceiling that is per chunk
  // and then forgotten. How much one image may keep in total is pinned
  // behaviourally in test/image-metadata.test.js.
  const many = Array.from({ length: 32 }, (_, i) => ztxtOf(8 * 1024 * 1024, 'C' + i));

  const hostile = {
    'PNG zTXt decompression bomb': H.png([ztxt]),
    'PNG zTXt bomb, many chunks': H.png(many),
    'WebP XMP packet of unclosed elements': riff([H.webpChunk('VP8 ', new Uint8Array(64)), H.webpChunk('XMP ', H.str('<CreatorTool>'.repeat(Math.floor(CAP / 13))))]),
    'WebP XMP packet of unclosed AI flags': riff([H.webpChunk('VP8 ', new Uint8Array(64)), H.webpChunk('XMP ', H.str('<x:AIGenerated '.repeat(Math.floor(CAP / 15))))]),
    'SVG of unclosed comments': H.str('<svg xmlns="http://www.w3.org/2000/svg">' + '<!--'.repeat(Math.floor(CAP / 4))),
    /*
     * A decodable image is not the end of the work. When a format-specific
     * parse finds no manifest the C2PA fallback scans the whole buffer for
     * the bytes "jumb", up to 64 times, and each attempt used to parse the
     * boxes from there to the end of the file. A valid 1x1 PNG — which
     * decodes, and styled to 100x100 passes every page-load and size gate —
     * followed by a lattice of empty jumb/jumd boxes measured 2.1 s at
     * 256 KB and 54.5 s at the fetch cap, in the one service worker every
     * tab shares, four images at a time. It is the shape none of the other
     * caps touch: nothing here inflates, decompresses or backtracks.
     */
    'PNG with a trailing JUMBF lattice': H.concat([H.png([]), jumbfLattice(CAP - 4096)]),
    // The same lattice with no format in front of it, which takes the generic
    // scan as well as the fallback, so the allowance has to cover both.
    'JUMBF lattice and no format at all': jumbfLattice(CAP),
  };

  const before = process.memoryUsage().rss;
  for (const [name, bytes] of Object.entries(hostile)) {
    assert.ok(bytes.length <= CAP + 65536, name + ' is bigger than the worker would ever fetch');
    const t0 = Date.now();
    await M.analyzeImageBytes(bytes, {});
    const ms = Date.now() - t0;
    assert.ok(ms < 4000, name + ' took ' + ms + 'ms (' + bytes.length + ' bytes)');
  }
  // Four of these run at once in the worker, so the whole set has to fit in
  // memory a service worker is allowed to have.
  const grew = (process.memoryUsage().rss - before) / (1 << 20);
  assert.ok(grew < 256, 'parsing the hostile set grew RSS by ' + Math.round(grew) + ' MB');

  /*
   * Growth, not only a wall clock. Capping the packet bounds the damage but
   * does not remove it: a quadratic scan inside the cap still costs seconds
   * of the shared worker per image, four at a time. Quadrupling the packet
   * must not do much more than quadruple the work.
   */
  const xmpCost = async (n) => {
    const bytes = riff([H.webpChunk('VP8 ', new Uint8Array(64)), H.webpChunk('XMP ', H.str('<CreatorTool>'.repeat(Math.floor(n / 13))))]);
    const t0 = Date.now();
    await M.analyzeImageBytes(bytes, {});
    return Date.now() - t0;
  };
  const quarter = await xmpCost(64 * 1024);
  const whole = await xmpCost(256 * 1024);
  assert.ok(whole < Math.max(150, quarter * 8), 'XMP parsing grew from ' + quarter + 'ms at 64 KB to ' + whole + 'ms at 256 KB');
});
