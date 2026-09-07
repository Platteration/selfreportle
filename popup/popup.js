(async function () {
  'use strict';
  const S = globalThis.SRL;
  const V = S.verdicts;
  const A = S.attribution;
  const $ = (id) => document.getElementById(id);

  const debugTabId = parseInt(new URLSearchParams(location.search).get('tabId'), 10);
  const tab = Number.isFinite(debugTabId) ? await chrome.tabs.get(debugTabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) return;
  $('url').textContent = (tab.url || '').replace(/^https?:\/\//, '');
  $('url').title = tab.url || '';

  let current = null;
  let active = 'overview';

  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('rescan').addEventListener('click', async () => {
    $('rescan').disabled = true;
    try { await chrome.tabs.sendMessage(tab.id, { type: 'srl:rescan' }); } catch (e) { /* no content script */ }
    setTimeout(load, 600);
    setTimeout(load, 3000);
    setTimeout(() => { $('rescan').disabled = false; }, 700);
  });
  $('toggle').addEventListener('click', async () => {
    try { await chrome.tabs.sendMessage(tab.id, { type: 'srl:toggle-overlay' }); } catch (e) { /* ignore */ }
  });
  $('tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) select(b.dataset.tab);
  });

  function select(name) {
    active = name;
    for (const b of $('tabs').querySelectorAll('button[data-tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const sec of $('main').querySelectorAll('section')) sec.hidden = sec.dataset.tab !== name;
    $('main').scrollTop = 0;
  }

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function tint(node, color) { node.style.setProperty('--c', color); return node; }

  /* ---------------- render ---------------- */

  function render(r) {
    const main = $('main');
    main.innerHTML = '';
    const ov = $('overall');
    if (!r) {
      ov.textContent = '';
      $('tabs').hidden = true;
      main.appendChild(el('div', 'empty', 'Nothing analysed yet for this tab. Reload the page or press Rescan. Browser-internal pages and the Web Store cannot be inspected.'));
      return;
    }
    $('tabs').hidden = false;
    const key = r.overall || V.overall(r);
    const overall = V.OVERALL[key] || V.OVERALL.none;
    ov.innerHTML = '';
    tint(ov, overall.color);
    ov.appendChild(el('span', 'ic', overall.icon || '○'));
    const body = el('div');
    body.appendChild(document.createTextNode(overall.label));
    body.appendChild(el('small', null, trustHint(key)));
    ov.appendChild(body);

    main.appendChild(section('overview', overviewPanel(r)));
    main.appendChild(section('site', sitePanel(r.site || {})));
    main.appendChild(section('text', textPanel(r.text || {})));
    main.appendChild(section('images', imagesPanel(r.images || {})));
    main.appendChild(section('trader', traderPanel(r.trader || null, r)));
    main.appendChild(section('tools', toolsPanel(r)));
    counts(r);
    select(active);
  }

  function section(name, nodes) {
    const s = el('section');
    s.dataset.tab = name;
    s.hidden = true;
    for (const n of [].concat(nodes)) if (n) s.appendChild(n);
    return s;
  }

  function counts(r) {
    const c = (r.images && r.images.counts) || {};
    const flaggedImages = (c['ai-generated'] || 0) + (c['ai-edited'] || 0) + (c['ai-disclosed'] || 0) + (c.suspected || 0);
    const set = (name, n, color) => {
      const b = $('tabs').querySelector('button[data-tab="' + name + '"]');
      const old = b.querySelector('.n');
      if (old) old.remove();
      if (!n) return;
      const s = el('span', 'n', String(n));
      tint(s, color);
      b.appendChild(s);
    };
    set('site', V.AI_SITE_VERDICTS.has(r.site && r.site.verdict) ? 1 : 0, V.info('site', r.site && r.site.verdict).color);
    set('text', (r.text && r.text.flaggedBlocks) || 0, V.info('text', r.text && r.text.verdict).color);
    set('images', flaggedImages, V.COLORS.vermillion);
    set('tools', (r.aiSystems || []).length, V.COLORS.orange);
    const t = r.trader;
    set('trader', t ? t.missingCritical.length + t.pressure.length : 0, t && t.missingCritical.length ? V.COLORS.vermillion : V.COLORS.gold);
  }

  function trustHint(key) {
    switch (key) {
      case 'undisclosed-ai': return 'AI-generation markers were found but no disclosure statement. Verify the operator before relying on this content or doing business.';
      case 'disclosed-ai': return 'AI use is declared on the page or in metadata. Decide whether that is acceptable for your purpose.';
      case 'weak-ai': return 'Only heuristic or indirect signals. Treat as a prompt to look closer, not a verdict.';
      case 'provenance': return 'Some content carries capture or human-creation credentials. Credentials were parsed, not cryptographically verified.';
      default: return 'No markers found. Many AI systems still emit nothing detectable, so this is not proof of human origin.';
    }
  }

  /* ---------------- shared pieces ---------------- */

  function sigRow(s) {
    const d = el('div', 'sig');
    const icon = s.kind === 'hard' || s.hard ? '◆' : s.kind === 'disclosure' ? '✎' : s.kind === 'info' ? 'ℹ' : '?';
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
      i.style.width = Math.round(Math.min(1, score) * 100) + '%';
      bar.appendChild(i);
      wrap.appendChild(bar);
    }
    return wrap;
  }

  function skewList(attr, kind, openByDefault) {
    const prof = attr.id ? A.profile(attr.id) : null;
    const skews = A.skewsFor(prof ? { ...attr, skews: prof.skews } : attr, kind);
    if (!skews.length) return null;
    const own = skews.filter((k) => k.source !== 'generic');
    const det = el('details');
    det.open = !!openByDefault;
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
    const sk = skewList(attr, kind, false);
    if (sk) d.appendChild(sk);
    return d;
  }

  /* ---------------- panels ---------------- */

  function overviewPanel(r) {
    const out = [];
    const sum = el('div');
    sum.appendChild(el('h3', null, 'Summary'));
    sum.appendChild(sumRow('Site', verdictLine('site', (r.site || {}).verdict), (r.site || {}).attribution));
    sum.appendChild(sumRow('Text', verdictLine('text', (r.text || {}).verdict), (r.text || {}).attribution));
    const c = (r.images || {}).counts || {};
    const worst = V.worst('image', Object.keys(c).filter((k) => c[k] > 0));
    const imgLine = el('div');
    imgLine.appendChild(verdictLine('image', worst));
    const chips = el('div');
    for (const k of ['ai-generated', 'ai-edited', 'ai-disclosed', 'suspected', 'captured', 'human-created', 'algorithmic', 'no-signal']) {
      if (!c[k]) continue;
      const chip = tint(el('span', 'chip'), V.IMAGE[k].color);
      chip.appendChild(el('span', 'ic', V.IMAGE[k].icon));
      chip.appendChild(document.createTextNode(c[k] + ' ' + V.IMAGE[k].short));
      chips.appendChild(chip);
    }
    imgLine.appendChild(chips);
    sum.appendChild(sumRow('Images', imgLine));
    out.push(sum);

    const discl = (r.disclosures || []).filter((d) => d.level !== 'weak');
    if (discl.length) {
      const d = el('div');
      d.appendChild(el('h3', null, 'Disclosures found on the page'));
      for (const x of discl.slice(0, 8)) {
        const it = el('div', 'item');
        it.appendChild(tint(el('span', 'chip', x.level + ' · ' + x.scope), x.level === 'human' ? V.COLORS.green : V.COLORS.orange));
        it.appendChild(el('div', 'ex', '“…' + x.context + '…”'));
        d.appendChild(it);
      }
      out.push(d);
    }

    const notes = (r.site && r.site.trustNotes) || [];
    if (notes.length) {
      const d = el('div');
      d.appendChild(el('h3', null, 'Trust notes'));
      for (const n of notes) d.appendChild(sigRow({ kind: 'info', label: n.label, detail: n.detail }));
      d.appendChild(el('div', 'note', 'Template leftovers suggest an unfinished or auto-generated site. Not AI evidence by itself.'));
      out.push(d);
    }

    const mem = el('div');
    mem.id = 'memory';
    out.push(mem);
    loadMemory(r, mem);

    out.push(exportBlock(r));
    return out;
  }

  /* Local-only per-domain counters. One page says little; a pattern says more. */
  async function loadMemory(r, host) {
    let res = null;
    try { res = await chrome.runtime.sendMessage({ type: 'srl:get-history', host: r.hostname }); } catch (e) { return; }
    const sum = res && res.summary;
    if (!sum) return;
    host.appendChild(el('h3', null, 'This domain, on this device'));
    const tone = sum.tone === 'high' ? V.COLORS.vermillion : sum.tone === 'some' ? V.COLORS.gold : V.COLORS.green;
    const line = el('div', 'attr');
    const t = tint(el('div', 'tag'), tone);
    t.appendChild(el('span', 'ic', sum.tone === 'none' ? '○' : sum.tone === 'high' ? '◆' : '?'));
    t.appendChild(document.createTextNode(sum.text));
    line.appendChild(t);
    if (sum.tools.length) {
      const names = sum.tools.map((id) => { const p = A.profile(id); return p ? p.name.replace(/\s*\(.*$/, '') : id; });
      line.appendChild(el('div', 'd', 'Tools seen here: ' + names.join(', ')));
    }
    line.appendChild(el('div', 'd', 'Counters only, kept on this device. Clear or switch off in settings.'));
    host.appendChild(line);
  }

  function sumRow(label, node, attr) {
    const d = el('div', 'sum');
    d.appendChild(el('div', 'k', label));
    const v = el('div');
    v.appendChild(node);
    if (attr) v.appendChild(el('div', 'd', 'Likely ' + attr.name + ' · ' + (A.CONFIDENCE_LABEL[attr.confidence] || '')));
    d.appendChild(v);
    return d;
  }

  function sitePanel(site) {
    const out = [];
    out.push(verdictLine('site', site.verdict, site.score));
    const ab = attributionBox(site.attribution, 'site');
    if (ab) out.push(ab);
    if (site.generator) out.push(el('div', 'note', 'Generator meta: ' + site.generator));
    const sigs = el('div');
    for (const s of site.signals || []) sigs.appendChild(sigRow(s));
    if (!(site.signals || []).length) sigs.appendChild(el('div', 'note', 'No generator fingerprints, disclosure meta tags, structured-data flags or AI code comments found.'));
    out.push(sigs);
    if (V.AI_SITE_VERDICTS.has(site.verdict) && !site.disclosed) out.push(el('div', 'note', 'No statement about AI involvement was found on the page.'));
    return out;
  }

  function textPanel(text) {
    const out = [];
    out.push(verdictLine('text', text.verdict, text.score));
    const ab = attributionBox(text.attribution, 'text');
    if (ab) out.push(ab);
    if (text.language && text.language.lexicon) {
      out.push(el('div', 'note', 'Read with the ' + text.language.lexicon + ' lexicon (' + (text.language.source === 'declared' ? 'declared by the page' : text.language.source === 'detected' ? 'detected from the text' : 'default') + '). Non-English lexicons are smaller, so they report less rather than guessing.'));
    }
    out.push(el('div', 'note', (text.blocks || 0) + ' text blocks, ' + (text.words || 0) + ' words analysed; ' + (text.flaggedBlocks || 0) + ' flagged.'));
    if (text.page && text.page.signals && text.page.signals.length) {
      const d = el('div');
      d.appendChild(el('h3', null, 'Whole-page signals'));
      for (const s of text.page.signals) d.appendChild(sigRow(s));
      out.push(d);
    }
    if (text.page && text.page.stats) {
      const st = text.page.stats;
      out.push(el('div', 'note', 'Stylometry: ' + st.sentences + ' sentences, sentence-length CV ' + (st.sentenceLengthCV == null ? 'n/a' : st.sentenceLengthCV) + ', lexicon ' + st.lexiconPointsPerK + ' pts/1k words, ' + st.contractions + ' contractions.'));
    }
    if (text.flagged && text.flagged.length) {
      const d = el('div');
      d.appendChild(el('h3', null, 'Flagged blocks'));
      for (const f of text.flagged.slice(0, 15)) {
        const info = V.info('text', f.verdict);
        const it = el('div', 'item');
        const chip = tint(el('span', 'chip'), info.color);
        chip.appendChild(el('span', 'ic', info.icon));
        chip.appendChild(document.createTextNode(info.short));
        it.appendChild(chip);
        it.appendChild(el('span', 'ex', ' “' + f.excerpt + '”'));
        for (const s of (f.signals || []).slice(0, 3)) it.appendChild(sigRow(s));
        d.appendChild(it);
      }
      out.push(d);
    }
    return out;
  }

  function imagesPanel(images) {
    const out = [];
    const counts = images.counts || {};
    const verdicts = Object.keys(counts).filter((k) => counts[k] > 0);
    out.push(verdictLine('image', V.worst('image', verdicts.length ? verdicts : ['no-signal'])));
    const line = el('div');
    for (const k of ['ai-generated', 'ai-edited', 'ai-disclosed', 'suspected', 'captured', 'human-created', 'algorithmic', 'no-signal', 'unavailable']) {
      if (!counts[k]) continue;
      const chip = tint(el('span', 'chip'), V.IMAGE[k].color);
      chip.appendChild(el('span', 'ic', V.IMAGE[k].icon));
      chip.appendChild(document.createTextNode(counts[k] + ' ' + V.IMAGE[k].label));
      line.appendChild(chip);
    }
    out.push(line);
    out.push(el('div', 'note', (images.total || 0) + ' images considered, ' + (images.inspected || 0) + ' inspected at byte level' + (images.pending ? ', ' + images.pending + ' pending' : '') + '.'));
    const list = el('div');
    for (const it of (images.items || []).slice(0, 25)) {
      const info = V.IMAGE[it.verdict] || V.IMAGE['no-signal'];
      const d = el('div', 'item');
      const chip = tint(el('span', 'chip'), info.color);
      chip.appendChild(el('span', 'ic', info.icon));
      chip.appendChild(document.createTextNode(info.short));
      d.appendChild(chip);
      if (it.kind && it.kind !== 'image') d.appendChild(tint(el('span', 'chip', it.kind === 'av' ? 'video / audio' : 'poster frame'), V.COLORS.blue));
      d.appendChild(el('div', 'u', it.url));
      if (it.platformLabel) d.appendChild(el('div', 'd', it.platformLabel.platform + ' label: “' + it.platformLabel.text + '”'));
      if (it.attribution) d.appendChild(el('div', 'd', 'Likely tool: ' + it.attribution.name + ' · ' + (A.CONFIDENCE_LABEL[it.attribution.confidence] || '') + (it.attribution.detail ? ' · ' + it.attribution.detail : '')));
      // The verification box below says this in full; don't say it twice.
      const shown = (it.signals || []).filter((s) => s.id !== 'c2pa-verified' && s.id !== 'c2pa-unverified');
      for (const s of shown.slice(0, 5)) d.appendChild(sigRow(s));
      if (it.metadata && it.metadata.c2pa) {
        const c2 = it.metadata.c2pa;
        d.appendChild(el('div', 'note', 'C2PA: ' + [c2.claimGenerator, (c2.actions || []).map((a) => a.action + (a.digitalSourceType ? ' (' + a.digitalSourceType.split('/').pop() + ')' : '')).join(', '), c2.signerNames && c2.signerNames.length ? 'signer ' + c2.signerNames.join(', ') : ''].filter(Boolean).join(' · ')));
        const vr = verificationRow(c2.verification);
        if (vr) d.appendChild(vr);
      }
      list.appendChild(d);
    }
    out.push(list);
    return out;
  }

  const STATUS = {
    present: { icon: '✓', color: V.COLORS.green },
    weak: { icon: '~', color: V.COLORS.gold },
    missing: { icon: '✗', color: V.COLORS.mist },
    concern: { icon: '!', color: V.COLORS.vermillion },
  };

  function traderPanel(t, r) {
    if (!t) return [el('div', 'empty', 'This page was not analysed for trader identification.')];
    const out = [];
    const headline = t.missingCritical.length
      ? (t.commerce ? 'A page that takes money should say who runs it. ' : '') + t.missingCritical.length + ' expected disclosure' + (t.missingCritical.length === 1 ? '' : 's') + ' not found on this page.'
      : 'The disclosures a reader would expect are present on this page.';
    const banner = tint(el('div', 'attr'), t.missingCritical.length ? V.COLORS.vermillion : V.COLORS.green);
    const bt = tint(el('div', 'tag'), t.missingCritical.length ? V.COLORS.vermillion : V.COLORS.green);
    bt.appendChild(el('span', 'ic', t.missingCritical.length ? '!' : '✓'));
    bt.appendChild(document.createTextNode(headline));
    banner.appendChild(bt);
    banner.appendChild(el('div', 'd', t.commerce ? 'This page looks like it sells something, so returns and terms are checked too.' : 'This page does not look like a shop, so only the basic disclosures are checked.'));
    out.push(banner);

    const list = el('div');
    list.appendChild(el('h3', null, 'Identification and policies'));
    for (const c of t.checks) {
      const st = STATUS[c.status] || STATUS.missing;
      const d = el('div', 'sig');
      const k = el('span', 'k', st.icon);
      k.style.color = st.color;
      d.appendChild(k);
      const v = el('div');
      v.appendChild(el('div', 'l', c.label));
      if (c.detail) v.appendChild(el('div', 'd', c.detail));
      else if (c.status === 'missing') v.appendChild(el('div', 'd', 'Not found on this page. It may live on another page of the site.'));
      d.appendChild(v);
      list.appendChild(d);
    }
    out.push(list);

    if (t.pressure.length) {
      const p = el('div');
      p.appendChild(el('h3', null, 'Pressure and urgency patterns'));
      for (const x of t.pressure) {
        const it = el('div', 'item');
        it.appendChild(tint(el('span', 'chip', x.label), V.COLORS.orange));
        it.appendChild(el('div', 'ex', '“…' + x.detail + '…”'));
        it.appendChild(el('div', 'd', x.note));
        p.appendChild(it);
      }
      p.appendChild(el('div', 'note', 'These are shown because EU consumer law restricts them, not as proof that anything is wrong. A genuine sale can have a genuine timer.'));
      out.push(p);
    }

    out.push(el('div', 'note', t.note + ' Findings describe this page only, not the business behind it.'));
    return out;
  }

  /* Cryptographic state of a Content Credentials manifest. Three outcomes,
   * kept visually distinct because they mean different things. */
  function verificationRow(v) {
    if (!v) return null;
    const sum = v.summary || {};
    const state = sum.broken ? { icon: '✗', color: V.COLORS.vermillion, word: 'Credentials do not verify' }
      : sum.caution ? { icon: '!', color: V.COLORS.gold, word: 'Signed, assertions unreconciled' }
        : sum.ok ? { icon: '✓', color: V.COLORS.green, word: 'Signature verified' }
          : { icon: '○', color: V.COLORS.mist, word: 'Signature not verified' };
    const d = el('div', 'attr');
    const t = tint(el('div', 'tag'), state.color);
    t.appendChild(el('span', 'ic', state.icon));
    t.appendChild(document.createTextNode(state.word));
    d.appendChild(t);
    if (sum.text) d.appendChild(el('div', 'd', sum.text));
    if (v.signedBy && v.signedBy.subject) d.appendChild(el('div', 'd', 'Certificate subject: ' + v.signedBy.subject + (v.signedBy.issuer ? ', issued by ' + v.signedBy.issuer : '')));
    const det = el('details');
    det.appendChild(el('summary', null, 'What this does and does not prove'));
    const body = el('div', 'skew');
    body.appendChild(el('div', null, sum.ok
      ? 'The manifest has not been altered since it was signed. It does not prove the signer is who the certificate name suggests, because this build ships no trust list to anchor the chain.'
      : sum.broken
        ? 'Something verifiably does not add up: the signature, an assertion hash or the certificate chain. Treat the claims inside the manifest as unreliable.'
        : sum.caution
          ? 'The claim is authentic but the assertions present do not hash to the values it recorded. Either an assertion was replaced after signing, or this reader does not know the hashing convention used.'
          : 'No cryptographic check completed, so the manifest is being read as an unverified claim.'));
    if (v.chain && v.chain.anchorNote) body.appendChild(el('div', 'basis', v.chain.anchorNote));
    if (v.notes && v.notes.length) body.appendChild(el('div', 'basis', v.notes.join(' ')));
    det.appendChild(body);
    d.appendChild(det);
    return d;
  }

  function toolsPanel(r) {
    const systems = (r.aiSystems || []).slice().sort((a, b) => rank(b.confidence) - rank(a.confidence));
    if (!systems.length) return [el('div', 'empty', 'No AI tool could be identified on this page. That means the evidence named no product, not that none was used.')];
    const out = [];
    for (const sys of systems) {
      const it = el('div', 'item');
      const head = el('div');
      head.appendChild(el('b', null, sys.name));
      head.appendChild(el('span', 'conf', ' · ' + sys.layers.join(', ') + ' · ' + (A.CONFIDENCE_LABEL[sys.confidence] || sys.confidence)));
      it.appendChild(head);
      if (sys.vendor) it.appendChild(el('div', 'd', sys.vendor + (sys.country ? ', ' + sys.country : '')));
      if (sys.evidence) it.appendChild(el('div', 'd', 'Evidence: ' + sys.evidence));
      if (sys.marking) it.appendChild(el('div', 'd', 'Marking: ' + sys.marking));
      const kind = sys.layers.includes('image') && !sys.layers.includes('text') ? 'image' : sys.layers.includes('site') && sys.layers.length === 1 ? 'site' : 'text';
      const sk = skewList(sys, kind, systems.length === 1);
      if (sk) it.appendChild(sk);
      out.push(it);
    }
    out.push(el('div', 'note', 'Skew notes summarise public reports and vendor statements reviewed ' + A.REVIEWED + '. They describe typical default behaviour of the tool, not this specific content, and models change between versions.'));
    return out;
  }

  function rank(c) { return { confirmed: 3, declared: 2, inferred: 1, unknown: 0 }[c] || 0; }

  /* ---------------- export ---------------- */

  function exportBlock(r) {
    const d = el('div');
    d.appendChild(el('h3', null, 'Keep a record'));
    const row = el('div', 'exports');
    row.appendChild(btn('Copy JSON', async (b) => {
      const report = await buildReport(r);
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      flash(b, 'Copied');
    }));
    row.appendChild(btn('Save report', async (b) => {
      const report = await buildReport(r);
      download(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }), 'selfreportle-' + safeName(r.hostname) + '-' + stamp() + '.json');
      flash(b, 'Saved');
    }));
    row.appendChild(btn('Save receipt', async (b) => {
      const blob = await receipt(r);
      download(blob, 'selfreportle-' + safeName(r.hostname) + '-' + stamp() + '.png');
      flash(b, 'Saved');
    }));
    d.appendChild(row);
    d.appendChild(el('div', 'note', 'The report carries a SHA-256 digest of its own findings so you can show it has not been edited since you saved it. It is self-attested by this extension, not notarised by a third party.'));
    return d;
  }

  function btn(label, fn) {
    const b = el('button', null, label);
    b.type = 'button';
    b.addEventListener('click', async () => {
      try { await fn(b); } catch (e) { flash(b, 'Failed'); }
    });
    return b;
  }

  function flash(b, msg) {
    const old = b.textContent;
    b.textContent = msg;
    setTimeout(() => { b.textContent = old; }, 1500);
  }

  function safeName(h) { return String(h || 'page').replace(/[^a-z0-9.-]/gi, '_').slice(0, 40); }
  function stamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  async function buildReport(r) {
    const findings = { url: r.url, title: r.title, analysedAt: new Date(r.at).toISOString(), overall: r.overall, site: r.site, text: r.text, images: r.images, disclosures: r.disclosures, aiSystems: r.aiSystems };
    const canonical = JSON.stringify(findings);
    const digest = await sha256(canonical);
    return {
      tool: 'Selfreportle ' + chrome.runtime.getManifest().version,
      skewCatalogueReviewed: A.REVIEWED,
      savedAt: new Date().toISOString(),
      integrity: { algorithm: 'SHA-256', digest, covers: 'the findings object as serialised by JSON.stringify', attestedBy: 'this extension only; not a third-party notarisation' },
      caveats: [
        'C2PA signatures are parsed, not cryptographically verified.',
        'Absence of signals is not proof of human origin; metadata is routinely stripped on upload.',
        'Stylometric text signals are heuristics and are capped below the strongest verdict.',
        'Attribution confidence is one of confirmed, declared, inferred or unknown; only "confirmed" rests on embedded evidence.',
      ],
      findings,
    };
  }

  async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* A shareable card: the verdict, the three layers and the tools found. */
  async function receipt(r) {
    const W = 1000, H = 560, P = 48;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const key = r.overall || V.overall(r);
    const overall = V.OVERALL[key] || V.OVERALL.none;
    g.fillStyle = '#12161d'; g.fillRect(0, 0, W, H);
    g.fillStyle = overall.color; g.fillRect(0, 0, W, 8);
    const font = (size, weight) => { g.font = (weight || 400) + ' ' + size + 'px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'; };

    font(15, 600); g.fillStyle = '#9aa3b2';
    g.fillText('SELFREPORTLE · AI CONTENT SIGNALS', P, P + 12);
    font(30, 700); g.fillStyle = '#e8eaf0';
    g.fillText(clip(g, r.title || r.hostname, W - P * 2), P, P + 58);
    font(16, 400); g.fillStyle = '#9aa3b2';
    g.fillText(clip(g, r.url, W - P * 2), P, P + 86);

    g.fillStyle = overall.color;
    roundRect(g, P, P + 110, W - P * 2, 66, 10); g.fill();
    font(24, 700); g.fillStyle = '#ffffff';
    g.fillText((overall.icon || '') + '  ' + overall.label, P + 18, P + 152);

    const rows = [
      ['Site', V.info('site', (r.site || {}).verdict), (r.site || {}).attribution],
      ['Text', V.info('text', (r.text || {}).verdict), (r.text || {}).attribution],
      ['Images', imageSummaryInfo(r), null],
    ];
    let y = P + 216;
    for (const [label, info, attr] of rows) {
      g.fillStyle = info.color;
      roundRect(g, P, y - 15, 20, 20, 5); g.fill();
      font(17, 700); g.fillStyle = '#9aa3b2'; g.fillText(label, P + 34, y);
      font(17, 400); g.fillStyle = '#e8eaf0'; g.fillText(clip(g, info.label, 620), P + 130, y);
      if (attr) { font(14, 400); g.fillStyle = '#9aa3b2'; g.fillText(clip(g, 'likely ' + attr.name + ' (' + attr.confidence + ')', 620), P + 130, y + 21); }
      y += attr ? 56 : 44;
    }

    const tools = (r.aiSystems || []).filter((x) => x.id).map((x) => x.name.replace(/\s*\(.*$/, ''));
    if (tools.length) {
      font(14, 600); g.fillStyle = '#9aa3b2'; g.fillText('TOOLS IDENTIFIED', P, y + 8);
      font(16, 400); g.fillStyle = '#e8eaf0'; g.fillText(clip(g, tools.join(' · '), W - P * 2), P, y + 32);
    }

    font(13, 400); g.fillStyle = '#79818e';
    g.fillText('Saved ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC · signals only, not proof of authorship · signatures parsed, not verified', P, H - P + 10);
    return new Promise((res) => cv.toBlob(res, 'image/png'));
  }

  function imageSummaryInfo(r) {
    const c = (r.images || {}).counts || {};
    const verdicts = Object.keys(c).filter((k) => c[k] > 0);
    const worst = V.worst('image', verdicts.length ? verdicts : ['no-signal']);
    const info = V.IMAGE[worst];
    const n = (c['ai-generated'] || 0) + (c['ai-edited'] || 0) + (c['ai-disclosed'] || 0);
    return { color: info.color, label: n ? n + ' of ' + (r.images.total || 0) + ' images show AI provenance' : info.label };
  }

  function clip(g, text, max) {
    let t = String(text || '');
    if (g.measureText(t).width <= max) return t;
    while (t.length > 4 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
    return t + '…';
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* ---------------- load ---------------- */

  async function load() {
    let result = null;
    try { result = await chrome.runtime.sendMessage({ type: 'srl:get-result', tabId: tab.id }); } catch (e) { result = null; }
    if (!result) {
      try { result = await chrome.tabs.sendMessage(tab.id, { type: 'srl:get-page-result' }); } catch (e) { result = null; }
    }
    current = result;
    render(result);
  }

  await load();
})();
