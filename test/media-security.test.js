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

test('the PNG metadata budget accumulates across compressed and plain text chunks', async () => {
  const compressed = zlib.deflateSync(Buffer.alloc(24, 65));
  const bytes = H.png([
    H.pngChunk('zTXt', H.concat([H.str('First\0'), new Uint8Array([0]), compressed])),
    H.tEXt('Second', 'x'.repeat(24)),
  ]);
  const r = await M.analyzeImageBytes(bytes, { maxMetadataBytes: 32 });
  assert.equal(r.metadata.pngText.First.length, 24);
  // Cut at the 8 bytes the first chunk left, not kept whole and not the
  // parse abandoned: 32 kept in all, which is the budget.
  assert.equal(r.metadata.pngText.Second, 'x'.repeat(8));
  assert.ok(r.signals.some((s) => /too large to inspect/.test(s.label)));
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
