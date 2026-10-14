/*
 * web/account.js: what the website reads from the site's api/ and what it draws, against a fake
 * fetch and just enough of a document. The website's browser suite (test/e2e/site.js) drives the
 * same file in Chromium against the real kit under the site's policy; this pins each answer the
 * page can get, the ones a real server is hard to make give, and what the page does with it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const account = require('../web/account.js');

const BASE = 'https://selfreportle.example/selfreportle/';
const CONFIG = {
  auth: { google: true },
  shop: { products: [{ id: 'supporter', name: 'Support this app', description: 'A one-time payment.', mode: 'payment', price: { unit_amount: 500, currency: 'eur' } }] },
};

/** An element: attributes, children, text, `hidden`, `disabled`, click listeners. */
class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.children = [];
    this.hidden = false;
    this.disabled = false;
    this.listeners = [];
    this.scrolled = 0;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; }
  append(...kids) { for (const k of kids) this.children.push(typeof k === 'string' ? { text: k } : k); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  get textContent() { return this.children.map((c) => (c instanceof FakeElement ? c.textContent : c.text)).join(''); }
  set textContent(value) { this.children = [{ text: String(value) }]; }
  addEventListener(type, fn) { if (type === 'click') this.listeners.push(fn); }
  /** Clicks, and hands back what the handlers started, so a test can wait for it. */
  click() { return this.disabled ? Promise.resolve() : Promise.all(this.listeners.map((fn) => fn({}))); }
  focus() { FakeElement.focused = this; }
  scrollIntoView() { this.scrolled += 1; }
  *walk() { for (const c of this.children) if (c instanceof FakeElement) { yield c; yield* c.walk(); } }
  querySelector(tag) { for (const c of this.walk()) if (c.tagName === tag.toUpperCase()) return c; return null; }
  buttons() { return [...this.walk()].filter((e) => e.tagName === 'BUTTON'); }
  button(label) { return this.buttons().find((b) => b.textContent === label) || null; }
}
const doc = { createElement: (tag) => new FakeElement(tag) };

/** A fetch that answers each `METHOD route` from `routes` (a value, a function of the call, or
 *  an Error to throw), and records every call. */
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const route = url.startsWith(BASE + 'api/') ? url.slice((BASE + 'api/').length) : 'OUTSIDE ' + url;
    const method = init.method || 'GET';
    const call = { method, route, init };
    calls.push(call);
    let answer = routes[method + ' ' + route];
    if (typeof answer === 'function') answer = await answer(call, calls);
    if (answer === undefined) answer = { status: 404, body: { error: 'not_found' } };
    if (answer instanceof Error) throw answer;
    const text = typeof answer.body === 'string' ? answer.body : answer.body === undefined ? '' : JSON.stringify(answer.body);
    return { ok: answer.status >= 200 && answer.status < 300, status: answer.status, text: async () => text };
  };
  return { fetch, calls };
}

function page(routes, { href = BASE, confirmAnswer = true } = {}) {
  const els = {
    section: Object.assign(new FakeElement('section'), { hidden: true }),
    body: new FakeElement('div'),
    note: new FakeElement('p'),
    privacyLocal: new FakeElement('p'),
    privacyAccount: Object.assign(new FakeElement('p'), { hidden: true }),
  };
  const url = new URL(href);
  const seen = { assigned: [], replaced: [], confirms: [], waits: [] };
  const net = fakeFetch(routes);
  const ctl = account.start({
    doc,
    fetch: net.fetch,
    location: { href: url.href, pathname: url.pathname, search: url.search, assign: (to) => seen.assigned.push(to) },
    history: { replaceState: (_s, _t, to) => seen.replaced.push(to) },
    confirm: (message) => { seen.confirms.push(message); return confirmAnswer; },
    wait: async (ms) => { seen.waits.push(ms); },
    els,
  });
  return { ctl, els, seen, calls: net.calls };
}
const ok = (body) => ({ status: 200, body });
const SIGNED_OUT = ok({ user: null, entitlements: [] });
const ADA = ok({ user: { email: 'ada@example.com' }, entitlements: [] });
const ADA_SUPPORTER = ok({ user: { email: 'ada@example.com' }, entitlements: ['supporter'] });

