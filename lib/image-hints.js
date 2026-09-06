/*
 * lib/image-hints.js — DOM-side image signals that need no byte access:
 * captions/alt text disclosures, generator hostnames, filename hints.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.imageHints = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const S = (typeof module === 'object' && typeof require === 'function') ? require('./signals.js') : root.SRL.signals;

  function analyzeImageHints(h) {
    const signals = [];
    const url = h.url || '';
    let hostname = '';
    let pathname = '';
    try { const u = new URL(url); hostname = u.hostname; pathname = u.pathname; } catch (e) { /* data: or relative */ }

    const texts = [h.alt, h.title, h.caption, h.ariaLabel].filter(Boolean).join(' · ');
    if (texts) {
      const discl = S.findDisclosures(texts);
      const ai = discl.find((d) => d.level === 'generated' || d.level === 'assisted');
      if (ai) signals.push({ id: 'caption-disclosure', hard: false, verdict: 'ai-disclosed', strength: 0.9, label: 'Caption/alt text discloses AI ' + (ai.level === 'generated' ? 'generation' : 'assistance'), detail: '"' + ai.context + '"' });
      const human = discl.find((d) => d.level === 'human');
      if (human && !ai) signals.push({ id: 'caption-human', hard: false, verdict: 'human-created', strength: 0.5, label: 'Caption/alt text declares human authorship', detail: '"' + human.context + '"' });
      const tools = S.matchTools(S.AI_IMAGE_TOOLS, texts).filter((t) => !/Gemini|Grok|Meta AI|Replicate|Hugging Face|Canva/.test(t));
      if (tools.length && !ai) signals.push({ id: 'caption-tool', hard: false, verdict: 'suspected', strength: 0.45, label: 'Caption/alt text names a generative tool', detail: tools.join(', ') });
    }

    if (hostname) {
      for (const [name, re, strength] of S.AI_IMAGE_HOSTS) {
        if (re.test(hostname)) { signals.push({ id: 'host', hard: false, verdict: 'suspected', strength, label: 'Served from ' + name, detail: hostname }); break; }
      }
    }
    const file = decodeURIComponent(pathname.split('/').pop() || '');
    if (file && S.AI_IMAGE_FILENAME_RE.test(file)) {
      signals.push({ id: 'filename', hard: false, verdict: 'suspected', strength: 0.35, label: 'File name hints at a generator', detail: file.slice(0, 80) });
    } else if (S.AI_IMAGE_FILENAME_RE.test(pathname)) {
      signals.push({ id: 'path', hard: false, verdict: 'suspected', strength: 0.25, label: 'URL path hints at generated imagery', detail: pathname.slice(0, 100) });
    }
    if (/^data:image\/svg/i.test(url) || /\.svg(?:$|\?)/i.test(pathname)) {
      signals.push({ id: 'svg', hard: false, verdict: 'no-signal', strength: 0, label: 'Vector graphic', detail: 'SVG files rarely carry provenance metadata' });
    }
    return signals;
  }

  return { analyzeImageHints };
});
