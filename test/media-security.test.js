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
  assert.ok(r.signals.some((s) => /Metadata byte budget exceeded/.test(s.label)));
  assert.equal((r.metadata.pngText || {}).Comment, undefined);
});

test('the real Node zlib fallback also enforces its output limit', async () => {
  const previous = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    const bytes = H.png([H.iTXt('Comment', 'A'.repeat(256), true)]);
    const r = await M.analyzeImageBytes(bytes, { maxMetadataBytes: 32 });
    assert.ok(r.signals.some((s) => /Metadata byte budget exceeded/.test(s.label)));
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
  assert.equal(r.metadata.pngText.Second, undefined);
  assert.ok(r.signals.some((s) => /Metadata byte budget exceeded/.test(s.label)));
});

function worker(fetch) {
  const noop = { addListener() {} };
  const sandbox = {
    self: { SRL: { byteBudget: B } }, importScripts() {}, fetch, setTimeout, clearTimeout, AbortController,
    chrome: { runtime: { onInstalled: noop, onMessage: noop }, contextMenus: { onClicked: noop }, tabs: { onRemoved: noop, onUpdated: noop } },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background/service-worker.js'), 'utf8') + '\nglobalThis.fetchTailForTest = fetchTail; globalThis.fetchBytesForTest = fetchBytes;', sandbox);
  return sandbox;
}

test('an oversized 206 tail is canceled and rejected rather than fully buffered', async () => {
  const source = body([new Uint8Array(12), new Uint8Array(12)]);
  const w = worker(async () => ({ status: 206, body: source, arrayBuffer() { throw new Error('must not buffer the body'); } }));
  await assert.rejects(w.fetchTailForTest('https://media.example/clip.mp4', 8), { name: 'BudgetExceeded' });
  assert.equal(source.canceled, true);
  assert.equal(source.reads, 1);
});

test('a correctly sized 206 tail is retained', async () => {
  const w = worker(async () => ({ status: 206, body: body([new Uint8Array(8).fill(7)]) }));
  assert.deepEqual(Array.from(await w.fetchTailForTest('https://media.example/clip.mp4', 8)), Array(8).fill(7));
});

test('the main range reader retains capped bytes and content-range truncation', async () => {
  const w = worker(async () => ({ status: 206, body: body([new Uint8Array(8)]), headers: { get(name) { return name === 'content-range' ? 'bytes 0-7/100' : 'video/mp4'; } } }));
  const r = await w.fetchBytesForTest('https://media.example/clip.mp4', 8);
  assert.equal(r.bytes.length, 8);
  assert.equal(r.truncated, true);
});

test('a 206 without complete range accounting cannot authenticate a whole asset', async () => {
  const w = worker(async () => ({ status: 206, body: body([new Uint8Array(8)]), headers: { get() { return null; } } }));
  const r = await w.fetchBytesForTest('https://media.example/image.png', 8);
  assert.equal(r.truncated, true);
});

test('a 206 covering the complete small asset remains eligible for hard binding', async () => {
  const w = worker(async () => ({ status: 206, body: body([new Uint8Array(8)]), headers: { get(name) { return name === 'content-range' ? 'bytes 0-7/8' : 'image/png'; } } }));
  const r = await w.fetchBytesForTest('https://media.example/image.png', 8);
  assert.equal(r.truncated, false);
});
