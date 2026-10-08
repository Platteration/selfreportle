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
/* The website's own scripts run their patterns over a file the visitor picked, which may be a
 * page a hostile site wrote for exactly this, so they are held to the same budget. */
const WEB = path.join(__dirname, '..', 'web');

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

test('no regex in lib/ or web/ backtracks superlinearly on hostile input', () => {
  const files = [
    ...fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).map((f) => path.join(LIB, f)),
    ...fs.readdirSync(WEB).filter((f) => f.endsWith('.js')).map((f) => path.join(WEB, f)),
  ];
  assert.ok(files.some((f) => f.endsWith(path.join('web', 'app.js'))), 'the walk reaches the website\'s scripts');
  const small = adversarialInputs(SMALL);
  const large = adversarialInputs(LARGE);
  const findings = [];
  let checked = 0;
  let pairs = 0;

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const { re, where, src } of regexLiterals(source, path.relative(path.join(__dirname, '..'), file))) {
      checked++;
      for (const shape of Object.keys(small)) {
        // Below the noise floor the ratio is meaningless, but the flat budget
        // still applies: every pair is checked against it. A pair that fails is
        // measured once more and reported only if it fails again: the bounded
        // three-item-list pattern, linear with a window of thirty, failed 1 run
        // in 12 of the whole suite on a machine shared with other test runs
        // (0.3 ms → 5.3 ms on "dashes", at 179f99f), when its 16 KB run met a
        // load spike three times over. A quadratic is slow on every run.
        const measure = () => {
          const a = timeRun(re, small[shape]);
          const b = timeRun(re, large[shape]);
          return b > BUDGET_MS || (a >= NOISE_MS && b / a > GROWTH) ? { a, b } : null;
        };
        pairs++;
        const hit = measure() && measure();
        if (hit) {
          findings.push(`${where} on "${shape}": ${hit.a.toFixed(1)}ms at ${SMALL} → ${hit.b.toFixed(1)}ms at ${LARGE}\n    ${src}`);
          break;
        }
      }
    }
  }

  assert.ok(checked > 150, 'expected to find the pattern catalogue, only saw ' + checked);
  assert.ok(pairs > 3000, 'every regex must be measured against every shape, only saw ' + pairs + ' pairs');
  assert.deepEqual(findings, [], 'superlinear regexes:\n  ' + findings.join('\n  '));
});

/*
 * Shapes derived from each pattern itself. The shapes above are generic, and
 * a pattern that opens with a token of its own — 【1†, "creator":{, Steps:,
 * freepik, canva — never meets its worst case in them: nine such patterns
 * were quadratic and passed every pair. 300 KB of unclosed citation markers
 * cost the text analyser 42 s; a 256 KB C2PA claim generator of "canva " cost
 * the shared worker 64 s; a 512 KB EXIF UserComment of "Steps: 1a" lines
 * 43 s. Each pattern is parsed into a small tree and walked with every
 * alternative and with its optional parts in and out; from each walk come a
 * near miss (the text less its last character) and, for every unbounded
 * repetition, the text up to it plus one character it accepts — the opener
 * of a scan that never finds its closer. Each unit is repeated to the same
 * two sizes and held to the same budgets as above.
 */
