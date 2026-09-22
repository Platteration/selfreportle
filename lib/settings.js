/*
 * lib/settings.js — user settings: every storage key this extension writes,
 * validation of what comes back out, and the one-time copy of the flat
 * items earlier builds wrote under the namespaced keys (chrome.storage).
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
  /* The flat items written before the namespaced record: one sync item per
   * field of DEFAULTS. migrate() copies them under KEYS once, from the
   * worker's onInstalled, and load() reads them whenever KEYS are absent.
   * They are never removed: sync storage is shared with every device on the
   * same profile, and a device still on the old build re-creates them on
   * every save and reads nothing else. */
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

  const ALL_KEYS = [KEYS.settings, KEYS.disabledHosts, ...LEGACY_KEYS];

  /*
   * The raw records to validate, read per record: NEW where present, else
   * the flat items. Both present is the normal state once the copy has run,
   * and NEW wins — an old build on another device writes only the flat
   * items, so they can be newer than NEW and still say nothing this build
   * should read over its own record. `settings` is the object, `hosts` the
   * list, each undefined when nothing was stored.
   */
  function records(got) {
    const out = {};
    const legacySettingKeys = LEGACY_KEYS.filter((k) => k !== LEGACY_HOSTS_KEY);
    if (own(got, KEYS.settings)) out.settings = got[KEYS.settings];
    else if (legacySettingKeys.some((k) => own(got, k))) {
      const copy = {};
      for (const k of legacySettingKeys) if (own(got, k)) copy[k] = got[k];
      out.settings = copy;
    }
    if (own(got, KEYS.disabledHosts)) out.hosts = got[KEYS.disabledHosts];
    else if (own(got, LEGACY_HOSTS_KEY)) out.hosts = got[LEGACY_HOSTS_KEY];
    return out;
  }

  /*
   * The one-time copy of the flat items under KEYS, run from the worker's
   * onInstalled — not from load(), because a reader that writes can lose an
   * update: a load() that had read the flat items and not yet written its
   * copy would land that copy over a save() that completed in between.
   * Per record: NEW present → nothing; absent → write the flat items'
   * bytes, unvalidated. Two set() calls, because sync refuses a whole call
   * when one item is past QUOTA_BYTES_PER_ITEM, and the new host-list key is
   * sixteen bytes longer than the old one: a list that fitted before can be
   * exactly what is refused, and must not take the settings object with it.
   * A refused write leaves the flat items where load() still reads them; the
   * next save() or onInstalled writes NEW. The flat items are never removed
   * (see LEGACY_KEYS). Returns the keys it wrote.
   */
  async function migrate() {
    if (!available()) return [];
    const got = fields(await chrome.storage.sync.get(ALL_KEYS));
    const raw = records(got);
    const pending = [];
    if (!own(got, KEYS.settings) && raw.settings !== undefined) pending.push([KEYS.settings, raw.settings]);
    if (!own(got, KEYS.disabledHosts) && raw.hosts !== undefined) pending.push([KEYS.disabledHosts, raw.hosts]);
    const written = [];
    for (const [key, value] of pending) {
      try { await chrome.storage.sync.set({ [key]: value }); written.push(key); } catch (e) { /* load() reads the flat item meanwhile */ }
    }
    return written;
  }

  /* Read-only: every reader goes through here, and none of them writes. */
  async function load() {
    if (!available()) return cleanSettings({}, DEFAULTS);
    let got;
    try { got = await chrome.storage.sync.get(ALL_KEYS); } catch (e) { return cleanSettings({}, DEFAULTS); }
    const raw = records(fields(got));
    const s = cleanSettings(raw.settings, DEFAULTS);
    s.disabledHosts = cleanHosts(raw.hosts, DEFAULTS.disabledHosts);
    return s;
  }

  const sameHosts = (a, b) => a.length === b.length && a.every((h, i) => h === b[i]);

  /*
   * Writes the settings object, then the host list only when it changed —
   * in two set() calls, so a list the browser refuses (past
   * QUOTA_BYTES_PER_ITEM) refuses only itself. The error for that names the
   * list and carries code 'hosts', because by then the rest is saved and
   * the caller should say so rather than "could not save".
   */
  async function save(patch) {
    const current = await load();
    const merged = cleanSettings(Object.assign({}, current, fields(patch)), DEFAULTS);
    const record = {};
    for (const k of Object.keys(merged)) if (k !== LEGACY_HOSTS_KEY) record[k] = merged[k];
    await chrome.storage.sync.set({ [KEYS.settings]: record });
    if (!sameHosts(merged.disabledHosts, current.disabledHosts)) {
      try { await chrome.storage.sync.set({ [KEYS.disabledHosts]: merged.disabledHosts }); } catch (e) {
        const reason = (e && e.message) || String(e);
        const err = new Error(/quota/i.test(reason)
          ? 'the paused-host list is too long to store; remove some hosts'
          : 'the paused-host list could not be stored: ' + reason);
        err.code = 'hosts';
        throw err;
      }
    }
    return merged;
  }

  /* Settings only: the defaults written under the two records, so NEW wins
   * over whatever the flat items still say. Nothing is removed — not the
   * flat items, which a device on the old build still reads, and not the
   * domain memory (local) or the image cache (worker memory), which are
   * their own actions on the options page. */
  async function reset() {
    const record = {};
    for (const k of Object.keys(DEFAULTS)) if (k !== LEGACY_HOSTS_KEY) record[k] = DEFAULTS[k];
    await chrome.storage.sync.set({ [KEYS.settings]: record });
    await chrome.storage.sync.set({ [KEYS.disabledHosts]: DEFAULTS.disabledHosts.slice() });
  }

  return {
    DEFAULTS, KEYS, LEGACY_KEYS, SENSITIVITY, MOOD, RANGES,
    has, pick, bool, int, cleanSettings, cleanHosts, normalize,
    canonicalHost, isHostDisabled, records, migrate, load, save, reset,
  };
});
