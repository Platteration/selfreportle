/*
 * lib/site-analyzer.js — page/code-level AI signals.
 *
 * Works on a serialisable snapshot of the document (built by the content
 * script) so it can also run in Node tests.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.siteAnalyzer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const S = (typeof module === 'object' && typeof require === 'function') ? require('./signals.js') : root.SRL.signals;

  const KIND_STRENGTH = { 'ai-builder': 0.95, 'ai-host': 0.45, 'builder-ai': 0.15, builder: 0.05 };

  function analyzeSite(snap) {
    const signals = [];
    const trustNotes = [];
    let builder = null;
    let disclosed = false;
    let score = 0;

    /* Same host with or without a trailing dot, so the host fingerprints
     * below cannot be stepped past by writing the name fully qualified. */
    const hostname = (snap.hostname || '').toLowerCase().replace(/\.+$/, '');
    const metas = snap.metas || [];
    const generatorValues = metas.filter((m) => /^generator$/i.test(m.name || '')).map((m) => (m.content || '').trim()).filter(Boolean);
    const generator = generatorValues.join(' | ');
    const scripts = snap.scripts || [];
    const comments = snap.comments || [];
    const attrNames = snap.attrNames || [];
    const inline = snap.inlineScripts || [];

    /* 1. Builder / generator fingerprints. */
    for (const fp of S.SITE_FINGERPRINTS) {
      const evidence = [];
      // Each generator tag is matched on its own: the fingerprints are anchored
      // at the start, so a joined "Next.js | v0 by Vercel" would match neither.
      const hitMeta = generatorValues.find((v) => fp.meta && fp.meta.some((re) => re.test(v)));
      if (hitMeta) evidence.push('meta generator "' + hitMeta.slice(0, 80) + '"');
      if (fp.attrs && attrNames.some((a) => fp.attrs.some((re) => re.test(a)))) evidence.push('DOM attributes ' + attrNames.filter((a) => fp.attrs.some((re) => re.test(a))).slice(0, 3).join(', '));
      if (fp.scripts && scripts.some((s) => fp.scripts.some((re) => re.test(s)))) evidence.push('script ' + scripts.find((s) => fp.scripts.some((re) => re.test(s))).slice(0, 100));
      if (fp.comments && comments.some((c) => fp.comments.some((re) => re.test(c)))) evidence.push('HTML comment mentions ' + fp.name);
      if (fp.hosts && fp.hosts.some((re) => re.test(hostname))) evidence.push('hosted on ' + hostname);
      if (!evidence.length) continue;
      const strength = KIND_STRENGTH[fp.kind] || 0.1;
      const kind = fp.kind === 'ai-builder' ? 'hard' : fp.kind === 'ai-host' ? 'soft' : 'info';
      signals.push({ id: 'fingerprint-' + slug(fp.name), kind, weight: strength, label: fingerprintLabel(fp), detail: evidence.join('; ') });
      if (!builder || strength > (KIND_STRENGTH[builder.kind] || 0)) builder = { name: fp.name, kind: fp.kind };
      score = Math.max(score, strength);
    }

    /* 2. Machine-readable disclosure hooks. */
    for (const m of metas) {
      const key = m.name || m.property || m.itemprop || '';
      if (!key || !S.META_DISCLOSURE_NAME_RE.test(key)) continue;
      const val = (m.content || '').trim();
      const tag = '<meta ' + (m.name ? 'name' : 'property') + '="' + key + '" content="' + val.slice(0, 60) + '">';
      const saysHuman = !val || S.META_DISCLOSURE_FALSE_RE.test(val)
        || S.findDisclosures(val).some((d) => d.level === 'human');
      if (saysHuman) {
        signals.push({ id: 'meta-human', kind: 'disclosure', weight: 0, label: val ? 'Meta tag declares no AI involvement' : 'AI disclosure meta tag is present but empty', detail: tag });
      } else if (S.META_DISCLOSURE_TRUE_RE.test(val) || S.findDisclosures(val).some((d) => d.level === 'generated' || d.level === 'assisted')) {
        disclosed = true;
        score = Math.max(score, 0.9);
        signals.push({ id: 'meta-ai', kind: 'disclosure', weight: 0.9, label: 'Meta tag declares AI-generated content', detail: tag });
      } else {
        /* A value this reader does not recognise is not a declaration either
         * way; saying so beats guessing that it means yes. */
        signals.push({ id: 'meta-unknown', kind: 'info', weight: 0, label: 'AI disclosure meta tag carries a value this reader does not recognise', detail: tag });
      }
    }
    for (const l of snap.links || []) {
      if (/ai[-_]?disclosure|content[-_]?credentials|c2pa/i.test(l.rel || '')) {
        signals.push({ id: 'link-disclosure', kind: 'info', weight: 0.1, label: 'Link relation hints at an AI/provenance disclosure', detail: '<link rel="' + l.rel + '" href="' + (l.href || '').slice(0, 100) + '">' });
      }
    }
    for (const raw of snap.jsonLd || []) {
      const dst = raw.match(/digitalsourcetype\/(\w+)/i) || raw.match(/"(?:Iptc4xmpExt:)?[Dd]igitalSourceType"\s*:\s*"([^"]+)"/);
      if (dst) {
        const info = S.digitalSourceType(dst[1]);
        if (info && (info.verdict === 'ai-generated' || info.verdict === 'ai-edited')) {
          disclosed = true; score = Math.max(score, 0.9);
          signals.push({ id: 'jsonld-dst', kind: 'disclosure', weight: 0.9, label: 'Structured data declares generative-AI source', detail: 'JSON-LD digitalSourceType = ' + info.key });
        } else if (info) {
          signals.push({ id: 'jsonld-dst-other', kind: 'info', weight: 0, label: 'Structured data declares a digital source type', detail: 'JSON-LD digitalSourceType = ' + info.key + ' (' + info.label + ')' });
        }
      }
      const creator = raw.match(/"(?:creator|author|generator|creditText|producer)"\s*:\s*(?:\{[^}]*"name"\s*:\s*)?"([^"]{2,80})"/i);
      // Structured data that types the creator as a Person is naming a human,
      // whatever their name happens to collide with.
      const namedPerson = /"@type"\s*:\s*"Person"/i.test(raw) && !/"@type"\s*:\s*"(?:Organization|SoftwareApplication)"/i.test(raw);
      if (creator && !namedPerson && S.AI_GENERATOR_RE.test(creator[1]) && !/^(?:google|meta)$/i.test(creator[1].trim())) {
        disclosed = true; score = Math.max(score, 0.8);
        signals.push({ id: 'jsonld-creator', kind: 'disclosure', weight: 0.8, label: 'Structured data names an AI system as creator', detail: creator[1] });
      }
      if (/"(?:ai[-_]?generated|isAIGenerated|aiGenerated)"\s*:\s*(?:true|"true"|"yes")/i.test(raw)) {
        disclosed = true; score = Math.max(score, 0.9);
        signals.push({ id: 'jsonld-flag', kind: 'disclosure', weight: 0.9, label: 'Structured data carries an AI-generated flag', detail: raw.match(/"(?:ai[-_]?generated|isAIGenerated|aiGenerated)"\s*:\s*(?:true|"true"|"yes")/i)[0] });
      }
    }

    /* 3. Comments and inline code that admit AI authorship. */
    const codeHits = [];
    for (const c of comments) {
      const m = c.match(S.CODE_AI_COMMENT_RE) || c.match(S.CODE_AI_MARKER_RE);
      if (m) codeHits.push('comment: "' + trimAround(c, m.index, m[0].length) + '"');
    }
    for (const src of inline) {
      const m = src.match(S.CODE_AI_COMMENT_RE);
      if (m) codeHits.push('inline script: "' + trimAround(src, m.index, m[0].length) + '"');
    }
    if (codeHits.length) {
      score = Math.max(score, 0.6);
      signals.push({ id: 'code-comment', kind: 'soft', weight: 0.6, label: 'Code comments credit an AI tool', detail: codeHits.slice(0, 3).join(' · ') });
    }
    const aiAttrs = attrNames.filter((a) => /^data-(?:ai[-_]?generated|generated[-_]?by[-_]?ai|ai[-_]?content|llm[-_]?generated)$/i.test(a));
    if (aiAttrs.length) {
      disclosed = true; score = Math.max(score, 0.7);
      signals.push({ id: 'attr-ai', kind: 'disclosure', weight: 0.7, label: 'Elements carry AI-generated data attributes', detail: aiAttrs.join(', ') });
    }

    /* 4. Visible disclosures about the site/page itself. */
    const bodyText = snap.bodyText || '';
    const disclosures = S.findDisclosures(bodyText, { lang: (snap.lang || '').toLowerCase().slice(0, 2) });
    for (const d of disclosures) {
      if (d.scope === 'site' && (d.level === 'generated' || d.level === 'assisted')) {
        disclosed = true; score = Math.max(score, d.level === 'generated' ? 0.85 : 0.6);
        signals.push({ id: 'visible-site-disclosure', kind: 'disclosure', weight: d.level === 'generated' ? 0.85 : 0.6, label: 'Page states the site was ' + (d.level === 'generated' ? 'built with AI' : 'made with AI assistance'), detail: '"…' + d.context + '…"' });
      }
    }

    /* 5. Trust notes (not AI evidence, but relevant to "can I do business here"). */
    for (const p of S.PLACEHOLDER_PATTERNS) {
      const m = bodyText.match(p.re);
      if (m) trustNotes.push({ id: 'placeholder-' + p.id, label: p.label, detail: '"' + trimAround(bodyText, m.index, m[0].length) + '"' });
    }
    if (snap.title && /^(?:untitled|new page|document|index|home|react app|vite \+ react|lovable app|my v0 app|create next app|vercel app)$/i.test(snap.title.trim())) {
      trustNotes.push({ id: 'default-title', label: 'Default / template page title', detail: '"' + snap.title.trim() + '"' });
    }

    /* Verdict. */
    let verdict = 'no-signal';
    if (builder && builder.kind === 'ai-builder') verdict = 'ai-built';
    else if (disclosed) verdict = 'ai-disclosed';
    else if (score >= 0.4) verdict = 'ai-assisted';
    else if (builder) verdict = 'builder';

    signals.sort((a, b) => (b.weight || 0) - (a.weight || 0));
    return { verdict, score: Math.round(score * 100) / 100, signals, trustNotes, builder, disclosed, generator: generator || null };
  }

  function fingerprintLabel(fp) {
    switch (fp.kind) {
      case 'ai-builder': return 'Generated with ' + fp.name + ' (AI site/app generator)';
      case 'ai-host': return 'Hosted on ' + fp.name + ' (commonly used for AI-generated apps)';
      case 'builder-ai': return 'Built with ' + fp.name + ' (builder with AI generation features)';
      default: return 'Built with ' + fp.name + ' (conventional builder)';
    }
  }

  function trimAround(text, index, len) {
    const start = Math.max(0, index - 60);
    const end = Math.min(text.length, index + len + 60);
    return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-'); }

  return { analyzeSite };
});
