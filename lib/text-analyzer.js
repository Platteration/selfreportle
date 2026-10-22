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
  const R = isNode ? require('./research.js') : root.SRL.research;
  const C = isNode ? require('./model-catalog.js') : root.SRL.modelCatalog;

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

  /* Which family of evidence each heuristic belongs to (see corroboration). */
  const FAMILY = {
    'lexicon': 'vocabulary', 'research-vocabulary': 'vocabulary', 'reframe': 'rhetoric',
    'chat-register': 'register', 'self-reference-weak': 'register', 'addressed-answer': 'register',
    'markdown-leak': 'format', 'model-artifact': 'format', 'bold-lead-ins': 'format',
    'burstiness': 'rhythm', 'paragraph-uniformity': 'rhythm', 'em-dash': 'rhythm', 'tricolon': 'rhythm',
    'narrow-nbsp': 'typography',
  };

  function analyzeText(text, opts = {}) {
    const mode = opts.mode || 'block'; // block | page
    const sens = SENSITIVITY[opts.sensitivity] || 1;
    const signals = [];
    const raw = String(text || '');
    /* Spaces collapse but paragraph breaks survive: the whole-page mode
     * measures paragraph lengths, and callers join blocks with a blank line
     * expressly so it can. Apostrophes are normalised because every lexicon
     * pattern is written with the straight one while pasted chat output uses
     * the curly one; both substitutions are one character for one, so match
     * offsets still line up with the original text. */
    const clean = S.normalizeQuotes(raw.replace(/[^\S\n]+/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/ ?\n ?/g, '\n')).trim();
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
    let supportingScore = 0;
    const hidden = scanHiddenCharacters(raw, lang);
    for (const h of hidden.signals) {
      signals.push(h);
      if (h.kind === 'soft') supportingScore += h.weight;
      else hardScore += h.weight;
    }
    const artifacts = scanModelArtifacts(raw);
    signals.push(...artifacts);
    // A recognizable template can be copied into human documentation. It is
    // evidence of a format, never proof of authorship or a calibrated chance.
    if (artifacts.some((s) => s.kind === 'artifact')) hardScore += 0.55;
    supportingScore += artifacts.filter((s) => s.kind === 'soft').reduce((n, s) => n + s.weight, 0);

    const label = scanTranscriptLabels(raw);
    if (label) {
      signals.push(label);
      hardScore += label.weight;
    }

    const selfStrong = raw.match(S.SELF_REFERENCE_STRONG_RE) || (pack ? raw.match(pack.selfRefStrong) : null);
    if (selfStrong) {
      signals.push({ id: 'self-reference', kind: 'hard', weight: 0.75, label: 'Assistant-style sentence left in the text', detail: '"' + selfStrong[0].trim() + '"' });
      hardScore += 0.75;
    } else if (!pack && words > 20) {
      // English: the reply's shape, of which the old closing phrases are part.
      const register = scanChatRegister(clean);
      if (register) {
        signals.push(register);
        supportingScore += register.weight;
      }
    } else if (pack) {
      const selfMed = raw.match(pack.selfRefMedium);
      if (selfMed && words > 20) {
        signals.push({ id: 'self-reference-weak', kind: 'soft', weight: 0.2, label: 'Chat-style closing phrase', detail: '"' + selfMed[0].trim() + '"' });
        supportingScore += 0.2;
      }
    }

    // An answer that opens on the point and speaks to its reader as "you".
    // Half of what people write to one another does too, so it counts only
    // beside a page of bold labels (see corroboration).
    const answer = !pack && words >= 60 ? scanAddressedAnswer(clean, words) : null;
    if (answer) {
      signals.push(answer);
      supportingScore += answer.weight;
    }

    const md = scanMarkdownLeak(raw);
    // The caller's count of blocks that open with a bold label, for text whose
    // line starts are gone: rendering took the ** out of a page, and joining a
    // paragraph's lines put a text file's mid-line. The larger count stands,
    // on one signal, so a label is never weighed twice.
    const counted = mode === 'page' ? Math.floor(Number(opts.boldLeads) || 0) : 0;
    const boldLeads = Math.max(md.boldLeads, counted);
    if (md.count > 0) {
      const w = md.hasCitation ? 0.4 : md.count >= 3 || boldLeads >= 3 ? 0.12 : md.count === 2 ? 0.08 : 0.04;
      signals.push({ id: 'markdown-leak', kind: md.hasCitation ? 'hard' : 'soft', weight: w, boldLeads, label: 'Markdown / chat markup left in rendered text', detail: md.details.join('; ') });
      if (md.hasCitation) hardScore += w;
      else supportingScore += w;
    } else if (counted >= 3) {
      signals.push({ id: 'bold-lead-ins', kind: 'soft', weight: 0.12, boldLeads: counted, label: 'Paragraphs and list items that open with a bold label', detail: counted + ' on the page. How a chat window renders its replies; also a common house style.' });
      supportingScore += 0.12;
    }

    /* 3. Stylometry (only on enough text). */
    let softScore = supportingScore;
    const minWords = mode === 'page' ? 120 : 50;
    const stylometry = words >= minWords ? scanStylometry(clean, words, mode, pack, lang) : null;
    if (stylometry) {
      let lexical = 0;
      for (const s of stylometry.signals) {
        signals.push(s);
        // Legacy and researched vocabulary overlap; do not count them twice.
        if (s.id === 'lexicon' || s.id === 'research-vocabulary') lexical = Math.max(lexical, s.weight);
        else softScore += s.weight;
      }
      softScore += lexical;
    }
    // Each heuristic belongs to one family of evidence. Signals of one family
    // are not independent of each other (a chat window's markdown brings its
    // bold and its headings together), so only a second family corroborates.
    const families = new Set(signals.filter((s) => s.kind === 'soft').map((s) => FAMILY[s.id] || s.id));
    // A chat window's copy button copies its markdown, so literal bold
    // lead-ins beside a phrase that speaks to the reader (an opener or an
    // offer) anchor as well, and so do the rendered bold lead-ins a caller
    // counted in the page. Framing does not: documentation introduces its
    // examples the same way ("Here's an example:"); nor does a closing
    // question, which on a whole page is as often the footer's.
    const register = signals.find((s) => s.id === 'chat-register') || {};
    const parts = register.parts || 0;
    const addressed = (register.phrasedParts || []).some((p) => p === 'opener' || p === 'offer');
    // An answer announced as prepared ("Here is a step-by-step guide",
    // "Here's a breakdown") under a page of bold labels is the other shape,
    // and one documentation does not take: "Here's an example:" is not in it.
    const prepared = (register.phrasedParts || []).includes('prepared');
    // And an answer that opens on the point and speaks to "you" is the third:
    // under at least three bold labels it occurred in none of 1,632 pieces of
    // package and tool documentation, and in about half of the replies.
    const answered = signals.some((s) => s.id === 'addressed-answer');
    const anchored = families.has('vocabulary') || parts >= 2 || ((addressed || answered) && boldLeads >= 3) || (prepared && boldLeads >= 5);
    const corroborated = signals.some((s) => (s.id === 'lexicon' || s.id === 'research-vocabulary') && s.patternCount >= 6)
      || (anchored && families.size >= 2);
    // A small vocabulary cluster, one assistant-style phrase, ordinary markup
    // and punctuation stay below the flag threshold. Six distinct expressions
    // can give only a weak flag by themselves, and so can a reply with all
    // three parts of the register, never more; anything else needs an anchor
    // and a second family. All heuristics share one budget.
    const wholeReply = parts >= 3;
    softScore = Math.min(corroborated ? 0.55 : wholeReply ? 0.44 : 0.21, softScore * sens);

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
    let hasCitation = false;
    let boldLeads = 0;
    const details = [];
    for (const p of S.MARKDOWN_LEAK_PATTERNS) {
      const m = text.match(p.re);
      if (m && m.length) {
        count += p.id === 'citation' ? 2 : 1;
        if (p.id === 'citation') hasCitation = true;
        if (p.id === 'bold-lead') boldLeads = m.length;
        details.push(m.length + '× ' + p.label);
      }
    }
    return { count, details, hasCitation, boldLeads };
  }

  function scanModelArtifacts(text) {
    const out = [];
    for (const pattern of C.TEXT_ARTIFACTS) {
      if (!pattern.markers.every((re) => re.test(text))) continue;
      out.push({ id: 'model-artifact', kind: pattern.toolId ? 'artifact' : 'soft', weight: pattern.toolId ? 0.55 : 0.12,
        label: pattern.label, detail: 'Serialized output format markers found. Other models and human examples can reuse this format.',
        toolId: pattern.toolId, patternIds: [pattern.id], sourceUrls: [pattern.source] });
    }
    return out;
  }

  /* ---- conversation shape ------------------------------------------------ */

  /* A line labelling an assistant's turn. Returns one hard signal naming the
   * tool of the first label that counts, or null. */
  function scanTranscriptLabels(text) {
    const userLabel = S.TRANSCRIPT_USER_RE.test(text);
    let first = null;
    let count = 0;
    for (const m of text.matchAll(S.TRANSCRIPT_LABEL_RE)) {
      const tool = S.TRANSCRIPT_TOOLS[m[1]];
      if (!tool || (!tool.alone && !userLabel)) continue;
      count++;
      if (!first) first = { name: m[1], toolId: tool.toolId };
    }
    if (!first) return null;
    return { id: 'transcript-label', kind: 'hard', weight: 0.75, toolId: first.toolId,
      label: 'Chat transcript turn labelled as an AI assistant',
      detail: '"' + first.name + ' said:"' + (count > 1 ? ' (' + count + ' turns)' : '') + (userLabel ? ' beside "You said:"' : '') + '. The label a chat page gives the assistant\'s reply; a person can type it too.' };
  }

  /* How many of a reply's three parts (opener, framing, offer) the text has. */
  function scanChatRegister(text) {
    const parts = new Set();
    // The parts a phrase from the list supplied; a closing question is not
    // one of them (see corroboration).
    const phrased = new Set();
    const hits = [];
    for (const p of S.CHAT_REGISTER) {
      const m = text.match(p.re);
      if (!m) continue;
      if (p.part) { parts.add(p.part); phrased.add(p.id === 'prepared-answer' || p.id === 'step-guide' ? 'prepared' : p.part); }
      hits.push(m[0].trim());
    }
    // A reply that ends by asking the reader about their situation.
    const last = text.slice(text.lastIndexOf('\n') + 1).trim();
    if (/\?$/.test(last) && /\byou(?:r|'re|'ve)?\b/i.test(last) && countWords(last) <= 50) {
      parts.add('offer');
      hits.push(last.slice(Math.max(0, last.length - 60)));
    }
    if (!hits.length) return null;
    const quoted = hits.slice(0, 4).map((h) => '"' + h.slice(0, 60) + '"').join(', ');
    // Sign-offs alone: the weight the closing-phrase check always gave them.
    if (!parts.size) return { id: 'chat-register', kind: 'soft', weight: 0.2, parts: 0, patternCount: hits.length, label: 'Chat-style closing phrase', detail: quoted };
    const extra = hits.length - parts.size;
    const weight = round(Math.min(0.45, 0.1 + parts.size * 0.1 + Math.max(0, extra) * 0.03));
    return { id: 'chat-register', kind: 'soft', weight, parts: parts.size, phrasedParts: [...phrased], patternCount: hits.length,
      label: parts.size >= 2 ? 'Written as a chat assistant\'s reply' : 'Chat-style phrase',
      detail: [...parts].join(' + ') + ': ' + quoted + '. People write each of these too; the combination is what is typical of an assistant.' };
  }

  /* Whether the text opens with a short paragraph that reads as an answer (a
   * sentence, not a title or markup) and addresses its reader as "you" at
   * least once in every forty words. */
  function scanAddressedAnswer(text, words) {
    const first = text.slice(0, text.indexOf('\n\n') === -1 ? text.length : text.indexOf('\n\n')).trim();
    const firstWords = countWords(first);
    if (firstWords < 6 || firstWords > 45 || /^[#*|`>-]/.test(first) || !/[.!?:]$/.test(first)) return null;
    const you = (text.match(/\byou(?:r|rs|'re|'ll|'ve|'d)?\b/gi) || []).length;
    if (you / words < 0.025) return null;
    return { id: 'addressed-answer', kind: 'soft', weight: 0.12,
      label: 'Opens with a direct answer and speaks to the reader as "you"',
      detail: you + ' uses of "you" in ' + words + ' words, after a ' + firstWords + '-word opening answer. Letters and how-to articles do this too.' };
  }

  /* ---- stylometry ------------------------------------------------------- */

  /* `pack` is the language lexicon, or null for English. The English lexicon
   * is never applied to another language: it would invent signals. */
  function scanStylometry(text, words, mode, pack, lang) {
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
    // At least three distinct expressions, not repetitions of one word.
    const lexScore = t1hits.size >= 3 ? clamp((points - 6) / 22, 0, 1) * 0.42 : 0;
    const top = [...t1hits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([w, k]) => (k > 1 ? w + ' ×' + k : w));
    if (lexScore > 0.04) {
      signals.push({ id: 'lexicon', kind: 'soft', weight: round(lexScore), patternCount: t1hits.size, label: 'Vocabulary cluster (weak heuristic)', detail: points.toFixed(0) + ' lexicon points per 1,000 words' + (top.length ? ' (' + top.join(', ') + ')' : '') + '. Common in human writing too; cannot identify a model.' });
    }
    if (!pack && (!lang || lang === 'en') && words >= 80) {
      const matches = R.VOCABULARY.map((p) => ({ pattern: p, hits: text.match(p.re) })).filter((p) => p.hits);
      if (matches.length >= 3) signals.push({ id: 'research-vocabulary', kind: 'soft',
        weight: round(Math.min(0.36, matches.length * 0.045)),
        patternCount: matches.length,
        label: 'Research-associated vocabulary cluster (weak heuristic)',
        detail: matches.length + ' distinct word groups: ' + matches.slice(0, 8).map((p) => p.hits[0]).join(', ') + '. Studied in biomedical abstracts; not proof for an individual page.',
        sourceIds: ['excess-vocabulary'], patternIds: matches.map((p) => p.pattern.id) });
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

    // Scan comma positions and at most 30 characters per word. This preserves
    // the list vocabulary without retrying a word prefix at every hyphen.
    const tricolons = countTricolons(text);
    if (lens.length >= 8 && tricolons / lens.length >= 0.3) signals.push({ id: 'tricolon', kind: 'soft', weight: 0.06, label: 'Frequent three-item lists', detail: tricolons + ' in ' + lens.length + ' sentences' });

    if (!pack && (!lang || lang === 'en')) {
      let reframes = 0;
      for (const re of S.REFRAME_PATTERNS) reframes += (text.match(re) || []).length;
      const perK1 = reframes * perK;
      if (reframes >= 2 && perK1 >= 3) signals.push({ id: 'reframe', kind: 'soft', weight: round(Math.min(0.12, 0.04 * reframes)), label: '"It isn\'t X. It\'s Y" reframes', detail: reframes + ' in ' + words + ' words. A rhetorical habit of current assistants; also of columnists.' });
    }

    const contractions = (text.match(/\b\w+['’](?:t|s|re|ve|ll|d|m)\b/gi) || []).length;
    const stats = { words, sentences: lens.length, sentenceLengthCV: cv === null ? null : round(cv), lexiconPointsPerK: round(points), emDashesPer100: round(emPer100), contractions };

    if (mode === 'page') {
      const paras = text.split(/\n{2,}/).map(countWords).filter((n) => n >= 20);
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

  function countTricolons(text) {
    // Scan comma candidates with bounded word walks instead of retrying a
    // three-word regex at every boundary in long hyphenated input.
    const asciiWord = (ch) => {
      const c = ch ? ch.charCodeAt(0) : 0;
      return c >= 48 && c <= 57 || c >= 65 && c <= 90 || c >= 97 && c <= 122 || ch === '_';
    };
    const listWord = (ch) => asciiWord(ch) || ch === "'" || ch === '’' || ch === '-';
    const wordEnd = (start) => {
      let end = start;
      while (end - start < 30 && listWord(text[end])) end++;
      return end;
    };
    let count = 0;
    let consumed = 0;
    let comma = text.indexOf(', ');
    while (comma !== -1) {
      let first = comma;
      while (first > 0 && comma - first < 30 && listWord(text[first - 1])) first--;
      first = Math.max(first, consumed);
      while (first < comma && asciiWord(text[first]) === asciiWord(text[first - 1])) first++;
      if (first < comma) {
        const middle = comma + 2;
        let end = wordEnd(middle);
        if (end > middle && text[end] === ' ') {
          const second = end + 1;
          const secondEnd = wordEnd(second);
          if (secondEnd > second) end = secondEnd;
        }
        if (end > middle && (text.slice(end, end + 6) === ', and ' || text.slice(end, end + 5) === ', or ')) {
          const last = end + (text.slice(end, end + 6) === ', and ' ? 6 : 5);
          const lastEnd = wordEnd(last);
          if (lastEnd > last) { count++; consumed = lastEnd; }
        }
      }
      comma = text.indexOf(', ', Math.max(comma + 2, consumed));
    }
    return count;
  }

  function countWords(text) {
    const m = String(text || '').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu);
    return m ? m.length : 0;
  }

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function round(v) { return Math.round(v * 100) / 100; }

  return { analyzeText, scanHiddenCharacters, scanMarkdownLeak, scanModelArtifacts, scanTranscriptLabels, scanChatRegister, scanAddressedAnswer, scanStylometry, countTricolons, countWords, splitSentences };
});
