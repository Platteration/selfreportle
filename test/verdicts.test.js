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
  assert.equal(V.overall({ site: { verdict: 'no-signal' }, text: { verdict: 'no-signal' }, images: { counts: { captured: 2 }, proven: 2 }, disclosures: [] }), 'provenance');
  assert.equal(V.overall({ site: {}, text: {}, images: {}, disclosures: [] }), 'none');
});

/*
 * L5-1(d). "Provenance credentials present" is a claim about credentials, and
 * `captured` is also what camera EXIF and an XMP DigitalSourceType attribute
 * produce — metadata anyone can type, and worth typing, since the claim is
 * the exculpatory one. Only an image whose manifest verified, bound, anchored
 * and came from the bytes the page loaded may light the green tick.
 */
test('the page-level provenance tick needs credentials, not a captured count', () => {
  const weak = { site: {}, text: {}, images: { counts: { captured: 3 }, proven: 0 }, disclosures: [] };
  assert.equal(V.overall(weak), 'none');
  assert.equal(V.overall({ ...weak, images: { ...weak.images, proven: 1 } }), 'provenance');
  // and the count comes from the signals, not from the verdict word
  assert.equal(V.provenCount([[{ id: 'exif-camera' }], [{ id: 'c2pa-capture-unverified' }]]), 0);
  assert.equal(V.provenCount([[{ id: 'exif-camera' }, { id: 'c2pa-capture' }]]), 1);
  // A sentence on the page saying a person wrote it is a disclosure, and a
  // welcome one, but "Provenance credentials present" is not what it shows.
  assert.equal(V.overall({ site: {}, text: { verdict: 'human-disclosed' }, images: {}, disclosures: [] }), 'none');
});

/*
 * An exculpatory verdict needs a hard signal, which lib/image-metadata.js
 * emits only for a manifest that verified, bound, anchored and came from the
 * bytes the page loaded. 'captured' and 'algorithmic' used to need no hard
 * signal at all, which is how a camera EXIF tag reached the same green badge
 * as a signed manifest — and how one XMP attribute would have, whatever the
 * trust anchors said.
 */
test('a soft exculpatory signal reads as a claim, never as the verified badge', () => {
  const proven = { id: 'c2pa-capture', hard: true, verdict: 'captured', strength: 0.9 };
  for (const soft of [
    { id: 'exif-camera', hard: false, verdict: 'captured', strength: 0.45 },
    { id: 'xmp-dst-claim', hard: false, verdict: 'captured', strength: 0.9 },
    { id: 'caption-human', hard: false, verdict: 'human-created', strength: 0.5 },
    { id: 'x', hard: false, verdict: 'algorithmic', strength: 0.8 },
  ]) {
    const got = V.combineImageSignals([soft]).verdict;
    assert.notEqual(got, soft.verdict, soft.id + ' reached an exculpatory verdict unaided');
    assert.notEqual(V.IMAGE[got].color, V.IMAGE[soft.verdict].color, soft.id + ' is drawn as the verdict it claimed');
    assert.ok(V.IMAGE[got].rank >= V.IMAGE[proven.verdict].rank, soft.id + ' is ranked as more trustworthy than a verified manifest');
  }
  assert.equal(V.combineImageSignals([proven]).verdict, 'captured', 'and the hard one still earns it');
  // A claim is shown rather than swallowed: it has its own tier, not no-signal.
  assert.equal(V.combineImageSignals([{ id: 'exif-camera', hard: false, verdict: 'self-claimed', strength: 0 }]).verdict, 'self-claimed');
  assert.notEqual(V.IMAGE['self-claimed'].label, V.IMAGE['no-signal'].label, 'and it says something a reader can act on');
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

/*
 * L5-6. The saved report called its digest "integrity" and the popup and the
 * README said it showed the file had not been edited since it was saved. It
 * cannot: the digest is unkeyed and it travels inside the artefact it
 * describes, so whoever holds the file can change a finding, recompute the
 * digest over the change, and produce something indistinguishable from a
 * genuine export. Demonstrated below, against the shape the popup writes.
 */
test('the report checksum claims only what an unkeyed digest inside the file can show', () => {
  const sha256 = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
  const findings = { url: 'https://example.invalid/', overall: 'undisclosed-ai', site: { verdict: 'ai-built' } };
  const report = { checksum: { algorithm: 'SHA-256', digest: sha256(JSON.stringify(findings)), proves: V.REPORT_CHECKSUM_NOTE }, findings };

  const forged = JSON.parse(JSON.stringify(report));
  forged.findings.overall = 'none';
  forged.findings.site = { verdict: 'no-signal' };
  forged.checksum.digest = sha256(JSON.stringify(forged.findings));
  assert.equal(forged.checksum.digest, sha256(JSON.stringify(forged.findings)), 'a forged report is self-consistent');
  assert.notEqual(forged.checksum.digest, report.checksum.digest, 'and nothing outside it says which is which');

  assert.match(V.REPORT_CHECKSUM_NOTE, /cannot show the file has not been edited/);
  assert.match(V.REPORT_CHECKSUM_NOTE, /accidental corruption/);
  // And the claim is made in one place, so the copies cannot drift again.
  const overclaim = /(?:digest|checksum)[^.]{0,120}so you can show it has not been edited/i;
  for (const f of ['popup/popup.js', 'popup/popup.html', 'README.md', 'lib/verdicts.js']) {
    assert.ok(!overclaim.test(fs.readFileSync(root(f), 'utf8')), f + ' still says the digest proves the file is unedited');
  }
  assert.match(fs.readFileSync(root('popup/popup.js'), 'utf8'), /V\.REPORT_CHECKSUM_NOTE/, 'the popup uses the shared sentence');
  assert.ok(!/integrity: \{/.test(fs.readFileSync(root('popup/popup.js'), 'utf8')), 'and the field is not called integrity');
});