/** What a visitor sees of the section: nothing, or its text. */
const drawn = ({ els }) => ({
  section: !els.section.hidden, privacyLocal: !els.privacyLocal.hidden, privacyAccount: !els.privacyAccount.hidden,
  text: els.body.textContent, note: els.note.textContent,
});

test('no API on the host: a 404, a network error, a body that is not JSON or nothing on draws nothing and asks nothing more', async () => {
  for (const [label, answer] of [
    ['404', { status: 404, body: '<!doctype html><title>Page not found · Selfreportle</title>' }],
    ['network error', new TypeError('Failed to fetch')],
    ['not JSON', { status: 200, body: 'not json' }],
    ['502 from a proxy with no API behind it', { status: 502, body: '<html>Bad Gateway</html>' }],
    ['nothing on (the api/config the site publishes)', ok({ auth: { google: false }, shop: { products: [] } })],
    ['a shop without sign-in', ok({ auth: { google: false }, shop: CONFIG.shop })],
    ['another shape', ok({ auth: { google: 'yes' } })],
    ['an array', ok([CONFIG])],
    ['null', ok(null)],
    ['the config, but answered as an error', { status: 404, body: CONFIG }],
  ]) {
    const p = page({ 'GET config': answer, 'GET me': ADA });
    assert.equal(await p.ctl.ready, false, label);
    assert.deepEqual(drawn(p), { section: false, privacyLocal: true, privacyAccount: false, text: '', note: '' }, label + ': the page is as it always was');
    assert.deepEqual(p.calls.map((c) => c.method + ' ' + c.route), ['GET config'], label + ': one question, never api/me');
    assert.deepEqual(p.seen.replaced, [], label + ': the address is left alone');
  }
});

test("the page asks the site's own api/ beside it, and nothing else", async () => {
  const p = page({ 'GET config': ok(CONFIG), 'GET me': SIGNED_OUT }, { href: BASE + 'index.html?x=1#y' });
  assert.equal(await p.ctl.ready, true);
  assert.deepEqual(p.calls.map((c) => c.method + ' ' + c.route), ['GET config', 'GET me']);
  assert.equal(p.calls[1].init.cache, 'no-store', 'api/me is never answered from the HTTP cache');
  for (const c of p.calls) assert.equal(c.init.credentials, 'same-origin');
});

test('signed out: the account offers Google, the product offers sign-in, and the privacy line says what would leave', async () => {
  const p = page({ 'GET config': ok(CONFIG), 'GET me': SIGNED_OUT });
  await p.ctl.ready;
  const d = drawn(p);
  assert.deepEqual([d.section, d.privacyLocal, d.privacyAccount], [true, false, true]);
  assert.deepEqual(p.els.body.buttons().map((b) => b.textContent), ['Sign in with Google', 'Sign in to buy']);
  assert.match(d.text, /Support this app · €5\.00|Support this app · 5,00 €|Support this app · €5/);
  assert.match(d.text, /A one-time payment\./);
  await p.els.body.button('Sign in with Google').click();
  assert.deepEqual(p.seen.assigned, [BASE + 'api/auth/google/start?return=' + encodeURIComponent('/selfreportle/')], 'a top-level navigation that comes back to this page');
  await p.els.body.button('Sign in to buy').click();
  assert.equal(p.seen.assigned.length, 2, 'Sign in to buy signs in');
  assert.equal(p.seen.assigned[1], p.seen.assigned[0]);
  assert.deepEqual(p.calls.map((c) => c.method + ' ' + c.route), ['GET config', 'GET me'], 'and nothing is posted');
});

test('the return path is the page and its query, never another address', async () => {
  const p = page({ 'GET config': ok(CONFIG), 'GET me': SIGNED_OUT }, { href: BASE + '?lang=de' });
  await p.ctl.ready;
  await p.els.body.button('Sign in with Google').click();
  const asked = new URL(p.seen.assigned[0]);
  assert.equal(asked.origin + asked.pathname, BASE + 'api/auth/google/start');
  assert.equal(asked.searchParams.get('return'), '/selfreportle/?lang=de');
});

