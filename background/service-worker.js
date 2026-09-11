/*
 * background/service-worker.js — fetches image bytes (cross-origin, with host
 * permissions the content script lacks), parses embedded provenance, stores
 * per-tab results for the popup and updates the toolbar badge.
 */
importScripts('../lib/lexicons.js', '../lib/signals.js', '../lib/settings.js', '../lib/verdicts.js', '../lib/cbor.js', '../lib/x509.js', '../lib/c2pa-verify.js', '../lib/image-metadata.js', '../lib/history.js', '../lib/fetch-policy.js');

const S = self.SRL;
const results = new Map();          // tabId → page result
const imageCache = new Map();       // url → { signals, metadata, format }
const IMAGE_CACHE_MAX = 400;
const MAX_IMAGES_PER_MESSAGE = 32;   // the content script sends six
const FETCH_TIMEOUT_MS = 20000;
const CONCURRENCY = 4;

/*
 * What one tab may spend.
 *
 * The content script's own cap counts URLs it has handed over, which bounds
 * an honest page; it does not bound a page that reloads the content script,
 * and nothing in here bounded the caller at all. Twenty ordinary batches from
 * one tab pulled 640 requests and 2.6 GB with the reader's IP address on
 * them. The budget is charged where the fetch is issued and where its bytes
 * are read, refilled only by the clock, and reset when the tab navigates or
 * closes — the two places a page stops being the same page.
 */
const BUDGET_WINDOW_MS = 60000;
const BUDGET_REQUESTS = 200;
const BUDGET_BYTES = 64 * 1024 * 1024;
const budgets = new Map();          // tabId → { start, requests, bytes }

function budgetFor(tabId) {
  const now = Date.now();
  let b = budgets.get(tabId);
  if (!b || now - b.start > BUDGET_WINDOW_MS) { b = { start: now, requests: 0, bytes: 0 }; budgets.set(tabId, b); }
  return b;
}

/* True when there is room for one more fetch, which it then charges for. */
function chargeRequest(tabId) {
  if (tabId == null) return true;
  const b = budgetFor(tabId);
  if (b.requests >= BUDGET_REQUESTS || b.bytes >= BUDGET_BYTES) return false;
  b.requests++;
  return true;
}

function chargeBytes(tabId, n) {
  if (tabId == null) return;
  budgetFor(tabId).bytes += n;
}

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({ id: 'srl-inspect-image', title: 'Inspect this image for AI provenance', contexts: ['image'] });
    chrome.contextMenus.create({ id: 'srl-inspect-selection', title: 'Check selected text for AI signals', contexts: ['selection'] });
  } catch (e) { /* already created */ }
});

chrome.commands && chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'toggle-overlay' && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'srl:toggle-overlay' }).catch(() => {});
  }
});

chrome.contextMenus && chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === 'srl-inspect-image') chrome.tabs.sendMessage(tab.id, { type: 'srl:inspect-image', srcUrl: info.srcUrl }).catch(() => {});
  if (info.menuItemId === 'srl-inspect-selection') chrome.tabs.sendMessage(tab.id, { type: 'srl:inspect-selection' }).catch(() => {});
});

/*
 * Only this extension's own content scripts and pages can reach onMessage —
 * there is no externally_connectable — but a handler that acts on whatever
 * tab id or host the caller names is still the wrong shape: srl:get-result
 * is the one that hands back another tab's whole report. A content script
 * gets the tab it is actually running in; only an extension page (the popup
 * and the publisher view, which have no sender.tab) may name one.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (sender.id !== chrome.runtime.id) return false;
  const fromTab = sender.tab && sender.tab.id != null ? sender.tab.id : null;
  switch (msg.type) {
    case 'srl:analyze-images':
      /* Fetching happens on a page's behalf, so there has to be a page: the
       * content script is the only sender, and its URL decides which address
       * spaces the fetches may reach. */
      if (fromTab == null) { sendResponse({ error: 'no sender tab' }); return false; }
      analyzeImages(msg.images || [], msg.settings || {}, sender.url || sender.tab.url || '', fromTab)
        .then(sendResponse, (e) => sendResponse({ error: String(e) }));
      return true;
    case 'srl:page-result': {
      if (fromTab != null) storeResult(fromTab, msg.result);
      sendResponse({ ok: true });
      return false;
    }
    case 'srl:paused': {
      if (fromTab != null) clearTab(fromTab);
      sendResponse({ ok: true });
      return false;
    }
    case 'srl:get-result':
      getResult(fromTab != null ? fromTab : msg.tabId).then(sendResponse);
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
  budgets.delete(tabId);
  chrome.storage.session.remove('tab:' + tabId).catch(() => {});
});

