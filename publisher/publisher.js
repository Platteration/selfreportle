/*
 * publisher/publisher.js — the same analysis, pointed at your own site.
 *
 * Two jobs: say what a reader's tool can and cannot see on this page, and
 * hand over paste-ready markup to fix the gaps. Legal duty and good practice
 * are labelled separately, because conflating them would be misleading.
 */
(async function () {
  'use strict';
  const S = globalThis.SRL;
  const V = S.verdicts;
  const A = S.attribution;
  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(location.search);
  const tabId = parseInt(params.get('tabId'), 10);
  let result = null;

  $('recheck').addEventListener('click', () => load(true));
  $('copyall').addEventListener('click', async (e) => {
    const all = [...document.querySelectorAll('.snippet pre')].map((p) => p.textContent).join('\n\n');
    if (!all) return;
    try { await navigator.clipboard.writeText(all); flash(e.target, 'Copied'); } catch (err) { flash(e.target, 'Failed'); }
  });

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function tint(n, c) { n.style.setProperty('--c', c); return n; }
  function flash(b, msg) { const old = b.textContent; b.textContent = msg; setTimeout(() => { b.textContent = old; }, 1500); }

  const MARKS = {
    pass: { icon: '✓', color: 'var(--pass)' },
    warn: { icon: '!', color: 'var(--warn)' },
    fail: { icon: '✗', color: 'var(--fail)' },
    info: { icon: 'ℹ', color: 'var(--info)' },
  };

  const DUTY = {
    duty: 'legal duty (Art. 50)',
    practice: 'good practice',
    trader: 'trader identification',
  };

  async function load(force) {
    if (!Number.isFinite(tabId)) return;
    if (force) {
      try { await chrome.tabs.sendMessage(tabId, { type: 'srl:rescan' }); } catch (e) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 1500));
    }
    try { result = await chrome.runtime.sendMessage({ type: 'srl:get-result', tabId }); } catch (e) { result = null; }
    render();
  }

  function render() {
    const main = $('main');
    main.innerHTML = '';
    if (!result) {
      main.appendChild(el('p', 'empty', 'No analysis is available for that tab. Open the page, let it finish loading, then press Re-check.'));
      return;
    }
    $('url').textContent = result.url;
    document.title = 'Self-check — ' + result.hostname;

    const checks = buildChecks(result);
    main.appendChild(headline(checks));

    const groups = [['What a reader’s tool can see', 'visibility'], ['Who you are', 'identity'], ['Media provenance', 'media']];
    for (const [title, group] of groups) {
      const rows = checks.filter((c) => c.group === group);
      if (!rows.length) continue;
      main.appendChild(el('h2', null, title));
      for (const c of rows) main.appendChild(checkRow(c));
    }

    main.appendChild(el('h2', null, 'Paste-ready markup'));
    main.appendChild(el('p', 'note', 'These are conventions, not adopted standards, for everything except Content Credentials. They exist so that tools which do look can find something. Adjust the wording to what is actually true of your page: a false disclosure is worse than none.'));
    for (const sn of snippets(result, checks)) main.appendChild(snippetBlock(sn));

    const broken = brokenCredentials(result);
    if (broken.length) {
      main.appendChild(el('h2', null, 'Credentials that need attention'));
      main.appendChild(el('p', 'note', 'These files carry a C2PA manifest that did not come back clean. An unsigned manifest is a claim with nothing behind it; a manifest that fails to verify usually means the file was re-encoded or optimised after signing. Sign after your build pipeline, not before.'));
      for (const b of broken) {
        const d = el('div', 'item');
        d.appendChild(el('b', null, b.state));
        d.appendChild(el('div', 'u', b.url));
        if (b.detail) d.appendChild(el('div', 'd', b.detail));
        main.appendChild(d);
      }
    }
  }

  /* ---- checks ---- */

  function buildChecks(r) {
    const out = [];
    const site = r.site || {};
    const text = r.text || {};
    const images = r.images || {};
    const counts = images.counts || {};
    const trader = r.trader || { checks: [], missingCritical: [] };
    const disclosures = (r.disclosures || []).filter((d) => d.level === 'generated' || d.level === 'assisted');

    const aiText = ['ai', 'likely-ai', 'ai-disclosed', 'ai-assisted-disclosed'].includes(text.verdict);
    const aiImages = (counts['ai-generated'] || 0) + (counts['ai-edited'] || 0);
    const aiSite = V.AI_SITE_VERDICTS.has(site.verdict);
    const machineReadable = (site.signals || []).some((s) => s.id === 'meta-ai' || s.id === 'jsonld-dst' || s.id === 'jsonld-flag' || s.id === 'attr-ai');

    out.push({
      group: 'visibility', duty: 'practice',
      status: machineReadable ? 'pass' : (aiText || aiImages || aiSite ? 'warn' : 'info'),
      title: 'Machine-readable AI declaration on the page',
      detail: machineReadable
        ? 'A meta tag or structured-data field on this page declares AI involvement, so a tool can read it without guessing.'
        : (aiText || aiImages || aiSite)
          ? 'This page shows AI indicators but carries no machine-readable declaration. A reader’s tool has to infer, and inference is where false positives come from.'
          : 'No AI indicators were found, so nothing needs declaring. If you do use AI here, declaring it costs one tag.',
    });

    out.push({
      group: 'visibility', duty: aiText ? 'duty' : 'practice',
      status: disclosures.length ? 'pass' : (aiText || aiImages ? 'warn' : 'info'),
      title: 'Visible disclosure a person can read',
      detail: disclosures.length
        ? 'A disclosure statement was found in the page text: “' + disclosures[0].context.slice(0, 120) + '”.'
        : (aiText || aiImages)
          ? 'AI indicators were found but no sentence on the page tells a reader so. If this page informs the public on a matter of public interest and no human holds editorial responsibility for it, Article 50(4) requires the disclosure.'
          : 'Nothing on this page appears to need a disclosure.',
    });

    out.push({
      group: 'visibility', duty: 'practice',
      status: aiText && text.verdict !== 'ai-disclosed' && text.verdict !== 'ai-assisted-disclosed' ? 'warn' : 'pass',
      title: 'Text does not carry accidental machine tells',
      detail: describeTextTells(text),
    });

    for (const id of ['imprint', 'privacy', 'contact', 'terms', 'returns']) {
      const c = (trader.checks || []).find((x) => x.id === id);
      if (!c) continue;
      const critical = trader.missingCritical.includes(id);
      out.push({
        group: 'identity', duty: 'trader',
        status: c.status === 'present' ? 'pass' : c.status === 'weak' ? 'warn' : critical ? 'fail' : 'warn',
        title: c.label,
        detail: c.status === 'present' ? (c.detail || 'Found on this page.')
          : c.status === 'weak' ? 'Mentioned in the text but not linked, so a reader (or a crawler) may not find it.'
            : 'Not found on this page. If it lives elsewhere on the site, link to it from every page, which is what the e-Commerce Directive’s imprint rules effectively require.',
      });
    }

    const identifiers = (trader.identifiers || {});
    const hasId = (identifiers.vat || []).length || (identifiers.registration || []).length;
    out.push({
      group: 'identity', duty: 'trader',
      status: hasId ? 'pass' : trader.commerce ? 'fail' : 'warn',
      title: 'Company or VAT identifier',
      detail: hasId
        ? 'Found: ' + [...(identifiers.vat || []).map((v) => v.value), ...(identifiers.registration || []).map((x) => x.label + ' ' + x.value)].join(', ') + '. Checked for format only.'
        : trader.commerce
          ? 'This page looks like it sells something but names no company or VAT identifier. That is the single strongest signal a reader has that a shop is real.'
          : 'No identifier found. Not required of every page, but it is what tells a visitor you are a real business.',
    });

    const withCreds = (images.items || []).filter((i) => i.metadata && i.metadata.c2pa).length;
    out.push({
      group: 'media', duty: 'practice',
      status: withCreds ? 'pass' : images.inspected ? 'info' : 'info',
      title: 'Content Credentials on images and media',
      detail: withCreds
        ? withCreds + ' of the ' + (images.inspected || 0) + ' files inspected carry a C2PA manifest.'
        : 'None of the ' + (images.inspected || 0) + ' files inspected carry C2PA Content Credentials. This is the one adopted standard here, and it survives if your pipeline does not re-encode after signing.',
    });

    if (aiImages) {
      const disclosedImages = disclosures.some((d) => d.scope === 'image' || d.scope === 'general') || (counts['ai-disclosed'] || 0) > 0;
      out.push({
        group: 'media', duty: 'duty',
        status: disclosedImages ? 'pass' : 'warn',
        title: 'AI-generated media is disclosed',
        detail: aiImages + ' file(s) carry generative-AI provenance. Where such media appreciably resembles real people, places or events, Article 50(4) requires a deployer to disclose it.',
      });
    }

    out.push({
      group: 'media', duty: 'practice',
      status: (counts.unavailable || 0) > 0 ? 'warn' : 'pass',
      title: 'Media is reachable for inspection',
      detail: (counts.unavailable || 0) > 0
        ? (counts.unavailable) + ' file(s) could not be fetched for inspection. Hotlink protection or a strict CORS policy hides your provenance from readers’ tools as effectively as stripping it.'
        : 'Everything on the page could be fetched and inspected.',
    });

    return out;
  }

  function describeTextTells(text) {
    const tells = [];
    for (const f of text.flagged || []) {
      for (const s of f.signals || []) {
        if (['unicode-tags', 'zw-stego', 'zw-density', 'variation-selector-run', 'self-reference', 'markdown-leak'].includes(s.id) && !tells.includes(s.label)) tells.push(s.label);
      }
    }
    if (tells.length) return 'Found on this page: ' + tells.join('; ') + '. These are artefacts of pasting from a chat window. They do not belong in published copy and a reader’s tool will flag them.';
    if (text.verdict === 'likely-ai' || text.verdict === 'ai') return 'No pasted-in artefacts, but the prose scores high on machine-typical wording. That is a heuristic, not proof, and it is what a reader’s tool will show them.';
    return 'No hidden characters, chat-transcript leftovers or markdown residue were found in the visible text.';
  }

  function headline(checks) {
    const fails = checks.filter((c) => c.status === 'fail').length;
    const warns = checks.filter((c) => c.status === 'warn').length;
    const state = fails ? { c: 'var(--fail)', t: fails + ' thing' + (fails === 1 ? '' : 's') + ' a visitor cannot find out about you' }
      : warns ? { c: 'var(--warn)', t: warns + ' gap' + (warns === 1 ? '' : 's') + ' worth closing' }
        : { c: 'var(--pass)', t: 'Nothing missing that this tool can see' };
    const d = tint(el('div', 'headline'), state.c);
    d.appendChild(el('b', null, state.t));
    d.appendChild(el('span', null, 'This is what a reader running this extension sees on your page. It is a readability check, not a compliance certificate, and it cannot see the rest of your site.'));
    return d;
  }

  function checkRow(c) {
    const m = MARKS[c.status] || MARKS.info;
    const d = tint(el('div', 'check'), m.color);
    d.appendChild(el('span', 'mark', m.icon));
    const v = el('div');
    const t = el('div', 't');
    t.appendChild(document.createTextNode(c.title));
    t.appendChild(el('span', 'duty', DUTY[c.duty] || c.duty));
    v.appendChild(t);
    v.appendChild(el('div', 'd', c.detail));
    d.appendChild(v);
    return d;
  }

  /* ---- snippets ---- */

  function snippets(r, checks) {
    const out = [];
    const site = r.site || {};
    const text = r.text || {};
    const counts = (r.images || {}).counts || {};
    const aiImages = (counts['ai-generated'] || 0) + (counts['ai-edited'] || 0);
    const aiText = ['ai', 'likely-ai', 'ai-disclosed', 'ai-assisted-disclosed'].includes(text.verdict);
    const tool = (site.attribution && site.attribution.name) || (text.attribution && text.attribution.name) || 'the tool you used';
    const shortTool = tool.replace(/\s*\(.*$/, '');

    out.push({
      title: 'Declare AI involvement in the page head',
      why: 'Read by this extension and by other checkers that look for a declaration. Set the value to what is true: full, partial or none.',
      code: [
        '<!-- Convention, not an adopted standard. Values: none | assisted | generated -->',
        '<meta name="ai-generated" content="' + (aiText || aiImages ? (text.verdict === 'ai-assisted-disclosed' ? 'assisted' : 'generated') : 'none') + '">',
        '<meta name="ai-disclosure" content="' + (aiText || aiImages ? 'Parts of this page were produced with ' + shortTool + ' and reviewed by a person before publication.' : 'No generative AI was used to produce this page.') + '">',
      ].join('\n'),
    });

    out.push({
      title: 'Structured data with the IPTC digital source type',
      why: 'The IPTC vocabulary is the same one C2PA and XMP use, so a single value means the same thing across images, metadata and structured data. Drop the digitalSourceType line if nothing on the page is AI-made.',
      code: JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: r.title || 'Your headline',
        datePublished: new Date().toISOString().slice(0, 10),
        author: { '@type': 'Person', name: 'Author name' },
        publisher: { '@type': 'Organization', name: 'Your organisation' },
        creditText: aiText || aiImages ? 'Produced with ' + shortTool + ', reviewed by Author name' : 'Written by Author name',
        digitalSourceType: aiText || aiImages
          ? 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia'
          : 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation',
      }, null, 2).replace(/^/gm, '  ').replace(/^ {2}/, ''),
      wrap: '<script type="application/ld+json">\n%s\n</script>',
    });

    out.push({
      title: 'A visible line a person can read',
      why: 'Article 50(4) asks for disclosure that is clear and distinguishable, given at the latest at first exposure. A footnote below the fold is not that; a line near the content is.',
      code: [
        '<p class="ai-disclosure">',
        aiText || aiImages
          ? '  Parts of this page were produced with ' + shortTool + '. A member of our team reviewed and edited the result before publication and takes editorial responsibility for it.'
          : '  This page was written and produced by people. No generative AI was used.',
        '</p>',
      ].join('\n'),
    });

    if (aiImages || (r.images || {}).inspected) {
      out.push({
        title: 'Mark individual images in the page',
        why: 'Per-image marking is what lets a reader tell the AI illustration from the photograph of your premises. This attribute is a convention; Content Credentials on the file itself is the standard, and stronger.',
        code: [
          '<figure>',
          '  <img src="illustration.png" alt="…" data-ai-generated="true">',
          '  <figcaption>Illustration generated with ' + shortTool + '</figcaption>',
          '</figure>',
        ].join('\n'),
      });
    }

    out.push({
      title: 'Keep Content Credentials alive through your build',
      why: 'The commonest way provenance disappears is not stripping, it is re-encoding. Anything that rewrites the file after signing invalidates the manifest.',
      code: [
        '# Sign after every transform, never before.',
        '#   1. resize, compress, convert format',
        '#   2. THEN attach Content Credentials',
        '#   3. serve the signed file unchanged',
        '#',
        '# Common breakers: image CDNs with on-the-fly resizing, WordPress',
        '# thumbnail generation, imagemin/sharp in a bundler, "optimise images"',
        '# toggles in a host control panel.',
        '#',
        '# Also check the served file, not the source file:',
        'curl -s https://' + (r.hostname || 'example.com') + '/path/to/image.jpg | head -c 400 | strings | grep -i -m3 "c2pa\\|jumb"',
      ].join('\n'),
    });

    const missing = (r.trader && r.trader.missingCritical) || [];
    if (missing.length) {
      out.push({
        title: 'Link the disclosures a visitor expects to find',
        why: 'Missing from this page: ' + missing.join(', ') + '. The e-Commerce Directive imprint rules effectively require these to be reachable from anywhere on the site, which in practice means the footer.',
        code: [
          '<footer>',
          '  <nav aria-label="Legal">',
          '    <a href="/imprint">Legal notice</a>',
          '    <a href="/privacy">Privacy policy</a>',
          '    <a href="/terms">Terms and conditions</a>',
          '    <a href="/returns">Returns and right of withdrawal</a>',
          '    <a href="/contact">Contact</a>',
          '  </nav>',
          '  <p>Your Company Ltd · Street 1, 12345 City, Country · VAT: XX123456789 · Registered no. 12345678</p>',
          '</footer>',
        ].join('\n'),
      });
    }
    return out;
  }

  function snippetBlock(sn) {
    const code = sn.wrap ? sn.wrap.replace('%s', sn.code) : sn.code;
    const d = el('div', 'snippet');
    const hd = el('div', 'hd');
    hd.appendChild(el('b', null, sn.title));
    const btn = el('button', null, 'Copy');
    btn.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(code); flash(btn, 'Copied'); } catch (e) { flash(btn, 'Failed'); }
    });
    hd.appendChild(btn);
    d.appendChild(hd);
    d.appendChild(el('div', 'why', sn.why));
    d.appendChild(el('pre', null, code));
    return d;
  }

  function brokenCredentials(r) {
    const out = [];
    for (const it of (r.images || {}).items || []) {
      const v = it.metadata && it.metadata.c2pa && it.metadata.c2pa.verification;
      if (!v || !v.summary) continue;
      if (v.summary.ok) continue;
      const state = v.signature === 'absent' ? 'No signature in the manifest'
        : v.summary.bindingMismatch ? 'Signed, but the credentials describe different bytes'
          : v.summary.bindingAbsent && v.summary.broken ? 'Signed, but bound to no file'
            : v.summary.broken ? 'Does not verify'
              : v.summary.caution ? 'Signed, but could not be fully reconciled'
                : 'Signature could not be checked';
      const advice = v.signature === 'absent'
        ? 'A manifest without a signature carries no guarantee at all. Sign it, or readers have only your word for it.'
        : v.summary.bindingMismatch
          ? 'The file was changed after it was signed — almost always a re-encode, a resize or a metadata rewrite in the build. Attach credentials as the last step, after every transformation.'
          : v.summary.bindingAbsent
            ? 'The claim carries no hard binding, so it does not name any particular file. Whatever wrote it is not producing conformant credentials.'
            : v.summary.broken
              ? 'Something verifiably does not add up. Check whether the file is re-encoded after signing.'
              : '';
      out.push({ url: it.url, state, detail: [v.summary.text, advice].filter(Boolean).join(' ') });
    }
    return out;
  }

  await load(false);
})();