function patternTree(src) {
  let i = 0;
  const alt = () => { const branches = [seq()]; while (src[i] === '|') { i++; branches.push(seq()); } return branches.length === 1 ? branches[0] : { t: 'alt', branches }; };
  const seq = () => {
    const items = [];
    while (i < src.length && src[i] !== '|' && src[i] !== ')') {
      let node = atom();
      const q = /^(?:\*|\+|\?|\{(\d+)(?:(,)(\d*))?\})\??/.exec(src.slice(i));
      if (q) {
        i += q[0].length;
        const k = q[0][0];
        const [min, max] = k === '*' ? [0, Infinity] : k === '+' ? [1, Infinity] : k === '?' ? [0, 1]
          : [+q[1], q[2] ? (q[3] === '' ? Infinity : +q[3]) : +q[1]];
        node = { t: 'rep', node, min, max };
      }
      items.push(node);
    }
    return { t: 'seq', items };
  };
  const ch = (c) => ({ t: 'ch', c });
  const escape = () => {
    const c = src[i + 1];
    i += 2;
    const simple = { d: '1', D: 'a', w: 'a', W: '-', s: ' ', S: 'a', n: '\n', t: '\t', r: '\r' };
    if (Object.prototype.hasOwnProperty.call(simple, c)) return ch(simple[c]);
    if (c === 'b' || c === 'B' || /[1-9]/.test(c)) return { t: 'empty' };
    if (c === 'u') {
      const m = /^\{([0-9a-fA-F]+)\}|^([0-9a-fA-F]{4})/.exec(src.slice(i));
      if (m) { i += m[0].length; return ch(String.fromCodePoint(parseInt(m[1] || m[2], 16))); }
    }
    if (c === 'x') { i += 2; return ch(String.fromCharCode(parseInt(src.slice(i - 2, i), 16))); }
    return ch(c);
  };
  const charClass = () => {
    i++;
    const negated = src[i] === '^';
    if (negated) i++;
    const members = [];
    for (let first = true; i < src.length && (src[i] !== ']' || first); first = false) {
      if (src[i] === '\\') { const e = escape(); if (e.t === 'ch') members.push(e.c); continue; }
      members.push(src[i++]);
      if (src[i] === '-' && src[i + 1] !== ']' && i + 1 < src.length) { i++; if (src[i] === '\\') escape(); else i++; }
    }
    i++;
    if (!negated) return ch(members[0] || 'a');
    return ch([...'a1 xZ.-q'].find((c) => !members.includes(c)));
  };
  const atom = () => {
    const c = src[i];
    if (c === '(') {
      i++;
      let look = false;
      if (src[i] === '?') {
        if (src[i + 1] === ':') i += 2;
        else if (src[i + 1] === '<' && src[i + 2] !== '=' && src[i + 2] !== '!') i = src.indexOf('>', i) + 1;
        else { look = true; i += src[i + 1] === '<' ? 3 : 2; }
      }
      const inner = alt();
      i++;
      return look ? { t: 'empty' } : inner;
    }
    if (c === '[') return charClass();
    if (c === '\\') return escape();
    i++;
    if (c === '^' || c === '$') return { t: 'empty' };
    return ch(c === '.' ? 'a' : c);
  };
  return alt();
}

function derivedUnits(re) {
  let tree;
  try { tree = patternTree(re.source); } catch (e) { return []; }
  const widest = (n) => (n.t === 'alt' ? Math.max(n.branches.length, ...n.branches.map(widest))
    : n.t === 'seq' ? Math.max(1, ...n.items.map(widest)) : n.t === 'rep' ? widest(n.node) : 1);
  const once = (n) => (n.t === 'ch' ? n.c : n.t === 'seq' ? n.items.map(once).join('') : n.t === 'alt' ? once(n.branches[0]) : n.t === 'rep' ? once(n.node) : '') || 'a';
  const units = new Set();
  for (let k = 0; k < Math.min(widest(tree), 80); k++) {
    for (const optional of [true, false]) {
      let text = '';
      const cuts = [];
      const walk = (n) => {
        if (n.t === 'ch') text += n.c;
        else if (n.t === 'seq') n.items.forEach(walk);
        else if (n.t === 'alt') walk(n.branches[Math.min(k, n.branches.length - 1)]);
        else if (n.t === 'rep') {
          if (n.max === Infinity) cuts.push(text + once(n.node));
          const times = n.min > 0 ? Math.min(n.min, 3) : optional ? 1 : 0;
          for (let r = 0; r < times; r++) walk(n.node);
        }
      };
      walk(tree);
      if (text.length >= 2) units.add(text.slice(0, -1) + (/\s/.test(text.slice(-1)) ? 'a' : ' '));
      for (const cut of cuts) if (cut.length >= 2) units.add(cut);
    }
  }
  return [...units].filter((u) => u.length <= 400);
}