/* The stored copy has to go too, or the popup shows the previous page's
 * report as though it belonged to the new one. */
function clearTab(tabId) {
  results.delete(tabId);
  budgets.delete(tabId);
  chrome.storage.session.remove('tab:' + tabId).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  chrome.action.setTitle({ tabId, title: 'Selfreportle' }).catch(() => {});
  chrome.action.setIcon({ tabId, path: { 16: '/icons/icon16.png', 32: '/icons/icon32.png' } }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    clearTab(tabId);
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

/* The caller's numbers go through the same normaliser the settings page
 * uses, which is where the ceilings live: a byte cap taken on trust is a cap
 * of whatever the caller felt like, and fetchBytes buffers to it. */
async function analyzeImages(images, settings, pageUrl, tabId) {
  const s = S.settings.normalize(settings || {});
  const maxBytes = s.maxImageBytes;
  const maxMedia = s.maxMediaBytes;
  const list = (Array.isArray(images) ? images : []).slice(0, MAX_IMAGES_PER_MESSAGE);
  const out = [];
  let i = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (i < list.length) {
      const img = list[i++];
      out.push(await analyzeOne(img, img.kind === 'av' ? maxMedia : maxBytes, img.kind === 'av' ? maxMedia : 0, pageUrl, tabId));
    }
  });
  await Promise.all(workers);
  return { results: out };
}