test('signed in: the email as text, sign out and delete; Buy goes to Stripe and nowhere else', async () => {
  const hostile = '<img src=x onerror=alert(1)>@example.com';
  const p = page({ 'GET config': ok(CONFIG), 'GET me': ok({ user: { email: hostile }, entitlements: [] }), 'POST checkout': ok({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }) });
  await p.ctl.ready;
  assert.equal(p.els.body.children[0].textContent, 'Signed in as ' + hostile, 'drawn as text, character for character');
  assert.ok(!p.els.body.children[0].children.some((c) => c instanceof FakeElement), 'and no element came out of it');
  assert.deepEqual(p.els.body.buttons().map((b) => b.textContent), ['Sign out', 'Delete account', 'Buy']);
  await p.els.body.button('Buy').click();
  const post = p.calls.find((c) => c.route === 'checkout');
  assert.equal(post.method, 'POST');
  assert.equal(post.init.headers['Content-Type'], 'application/json', 'a type an HTML form cannot send');
  assert.deepEqual(JSON.parse(post.init.body), { product: 'supporter' }, 'the product id and nothing else');
  assert.deepEqual(p.seen.assigned, ['https://checkout.stripe.com/c/pay/cs_test_1']);
});

test('a Checkout address that is not Stripe\'s hosted page over https is not followed', async () => {
  for (const url of ['http://checkout.stripe.com/c/pay/x', 'https://checkout.stripe.com.evil.example/c', 'https://evil.example/https://checkout.stripe.com/', 'javascript:alert(1)//https://checkout.stripe.com/',
    'https://user:pw@checkout.stripe.com/c', '//checkout.stripe.com/c', 'https://checkout.stripe.co/c', 42, null]) {
    const p = page({ 'GET config': ok(CONFIG), 'GET me': ADA, 'POST checkout': ok({ url }) });
    await p.ctl.ready;
    await p.els.body.button('Buy').click();
    assert.deepEqual(p.seen.assigned, [], String(url) + ' is not followed');
    assert.equal(p.els.note.textContent, account.NOTES.failed, String(url) + ': the visitor is told');
  }
  assert.equal(account.checkoutAddress({ url: 'https://checkout.stripe.com/c/pay/cs_live_a#frag' }), 'https://checkout.stripe.com/c/pay/cs_live_a#frag');
});

test('what each refusal at checkout says, and that only one action runs at a time', async () => {
  for (const [status, expect] of [[401, null], [404, account.NOTES.unavailable], [429, account.NOTES.busy], [500, account.NOTES.failed], [502, account.NOTES.failed]]) {
    const p = page({ 'GET config': ok(CONFIG), 'GET me': ADA, 'POST checkout': { status, body: { error: 'x' } } });
    await p.ctl.ready;
    await p.els.body.button('Buy').click();
    assert.deepEqual(p.seen.assigned, [], status + ': nowhere to go');
    if (status === 401) assert.deepEqual(p.els.body.buttons().map((b) => b.textContent), ['Sign in with Google', 'Sign in to buy'], '401: the session is gone, so the page is signed out');
    else assert.equal(p.els.note.textContent, expect, status + ': ' + expect);
  }
  // 409: already owned (a purchase made in another tab): the page asks api/me again and shows it.
  let me = 0;
  const p = page({ 'GET config': ok(CONFIG), 'GET me': () => (me++ ? ADA_SUPPORTER : ADA), 'POST checkout': { status: 409, body: { error: 'owned' } } });
  await p.ctl.ready;
  const routesBefore = p.calls.length;
  const click = p.els.body.button('Buy').click();
  assert.ok(p.els.body.buttons().length === 3 && p.els.body.buttons().every((b) => b.disabled), 'every button is disabled while Buy is out');
  await click;
  assert.equal(p.calls.length - routesBefore, 2, 'POST checkout, then GET me');
  assert.match(p.els.body.textContent, /Owned/);
  assert.deepEqual(p.els.body.buttons().map((b) => b.textContent), ['Sign out', 'Delete account']);
});

