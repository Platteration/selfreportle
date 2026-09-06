/*
 * background/service-worker.js — fetches image bytes (cross-origin, with host
 * permissions the content script lacks), parses embedded provenance, stores
 * per-tab results for the popup and updates the toolbar badge.
 */
importScripts('../lib/signals.js', '../lib/settings.js', '../lib/verdicts.js', '../lib/cbor.js', '../lib/image-metadata.js');

const S = self.SRL;
const results = new Map();          // tabId → page result
const imageCache = new Map();       // url → { signals, metadata, format }
const IMAGE_CACHE_MAX = 400;
const FETCH_TIMEOUT_MS = 20000;
const CONCURRENCY = 4;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  switch (msg.type) {
    case 'srl:analyze-images':
      analyzeImages(msg.images || [], msg.settings || {}).then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;
    case 'srl:page-result': {
      const tabId = sender.tab && sender.tab.id;
      if (tabId != null) storeResult(tabId, msg.result);
      sendResponse({ ok: true });
      return false;
    }
    case 'srl:get-result':
      getResult(msg.tabId).then(sendResponse);
      return true;
    case 'srl:clear-cache':
      imageCache.clear();
      sendResponse({ ok: true });
      return false;
    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  results.delete(tabId);
  chrome.storage.session.remove('tab:' + tabId).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    results.delete(tabId);
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  }
});

async function storeResult(tabId, result) {
  results.set(tabId, result);
  try { await chrome.storage.session.set({ ['tab:' + tabId]: result }); } catch (e) { /* ignore */ }
  updateBadge(tabId, result);
}

async function getResult(tabId) {
  if (results.has(tabId)) return results.get(tabId);
  try {
    const stored = await chrome.storage.session.get('tab:' + tabId);
    return stored['tab:' + tabId] || null;
  } catch (e) {
    return null;
  }
}

function updateBadge(tabId, result) {
  const overall = S.verdicts.overall(result);
  const counts = (result.images && result.images.counts) || {};
  const flaggedImages = (counts['ai-generated'] || 0) + (counts['ai-edited'] || 0) + (counts['ai-disclosed'] || 0) + (counts.suspected || 0);
  const flaggedText = (result.text && result.text.flaggedBlocks) || 0;
  const flaggedSite = S.verdicts.AI_SITE_VERDICTS.has(result.site && result.site.verdict) ? 1 : 0;
  const n = flaggedImages + flaggedText + flaggedSite;
  const color = S.verdicts.OVERALL[overall].color;
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  chrome.action.setBadgeTextColor && chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: n > 0 ? String(Math.min(n, 99)) : (overall === 'provenance' ? '✓' : '') }).catch(() => {});
  chrome.action.setTitle({ tabId, title: 'Selfreportle: ' + S.verdicts.OVERALL[overall].label }).catch(() => {});
}

/* ---- image fetching ---------------------------------------------------- */

async function analyzeImages(images, settings) {
  const maxBytes = Math.max(65536, settings.maxImageBytes || S.settings.DEFAULTS.maxImageBytes);
  const out = [];
  let i = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < images.length) {
      const img = images[i++];
      out.push(await analyzeOne(img, maxBytes));
    }
  });
  await Promise.all(workers);
  return { results: out };
}

async function analyzeOne(img, maxBytes) {
  const url = img.url || '';
  const base = { id: img.id, url };
  if (!/^(https?|data|file):/i.test(url)) {
    return { ...base, signals: [{ id: 'unavailable', hard: false, verdict: 'unavailable', strength: 0, label: 'Cannot fetch this image type', detail: url.slice(0, 12) + '…' }] };
  }
  const cacheKey = url.length > 2000 ? url.slice(0, 2000) + '#' + url.length : url;
  if (imageCache.has(cacheKey)) return { ...base, ...imageCache.get(cacheKey), cached: true };
  let outcome;
  try {
    const { bytes, truncated, contentType } = await fetchBytes(url, maxBytes);
    const analysed = await S.imageMeta.analyzeImageBytes(bytes, { url, truncated });
    outcome = { format: analysed.format, contentType, bytes: bytes.length, truncated, signals: analysed.signals, metadata: analysed.metadata };
  } catch (e) {
    outcome = { signals: [{ id: 'unavailable', hard: false, verdict: 'unavailable', strength: 0, label: 'Could not fetch image bytes', detail: String(e && e.message ? e.message : e).slice(0, 120) }] };
  }
  if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  imageCache.set(cacheKey, outcome);
  return { ...base, ...outcome };
}

async function fetchBytes(url, maxBytes) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = /^https?:/i.test(url) ? { Range: 'bytes=0-' + (maxBytes - 1) } : {};
    const res = await fetch(url, { headers, credentials: 'omit', redirect: 'follow', signal: controller.signal });
    if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
    const contentType = res.headers.get('content-type') || '';
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.length > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        break;
      }
      chunks.push(value);
      total += value.length;
    }
    const lenHeader = res.headers.get('content-range');
    if (lenHeader) {
      const m = /\/(\d+)$/.exec(lenHeader);
      if (m && parseInt(m[1], 10) > total) truncated = true;
    }
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { bytes.set(c, o); o += c.length; }
    return { bytes, truncated, contentType };
  } finally {
    clearTimeout(timer);
  }
}
