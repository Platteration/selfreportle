const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const H = require('./helpers.js');
const M = require('../lib/image-metadata.js');
const B = require('../lib/byte-budget.js');

function body(chunks) {
  let index = 0;
  let canceled = false;
  return {
    getReader() { return { async read() { return index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; }, async cancel() { canceled = true; }, releaseLock() {} }; },
    get canceled() { return canceled; }, get reads() { return index; },
  };
}

test('streamed blob prefixes stop at the byte cap and cancel the source', async () => {
  const source = body([new Uint8Array(8).fill(1), new Uint8Array(8).fill(2), new Uint8Array(8).fill(3)]);
  const read = await B.read(source, 10);
  assert.equal(read.bytes.length, 10);
  assert.equal(read.truncated, true);
  assert.equal(source.canceled, true);
  assert.equal(source.reads, 2);
});

test('small compressed metadata exceeding a small budget is rejected before text conversion', async () => {
  const compressed = zlib.deflateSync(Buffer.alloc(256, 65));
  const bytes = H.png([H.pngChunk('zTXt', H.concat([H.str('Comment\0'), new Uint8Array([0]), compressed]))]);
  const r = await M.analyzeImageBytes(bytes, { maxMetadataBytes: 32 });
  assert.ok(r.signals.some((s) => /too large to inspect/.test(s.label)));
  assert.equal((r.metadata.pngText || {}).Comment, undefined);
});

test('the real Node zlib fallback also enforces its output limit', async () => {
  const previous = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    const bytes = H.png([H.iTXt('Comment', 'A'.repeat(256), true)]);
    const r = await M.analyzeImageBytes(bytes, { maxMetadataBytes: 32 });
    assert.ok(r.signals.some((s) => /too large to inspect/.test(s.label)));
    assert.equal((r.metadata.pngText || {}).Comment, undefined);
  } finally { globalThis.DecompressionStream = previous; }
});

test('the PNG metadata budget accumulates across compressed and plain text chunks, keys included', async () => {
  const compressed = zlib.deflateSync(Buffer.alloc(24, 65));
  const bytes = H.png([
    H.pngChunk('zTXt', H.concat([H.str('First\0'), new Uint8Array([0]), compressed])),
    H.tEXt('Second', 'x'.repeat(24)),
  ]);
  const r = await M.analyzeImageBytes(bytes, { maxMetadataBytes: 40 });
  assert.equal(r.metadata.pngText.First.length, 24);
  // Cut at the 5 bytes the first chunk and the two keys left (40 - 5 - 24 - 6),
  // not kept whole and not the parse abandoned: 40 kept in all, keys included,
  // which is the budget.
  assert.equal(r.metadata.pngText.Second, 'x'.repeat(5));
  assert.ok(r.signals.some((s) => /too large to inspect/.test(s.label)));
});

/* A key was kept free of the budget, in any number: a 4 MB PNG of empty tEXt
 * chunks under distinct keys kept 198,429 of them (2.6 MB of report, cached
 * in the worker every tab shares), with no note. Now a key is charged before
 * it is kept, one longer than the 79 bytes the specification allows is not
 * read, and no more than 100 text chunks are read in all. */
test('PNG text keys are charged to the budget, and a file of many keys keeps a bounded few', async () => {
  const many = H.png(Array.from({ length: 5000 }, (_, i) => H.tEXt('k' + i, '')));
  const r = await M.analyzeImageBytes(many);
  assert.equal(Object.keys(r.metadata.pngText).length, 100, 'the first 100 text chunks are read');
  assert.deepEqual(Object.keys(r.metadata.pngText).slice(0, 3), ['k0', 'k1', 'k2'], 'in file order');
  assert.ok(r.signals.some((s) => /too large to inspect/.test(s.label)), 'and the rest is said to be skipped');

  const full = await M.analyzeImageBytes(H.png([H.tEXt('parameters', 'Steps: 20, ' + 'x'.repeat(256 * 1024)), H.tEXt('Software', '')]));
  assert.equal(full.metadata.pngText.parameters.length, 300, 'a value that fills the budget is kept');
  assert.ok(!Object.prototype.hasOwnProperty.call(full.metadata.pngText, 'Software'), 'and a key after it is not: there is no budget left for it');

  const at = (n) => 'K'.repeat(n);
  const long = await M.analyzeImageBytes(H.png([H.tEXt(at(80), 'too long'), H.tEXt(at(79), 'fits')]));
  assert.deepEqual(long.metadata.pngText, { [at(79)]: 'fits' }, 'a key of 80 bytes is skipped, one of 79 is read');
  assert.ok(long.signals.some((s) => /too large to inspect/.test(s.label)), 'and the skip is reported');
  const plain = await M.analyzeImageBytes(H.png([H.tEXt(at(79), 'fits')]));
  assert.ok(!plain.signals.some((s) => /too large to inspect/.test(s.label)), 'control: nothing skipped, nothing reported');
});

