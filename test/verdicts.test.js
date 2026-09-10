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

/*
 * SEC-6. Cryptographic verification shipped, but the caveat text did not
 * follow it: the exported JSON report — the artefact the README tells the
 * reader to keep as evidence, complete with a SHA-256 digest of its own
 * findings — still said "C2PA signatures are parsed, not cryptographically
 * verified", as did the PNG receipt's footer and the Overview tab's hint for
 * the 'provenance' verdict, while the same popup showed a green "Signature
 * verified" row and popup.html said the opposite. One exported sentence now,
 * so the four copies cannot drift again.
 */
const fs = require('fs');
const path = require('path');
const root = (...p) => path.join(__dirname, '..', ...p);

test('the credential caveat says what is actually checked, in both directions', () => {
  const c = V.CREDENTIAL_CAVEAT;
  assert.match(c, /cryptographically verified/, 'signatures are verified, and the report must say so');
  assert.ok(!/parsed, not cryptographically verified/.test(c));
  assert.match(c, /hard binding is recomputed/, 'and the binding is checked');
  assert.match(c, /never anchored|no trust list|No trust list/, 'but the root is not anchored, and that must not be dropped');
  assert.match(V.CREDENTIAL_CAVEAT_SHORT, /not anchored/);
});

test('the caveat list is derived from the manifests the page actually carried', () => {
  const withSummary = (summary) => ({ metadata: { c2pa: { verification: { summary } } } });
  const none = V.credentialCaveats({ images: { items: [{ metadata: null }, { metadata: { exif: {} } }] } });
  assert.deepEqual(none, [V.CREDENTIAL_CAVEAT], 'nothing to add when the page carried no credentials at all');
  // A manifest that produced no verification summary is an unchecked one,
  // not an absent one: it still has to be reported.
  assert.equal(V.credentialCaveats({ images: { items: [withSummary(null)] } }).length, 2);

  const mixed = V.credentialCaveats({
    images: {
      items: [
        withSummary({ ok: true }), withSummary({ ok: true }),
        withSummary({ broken: true }),
        withSummary({ caution: true }),
        withSummary({}),
      ],
    },
  });
  assert.equal(mixed[0], V.CREDENTIAL_CAVEAT);
  assert.ok(mixed.some((s) => /^2 manifest\(s\) verified and are bound/.test(s)));
  assert.ok(mixed.some((s) => /^1 manifest\(s\) did not verify/.test(s)));
  assert.ok(mixed.some((s) => /^1 manifest\(s\) carry a valid signature but could not be fully reconciled/.test(s)));
  assert.ok(mixed.some((s) => /^1 manifest\(s\) could not be checked cryptographically/.test(s)));
  assert.deepEqual(V.credentialCaveats(null), [V.CREDENTIAL_CAVEAT], 'and it survives an empty result');
});

test('no user-facing copy still claims signatures go unverified', () => {
  const stale = /(?:parsed|signatures parsed),\s*not\s*(?:cryptographically\s*)?verified/i;
  for (const f of ['popup/popup.js', 'popup/popup.html', 'lib/image-metadata.js', 'lib/verdicts.js', 'publisher/publisher.js', 'content/overlay.js', 'README.md']) {
    assert.ok(!stale.test(fs.readFileSync(root(f), 'utf8')), f + ' still carries the stale caveat');
  }
  const popup = fs.readFileSync(root('popup/popup.js'), 'utf8');
  assert.match(popup, /V\.credentialCaveats\(r\)/, 'the exported report derives its caveats');
  assert.match(popup, /V\.CREDENTIAL_CAVEAT_SHORT/, 'and the receipt footer uses the shared sentence');
});