async function analyzeOne(img, maxBytes, tailBytes, pageUrl, tabId) {
  const url = img.url || '';
  const base = { id: img.id, url };
  if (img.base64) {
    try {
      const bytes = fromBase64(img.base64);
      /* The page read these out of its own cache, so they are the bytes it
       * rendered — which is the only basis on which a provenance claim may
       * be read as being about the picture the reader is looking at. */
      const analysed = await S.imageMeta.analyzeImageBytes(bytes, { url, truncated: !!img.truncated, rendered: !!img.rendered });
      return { ...base, format: analysed.format, bytes: bytes.length, truncated: !!img.truncated, signals: analysed.signals, metadata: analysed.metadata };
    } catch (e) {
      return { ...base, signals: [{ id: 'unavailable', hard: false, verdict: 'unavailable', strength: 0, label: 'Could not parse image bytes', detail: String(e && e.message ? e.message : e).slice(0, 120) }] };
    }
  }
  const allowed = S.fetchPolicy.mayFetch(url, pageUrl);
  if (!allowed.ok) {
    return { ...base, signals: [{ id: 'unavailable', hard: false, verdict: 'unavailable', strength: 0, label: 'Not fetched', detail: allowed.reason }] };
  }
  const cacheKey = await S.fetchPolicy.cacheKey(url);
  if (cacheKey !== null && imageCache.has(cacheKey)) return { ...base, ...imageCache.get(cacheKey), cached: true };
  if (!chargeRequest(tabId)) {
    return { ...base, signals: [{ id: 'unavailable', hard: false, verdict: 'unavailable', strength: 0, label: 'Not fetched', detail: 'this page has already had the extension fetch its share of media for the minute' }] };
  }
  let outcome;
  try {
    const { bytes, truncated, contentType } = await fetchBytes(url, maxBytes, pageUrl, tabId);
    const analysed = await S.imageMeta.analyzeImageBytes(bytes, { url, truncated });
    outcome = { format: analysed.format, contentType, bytes: bytes.length, truncated, signals: analysed.signals, metadata: analysed.metadata };
    /* Many MP4s put their index (and so the Content Credentials) at the end
     * of the file, which a prefix fetch never sees. Ask for the tail once. */
    if (tailBytes && truncated && !(analysed.metadata && analysed.metadata.c2pa) && /^isobmff/.test(analysed.format) && S.imageMeta.isobmffNeedsTail(bytes)) {
      const tail = chargeRequest(tabId) ? await fetchTail(url, tailBytes, pageUrl, tabId) : null;
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
  /* Failures are not cached: a single timeout would otherwise pin the URL to
   * "could not fetch" for the worker's lifetime, including on an explicit
   * right-click re-inspection. */
  const failed = outcome.signals.length === 1 && outcome.signals[0].id === 'unavailable';
  if (!failed && cacheKey !== null) {
    if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
    imageCache.set(cacheKey, outcome);
  }
  return { ...base, ...outcome };
}

/* A suffix range request. Servers that ignore Range return the whole body,
 * so the result is only used when it actually parses as a credential store. */
async function fetchTail(url, n, pageUrl, tabId) {
  if (!/^https?:/i.test(url)) return null;
  if (!S.fetchPolicy.mayFetch(url, pageUrl).ok) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=-' + n }, credentials: 'omit', redirect: redirectMode(pageUrl), signal: controller.signal });
    if (res.type === 'opaqueredirect') return null;
    if (res.status !== 206) return null;
    if (!landedSomewhereAllowed(res, url, pageUrl)) return null;
    const buf = await res.arrayBuffer();
    chargeBytes(tabId, buf.byteLength);
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

/*
 * Redirects.
 *
 * `redirect: 'follow'` has the user agent perform every hop before the fetch
 * settles, so checking where it landed afterwards can only refuse the read:
 * the GET has already been delivered. A page that names a redirector it
 * controls would still get the request made to loopback or to a router on
 * the reader's network, which is the capability this policy exists to
 * remove, not merely to keep the bytes from.
 *
 * `redirect: 'manual'` does not perform the redirect at all — the fetch
 * settles as an opaque-redirect response, with no status, headers or
 * Location to read. Where it would have gone therefore cannot be checked,
 * so it is refused: an image behind a redirect is reported as not fetched
 * rather than followed blind. That is the trade, and it is the reason the
 * mode is chosen per page rather than globally.
 *
 * The one page that still follows is one already sitting in the most private
 * space there is — a local page, `file:` included — because the policy lets
 * such a page reach every space anyway, so a redirect can take the worker
 * nowhere the page could not have named outright. That is what keeps a
 * file:// album and a localhost fixture reading their own images.
 */
function redirectMode(pageUrl) {
  return S.fetchPolicy.callerSpace(pageUrl) === 'local' ? 'follow' : 'manual';
}

/*
 * Where the request actually ended up, for the one case that still follows.
 * `res.url` is the URL the bytes came from, so it catches a hop the first
 * check never saw; it is a check on what was read, and the mode above is
 * what decides whether a private address is reached at all.
 */
function landedSomewhereAllowed(res, url, pageUrl) {
  const finalUrl = res.url || url;
  if (finalUrl === url) return true;
  return S.fetchPolicy.mayFetch(finalUrl, pageUrl).ok;
}

async function fetchBytes(url, maxBytes, pageUrl, tabId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers = /^https?:/i.test(url) ? { Range: 'bytes=0-' + (maxBytes - 1) } : {};
    const res = await fetch(url, { headers, credentials: 'omit', redirect: redirectMode(pageUrl), signal: controller.signal });
    if (res.type === 'opaqueredirect') throw new Error('the URL redirects, and a redirect is not followed for this page');
    if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
    if (!landedSomewhereAllowed(res, url, pageUrl)) throw new Error('redirected to an address this page may not reach');
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
        chargeBytes(tabId, maxBytes - total);
        total = maxBytes;
        truncated = true;
        try { await reader.cancel(); } catch (e) { /* ignore */ }
        break;
      }
      chunks.push(value);
      total += value.length;
      chargeBytes(tabId, value.length);
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