/* Each compressed chunk is an inflate, and one that fails at once costs the
 * budget nothing: a 4 MB file of tiny zTXt chunks held the worker 21 s, one
 * whose streams were garbage 55 s. Only the first 100 text chunks are read,
 * so only they are inflated. */
test('a PNG of thousands of compressed text chunks inflates no more than 100 of them', async () => {
  const previous = globalThis.DecompressionStream;
  let streams = 0;
  globalThis.DecompressionStream = class extends previous { constructor(...a) { super(...a); streams++; } };
  try {
    const garbage = H.png(Array.from({ length: 3000 }, (_, i) => H.pngChunk('zTXt', H.concat([H.str('k' + i + '\0'), new Uint8Array([0, 0xff])]))));
    const r = await M.analyzeImageBytes(garbage);
    assert.equal(streams, 100, 'the first 100 are inflated, and no more');
    assert.ok(r.signals.some((s) => /too large to inspect/.test(s.label)));
    streams = 0;
    const tiny = zlib.deflateSync(Buffer.from('a'));
    const itxt = H.png(Array.from({ length: 3000 }, (_, i) => H.pngChunk('iTXt', H.concat([H.str('k' + i + '\0'), new Uint8Array([1, 0, 0, 0]), tiny]))));
    const kept = await M.analyzeImageBytes(itxt);
    assert.equal(streams, 100, 'iTXt the same');
    assert.equal(Object.keys(kept.metadata.pngText).length, 100);
  } finally { globalThis.DecompressionStream = previous; }
});

/* A caller may lower the budget, never raise it: asked for a megabyte, the
 * parser still stops at 256 KB, key and value together. */
test('a caller asking for more PNG text than 256 KB still gets 256 KB', async () => {
  const cut = (n) => M.analyzeImageBytes(H.png([H.tEXt('parameters', 'x'.repeat(n))]), { maxMetadataBytes: 1024 * 1024 })
    .then((r) => r.signals.some((s) => /too large to inspect/.test(s.label)));
  const room = 256 * 1024 - 'parameters'.length;
  assert.equal(await cut(room - 1), false, 'a byte short of 256 KB is read whole');
  assert.equal(await cut(room + 1), true, 'a byte past it is cut, and the cut reported');
});

/* What does not fit is skipped, and the file is still read past it: a caBX
 * after a text chunk that spends the whole budget is found, which an abort
 * on the budget would have left unread. */
