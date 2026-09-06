const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../lib/cbor.js');

test('round trip', () => {
  const v = { claim_generator: 'OpenAI', n: 1234567, neg: -5, arr: [1, 'x', new Uint8Array([1, 2, 3])], nested: { a: true, b: null, f: 1.5 }, 33: 'x5' };
  const d = C.decodeValue(C.encode(v));
  assert.equal(d.claim_generator, 'OpenAI');
  assert.equal(d.n, 1234567);
  assert.equal(d.neg, -5);
  assert.deepEqual([...d.arr[2]], [1, 2, 3]);
  assert.equal(d.nested.f, 1.5);
  assert.equal(d['33'], 'x5');
});

test('indefinite length arrays and strings', () => {
  const bytes = Uint8Array.from([0x9f, 0x01, 0x5f, 0x41, 0x61, 0x41, 0x62, 0xff, 0x7f, 0x61, 0x68, 0x61, 0x69, 0xff, 0xff]);
  const d = C.decodeValue(bytes);
  assert.equal(d[0], 1);
  assert.deepEqual([...d[1]], [0x61, 0x62]);
  assert.equal(d[2], 'hi');
});

test('half float and tags', () => {
  assert.equal(C.decodeValue(Uint8Array.from([0xf9, 0x3c, 0x00])), 1);
  assert.equal(C.decodeValue(Uint8Array.from([0xc0, 0x61, 0x74])), 't');
});

test('truncated input returns undefined', () => {
  assert.equal(C.decodeValue(Uint8Array.from([0x82, 0x01])), undefined);
  assert.equal(C.decodeValue(new Uint8Array(0)), undefined);
});
