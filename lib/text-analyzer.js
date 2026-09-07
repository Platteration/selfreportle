/*
 * lib/text-analyzer.js — text-level AI signals.
 *
 * Three families of evidence, in decreasing order of reliability:
 *   1. Disclosures: the text itself says it is AI-generated / AI-assisted /
 *      human-written.
 *   2. Hard artefacts: invisible Unicode characters used as watermarks or
 *      steganographic payloads, chat-transcript leakage ("As an AI language
 *      model…"), markdown that survived a copy-paste from a chat window,
 *      ChatGPT citation markers.
 *   3. Stylometry: lexical and rhythmic heuristics. These are indicative only
 *      and are capped so they can never yield the strongest verdict alone.
 *
 * Note on watermarks: SynthID-Text (Google) and similar statistical text
 * watermarks are only verifiable with the provider's keys, so this module
 * cannot detect them. What it can detect are the visible artefacts above.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.textAnalyzer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const isNode = typeof module === 'object' && typeof require === 'function';
  const S = isNode ? require('./signals.js') : root.SRL.signals;
  const LEX = isNode ? require('./lexicons.js') : root.SRL.lexicons;

  const ZERO_WIDTH = {
    '​': 'zero-width space (U+200B)',
    '‌': 'zero-width non-joiner (U+200C)',
    '‍': 'zero-width joiner (U+200D)',
    '⁠': 'word joiner (U+2060)',
    '⁡': 'invisible function application (U+2061)',
    '⁢': 'invisible times (U+2062)',
    '⁣': 'invisible separator (U+2063)',
    '⁤': 'invisible plus (U+2064)',
    '﻿': 'zero-width no-break space / BOM (U+FEFF)',
    '᠎': 'Mongolian vowel separator (U+180E)',
  };

  const PICTOGRAPHIC_RE = /\p{Extended_Pictographic}/u;
  /* Scripts where ZWJ / ZWNJ are legitimate orthography. */
  const JOINER_SCRIPT_RE = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿ऀ-෿฀-๿຀-໿က-႟ក-៿᠀-᢯ꦀ-꧟]/;

  const SENSITIVITY = { low: 0.7, medium: 1, high: 1.35 };

  function analyzeText(text, opts = {}) {
    const mode = opts.mode || 'block'; // block | page
    const sens = SENSITIVITY[opts.sensitivity] || 1;
    const signals = [];
    const raw = String(text || '');
    const clean = raw.replace(/\s+/g, ' ').trim();
    const words = countWords(clean);

    if (!clean) return finish({ signals, words, score: 0, verdict: 'no-signal', disclosures: [], language: null });

    /* Which lexicon to read this text with. A caller-supplied language wins;
     * otherwise the text is sampled. Unknown means English only. */
    const detected = opts.language || (LEX ? LEX.detectLanguage(clean, opts.lang) : { code: (opts.lang || '').slice(0, 2) || null, source: 'none', confidence: 0 });
    const lang = detected.code || (opts.lang || '').toLowerCase().slice(0, 2);
    const pack = LEX && lang && lang !== 'en' ? LEX.get(lang) : null;

    /* 1. Disclosures. */
    const disclosures = S.findDisclosures(clean, { lang });
    let disclosureVerdict = null;
    for (const d of disclosures) {
      if (d.level === 'generated') disclosureVerdict = 'ai-disclosed';
      else if (d.level === 'assisted' && disclosureVerdict !== 'ai-disclosed') disclosureVerdict = 'ai-assisted-disclosed';
      else if (d.level === 'human' && !disclosureVerdict) disclosureVerdict = 'human-disclosed';
      if (d.level !== 'weak') {
        signals.push({ id: 'disclosure-' + d.level, kind: 'disclosure', weight: 0, label: disclosureLabel(d.level), detail: '"…' + d.context + '…"' });
      }
    }

    /* 2. Hard artefacts. */
    let hardScore = 0;
    const hidden = scanHiddenCharacters(raw, lang);
    for (const h of hidden.signals) { signals.push(h); hardScore += h.weight; }

    const selfStrong = raw.match(S.SELF_REFERENCE_STRONG_RE) || (pack ? raw.match(pack.selfRefStrong) : null);
    if (selfStrong) {
      signals.push({ id: 'self-reference', kind: 'hard', weight: 0.75, label: 'Assistant-style sentence left in the text', detail: '"' + selfStrong[0].trim() + '"' });
      hardScore += 0.75;
    } else {
      const selfMed = raw.match(S.SELF_REFERENCE_MEDIUM_RE) || (pack ? raw.match(pack.selfRefMedium) : null);
      if (selfMed && words > 20) {
        signals.push({ id: 'self-reference-weak', kind: 'soft', weight: 0.2, label: 'Chat-style closing phrase', detail: '"' + selfMed[0].trim() + '"' });
        hardScore += 0.2;
      }
    }

    const md = scanMarkdownLeak(raw);
    if (md.count > 0) {
      const w = md.count >= 3 ? 0.4 : md.count === 2 ? 0.3 : 0.15;
      signals.push({ id: 'markdown-leak', kind: md.count >= 2 ? 'hard' : 'soft', weight: w, label: 'Markdown / chat markup left in rendered text', detail: md.details.join('; ') });
      hardScore += w;
    }

    /* 3. Stylometry (only on enough text). */
    let softScore = 0;
    const minWords = mode === 'page' ? 120 : 50;
    const stylometry = words >= minWords ? scanStylometry(clean, words, mode, pack) : null;
    if (stylometry) {
      for (const s of stylometry.signals) { signals.push(s); softScore += s.weight; }
    }
    softScore = Math.min(0.55, softScore * sens);

    let score = Math.min(1, hardScore + softScore);
    let verdict;
    if (disclosureVerdict === 'ai-disclosed' || disclosureVerdict === 'ai-assisted-disclosed') {
      verdict = disclosureVerdict;
      score = Math.max(score, disclosureVerdict === 'ai-disclosed' ? 0.9 : 0.6);
    } else if (score >= 0.75) verdict = 'ai';
    else if (score >= 0.45) verdict = 'likely-ai';
    else if (score >= 0.22) verdict = 'possible-ai';
    else if (disclosureVerdict === 'human-disclosed') verdict = 'human-disclosed';
    else verdict = 'no-signal';

    return finish({ signals, words, score, verdict, disclosures, hidden: hidden.summary, stylometry: stylometry && stylometry.stats, language: { code: lang || null, name: LEX ? LEX.nameOf(lang) : null, source: detected.source, lexicon: pack ? pack.name : (lang === 'en' || !lang ? 'English' : null) } });
  }

  function finish(r) {
    r.signals.sort((a, b) => (b.weight || 0) - (a.weight || 0));
    r.score = round(r.score);
    return r;
  }

  function disclosureLabel(level) {
    return level === 'generated' ? 'Text declares AI generation'
      : level === 'assisted' ? 'Text declares AI assistance'
        : level === 'human' ? 'Text declares human authorship' : 'Automation notice';
  }

  /* ---- hidden characters ------------------------------------------------ */

  function scanHiddenCharacters(text, lang) {
    const signals = [];
    const counts = {};
    const len = text.length || 1;
    const chars = Array.from(text);
    const n = chars.length;

    let zwRun = [];
    const zwRuns = [];
    let tagRun = [];
    const tagRuns = [];
    let vsRun = 0;
    const vsRuns = [];
    let softHyphen = 0;
    let narrowNbsp = 0;
    let legitJoiners = 0;

    for (let i = 0; i < n; i++) {
      const ch = chars[i];
      const cp = ch.codePointAt(0);
      const prev = i > 0 ? chars[i - 1] : '';
      const next = i + 1 < n ? chars[i + 1] : '';

      if (ZERO_WIDTH[ch]) {
        const legit = (ch === '‍' || ch === '‌') && (PICTOGRAPHIC_RE.test(prev) || PICTOGRAPHIC_RE.test(next) || JOINER_SCRIPT_RE.test(prev) || JOINER_SCRIPT_RE.test(next));
        const bomAtStart = ch === '﻿' && i === 0;
        if (legit || bomAtStart) { legitJoiners++; flushZw(); continue; }
        counts[ch] = (counts[ch] || 0) + 1;
        zwRun.push(ch);
        continue;
      }
      flushZw();

      if (cp >= 0xE0000 && cp <= 0xE007F) {
        // Unicode "tag" characters. Legitimate only inside subdivision flag emoji.
        if (cp === 0xE007F) { // cancel tag
          if (tagRun.length) { tagRun.push(ch); finishTagRun(true); }
          continue;
        }
        if (!tagRun.length) tagRun.start = prev;
        tagRun.push(ch);
        continue;
      }
      if (tagRun.length) finishTagRun(false);

      if ((cp >= 0xFE00 && cp <= 0xFE0F) || (cp >= 0xE0100 && cp <= 0xE01EF)) {
        vsRun++;
        continue;
      }
      if (vsRun) { if (vsRun >= 4) vsRuns.push(vsRun); vsRun = 0; }

      if (ch === '­') softHyphen++;
      else if (ch === ' ') narrowNbsp++;
    }
    flushZw();
    if (tagRun.length) finishTagRun(false);
    if (vsRun >= 4) vsRuns.push(vsRun);

    function flushZw() {
      if (zwRun.length) { zwRuns.push(zwRun); zwRun = []; }
    }
    function finishTagRun(terminated) {
      const isFlag = terminated && tagRun.start && tagRun.start.codePointAt(0) === 0x1F3F4;
      if (!isFlag) tagRuns.push(tagRun.slice());
      tagRun = [];
    }

    const zwTotal = Object.values(counts).reduce((a, b) => a + b, 0);
    const zwPerK = (zwTotal / len) * 1000;
    const longest = zwRuns.reduce((m, r) => Math.max(m, r.length), 0);

    if (tagRuns.length) {
      const payload = tagRuns.map((r) => r.map((c) => {
        const cp = c.codePointAt(0) - 0xE0000;
        return cp >= 0x20 && cp <= 0x7E ? String.fromCharCode(cp) : '';
      }).join('')).filter(Boolean).join(' ¶ ');
      signals.push({ id: 'unicode-tags', kind: 'hard', weight: 0.9, label: 'Hidden Unicode tag characters (invisible payload)', detail: payload ? 'Decoded hidden text: "' + payload.slice(0, 200) + '"' : tagRuns.length + ' run(s) of tag characters' });
    }
    if (longest >= 8) {
      const bits = zwRuns.filter((r) => r.length >= 8).map((r) => r.map((c) => (c === '​' ? '0' : '1')).join(''));
      const decoded = bits.map(decodeBits).filter(Boolean).join(' ');
      signals.push({ id: 'zw-stego', kind: 'hard', weight: 0.85, label: 'Zero-width character sequence (steganographic pattern)', detail: 'Longest run: ' + longest + ' invisible characters' + (decoded ? '; decoded as "' + decoded.slice(0, 120) + '"' : '') });
    } else if (zwTotal > 0 && (zwPerK >= 1.5 || zwTotal >= 4)) {
      const what = Object.entries(counts).map(([c, k]) => k + '× ' + ZERO_WIDTH[c]).join(', ');
      signals.push({ id: 'zw-density', kind: 'hard', weight: Math.min(0.55, 0.25 + zwPerK * 0.05), label: 'Invisible characters scattered in the text', detail: what + ' (' + zwPerK.toFixed(1) + ' per 1,000 characters)' });
    } else if (zwTotal > 0) {
      const what = Object.entries(counts).map(([c, k]) => k + '× ' + ZERO_WIDTH[c]).join(', ');
      signals.push({ id: 'zw-trace', kind: 'info', weight: 0.05, label: 'A few invisible characters present', detail: what });
    }
    if (vsRuns.length) {
      signals.push({ id: 'variation-selector-run', kind: 'hard', weight: 0.8, label: 'Run of variation selectors (emoji byte-smuggling pattern)', detail: vsRuns.length + ' run(s), longest ' + Math.max(...vsRuns) + ' selectors' });
    }
    const nnPerK = (narrowNbsp / len) * 1000;
    if (narrowNbsp >= 2 && nnPerK >= 0.8 && lang !== 'fr') {
      signals.push({ id: 'narrow-nbsp', kind: 'soft', weight: 0.3, label: 'Narrow no-break spaces (U+202F) in non-French text', detail: narrowNbsp + ' occurrences. Seen in some LLM outputs; also used in French typography and some CMSs.' });
    }
    const shPerK = (softHyphen / len) * 1000;
    if (softHyphen >= 5 && shPerK >= 8) {
      signals.push({ id: 'soft-hyphen', kind: 'info', weight: 0.08, label: 'Dense soft hyphens (U+00AD)', detail: softHyphen + ' occurrences; usually a CMS hyphenation feature.' });
    }

    return { signals, summary: { zeroWidth: zwTotal, tagRuns: tagRuns.length, variationSelectorRuns: vsRuns.length, narrowNbsp, softHyphen, legitimateJoiners: legitJoiners } };
  }

  function decodeBits(bits) {
    if (bits.length < 8) return '';
    let out = '';
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      const code = parseInt(bits.slice(i, i + 8), 2);
      if (code < 0x20 || code > 0x7E) return '';
      out += String.fromCharCode(code);
    }
    return out;
  }

  /* ---- markdown leakage ------------------------------------------------- */

  function scanMarkdownLeak(text) {
    let count = 0;
    const details = [];
    for (const p of S.MARKDOWN_LEAK_PATTERNS) {
      const m = text.match(p.re);
      if (m && m.length) { count += p.id === 'citation' ? 2 : 1; details.push(m.length + '× ' + p.label); }
    }
    return { count, details };
  }

  /* ---- stylometry ------------------------------------------------------- */

  /* `pack` is the language lexicon, or null for English. The English lexicon
   * is never applied to another language: it would invent signals. */
  function scanStylometry(text, words, mode, pack) {
    const signals = [];
    const perK = 1000 / words;
    const tier1 = pack ? pack.tier1 : S.LEXICON_TIER1;
    const tier2 = pack ? pack.tier2 : S.LEXICON_TIER2;

    let t1 = 0; const t1hits = new Map();
    for (const re of tier1) {
      const m = text.match(re);
      if (m) { t1 += m.length; t1hits.set(m[0].toLowerCase(), (t1hits.get(m[0].toLowerCase()) || 0) + m.length); }
    }
    let t2 = 0;
    for (const re of tier2) {
      const m = text.match(re);
      if (m) t2 += m.length;
    }
    const points = (t1 * 3 + t2) * perK;
    const lexScore = clamp((points - 6) / 22, 0, 1) * 0.42;
    const top = [...t1hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w, k]) => (k > 1 ? w + ' ×' + k : w));
    if (lexScore > 0.04) {
      signals.push({ id: 'lexicon', kind: 'soft', weight: round(lexScore), label: 'LLM-typical vocabulary density', detail: points.toFixed(0) + ' lexicon points per 1,000 words' + (top.length ? ' (' + top.join(', ') + ')' : '') });
    }

    const sentences = splitSentences(text);
    const lens = sentences.map(countWords).filter((n) => n > 0);
    let cv = null;
    if (lens.length >= 8) {
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
      cv = mean ? sd / mean : 0;
      if (cv < 0.28 && mean >= 12) signals.push({ id: 'burstiness', kind: 'soft', weight: 0.14, label: 'Very uniform sentence lengths (low burstiness)', detail: 'Coefficient of variation ' + cv.toFixed(2) + ' over ' + lens.length + ' sentences' });
      else if (cv < 0.38 && mean >= 12) signals.push({ id: 'burstiness', kind: 'soft', weight: 0.07, label: 'Uniform sentence lengths', detail: 'Coefficient of variation ' + cv.toFixed(2) + ' over ' + lens.length + ' sentences' });
    }

    const emDashes = (text.match(/—|\s-\s|–/g) || []).length;
    const emPer100 = (emDashes / words) * 100;
    if (emDashes >= 3 && emPer100 >= 1.2) signals.push({ id: 'em-dash', kind: 'soft', weight: 0.08, label: 'High dash density', detail: emPer100.toFixed(1) + ' dashes per 100 words' });

    const tricolons = (text.match(/\b[\w'’-]+, [\w'’-]+(?: [\w'’-]+)?, (?:and|or) [\w'’-]+/g) || []).length;
    if (lens.length >= 8 && tricolons / lens.length >= 0.3) signals.push({ id: 'tricolon', kind: 'soft', weight: 0.06, label: 'Frequent three-item lists', detail: tricolons + ' in ' + lens.length + ' sentences' });

    const contractions = (text.match(/\b\w+['’](?:t|s|re|ve|ll|d|m)\b/gi) || []).length;
    const stats = { words, sentences: lens.length, sentenceLengthCV: cv === null ? null : round(cv), lexiconPointsPerK: round(points), emDashesPer100: round(emPer100), contractions };

    if (mode === 'page') {
      const paras = text.split(/\n{2,}|\r\n\r\n/).map(countWords).filter((n) => n >= 20);
      if (paras.length >= 5) {
        const mean = paras.reduce((a, b) => a + b, 0) / paras.length;
        const sd = Math.sqrt(paras.reduce((a, b) => a + (b - mean) ** 2, 0) / paras.length);
        const pcv = mean ? sd / mean : 0;
        stats.paragraphLengthCV = round(pcv);
        if (pcv < 0.25) signals.push({ id: 'paragraph-uniformity', kind: 'soft', weight: 0.08, label: 'Very uniform paragraph lengths', detail: 'Coefficient of variation ' + pcv.toFixed(2) + ' over ' + paras.length + ' paragraphs' });
      }
    }
    return { signals, stats };
  }

  function splitSentences(text) {
    return text.split(/(?<=[.!?…])\s+(?=[\p{Lu}"“(\[])/u).map((s) => s.trim()).filter(Boolean);
  }

  function countWords(text) {
    const m = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    return m ? m.length : 0;
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function round(v) { return Math.round(v * 100) / 100; }

  return { analyzeText, scanHiddenCharacters, scanMarkdownLeak, scanStylometry, countWords, splitSentences };
});
