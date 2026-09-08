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

/* Broken provenance sits between an independent disclosure and the benign
 * verdicts: a platform label is evidence in its own right, but a claim from
 * the same untrustworthy manifest is not. */
test('broken credentials outrank benign claims but not independent disclosures', () => {
  const broken = { id: 'c2pa-broken', hard: true, verdict: 'suspected', strength: 0.7 };
  const label = { id: 'platform-label', hard: false, verdict: 'ai-disclosed', strength: 0.9 };
  const camera = { id: 'exif-camera', hard: false, verdict: 'captured', strength: 0.45 };
  const generated = { id: 'png-sd', hard: true, verdict: 'ai-generated', strength: 0.98 };

  assert.equal(V.combineImageSignals([broken]).verdict, 'suspected');
  assert.equal(V.combineImageSignals([camera, broken]).verdict, 'suspected', 'a benign claim must not hide broken credentials');
  assert.equal(V.combineImageSignals([label, broken]).verdict, 'ai-disclosed', 'an independent disclosure still stands');
  assert.equal(V.combineImageSignals([generated, broken]).verdict, 'ai-generated');
});
