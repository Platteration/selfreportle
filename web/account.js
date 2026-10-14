/*
 * web/account.js — sign in with Google and "Support this app", on a host that runs the site's
 * optional API (server/kit on the site's own origin under api/: Cloudflare Pages' function, or
 * server/start.mjs behind nginx). Everywhere else, GitHub Pages and Netlify included, there is
 * no such API and nothing here draws a thing: the page asks api/config once, and an answer of
 * "nothing on" (the api/config the site publishes), a 404, a network error or a body that is not
 * the kit's shape leaves the page as it always was. Nothing is stored and nothing is asked again.
 * The kit's own flags in the address (`?signin=failed`, `?purchase=success|cancelled`) are taken
 * out on arrival on every host, before api/config is asked: they are the kit's, and a reload
 * should not read one twice.
 *
 * Where it is on, the page gains an "Account and support" section (Sign in with Google; then
 * "Signed in as …", Sign out and Delete account) holding the one thing the site sells, "Support
 * this app", and the privacy line above the checker says exactly what then leaves the device. The
 * page then asks api/me once on every load, signed in or not. A purchase is granted by Stripe's
 * signed webhook alone and read back from api/me; it unlocks nothing, so the page shows "Owned"
 * and the checker is the same for everyone. A visitor who edits the page can show themselves
 * "Owned" without paying: it gates nothing, so there is nothing to protect, and the server's
 * record of the payment is what a purchase is.
 *
 * Stripe's webhook can land after Checkout has sent the visitor back. Until api/me reports the
 * purchase, the product reads "Payment received — processing" where Buy was: for the life of the
 * page, and across a reload within PENDING_MS through one record in the tab's sessionStorage
 * (PENDING_KEY), the only thing the page stores. A second Buy there opened a second Checkout
 * Session, and both were paid. Only a signed-in visitor can have paid, so to anyone else a
 * `?purchase=success` link says nothing and asks nothing.
 *
 * Everything the server says is read field by field and drawn as text (createElement, and
 * strings appended as text nodes), never as markup. Sign-in and Checkout are top-level
 * navigations to Google and Stripe, which the page's policy does not govern; the only requests
 * are to the site's own api/ (connect-src 'self'), and none of them carries anything about the
 * file being checked. The extension never loads this file and never calls the API.
 *
 * Loaded after app.js, which has already marked the page started, so a failure here (this file
 * missing, or a throw) leaves the checker working and the safety net (guard.js) quiet.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.account = api;
  if (typeof window !== 'undefined' && root === window && typeof document !== 'undefined') api.boot(window);
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** The product server/catalogue.js sells, and the entitlement a paid one grants. */
  const SUPPORTER = 'supporter';
  /** An id as the kit writes one: a product, an entitlement. */
  const ID = /^[a-z][a-z0-9-]{0,31}$/;
  /** The only place Buy navigates to. */
  const CHECKOUT_ORIGIN = 'https://checkout.stripe.com';
  /** After Checkout sends the visitor back: api/me up to five times over fifteen seconds. */
  const POLL = { tries: 5, everyMs: 3000 };
  /** How long after a paid Checkout sent this tab back a reload still says "processing" rather
   *  than offer Buy, while api/me has not reported the purchase: the webhook's own delay, and the
   *  minute Cloudflare KV can take to reach every location, with room to spare. */
  const PENDING_MS = 10 * 60 * 1000;
  /** The one record the page keeps, in the tab's sessionStorage: `{ at }`, the time (ms) a paid
   *  Checkout sent this tab back. test/settings-contract.test.js pins it. */
  const PENDING_KEY = 'selfreportle.purchasePending.v1';

  /** The words the account and the shop say, the same in every app that carries the kit but for
   *  the thank-you, which names this app, and `processing`, which only some apps have so far. */
  const WORDS = {
    signIn: 'Sign in with Google',
    signedInAs: (email) => 'Signed in as ' + email,
    signedIn: 'Signed in with Google',
    signOut: 'Sign out',
    deleteAccount: 'Delete account',
    signInFailed: "Sign-in didn't complete.",
    buy: 'Buy',
    signInToBuy: 'Sign in to buy',
    owned: 'Owned',
    thanks: 'Thank you for supporting Selfreportle.',
    paymentPending: 'Payment received. It can take a minute to appear — reload to check.',
    processing: 'Payment received — processing',
  };

  /** What the page asks before it deletes an account, and what it says when something fails. */
  const NOTES = {
    deleteBody: 'Delete your account? This deletes your account on this site and the record of your support with it. The payment itself stays with Stripe, with the account id it was made under. This cannot be undone.',
    deleteFailed: 'The account could not be deleted. Try again.',
    signOutFailed: 'Could not sign out. Try again.',
    unavailable: 'Support is not on sale right now.',
    busy: 'Too many tries for now. Try again in a while.',
    failed: 'The shop could not be reached. Try again.',
  };

  const SIGNED_OUT = Object.freeze({ user: null, entitlements: Object.freeze([]) });

  const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

  /** Text of at most `max` characters with no control character, or null. */
  function text(value, max) {
    return typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
  }

  /** A price as Stripe states it, in the currency's smallest unit; null when it is not one. */
  function readPrice(raw) {
    if (!isRecord(raw)) return null;
    const amount = raw.unit_amount;
    const currency = raw.currency;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0) return null;
    if (typeof currency !== 'string' || !/^[a-z]{3}$/.test(currency)) return null;
    return { unitAmount: amount, currency };
  }

  /** `GET api/config`'s body, or null when the feature does not exist: anything that is not the
   *  kit's shape, and a body with sign-in off (the kit sells nothing without it). "Support this
   *  app" is read from the product list when it is there as this site sells it (once, `payment`);
   *  any other product is not this page's to draw. */
  function readConfig(raw) {
    if (!isRecord(raw) || !isRecord(raw.auth) || raw.auth.google !== true) return null;
    const listed = isRecord(raw.shop) && Array.isArray(raw.shop.products) ? raw.shop.products : [];
    let supporter = null;
    for (const item of listed) {
      if (!isRecord(item) || item.id !== SUPPORTER || item.mode !== 'payment') continue;
      const name = text(item.name, 100);
      const description = text(item.description, 500);
      if (!name || description === null) continue;
      supporter = { id: SUPPORTER, name, description, price: readPrice(item.price) };
      break;
    }
    return { supporter };
  }

  /** `GET api/me`'s body, or null when it is not the kit's shape. */
  function readMe(raw) {
    if (!isRecord(raw) || !Array.isArray(raw.entitlements)) return null;
    let user = null;
    if (raw.user !== null) {
      if (!isRecord(raw.user)) return null;
      user = { email: text(raw.user.email, 320) || null };
    }
    const entitlements = [...new Set(raw.entitlements.filter((e) => typeof e === 'string' && ID.test(e)))].slice(0, 50);
    return { user, entitlements };
  }

  /** Stripe's zero-decimal currencies (499 JPY is ¥499) and three-decimal ones (1500 KWD is
   *  1.500 KWD); every other currency is in hundredths. */
  const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
  const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

  /** A price for people to read, in the visitor's locale (undefined: the browser's own); null
   *  when the browser cannot format the currency, and the product is then shown without one. */
  function formatPrice(price, locale) {
    const divisor = ZERO_DECIMAL.has(price.currency) ? 1 : THREE_DECIMAL.has(price.currency) ? 1000 : 100;
    try {
      return new Intl.NumberFormat(locale, { style: 'currency', currency: price.currency.toUpperCase() }).format(price.unitAmount / divisor);
    } catch (e) {
      return null;
    }
  }

  /** What the address said on arrival (the kit's `?signin=failed`, Checkout's `?purchase=`), and
   *  the same address without it, or null when there was nothing of ours to take out. Only the
   *  values the kit writes are read and removed; any other `?purchase=` is not ours and stays. */
  function landingOf(href) {
    let url;
    try { url = new URL(href); } catch (e) { return { landing: { signIn: null, purchase: null }, without: null }; }
    const signin = url.searchParams.get('signin');
    const purchase = url.searchParams.get('purchase');
    const landing = {
      signIn: signin === 'failed' ? 'failed' : null,
      purchase: purchase === 'success' || purchase === 'cancelled' ? purchase : null,
    };
    if (landing.signIn) url.searchParams.delete('signin');
    if (landing.purchase) url.searchParams.delete('purchase');
    if (!landing.signIn && !landing.purchase) return { landing, without: null };
    return { landing, without: url.pathname + url.search + url.hash };
  }

  /** Whether `raw` (what sessionStorage holds at PENDING_KEY, or null) says a paid Checkout sent
   *  this tab back less than PENDING_MS before `now`. Anything else, an unreadable record or a
   *  time in the future included, says no. */
  function pendingSince(raw, now) {
    let value;
    try { value = JSON.parse(raw); } catch (e) { return false; }
    if (!isRecord(value) || !Number.isFinite(value.at)) return false;
    const age = now - value.at;
    return age >= 0 && age < PENDING_MS;
  }

  /** The Checkout address `POST api/checkout` answered with, only when it is Stripe's hosted
   *  page over https (its origin says both) with no credentials in it; anything else is not
   *  followed. */
  function checkoutAddress(raw) {
    if (!isRecord(raw) || typeof raw.url !== 'string') return null;
    let url;
    try { url = new URL(raw.url); } catch (e) { return null; }
    return url.origin === CHECKOUT_ORIGIN && !url.username && !url.password ? url.href : null;
  }

  /** Asks `me` up to POLL.tries times, POLL.everyMs apart, until it reports `entitlement`: a
   *  purchase is granted by Stripe's webhook, which may land after the visitor is back. */
  async function pollFor(entitlement, me, wait) {
    let last = null;
    for (let i = 0; i < POLL.tries; i += 1) {
      await wait(POLL.everyMs);
      last = await me();
      if (last && last.entitlements.includes(entitlement)) return { held: true, me: last };
    }
    return { held: false, me: last };
  }

  /** The site's api/, beside the page at `base`, through `fetch`. Every answer that is not what
   *  the kit sends reads as "not available"; nothing throws. */
  function client({ fetch, base }) {
    const api = (route) => new URL('api/' + route, base).href;
    const body = async (response) => {
      try { return JSON.parse(await response.text()); } catch (e) { return undefined; }
    };
    const call = async (route, init) => {
      try { return await fetch(api(route), Object.assign({ credentials: 'same-origin' }, init)); } catch (e) { return null; }
    };
    return {
      startUrl: (returnPath) => api('auth/google/start') + '?return=' + encodeURIComponent(returnPath),
      async config() {
        const r = await call('config', {});
        return r && r.ok ? readConfig(await body(r)) : null;
      },
      async me() {
        const r = await call('me', { cache: 'no-store' });
        return r && r.ok ? readMe(await body(r)) : null;
      },
      async signOut() {
        const r = await call('auth/logout', { method: 'POST' });
        return !!r && r.status === 204;
      },
      async deleteAccount() {
        const r = await call('me', { method: 'DELETE' });
        return !!r && r.status === 204;
      },
      /** 'signin' (401), 'pending' (409 `payment_pending`: the Checkout Session the visitor was
       *  given has been paid and its webhook has not arrived, which the kit answers from its
       *  canonical b575aee on), 'owned' (any other 409), 'unavailable' (404), 'busy' (429),
       *  'failed' (anything else, an address that is not Stripe's included), or { url } to go to. */
      async checkout(product) {
        const r = await call('checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ product }) });
        if (!r) return 'failed';
        if (r.status === 200) {
          const url = checkoutAddress(await body(r));
          return url ? { url } : 'failed';
        }
        if (r.status === 409) {
          const answer = await body(r);
          return isRecord(answer) && answer.error === 'payment_pending' ? 'pending' : 'owned';
        }
        return { 401: 'signin', 404: 'unavailable', 429: 'busy' }[r.status] || 'failed';
      },
    };
  }

  /**
   * The "Account and support" section. `o` carries what the page provides:
   *   doc       the document, to build elements with
   *   fetch     the browser's fetch
   *   location  the window's location (href, pathname, search, assign)
   *   history   for taking the kit's flags out of the address
   *   confirm   the page's confirm (window.confirm)
   *   wait      a timer, for the poll after a purchase
   *   session   the tab's sessionStorage, for the one record of a payment on its way (absent, or
   *             refusing, a reload forgets that payment; the page itself does not)
   *   now       the clock (Date.now)
   *   els       { section, body, note, privacyLocal, privacyAccount }
   * Returns `ready`, which resolves to whether the feature is on (and never rejects), and the
   * state, for tests.
   */
  function start(o) {
    const api = client({ fetch: o.fetch, base: o.location.href });
    const { landing, without } = landingOf(o.location.href);
    if (without !== null) o.history.replaceState(null, '', without);
    const state = { config: null, me: SIGNED_OUT, busy: false, pending: false };
    const els = o.els;
    const now = o.now || Date.now;

    const el = (tag, cls, ...children) => {
      const node = o.doc.createElement(tag);
      if (cls) node.setAttribute('class', cls);
      node.append(...children);
      return node;
    };
    const button = (label, onClick, id) => {
      const b = el('button', 'btn', label);
      b.setAttribute('type', 'button');
      if (id) b.setAttribute('id', id);
      b.disabled = state.busy;
      b.addEventListener('click', onClick);
      return b;
    };
    /** A short message under the section, read out by a screen reader (role="status"). */
    const note = (message) => { els.note.textContent = message; };
    /** Runs one action at a time: every button of the section is drawn disabled while it is out,
     *  and the last action's note is taken down. */
    const act = async (task) => {
      state.busy = true;
      note('');
      render();
      try { await task(); } finally { state.busy = false; render(); }
    };
    const owns = () => state.me.entitlements.includes(SUPPORTER);

    /** Whether this tab came back from a paid Checkout less than PENDING_MS ago. */
    const marked = () => {
      let raw = null;
      try { raw = o.session ? o.session.getItem(PENDING_KEY) : null; } catch (e) { return false; }
      return pendingSince(raw, now());
    };
    /** The payment is on its way: no Buy until api/me reports it, on this page or a reload. */
    const holdPending = () => {
      state.pending = true;
      try { if (o.session) o.session.setItem(PENDING_KEY, JSON.stringify({ at: now() })); } catch (e) { /* this page still holds it */ }
    };
    /** It arrived, or the account that paid has left the page. */
    const dropPending = () => {
      state.pending = false;
      try { if (o.session) o.session.removeItem(PENDING_KEY); } catch (e) { /* not read after PENDING_MS */ }
    };

    function render() {
      if (!state.config) return;
      const { config, me } = state;
      els.section.hidden = false;
      els.privacyLocal.hidden = true;
      els.privacyAccount.hidden = false;
      const parts = [];
      if (me.user) {
        parts.push(el('p', 'signed-in', me.user.email ? WORDS.signedInAs(me.user.email) : WORDS.signedIn));
        parts.push(el('p', 'actions', button(WORDS.signOut, signOut, 'accountSignOut'), button(WORDS.deleteAccount, deleteAccount, 'accountDelete')));
      } else {
        parts.push(el('p', 'actions', button(WORDS.signIn, signIn, 'accountSignIn')));
      }
      const product = config.supporter;
      if (product) {
        const price = product.price ? formatPrice(product.price) : null;
        const heading = el('p', 'product-name', el('strong', null, product.name));
        if (price) heading.append(' · ' + price);
        const action = owns() ? el('p', 'owned', WORDS.owned)
          : !me.user ? el('p', 'actions', button(WORDS.signInToBuy, signIn, 'supportBuy'))
            : state.pending ? el('p', 'pending', WORDS.processing)
              : el('p', 'actions', button(WORDS.buy, buy, 'supportBuy'));
        parts.push(el('div', 'product', heading, el('p', 'product-text', product.description), action));
      }
      els.body.replaceChildren(...parts);
    }

    /** Keyboard focus to the section's first control, after a re-render took the one it was on. */
    const refocus = () => {
      const first = els.body.querySelector('button');
      if (first && first.focus) first.focus();
    };

    function signIn() {
      o.location.assign(api.startUrl(o.location.pathname + o.location.search));
    }

    function buy() {
      return act(async () => {
        const result = await api.checkout(SUPPORTER);
        if (typeof result === 'object') { o.location.assign(result.url); return; }
        if (result === 'signin') { state.me = SIGNED_OUT; dropPending(); }
        if (result === 'owned') state.me = (await api.me()) || state.me;
        if (result === 'pending') { holdPending(); note(WORDS.paymentPending); }
        if (result === 'unavailable') note(NOTES.unavailable);
        if (result === 'busy') note(NOTES.busy);
        if (result === 'failed') note(NOTES.failed);
      });
    }

    function signOut() {
      return act(async () => {
        if (await api.signOut()) { state.me = SIGNED_OUT; dropPending(); } else note(NOTES.signOutFailed);
      }).then(refocus);
    }

    function deleteAccount() {
      if (!o.confirm(NOTES.deleteBody)) return Promise.resolve();
      return act(async () => {
        if (await api.deleteAccount()) { state.me = SIGNED_OUT; dropPending(); } else note(NOTES.deleteFailed);
      }).then(refocus);
    }

    /** Back from a paid Checkout, signed in: no Buy while api/me is asked for the purchase. */
    async function afterPurchase() {
      if (owns()) { note(WORDS.thanks); return; }
      holdPending();
      render();
      const { held, me } = await pollFor(SUPPORTER, api.me, o.wait);
      if (me) state.me = me;
      if (held || !state.me.user) dropPending();
      render();
      note(held ? WORDS.thanks : state.me.user ? WORDS.paymentPending : '');
    }

    const ready = (async () => {
      const config = await api.config();
      if (!config) return false;
      state.config = config;
      const me = await api.me();
      state.me = me || SIGNED_OUT;
      // A reload while a payment this tab made is on its way: still no Buy. An api/me that cannot
      // be read says nothing about it, so the record is left as it is.
      if (me && me.user && !owns() && marked()) state.pending = true;
      else if (me) dropPending();
      render();
      // Only a signed-in visitor can have paid; to anyone else the flag says nothing.
      const bought = landing.purchase === 'success' && !!config.supporter && !!state.me.user;
      if (landing.signIn === 'failed' || bought) {
        if (els.section.scrollIntoView) els.section.scrollIntoView({ block: 'nearest' });
      }
      if (landing.signIn === 'failed') note(WORDS.signInFailed);
      if (bought) await afterPurchase();
      return true;
    })().catch(() => false);
    return { ready, state, render };
  }

  /** The window's sessionStorage, or null where reading it throws (storage blocked). */
  function sessionOf(win) {
    try { return win.sessionStorage || null; } catch (e) { return null; }
  }

  /** Starts the section in the page, when the page has it. */
  function boot(win) {
    const doc = win.document;
    const $ = (id) => doc.getElementById(id);
    const els = { section: $('account'), body: $('accountBody'), note: $('accountNote'), privacyLocal: $('privacyLocal'), privacyAccount: $('privacyAccount') };
    if (Object.values(els).some((e) => !e)) return null;
    return start({
      doc,
      fetch: win.fetch.bind(win),
      location: win.location,
      history: win.history,
      confirm: (message) => win.confirm(message),
      wait: (ms) => new Promise((resolve) => win.setTimeout(resolve, ms)),
      session: sessionOf(win),
      now: () => Date.now(),
      els,
    });
  }

  return { SUPPORTER, WORDS, NOTES, POLL, PENDING_MS, PENDING_KEY, SIGNED_OUT, readConfig, readMe, formatPrice, landingOf, pendingSince, checkoutAddress, pollFor, client, start, boot };
});
