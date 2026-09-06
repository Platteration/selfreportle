/*
 * content/content.js — orchestrates the three analyses on the page:
 *   site/code  → lib/site-analyzer (runs here)
 *   text       → lib/text-analyzer (runs here, per block + whole page)
 *   images     → DOM hints here, byte-level provenance in the service worker
 * and renders the overlay, then reports the result to the service worker.
 */
(function () {
  'use strict';
  if (window.top !== window) return;
  const S = globalThis.SRL;
  if (!S || !S.overlay) return;
  const V = S.verdicts;

  const BLOCK_SEL = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, td, th, pre, summary';
  const SKIP_SEL = 'srl-overlay, [data-srl-ui], script, style, noscript, template, textarea, [contenteditable="true"], svg';

  let settings = S.settings.DEFAULTS;
  let runId = 0;
  let imageState = new Map();   // HTMLImageElement → state
  let textSeen = new WeakSet();
  let textCounter = 0;
  let imageCounter = 0;
  let result = null;
  let postTimer = 0;
  let observer = null;
  let lastHref = location.href;
  let pendingImages = 0;

  /* ---- lifecycle -------------------------------------------------------- */

  async function main() {
    settings = await S.settings.load();
    if (!settings.enabled || S.settings.isHostDisabled(settings, location.hostname)) return;
    S.overlay.init(settings);
    await analyze(true);
    observeMutations();
    setInterval(() => {
      if (location.href !== lastHref) { lastHref = location.href; analyze(true); }
    }, 1000);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    if (msg.type === 'srl:rescan') {
      S.settings.load().then((s) => { settings = s; return analyze(true); }).then(() => sendResponse({ ok: true, result }));
      return true;
    }
    if (msg.type === 'srl:toggle-overlay') {
      S.overlay.setVisible(!S.overlay.isVisible());
      sendResponse({ visible: S.overlay.isVisible() });
      return false;
    }
    if (msg.type === 'srl:open-panel') { S.overlay.setVisible(true); S.overlay.togglePanel(); sendResponse({ ok: true }); return false; }
    if (msg.type === 'srl:get-page-result') { sendResponse(result); return false; }
    return false;
  });

  /* ---- full analysis ---------------------------------------------------- */

  async function analyze(full) {
    const id = ++runId;
    if (full) {
      S.overlay.clearMarkers();
      imageState = new Map();
      textSeen = new WeakSet();
      textCounter = 0; imageCounter = 0; pendingImages = 0;
    }
    const snapshot = collectSnapshot();
    const site = S.siteAnalyzer.analyzeSite(snapshot);
    const disclosures = S.signals.findDisclosures(snapshot.bodyText, { max: 25 }).map(({ level, match, context, scope }) => ({ level, match, context, scope }));
    const text = analyzeTextBlocks();
    result = {
      url: location.href, hostname: location.hostname, title: document.title, at: Date.now(),
      site, text, disclosures,
      images: { total: 0, inspected: 0, pending: 0, counts: {}, items: [] },
    };
    refreshSummary();
    const imgs = collectImages();
    await processImages(imgs, id);
  }

  /* ---- site snapshot ---------------------------------------------------- */

  function collectSnapshot() {
    const metas = [...document.querySelectorAll('meta')].slice(0, 300).map((m) => ({
      name: m.getAttribute('name') || '', property: m.getAttribute('property') || '', itemprop: m.getAttribute('itemprop') || '', content: (m.getAttribute('content') || '').slice(0, 300),
    }));
    const scripts = [...document.scripts].map((s) => s.src).filter(Boolean).slice(0, 300);
    const inlineScripts = [...document.scripts].filter((s) => !s.src && s.textContent && s.type !== 'application/ld+json').slice(0, 40).map((s) => s.textContent.slice(0, 20000));
    const jsonLd = [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent.slice(0, 50000));
    const links = [...document.querySelectorAll('link[rel]')].slice(0, 150).map((l) => ({ rel: l.rel, href: l.href }));
    const comments = [];
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_COMMENT);
    let n;
    while ((n = walker.nextNode()) && comments.length < 300) comments.push(n.nodeValue.slice(0, 500));
    const attrs = new Set();
    const all = document.getElementsByTagName('*');
    const step = Math.max(1, Math.floor(all.length / 4000));
    for (let i = 0; i < all.length; i += step) for (const a of all[i].attributes) attrs.add(a.name);
    let bodyText = '';
    try { bodyText = document.body ? document.body.innerText.slice(0, 300000) : ''; } catch (e) { bodyText = ''; }
    return {
      url: location.href, hostname: location.hostname, lang: document.documentElement.lang || '', title: document.title,
      metas, scripts, inlineScripts, jsonLd, links, comments, attrNames: [...attrs], bodyText,
    };
  }

  /* ---- text ------------------------------------------------------------- */

  function ownText(elm) {
    let out = '';
    const walker = document.createTreeWalker(elm, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (node !== elm && (node.matches(BLOCK_SEL) || node.matches(SKIP_SEL))) return NodeFilter.FILTER_REJECT;
          if (node.tagName === 'BR') { out += '\n'; }
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) out += node.nodeValue;
    return out;
  }

  function isRendered(elm) {
    if (!elm.getClientRects().length) return false;
    const cs = getComputedStyle(elm);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  function collectTextBlocks(onlyNew) {
    const blocks = [];
    const nodes = document.body ? document.body.querySelectorAll(BLOCK_SEL) : [];
    for (const elm of nodes) {
      if (blocks.length >= 600) break;
      if (onlyNew && textSeen.has(elm)) continue;
      if (elm.closest(SKIP_SEL)) continue;
      const text = ownText(elm);
      if (!text || text.trim().length < 2) continue;
      if (!isRendered(elm)) continue;
      blocks.push({ el: elm, text });
    }
    // Fallback for div-soup pages: leaf-ish divs with substantial direct text.
    const total = blocks.reduce((n, b) => n + b.text.length, 0);
    if (total < 600 && document.body) {
      for (const elm of document.body.querySelectorAll('div, span, section, article')) {
        if (blocks.length >= 600) break;
        if (onlyNew && textSeen.has(elm)) continue;
        if (elm.closest(SKIP_SEL)) continue;
        let direct = '';
        for (const c of elm.childNodes) if (c.nodeType === 3) direct += c.nodeValue;
        if (direct.trim().length < 120 || !isRendered(elm)) continue;
        blocks.push({ el: elm, text: direct });
      }
    }
    return blocks;
  }

  function analyzeTextBlocks(onlyNew) {
    const lang = document.documentElement.lang || '';
    const opts = { lang, sensitivity: settings.sensitivity };
    const blocks = collectTextBlocks(onlyNew);
    const flagged = [];
    const verdicts = [];
    let words = 0;
    for (const b of blocks) {
      textSeen.add(b.el);
      const r = S.textAnalyzer.analyzeText(b.text, { ...opts, mode: 'block' });
      words += r.words;
      if (r.verdict === 'no-signal') continue;
      verdicts.push(r.verdict);
      const key = 't' + (++textCounter);
      S.overlay.upsertMarker({ key, el: b.el, kind: 'text', verdict: r.verdict, details: r.signals.map((s) => ({ label: s.label, detail: s.detail })) });
      flagged.push({ verdict: r.verdict, score: r.score, words: r.words, excerpt: b.text.replace(/\s+/g, ' ').trim().slice(0, 160), signals: r.signals.slice(0, 6).map(({ id, kind, label, detail, weight }) => ({ id, kind, label, detail, weight })) });
    }
    let page = null;
    if (!onlyNew) {
      const mainEl = document.querySelector('main, article, [role="main"]');
      const pageText = blocks.filter((b) => !mainEl || mainEl.contains(b.el)).map((b) => b.text.replace(/\s+/g, ' ').trim()).filter((t) => S.textAnalyzer.countWords(t) >= 8).join('\n\n');
      page = S.textAnalyzer.analyzeText(pageText, { ...opts, mode: 'page' });
      verdicts.push(page.verdict);
    } else if (result && result.text) {
      verdicts.push(result.text.verdict);
      flagged.unshift(...(result.text.flagged || []));
      words += result.text.words || 0;
    }
    const aiVerdicts = verdicts.filter((v) => V.AI_TEXT_VERDICTS.has(v));
    let verdict = aiVerdicts.length ? V.worst('text', aiVerdicts) : verdicts.includes('human-disclosed') ? 'human-disclosed' : 'no-signal';
    const flaggedCount = flagged.filter((f) => V.AI_TEXT_VERDICTS.has(f.verdict)).length;
    const prev = (!onlyNew || !result) ? null : result.text;
    return {
      verdict,
      score: page ? page.score : (prev ? prev.score : 0),
      words: onlyNew && prev ? prev.words + words - (prev.words || 0) : words,
      blocks: (prev ? prev.blocks : 0) + blocks.length,
      flaggedBlocks: flaggedCount,
      page: page ? { verdict: page.verdict, score: page.score, words: page.words, signals: page.signals.slice(0, 8), stats: page.stylometry || null, hidden: page.hidden } : (prev ? prev.page : null),
      flagged: flagged.slice(0, 30),
    };
  }

  /* ---- images ----------------------------------------------------------- */

  function captionFor(img) {
    const fig = img.closest('figure');
    const fc = fig && fig.querySelector('figcaption');
    if (fc) return fc.innerText.slice(0, 300);
    const a = img.closest('a[title]');
    return a ? a.title.slice(0, 200) : '';
  }

  function collectImages() {
    const out = [];
    for (const img of document.images) {
      if (imageState.has(img)) continue;
      if (img.closest('[data-srl-ui]')) continue;
      const r = img.getBoundingClientRect();
      const w = r.width || img.width, h = r.height || img.height;
      if (w < settings.minImageSize || h < settings.minImageSize) continue;
      const url = img.currentSrc || img.src;
      if (!url) continue;
      out.push({ el: img, url, alt: img.alt || '', title: img.title || '', ariaLabel: img.getAttribute('aria-label') || '', caption: captionFor(img), w: Math.round(w), h: Math.round(h) });
    }
    return out;
  }

  async function processImages(list, id) {
    const toFetch = [];
    for (const item of list) {
      const key = 'i' + (++imageCounter);
      const hints = S.imageHints.analyzeImageHints(item);
      const st = { key, el: item.el, url: item.url, hints, bytes: null, verdict: 'no-signal', score: 0, signals: hints, done: false };
      imageState.set(item.el, st);
      applyImageVerdict(st);
      const fetchable = settings.fetchImages && !/^data:image\/svg/i.test(item.url) && !/^blob:/i.test(item.url) && imageState.size <= settings.maxImages;
      if (fetchable) toFetch.push({ st, msg: { id: key, url: item.url } });
      else st.done = true;
    }
    pendingImages += toFetch.length;
    refreshSummary();
    for (let i = 0; i < toFetch.length; i += 6) {
      if (id !== runId) return;
      const batch = toFetch.slice(i, i + 6);
      let resp = null;
      try {
        resp = await chrome.runtime.sendMessage({ type: 'srl:analyze-images', images: batch.map((b) => b.msg), settings: { maxImageBytes: settings.maxImageBytes } });
      } catch (e) { resp = null; }
      if (id !== runId) return;
      const byId = new Map(((resp && resp.results) || []).map((r) => [r.id, r]));
      for (const { st } of batch) {
        const r = byId.get(st.key);
        st.done = true;
        pendingImages = Math.max(0, pendingImages - 1);
        if (r) {
          st.bytes = { format: r.format, contentType: r.contentType, size: r.bytes, truncated: r.truncated, metadata: r.metadata || null };
          st.signals = [...st.hints, ...(r.signals || [])];
        } else {
          st.signals = [...st.hints, { id: 'unavailable', hard: false, verdict: 'unavailable', strength: 0, label: 'Background inspection failed', detail: '' }];
        }
        applyImageVerdict(st);
      }
      refreshSummary();
    }
  }

  function applyImageVerdict(st) {
    const c = V.combineImageSignals(st.signals);
    st.verdict = c.verdict; st.score = c.score;
    const show = st.verdict !== 'no-signal' && st.verdict !== 'unavailable' ? true : settings.markUnflaggedImages && st.done;
    if (show) {
      const details = st.signals.filter((s) => s.label).map((s) => ({ label: s.label, detail: s.detail }));
      if (st.bytes && st.bytes.format) details.push({ label: 'Inspected ' + Math.round((st.bytes.size || 0) / 1024) + ' KB of ' + st.bytes.format.toUpperCase() + (st.bytes.truncated ? ' (truncated)' : ''), detail: '' });
      S.overlay.upsertMarker({ key: st.key, el: st.el, kind: 'image', verdict: st.verdict, details });
    } else S.overlay.removeMarker(st.key);
  }

  /* ---- summary / reporting --------------------------------------------- */

  function refreshSummary() {
    if (!result) return;
    const counts = {};
    const items = [];
    let inspected = 0;
    for (const st of imageState.values()) {
      counts[st.verdict] = (counts[st.verdict] || 0) + 1;
      if (st.bytes) inspected++;
      if (st.verdict !== 'no-signal' && st.verdict !== 'unavailable' && items.length < 100) {
        items.push({ url: st.url.slice(0, 500), verdict: st.verdict, score: Math.round(st.score * 100) / 100, format: st.bytes && st.bytes.format, signals: st.signals.filter((s) => s.label).slice(0, 8).map(({ id, hard, verdict, strength, label, detail }) => ({ id, hard, verdict, strength, label, detail })), metadata: st.bytes ? trimMetadata(st.bytes.metadata) : null });
      }
    }
    result.images = { total: imageState.size, inspected, pending: pendingImages, counts, items };
    result.overall = V.overall(result);
    S.overlay.setSummary({ overall: result.overall, site: result.site, text: result.text, images: result.images, disclosures: result.disclosures.filter((d) => d.level !== 'weak' && d.level !== 'human') });
    clearTimeout(postTimer);
    postTimer = setTimeout(postResult, 250);
  }

  function trimMetadata(m) {
    if (!m) return null;
    const out = {};
    if (m.exif) out.exif = m.exif;
    if (m.xmp) out.xmp = m.xmp;
    if (m.pngText) out.pngText = Object.fromEntries(Object.entries(m.pngText).slice(0, 8).map(([k, v]) => [k, String(v).slice(0, 200)]));
    if (m.c2pa) out.c2pa = { claimGenerator: m.c2pa.claimGenerator, claimGeneratorInfo: m.c2pa.claimGeneratorInfo, title: m.c2pa.title, actions: (m.c2pa.actions || []).slice(0, 12), assertions: m.c2pa.assertions, ingredients: m.c2pa.ingredients, signerNames: m.c2pa.signerNames, digitalSourceTypes: m.c2pa.digitalSourceTypes, softwareAgents: m.c2pa.softwareAgents, manifestCount: m.c2pa.manifestCount };
    if (m.comments) out.comments = m.comments;
    return out;
  }

  function postResult() {
    if (!result) return;
    try { chrome.runtime.sendMessage({ type: 'srl:page-result', result }).catch(() => {}); } catch (e) { /* context gone */ }
  }

  /* ---- dynamic content -------------------------------------------------- */

  function observeMutations() {
    if (observer || !document.body) return;
    let timer = 0;
    observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const id = runId;
        const imgs = collectImages();
        if (imgs.length) processImages(imgs, id);
        if (settings.showTextMarkers || true) {
          const t = analyzeTextBlocks(true);
          if (result) { result.text = t; refreshSummary(); }
        }
        S.overlay.reposition();
      }, 900);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main, { once: true });
  else main();
})();
