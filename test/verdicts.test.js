const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/verdicts.js');

test('hard AI signal wins', () => {
  const r = V.combineImageSignals([{ verdict: 'captured', hard: false, strength: 0.45 }, { verdict: 'ai-generated', hard: true, strength: 0.9 }]);
  assert.equal(r.verdict, 'ai-generated');
});

test('weak signals combine into suspected', () => {
  const r = V.combineImageSignals([{ verdict: 'suspected', hard: false, strength: 0.2 }, { verdict: 'suspected', hard: false, strength: 0.2 }]);
  assert.equal(r.verdict, 'suspected');
  assert.ok(r.score > 0.3);
});

test('single weak filename hint is below threshold', () => {
  const r = V.combineImageSignals([{ verdict: 'suspected', hard: false, strength: 0.25 }]);
  assert.equal(r.verdict, 'no-signal');
});

test('overall summary', () => {
  assert.equal(V.overall({ site: { verdict: 'ai-built' }, text: { verdict: 'no-signal' }, images: { counts: {} }, disclosures: [] }), 'undisclosed-ai');
  assert.equal(V.overall({ site: { verdict: 'ai-built' }, text: { verdict: 'no-signal' }, images: { counts: {} }, disclosures: [{ level: 'generated', scope: 'site' }] }), 'disclosed-ai');
  assert.equal(V.overall({ site: { verdict: 'ai-built' }, text: { verdict: 'no-signal' }, images: { counts: {} }, disclosures: [{ level: 'generated', scope: 'text' }] }), 'undisclosed-ai', 'a text disclosure does not cover an undisclosed AI-built site');
  assert.equal(V.overall({ site: { verdict: 'no-signal' }, text: { verdict: 'no-signal' }, images: { counts: { 'ai-generated': 2 } }, disclosures: [{ level: 'generated', scope: 'general' }] }), 'disclosed-ai');
  assert.equal(V.overall({ site: { verdict: 'no-signal' }, text: { verdict: 'ai-assisted-disclosed' }, images: { counts: {} }, disclosures: [] }), 'disclosed-ai');
  assert.equal(V.overall({ site: { verdict: 'no-signal' }, text: { verdict: 'possible-ai' }, images: { counts: {} }, disclosures: [] }), 'weak-ai');
  assert.equal(V.overall({ site: { verdict: 'no-signal' }, text: { verdict: 'no-signal' }, images: { counts: { captured: 2 } }, disclosures: [] }), 'provenance');
  assert.equal(V.overall({ site: {}, text: {}, images: {}, disclosures: [] }), 'none');
});