test('owned: "Owned" in place of Buy, and the account still signs out', async () => {
  const p = page({ 'GET config': ok(CONFIG), 'GET me': ADA_SUPPORTER, 'POST auth/logout': { status: 204 }, 'GET nothing': ok({}) });
  await p.ctl.ready;
  assert.match(p.els.body.textContent, /Owned$/);
  assert.equal(p.els.body.button('Buy'), null);
  await p.els.body.button('Sign out').click();
  assert.deepEqual(p.els.body.buttons().map((b) => b.textContent), ['Sign in with Google', 'Sign in to buy'], 'signed out, nothing is owned on this page');
  assert.equal(FakeElement.focused.textContent, 'Sign in with Google', 'keyboard focus lands on the first control again');
});

test('a sign-out or a deletion the server refuses is said, and the page stays signed in', async () => {
  const p = page({ 'GET config': ok(CONFIG), 'GET me': ADA, 'POST auth/logout': { status: 403 }, 'DELETE me': { status: 500 } });
  await p.ctl.ready;
  await p.els.body.button('Sign out').click();
  assert.equal(p.els.note.textContent, account.NOTES.signOutFailed);
  const deleting = p.els.body.button('Delete account').click();
  assert.equal(p.els.note.textContent, '', 'the last note is taken down when the next action starts');
  await deleting;
  assert.equal(p.els.note.textContent, account.NOTES.deleteFailed);
  assert.match(p.els.body.textContent, /^Signed in as ada@example\.com/);
});

test('Delete account asks first, says the support goes with it, and does nothing when the answer is no', async () => {
  const no = page({ 'GET config': ok(CONFIG), 'GET me': ADA_SUPPORTER, 'DELETE me': { status: 204 } }, { confirmAnswer: false });
  await no.ctl.ready;
  await no.els.body.button('Delete account').click();
  assert.deepEqual(no.seen.confirms, [account.NOTES.deleteBody]);
  assert.match(account.NOTES.deleteBody, /support/, 'the question says the purchase goes with the account');
  assert.ok(!no.calls.some((c) => c.method === 'DELETE'), 'no answer, no request');
  const yes = page({ 'GET config': ok(CONFIG), 'GET me': ADA_SUPPORTER, 'DELETE me': { status: 204 } });
  await yes.ctl.ready;
  await yes.els.body.button('Delete account').click();
  assert.ok(yes.calls.some((c) => c.method === 'DELETE' && c.route === 'me'));
  assert.deepEqual(yes.els.body.buttons().map((b) => b.textContent), ['Sign in with Google', 'Sign in to buy']);
});

test('?signin=failed: said once, the flag taken out of the address, the rest of the address kept', async () => {
  const p = page({ 'GET config': ok(CONFIG), 'GET me': SIGNED_OUT }, { href: BASE + '?keep=1&signin=failed#top' });
  await p.ctl.ready;
  assert.deepEqual(p.seen.replaced, ['/selfreportle/?keep=1#top']);
  assert.equal(p.els.note.textContent, "Sign-in didn't complete.");
  assert.equal(p.els.section.scrolled, 1, 'the section is brought into view, where the note is');
  // a value the kit does not write is not ours
  const other = page({ 'GET config': ok(CONFIG), 'GET me': SIGNED_OUT }, { href: BASE + '?signin=other&purchase=maybe' });
  await other.ctl.ready;
  assert.deepEqual(other.seen.replaced, []);
  assert.equal(other.els.note.textContent, '');
  assert.equal(other.els.section.scrolled, 0);
});

test('?purchase=cancelled is taken out of the address and nothing else happens', async () => {
  const p = page({ 'GET config': ok(CONFIG), 'GET me': ADA }, { href: BASE + '?purchase=cancelled' });
  await p.ctl.ready;
  assert.deepEqual(p.seen.replaced, ['/selfreportle/']);
  assert.equal(p.els.note.textContent, '');
  assert.deepEqual(p.seen.waits, []);
});

