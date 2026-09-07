/*
 * lib/history.js — a local-only record of what was found per domain.
 *
 * One page tells you little; a pattern across a domain tells you a lot. This
 * keeps counters (not URLs, not page content) in chrome.storage.local, on the
 * user's machine only, capped and prunable, and off by default for anyone who
 * would rather keep no record at all.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.history = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const KEY = 'srl:domains';
  const MAX_DOMAINS = 400;

  function blank(host) {
    return { host, pages: 0, aiPages: 0, disclosedPages: 0, images: 0, aiImages: 0, tools: {}, firstSeen: 0, lastSeen: 0 };
  }

  /* Folds one page result into a domain record. Pure, so it is testable. */
  function fold(rec, result, now) {
    const r = rec || blank(result.hostname);
    const counts = (result.images && result.images.counts) || {};
    const aiImages = (counts['ai-generated'] || 0) + (counts['ai-edited'] || 0) + (counts['ai-disclosed'] || 0);
    const overall = result.overall;
    r.pages += 1;
    if (overall === 'undisclosed-ai' || overall === 'disclosed-ai') r.aiPages += 1;
    if (overall === 'disclosed-ai') r.disclosedPages += 1;
    r.images += (result.images && result.images.total) || 0;
    r.aiImages += aiImages;
    for (const sys of result.aiSystems || []) {
      if (!sys.id) continue;
      r.tools[sys.id] = (r.tools[sys.id] || 0) + 1;
    }
    r.firstSeen = r.firstSeen || now;
    r.lastSeen = now;
    return r;
  }

  /* A one-line reading of the record, or null when there is not enough of it. */
  function summarize(rec) {
    if (!rec || rec.pages < 2) return null;
    const tools = Object.entries(rec.tools).sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]);
    const share = rec.aiPages / rec.pages;
    let tone = 'none';
    if (share >= 0.6) tone = 'high';
    else if (share > 0) tone = 'some';
    return {
      pages: rec.pages,
      aiPages: rec.aiPages,
      disclosedPages: rec.disclosedPages,
      aiImages: rec.aiImages,
      images: rec.images,
      tools,
      tone,
      text: rec.aiPages === 0
        ? 'No AI markers on any of the ' + rec.pages + ' pages you have opened here.'
        : 'AI markers on ' + rec.aiPages + ' of ' + rec.pages + ' pages you have opened here'
          + (rec.disclosedPages ? ', disclosed on ' + rec.disclosedPages : ', none of them disclosed')
          + (rec.aiImages ? '; ' + rec.aiImages + ' of ' + rec.images + ' images carried AI provenance' : '')
          + '.',
    };
  }

  /* Keeps the most recently seen domains when the cap is exceeded. */
  function prune(all, max) {
    const keys = Object.keys(all);
    if (keys.length <= (max || MAX_DOMAINS)) return all;
    const keep = keys.sort((a, b) => (all[b].lastSeen || 0) - (all[a].lastSeen || 0)).slice(0, max || MAX_DOMAINS);
    const out = {};
    for (const k of keep) out[k] = all[k];
    return out;
  }

  async function readAll() {
    if (typeof chrome === 'undefined' || !chrome.storage) return {};
    try {
      const got = await chrome.storage.local.get(KEY);
      return got[KEY] || {};
    } catch (e) { return {}; }
  }

  async function record(result, now = Date.now()) {
    if (!result || !result.hostname) return null;
    const all = await readAll();
    all[result.hostname] = fold(all[result.hostname], result, now);
    const pruned = prune(all, MAX_DOMAINS);
    try { await chrome.storage.local.set({ [KEY]: pruned }); } catch (e) { /* quota */ }
    return pruned[result.hostname];
  }

  async function get(host) {
    const all = await readAll();
    return all[host] || null;
  }

  async function clear() {
    try { await chrome.storage.local.remove(KEY); } catch (e) { /* ignore */ }
  }

  return { KEY, MAX_DOMAINS, blank, fold, summarize, prune, readAll, record, get, clear };
});