test('a full text budget skips the text, not the credentials after it', async () => {
  const compressed = zlib.deflateSync(Buffer.alloc(4096, 65));
  const manifest = H.c2paManifest({ generator: 'DALL-E', actions: [{ action: 'c2pa.created', digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia' }] });
  const bytes = H.png([H.pngChunk('zTXt', H.concat([H.str('Comment\0'), new Uint8Array([0]), compressed])), H.pngChunk('caBX', manifest)]);
  const r = await M.analyzeImageBytes(bytes, { maxMetadataBytes: 32 });
  assert.ok(r.signals.some((s) => /too large to inspect/.test(s.label)), 'the skipped text is reported');
  assert.ok(r.metadata.c2pa, 'and the credentials after it are read');
  assert.ok(r.signals.some((s) => s.id === 'c2pa-ai-created'));
});

function worker(fetch) {
  const noop = { addListener() {} };
  const sandbox = {
    self: { SRL: { byteBudget: B, fetchPolicy: require('../lib/fetch-policy.js'), imageMeta: M } }, importScripts() {}, fetch, setTimeout, clearTimeout, AbortController, atob,
    chrome: { runtime: { onInstalled: noop, onMessage: noop, getURL: (p) => 'chrome-extension://selfreportle/' + p }, contextMenus: { onClicked: noop }, tabs: { onRemoved: noop, onUpdated: noop } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background/service-worker.js'), 'utf8') + '\nglobalThis.fetchTailForTest = fetchTail; globalThis.fetchBytesForTest = fetchBytes; globalThis.analyzeOneForTest = analyzeOne; globalThis.budgetsForTest = budgets;', sandbox);
  return sandbox;
}

// A public page, so the policy lets the worker reach the public media host.
const PAGE = 'https://page.example/article';
const TAB = 7;

test('an oversized 206 tail is canceled and rejected rather than fully buffered', async () => {
  const source = body([new Uint8Array(12), new Uint8Array(12)]);
  const w = worker(async () => ({ status: 206, body: source, arrayBuffer() { throw new Error('must not buffer the body'); } }));
  await assert.rejects(w.fetchTailForTest('https://media.example/clip.mp4', 8, PAGE, TAB), { name: 'BudgetExceeded' });
  assert.equal(source.canceled, true);
  assert.equal(source.reads, 1);
  assert.equal(w.budgetsForTest.get(TAB).bytes, 12, 'what arrived before the refusal is charged to the tab');
});

/* The refusal is the tail's alone. A video whose head says what made it, cut
 * at the cap with no index read, asks for its tail; a host that answers with
 * one byte more than was asked lost the head's finished verdict to "Could not
 * fetch image bytes", where one that answers exactly kept it. */
test('a refused tail leaves the head\'s analysis standing', async () => {
  const xmp = H.xmpPacket('<rdf:Description xmlns:Iptc4xmpExt="http://iptc.org/std/Iptc4xmpExt/2008-02-29/" Iptc4xmpExt:DigitalSourceType="http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia"/>');
  const head = H.concat([H.isoBox('ftyp', H.concat([H.str('mp42'), new Uint8Array(4), H.str('mp42isom')])), H.isoBox('free', H.str(xmp)), H.isoBox('mdat', new Uint8Array(4096))]);
  const cap = head.length;
  const run = async (extra) => {
    const asked = [];
    const tail = body([new Uint8Array(cap + extra)]);
    const w = worker(async (url, init) => {
      asked.push(init.headers.Range);
      if (asked.length === 1) return { ok: false, status: 206, type: 'basic', url, redirected: false, body: body([head]), headers: { get: (n) => (n === 'content-range' ? 'bytes 0-' + (cap - 1) + '/999999' : n === 'content-type' ? 'video/mp4' : null) } };
      return { ok: false, status: 206, type: 'basic', url, redirected: false, body: tail, headers: { get: () => null } };
    });
    const r = await w.analyzeOneForTest({ id: 'v1', url: 'https://media.example/clip.mp4', kind: 'av' }, cap, cap, PAGE, TAB);
    return { r, asked, tail, charged: w.budgetsForTest.get(TAB).bytes };
  };
  const exact = await run(0);
  assert.deepEqual(exact.asked, ['bytes=0-' + (cap - 1), 'bytes=-' + cap], 'control: the head, then the tail, are asked for');
  assert.ok(exact.r.signals.some((s) => s.id === 'xmp-dst'), 'control: a tail of the size asked keeps the head\'s verdict');
  const over = await run(1);
  assert.equal(over.asked.length, 2, 'the tail was asked for');
  assert.equal(over.tail.canceled, true, 'and refused as it arrived');
  assert.equal(over.charged, cap + cap + 1, 'what arrived of it is charged to the tab');
  assert.ok(over.r.signals.some((s) => s.id === 'xmp-dst'), 'the head\'s verdict stands');
  assert.ok(!over.r.signals.some((s) => s.id === 'unavailable'), 'not "could not fetch"');
  assert.equal(over.r.tailRead, undefined, 'and nothing of the tail was used');
});

test('a correctly sized 206 tail is retained', async () => {
  const w = worker(async () => ({ status: 206, body: body([new Uint8Array(8).fill(7)]) }));
  assert.deepEqual(Array.from(await w.fetchTailForTest('https://media.example/clip.mp4', 8, PAGE, TAB)), Array(8).fill(7));
  assert.equal(w.budgetsForTest.get(TAB).bytes, 8);
});

test('the main range reader retains capped bytes and content-range truncation', async () => {
  const w = worker(async () => ({ status: 206, body: body([new Uint8Array(8)]), headers: { get(name) { return name === 'content-range' ? 'bytes 0-7/100' : 'video/mp4'; } } }));
  const r = await w.fetchBytesForTest('https://media.example/clip.mp4', 8, PAGE, TAB);
  assert.equal(r.bytes.length, 8);
  assert.equal(r.truncated, true);
  assert.equal(w.budgetsForTest.get(TAB).bytes, 8, 'and the bytes read are charged to the tab');
});

test('a 206 without complete range accounting cannot authenticate a whole asset', async () => {
  const w = worker(async () => ({ status: 206, body: body([new Uint8Array(8)]), headers: { get() { return null; } } }));
  const r = await w.fetchBytesForTest('https://media.example/image.png', 8, PAGE, TAB);
  assert.equal(r.truncated, true);
});

test('a 206 covering the complete small asset remains eligible for hard binding', async () => {
  const w = worker(async () => ({ status: 206, body: body([new Uint8Array(8)]), headers: { get(name) { return name === 'content-range' ? 'bytes 0-7/8' : 'image/png'; } } }));
  const r = await w.fetchBytesForTest('https://media.example/image.png', 8, PAGE, TAB);
  assert.equal(r.truncated, false);
});

/* The content script caps what it encodes, but the worker does not take a
 * caller's length on trust: base64 past the cap is refused before it is
 * decoded, and the decoded bytes are held to the cap as well (four base64
 * characters carry three bytes, so the first check alone lets two through). */
test('page bytes past the cap are refused before they are parsed', async () => {
  const w = worker(async () => { throw new Error('page bytes are not fetched'); });
  const one = (base64) => w.analyzeOneForTest({ id: 'i1', url: 'blob:https://page.example/x', base64 }, 7, 0, PAGE, TAB);
  const refused = (r) => r.signals.length === 1 && r.signals[0].id === 'unavailable' && /byte budget exceeded/.test(r.signals[0].detail);
  assert.ok(refused(await one('A'.repeat(16))), 'longer than 7 bytes could ever encode to');
  assert.ok(refused(await one('!'.repeat(16))), 'and refused before decoding: these characters would not decode at all');
  assert.ok(refused(await one('A'.repeat(12))), 'nine decoded bytes, two past the cap');
  const within = await one('A'.repeat(8));
  assert.equal(within.bytes, 6, 'six bytes are within it and are parsed');
  assert.ok(!refused(within));
});

/* An iTXt chunk whose language tag, or translated keyword, is never
 * terminated was read from the wrong offset: indexOf answered -1, the next
 * search began at 0 and found the keyword's own terminator, and the flag
 * bytes and tag came out as the text. Such a chunk is skipped. */
test('an iTXt chunk missing a terminator is skipped, not read from the wrong offset', async () => {
  const itxt = (tail) => H.pngChunk('iTXt', H.concat([H.str('Comment\0'), new Uint8Array([0, 0]), H.str(tail)]));
  for (const [what, tail] of [['no end to the language tag', 'en'], ['no end to the translated keyword', 'en\0Kommentar']]) {
    const r = await M.analyzeImageBytes(H.png([itxt(tail)]));
    assert.equal((r.metadata.pngText || {}).Comment, undefined, what);
  }
  const whole = await M.analyzeImageBytes(H.png([itxt('en\0Kommentar\0hello')]));
  assert.equal(whole.metadata.pngText.Comment, 'hello', 'control: a complete chunk is read');
});

/* The default budget, with no caller lowering it: 256 KB of PNG text, the
 * rest of a longer value cut away and said so. */
test('PNG text is kept to 256 KB per image', async () => {
  const r = await M.analyzeImageBytes(H.png([H.tEXt('parameters', 'Steps: 20, ' + 'x'.repeat(300 * 1024))]));
  assert.equal(r.metadata.pngText.parameters.length, 300, 'the summary shows the start of it');
  assert.ok(r.signals.some((s) => s.id === 'png-sd'), 'a value cut short still names its generator');
  assert.ok(r.signals.some((s) => /too large to inspect/.test(s.label)), 'and the cut is reported');
  const under = await M.analyzeImageBytes(H.png([H.tEXt('parameters', 'Steps: 20, ' + 'x'.repeat(200 * 1024))]));
  assert.ok(!under.signals.some((s) => /too large to inspect/.test(s.label)), 'control: 200 KB fits');
});
