/*
 * lib/settings.js — user settings: every storage key this extension writes,
 * validation of what comes back out, and the one migration (chrome.storage).
 *
 * Stored values are input. chrome.storage.sync is the browser's own copy of
 * what an earlier or later build of this extension wrote, on this device or
 * another one, so nothing read from it is taken on type: each field falls
 * back to its default on its own, never the record as a whole, and a lookup
 * in an enum table is an own-property check — every name on Object.prototype
 * is truthy on a plain table.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.settings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    showPill: true,            // floating summary pill in the page
    showImageBadges: true,     // per-image badges
    showTextMarkers: true,     // per-paragraph markers
    markUnflaggedImages: false, // also badge images with no signals
    fetchImages: true,         // fetch image bytes to read embedded metadata
    maxImages: 60,             // per page
    maxImageBytes: 4 * 1024 * 1024,
    inspectMedia: true,        // read Content Credentials from video and audio
    maxMediaBytes: 512 * 1024, // head, and again for the tail, per media file
    minImageSize: 80,          // px, rendered width and height
    sensitivity: 'medium',     // stylometry: low | medium | high
    mood: 'reader',            // display density: quiet | reader | forensic
    platformLabels: true,      // read AI labels applied by Instagram, TikTok, YouTube…
    rememberDomains: true,     // keep local per-domain counters
    disabledHosts: [],         // hostnames where the extension stays quiet
  };

  /*
   * The key table. `sync` holds the two settings records: the object under
   * `settings` carries every field of DEFAULTS but one, and `disabledHosts`
   * is its own item so that QUOTA_BYTES_PER_ITEM bounds the host list alone,
   * as it did when each field was an item; folded into the object it would
   * cap the whole record. `local` holds the domain memory (lib/history.js
   * reads its key from here). Per-tab results live in `session` under
   * 'tab:<id>' and end with the tab; they are a cache, not a record.
   */
  const KEYS = Object.freeze({
    settings: 'selfreportle.settings.v1',
    disabledHosts: 'selfreportle.disabledHosts.v1',
    domains: 'srl:domains',
  });
  /* 0.1.0 stored each field of DEFAULTS as its own sync item. load() moves
   * them under KEYS once and removes them only after the copy is stored. */
  const LEGACY_KEYS = Object.freeze(Object.keys(DEFAULTS));
  const LEGACY_HOSTS_KEY = 'disabledHosts';

  const SENSITIVITY = Object.freeze({ low: true, medium: true, high: true });
  const MOOD = Object.freeze({ quiet: true, reader: true, forensic: true });
  const TABLES = Object.freeze({ sensitivity: SENSITIVITY, mood: MOOD });
  /* Inclusive bounds for every numeric field; the same ones the options
   * page's inputs declare. */
  const RANGES = Object.freeze({
    maxImages: [0, 500],
    maxImageBytes: [64 * 1024, 32 * 1024 * 1024],
    maxMediaBytes: [64 * 1024, 8 * 1024 * 1024],
    minImageSize: [16, 2000],
  });

  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /* Own-property membership only: `'constructor' in TABLE` is true. */
  function has(table, value) {
    return typeof value === 'string' && own(table, value);
  }
  function pick(value, table, fallback) { return has(table, value) ? value : fallback; }
  function bool(value, fallback) { return typeof value === 'boolean' ? value : fallback; }
  function int(value, min, max, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(value)));
  }
  /* A plain object or nothing: an array, a string or null has no fields. */
  function fields(raw) {
    return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }

  /* A hostname as a resolver treats it: lower case, no trailing dot. The dot
   * is optional syntax for the same name — `example.com.` and `example.com`
   * are one host — but `new URL` and `location.hostname` keep it, so a rule
   * keyed on a name has to strip it or the name silently stops matching.
   * lib/fetch-policy.js does the same for the addresses the worker may
   * fetch, where the same character was a way past the whole policy. */
  function canonicalHost(hostname) {
    return (typeof hostname === 'string' ? hostname : '').trim().toLowerCase().replace(/\.+$/, '');
  }

  /* The paused-host list: strings only, canonicalised, empties dropped. A
   * stored entry that is not a string is not a host, and String() on an
   * object with a `toString` of its own throws, which used to hang load(). */
  function cleanHosts(raw, fallback) {
    if (!Array.isArray(raw)) return (fallback || []).slice();
    const out = [];
    for (const h of raw) {
      if (typeof h !== 'string') continue;
      const c = canonicalHost(h);
      if (c) out.push(c);
    }
    return out;
  }

  /* One settings record, field by field: an enum by its table, a boolean
   * only as a boolean, a number only as a number and within its range,
   * anything else its default. Unknown fields are dropped, so an own
   * `__proto__` key or a field a later build adds never reaches a caller. */
  function cleanSettings(raw, fallback) {
    const r = fields(raw);
    const d = fallback || DEFAULTS;
    const out = {};
    for (const k of Object.keys(d)) {
      const dv = d[k];
      const v = own(r, k) ? r[k] : undefined;
      if (own(TABLES, k)) out[k] = pick(v, TABLES[k], dv);
      else if (k === LEGACY_HOSTS_KEY) out[k] = cleanHosts(v, dv);
      else if (typeof dv === 'boolean') out[k] = bool(v, dv);
      else if (typeof dv === 'number') out[k] = int(v, RANGES[k][0], RANGES[k][1], dv);
      else out[k] = dv;
    }
    return out;
  }

  /* The worker normalises the numbers a content script sends with the same
   * rules, because the ceilings live here. */
  function normalize(raw) { return cleanSettings(raw, DEFAULTS); }

  function isHostDisabled(settings, hostname) {
    const h = canonicalHost(hostname);
    if (!h) return false;
    return (settings.disabledHosts || []).some((raw) => {
      const d = canonicalHost(raw);
      return !!d && (h === d || h.endsWith('.' + d));
    });
  }

  const available = () => typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.sync;

  /*
   * The migration, per record: read NEW; present → NEW wins and OLD goes;
   * absent → OLD is copied under NEW byte for byte, no validation, and OLD
   * is removed only once that write has resolved. A write that fails leaves
   * OLD for the next load to try again; a remove that fails leaves both,
   * which the next load reads as "NEW wins". There is no flag to lose:
   * "NEW present" is the idempotence. Every reader goes through load(), so
   * this is the one chokepoint, and concurrent content scripts all copy the
   * same bytes, so their race is harmless.
   *
   * Returns the raw records to validate: `settings` for the object and
   * `hosts` for the list, each undefined when nothing was stored.
   */
  async function migrate(got) {
    const out = {};
    const write = {};
    const legacySettingKeys = LEGACY_KEYS.filter((k) => k !== LEGACY_HOSTS_KEY);
    if (own(got, KEYS.settings)) out.settings = got[KEYS.settings];
    else if (legacySettingKeys.some((k) => own(got, k))) {
      const copy = {};
      for (const k of legacySettingKeys) if (own(got, k)) copy[k] = got[k];
      out.settings = write[KEYS.settings] = copy;
    }
    if (own(got, KEYS.disabledHosts)) out.hosts = got[KEYS.disabledHosts];
    else if (own(got, LEGACY_HOSTS_KEY)) out.hosts = write[KEYS.disabledHosts] = got[LEGACY_HOSTS_KEY];
    if (Object.keys(write).length) {
      try { await chrome.storage.sync.set(write); } catch (e) { return out; }
    }
    const stale = LEGACY_KEYS.filter((k) => own(got, k));
    if (stale.length) {
      try { await chrome.storage.sync.remove(stale); } catch (e) { /* next load */ }
    }
    return out;
  }

  async function load() {
    if (!available()) return cleanSettings({}, DEFAULTS);
    let got;
    try { got = await chrome.storage.sync.get([KEYS.settings, KEYS.disabledHosts, ...LEGACY_KEYS]); } catch (e) { return cleanSettings({}, DEFAULTS); }
    const raw = await migrate(fields(got));
    const s = cleanSettings(raw.settings, DEFAULTS);
    s.disabledHosts = cleanHosts(raw.hosts, DEFAULTS.disabledHosts);
    return s;
  }

  /* Writes both records; rejects when the browser refuses (a host list past
   * QUOTA_BYTES_PER_ITEM), so the caller can say so rather than flash Saved. */
  async function save(patch) {
    const merged = cleanSettings(Object.assign({}, await load(), fields(patch)), DEFAULTS);
    const record = {};
    for (const k of Object.keys(merged)) if (k !== LEGACY_HOSTS_KEY) record[k] = merged[k];
    await chrome.storage.sync.set({ [KEYS.settings]: record, [KEYS.disabledHosts]: merged.disabledHosts });
    return merged;
  }

  /* Settings only: the two records and any legacy item a failed remove left
   * behind, which the next load() would otherwise copy back over the
   * defaults. Domain memory (local) and the image cache (worker memory) are
   * their own actions on the options page. */
  async function reset() {
    await chrome.storage.sync.remove([KEYS.settings, KEYS.disabledHosts, ...LEGACY_KEYS]);
  }

  return {
    DEFAULTS, KEYS, LEGACY_KEYS, SENSITIVITY, MOOD, RANGES,
    has, pick, bool, int, cleanSettings, cleanHosts, normalize,
    canonicalHost, isHostDisabled, load, save, reset,
  };
});
