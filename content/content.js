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

  /* location.hostname keeps a trailing dot when the page was reached by its
   * fully qualified name ("example.com."). It is the same host, but it
   * matches no rule written against the name — the reader's paused-host
   * list, the platform-label hosts, the builder fingerprints — so the host
   * is canonicalised once, here, and that form is what everything downstream
   * sees. lib/fetch-policy.js does the same for the worker's fetches. */
  const pageHost = () => S.settings.canonicalHost(location.hostname);

  let settings = S.settings.DEFAULTS;
  let runId = 0;
  let imageState = new Map();   // media element → state
  let posterSeen = new Set();
  /* URLs handed to the worker whose answer has not come back yet, counted so
   * a page cannot keep the ceiling below free by dropping each element as
   * soon as its fetch is in flight. See imageBudget. */
  const inFlightUrls = new Map();
  let textSeen = new WeakSet();
  let textCounter = 0;
  let imageCounter = 0;
  let result = null;
  let postTimer = 0;
  let observer = null;
  let hrefTimer = 0;
  let lastHref = location.href;
  let pageLanguage = null;
  let lastBodyText = '';
  let pendingImages = 0;

  /* ---- lifecycle -------------------------------------------------------- */

  async function main() {
    settings = await S.settings.load();
    if (!active()) return;
    observeFetches();
    S.overlay.init(settings);
    await analyze(true);
    observeMutations();
    hrefTimer = setInterval(() => {
      if (!active()) return;
      if (location.href !== lastHref) { lastHref = location.href; analyze(true); }
    }, 1000);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    S.settings.load().then((s) => {
      const wasEnabled = active();
      settings = s;
      if (!active()) { stop(); return; }
      if (!wasEnabled) { S.overlay.init(s); S.overlay.setVisible(true); observeMutations(); }
      S.overlay.applySettings(s);
      analyze(true);
    });
  });

  function active() {
    return settings.enabled && !S.settings.isHostDisabled(settings, pageHost());
  }

  /* Pausing a host has to stop the work, not just hide the result: no more
   * fetching image bytes, no more badge updates, no more history for a site
   * the reader asked to be left alone. */
  function stop() {
    runId++;
    if (observer) { observer.disconnect(); observer = null; }
    clearInterval(hrefTimer);
    hrefTimer = 0;
    clearTimeout(postTimer);
    S.overlay.clearMarkers();
    S.overlay.setVisible(false);
    imageState = new Map();
    posterSeen = new Set();
    pendingImages = 0;
    result = null;
    try { chrome.runtime.sendMessage({ type: 'srl:paused' }).catch(() => {}); } catch (e) { /* context gone */ }
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
    if (msg.type === 'srl:inspect-image') { inspectImage(msg.srcUrl); sendResponse({ ok: true }); return false; }
    if (msg.type === 'srl:inspect-selection') { inspectSelection(); sendResponse({ ok: true }); return false; }
    return false;
  });

  /* Context menu: analyse one image on demand, ignoring the size floor and
   * the per-page cap, then open its popover. */
  async function inspectImage(srcUrl) {
    S.overlay.setVisible(true);
    let target = null;
    for (const img of document.images) {
      if ((img.currentSrc || img.src) === srcUrl) { target = img; break; }
    }
    if (!target) return;
    const existing = imageState.get(target);
    if (existing && existing.done) { S.overlay.showPopover(existing.key, existing.el); return; }
    if (existing) S.overlay.removeMarker(existing.key);   // in flight: drop its badge first
    const item = { el: target, url: srcUrl, alt: target.alt || '', title: target.title || '', ariaLabel: target.getAttribute('aria-label') || '', caption: captionFor(target) };
    imageState.delete(target);
    const key = 'i' + (++imageCounter);
    const hints = S.imageHints.analyzeImageHints(item);
    const st = { key, el: target, url: srcUrl, hints, bytes: null, verdict: 'no-signal', score: 0, signals: hints, done: false, forced: true };
    imageState.set(target, st);
    const msg = { id: key, url: srcUrl };
    await addPageBytes(msg, target);
    let resp = null;
    try { resp = await chrome.runtime.sendMessage({ type: 'srl:analyze-images', images: [msg], settings: { maxImageBytes: settings.maxImageBytes, maxMediaBytes: settings.maxMediaBytes } }); } catch (e) { resp = null; }
    const r = resp && resp.results && resp.results[0];
    st.done = true;
    if (r) { st.bytes = { format: r.format, contentType: r.contentType, size: r.bytes, truncated: r.truncated, metadata: r.metadata || null }; st.signals = [...hints, ...(r.signals || [])]; }
    applyImageVerdict(st, true);
    refreshSummary();
    S.overlay.showPopover(st.key, st.el);
  }

  /* Context menu: analyse whatever the user has selected. */
  function inspectSelection() {
    const sel = window.getSelection();
    const text = sel ? String(sel) : '';
    if (!text.trim()) return;
    S.overlay.setVisible(true);
    const r = S.textAnalyzer.analyzeText(text, { lang: document.documentElement.lang || '', sensitivity: settings.sensitivity, mode: 'block' });
    const attr = S.attribution.attributeText({ verdict: r.verdict, disclosures: r.disclosures, page: { signals: r.signals } });
    const details = r.signals.map((x) => ({ label: x.label, detail: x.detail }));
    if (attr) details.unshift({ label: 'Likely tool: ' + attr.name, detail: S.attribution.CONFIDENCE_LABEL[attr.confidence] + (attr.evidence ? ' · ' + attr.evidence : '') });
    if (!details.length) details.push({ label: 'No AI signals in the selection', detail: r.words + ' words analysed. Short selections carry little signal.' });
    let anchor = sel.anchorNode;
    while (anchor && anchor.nodeType !== 1) anchor = anchor.parentNode;
    if (!anchor) return;
    const key = 'sel' + (++textCounter);
    S.overlay.upsertMarker({ key, el: anchor, kind: 'text', verdict: r.verdict, details, raw: text.slice(0, 4000) });
    S.overlay.reposition();
    setTimeout(() => S.overlay.showPopover(key, anchor), 60);
  }

  /* ---- full analysis ---------------------------------------------------- */

  /*
   * No single analyser defect may silently disable the content script. The
   * page controls its own markup, so a malformed URL or attribute is an
   * attacker-reachable input; without this guard one bad tag aborts main()
   * before the mutation observer and the SPA poller ever start, and the
   * reader is told nothing was analysed. The failure is recorded on the
   * result instead, and reported.
   */
  async function analyze(full) {
    try {
      await runAnalysis(full);
    } catch (e) {
      const message = (e && e.message) ? e.message : String(e);
      if (!result) {
        result = {
          url: location.href, hostname: pageHost(), title: document.title, at: Date.now(),
          site: { verdict: 'no-signal', signals: [] }, text: { verdict: 'no-signal', signals: [], flaggedBlocks: 0 },
          trader: null, disclosures: [], textHints: { disclosures: [], metaText: '' },
          images: { total: 0, inspected: 0, pending: 0, counts: {}, items: [] },
        };
      }
      result.error = 'Analysis stopped early: ' + message.slice(0, 200);
      try { refreshSummary(); } catch (e2) { /* nothing more to do */ }
    }
  }

  async function runAnalysis(full) {
    if (!active()) return;
    const id = ++runId;
    if (full) {
      S.overlay.clearMarkers();
      imageState = new Map();
      posterSeen = new Set();
      textSeen = new WeakSet();
      textCounter = 0; imageCounter = 0; pendingImages = 0;
    }
    const snapshot = collectSnapshot();
    lastBodyText = snapshot.bodyText;
    pageLanguage = S.lexicons.detectLanguage(snapshot.bodyText, snapshot.lang);
    const site = S.siteAnalyzer.analyzeSite(snapshot);
    site.attribution = S.attribution.attributeSite(site, snapshot);
    const trader = S.legitimacy.analyzeLegitimacy({ url: snapshot.url, hostname: snapshot.hostname, bodyText: snapshot.bodyText, links: snapshot.anchors });
    const disclosures = S.signals.findDisclosures(snapshot.bodyText, { max: 25, lang: pageLanguage.code }).map(({ level, match, context, scope }) => ({ level, match, context, scope }));
    const text = analyzeTextBlocks();
    const metaText = snapshot.metas.filter((m) => /generator|ai/i.test(m.name || m.property || '')).map((m) => (m.name || m.property) + '=' + m.content).join(' | ');
    const textHints = { disclosures: disclosures.filter((d) => d.scope === 'text' || d.scope === 'general'), metaText };
    text.attribution = S.attribution.attributeText(text, textHints);
    result = {
      url: location.href, hostname: pageHost(), title: document.title, at: Date.now(),
      site, text, trader, disclosures, textHints,
      images: { total: 0, inspected: 0, pending: 0, counts: {}, items: [] },
    };
    refreshSummary();
    const imgs = [...collectImages(), ...collectMedia()];
    await processImages(imgs, id);
    applyPlatformLabels();
  }

  /* Platform-applied AI labels (Instagram, TikTok, YouTube, LinkedIn,
   * Pinterest, X). These survive where embedded metadata does not, so they
   * are merged into the matching image's signals, and media that would
   * otherwise be untracked gets its own badge. */
  function applyPlatformLabels() {
    if (!settings.platformLabels) return;
    let labels = [];
    try { labels = S.platformLabels.scanLabels(pageHost(), document); } catch (e) { return; }
    if (!labels.length) return;
    for (const label of labels) {
      const signal = S.platformLabels.toImageSignal(label);
      if (!label.media) {
        if (!result.disclosures.some((d) => d.match === label.text)) {
          result.disclosures.push({ level: label.level === 'info' ? 'weak' : label.level, match: label.text, context: signal.label + ': “' + label.text + '”', scope: 'image' });
        }
        continue;
      }
      let st = imageState.get(label.media);
      if (!st) {
        st = { key: 'i' + (++imageCounter), el: label.media, url: label.media.currentSrc || label.media.src || location.href, hints: [], bytes: null, verdict: 'no-signal', score: 0, signals: [], done: true, forced: true };
        imageState.set(label.media, st);
      }
      if (st.signals.some((x) => x.id === 'platform-label' && x.detail === signal.detail)) continue;
      st.signals = [...st.signals, signal];
      st.platformLabel = { platform: label.platform, level: label.level, text: label.text };
      applyImageVerdict(st, label.level !== 'info');
    }
    refreshSummary();
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
    const anchors = [...document.querySelectorAll('a[href]')].slice(0, 600).map((a) => ({ text: (a.textContent || '').trim().slice(0, 80), href: a.getAttribute('href') || '' }));
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
      url: location.href, hostname: pageHost(), lang: document.documentElement.lang || '', title: document.title,
      metas, scripts, inlineScripts, jsonLd, links, anchors, comments, attrNames: [...attrs], bodyText,
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
    const declared = document.documentElement.lang || '';
    // Detect once from the page as a whole; per-block samples are too short.
    const language = pageLanguage || (pageLanguage = S.lexicons.detectLanguage(lastBodyText, declared));
    const opts = { lang: declared, language, sensitivity: settings.sensitivity };
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
      const blockAttr = S.attribution.attributeText({ verdict: r.verdict, disclosures: r.disclosures, page: { signals: r.signals } });
      const details = r.signals.map((s) => ({ label: s.label, detail: s.detail }));
      if (blockAttr) {
        details.unshift({ label: 'Likely tool: ' + blockAttr.name, detail: S.attribution.CONFIDENCE_LABEL[blockAttr.confidence] + (blockAttr.evidence ? ' · ' + blockAttr.evidence : '') });
        for (const k of S.attribution.skewsFor(blockAttr, 'text').slice(0, 3)) details.push({ label: 'Skew · ' + k.area, detail: k.note });
      }
      S.overlay.upsertMarker({ key, el: b.el, kind: 'text', verdict: r.verdict, details, raw: b.text.slice(0, 4000) });
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
      language: page ? page.language : (prev ? prev.language : null),
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

  /* Video and audio, plus any poster frame, alongside images. Media carries
   * Content Credentials in the same JUMBF store, so it goes through the same
   * pipeline; only the byte budget differs. */
  function collectMedia() {
    const out = [];
    if (!settings.inspectMedia) return out;
    for (const m of document.querySelectorAll('video, audio')) {
      if (m.closest('[data-srl-ui]')) continue;
      const src = m.currentSrc || m.getAttribute('src') || (m.querySelector('source[src]') || {}).src || '';
      const r = m.getBoundingClientRect();
      const rendered = r.width >= 24 && r.height >= 24;
      if (src && rendered && !imageStateHasUrl(m, src)) {
        out.push({ el: m, url: src, kind: 'av', alt: '', title: m.title || '', ariaLabel: m.getAttribute('aria-label') || '', caption: captionFor(m) });
      }
      /* The same rendered-size floor as the video's own source. Without it a
       * hidden <video poster="…"> was a URL the extension would fetch for a
       * page that never displayed, let alone loaded, the poster itself. */
      const poster = m.tagName === 'VIDEO' && rendered ? m.getAttribute('poster') : null;
      if (poster) {
        // The page writes this attribute, and it need not be a URL at all;
        // one unparseable one would otherwise stop the whole analysis for the
        // page's life. resolveUrl answers null instead of throwing.
        const abs = S.imageHints.resolveUrl(poster, location.href);
        if (abs && !posterSeen.has(abs)) {
          posterSeen.add(abs);
          out.push({ el: m, url: abs, kind: 'poster', alt: '', title: '', ariaLabel: '', caption: captionFor(m) });
        }
      }
    }
    return out;
  }

  function imageStateHasUrl(el, url) {
    const st = imageState.get(el);
    return !!st && st.url === url;
  }

  function collectImages() {
    const out = [];
    for (const img of document.images) {
      if (img.closest('[data-srl-ui]')) continue;
      const url = img.currentSrc || img.src;
      if (!url) continue;
      const prev = imageState.get(img);
      if (prev) {
        if (prev.url === url) continue;
        S.overlay.removeMarker(prev.key);   // src changed: analyse again
        imageState.delete(img);
      }
      const r = img.getBoundingClientRect();
      const w = r.width || img.width, h = r.height || img.height;
      if (w < settings.minImageSize || h < settings.minImageSize) continue;
      out.push({ el: img, url, alt: img.alt || '', title: img.title || '', ariaLabel: img.getAttribute('aria-label') || '', caption: captionFor(img), w: Math.round(w), h: Math.round(h) });
    }
    return out;
  }

  /*
   * Has the page's own loader already fetched this?
   *
   * That is the question the address-space policy cannot answer: it reads the
   * URL's text and never resolves it, so a name the attacker owns pointed at
   * 127.0.0.1 is classified public and fetched by a worker that is exempt
   * from mixed-content blocking, the page's CSP and Private Network Access.
   * A URL the browser has already requested for this document has been
   * through all three for that exact request, so re-reading it mints no new
   * capability; a URL that only ever appeared in an attribute has not.
   *
   * Resource timing is the record of what was actually requested — a resource
   * mixed-content blocking or a CSP refused never appears there — and it is
   * read through the isolated world's own bindings, so the page cannot patch
   * what this sees. Entries can be cleared by the page and the buffer can
   * overflow, so the observer keeps its own copy as they arrive; the sweep in
   * processImages covers whatever landed before it was registered.
   *
   * The element's own state is the fallback, for a blob: URL (which resource
   * timing does not record) and for a browser without the observer. A failed
   * <img> completes with no intrinsic size at all, which is what separates it
   * from an SVG that has only one of the two.
   */
  const fetchedByPage = new Set();

  function sweepFetched() {
    try { for (const e of performance.getEntriesByType('resource')) fetchedByPage.add(e.name); } catch (e) { /* nothing to read */ }
  }

  function observeFetches() {
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) fetchedByPage.add(e.name); }).observe({ type: 'resource', buffered: true });
    } catch (e) { /* the sweep still runs */ }
  }

  function pageLoaded(item) {
    const el = item.el;
    if (fetchedByPage.has(item.url)) return true;
    if (!el) return false;
    if (item.kind === 'av') return el.readyState >= 1;            // HAVE_METADATA
    if (item.kind === 'poster') return false;                     // nothing else reports whether a poster was fetched
    return !!el.complete && (el.naturalWidth > 0 || el.naturalHeight > 0);
  }

  const retryArmed = new WeakSet();

  /*
   * An element the page is still loading has not failed the gate above, it
   * has not answered it yet: the browser's own request is in flight. One
   * listener per element re-collects it when that request settles, so a slow
   * image is inspected rather than dropped. An element that loads and fails
   * fires no 'load' at all and stays out, which is the point.
   */
  function retryWhenLoaded(item, st) {
    const el = item.el;
    const kind = item.kind || 'image';
    if (!el || kind === 'poster' || retryArmed.has(el)) return;
    if (kind === 'av' ? el.readyState >= 1 : el.complete) return;
    retryArmed.add(el);
    el.addEventListener(kind === 'av' ? 'loadedmetadata' : 'load', () => {
      retryArmed.delete(el);
      if (!active() || imageState.get(el) !== st) return;   // superseded, or the host was paused
      imageState.delete(el);
      S.overlay.removeMarker(st.key);
      const again = [...collectImages(), ...collectMedia()].filter((x) => x.el === el);
      if (again.length) processImages(again, runId);
    }, { once: true });
  }

  /*
   * An element the page has taken out of the document is not in front of the
   * reader any more: its badge goes with it, and so does the inspection
   * budget it was holding. Without this a virtualised feed or a client-side
   * route change accumulates state for pictures nobody can see, which is
   * both a leak and — before the budget below was made a live count — the
   * thing that made the extension go quietly blind.
   */
  function dropDetached() {
    for (const [key, st] of imageState) {
      if (st.el && st.el.isConnected === false) {
        imageState.delete(key);
        S.overlay.removeMarker(st.key);
      }
    }
  }

  /*
   * What one view may have inspected at once.
   *
   * This cap used to count live <img> elements, and a src rewrite deletes
   * the entry and re-inserts it, so rewriting the same sixty srcs re-armed
   * it indefinitely: twenty ordinary batches pulled 640 requests and 2.6 GB.
   * Counting instead every URL the document had ever submitted stopped that
   * and paid for it in the reader's sight: nothing refilled the count, so a
   * single-page app or an infinite feed went blind after sixty distinct
   * images — for the tab's whole life, no badge, no marker, a page report
   * indistinguishable from a clean one.
   *
   * Volume is bounded where it is actually spent. The worker charges each
   * tab a request and byte budget per minute (BUDGET_REQUESTS, BUDGET_BYTES)
   * which no amount of rewriting re-arms, and that is what answers the
   * denial of service. What is wanted here is only a ceiling on how much of
   * the view in front of the reader is inspected at once, so it is counted
   * over the images this document is still tracking plus the fetches still
   * in flight: a route change or a feed that drops its nodes gives its
   * budget back, a page that holds sixty images on screen does not.
   */
  function imageBudget() {
    const spent = new Set(inFlightUrls.keys());
    for (const st of imageState.values()) if (st.submitted) spent.add(st.url);
    return spent;
  }

  function holdUrl(url) { inFlightUrls.set(url, (inFlightUrls.get(url) || 0) + 1); }

  function releaseUrl(entry) {
    if (entry.released) return;
    entry.released = true;
    const n = (inFlightUrls.get(entry.msg.url) || 1) - 1;
    if (n > 0) inFlightUrls.set(entry.msg.url, n); else inFlightUrls.delete(entry.msg.url);
  }

  /* Skipping an image for budget is not the same as finding nothing in it,
   * and a reader cannot tell the two apart from a blank badge. */
  function overBudgetSignal() {
    return { id: 'not-budgeted', hard: false, verdict: 'unavailable', strength: 0, label: 'Not inspected: this page shows more images at once than the inspection limit', detail: 'The first ' + settings.maxImages + ' images in view have their bytes read; this one did not, so nothing here says whether it carries provenance either way.' };
  }

  async function processImages(list, id) {
    sweepFetched();
    dropDetached();
    const spent = imageBudget();
    const toFetch = [];
    for (const item of list) {
      // One unreadable item must not cost the page every later one.
      try {
        const key = 'i' + (++imageCounter);
        const hints = S.imageHints.analyzeImageHints(item);
        const st = { key, el: item.el, url: item.url, kind: item.kind || 'image', hints, bytes: null, verdict: 'no-signal', score: 0, signals: hints, done: false };
        // A poster shares its element with the video, so it is tracked by key.
        imageState.set(item.kind === 'poster' ? Symbol('poster:' + item.url) : item.el, st);
        const wanted = settings.fetchImages && !/^data:image\/svg/i.test(item.url) && pageLoaded(item);
        const budgeted = spent.has(item.url) || spent.size < settings.maxImages;
        if (wanted && budgeted) {
          spent.add(item.url);
          st.submitted = true;
          const msg = { id: key, url: item.url, kind: item.kind === 'av' ? 'av' : 'image' };
          holdUrl(item.url);
          toFetch.push({ st, msg });
        } else {
          if (wanted) st.signals = [...st.signals, overBudgetSignal()];
          st.done = true;
          retryWhenLoaded(item, st);
        }
        applyImageVerdict(st);
      } catch (e) { /* skip this item */ }
    }
    /*
     * The bytes the page itself has, wherever they can be had.
     *
     * The worker's fetch is a second, distinguishable request — no cookies, a
     * Range header, no Referer — so a server can answer the reader with an AI
     * picture and the extension with a signed photograph, and the badge lands
     * on the one nobody hashed. `only-if-cached` reads the response the
     * browser already holds and makes no request of its own, so it costs no
     * traffic and sends no cookies; it is same-origin only, and a blob: URL
     * is only reachable from here at all. Reading the cache is not the same
     * as reading the picture, though — see showsTheseBytes, which is what
     * decides whether these bytes may speak for it. Where neither applies the
     * worker still fetches, and deriveSignals will not read an exculpatory
     * claim out of bytes nobody can tie to the picture (hints.rendered).
     */
    for (const entry of toFetch) {
      if (entry.msg.kind === 'av') continue;      // a video is too large to pull through a message
      await addPageBytes(entry.msg, entry.st.el);
    }
    pendingImages += toFetch.length;
    refreshSummary();
    try {
      for (let i = 0; i < toFetch.length; i += 6) {
        if (id !== runId) return;
        const batch = toFetch.slice(i, i + 6);
        let resp = null;
        try {
          resp = await chrome.runtime.sendMessage({ type: 'srl:analyze-images', images: batch.map((b) => b.msg), settings: { maxImageBytes: settings.maxImageBytes, maxMediaBytes: settings.maxMediaBytes } });
        } catch (e) { resp = null; }
        if (id !== runId) return;
        const byId = new Map(((resp && resp.results) || []).map((r) => [r.id, r]));
        for (const entry of batch) {
          const st = entry.st;
          const r = byId.get(st.key);
          releaseUrl(entry);
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
    } finally {
      // Superseded runs and thrown batches release their hold too, or the
      // budget drains without ever having fetched anything.
      for (const entry of toFetch) releaseUrl(entry);
    }
  }

  function applyImageVerdict(st, force) {
    const c = V.combineImageSignals(st.signals);
    st.verdict = c.verdict; st.score = c.score;
    st.attribution = V.AI_IMAGE_VERDICTS.has(st.verdict) ? S.attribution.attributeImage(st.signals, st.bytes && st.bytes.metadata) : null;
    const show = force || st.forced || (st.verdict !== 'no-signal' && st.verdict !== 'unavailable' ? true : settings.markUnflaggedImages && st.done);
    if (show) {
      const details = st.signals.filter((s) => s.label).map((s) => ({ label: s.label, detail: s.detail }));
      if (st.attribution) {
        details.unshift({ label: 'Likely tool: ' + st.attribution.name, detail: S.attribution.CONFIDENCE_LABEL[st.attribution.confidence] + (st.attribution.evidence ? ' · ' + st.attribution.evidence : '') + (st.attribution.detail ? ' · ' + st.attribution.detail : '') });
        for (const k of S.attribution.skewsFor(st.attribution, 'image').slice(0, 3)) details.push({ label: 'Skew · ' + k.area, detail: k.note });
      }
      if (st.bytes && st.bytes.format) details.push({ label: 'Inspected ' + Math.round((st.bytes.size || 0) / 1024) + ' KB of ' + st.bytes.format.toUpperCase() + (st.bytes.truncated ? ' (truncated)' : ''), detail: '' });
      S.overlay.upsertMarker({ key: st.key, el: st.el, kind: 'image', verdict: st.verdict, details });
    } else S.overlay.removeMarker(st.key);
  }

  /* resolveUrl rather than a bare `new URL`: the string came off an attribute
   * the page wrote, and one unparseable one used to abort the whole analysis.
   * An origin is a prefix of the resolved href, so no second parse is wanted. */
  function sameOrigin(url) {
    const abs = S.imageHints.resolveUrl(url, location.href);
    return !!abs && (abs === location.origin || abs.startsWith(location.origin + '/'));
  }

  /* Fills msg.base64 when the page can produce the bytes, and msg.rendered
   * only when they have been shown to be the picture on the page; leaves the
   * message alone otherwise, and the worker's own fetch stands. */
  async function addPageBytes(msg, el) {
    const isBlob = /^blob:/i.test(msg.url);
    if (!isBlob && !sameOrigin(msg.url)) return;
    try {
      const res = isBlob ? await fetch(msg.url) : await fetch(msg.url, { mode: 'same-origin', cache: 'only-if-cached' });
      if (!res || !res.ok) return;
      const buf = await res.arrayBuffer();
      const cap = Math.min(buf.byteLength, settings.maxImageBytes);
      msg.base64 = toBase64(new Uint8Array(buf, 0, cap));
      msg.truncated = cap < buf.byteLength;
      msg.rendered = !msg.truncated && (isBlob ? namesOneBlob(el, msg.url) : await showsTheseBytes(el, msg.url, buf));
    } catch (e) { msg.base64 = null; }
  }

  /*
   * Are these the bytes on the page?
   *
   * The question the HTTP cache cannot answer, and reading it was a mistake.
   * `cache: 'only-if-cached'` returns whatever the cache holds for the URL
   * *now*, and nothing pins that entry to the response an <img> decoded: the
   * page can overwrite its own entry whenever it likes — `fetch(url, {cache:
   * 'reload'})`, or the same request from a frame or a worker this script
   * never sees — so a page can show a generated picture, replace the entry
   * with a genuinely signed photograph, and have the extension verify the
   * photograph while the reader looks at the picture. Reproduced, at the
   * browser layer and end to end. Nothing about the response distinguishes
   * the two: not its status, not res.url, and not its length either — the
   * lengths only have to match, and the generated half is the half the page
   * is free to pad to any size it likes.
   *
   * So the bytes are not taken on trust. They are decoded and compared,
   * pixel for pixel, with what this element is actually holding, and what
   * that buys is worth stating exactly: the bytes handed to the worker
   * decode to the picture this element is showing, so a credential read out
   * of them is a credential about the picture in front of the reader. It is
   * not a statement about the page's layout — an element can still be
   * covered or replaced by something painted over it, which is equally true
   * of the badge this extension draws next to it, and no check inside the
   * page can settle that.
   *
   * Everything that cannot answer the question answers no, and the bytes are
   * then read as what they are, a separate fetch whose claims are shown but
   * not believed (deriveSignals, hints.rendered): a cross-origin or
   * otherwise tainted canvas, a truncated read, an image too large to
   * compare, an element that has moved on, differing dimensions, an
   * animation past its first frame, or bytes that will not decode at all.
   */
  const MAX_COMPARE_PIXELS = 32 * 1024 * 1024;   // a 32 MP picture, four bytes a pixel
  const COMPARE_ROWS = 64;                       // rows read back at a time

  function namesOneBlob(el, url) {
    /* A blob: URL names one immutable Blob under a name nothing can
     * re-register — revoking it and creating another yields a different
     * URL — so reading it back is reading what the element was given. */
    return showingStill(el, url);
  }

  function showingStill(el, url) {
    return !!el && el.tagName === 'IMG' && !!el.complete && (el.currentSrc || el.src) === url && el.naturalWidth > 0 && el.naturalHeight > 0;
  }

  /*
   * `rendered` gates one thing: whether a C2PA claim may be read as
   * provenance for the picture. A C2PA manifest always arrives inside a
   * JUMBF store, so an image with no "jumb" in it anywhere has no claim for
   * the flag to gate, and decoding every ordinary picture on a page a second
   * time to prove that is a cost with nothing on the other side of it.
   */
  function carriesCredentials(buf) {
    const b = new Uint8Array(buf);
    for (let i = b.indexOf(0x6a); i >= 0 && i + 3 < b.length; i = b.indexOf(0x6a, i + 1)) {
      if (b[i + 1] === 0x75 && b[i + 2] === 0x6d && b[i + 3] === 0x62) return true;   // "jumb"
    }
    return false;
  }

  async function showsTheseBytes(el, url, buf) {
    if (!showingStill(el, url) || !carriesCredentials(buf)) return false;
    const w = el.naturalWidth, h = el.naturalHeight;
    if (w * h > MAX_COMPARE_PIXELS) return false;
    let bmp = null;
    try {
      bmp = await createImageBitmap(new Blob([buf]));
      // Re-asked after the await: the element may have been given something
      // else while these bytes were decoding.
      if (!showingStill(el, url) || bmp.width !== w || bmp.height !== h) return false;
      const a = compareSurface(w), b = compareSurface(w);
      for (let y = 0; y < h; y += COMPARE_ROWS) {
        const rows = Math.min(COMPARE_ROWS, h - y);
        a.clearRect(0, 0, w, rows); b.clearRect(0, 0, w, rows);
        a.drawImage(el, 0, y, w, rows, 0, 0, w, rows);
        b.drawImage(bmp, 0, y, w, rows, 0, 0, w, rows);
        const pa = a.getImageData(0, 0, w, rows).data;
        const pb = b.getImageData(0, 0, w, rows).data;
        if (pa.length !== pb.length) return false;
        // Four channels at a time: the same comparison, a quarter of the
        // iterations, on the page's own thread.
        const va = new Uint32Array(pa.buffer, pa.byteOffset, pa.length >> 2);
        const vb = new Uint32Array(pb.buffer, pb.byteOffset, pb.length >> 2);
        for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
      }
      return showingStill(el, url);
    } catch (e) {
      return false;      // tainted canvas, undecodable bytes, no createImageBitmap
    } finally {
      if (bmp && bmp.close) bmp.close();
    }
  }

  /* A few rows at a time, not the whole picture twice: a 32 MP comparison
   * would otherwise hold a quarter of a gigabyte of pixels on the page's own
   * heap. Built through the isolated world's own bindings, so the page
   * cannot hand back a canvas that agrees with whatever it likes. */
  function compareSurface(w) {
    const c = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(w, COMPARE_ROWS) : document.createElement('canvas');
    c.width = w; c.height = COMPARE_ROWS;
    return c.getContext('2d', { willReadFrequently: true });
  }

  function toBase64(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  /* ---- summary / reporting --------------------------------------------- */

  function refreshSummary() {
    if (!result) return;
    dropDetached();
    const counts = {};
    const items = [];
    let inspected = 0;
    let proven = 0;
    for (const st of imageState.values()) {
      counts[st.verdict] = (counts[st.verdict] || 0) + 1;
      if (st.bytes) inspected++;
      if (st.signals.some((x) => V.PROVEN_PROVENANCE_SIGNALS.has(x.id))) proven++;
      if ((st.platformLabel || (st.verdict !== 'no-signal' && st.verdict !== 'unavailable')) && items.length < 100) {
        items.push({ url: st.url.slice(0, 500), verdict: st.verdict, kind: st.kind || 'image', score: Math.round(st.score * 100) / 100, format: st.bytes && st.bytes.format, platformLabel: st.platformLabel || null, attribution: st.attribution ? stripSkews(st.attribution) : null, signals: st.signals.filter((s) => s.label).slice(0, 8).map(({ id, hard, verdict, strength, label, detail }) => ({ id, hard, verdict, strength, label, detail })), metadata: st.bytes ? trimMetadata(st.bytes.metadata) : null });
      }
    }
    result.images = { total: imageState.size, inspected, proven, pending: pendingImages, counts, items };
    result.overall = V.overall(result);
    result.aiSystems = collectAiSystems();
    S.overlay.setSummary({ overall: result.overall, site: result.site, text: result.text, images: result.images, aiSystems: result.aiSystems, disclosures: result.disclosures.filter((d) => d.level !== 'weak' && d.level !== 'human') });
    clearTimeout(postTimer);
    postTimer = setTimeout(postResult, 250);
  }

  function stripSkews(a) { const { skews, ...rest } = a; return rest; }

  /* Every AI system the page's evidence points to, with the layers it touched. */
  function collectAiSystems() {
    const map = new Map();
    const add = (attr, layer) => {
      if (!attr) return;
      const key = attr.id || 'unknown-' + layer;
      const cur = map.get(key) || { id: attr.id, name: attr.name, vendor: attr.vendor || null, country: attr.country || null, layers: [], confidence: attr.confidence, evidence: attr.evidence, marking: attr.marking || null, count: 0 };
      if (!cur.layers.includes(layer)) cur.layers.push(layer);
      cur.count++;
      const rank = { confirmed: 3, declared: 2, inferred: 1, unknown: 0 };
      if (rank[attr.confidence] > rank[cur.confidence]) { cur.confidence = attr.confidence; cur.evidence = attr.evidence; cur.name = attr.name; }
      map.set(key, cur);
    };
    add(result.site && result.site.attribution, 'site');
    add(result.text && result.text.attribution, 'text');
    for (const st of imageState.values()) add(st.attribution, 'image');
    return [...map.values()];
  }

  function trimMetadata(m) {
    if (!m) return null;
    const out = {};
    if (m.exif) out.exif = m.exif;
    if (m.xmp) out.xmp = m.xmp;
    if (m.pngText) out.pngText = Object.fromEntries(Object.entries(m.pngText).slice(0, 8).map(([k, v]) => [k, String(v).slice(0, 200)]));
    if (m.c2pa) out.c2pa = { claimGenerator: m.c2pa.claimGenerator, claimGeneratorInfo: m.c2pa.claimGeneratorInfo, title: m.c2pa.title, actions: (m.c2pa.actions || []).slice(0, 12), assertions: m.c2pa.assertions, ingredients: m.c2pa.ingredients, signerNames: m.c2pa.signerNames, digitalSourceTypes: m.c2pa.digitalSourceTypes, softwareAgents: m.c2pa.softwareAgents, manifestCount: m.c2pa.manifestCount, verification: m.c2pa.verification || null };
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
        if (!active()) return;
        const id = runId;
        const imgs = [...collectImages(), ...collectMedia()];
        if (imgs.length) processImages(imgs, id);
        applyPlatformLabels();
        const t = analyzeTextBlocks(true);
        if (result) {
          t.attribution = S.attribution.attributeText(t, result.textHints);
          result.text = t;
          refreshSummary();
        }
        S.overlay.reposition();
      }, 900);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main, { once: true });
  else main();
})();
