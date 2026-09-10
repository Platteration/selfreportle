/*
 * lib/fetch-policy.js — which URLs the service worker is allowed to fetch,
 * and how a fetched URL is keyed in the cache.
 *
 * The worker fetches with <all_urls> host permissions, so its requests are
 * not subject to the page's CSP, its mixed-content rules or Chrome's Private
 * Network Access checks. The URLs come from attributes the page wrote, so
 * without a rule here any site could aim the extension at 127.0.0.1,
 * 192.168.x.x or 169.254.169.254 and use the reader's network position.
 *
 * The rule is the one Private Network Access uses: a document may reach its
 * own address space or a less private one, never a more private one. A page
 * on localhost may read localhost (that is how the test fixtures work); a
 * page on the public internet may not.
 *
 * Nothing here resolves DNS — a worker cannot — so a public name that
 * resolves to a private address still gets through. This closes the direct
 * literal-address path, which is the one a page can rely on.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.fetchPolicy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* More private = higher. A fetch is allowed when the target's rank is no
   * higher than the requesting page's. */
  const RANK = { public: 0, private: 1, local: 2 };

  const LOCAL_HOST_RE = /^(?:localhost|ip6-localhost|ip6-loopback)$/;
  const LOCAL_SUFFIX_RE = /\.(?:localhost|local|home\.arpa|internal)$/;

  /*
   * The host in the form a resolver treats it. A trailing dot marks a name as
   * already fully qualified, and it resolves to exactly the same place:
   * `localhost.` is loopback, `router.local.` is the same mDNS responder.
   * `new URL` keeps that dot on a domain (only IPv4 literals are
   * canonicalised), so every rule below has to be matched against a host with
   * it removed — otherwise one extra character walks past all of them, which
   * is the whole of the boundary this file exists to draw. Empty labels do
   * not resolve, so a run of trailing dots is stripped as well rather than
   * being left to fail open, and the result is lower-cased once here so no
   * rule has to remember to.
   */
  function canonicalHost(host) {
    return String(host == null ? '' : host).toLowerCase().replace(/\.+$/, '');
  }

  function parse(url) {
    try { return new URL(String(url)); } catch (e) { return null; }
  }

  /* An IPv4 literal as four numbers, or null when the host is a name. */
  function ipv4(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return null;
    const parts = m.slice(1).map((n) => parseInt(n, 10));
    return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
  }

  function ipv4Space(p) {
    const [a, b, c] = p;
    if (a === 127 || a === 0) return 'local';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'private';       // link-local, incl. 169.254.169.254
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT
    // 192.0.0.0/24 (IETF protocol assignments) and 192.0.2.0/24 (TEST-NET-1)
    // only: the rest of 192.0.0.0/16 is ordinary routed space, and refusing
    // all of it reported real images as 'Not fetched' for no reason.
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return 'private';
    return 'public';
  }

  /*
   * The eight groups of an IPv6 literal, or null. `new URL` hands back the
   * compressed hexadecimal form — ::ffff:10.0.0.1 comes out as ::ffff:a00:1 —
   * so the text cannot be matched directly and has to be expanded first.
   */
  function ipv6Groups(host) {
    const h = host.replace(/^\[|\]$/g, '').toLowerCase().split('%')[0];
    if (!/^[0-9a-f:.]*$/.test(h) || h.indexOf(':') < 0) return null;
    const halves = h.split('::');
    if (halves.length > 2) return null;
    const expand = (part) => {
      if (!part) return [];
      const out = [];
      for (const piece of part.split(':')) {
        if (piece.indexOf('.') >= 0) {
          const p = ipv4(piece);
          if (!p) return null;
          out.push((p[0] << 8) | p[1], (p[2] << 8) | p[3]);
        } else {
          if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
          out.push(parseInt(piece, 16));
        }
      }
      return out;
    };
    const head = expand(halves[0]);
    const tail = halves.length === 2 ? expand(halves[1]) : [];
    if (head === null || tail === null) return null;
    if (halves.length === 1) return head.length === 8 ? head : null;
    const gap = 8 - head.length - tail.length;
    if (gap < 0) return null;
    return [...head, ...new Array(gap).fill(0), ...tail];
  }

  function ipv6Space(host) {
    const g = ipv6Groups(host);
    if (!g) return null;
    if (g.every((x, i) => (i === 7 ? x === 1 : x === 0))) return 'local';   // ::1
    if (g.every((x) => x === 0)) return 'local';                            // ::
    // An IPv4-mapped or -compatible address carries the v4 rules with it.
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      return ipv4Space([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
    }
    if ((g[0] & 0xfe00) === 0xfc00) return 'private';   // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return 'private';   // fe80::/10 link-local
    return 'public';
  }

  /*
   * The address space a URL names: 'local', 'private' or 'public'. Schemes
   * that never touch the network answer 'inline'; anything unrecognised
   * answers null, which is refused rather than guessed at.
   */
  function addressSpace(url) {
    const u = parse(url);
    if (!u) return null;
    const scheme = u.protocol.toLowerCase();
    if (scheme === 'data:') return 'inline';
    if (scheme === 'file:') return 'local';
    if (scheme !== 'http:' && scheme !== 'https:') return null;
    const host = canonicalHost(u.hostname);
    if (!host) return null;
    if (host.startsWith('[')) return ipv6Space(host) || 'public';
    const v6 = host.indexOf(':') >= 0 ? ipv6Space(host) : null;
    if (v6) return v6;
    if (LOCAL_HOST_RE.test(host) || LOCAL_SUFFIX_RE.test(host)) return 'local';
    const p = ipv4(host);
    if (p) return ipv4Space(p);
    return 'public';
  }

  /*
   * May the worker fetch `url` on behalf of a page at `pageUrl`?
   *
   * Returns { ok, space, reason }. `reason` is short enough to show as the
   * detail of an 'unavailable' signal, and says what was refused, not how to
   * get around it.
   */
  function mayFetch(url, pageUrl) {
    const space = addressSpace(url);
    if (space === null) return { ok: false, space: null, reason: 'unsupported URL scheme' };
    if (space === 'inline') return { ok: true, space, reason: '' };
    const from = addressSpace(pageUrl);
    /* An unknown caller is treated as the least privileged one. */
    const fromSpace = from === 'inline' || from === null ? 'public' : from;
    const scheme = (parse(url).protocol || '').toLowerCase();
    if (scheme === 'file:' && (parse(pageUrl) || {}).protocol !== 'file:') {
      return { ok: false, space, reason: 'a file: resource may only be read for a page that is itself a local file' };
    }
    if (RANK[space] > RANK[fromSpace]) {
      return { ok: false, space, reason: 'the page is ' + fromSpace + ' but this address is ' + space + ', so the extension will not fetch it on the page\'s behalf' };
    }
    return { ok: true, space, reason: '' };
  }

  /*
   * A cache key that cannot collide. Truncating a long URL to a prefix made
   * two signed CDN URLs that differ only in a trailing token share one
   * provenance verdict, which for this tool is the worst possible failure:
   * image B reported with image A's credentials. A digest is fixed-size and
   * keeps the memory bound the truncation was there for.
   */
  const KEY_LIMIT = 2000;

  async function cacheKey(url) {
    const s = String(url);
    if (s.length <= KEY_LIMIT) return s;
    const subtle = typeof crypto !== 'undefined' && crypto.subtle;
    if (!subtle) return null;   // no key rather than a colliding one
    const digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(s)));
    let hex = '';
    for (const b of digest) hex += b.toString(16).padStart(2, '0');
    return 'sha256:' + hex;
  }

  return { RANK, canonicalHost, addressSpace, mayFetch, cacheKey, KEY_LIMIT };
});