/* Sizes for the derived shapes, chosen by measurement. A bounded pattern is
 * linear but lumpy: the XMP AI-flag pattern scans up to a thousand characters
 * past every "<", and between 2 KB and 16 KB it grew 25-29x, past the 16x
 * above, with no quadratic in it (8 KB → 256 KB doubles with the input). A
 * 16x step separates the two: linear measured at most 77x across ten runs of
 * every derived unit, and quadratic is 256x. A flagged pair is measured once
 * more and reported only if it is flagged again; a real quadratic is slow on
 * every run. */
const DERIVED_SMALL = 4000;
const DERIVED_LARGE = 64000;   // 16x the input
const DERIVED_GROWTH = 128;    // linear stays under ~77x here, quadratic is ~256x
const DERIVED_BUDGET_MS = 500; // the slowest linear unit costs ~80 ms at 64 KB

test('no regex in lib/ or web/ backtracks superlinearly on near misses of itself', () => {
  const files = [
    ...fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).map((f) => path.join(LIB, f)),
    ...fs.readdirSync(WEB).filter((f) => f.endsWith('.js')).map((f) => path.join(WEB, f)),
  ];
  const fill = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  const flagged = (re, unit) => {
    const a = timeRun(re, fill(unit, DERIVED_SMALL));
    const b = timeRun(re, fill(unit, DERIVED_LARGE));
    return b > DERIVED_BUDGET_MS || (a >= NOISE_MS && b / a > DERIVED_GROWTH) ? { a, b } : null;
  };
  const findings = [];
  let checked = 0;
  let pairs = 0;
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const { re, where, src } of regexLiterals(source, path.relative(path.join(__dirname, '..'), file))) {
      checked++;
      for (const unit of derivedUnits(re)) {
        pairs++;
        const hit = flagged(re, unit) && flagged(re, unit);
        if (hit) {
          findings.push(`${where} on ${JSON.stringify(unit.slice(0, 40))} repeated: ${hit.a.toFixed(1)}ms at ${DERIVED_SMALL} → ${hit.b.toFixed(1)}ms at ${DERIVED_LARGE}\n    ${src}`);
          break;
        }
      }
    }
  }
  assert.ok(checked > 150, 'expected to find the pattern catalogue, only saw ' + checked);
  assert.ok(pairs > 2000, 'every regex must yield shapes of its own, only saw ' + pairs + ' pairs');
  // The walk reads what it should: two patterns that were quadratic, unit for unit.
  assert.ok(derivedUnits(/【\d+(?::\d+)?†[^】]*】/).includes('【1†a'), 'an unclosed citation marker is derived from its pattern');
  assert.ok(derivedUnits(/"creator"\s*:\s*(?:\{[^}]*"name")?/).some((u) => u.startsWith('"creator"') && u.includes('{')), 'and an opened, unclosed object');
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
    // Derived from the patterns: a citation marker opened and never closed
    // (42 s), and blank lines that the heading and bullet detectors' \s*
    // crossed one start at a time (over a minute), each at this cap.
    'unclosed citation markers': '【1†a '.repeat(CAP / 5),
    'blank lines after a sentence': 'We baked bread today. ' + '\n '.repeat((CAP - 22) / 2),
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
    /* Derived from the patterns (see "near misses of itself" above), through the
     * worker's own entry point: an EXIF UserComment of generation-parameter
     * lines that never name a sampler, which a PNG eXIf chunk carries at any
     * length (43 s at this size), and a signed claim whose generator repeats a
     * tool-name prefix the generator pattern then scanned to the end from each
     * time (64 s and 46 s). */
    'PNG eXIf UserComment of parameters that never name a sampler': H.png([H.pngChunk('eXIf', H.tiff([{ tag: 0x9286, type: 7, value: H.concat([H.str('ASCII\0\0\0'), H.str('Steps: 1a\n'.repeat(52429))]) }]))]),
    'C2PA claim generator of "canva " repeated': (await H.signedC2paAsset({ container: 'png', generator: 'canva '.repeat(43691) })).bytes,
    'C2PA claim generator of "adobe express " repeated': (await H.signedC2paAsset({ container: 'png', generator: 'adobe express '.repeat(18725) })).bytes,
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

