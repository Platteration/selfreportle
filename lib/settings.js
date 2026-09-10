/* lib/settings.js — user settings with defaults (chrome.storage.sync). */
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

  function normalize(raw) {
    const s = { ...DEFAULTS, ...(raw || {}) };
    s.maxImages = clampInt(s.maxImages, 0, 500, DEFAULTS.maxImages);
    s.maxImageBytes = clampInt(s.maxImageBytes, 64 * 1024, 32 * 1024 * 1024, DEFAULTS.maxImageBytes);
    s.maxMediaBytes = clampInt(s.maxMediaBytes, 64 * 1024, 8 * 1024 * 1024, DEFAULTS.maxMediaBytes);
    s.minImageSize = clampInt(s.minImageSize, 16, 2000, DEFAULTS.minImageSize);
    if (!['low', 'medium', 'high'].includes(s.sensitivity)) s.sensitivity = 'medium';
    if (!['quiet', 'reader', 'forensic'].includes(s.mood)) s.mood = 'reader';
    if (!Array.isArray(s.disabledHosts)) s.disabledHosts = [];
    s.disabledHosts = s.disabledHosts.map(canonicalHost).filter(Boolean);
    return s;
  }

  function clampInt(v, min, max, dflt) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  /* A hostname as a resolver treats it: lower case, no trailing dot. The dot
   * is optional syntax for the same name — `example.com.` and `example.com`
   * are one host — but `new URL` and `location.hostname` keep it, so a rule
   * keyed on a name has to strip it or the name silently stops matching.
   * lib/fetch-policy.js does the same for the addresses the worker may
   * fetch, where the same character was a way past the whole policy. */
  function canonicalHost(hostname) {
    return String(hostname == null ? '' : hostname).trim().toLowerCase().replace(/\.+$/, '');
  }

  function isHostDisabled(settings, hostname) {
    const h = canonicalHost(hostname);
    if (!h) return false;
    return (settings.disabledHosts || []).some((raw) => {
      const d = canonicalHost(raw);
      return !!d && (h === d || h.endsWith('.' + d));
    });
  }

  async function load() {
    if (typeof chrome === 'undefined' || !chrome.storage) return normalize({});
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (raw) => resolve(normalize(raw)));
      } catch (e) {
        resolve(normalize({}));
      }
    });
  }

  async function save(patch) {
    const merged = normalize({ ...(await load()), ...patch });
    return new Promise((resolve) => chrome.storage.sync.set(merged, () => resolve(merged)));
  }

  return { DEFAULTS, normalize, canonicalHost, isHostDisabled, load, save };
});
