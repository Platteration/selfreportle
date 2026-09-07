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
    minImageSize: 80,          // px, rendered width and height
    sensitivity: 'medium',     // stylometry: low | medium | high
    mood: 'reader',            // display density: quiet | reader | forensic
    disabledHosts: [],         // hostnames where the extension stays quiet
  };

  function normalize(raw) {
    const s = { ...DEFAULTS, ...(raw || {}) };
    s.maxImages = clampInt(s.maxImages, 0, 500, DEFAULTS.maxImages);
    s.maxImageBytes = clampInt(s.maxImageBytes, 64 * 1024, 32 * 1024 * 1024, DEFAULTS.maxImageBytes);
    s.minImageSize = clampInt(s.minImageSize, 16, 2000, DEFAULTS.minImageSize);
    if (!['low', 'medium', 'high'].includes(s.sensitivity)) s.sensitivity = 'medium';
    if (!['quiet', 'reader', 'forensic'].includes(s.mood)) s.mood = 'reader';
    if (!Array.isArray(s.disabledHosts)) s.disabledHosts = [];
    s.disabledHosts = s.disabledHosts.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
    return s;
  }

  function clampInt(v, min, max, dflt) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(max, Math.max(min, n));
  }

  function isHostDisabled(settings, hostname) {
    const h = (hostname || '').toLowerCase();
    return settings.disabledHosts.some((d) => h === d || h.endsWith('.' + d));
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

  return { DEFAULTS, normalize, isHostDisabled, load, save };
});
