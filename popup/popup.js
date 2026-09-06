(async function () {
  'use strict';
  const S = globalThis.SRL;
  const V = S.verdicts;
  const $ = (id) => document.getElementById(id);

  // ?tabId=N lets the popup be opened as a normal page for debugging.
  const debugTabId = parseInt(new URLSearchParams(location.search).get('tabId'), 10);
  const tab = Number.isFinite(debugTabId) ? await chrome.tabs.get(debugTabId) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab) return;
  $('url').textContent = tab.url || '';

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

  let current = null;
  $('copy').addEventListener('click', async () => {
    if (!current) return;
    const report = { generatedBy: 'Selfreportle ' + chrome.runtime.getManifest().version, generatedAt: new Date().toISOString(), ...current };
    try { await navigator.clipboard.writeText(JSON.stringify(report, null, 2)); $('copy').textContent = 'Copied'; } catch (e) { $('copy').textContent = 'Failed'; }
    setTimeout(() => { $('copy').textContent = 'Copy'; }, 1500);
  });

  async function load() {
    let result = null;
    try { result = await chrome.runtime.sendMessage({ type: 'srl:get-result', tabId: tab.id }); } catch (e) { result = null; }
    if (!result) {
      try { result = await chrome.tabs.sendMessage(tab.id, { type: 'srl:get-page-result' }); } catch (e) { result = null; }
    }
    current = result;
    render(result);
  }

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  function render(r) {
    const main = $('main');
    main.innerHTML = '';
    const ov = $('overall');
    if (!r) {
      ov.textContent = '';
      main.appendChild(el('div', 'empty', 'Nothing analysed yet for this tab. Reload the page or press Rescan. Browser-internal pages and the Web Store cannot be inspected.'));
      return;
    }
    const overall = V.OVERALL[r.overall || V.overall(r)] || V.OVERALL.none;
    ov.style.setProperty('--c', overall.color);
    ov.innerHTML = '';
    ov.appendChild(document.createTextNode(overall.label));
    ov.appendChild(el('small', null, trustHint(r)));

    main.appendChild(siteCard(r.site || {}, r));
    main.appendChild(textCard(r.text || {}));
    main.appendChild(imagesCard(r.images || {}));
    if (r.disclosures && r.disclosures.length) main.appendChild(disclosureCard(r.disclosures));
    if (r.site && r.site.trustNotes && r.site.trustNotes.length) main.appendChild(trustCard(r.site.trustNotes));
  }

  function trustHint(r) {
    switch (r.overall) {
      case 'undisclosed-ai': return 'AI-generation markers were found but no disclosure statement. Verify the operator before relying on this content or doing business.';
      case 'disclosed-ai': return 'AI use is declared on the page or in metadata. Decide whether that is acceptable for your purpose.';
      case 'weak-ai': return 'Only heuristic or indirect signals. Treat as a prompt to look closer, not a verdict.';
      case 'provenance': return 'Some content carries capture or human-creation credentials. Credentials were parsed, not cryptographically verified.';
      default: return 'No markers found. Many AI systems still emit nothing detectable, so this is not proof of human origin.';
    }
  }

  function card(title, kind, verdict, score, open, override) {
    const info = override || V.info(kind, verdict);
    const c = el('div', 'card' + (open ? ' open' : ''));
    const hd = el('div', 'hd');
    hd.style.setProperty('--c', info.color);
    hd.appendChild(el('span', 'dot'));
    hd.appendChild(el('span', 't', title));
    hd.appendChild(el('span', 'v', info.label));
    hd.addEventListener('click', () => c.classList.toggle('open'));
    c.appendChild(hd);
    const bd = el('div', 'bd');
    if (typeof score === 'number') { const bar = el('div', 'bar'); bar.style.setProperty('--c', info.color); const i = el('i'); i.style.width = Math.round(score * 100) + '%'; bar.appendChild(i); bd.appendChild(bar); }
    c.appendChild(bd);
    return { c, bd };
  }

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

  function siteCard(site, r) {
    const open = V.AI_SITE_VERDICTS.has(site.verdict);
    const { c, bd } = card('Site & code', 'site', site.verdict, site.score, open);
    if (site.generator) bd.appendChild(el('div', 'note', 'Generator meta: ' + site.generator));
    for (const s of site.signals || []) bd.appendChild(sigRow(s));
    if (!(site.signals || []).length) bd.appendChild(el('div', 'note', 'No generator fingerprints, disclosure meta tags, structured-data flags or AI code comments found.'));
    if (V.AI_SITE_VERDICTS.has(site.verdict) && !site.disclosed) bd.appendChild(el('div', 'note', 'No statement about AI involvement was found on the page.'));
    return c;
  }

  function textCard(text) {
    const open = V.AI_TEXT_VERDICTS.has(text.verdict);
    const { c, bd } = card('Text', 'text', text.verdict, text.score, open);
    bd.appendChild(el('div', 'note', (text.blocks || 0) + ' text blocks, ' + (text.words || 0) + ' words analysed; ' + (text.flaggedBlocks || 0) + ' flagged.'));
    if (text.page && text.page.signals && text.page.signals.length) {
      bd.appendChild(el('h3', null, 'Whole-page signals'));
      for (const s of text.page.signals) bd.appendChild(sigRow(s));
    }
    if (text.page && text.page.stats) {
      const st = text.page.stats;
      bd.appendChild(el('div', 'note', 'Stylometry: ' + st.sentences + ' sentences, sentence-length CV ' + (st.sentenceLengthCV == null ? 'n/a' : st.sentenceLengthCV) + ', lexicon ' + st.lexiconPointsPerK + ' pts/1k words.'));
    }
    if (text.flagged && text.flagged.length) {
      bd.appendChild(el('h3', null, 'Flagged blocks'));
      for (const f of text.flagged.slice(0, 12)) {
        const it = el('div', 'item');
        const chip = el('span', 'chip', V.info('text', f.verdict).short);
        chip.style.setProperty('--c', V.info('text', f.verdict).color);
        it.appendChild(chip);
        it.appendChild(el('span', 'ex', '“' + f.excerpt + '”'));
        for (const s of (f.signals || []).slice(0, 3)) it.appendChild(sigRow(s));
        bd.appendChild(it);
      }
    }
    return c;
  }

  function imagesCard(images) {
    const counts = images.counts || {};
    const verdicts = Object.keys(counts).filter((k) => counts[k] > 0);
    const worst = V.worst('image', verdicts.length ? verdicts : ['no-signal']);
    const open = V.AI_IMAGE_VERDICTS.has(worst);
    const { c, bd } = card('Images', 'image', worst, null, open);
    const order = ['ai-generated', 'ai-edited', 'ai-disclosed', 'suspected', 'captured', 'human-created', 'algorithmic', 'no-signal', 'unavailable'];
    const line = el('div');
    for (const k of order) {
      if (!counts[k]) continue;
      const chip = el('span', 'chip', counts[k] + ' ' + V.IMAGE[k].label);
      chip.style.setProperty('--c', V.IMAGE[k].color);
      line.appendChild(chip);
    }
    bd.appendChild(line);
    bd.appendChild(el('div', 'note', (images.total || 0) + ' images considered, ' + (images.inspected || 0) + ' inspected at byte level' + (images.pending ? ', ' + images.pending + ' pending' : '') + '.'));
    for (const it of (images.items || []).slice(0, 20)) {
      const d = el('div', 'item');
      const chip = el('span', 'chip', V.IMAGE[it.verdict].short);
      chip.style.setProperty('--c', V.IMAGE[it.verdict].color);
      d.appendChild(chip);
      const u = el('span', 'u', it.url);
      u.title = it.url;
      d.appendChild(u);
      for (const s of (it.signals || []).slice(0, 4)) d.appendChild(sigRow(s));
      if (it.metadata && it.metadata.c2pa) {
        const c2 = it.metadata.c2pa;
        d.appendChild(el('div', 'note', 'C2PA: ' + [c2.claimGenerator, (c2.actions || []).map((a) => a.action + (a.digitalSourceType ? ' (' + a.digitalSourceType.split('/').pop() + ')' : '')).join(', '), c2.signerNames && c2.signerNames.length ? 'signer ' + c2.signerNames.join(', ') : ''].filter(Boolean).join(' · ')));
      }
      bd.appendChild(d);
    }
    return c;
  }

  function disclosureCard(list) {
    const shown = list.filter((d) => d.level !== 'weak');
    if (!shown.length) return document.createDocumentFragment();
    const { c, bd } = card('Disclosures on the page', 'text', shown.some((d) => d.level !== 'human') ? 'ai-disclosed' : 'human-disclosed', null, false);
    for (const d of shown.slice(0, 10)) {
      const it = el('div', 'item');
      it.appendChild(el('span', 'chip', d.level + ' · ' + d.scope));
      it.appendChild(el('span', 'ex', '“…' + d.context + '…”'));
      bd.appendChild(it);
    }
    return c;
  }

  function trustCard(notes) {
    const { c, bd } = card('Trust notes', 'site', 'no-signal', null, false, { label: notes.length + ' template leftover(s)', color: V.COLORS.blue });
    for (const n of notes) bd.appendChild(sigRow({ kind: 'info', label: n.label, detail: n.detail }));
    bd.appendChild(el('div', 'note', 'Template leftovers suggest an unfinished or auto-generated site. Not AI evidence by itself.'));
    return c;
  }

  await load();
})();
