/*
 * web/app.js — the website's front end. The extension's own analysers (lib/), run on one file
 * the visitor picks, in this page:
 *
 *   an image, a video or an audio file  → lib/image-metadata (C2PA verified with WebCrypto,
 *                                         XMP/IPTC, EXIF, PNG generator chunks) and the
 *                                         file-name hints of lib/image-hints
 *   a web page saved as HTML            → lib/site-analyzer, lib/text-analyzer,
 *                                         lib/legitimacy and lib/image-hints, on the file
 *                                         parsed into an inert document
 *   plain text                          → lib/text-analyzer
 *
 * Nothing is uploaded and nothing is fetched: the policy's connect-src is 'none', and the file
 * is read with the File API. Four lib/ modules are not loaded, each for a reason the page
 * cannot work around: settings.js and history.js keep their records in chrome.storage (this
 * page keeps nothing), fetch-policy.js governs the extension worker's cross-origin fetches
 * (this page fetches nothing), and platform-labels.js pairs a platform's "Made with AI" label
 * with the media in the same post by where each sits on screen, which a saved file parsed
 * without layout cannot answer.
 *
 * Everything the file says reaches the page as text: elements are built with createElement
 * and filled with textContent, never from a string of HTML. The one place a string becomes a
 * document is DOMParser, under the Trusted Types policy below, into a document that has no
 * window: none of its scripts run, none of its event handlers fire, and none of its pictures,
 * styles or frames are fetched.
 */
