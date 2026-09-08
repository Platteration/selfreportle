/*
 * content/overlay.js — all in-page UI, isolated in a closed shadow root:
 *   • a floating summary pill (bottom-right) that expands into a panel
 *   • badges anchored to images and text blocks, positioned in a fixed layer
 *   • a detail popover per badge
 */
(function () {
  'use strict';
  const S = globalThis.SRL;
  const V = S.verdicts;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
    .layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483645; }
    .badge { position: absolute; top: 0; left: 0; pointer-events: auto; display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 7px; border-radius: 999px; font-size: 11px; font-weight: 600; line-height: 16px; color: #fff; cursor: pointer;
      background: var(--c, #7a7f87); box-shadow: 0 1px 3px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.65); white-space: nowrap;
      transform: translate(var(--x, 0px), var(--y, 0px)); will-change: transform; user-select: none; }
    .badge.text { font-size: 10px; padding: 1px 6px; opacity: .92; }
    .badge:hover { filter: brightness(1.08); }
    .badge[hidden] { display: none; }
    .badge .ic { font-size: 10px; }
    .pill { all: unset; position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; pointer-events: auto; display: flex; align-items: center; gap: 8px;
      background: #1f2430; color: #fff; border-radius: 999px; padding: 6px 10px 6px 12px; font-size: 12px; box-shadow: 0 4px 16px rgba(0,0,0,.35); cursor: pointer; }
    .pill .dot { width: 9px; height: 9px; border-radius: 50%; background: var(--c, #7a7f87); box-shadow: 0 0 0 2px rgba(255,255,255,.15); }
    .pill .lbl { opacity: .85; }
    .pill b { font-weight: 600; }
    .pill .x { margin-left: 4px; opacity: .6; font-size: 14px; line-height: 1; padding: 0 2px; }
    .pill .x:hover { opacity: 1; }
    /* "all: unset" plus an author display beats the UA [hidden] rule, so the
       dismiss button, the showPill setting and Alt+Shift+A all need this. */
    .pill[hidden] { display: none; }
    .panel { position: fixed; right: 16px; bottom: 56px; z-index: 2147483646; pointer-events: auto; width: 360px; max-width: calc(100vw - 32px); max-height: min(70vh, 560px);
      overflow: auto; background: #fff; color: #1f2430; border-radius: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.35); font-size: 13px; }
    .panel[hidden] { display: none; }
    .panel h2 { margin: 0; padding: 12px 14px 8px; font-size: 14px; display: flex; align-items: center; justify-content: space-between; }
    .panel h2 small { font-weight: 400; color: #666; font-size: 11px; }
    .overall { margin: 0 14px 10px; padding: 8px 10px; border-radius: 8px; color: #fff; font-weight: 600; background: var(--c, #7a7f87); }
    .row { display: grid; grid-template-columns: 62px 1fr; gap: 8px; padding: 6px 14px; align-items: start; border-top: 1px solid #eee; }
    .row .k { font-weight: 600; color: #444; padding-top: 2px; }
    .row .v { display: flex; flex-direction: column; gap: 3px; }
    .tag { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; }
    .tag i { width: 8px; height: 8px; border-radius: 50%; background: var(--c, #7a7f87); display: inline-block; }
    .sig { color: #444; font-size: 12px; }
    .sig span { color: #777; }
    .foot { padding: 8px 14px 12px; font-size: 11px; color: #666; border-top: 1px solid #eee; line-height: 1.4; }
    .pop { position: fixed; z-index: 2147483647; pointer-events: auto; width: 320px; max-width: calc(100vw - 24px); max-height: 60vh; overflow: auto;
      background: #fff; color: #1f2430; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.35); font-size: 12px; }
    .pop[hidden] { display: none; }
    .pop .hd { padding: 8px 10px; color: #fff; font-weight: 600; background: var(--c, #7a7f87); border-radius: 10px 10px 0 0; display: flex; justify-content: space-between; align-items: center; }
    .pop .hd button { all: unset; cursor: pointer; padding: 0 4px; font-size: 14px; }
    .pop ul { margin: 0; padding: 8px 10px 8px 24px; }
    .pop li { margin: 4px 0; line-height: 1.35; }
    .pop li b { font-weight: 600; }
    .pop li span { color: #666; display: block; word-break: break-word; }
    .pop .meta { padding: 6px 10px 10px; color: #777; font-size: 11px; border-top: 1px solid #eee; }
    .pop .none { padding: 10px; color: #666; }
    .pop .tools { display: flex; gap: 6px; padding: 0 10px 8px; flex-wrap: wrap; }
    .pop .tools button { all: unset; cursor: pointer; font-size: 11px; padding: 3px 8px; border-radius: 6px; background: #eef0f4; color: #1f2430; }
    .pop .tools button:hover { background: #e2e5ec; }
    .reveal { margin: 0 10px 8px; padding: 8px; border-radius: 6px; background: #f4f5f8; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      white-space: pre-wrap; word-break: break-word; max-height: 180px; overflow: auto; }
    .reveal[hidden] { display: none; }
    .reveal mark { background: #c43d0f; color: #fff; border-radius: 3px; padding: 0 2px; font-weight: 700; }

    /* Quiet mood: badges stay out of the way until the element is hovered. */
    :host([data-mood="quiet"]) .badge { opacity: 0; transition: opacity .15s ease; }
    :host([data-mood="quiet"]) .badge.near, :host([data-mood="quiet"]) .badge:focus-visible { opacity: 1; }
    :host([data-mood="quiet"]) .pill.dozing { padding: 6px; }
    :host([data-mood="quiet"]) .pill.dozing .lbl, :host([data-mood="quiet"]) .pill.dozing .x { display: none; }

    /* Forensic mood: denser, monospace evidence. */
    :host([data-mood="forensic"]) .pop, :host([data-mood="forensic"]) .panel { width: 420px; }
    :host([data-mood="forensic"]) .pop li span, :host([data-mood="forensic"]) .sig span { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
    :host([data-mood="forensic"]) .badge { font-size: 10px; }

    @media (prefers-color-scheme: dark) {
      .panel, .pop { background: #1b1f27; color: #e8eaf0; box-shadow: 0 8px 32px rgba(0,0,0,.6); }
      .panel h2 small, .sig span, .foot, .pop .meta, .pop .none, .pop li span { color: #9aa3b2; }
      .row, .foot, .pop .meta { border-color: #2e3440; }
      .row .k, .sig { color: #c7ccd6; }
      .pop .tools button { background: #2a3140; color: #e8eaf0; }
      .pop .tools button:hover { background: #333c4e; }
      .reveal { background: #12161d; }
      .pill { background: #0f1218; }
    }
  `;

  let host, shadow, layer, pill, panel, pop;
  let markers = new Map();
  let settings = {};
  let visible = true;
  let raf = 0;
  let summary = null;
  let dozeTimer = 0;

  /* Quiet mood: reveal the badge whose element is under or near the cursor. */
  function onQuietHover(e) {
    for (const m of markers.values()) {
      if (!m.node || m.node.hidden) continue;
      const r = m.el.getBoundingClientRect();
      const near = e.clientX >= r.left - 24 && e.clientX <= r.right + 24 && e.clientY >= r.top - 24 && e.clientY <= r.bottom + 24;
      m.node.classList.toggle('near', near);
    }
  }

  function init(s) {
    settings = s || {};
    if (host) return;
    host = document.createElement('srl-overlay');
    host.setAttribute('data-srl-ui', '1');
    host.setAttribute('data-mood', settings.mood || 'reader');
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);
    layer = el('div', 'layer');
    shadow.appendChild(layer);
    pill = el('button', 'pill');
    pill.type = 'button';
    pill.setAttribute('aria-label', 'Selfreportle AI content summary. Activate to open the panel.');
    pill.hidden = !settings.showPill;
    pill.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) { pill.hidden = true; panel.hidden = true; return; }
      pill.classList.remove('dozing');
      clearTimeout(dozeTimer);
      panel.hidden = !panel.hidden;
    });
    pill.addEventListener('mouseenter', () => { pill.classList.remove('dozing'); clearTimeout(dozeTimer); });
    shadow.appendChild(pill);
    panel = el('div', 'panel');
    panel.hidden = true;
    shadow.appendChild(panel);
    pop = el('div', 'pop');
    pop.hidden = true;
    shadow.appendChild(pop);
    (document.documentElement || document.body).appendChild(host);

    applyMood();
    window.addEventListener('scroll', schedule, { passive: true, capture: true });
    window.addEventListener('resize', schedule, { passive: true });
    setInterval(schedule, 1200);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { pop.hidden = true; panel.hidden = true; } }, true);
    document.addEventListener('mousedown', (e) => { if (e.target !== host) pop.hidden = true; }, true);
  }

  function el(tag, cls) { const n = document.createElement(tag); if (cls) n.className = cls; return n; }

  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; reposition(); });
  }

  function reposition() {
    if (!visible) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    for (const m of markers.values()) {
      const node = m.node;
      if (!node) continue;
      if (!m.el.isConnected) { node.hidden = true; continue; }
      const r = m.el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom < -40 || r.top > vh + 40 || r.right < 0 || r.left > vw) { node.hidden = true; continue; }
      node.hidden = false;
      const bw = node.offsetWidth || 40;
      let x, y;
      if (m.kind === 'image') { x = r.left + 6; y = r.top + 6; }
      else { x = Math.min(r.right, vw) - bw - 4; y = r.top - 9; if (y < 0) y = r.top + 2; }
      node.style.setProperty('--x', Math.round(Math.max(0, Math.min(x, vw - bw - 2))) + 'px');
      node.style.setProperty('--y', Math.round(Math.max(0, y)) + 'px');
    }
  }

  function upsertMarker(m) {
    if (!layer) return;
    if (m.kind === 'image' && !settings.showImageBadges) return;
    if (m.kind === 'text' && !settings.showTextMarkers) return;
    const info = V.info(m.kind, m.verdict);
    let existing = markers.get(m.key);
    if (!existing) {
      const node = el('button', 'badge ' + m.kind);
      node.type = 'button';
      node.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); showPopover(m.key, node); });
      layer.appendChild(node);
      existing = { ...m, node };
      markers.set(m.key, existing);
    } else Object.assign(existing, m);
    const node = existing.node;
    node.style.setProperty('--c', info.color);
    node.innerHTML = '';
    const ic = el('span', 'ic'); ic.textContent = info.icon;
    node.appendChild(ic);
    node.appendChild(document.createTextNode(m.short || info.short));
    node.setAttribute('aria-label', (m.kind === 'image' ? 'Image: ' : 'Text: ') + info.label + '. Click for details.');
    node.title = info.label;
    if (m.kind === 'text') {
      m.el.setAttribute('data-srl-text', m.verdict);
    }
    schedule();
  }

  function removeMarker(key) {
    const m = markers.get(key);
    if (!m) return;
    if (m.node) m.node.remove();
    if (m.kind === 'text') m.el.removeAttribute('data-srl-text');
    markers.delete(key);
  }

  function clearMarkers() {
    for (const k of [...markers.keys()]) removeMarker(k);
  }

  function showPopover(key, anchor) {
    const m = markers.get(key);
    if (!m) return;
    anchor = anchor && anchor.getBoundingClientRect ? anchor : m.node;
    if (!anchor) return;
    const info = V.info(m.kind, m.verdict);
    pop.innerHTML = '';
    pop.style.setProperty('--c', info.color);
    const hd = el('div', 'hd');
    hd.appendChild(document.createTextNode((m.kind === 'image' ? 'Image · ' : 'Text · ') + info.label));
    const close = el('button'); close.textContent = '✕'; close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => { pop.hidden = true; });
    hd.appendChild(close);
    pop.appendChild(hd);
    const details = (m.details || []).filter((d) => d.label);
    if (details.length) {
      const ul = el('ul');
      for (const d of details) {
        const li = el('li');
        const b = el('b'); b.textContent = d.label; li.appendChild(b);
        if (d.detail) { const sp = el('span'); sp.textContent = d.detail; li.appendChild(sp); }
        ul.appendChild(li);
      }
      pop.appendChild(ul);
    } else {
      const none = el('div', 'none'); none.textContent = 'No details available.'; pop.appendChild(none);
    }
    if (m.raw && INVISIBLE_RE.test(m.raw)) pop.appendChild(revealTools(m.raw));
    const meta = el('div', 'meta');
    meta.textContent = m.meta || (m.kind === 'image' ? 'Embedded metadata can be stripped or forged; absence of signals is not proof of human origin.' : 'Stylometric signals are heuristics, not proof. Disclosures are self-reported.');
    pop.appendChild(meta);
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    const w = 320, h = Math.min(pop.offsetHeight || 200, window.innerHeight * 0.6);
    let left = r.left, top = r.bottom + 6;
    if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
  }

  /* Characters that render as nothing: zero-width family, Unicode tags,
   * variation selectors, soft hyphen, narrow/no-break spaces. */
  const INVISIBLE_RE = /[\u200B-\u200F\u2060-\u2064\u202A-\u202E\uFEFF\u180E\u00AD\u202F\u00A0\uFE00-\uFE0F]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/u;

  const INVISIBLE_NAMES = {
    0x200b: 'ZWSP', 0x200c: 'ZWNJ', 0x200d: 'ZWJ', 0x200e: 'LRM', 0x200f: 'RLM',
    0x2060: 'WJ', 0x2061: 'FA', 0x2062: 'IT', 0x2063: 'IS', 0x2064: 'IP',
    0xfeff: 'BOM', 0x180e: 'MVS', 0x00ad: 'SHY', 0x202f: 'NNBSP', 0x00a0: 'NBSP',
    0x202a: 'LRE', 0x202b: 'RLE', 0x202c: 'PDF', 0x202d: 'LRO', 0x202e: 'RLO',
  };

  function nameOf(cp) {
    if (INVISIBLE_NAMES[cp]) return INVISIBLE_NAMES[cp];
    if (cp >= 0xe0000 && cp <= 0xe007f) return 'TAG' + (cp - 0xe0000).toString(16).toUpperCase();
    if (cp >= 0xfe00 && cp <= 0xfe0f) return 'VS' + (cp - 0xfe00 + 1);
    if (cp >= 0xe0100 && cp <= 0xe01ef) return 'VS' + (cp - 0xe0100 + 17);
    return 'U+' + cp.toString(16).toUpperCase();
  }

  function stripInvisible(text) {
    return Array.from(text).filter((ch) => !INVISIBLE_RE.test(ch)).join('');
  }

  /* Renders the block with every invisible character shown as a named chip,
   * without touching the page's own DOM. */
  function revealTools(raw) {
    const wrap = el('div');
    const tools = el('div', 'tools');
    const view = el('div', 'reveal');
    view.hidden = (settings.mood || 'reader') !== 'forensic';
    const show = el('button');
    show.type = 'button';
    show.textContent = view.hidden ? 'Show hidden characters' : 'Hide hidden characters';
    show.addEventListener('click', () => {
      view.hidden = !view.hidden;
      show.textContent = view.hidden ? 'Show hidden characters' : 'Hide hidden characters';
    });
    const copy = el('button');
    copy.type = 'button';
    copy.textContent = 'Copy cleaned text';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(stripInvisible(raw)); copy.textContent = 'Copied'; } catch (e) { copy.textContent = 'Copy blocked'; }
      setTimeout(() => { copy.textContent = 'Copy cleaned text'; }, 1500);
    });
    tools.appendChild(show);
    tools.appendChild(copy);
    for (const ch of Array.from(raw.slice(0, 4000))) {
      if (INVISIBLE_RE.test(ch)) {
        const mk = document.createElement('mark');
        mk.textContent = nameOf(ch.codePointAt(0));
        view.appendChild(mk);
      } else {
        view.appendChild(document.createTextNode(ch));
      }
    }
    wrap.appendChild(tools);
    wrap.appendChild(view);
    return wrap;
  }

  function setSummary(sum) {
    summary = sum;
    if (!pill) return;
    const overall = V.OVERALL[sum.overall] || V.OVERALL.none;
    pill.innerHTML = '';
    pill.style.setProperty('--c', overall.color);
    pill.appendChild(el('span', 'dot'));
    const lbl = el('span', 'lbl');
    lbl.innerHTML = '';
    const b = el('b'); b.textContent = 'AI check: ';
    lbl.appendChild(b);
    lbl.appendChild(document.createTextNode(shortOverall(sum)));
    pill.appendChild(lbl);
    const x = el('span', 'x'); x.textContent = '×'; x.title = 'Hide'; pill.appendChild(x);
    pill.title = overall.label;

    panel.innerHTML = '';
    const h2 = el('h2');
    h2.appendChild(document.createTextNode('Selfreportle'));
    const small = el('small'); small.textContent = 'AI content signals'; h2.appendChild(small);
    panel.appendChild(h2);
    const ov = el('div', 'overall'); ov.style.setProperty('--c', overall.color); ov.textContent = overall.label; panel.appendChild(ov);
    panel.appendChild(row('Site', 'site', sum.site));
    panel.appendChild(row('Text', 'text', sum.text));
    panel.appendChild(imageRow(sum.images));
    if (sum.aiSystems && sum.aiSystems.length) {
      const r = el('div', 'row');
      const k = el('div', 'k'); k.textContent = 'AI tools'; r.appendChild(k);
      const v = el('div', 'v');
      for (const a of sum.aiSystems.slice(0, 5)) {
        const s = el('div', 'sig');
        s.textContent = a.name + ' (' + a.layers.join(', ') + ')';
        const sp = el('span'); sp.textContent = ' — ' + (S.attribution.CONFIDENCE_LABEL[a.confidence] || a.confidence); s.appendChild(sp);
        v.appendChild(s);
      }
      const hint = el('div', 'sig'); hint.textContent = 'Open the toolbar popup for each tool\'s documented skews.'; v.appendChild(hint);
      r.appendChild(v); panel.appendChild(r);
    }
    if (sum.disclosures && sum.disclosures.length) {
      const r = el('div', 'row');
      const k = el('div', 'k'); k.textContent = 'Disclosed'; r.appendChild(k);
      const v = el('div', 'v');
      for (const d of sum.disclosures.slice(0, 3)) { const s = el('div', 'sig'); s.textContent = '“…' + d.context + '…”'; v.appendChild(s); }
      r.appendChild(v); panel.appendChild(r);
    }
    const foot = el('div', 'foot');
    foot.textContent = 'EU AI Act Art. 50 requires machine-readable marking of AI output and disclosure of deepfakes and AI-written public-interest text (applies from 2 Aug 2026). Absence of signals is not proof of human origin. Open the toolbar popup for the full report.';
    panel.appendChild(foot);
  }

  function shortOverall(sum) {
    const c = (sum.images && sum.images.counts) || {};
    const parts = [];
    parts.push('site ' + V.info('site', sum.site.verdict).short);
    parts.push('text ' + V.info('text', sum.text.verdict).short);
    const ai = (c['ai-generated'] || 0) + (c['ai-edited'] || 0) + (c['ai-disclosed'] || 0);
    const sus = c.suspected || 0;
    parts.push('images ' + (ai ? ai + ' AI' : sus ? sus + ' AI?' : sum.images.pending ? '…' : (c.captured || c['human-created']) ? 'provenance' : '–'));
    return parts.join(' · ');
  }

  function row(label, kind, r) {
    const info = V.info(kind, r.verdict);
    const d = el('div', 'row');
    const k = el('div', 'k'); k.textContent = label; d.appendChild(k);
    const v = el('div', 'v');
    const t = el('div', 'tag'); t.style.setProperty('--c', info.color); t.appendChild(el('i')); t.appendChild(document.createTextNode(info.label)); v.appendChild(t);
    if (r.attribution) { const a = el('div', 'sig'); a.textContent = 'Likely tool: ' + r.attribution.name; const sp = el('span'); sp.textContent = ' — ' + (S.attribution.CONFIDENCE_LABEL[r.attribution.confidence] || ''); a.appendChild(sp); v.appendChild(a); }
    for (const s of (r.signals || []).slice(0, 3)) {
      const sg = el('div', 'sig'); sg.textContent = s.label; if (s.detail) { const sp = el('span'); sp.textContent = ' — ' + s.detail.slice(0, 120); sg.appendChild(sp); } v.appendChild(sg);
    }
    d.appendChild(v);
    return d;
  }

  function imageRow(img) {
    const d = el('div', 'row');
    const k = el('div', 'k'); k.textContent = 'Images'; d.appendChild(k);
    const v = el('div', 'v');
    const c = img.counts || {};
    const order = ['ai-generated', 'ai-edited', 'ai-disclosed', 'suspected', 'captured', 'human-created', 'algorithmic', 'no-signal', 'unavailable'];
    let any = false;
    for (const key of order) {
      if (!c[key]) continue;
      any = true;
      const info = V.IMAGE[key];
      const t = el('div', 'tag'); t.style.setProperty('--c', info.color); t.appendChild(el('i')); t.appendChild(document.createTextNode(c[key] + ' × ' + info.label)); v.appendChild(t);
    }
    if (!any) { const s = el('div', 'sig'); s.textContent = img.pending ? 'Inspecting…' : img.total ? 'No signals in ' + img.total + ' image(s)' : 'No images large enough to inspect'; v.appendChild(s); }
    else if (img.pending) { const s = el('div', 'sig'); s.textContent = 'Still inspecting ' + img.pending + '…'; v.appendChild(s); }
    d.appendChild(v);
    return d;
  }

  function setVisible(v) {
    visible = v;
    if (!host) return;
    layer.hidden = !v;
    pill.hidden = !v || !settings.showPill;
    if (!v) { panel.hidden = true; pop.hidden = true; }
    for (const m of markers.values()) if (m.kind === 'text') { if (v) m.el.setAttribute('data-srl-text', m.verdict); else m.el.removeAttribute('data-srl-text'); }
    if (v) schedule();
  }

  /* Quiet mood hides badges until the cursor is near them, so it needs a
   * mousemove listener. Switching into it at runtime must attach that listener,
   * and switching out must drop it, or every badge stays invisible. */
  function applyMood() {
    const quiet = (settings.mood || 'reader') === 'quiet';
    document.removeEventListener('mousemove', onQuietHover, { capture: true });
    clearTimeout(dozeTimer);
    if (quiet) {
      document.addEventListener('mousemove', onQuietHover, { passive: true, capture: true });
      dozeTimer = setTimeout(() => pill.classList.add('dozing'), 5000);
    } else {
      pill.classList.remove('dozing');
      for (const m of markers.values()) if (m.node) m.node.classList.remove('near');
    }
  }

  function applySettings(s) {
    settings = s || settings;
    if (!host) return;
    host.setAttribute('data-mood', settings.mood || 'reader');
    applyMood();
    pill.hidden = !visible || !settings.showPill;
    for (const m of [...markers.values()]) {
      if ((m.kind === 'image' && !settings.showImageBadges) || (m.kind === 'text' && !settings.showTextMarkers)) removeMarker(m.key);
    }
  }

  function togglePanel() { if (panel) panel.hidden = !panel.hidden; }
  function isVisible() { return visible; }

  S.overlay = { init, upsertMarker, removeMarker, clearMarkers, setSummary, setVisible, isVisible, togglePanel, applySettings, showPopover, stripInvisible, reposition: schedule };
})();
