/* lib/verdicts.js — verdict vocabularies, colours and combination rules. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.verdicts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Palette derived from Okabe & Ito's colour-blind-safe set, darkened so
   * that white badge text clears WCAG AA (>= 4.5:1) on every fill. `dark`
   * variants are used as accents on dark surfaces. Colour never carries
   * meaning alone: every verdict also has a distinct glyph. */
  const COLORS = {
    vermillion: '#c43d0f',
    orange: '#a56200',
    gold: '#8a6d00',
    purple: '#a24c7e',
    green: '#0b7a5b',
    blue: '#0f6fa8',
    slate: '#5a6472',
    mist: '#6b7280',
  };

  const COLORS_DARK = {
    vermillion: '#ff8a5c',
    orange: '#e8a33d',
    gold: '#d8be3a',
    purple: '#e794c0',
    green: '#4fcfa3',
    blue: '#67b7ea',
    slate: '#a6aebc',
    mist: '#9aa3b2',
  };

  function darken(color) {
    const key = Object.keys(COLORS).find((k) => COLORS[k] === color);
    return key ? COLORS_DARK[key] : color;
  }

  /* Rank: higher = more concerning for a reader deciding whether to trust.
   * icon: shape redundancy for colour-blind and monochrome rendering. */
  const IMAGE = {
    'ai-generated': { label: 'AI-generated', short: 'AI', color: COLORS.vermillion, rank: 6, icon: '◆' },
    'ai-edited': { label: 'AI-edited / composite', short: 'AI edit', color: COLORS.purple, rank: 5, icon: '◈' },
    'ai-disclosed': { label: 'Disclosed as AI-made', short: 'AI · disclosed', color: COLORS.orange, rank: 4, icon: '✎' },
    'suspected': { label: 'Possible AI (weak signals)', short: 'AI?', color: COLORS.gold, rank: 3, icon: '?' },
    'algorithmic': { label: 'Algorithmic (non-AI) media', short: 'Algo', color: COLORS.blue, rank: 1, icon: '▦' },
    'captured': { label: 'Camera-capture provenance', short: 'Camera', color: COLORS.green, rank: 0, icon: '●' },
    'human-created': { label: 'Declared human-made', short: 'Human', color: COLORS.green, rank: 0, icon: '✋' },
    /* What the file says about itself, and nothing more: an XMP
     * DigitalSourceType attribute, an EXIF camera make, a Content Credentials
     * claim that did not verify, bind and anchor. Deliberately not green and
     * deliberately not silent — the claim is evidence a reader should see,
     * and a reader has to be able to tell it from one that was checked. */
    'self-claimed': { label: 'Origin claimed by the file, not verified', short: 'Claimed', color: COLORS.slate, rank: 2, icon: '◌' },
    'no-signal': { label: 'No provenance signals found', short: '–', color: COLORS.slate, rank: 2, icon: '○' },
    'unavailable': { label: 'Could not inspect', short: 'n/a', color: COLORS.mist, rank: 2, icon: '⊘' },
  };

  const TEXT = {
    'ai': { label: 'Strong AI indicators', short: 'AI', color: COLORS.vermillion, rank: 6, icon: '◆' },
    'ai-disclosed': { label: 'Disclosed as AI-generated', short: 'AI · disclosed', color: COLORS.orange, rank: 4, icon: '✎' },
    'ai-assisted-disclosed': { label: 'Disclosed as AI-assisted', short: 'AI-assisted · disclosed', color: COLORS.orange, rank: 4, icon: '✎' },
    'likely-ai': { label: 'Likely AI-written (heuristic)', short: 'AI likely', color: COLORS.purple, rank: 5, icon: '◈' },
    'possible-ai': { label: 'Possibly AI-written (weak heuristic)', short: 'AI?', color: COLORS.gold, rank: 3, icon: '?' },
    'human-disclosed': { label: 'Declared human-written (self-reported)', short: 'Human · declared', color: COLORS.green, rank: 0, icon: '✋' },
    'no-signal': { label: 'No AI signals found', short: '–', color: COLORS.slate, rank: 2, icon: '○' },
  };

  const SITE = {
    'ai-built': { label: 'Built with an AI site/app generator', short: 'AI-built', color: COLORS.vermillion, rank: 6, icon: '◆' },
    'ai-disclosed': { label: 'Site declares AI involvement', short: 'AI · disclosed', color: COLORS.orange, rank: 4, icon: '✎' },
    'ai-assisted': { label: 'AI-assisted code (indicators)', short: 'AI-assisted', color: COLORS.purple, rank: 5, icon: '◈' },
    'builder': { label: 'Conventional site builder (AI optional)', short: 'Builder', color: COLORS.blue, rank: 1, icon: '▦' },
    'no-signal': { label: 'No AI-generation signals in code', short: '–', color: COLORS.slate, rank: 2, icon: '○' },
  };

  const OVERALL = {
    'undisclosed-ai': { label: 'AI signals without disclosure', color: COLORS.vermillion, icon: '◆' },
    'disclosed-ai': { label: 'AI use is disclosed', color: COLORS.orange, icon: '✎' },
    'weak-ai': { label: 'Weak AI signals only', color: COLORS.gold, icon: '?' },
    'provenance': { label: 'Provenance credentials present, no AI signals', color: COLORS.green, icon: '●' },
    'none': { label: 'No AI signals found (not proof of human origin)', color: COLORS.slate, icon: '○' },
  };

  function info(kind, verdict) {
    const table = kind === 'image' ? IMAGE : kind === 'text' ? TEXT : SITE;
    return table[verdict] || table['no-signal'];
  }

  const AI_IMAGE_VERDICTS = new Set(['ai-generated', 'ai-edited', 'ai-disclosed', 'suspected']);
  const AI_TEXT_VERDICTS = new Set(['ai', 'ai-disclosed', 'ai-assisted-disclosed', 'likely-ai', 'possible-ai']);
  const AI_SITE_VERDICTS = new Set(['ai-built', 'ai-disclosed', 'ai-assisted']);

  /* Combine per-image signals. Each signal: { verdict, strength (0..1), hard (bool) }. */
  function combineImageSignals(signals) {
    let best = { verdict: 'no-signal', score: 0 };
    const hard = signals.filter((s) => s.hard);
    const pick = (v) => signals.filter((s) => s.verdict === v);
    const maxStrength = (list) => list.reduce((m, s) => Math.max(m, s.strength || 0), 0);

    if (pick('ai-generated').some((s) => s.hard)) return { verdict: 'ai-generated', score: maxStrength(pick('ai-generated')) };
    if (pick('ai-edited').some((s) => s.hard)) return { verdict: 'ai-edited', score: maxStrength(pick('ai-edited')) };
    if (pick('ai-disclosed').length) return { verdict: 'ai-disclosed', score: Math.max(0.7, maxStrength(pick('ai-disclosed'))) };
    /* Broken provenance is stated as a hard 'suspected' signal. It ranks below
     * an independent disclosure — a platform label is evidence in its own
     * right — but above the benign verdicts, so a claim from the same
     * untrustworthy manifest can never outrank the finding that it is broken. */
    const hardSuspect = signals.filter((s) => s.hard && s.verdict === 'suspected');
    if (hardSuspect.length) return { verdict: 'suspected', score: maxStrength(hardSuspect) };

    const soft = signals.filter((s) => !s.hard && (s.verdict === 'ai-generated' || s.verdict === 'ai-edited' || s.verdict === 'suspected'));
    const softScore = 1 - soft.reduce((acc, s) => acc * (1 - (s.strength || 0)), 1);
    if (softScore >= 0.3) best = { verdict: 'suspected', score: softScore };
    /*
     * An exculpatory verdict needs a hard signal. lib/image-metadata.js emits
     * one only for a manifest that verified, bound, anchored to a signer this
     * build knows and was shown to decode to the picture on the page;
     * everything
     * softer — camera EXIF, an IPTC attribute, a caption — is a claim the
     * file or the page makes about itself and lands in 'self-claimed'.
     * 'captured' and 'algorithmic' used to need no hard signal at all, which
     * is how an EXIF Make reached the same green badge as a signed manifest.
     */
    else if (pick('algorithmic').some((s) => s.hard)) best = { verdict: 'algorithmic', score: maxStrength(pick('algorithmic')) };
    else if (pick('human-created').some((s) => s.hard)) best = { verdict: 'human-created', score: maxStrength(pick('human-created')) };
    else if (pick('captured').some((s) => s.hard)) best = { verdict: 'captured', score: maxStrength(pick('captured')) };
    else if (pick('self-claimed').length) best = { verdict: 'self-claimed', score: maxStrength(pick('self-claimed')) };
    else if (hard.length === 0 && signals.some((s) => s.verdict === 'unavailable')) best = { verdict: 'unavailable', score: 0 };
    return best;
  }

  function worst(kind, verdicts) {
    let top = null;
    for (const v of verdicts) {
      const i = info(kind, v);
      if (!top || i.rank > info(kind, top).rank) top = v;
    }
    return top || 'no-signal';
  }

  /* Page-level trust summary. A disclosure only "covers" AI signals of the
   * same scope (site / text / image) or of general scope. */
  function overall(result) {
    const site = result.site || {};
    const text = result.text || {};
    const images = result.images || {};
    const counts = images.counts || {};
    const disclosures = (result.disclosures || []).filter((d) => d.level === 'generated' || d.level === 'assisted');
    const covers = (scope) => disclosures.some((d) => d.scope === scope || d.scope === 'general');

    const findings = [];
    if (AI_SITE_VERDICTS.has(site.verdict)) findings.push(site.verdict === 'ai-disclosed' || site.disclosed || covers('site'));
    if (['ai', 'likely-ai'].includes(text.verdict)) findings.push(covers('text'));
    if (text.verdict === 'ai-disclosed' || text.verdict === 'ai-assisted-disclosed') findings.push(true);
    if ((counts['ai-generated'] || 0) + (counts['ai-edited'] || 0) > 0) findings.push(covers('image'));
    if (counts['ai-disclosed'] > 0) findings.push(true);

    if (findings.length) return findings.every(Boolean) ? 'disclosed-ai' : 'undisclosed-ai';
    if (disclosures.length) return 'disclosed-ai';
    if (text.verdict === 'possible-ai' || counts.suspected > 0 || site.verdict === 'builder') return 'weak-ai';
    /*
     * The green tick says provenance credentials are present, so it has to
     * rest on credentials. `captured` also covers camera EXIF and an XMP
     * DigitalSourceType attribute — fields anyone can type, and worth typing,
     * since the claim is exculpatory. `images.proven` counts only images
     * carrying one of PROVEN_PROVENANCE_SIGNALS, which lib/image-metadata.js
     * emits solely for a manifest that verified, bound, anchored to a signer
     * this build knows, and was shown to decode to the picture on the page.
     */
    /* 'human-disclosed' is a sentence on the page saying the text was written
     * by a person. It is a disclosure, and a welcome one, but it is not a
     * credential, and "Provenance credentials present" is what this verdict
     * claims — so a page could earn the green tick by typing one line. */
    if ((images.proven || 0) > 0) return 'provenance';
    return 'none';
  }

  /* The signal ids deriveSignals reserves for a manifest that passed all of
   * that. Named here so the page-level rule and the per-image one agree. */
  const PROVEN_PROVENANCE_SIGNALS = new Set(['c2pa-capture', 'c2pa-human', 'c2pa-algo', 'c2pa-capture-device']);

  function provenCount(states) {
    let n = 0;
    for (const signals of states) if ((signals || []).some((x) => PROVEN_PROVENANCE_SIGNALS.has(x.id))) n++;
    return n;
  }

  /*
   * What a Content Credentials result here does and does not mean, in one
   * place. It used to be written out separately in the popup's Overview tab,
   * the exported JSON report, the PNG receipt and the popup's own About
   * panel, and once verification actually shipped three of those four still
   * told the reader that signatures were never checked at all — including
   * the exported report, which is the artefact they are told to keep as
   * evidence. One export, four callers, no drift.
   */
  const CREDENTIAL_CAVEAT = 'C2PA signatures are cryptographically verified against the certificate embedded in the manifest, '
    + 'each assertion is re-hashed against the signed claim, and the claim\'s hard binding is recomputed over the file\'s own bytes. '
    + 'No trust list is shipped, so the certificate chain is never anchored: a verified manifest is intact and about this file, '
    + 'not proof that the signer is who the certificate names.';

  /* The same statement squeezed into a one-line footer. */
  const CREDENTIAL_CAVEAT_SHORT = 'signatures verified; root not anchored to a trust list';

  /*
   * What the digest on a saved report can and cannot show.
   *
   * It used to be called "integrity" and described as proof the file had not
   * been edited since it was saved. It is not: the digest is unkeyed and it
   * travels inside the artefact it describes, so whoever holds the file can
   * change a finding, recompute the digest over the change and produce
   * something no one can tell from a genuine export. There is no secret and
   * no outside reference point in the scheme at all. Signing it with a
   * per-installation key would be a different, real claim; until something
   * makes the claim true, the field is a checksum and says so. One exported
   * sentence, as with the credential caveat, so the copies cannot drift.
   */
  const REPORT_CHECKSUM_NOTE = 'The report carries a SHA-256 checksum of its own findings, which catches accidental corruption. '
    + 'It cannot show the file has not been edited: it is unkeyed and stored inside the report, so anyone changing a finding can recompute it.';

  /*
   * The blanket caveat plus what the manifests on this page actually did, so
   * a saved report says which of them were checked rather than leaving the
   * reader to assume the best or the worst.
   */
  function credentialCaveats(result) {
    const out = [CREDENTIAL_CAVEAT];
    const items = (result && result.images && result.images.items) || [];
    const tally = { ok: 0, broken: 0, caution: 0, unchecked: 0 };
    for (const it of items) {
      const c2 = it && it.metadata && it.metadata.c2pa;
      const v = c2 && c2.verification;
      if (!v) continue;
      const sum = v.summary || {};
      if (sum.ok) tally.ok++;
      else if (sum.broken) tally.broken++;
      else if (sum.caution) tally.caution++;
      else tally.unchecked++;
    }
    const n = (k) => tally[k] + ' manifest(s)';
    if (tally.ok) out.push(n('ok') + ' verified and are bound to the file they arrived in.');
    if (tally.broken) out.push(n('broken') + ' did not verify; nothing claimed inside them is relied on here.');
    if (tally.caution) out.push(n('caution') + ' carry a valid signature but could not be fully reconciled, so they are not read as provenance.');
    if (tally.unchecked) out.push(n('unchecked') + ' could not be checked cryptographically at all and are reported as unverified claims.');
    return out;
  }

  return { COLORS, COLORS_DARK, darken, IMAGE, TEXT, SITE, OVERALL, info, combineImageSignals, worst, overall, provenCount, PROVEN_PROVENANCE_SIGNALS, AI_IMAGE_VERDICTS, AI_TEXT_VERDICTS, AI_SITE_VERDICTS, CREDENTIAL_CAVEAT, CREDENTIAL_CAVEAT_SHORT, REPORT_CHECKSUM_NOTE, credentialCaveats };
});
