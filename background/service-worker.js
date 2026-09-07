/*
 * background/service-worker.js — fetches image bytes (cross-origin, with host
 * permissions the content script lacks), parses embedded provenance, stores
 * per-tab results for the popup and updates the toolbar badge.
 */
importScripts('../lib/lexicons.js', '../lib/signals.js', '../lib/settings.js', '../lib/verdicts.js', '../lib/cbor.js', '../lib/x509.js', '../lib/c2pa-verify.js', '../lib/image-metadata.js', '../lib/history.js');

const S = self.SRL;
const results = new Map();          // tabId → page result
const imageCache = new Map();       // url → { signals, metadata, format }
const IMAGE_CACHE_MAX = 400;
const FETCH_TIMEOUT_MS = 20000;
const CONCURRENCY = 4;

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({ id: 'srl-inspect-image', title: 'Inspect this image for AI provenance', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'srl-inspect-selection', title: 'Check selected text for AI signals', contexts: ['selection'] });
  } catch (e) { /* already created */ }
});

chrome.contextMenus && chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === 'srl-inspect-image') chrome.tabs.sendMessage(tab.id, { type: 'srl:inspect-image', srcUrl: info.srcUrl }).catch(() => {});
  if (info.menuItemId === 'srl-inspect-selection') chrome.tabs.sendMessage(tab.id, { type: 'srl:inspect-selection' }).catch(() => {});
});

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
    case 'srl:get-history':
      S.history.get(msg.host).then((rec) => sendResponse({ record: rec, summary: S.history.summarize(rec) }));
      return true;
    case 'srl:clear-history':
      S.history.clear().then(() => sendResponse({ ok: true }));
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
    chrome.action.setIcon({ tabId, path: { 16: '/icons/icon16.png', 32: '/icons/icon32.png' } }).catch(() => {});
  }
});

async function storeResult(tabId, result) {
  results.set(tabId, result);
  try { await chrome.storage.session.set({ ['tab:' + tabId]: result }); } catch (e) { /* ignore */ }
  updateBadge(tabId, result);
  recordHistory(result).catch(() => {});
}

/* One record per page load, not per incremental update. */
const historySeen = new Map();
async function recordHistory(result) {
  if (!result || !result.hostname || !/^https?:/i.test(result.url || '')) return;
  const settings = await S.settings.load();
  if (!settings.rememberDomains) return;
  const stamp = result.url + '|' + result.at;
  if (historySeen.get(result.hostname) === stamp) return;
  historySeen.set(result.hostname, stamp);
  if (historySeen.size > 200) historySeen.delete(historySeen.keys().next().value);
  await S.history.record(result);
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

const STATE_ICONS = ['undisclosed-ai', 'disclosed-ai', 'weak-ai', 'provenance', 'none'];

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
  if (STATE_ICONS.includes(overall)) {
    chrome.action.setIcon({ tabId, path: { 16: '/icons/state-' + overall + '-16.png', 32: '/icons/state-' + overall + '-32.png' } }).catch(() => {});
  }
}

/* ---- image fetching ---------------------------------------------------- */

async function analyzeImages(images, settings) {
  const maxBytes = Math.max(65536, settings.maxImageBytes || S.settings.DEFAULTS.maxImageBytes);
  const maxMedia = Math.max(65536, settings.maxMediaBytes || S.settings.DEFAULTS.maxMediaBytes);
  const out = [];
  let i = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < images.length) {
      const img = images[i++];
      out.push(await analyzeOne(img, img.kind === 'av' ? maxMedia : maxBytes, img.kind === 'av' ? maxMedia : 0));
    }
  });
  await Promise.all(workers);
  return { results: out };
}

async function analyzeOne(img, maxBytes, tailBytes) {
  const url = img.url || '';
  const base = { id: img.id, url };
  if (img.base64) {
    try {
      const bytes = fromBase64(img.base64);
      const analysed = await S.imageMeta.analyzeImageBytes(bytes, { url, truncated: !!img.truncated });
      return { ...base, format: analysed.format, bytes: bytes.length, truncated: !!img.truncated, signals: analysed.signals, metadata: analysed.metadata };
    } catch (e) {
      return { ...base, signals: [{ id: 'unavailable', hard: false, verdict: 'unavailable', strength: 0, label: 'Could not parse image bytes', detail: String(e && e.message ? e.message : e).slice(0, 120) }] };
    }
  }
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
    /* Many MP4s put their index (and so the Content Credentials) at the end
     * of the file, which a prefix fetch never sees. Ask for the tail once. */
    if (tailBytes && truncated && !(analysed.metadata && analysed.metadata.c2pa) && /^isobmff/.test(analysed.format) && S.imageMeta.isobmffNeedsTail(bytes)) {
      const tail = await fetchTail(url, tailBytes);
      if (tail) {
        const fromTail = await S.imageMeta.analyzeImageBytes(tail, { url, truncated: true });
        if (fromTail.metadata && fromTail.metadata.c2pa) {
          outcome.metadata = { ...outcome.metadata, ...fromTail.metadata };
          outcome.signals = [...outcome.signals.filter((s) => s.id !== 'note'), ...fromTail.signals];
          outcome.tailRead = tail.length;
        }
      }
    }
  } catch (e) {
    outcome = { signals: [{ id: 'unavailable', hard: false, verdict: 'unavailable', strength: 0, label: 'Could not fetch image bytes', detail: String(e && e.message ? e.message : e).slice(0, 120) }] };
  }
  if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
  imageCache.set(cacheKey, outcome);
  return { ...base, ...outcome };
}

/* A suffix range request. Servers that ignore Range return the whole body,
 * so the result is only used when it actually parses as a credential store. */
async function fetchTail(url, n) {
  if (!/^https?:/i.test(url)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=-' + n }, credentials: 'omit', signal: controller.signal });
    if (res.status !== 206) return null;
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf.byteLength > n ? buf.slice(buf.byteLength - n) : buf);
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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
