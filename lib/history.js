/*
 * lib/history.js — a local-only record of what was found per domain.
 *
 * One page tells you little; a pattern across a domain tells you a lot. This
 * keeps counters (not URLs, not page content) in chrome.storage.local, on the
 * user's machine only, capped and prunable, and switchable off in the
 * settings for anyone who would rather keep no record at all.
 *
 * It is still a record of which sites were opened, so the timestamps are kept
 * only to the day: enough to expire an old record and to decide what to drop
 * when the cap is reached, not enough to reconstruct a reading session.
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
  const DAY_MS = 24 * 60 * 60 * 1000;
  const MAX_AGE_MS = 90 * DAY_MS;

  /* Day granularity: see the note at the top of the file. */
  function day(now) { return Math.floor(now / DAY_MS) * DAY_MS; }

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
    const today = day(now);
    r.firstSeen = r.firstSeen || today;
    r.lastSeen = today;
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

  /*
   * Drops records nobody has added to in 90 days, then keeps the most
   * recently seen of what is left when the cap is exceeded. The cap alone
   * bounded the size of the store but not its age, so a domain opened once
   * stayed on the list until 400 other domains pushed it off — which on a
   * narrow browsing pattern is never.
   */
  function prune(all, max, now) {
    const limit = max || MAX_DOMAINS;
    let live = all;
    if (now != null) {
      const cutoff = day(now) - MAX_AGE_MS;
      live = {};
      for (const [k, rec] of Object.entries(all)) if ((rec.lastSeen || 0) >= cutoff) live[k] = rec;
    }
    const keys = Object.keys(live);
    if (keys.length <= limit) return live;
    const keep = keys.sort((a, b) => (live[b].lastSeen || 0) - (live[a].lastSeen || 0)).slice(0, limit);
    const out = {};
    for (const k of keep) out[k] = live[k];
    return out;
  }

  async function readAll() {
    if (typeof chrome === 'undefined' || !chrome.storage) return {};
    try {
      const got = await chrome.storage.local.get(KEY);
      return got[KEY] || {};
    } catch (e) { return {}; }
  }

  /*
   * Writes are serialised. record() is a read-modify-write of one shared map,
   * called fire-and-forget from the worker whenever any tab finishes, so two
   * tabs completing together would both read the old map and one would
   * silently overwrite the other's page count. A promise chain is enough:
   * the worker is single-threaded, so ordering is all that is missing.
   */
  let queue = Promise.resolve();

  function record(result, now = Date.now()) {
    if (!result || !result.hostname) return Promise.resolve(null);
    const next = queue.then(async () => {
      const all = await readAll();
      all[result.hostname] = fold(all[result.hostname], result, now);
      const pruned = prune(all, MAX_DOMAINS, now);
      try { await chrome.storage.local.set({ [KEY]: pruned }); } catch (e) { /* quota */ }
      return pruned[result.hostname];
    });
    // The chain must survive a failed write, or every later record is dropped.
    queue = next.catch(() => {});
    return next;
  }

  async function get(host) {
    const all = await readAll();
    return all[host] || null;
  }

  async function clear() {
    try { await chrome.storage.local.remove(KEY); } catch (e) { /* ignore */ }
  }

  return { KEY, MAX_DOMAINS, MAX_AGE_MS, DAY_MS, day, blank, fold, summarize, prune, readAll, record, get, clear };
});
