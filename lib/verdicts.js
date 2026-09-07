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

    /* Broken provenance is stated as a hard 'suspected' signal. It has to be
     * handled before anything else, or a benign claim from the same
     * (untrustworthy) manifest would outrank the finding that it is broken. */
    const hardSuspect = signals.filter((s) => s.hard && s.verdict === 'suspected');
    if (hardSuspect.length) return { verdict: 'suspected', score: maxStrength(hardSuspect) };
    if (pick('ai-generated').some((s) => s.hard)) return { verdict: 'ai-generated', score: maxStrength(pick('ai-generated')) };
    if (pick('ai-edited').some((s) => s.hard)) return { verdict: 'ai-edited', score: maxStrength(pick('ai-edited')) };
    if (pick('ai-disclosed').length) return { verdict: 'ai-disclosed', score: Math.max(0.7, maxStrength(pick('ai-disclosed'))) };

    const soft = signals.filter((s) => !s.hard && (s.verdict === 'ai-generated' || s.verdict === 'ai-edited' || s.verdict === 'suspected'));
    const softScore = 1 - soft.reduce((acc, s) => acc * (1 - (s.strength || 0)), 1);
    if (softScore >= 0.3) best = { verdict: 'suspected', score: softScore };
    else if (pick('algorithmic').length) best = { verdict: 'algorithmic', score: maxStrength(pick('algorithmic')) };
    else if (pick('human-created').some((s) => s.hard)) best = { verdict: 'human-created', score: maxStrength(pick('human-created')) };
    else if (pick('captured').length) best = { verdict: 'captured', score: maxStrength(pick('captured')) };
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
    if (counts.captured > 0 || counts['human-created'] > 0 || text.verdict === 'human-disclosed') return 'provenance';
    return 'none';
  }

  return { COLORS, COLORS_DARK, darken, IMAGE, TEXT, SITE, OVERALL, info, combineImageSignals, worst, overall, AI_IMAGE_VERDICTS, AI_TEXT_VERDICTS, AI_SITE_VERDICTS };
});