(function () {
  'use strict';
  const S = globalThis.SRL;
  const NEEDS = ['lexicons', 'signals', 'verdicts', 'textAnalyzer', 'siteAnalyzer', 'imageHints', 'legitimacy', 'attribution', 'cbor', 'x509', 'c2paVerify', 'imageMeta'];
  /* A missing module is a start failure the safety net (guard.js) reports, not a picker that
   * accepts a file and then throws. */
  const missing = NEEDS.filter((k) => !S || !S[k]);
  if (missing.length) throw new Error('Selfreportle: modules missing: ' + missing.join(', '));
  const V = S.verdicts;
  const A = S.attribution;
  const $ = (id) => document.getElementById(id);

  /* How much of a file is read. An image's provenance usually sits in its first few hundred
   * KB, and the extension's own ceiling for one image is 32 MB (lib/settings.js, RANGES), so a
   * file up to that is read whole — which is what lets the hard binding be recomputed over all
   * of it. Past that the head is read, and for MP4/MOV, whose index (and so the credentials)
   * often sits at the end, the tail as well, as the extension does. A saved page or a text
   * file is read to 8 MB: the extension reads at most 300,000 characters of a page's text. */
  const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
  const MAX_TAIL_BYTES = 8 * 1024 * 1024;
  const MAX_PAGE_BYTES = 8 * 1024 * 1024;
  const MAX_BODY_TEXT = 300000;
  const SENSITIVITY = 'medium';

  /* The same selectors the content script reads a live page with (content/content.js). A
   * saved file has no layout, so `[hidden]` is the one hiding rule that can be read off it;
   * `noframes` is where the page's <style> blocks are put (quietStyles, below). */
  const BLOCK_SEL = 'p, li, blockquote, h1, h2, h3, h4, h5, h6, dd, dt, figcaption, td, th, pre, summary';
  const SKIP_SEL = 'srl-overlay, [data-srl-ui], script, style, noframes, noscript, template, textarea, [contenteditable="true"], svg, [hidden]';
  const BREAK_TAGS = new Set(['BR', 'P', 'DIV', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'TR', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'NAV', 'ASIDE', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FORM', 'FIELDSET', 'DETAILS', 'SUMMARY', 'ADDRESS', 'HR']);

  /*
   * Trusted Types. The policy (require-trusted-types-for 'script') makes every HTML string
   * sink throw, DOMParser included, and names this one policy as the only one that may be
   * created. It exists for parseSavedPage alone and is never exported: the document it makes
   * belongs to no window, so markup in it is data. Where the browser has no Trusted Types the
   * string goes to DOMParser as it is, which is just as inert.
   */
  const inertPolicy = (typeof trustedTypes !== 'undefined' && trustedTypes && typeof trustedTypes.createPolicy === 'function')
    ? trustedTypes.createPolicy('selfreportle-saved-page', { createHTML: (s) => s })
    : null;

  function parseSavedPage(html) {
    const quiet = quietStyles(html);
    return new DOMParser().parseFromString(inertPolicy ? inertPolicy.createHTML(quiet) : quiet, 'text/html');
  }

  /*
   * The saved page's own styles, taken out of the way before it is parsed. A document built
   * by DOMParser has no window and never renders, but Chromium still checks its <style>
   * elements and style="" attributes against this page's policy while it parses, and reports
   * every one as a style-src violation (measured: one per element and per attribute, each a
   * console error), and its <base> against base-uri the same way. Nothing here wants those
   * styles or that base (addresses are read off the attributes and resolved against the
   * address the file names), so each <style> tag is renamed <noframes>, which the HTML parser
   * treats the same way — a raw-text element, placed where a <style> would be, its CSS left as
   * unparsed text — but which no policy governs; each style attribute is renamed
   * data-srl-style; and each <base> becomes a <meta>, the void head element the parser places
   * exactly where it places a <base>. The patterns are linear. One the rename misses (markup
   * too broken to name a tag) costs a console line, never a style applied.
   */
  function quietStyles(html) {
    return html.replace(/<(\/?)style(?=[\s/>])/gi, '<$1noframes').replace(/(\s)style(\s*=)/gi, '$1data-srl-style$2')
      .replace(/<base(?=[\s/>])/gi, '<meta data-srl-base');
  }

  /* ---- intake ------------------------------------------------------------- */

  const input = $('file');
  const drop = $('drop');
  let run = 0;
  let previewUrl = null;

  input.addEventListener('change', () => { if (input.files && input.files[0]) analyse(input.files[0]); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) analyse(f);
  });

  function status(text, isError) {
    const s = $('status');
    s.textContent = text || '';
    s.classList.toggle('error', !!isError);
  }

  /*
   * One file at a time; a second pick supersedes the first, whose result is dropped when it
   * arrives. An analyser that throws is reported in the page, as the content script records
   * it on the result, rather than leaving the reader with a spinner.
   */
  async function analyse(file) {
    const id = ++run;
    clearReport();
    status('Reading ' + file.name + '…');
    try {
      const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
      const kind = kindOf(file, head);
      let nodes;
      if (kind === 'media') nodes = await analyseMedia(file, id);
      else if (kind === 'page') nodes = await analysePage(file);
      else if (kind === 'text') nodes = await analyseTextFile(file);
      else {
        if (id !== run) return;
        status('This file is not one Selfreportle reads: pick an image, a video or audio file, a web page saved as HTML, or a text file.', true);
        return;
      }
      if (id !== run) return;
      $('report').replaceChildren(...nodes);
      status('');
    } catch (e) {
      if (id !== run) return;
      status('The file could not be analysed: ' + String((e && e.message) || e).slice(0, 200), true);
    }
  }

  function clearReport() {
    $('report').replaceChildren();
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
  }

  /* What a file is, by its bytes first and its name second: the name and the type the
   * operating system reports are only labels. */
  function kindOf(file, b) {
    const ascii = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'media';
    if (b.length >= 8 && b[0] === 0x89 && ascii(1, 3) === 'PNG') return 'media';
    if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'media';
    if (b.length >= 12 && ascii(4, 4) === 'ftyp') return 'media';
    if (b.length >= 6 && ascii(0, 4) === 'GIF8') return 'media';
    const lead = afterPrologue(new TextDecoder('utf-8').decode(b));
    if (/^<svg[\s>]/i.test(lead)) return 'media';
    if (/^<(?:!doctype\s+html|html|head|body|meta|title)[\s>]/i.test(lead)) return 'page';
    const name = String(file.name || '').toLowerCase();
    if (/\.(?:x?html?)$/.test(name)) return 'page';
    if (/\.(?:txt|md|markdown|text)$/.test(name) || /^text\/plain\b/.test(file.type || '')) return b.includes(0) ? 'unknown' : 'text';
    return 'unknown';
  }

  /* The start of a file with a byte-order mark, white space, an XML declaration and comments
   * taken off, so the first tag can be named. A loop rather than one pattern: a pattern that
   * repeats a comment of any length can split a run of comments more ways than there are
   * atoms in the universe, and the file chooses the run. */
  function afterPrologue(text) {
    let t = text.replace(/^\uFEFF/, '').trimStart();
    for (let i = 0; i < 64; i++) {
      const close = t.startsWith('<!--') ? '-->' : t.startsWith('<?') ? '?>' : null;
      if (!close) break;
      const end = t.indexOf(close, 2);
      if (end < 0) return '';
      t = t.slice(end + close.length).trimStart();
    }
    return t;
  }

  /* ---- images, video and audio --------------------------------------------- */

  async function analyseMedia(file, id) {
    const truncated = file.size > MAX_MEDIA_BYTES;
    const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, MAX_MEDIA_BYTES)).arrayBuffer());
    status('Checking ' + file.name + ' for embedded provenance…');
    /*
     * `rendered` is the extension's word for "these are the bytes of the picture the reader is
     * looking at"; in the page it has to prove that by decoding the bytes and matching them
     * against the element, pixel for pixel. Here it holds by construction: the bytes analysed
     * are the file the visitor asked about, and the preview below is drawn from the same
     * bytes. It is one of three conditions for a camera or human-made badge; the others
     * (a verified, bound manifest, and a signer this build knows) still have to hold, and no
     * build ships a trust list.
     */
    const analysed = await S.imageMeta.analyzeImageBytes(bytes, { url: file.name, truncated, rendered: true });
    let metadata = analysed.metadata;
    let signals = analysed.signals;
    let tailRead = 0;
    if (truncated && !(metadata && metadata.c2pa) && /^isobmff/.test(analysed.format) && S.imageMeta.isobmffNeedsTail(bytes)) {
      const n = Math.min(MAX_TAIL_BYTES, file.size);
      const tail = new Uint8Array(await file.slice(file.size - n).arrayBuffer());
      const fromTail = await S.imageMeta.analyzeImageBytes(tail, { url: file.name, truncated: true, rendered: true });
      if (fromTail.metadata && fromTail.metadata.c2pa) {
        metadata = { ...metadata, ...fromTail.metadata };
        signals = [...signals.filter((s) => s.id !== 'note'), ...fromTail.signals];
        tailRead = tail.length;
      }
    }
    const hints = S.imageHints.analyzeImageHints({ url: fileUrl(file.name) });
    const all = [...hints, ...signals];
    const c = V.combineImageSignals(all);
    const attribution = V.AI_IMAGE_VERDICTS.has(c.verdict) ? A.attributeImage(all, metadata) : null;
    if (id !== run) return [];

    const out = [];
    const head = el('div', 'file');
    const preview = previewFor(analysed.format, bytes, truncated);
    if (preview) head.appendChild(preview);
    const who = el('div');
    who.appendChild(el('div', 'name', file.name));
    who.appendChild(el('div', 'meta', formatName(analysed.format) + ' · ' + sizeText(file.size)
      + (truncated ? ' · the first ' + sizeText(bytes.length) + (tailRead ? ' and the last ' + sizeText(tailRead) : '') + ' were read' : ' · read in full')));
    head.appendChild(who);
    out.push(head);

    const info = V.IMAGE[c.verdict] || V.IMAGE['no-signal'];
    out.push(banner(info.color, info.icon, info.label, imageHint(c.verdict)));
    const panel = section('Evidence in the file');
    const ab = attributionBox(attribution, 'image');
    if (ab) panel.appendChild(ab);
    const shown = all.filter((s) => s.label && s.id !== 'c2pa-verified' && s.id !== 'c2pa-unverified');
    for (const s of shown) panel.appendChild(sigRow(s));
    if (!shown.length) panel.appendChild(el('p', 'note', 'No provenance metadata, generator parameters or AI markers were found in this file. Most platforms strip metadata on upload, so this is not proof of human origin.'));
    out.push(panel);
    if (metadata && metadata.c2pa) out.push(credentialsPanel(metadata.c2pa));
    return out;
  }

  /* A file name as a URL, so that lib/image-hints reads it the way it reads an image's
   * address on a page: the last path segment is the file name. */
  function fileUrl(name) {
    return 'file:///' + encodeURIComponent(String(name || 'file'));
  }

  /*
   * A preview, drawn from the bytes that were analysed and labelled with the type their own
   * signature says, never the one the operating system reported: a Blob typed image/png that
   * holds HTML is still only a broken picture if it is ever opened on its own. SVG is not
   * previewed, since an SVG opened as a document is a script carrier.
   */
  const PREVIEW_TYPES = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
  function previewFor(format, bytes, truncated) {
    if (truncated || !Object.prototype.hasOwnProperty.call(PREVIEW_TYPES, format)) return null;
    previewUrl = URL.createObjectURL(new Blob([bytes], { type: PREVIEW_TYPES[format] }));
    const img = document.createElement('img');
    img.className = 'preview';
    img.alt = 'Preview of the file you picked';
    img.src = previewUrl;
    return img;
  }

  function formatName(f) {
    return ({ jpeg: 'JPEG', png: 'PNG', webp: 'WebP', gif: 'GIF', svg: 'SVG', isobmff: 'AVIF / HEIC', 'isobmff-av': 'MP4 / MOV / M4A' })[f] || 'Unrecognised format';
  }

  function imageHint(verdict) {
    switch (verdict) {
      case 'ai-generated': return 'The file itself says it was generated by AI: embedded credentials, metadata or generator parameters.';
      case 'ai-edited': return 'The file itself says AI was used to edit or composite it.';
      case 'ai-disclosed': return 'AI involvement is declared in the file.';
      case 'suspected': return 'Only weak or indirect signs, or credentials that do not hold up. A prompt to look closer, not a verdict.';
      case 'self-claimed': return 'The file claims an origin (a camera, a person) that could not be verified. Shown as the claim it is.';
      case 'captured': case 'human-created': case 'algorithmic': return 'Credentials that verified, are bound to this file and come from a signer this build knows.';
      default: return 'No provenance signals. Many AI systems still emit nothing detectable, and metadata is routinely stripped, so this is not proof of human origin.';
    }
  }

  /* ---- a saved web page ----------------------------------------------------- */

  async function readText(file, cap) {
    const truncated = file.size > cap;
    const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, cap)).arrayBuffer());
    return { text: decode(bytes), truncated, read: bytes.length };
  }

  /* The charset a saved page declares, else UTF-8. TextDecoder knows every label the web
   * uses and throws on any other, which falls back too; a <meta> that names UTF-16 is read as
   * UTF-8, as the HTML standard has a browser do, since a file whose ASCII spelled that tag out
   * is not UTF-16. */
  function decode(bytes) {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
    const m = /<meta[^>]{0,200}?charset\s*=\s*["']?([A-Za-z0-9_.:-]{1,40})/i.exec(head);
    if (m && !/^(?:utf-?16|ucs-?2|unicode)/i.test(m[1])) { try { return new TextDecoder(m[1]).decode(bytes); } catch (e) { /* unknown label */ } }
    return new TextDecoder('utf-8').decode(bytes);
  }

  async function analysePage(file) {
    const { text: html, truncated, read } = await readText(file, MAX_PAGE_BYTES);
    status('Reading the saved page…');
    const doc = parseSavedPage(html);
    const origin = savedFrom(doc);
    const snapshot = collectSnapshot(doc, origin);
    const language = S.lexicons.detectLanguage(snapshot.bodyText, snapshot.lang);
    const site = S.siteAnalyzer.analyzeSite(snapshot);
    site.attribution = A.attributeSite(site, snapshot);
    const trader = S.legitimacy.analyzeLegitimacy({ url: snapshot.url, hostname: snapshot.hostname, bodyText: snapshot.bodyText, links: snapshot.anchors });
    /* Whether the page was served over HTTPS is a fact about its address, and a file that
     * does not say where it came from has none: the check is left out rather than failed. */
    if (!origin) trader.checks = trader.checks.filter((c) => c.id !== 'https');
    const disclosures = S.signals.findDisclosures(snapshot.bodyText, { max: 25, lang: language.code }).map(({ level, match, context, scope }) => ({ level, match, context, scope }));
    const textResult = analyseBlocks(doc, snapshot, language);
    const metaText = snapshot.metas.filter((m) => /generator|ai/i.test(m.name || m.property || '')).map((m) => (m.name || m.property) + '=' + m.content).join(' | ');
    const textHints = { disclosures: disclosures.filter((d) => d.scope === 'text' || d.scope === 'general'), metaText };
    textResult.attribution = A.attributeText(textResult, textHints);
    const images = pageImages(doc, origin);
    const result = { url: snapshot.url, hostname: snapshot.hostname, title: snapshot.title, site, text: textResult, trader, disclosures, textHints, images: images.summary };
    result.overall = V.overall(result);
    result.aiSystems = aiSystems(result, images.attributions);

    const out = [];
    const head = el('div', 'file');
    const who = el('div');
    who.appendChild(el('div', 'name', file.name));
    who.appendChild(el('div', 'meta', 'Saved web page · ' + sizeText(file.size) + (truncated ? ' · the first ' + sizeText(read) + ' were read' : '')));
    who.appendChild(el('div', 'meta', origin ? 'The file says it was saved from ' + origin.href : 'The file does not say which address it was saved from.'));
    if (snapshot.title) who.appendChild(el('div', 'meta', 'Title: ' + snapshot.title));
    head.appendChild(who);
    out.push(head);
    const overall = V.OVERALL[result.overall] || V.OVERALL.none;
    out.push(banner(overall.color, overall.icon, overall.label, trustHint(result.overall)));
    out.push(summaryPanel(result));
    out.push(sitePanel(site));
    out.push(textPanel(textResult));
    out.push(imagesPanel(images));
    out.push(traderPanel(trader, !!origin));
    out.push(toolsPanel(result.aiSystems));
    return out;
  }

  /*
   * Where the file says it came from. Chrome writes `<!-- saved from url=(0024)https://… -->`
   * at the top of a page it saves; failing that, the page's own canonical link or og:url.
   * Each is only what the file states — the file is the visitor's, and anyone could have
   * written it — and the report says so. Only an http(s) address is taken.
   */
  function savedFrom(doc) {
    const candidates = [];
    for (const n of [...doc.childNodes, ...(doc.documentElement ? doc.documentElement.childNodes : [])].slice(0, 40)) {
      if (n.nodeType !== 8) continue;
      const m = /^\s*saved from url=\(\d{1,6}\)(\S{1,2048})\s*$/i.exec(n.nodeValue || '');
      if (m) candidates.push(m[1]);
    }
    const canonical = doc.querySelector('link[rel~="canonical"][href]');
    if (canonical) candidates.push(canonical.getAttribute('href'));
    const og = doc.querySelector('meta[property="og:url"][content]');
    if (og) candidates.push(og.getAttribute('content'));
    for (const c of candidates) {
      try {
        const u = new URL(c);
        if (u.protocol === 'https:' || u.protocol === 'http:') return u;
      } catch (e) { /* not an address */ }
    }
    return null;
  }

  /* What the page's own markup holds, in the shape lib/site-analyzer reads — the content
   * script's collectSnapshot, for a document with no window: attributes are read as written
   * (a property such as script.src would resolve them against this site, not the page's
   * address) and resolved against the address the file names, if any. */
  function collectSnapshot(doc, origin) {
    const base = origin ? origin.href : 'file:///';
    const abs = (v) => (v ? S.imageHints.resolveUrl(v, base) || v : '');
    const metas = [...doc.querySelectorAll('meta')].slice(0, 300).map((m) => ({
      name: m.getAttribute('name') || '', property: m.getAttribute('property') || '', itemprop: m.getAttribute('itemprop') || '', content: (m.getAttribute('content') || '').slice(0, 300),
    }));
    const scriptEls = [...doc.querySelectorAll('script')];
    const scripts = scriptEls.map((s) => abs(s.getAttribute('src'))).filter(Boolean).slice(0, 300);
    const inlineScripts = scriptEls.filter((s) => !s.hasAttribute('src') && s.textContent && s.getAttribute('type') !== 'application/ld+json').slice(0, 40).map((s) => s.textContent.slice(0, 20000));
    const jsonLd = scriptEls.filter((s) => s.getAttribute('type') === 'application/ld+json').slice(0, 40).map((s) => s.textContent.slice(0, 50000));
    const links = [...doc.querySelectorAll('link[rel]')].slice(0, 150).map((l) => ({ rel: l.getAttribute('rel') || '', href: abs(l.getAttribute('href')) }));
    const anchors = [...doc.querySelectorAll('a[href]')].slice(0, 600).map((a) => ({ text: (a.textContent || '').trim().slice(0, 80), href: a.getAttribute('href') || '' }));
    const comments = [];
    const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
    let n;
    while ((n = walker.nextNode()) && comments.length < 300) comments.push((n.nodeValue || '').slice(0, 500));
    const attrs = new Set();
    const all = doc.getElementsByTagName('*');
    const step = Math.max(1, Math.floor(all.length / 4000));
    for (let i = 0; i < all.length; i += step) for (const a of all[i].attributes) attrs.add(a.name);
    const title = (doc.title || '').trim().slice(0, 300);
    return {
      url: origin ? origin.href : '', hostname: origin ? origin.hostname.replace(/\.+$/, '').toLowerCase() : '',
      lang: (doc.documentElement && doc.documentElement.getAttribute('lang')) || '', title,
      metas, scripts, inlineScripts, jsonLd, links, anchors, comments, attrNames: [...attrs], bodyText: bodyText(doc),
    };
  }

  /* The body's text with a line break at every block, which is roughly what innerText gives
   * a rendered page; an element without layout answers innerText with its raw textContent,
   * scripts and styles included. */
  function bodyText(doc) {
    if (!doc.body) return '';
    let out = '';
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => (node.nodeType === 1 && node.matches(SKIP_SEL) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let node;
    while ((node = walker.nextNode()) && out.length < MAX_BODY_TEXT) {
      if (node.nodeType === 3) out += node.nodeValue;
      else if (BREAK_TAGS.has(node.tagName)) out += '\n';
    }
    // Runs of spaces become one, then the space either side of a line break and the empty
    // lines go: fixed-width patterns, so a page of nothing but blanks costs one pass.
    return out.replace(/[ \t\f\r]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').slice(0, MAX_BODY_TEXT);
  }

  /* An element's own text, leaving out the blocks inside it: content/content.js's ownText. */
  function ownText(doc, elm) {
    let out = '';
    const walker = doc.createTreeWalker(elm, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        if (node.nodeType === 1) {
          if (node !== elm && (node.matches(BLOCK_SEL) || node.matches(SKIP_SEL))) return NodeFilter.FILTER_REJECT;
          if (node.tagName === 'BR') out += '\n';
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let node;
    while ((node = walker.nextNode())) out += node.nodeValue;
    return out;
  }

  /* The content script's block analysis (analyzeTextBlocks), on the saved document. */
  function analyseBlocks(doc, snapshot, language) {
    const declared = snapshot.lang;
    const opts = { lang: declared, language, sensitivity: SENSITIVITY };
    const blocks = [];
    const nodes = doc.body ? doc.body.querySelectorAll(BLOCK_SEL) : [];
    for (const elm of nodes) {
      if (blocks.length >= 600) break;
      if (elm.closest(SKIP_SEL)) continue;
      const text = ownText(doc, elm);
      if (!text || text.trim().length < 2) continue;
      blocks.push({ el: elm, text });
    }
    const total = blocks.reduce((n, b) => n + b.text.length, 0);
    if (total < 600 && doc.body) {
      for (const elm of doc.body.querySelectorAll('div, span, section, article')) {
        if (blocks.length >= 600) break;
        if (elm.closest(SKIP_SEL)) continue;
        let direct = '';
        for (const c of elm.childNodes) if (c.nodeType === 3) direct += c.nodeValue;
        if (direct.trim().length < 120) continue;
        blocks.push({ el: elm, text: direct });
      }
    }
    return combineBlocks(blocks, opts, (b) => {
      const mainEl = doc.querySelector('main, article, [role="main"]');
      return !mainEl || mainEl.contains(b.el);
    });
  }

  function combineBlocks(blocks, opts, inMain) {
    const flagged = [];
    const verdicts = [];
    let words = 0;
    for (const b of blocks) {
      const r = S.textAnalyzer.analyzeText(b.text, { ...opts, mode: 'block' });
      words += r.words;
      if (r.verdict === 'no-signal') continue;
      verdicts.push(r.verdict);
      flagged.push({ verdict: r.verdict, score: r.score, words: r.words, excerpt: b.text.replace(/\s+/g, ' ').trim().slice(0, 160), signals: r.signals.slice(0, 6).map(({ id, kind, label, detail, weight }) => ({ id, kind, label, detail, weight })) });
    }
    const pageText = blocks.filter(inMain).map((b) => b.text.replace(/\s+/g, ' ').trim()).filter((t) => S.textAnalyzer.countWords(t) >= 8).join('\n\n');
    const page = S.textAnalyzer.analyzeText(pageText, { ...opts, mode: 'page' });
    verdicts.push(page.verdict);
    const aiVerdicts = verdicts.filter((v) => V.AI_TEXT_VERDICTS.has(v));
    const verdict = aiVerdicts.length ? V.worst('text', aiVerdicts) : verdicts.includes('human-disclosed') ? 'human-disclosed' : 'no-signal';
    return {
      verdict, score: page.score, words, blocks: blocks.length,
      flaggedBlocks: flagged.filter((f) => V.AI_TEXT_VERDICTS.has(f.verdict)).length,
      language: page.language,
      page: { verdict: page.verdict, score: page.score, words: page.words, signals: page.signals.slice(0, 8), stats: page.stylometry || null, hidden: page.hidden },
      flagged: flagged.slice(0, 30),
    };
  }

  /* The pictures a saved page names. Their bytes are not in the file, so each is judged by
   * what the page says about it — alt text, caption, title, its address and file name — as
   * the extension judges an image whose bytes it does not fetch. */
  function pageImages(doc, origin) {
    const base = origin ? origin.href : 'file:///';
    const counts = {};
    const items = [];
    const attributions = [];
    let total = 0;
    for (const img of [...doc.querySelectorAll('img')].slice(0, 200)) {
      const raw = img.getAttribute('src') || firstSrcset(img.getAttribute('srcset')) || '';
      if (!raw) continue;
      total++;
      const fig = img.closest('figure');
      const fc = fig && fig.querySelector('figcaption');
      const linkTitle = img.closest('a[title]');
      const item = {
        url: S.imageHints.resolveUrl(raw, base) || '', alt: img.getAttribute('alt') || '', title: img.getAttribute('title') || '', ariaLabel: img.getAttribute('aria-label') || '',
        caption: fc ? (fc.textContent || '').trim().slice(0, 300) : linkTitle ? (linkTitle.getAttribute('title') || '').slice(0, 200) : '',
      };
      const signals = S.imageHints.analyzeImageHints(item);
      const c = V.combineImageSignals(signals);
      counts[c.verdict] = (counts[c.verdict] || 0) + 1;
      const attribution = V.AI_IMAGE_VERDICTS.has(c.verdict) ? A.attributeImage(signals, null) : null;
      if (attribution) attributions.push(attribution);
      if (c.verdict !== 'no-signal' && items.length < 50) items.push({ src: raw.slice(0, 300), verdict: c.verdict, attribution, signals: signals.filter((s) => s.label) });
    }
    return { summary: { total, inspected: 0, proven: 0, pending: 0, counts, items }, attributions };
  }

  function firstSrcset(v) {
    const m = /^\s*(\S{1,2048})/.exec(v || '');
    return m ? m[1] : '';
  }

  /* Every AI system the evidence points to, with the layers it touched: the content
   * script's collectAiSystems. */
  function aiSystems(result, imageAttributions) {
    const map = new Map();
    const rank = { confirmed: 3, declared: 2, inferred: 1, unknown: 0 };
    const add = (attr, layer) => {
      if (!attr) return;
      const key = attr.id || 'unknown-' + layer;
      const cur = map.get(key) || { id: attr.id, name: attr.name, vendor: attr.vendor || null, country: attr.country || null, layers: [], confidence: attr.confidence, evidence: attr.evidence, marking: attr.marking || null, skews: attr.skews, count: 0 };
      if (!cur.layers.includes(layer)) cur.layers.push(layer);
      cur.count++;
      if (rank[attr.confidence] > rank[cur.confidence]) { cur.confidence = attr.confidence; cur.evidence = attr.evidence; cur.name = attr.name; }
      map.set(key, cur);
    };
    add(result.site && result.site.attribution, 'site');
    add(result.text && result.text.attribution, 'text');
    for (const a of imageAttributions) add(a, 'image');
    return [...map.values()];
  }

  /* ---- plain text ------------------------------------------------------------ */

  async function analyseTextFile(file) {
    const { text, truncated, read } = await readText(file, MAX_PAGE_BYTES);
    const body = text.slice(0, MAX_BODY_TEXT);
    const language = S.lexicons.detectLanguage(body, '');
    const blocks = paragraphs(body).slice(0, 600).filter((t) => t.trim().length >= 2).map((t) => ({ text: t }));
    const result = combineBlocks(blocks, { lang: '', language, sensitivity: SENSITIVITY }, () => true);
    const disclosures = S.signals.findDisclosures(body, { max: 25, lang: language.code });
    result.attribution = A.attributeText(result, { disclosures: disclosures.filter((d) => d.scope === 'text' || d.scope === 'general'), metaText: '' });
    const out = [];
    const head = el('div', 'file');
    const who = el('div');
    who.appendChild(el('div', 'name', file.name));
    who.appendChild(el('div', 'meta', 'Text · ' + sizeText(file.size) + (truncated || text.length > MAX_BODY_TEXT ? ' · the first ' + sizeText(Math.min(read, MAX_BODY_TEXT)) + ' were read' : '')));
    head.appendChild(who);
    out.push(head);
    const info = V.info('text', result.verdict);
    out.push(banner(info.color, info.icon, info.label, 'Hidden characters, chat leftovers and disclosures are hard evidence; wording and rhythm are a heuristic, capped below the strongest verdict.'));
    out.push(textPanel(result));
    const tools = aiSystems({ text: result }, []);
    if (tools.length) out.push(toolsPanel(tools));
    return out;
  }

  /* Paragraphs: runs of lines between blank ones, line by line rather than with a pattern. */
  function paragraphs(text) {
    const out = [];
    let cur = [];
    for (const line of text.split('\n')) {
      if (line.trim()) { cur.push(line); continue; }
      if (cur.length) { out.push(cur.join('\n')); cur = []; }
    }
    if (cur.length) out.push(cur.join('\n'));
    return out;
  }

  /* ---- rendering: the popup's panels, at page width ----------------------- */

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function tint(node, color) { node.style.setProperty('--c', color); node.style.setProperty('--cd', V.darken(color)); return node; }
  function section(title) { const s = el('section', 'panel'); s.appendChild(el('h2', null, title)); return s; }

  function banner(color, icon, label, hint) {
    const b = tint(el('div', 'overall'), color);
    b.setAttribute('role', 'status');
    b.appendChild(el('span', 'ic', icon || '○'));
    const body = el('div');
    body.appendChild(document.createTextNode(label));
    if (hint) body.appendChild(el('small', null, hint));
    b.appendChild(body);
    return b;
  }

  function trustHint(key) {
    switch (key) {
      case 'undisclosed-ai': return 'AI-generation markers were found but no disclosure statement. Verify the operator before relying on this content or doing business.';
      case 'disclosed-ai': return 'AI use is declared on the page or in its markup. Decide whether that is acceptable for your purpose.';
      case 'weak-ai': return 'Only heuristic or indirect signals. Treat as a prompt to look closer, not a verdict.';
      default: return 'No markers found. Many AI systems still emit nothing detectable, so this is not proof of human origin.';
    }
  }

  function sigRow(s) {
    const d = el('div', 'sig');
    const icon = s.kind === 'hard' || s.hard ? '◆' : s.kind === 'disclosure' ? '✎' : s.kind === 'info' || s.id === 'note' ? 'ℹ' : '?';
    d.appendChild(el('span', 'k', icon));
    const r = el('div');
    r.appendChild(el('div', 'l', s.label));
    if (s.detail) r.appendChild(el('div', 'd', s.detail));
    d.appendChild(r);
    return d;
  }

  function verdictLine(kind, verdict, score) {
    const info = V.info(kind, verdict);
    const wrap = el('div');
    const t = tint(el('div', 'tag'), info.color);
    t.appendChild(el('span', 'ic', info.icon));
    t.appendChild(document.createTextNode(info.label));
    wrap.appendChild(t);
    if (typeof score === 'number') {
      const bar = tint(el('div', 'bar'), info.color);
      const i = el('i');
      i.style.setProperty('--w', Math.round(Math.min(1, Math.max(0, score)) * 100) + '%');
      bar.appendChild(i);
      wrap.appendChild(bar);
    }
    return wrap;
  }

  function chip(color, icon, text) {
    const c = tint(el('span', 'chip'), color);
    if (icon) c.appendChild(el('span', 'ic', icon));
    c.appendChild(document.createTextNode(text));
    return c;
  }

  function skewList(attr, kind) {
    const prof = attr.id ? A.profile(attr.id) : null;
    const skews = A.skewsFor(prof ? { ...attr, skews: prof.skews } : attr, kind);
    if (!skews.length) return null;
    const own = skews.filter((k) => k.source !== 'generic');
    const det = el('details');
    det.appendChild(el('summary', null, 'Skews and tendencies (' + own.length + ' specific, ' + (skews.length - own.length) + ' general)'));
    for (const k of skews) {
      const li = el('div', 'skew');
      li.appendChild(el('b', null, k.area + (k.source === 'generic' ? ' · general' : '')));
      li.appendChild(el('div', null, k.note));
      if (k.basis) li.appendChild(el('div', 'basis', 'Basis: ' + k.basis));
      det.appendChild(li);
    }
    return det;
  }

  function attributionBox(attr, kind) {
    if (!attr) return null;
    const d = el('div', 'attr');
    const head = el('div');
    head.appendChild(el('b', null, 'Likely tool: ' + attr.name));
    head.appendChild(el('span', 'conf', ' · ' + (A.CONFIDENCE_LABEL[attr.confidence] || attr.confidence)));
    d.appendChild(head);
    if (attr.evidence) d.appendChild(el('div', 'd', attr.evidence));
    if (attr.detail) d.appendChild(el('div', 'd', attr.detail));
    const sk = skewList(attr, kind);
    if (sk) d.appendChild(sk);
    return d;
  }

  /* Content Credentials: what the manifest says, then what was verified. Three outcomes, kept
   * visually distinct because they mean different things (popup/popup.js, verificationRow). */
  function credentialsPanel(c2) {
    const panel = section('Content Credentials (C2PA)');
    const said = [c2.claimGenerator, (c2.actions || []).map((a) => a.action + (a.digitalSourceType ? ' (' + String(a.digitalSourceType).split('/').pop() + ')' : '')).join(', '), c2.signerNames && c2.signerNames.length ? 'signer ' + c2.signerNames.join(', ') : ''].filter(Boolean).join(' · ');
    if (said) panel.appendChild(el('p', 'note', 'The manifest says: ' + said));
    const v = c2.verification;
    const sum = (v && v.summary) || {};
    const state = !v ? { icon: '○', color: V.COLORS.mist, word: 'Signature not verified' }
      : sum.bindingMismatch ? { icon: '✗', color: V.COLORS.vermillion, word: 'Credentials describe a different file' }
        : sum.bindingAbsent && sum.broken ? { icon: '✗', color: V.COLORS.vermillion, word: 'Credentials bound to no file' }
          : sum.broken ? { icon: '✗', color: V.COLORS.vermillion, word: 'Credentials do not verify' }
            : sum.caution ? { icon: '!', color: V.COLORS.gold, word: sum.binding && sum.binding !== 'valid' ? 'Signed, not tied to this file' : 'Signed, assertions unreconciled' }
              : sum.ok && sum.anchored ? { icon: '✓', color: V.COLORS.green, word: 'Verified and bound to this file' }
                : sum.ok ? { icon: '!', color: V.COLORS.gold, word: 'Signed by an unvouched signer, bound to this file' }
                  : { icon: '○', color: V.COLORS.mist, word: 'Signature not verified' };
    const d = el('div', 'attr');
    const t = tint(el('div', 'tag'), state.color);
    t.appendChild(el('span', 'ic', state.icon));
    t.appendChild(document.createTextNode(state.word));
    d.appendChild(t);
    if (sum.text) d.appendChild(el('div', 'd', sum.text));
    if (v && v.signedBy && v.signedBy.subject) d.appendChild(el('div', 'd', 'Certificate subject: ' + v.signedBy.subject + (v.signedBy.issuer ? ', issued by ' + v.signedBy.issuer : '')));
    const det = el('details');
    det.appendChild(el('summary', null, 'What this does and does not prove'));
    const body = el('div', 'skew');
    body.appendChild(el('div', null, sum.ok && sum.anchored
      ? 'The manifest has not been altered since it was signed, the digest it records over the file matches this file\'s bytes, and the chain reaches a signer this build knows.'
      : sum.ok
        ? 'The manifest has not been altered since it was signed and the digest it records matches this file\'s bytes. But no certificate on its chain is a signer this build knows, so whatever name it carries vouches for nothing: anyone can mint a certificate in any name and sign their own claim with it.'
        : sum.broken
          ? 'Something verifiably does not add up: the signature, an assertion hash, the certificate chain, or the digest the claim records over the file. Treat the claims inside the manifest as unreliable.'
          : sum.caution
            ? 'The claim is authentic, but something could not be reconciled: either the assertions do not hash to the values it recorded, or the digest tying it to this file could not be recomputed here.'
            : 'No cryptographic check completed, so the manifest is read as an unverified claim: whatever it says about how the file was made is only what someone wrote in it.'));
    if (sum.bindingNote) body.appendChild(el('div', 'basis', sum.bindingNote));
    if (v && v.chain && v.chain.anchorNote) body.appendChild(el('div', 'basis', v.chain.anchorNote));
    if (v && v.notes && v.notes.length) body.appendChild(el('div', 'basis', v.notes.join(' ')));
    det.appendChild(body);
    d.appendChild(det);
    panel.appendChild(d);
    panel.appendChild(el('p', 'note', V.CREDENTIAL_CAVEAT));
    return panel;
  }

  function summaryPanel(r) {
    const panel = section('Summary');
    const row = (label, node, attr) => {
      const d = el('div', 'sig');
      d.appendChild(el('span', 'k', ''));
      const v = el('div');
      v.appendChild(el('div', 'l', label));
      v.appendChild(node);
      if (attr) v.appendChild(el('div', 'd', 'Likely ' + attr.name + ' · ' + (A.CONFIDENCE_LABEL[attr.confidence] || '')));
      d.appendChild(v);
      return d;
    };
    panel.appendChild(row('Site and code', verdictLine('site', r.site.verdict), r.site.attribution));
    panel.appendChild(row('Text', verdictLine('text', r.text.verdict), r.text.attribution));
    panel.appendChild(row('Pictures (by caption, alt text and file name)', verdictLine('image', imageWorst(r.images))));
    const discl = (r.disclosures || []).filter((x) => x.level !== 'weak');
    if (discl.length) {
      panel.appendChild(el('h3', null, 'Disclosures found on the page'));
      for (const x of discl.slice(0, 8)) {
        const it = el('div', 'item');
        it.appendChild(chip(x.level === 'human' ? V.COLORS.green : V.COLORS.orange, null, x.level + ' · ' + x.scope));
        it.appendChild(el('div', 'ex', '“…' + x.context + '…”'));
        panel.appendChild(it);
      }
    }
    return panel;
  }

  function imageWorst(images) {
    const c = images.counts || {};
    const verdicts = Object.keys(c).filter((k) => c[k] > 0);
    return V.worst('image', verdicts.length ? verdicts : ['no-signal']);
  }

  function sitePanel(site) {
    const panel = section('Site and code');
    panel.appendChild(verdictLine('site', site.verdict, site.score));
    const ab = attributionBox(site.attribution, 'site');
    if (ab) panel.appendChild(ab);
    if (site.generator) panel.appendChild(el('p', 'note', 'Generator meta: ' + site.generator));
    for (const s of site.signals || []) panel.appendChild(sigRow(s));
    if (!(site.signals || []).length) panel.appendChild(el('p', 'note', 'No generator fingerprints, disclosure meta tags, structured-data flags or AI code comments found.'));
    if (V.AI_SITE_VERDICTS.has(site.verdict) && !site.disclosed) panel.appendChild(el('p', 'note', 'No statement about AI involvement was found on the page.'));
    const notes = site.trustNotes || [];
    if (notes.length) {
      panel.appendChild(el('h3', null, 'Trust notes'));
      for (const n of notes) panel.appendChild(sigRow({ kind: 'info', label: n.label, detail: n.detail }));
      panel.appendChild(el('p', 'note', 'Template leftovers suggest an unfinished or auto-generated site. Not AI evidence by itself.'));
    }
    return panel;
  }

  function textPanel(text) {
    const panel = section('Text');
    panel.appendChild(verdictLine('text', text.verdict, text.score));
    const ab = attributionBox(text.attribution, 'text');
    if (ab) panel.appendChild(ab);
    if (text.language && text.language.lexicon) {
      panel.appendChild(el('p', 'note', 'Read with the ' + text.language.lexicon + ' lexicon (' + (text.language.source === 'declared' ? 'declared by the page' : text.language.source === 'detected' ? 'detected from the text' : 'default') + '). Non-English lexicons are smaller, so they report less rather than guessing.'));
    }
    panel.appendChild(el('p', 'note', (text.blocks || 0) + ' text blocks, ' + (text.words || 0) + ' words analysed; ' + (text.flaggedBlocks || 0) + ' flagged.'));
    if (text.page && text.page.signals && text.page.signals.length) {
      panel.appendChild(el('h3', null, 'Whole-text signals'));
      for (const s of text.page.signals) panel.appendChild(sigRow(s));
    }
    if (text.page && text.page.stats) {
      const st = text.page.stats;
      panel.appendChild(el('p', 'note', 'Stylometry: ' + st.sentences + ' sentences, sentence-length CV ' + (st.sentenceLengthCV == null ? 'n/a' : st.sentenceLengthCV) + ', lexicon ' + st.lexiconPointsPerK + ' pts/1k words, ' + st.contractions + ' contractions.'));
    }
    if (text.flagged && text.flagged.length) {
      panel.appendChild(el('h3', null, 'Flagged blocks'));
      for (const f of text.flagged.slice(0, 15)) {
        const info = V.info('text', f.verdict);
        const it = el('div', 'item');
        it.appendChild(chip(info.color, info.icon, info.short));
        it.appendChild(el('span', 'ex', ' “' + f.excerpt + '”'));
        for (const s of (f.signals || []).slice(0, 3)) it.appendChild(sigRow(s));
        panel.appendChild(it);
      }
    }
    return panel;
  }

  function imagesPanel(images) {
    const panel = section('Pictures');
    const sum = images.summary;
    const counts = sum.counts || {};
    panel.appendChild(verdictLine('image', imageWorst(sum)));
    const line = el('div');
    for (const k of ['ai-generated', 'ai-edited', 'ai-disclosed', 'suspected', 'self-claimed', 'no-signal']) {
      if (counts[k]) line.appendChild(chip(V.IMAGE[k].color, V.IMAGE[k].icon, counts[k] + ' ' + V.IMAGE[k].label));
    }
    panel.appendChild(line);
    panel.appendChild(el('p', 'note', sum.total + ' pictures named by the page. Their bytes are not in the saved file, so each is judged by its caption, alt text, title and file name; pick a picture\'s own file to read its embedded metadata and Content Credentials.'));
    for (const it of sum.items.slice(0, 25)) {
      const info = V.IMAGE[it.verdict] || V.IMAGE['no-signal'];
      const d = el('div', 'item');
      d.appendChild(chip(info.color, info.icon, info.short));
      d.appendChild(el('div', 'u', it.src));
      if (it.attribution) d.appendChild(el('div', 'd', 'Likely tool: ' + it.attribution.name + ' · ' + (A.CONFIDENCE_LABEL[it.attribution.confidence] || '')));
      for (const s of it.signals.slice(0, 5)) d.appendChild(sigRow(s));
      panel.appendChild(d);
    }
    return panel;
  }

  const STATUS = {
    present: { icon: '✓', color: V.COLORS.green },
    weak: { icon: '~', color: V.COLORS.gold },
    missing: { icon: '✗', color: V.COLORS.mist },
    concern: { icon: '!', color: V.COLORS.vermillion },
  };

  function traderPanel(t, haveAddress) {
    const panel = section('Who is behind the site');
    const headline = t.missingCritical.length
      ? (t.commerce ? 'A page that takes money should say who runs it. ' : '') + t.missingCritical.length + ' expected disclosure' + (t.missingCritical.length === 1 ? '' : 's') + ' not found on this page.'
      : 'The disclosures a reader would expect are present on this page.';
    const good = !t.missingCritical.length;
    const banner2 = el('div', 'attr');
    const bt = tint(el('div', 'tag'), good ? V.COLORS.green : V.COLORS.vermillion);
    bt.appendChild(el('span', 'ic', good ? '✓' : '!'));
    bt.appendChild(document.createTextNode(headline));
    banner2.appendChild(bt);
    banner2.appendChild(el('div', 'd', t.commerce ? 'This page looks like it sells something, so returns and terms are checked too.' : 'This page does not look like a shop, so only the basic disclosures are checked.'));
    panel.appendChild(banner2);
    for (const c of t.checks) {
      const st = Object.prototype.hasOwnProperty.call(STATUS, c.status) ? STATUS[c.status] : STATUS.missing;
      const d = el('div', 'check');
      d.appendChild(tint(el('span', 'k', st.icon), st.color));
      const v = el('div');
      v.appendChild(el('div', 'l', c.label));
      if (c.detail) v.appendChild(el('div', 'd', c.detail));
      else if (c.status === 'missing') v.appendChild(el('div', 'd', 'Not found on this page. It may live on another page of the site.'));
      d.appendChild(v);
      panel.appendChild(d);
    }
    if (!haveAddress) panel.appendChild(el('p', 'note', 'Whether the page was served over HTTPS is not checked: the file does not say which address it came from.'));
    if (t.pressure.length) {
      panel.appendChild(el('h3', null, 'Pressure and urgency patterns'));
      for (const x of t.pressure) {
        const it = el('div', 'item');
        it.appendChild(chip(V.COLORS.orange, null, x.label));
        it.appendChild(el('div', 'ex', '“…' + x.detail + '…”'));
        it.appendChild(el('div', 'd', x.note));
        panel.appendChild(it);
      }
    }
    panel.appendChild(el('p', 'note', t.note + ' Findings describe this page only, not the business behind it.'));
    return panel;
  }

  function toolsPanel(systems) {
    const panel = section('AI tools named by the evidence');
    const rank = (c) => ({ confirmed: 3, declared: 2, inferred: 1, unknown: 0 })[c] || 0;
    const list = (systems || []).slice().sort((a, b) => rank(b.confidence) - rank(a.confidence));
    if (!list.length) {
      panel.appendChild(el('p', 'note', 'No AI tool could be identified. That means the evidence named no product, not that none was used.'));
      return panel;
    }
    for (const sys of list) {
      const it = el('div', 'item');
      const head = el('div');
      head.appendChild(el('b', null, sys.name));
      head.appendChild(el('span', 'conf', ' · ' + sys.layers.join(', ') + ' · ' + (A.CONFIDENCE_LABEL[sys.confidence] || sys.confidence)));
      it.appendChild(head);
      if (sys.vendor) it.appendChild(el('div', 'd', sys.vendor + (sys.country ? ', ' + sys.country : '')));
      if (sys.evidence) it.appendChild(el('div', 'd', 'Evidence: ' + sys.evidence));
      if (sys.marking) it.appendChild(el('div', 'd', 'Marking: ' + sys.marking));
      const kind = sys.layers.includes('image') && !sys.layers.includes('text') ? 'image' : sys.layers.includes('site') && sys.layers.length === 1 ? 'site' : 'text';
      const sk = skewList(sys, kind);
      if (sk) it.appendChild(sk);
      panel.appendChild(it);
    }
    panel.appendChild(el('p', 'note', 'Skew notes summarise public reports and vendor statements reviewed ' + A.REVIEWED + '. They describe typical default behaviour of the tool, not this specific content, and models change between versions.'));
    return panel;
  }

  function sizeText(n) {
    if (n < 1024) return n + ' bytes';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1) + ' MB';
  }

  document.documentElement.classList.add('started');
})();