/*
 * Linear is not cheap enough when the constant is the scan length. A packet of
 * self-closing tags that never close, or of tags inside a value that never
 * close, had every "<" scan a thousand characters past it, the next "<"
 * included: 1.2 s and 0.4 s at the packet cap, per image, in the shared
 * worker, against 14 ms and 30 ms for the same packets closed — growth checks
 * see nothing, since doubling the packet doubles the cost. One of the two
 * patterns is built with `new RegExp`, which no literal scan sees. Each is
 * held here to the packet with its tags closed, measured in the same run.
 */
test('an XMP packet of tags that never close costs about what the same tags closed do', async () => {
  const M = require('../lib/image-metadata.js');
  const H = require('./helpers.js');
  const riff = (chunks) => {
    const body = H.concat([H.str('WEBP'), ...chunks]);
    const hdr = new Uint8Array(8);
    hdr.set(H.str('RIFF'), 0);
    new DataView(hdr.buffer).setUint32(4, body.length, true);
    return H.concat([hdr, body]);
  };
  const webpXmp = (xml) => riff([H.webpChunk('VP8 ', new Uint8Array(64)), H.webpChunk('XMP ', H.str(xml))]);
  const N = 250 * 1024;   // under the packet cap, so the closing tag of the value is read
  const fill = (unit) => unit.repeat(Math.floor(N / unit.length));
  const once = async (bytes) => {
    const t0 = Date.now();
    await M.analyzeImageBytes(bytes, {});
    return Date.now() - t0;
  };
  for (const [what, open, closed] of [
    ['self-closing tags', fill('<xmp:CreatorTool rdf:resource="a" '), fill('<xmp:CreatorTool rdf:resource="a"/>')],
    ['tags inside a value', '<xmp:CreatorTool>' + fill('<a ') + '</xmp:CreatorTool>', '<xmp:CreatorTool>' + fill('<a>') + '</xmp:CreatorTool>'],
  ]) {
    // Alternately and five times each, the fastest of each kept: a load spike
    // from the suites running beside this one lands on one run, not on five.
    let control = Infinity;
    let crafted = Infinity;
    for (let i = 0; i < 5; i++) {
      control = Math.min(control, await once(webpXmp(closed)));
      crafted = Math.min(crafted, await once(webpXmp(open)));
    }
    assert.ok(crafted <= 4 * control + 50, what + ' that never close: ' + crafted + 'ms against ' + control + 'ms closed');
  }
});

/* The other two entry points the derived shapes reach: structured data at the
 * snapshot's own cap (40 blocks of 50,000 characters; 8 s when each opened
 * "creator" object was scanned to the end for a "name"), and the alt text of a
 * picture in a saved page, which the website reads at any length (13 s for
 * 256 KB of "freepik "). */
test('structured data and alt text at their caps stay fast', () => {
  const S = require('../lib/site-analyzer.js');
  const IH = require('../lib/image-hints.js');
  const fill = (unit, n) => unit.repeat(Math.ceil(n / unit.length)).slice(0, n);
  let t0 = Date.now();
  S.analyzeSite({ hostname: 'a', lang: 'en', bodyText: '', jsonLd: Array.from({ length: 40 }, () => fill('"creator":{"a" ', 50000)) });
  let ms = Date.now() - t0;
  assert.ok(ms < 1000, 'JSON-LD of unclosed creator objects took ' + ms + 'ms');
  for (const unit of ['freepik ', 'photoshop ', 'canva ']) {
    t0 = Date.now();
    IH.analyzeImageHints({ url: 'https://a.example/x.png', alt: fill(unit, 300000) });
    ms = Date.now() - t0;
    assert.ok(ms < 1000, 'alt text of "' + unit + '" repeated took ' + ms + 'ms');
  }
});