test('?purchase=success: api/me is asked up to five times over fifteen seconds for the entitlement', async () => {
  let asked = 0;
  const later = page({ 'GET config': ok(CONFIG), 'GET me': () => (++asked >= 3 ? ADA_SUPPORTER : ADA) }, { href: BASE + '?purchase=success' });
  assert.equal(await later.ctl.ready, true);
  assert.deepEqual(later.seen.replaced, ['/selfreportle/']);
  assert.equal(asked, 3, 'the load, then until it shows');
  assert.deepEqual(later.seen.waits, [3000, 3000]);
  assert.equal(later.els.note.textContent, 'Thank you — Support this app is unlocked.');
  assert.match(later.els.body.textContent, /Owned/);

  const never = page({ 'GET config': ok(CONFIG), 'GET me': ADA }, { href: BASE + '?purchase=success' });
  await never.ctl.ready;
  assert.deepEqual(never.seen.waits, [3000, 3000, 3000, 3000, 3000], 'five tries, fifteen seconds');
  assert.equal(never.calls.filter((c) => c.route === 'me').length, 6);
  assert.equal(never.els.note.textContent, 'Payment received. It can take a minute to appear — reload to check.');

  const already = page({ 'GET config': ok(CONFIG), 'GET me': ADA_SUPPORTER }, { href: BASE + '?purchase=success' });
  await already.ctl.ready;
  assert.deepEqual(already.seen.waits, [], 'already granted when the page loads: no poll');
  assert.equal(already.els.note.textContent, 'Thank you — Support this app is unlocked.');
});

test('the shop is drawn only as this site sells it, and server text is checked before it is drawn', () => {
  const product = (over) => ({ auth: { google: true }, shop: { products: [{ ...CONFIG.shop.products[0], ...over }] } });
  assert.deepEqual(account.readConfig(product({})).supporter.price, { unitAmount: 500, currency: 'eur' });
  assert.equal(account.readConfig(product({ mode: 'subscription' })).supporter, null, 'not a subscription');
  assert.equal(account.readConfig(product({ id: 'pro' })).supporter, null, 'not another product');
  assert.equal(account.readConfig(product({ name: 'a\u0007b' })).supporter, null, 'no control character in a name');
  assert.equal(account.readConfig(product({ name: 'x'.repeat(101) })).supporter, null, 'a name of at most 100 characters');
  assert.equal(account.readConfig(product({ description: 7 })).supporter, null);
  assert.equal(account.readConfig(product({ price: { unit_amount: -1, currency: 'eur' } })).supporter.price, null, 'a price that is not one is left out, not the product');
  assert.equal(account.readConfig(product({ price: { unit_amount: 1.5, currency: 'eur' } })).supporter.price, null);
  assert.equal(account.readConfig(product({ price: { unit_amount: 5, currency: 'EURO' } })).supporter.price, null);
  assert.deepEqual(account.readMe({ user: { email: 'a\nb' }, entitlements: ['supporter', 'supporter', 'Bad', '__proto__', 7, 'pro'] }), { user: { email: null }, entitlements: ['supporter', 'pro'] });
  assert.equal(account.readMe({ user: 'ada', entitlements: [] }), null);
  assert.equal(account.readMe({ user: null }), null);
  assert.equal(account.formatPrice({ unitAmount: 499, currency: 'jpy' }, 'en-US'), '¥499', 'a zero-decimal currency is not divided');
  assert.match(account.formatPrice({ unitAmount: 1500, currency: 'kwd' }, 'en-US'), /^KWD\s1\.500$/, 'a three-decimal one by a thousand');
  assert.equal(account.formatPrice({ unitAmount: 500, currency: 'eur' }, 'en-GB'), '€5.00');
  assert.match(account.formatPrice({ unitAmount: 500, currency: 'zzq' }, 'en-GB'), /^ZZQ\s5\.00$/, 'a currency Intl does not know is still printed by its code');
});

test('a throw anywhere in the account leaves ready false, never a rejection', async () => {
  const p = page({ 'GET config': ok(CONFIG), 'GET me': SIGNED_OUT });
  p.els.body.replaceChildren = () => { throw new Error('boom'); };
  // The first render throws inside ready: it must settle to false, not reject.
  assert.equal(await p.ctl.ready, false);
});

test('boot draws nothing on a page that lacks the section', () => {
  const win = { document: { getElementById: () => null } };
  assert.equal(account.boot(win), null);
});
