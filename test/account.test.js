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

/** A tab's sessionStorage: `throws` makes every access throw, as a browser with storage
 *  blocked does. */
function fakeSession(initial = {}, { throws = false } = {}) {
  const data = new Map(Object.entries(initial));
  const guard = () => { if (throws) throw new DOMException('blocked', 'SecurityError'); };
  return {
    data,
    getItem(key) { guard(); return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { guard(); data.set(key, String(value)); },
    removeItem(key) { guard(); data.delete(key); },
  };
}
const NOW = 1_800_000_000_000;

function page(routes, { href = BASE, confirmAnswer = true, session = fakeSession(), now = () => NOW, onWait = null } = {}) {
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
    wait: async (ms) => { seen.waits.push(ms); if (onWait) onWait(els); },
    session,
    now,
    els,
  });
  return { ctl, els, seen, calls: net.calls, session };
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
  // The kit's own flags are taken out of the address on every host, before api/config answers
  // (README says so); nothing else happens there.
  for (const flag of ['signin=failed', 'purchase=success', 'purchase=cancelled']) {
    const p = page({ 'GET config': ok({ auth: { google: false }, shop: { products: [] } }), 'GET me': ADA }, { href: BASE + '?' + flag + '&keep=1' });
    assert.deepEqual(p.seen.replaced, ['/selfreportle/?keep=1'], flag + ': taken out before api/config is answered');
    assert.equal(await p.ctl.ready, false);
    assert.deepEqual(p.calls.map((c) => c.method + ' ' + c.route), ['GET config'], flag + ': one question');
    assert.deepEqual([p.seen.waits, p.els.note.textContent, p.els.section.scrolled, [...p.session.data.keys()]], [[], '', 0, []], flag + ': no poll, no note, no scroll, nothing stored');
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
  assert.equal(later.els.note.textContent, 'Thank you for supporting Selfreportle.', 'a thank-you for the support, which unlocks nothing');
  assert.match(later.els.body.textContent, /Owned/);
  assert.equal(later.els.section.scrolled, 1, 'the section is brought into view, where the thank-you is');
  assert.equal(later.session.data.size, 0, 'the purchase is reported: the record of a payment on its way is gone');

  const never = page({ 'GET config': ok(CONFIG), 'GET me': ADA }, { href: BASE + '?purchase=success' });
  await never.ctl.ready;
  assert.deepEqual(never.seen.waits, [3000, 3000, 3000, 3000, 3000], 'five tries, fifteen seconds');
  assert.equal(never.calls.filter((c) => c.route === 'me').length, 6);
  assert.equal(never.els.note.textContent, 'Payment received. It can take a minute to appear — reload to check.');

  const already = page({ 'GET config': ok(CONFIG), 'GET me': ADA_SUPPORTER }, { href: BASE + '?purchase=success' });
  await already.ctl.ready;
  assert.deepEqual(already.seen.waits, [], 'already granted when the page loads: no poll');
  assert.equal(already.els.note.textContent, 'Thank you for supporting Selfreportle.');
  assert.equal(account.WORDS.thanks, 'Thank you for supporting Selfreportle.', 'not "unlocked": the product unlocks nothing');
});

const PROCESSING = 'Payment received — processing';
const PENDING_KEY = 'selfreportle.purchasePending.v1';
/** What the product offers: its button, or the line drawn where Buy was. */
const offer = (els) => {
  const product = [...els.body.walk()].find((e) => e.getAttribute('class') === 'product');
  const last = product.children[product.children.length - 1];
  return last.tagName === 'P' && last.getAttribute('class') === 'actions' ? last.children[0].textContent : last.textContent;
};

/* Stripe's webhook can land after Checkout sends the visitor back, and the kit this site carries
 * makes a new payable Checkout Session for every press of Buy until the webhook records the
 * purchase: a second Buy then was a second payment. So nothing offers Buy until api/me reports
 * the purchase. */
test('back from Checkout before the webhook: "processing" where Buy was, through the poll and after it', async () => {
  const during = [];
  const p = page({ 'GET config': ok(CONFIG), 'GET me': ADA }, { href: BASE + '?purchase=success', onWait: (els) => during.push([offer(els), els.body.button('Buy')]) });
  assert.equal(await p.ctl.ready, true);
  assert.equal(during.length, 5);
  for (const [i, [what, buy]] of during.entries()) {
    assert.equal(what, PROCESSING, 'wait ' + (i + 1) + ': the payment is on its way');
    assert.equal(buy, null, 'wait ' + (i + 1) + ': no Buy');
  }
  assert.equal(offer(p.els), PROCESSING, 'the poll gave up: still no Buy, for the life of the page');
  assert.equal(p.els.body.button('Buy'), null);
  assert.deepEqual(p.els.body.buttons().map((b) => b.textContent), ['Sign out', 'Delete account'], 'the account can still sign out or be deleted');
  assert.equal(p.els.note.textContent, account.WORDS.paymentPending);
  assert.deepEqual(JSON.parse(p.session.data.get(PENDING_KEY)), { at: NOW }, "the tab's record: when Checkout sent it back");
  assert.deepEqual([...p.session.data.keys()], [PENDING_KEY], 'and nothing else');
  assert.ok(!p.calls.some((c) => c.route === 'checkout'), 'nothing was sold twice');
});

test('a reload within ten minutes still says "processing"; after them, or with no record, Buy is back', async () => {
  const at = (age) => fakeSession({ [PENDING_KEY]: JSON.stringify({ at: NOW - age }) });
  for (const [label, session, want] of [
    ['just now', at(0), PROCESSING],
    ['a minute ago', at(60 * 1000), PROCESSING],
    ['the last millisecond', at(account.PENDING_MS - 1), PROCESSING],
    ['ten minutes ago', at(account.PENDING_MS), 'Buy'],
    ['an hour ago', at(60 * 60 * 1000), 'Buy'],
    ['in the future', at(-1), 'Buy'],
    ['no record', fakeSession(), 'Buy'],
    ['not JSON', fakeSession({ [PENDING_KEY]: '{' }), 'Buy'],
    ['a number', fakeSession({ [PENDING_KEY]: String(NOW) }), 'Buy'],
    ['a string at', fakeSession({ [PENDING_KEY]: JSON.stringify({ at: String(NOW) }) }), 'Buy'],
    ['a null at', fakeSession({ [PENDING_KEY]: JSON.stringify({ at: null }) }), 'Buy'],
    ['an array', fakeSession({ [PENDING_KEY]: JSON.stringify([NOW]) }), 'Buy'],
    ['storage that throws', fakeSession({ [PENDING_KEY]: JSON.stringify({ at: NOW }) }, { throws: true }), 'Buy'],
  ]) {
    const p = page({ 'GET config': ok(CONFIG), 'GET me': ADA }, { session });
    assert.equal(await p.ctl.ready, true, label);
    assert.equal(offer(p.els), want, label);
    assert.deepEqual(p.seen.waits, [], label + ': a reload does not poll');
    if (want === 'Buy' && label !== 'storage that throws') assert.equal(session.data.size, 0, label + ': a record that says nothing is taken away');
  }
  assert.equal(account.PENDING_MS, 10 * 60 * 1000);
  assert.equal(account.pendingSince(null, NOW), false);
  assert.equal(account.pendingSince(JSON.stringify({ at: Infinity }), NOW), false);
});

test('the record goes once the purchase is reported, or with the account that paid', async () => {
  const marked = () => fakeSession({ [PENDING_KEY]: JSON.stringify({ at: NOW - 1000 }) });
  // reported on load
  const owned = page({ 'GET config': ok(CONFIG), 'GET me': ADA_SUPPORTER }, { session: marked() });
  await owned.ctl.ready;
  assert.equal(offer(owned.els), 'Owned');
  assert.equal(owned.session.data.size, 0, 'owned: the record is gone');
  // nobody signed in on load: the account that paid has left
  const out = page({ 'GET config': ok(CONFIG), 'GET me': SIGNED_OUT }, { session: marked() });
  await out.ctl.ready;
  assert.equal(offer(out.els), 'Sign in to buy');
  assert.equal(out.session.data.size, 0, 'signed out: the record is gone');
  // api/me unreadable: says nothing about the payment, so the record stays for the next load
  const unread = page({ 'GET config': ok(CONFIG), 'GET me': { status: 502, body: '<html>' } }, { session: marked() });
  await unread.ctl.ready;
  assert.equal(offer(unread.els), 'Sign in to buy');
  assert.equal(unread.session.data.size, 1, 'unreadable: the record is kept');
  // sign out, and delete
  for (const [label, route, click] of [['Sign out', 'POST auth/logout', 'Sign out'], ['Delete account', 'DELETE me', 'Delete account']]) {
    const p = page({ 'GET config': ok(CONFIG), 'GET me': ADA, [route]: { status: 204 } }, { session: marked() });
    await p.ctl.ready;
    assert.equal(offer(p.els), PROCESSING);
    await p.els.body.button(click).click();
    assert.equal(p.session.data.size, 0, label + ': the record is gone with the account');
    assert.equal(offer(p.els), 'Sign in to buy');
  }
  // the poll reports it
  let asked = 0;
  const later = page({ 'GET config': ok(CONFIG), 'GET me': () => (++asked >= 2 ? ADA_SUPPORTER : ADA) }, { session: marked(), href: BASE + '?purchase=success' });
  await later.ctl.ready;
  assert.equal(offer(later.els), 'Owned');
  assert.equal(later.session.data.size, 0);
  // the poll finds the visitor signed out (in another tab): nothing is said, and the record goes
  let polled = 0;
  const left = page({ 'GET config': ok(CONFIG), 'GET me': () => (++polled >= 2 ? SIGNED_OUT : ADA) }, { href: BASE + '?purchase=success' });
  await left.ctl.ready;
  assert.equal(left.els.note.textContent, '', 'signed out meanwhile: no "Payment received"');
  assert.equal(offer(left.els), 'Sign in to buy');
  assert.equal(left.session.data.size, 0);
  // storage that refuses: the page itself still holds the payment, and nothing throws
  const blocked = page({ 'GET config': ok(CONFIG), 'GET me': ADA }, { session: fakeSession({}, { throws: true }), href: BASE + '?purchase=success' });
  assert.equal(await blocked.ctl.ready, true);
  assert.equal(offer(blocked.els), PROCESSING);
  const none = page({ 'GET config': ok(CONFIG), 'GET me': ADA }, { session: null, href: BASE + '?purchase=success' });
  assert.equal(await none.ctl.ready, true);
  assert.equal(offer(none.els), PROCESSING, 'no sessionStorage at all: the same');
});

test('a ?purchase=success link opened by someone not signed in says nothing and asks nothing', async () => {
  for (const [label, me] of [
    ['signed out', SIGNED_OUT],
    ['signed out, with an entitlement listed', ok({ user: null, entitlements: ['supporter'] })],
    ['api/me unreadable', { status: 500, body: { user: { email: 'ada@example.com' }, entitlements: [] } }],
  ]) {
    const p = page({ 'GET config': ok(CONFIG), 'GET me': me }, { href: BASE + '?purchase=success' });
    assert.equal(await p.ctl.ready, true, label);
    assert.deepEqual(p.seen.replaced, ['/selfreportle/'], label + ': the flag is taken out of the address');
    assert.deepEqual(p.seen.waits, [], label + ': no poll');
    assert.deepEqual(p.calls.map((c) => c.method + ' ' + c.route), ['GET config', 'GET me'], label + ': api/me once');
    assert.equal(p.els.note.textContent, '', label + ': no "Payment received", no thank-you');
    assert.equal(p.els.section.scrolled, 0, label + ': nothing to bring into view');
    assert.equal(p.session.data.size, 0, label + ': nothing stored');
  }
});

test('a landing from Checkout on a site that sells nothing now asks nothing more', async () => {
  const p = page({ 'GET config': ok({ auth: { google: true }, shop: { products: [] } }), 'GET me': ADA }, { href: BASE + '?purchase=success' });
  assert.equal(await p.ctl.ready, true);
  assert.deepEqual(p.seen.waits, []);
  assert.deepEqual(p.calls.map((c) => c.method + ' ' + c.route), ['GET config', 'GET me']);
  assert.equal(p.els.note.textContent, '');
  assert.equal(p.els.section.scrolled, 0);
  assert.deepEqual(p.els.body.buttons().map((b) => b.textContent), ['Sign out', 'Delete account'], 'the account is drawn, and no product');
});

test('Buy answered 409 payment_pending: "processing" and the note, and no second Checkout', async () => {
  const p = page({ 'GET config': ok(CONFIG), 'GET me': ADA, 'POST checkout': { status: 409, body: { error: 'payment_pending' } } });
  await p.ctl.ready;
  await p.els.body.button('Buy').click();
  assert.deepEqual(p.seen.assigned, [], 'nowhere to go');
  assert.equal(offer(p.els), PROCESSING, 'the payment the kit knows of is on its way');
  assert.equal(p.els.note.textContent, account.WORDS.paymentPending);
  assert.deepEqual(JSON.parse(p.session.data.get(PENDING_KEY)), { at: NOW }, 'and a reload keeps it');
  assert.deepEqual(p.calls.map((c) => c.method + ' ' + c.route), ['GET config', 'GET me', 'POST checkout'], 'not taken for "owned": api/me is not asked again');
  // any other 409 is what it was: already owned, asked again
  for (const body of [{ error: 'already_owned' }, { error: 'x' }, 'not json', undefined]) {
    let me = 0;
    const q = page({ 'GET config': ok(CONFIG), 'GET me': () => (me++ ? ADA_SUPPORTER : ADA), 'POST checkout': { status: 409, body } });
    await q.ctl.ready;
    await q.els.body.button('Buy').click();
    assert.equal(offer(q.els), 'Owned', JSON.stringify(body));
    assert.equal(q.session.data.size, 0, JSON.stringify(body) + ': nothing held');
  }
});

test('a 401 at Buy signs the page out and lets the record go', async () => {
  const p = page({ 'GET config': ok(CONFIG), 'GET me': ADA, 'POST checkout': { status: 401, body: { error: 'signin' } } }, { session: fakeSession({ [PENDING_KEY]: JSON.stringify({ at: NOW - account.PENDING_MS }) }) });
  await p.ctl.ready;
  p.session.data.set(PENDING_KEY, JSON.stringify({ at: NOW }));
  await p.els.body.button('Buy').click();
  assert.equal(offer(p.els), 'Sign in to buy');
  assert.equal(p.session.data.size, 0);
});

test('Delete account puts the keyboard back on the section', async () => {
  FakeElement.focused = null;
  const p = page({ 'GET config': ok(CONFIG), 'GET me': ADA, 'DELETE me': { status: 204 } });
  await p.ctl.ready;
  await p.els.body.button('Delete account').click();
  assert.equal(FakeElement.focused && FakeElement.focused.textContent, 'Sign in with Google', 'the control it was on is gone; focus lands on the first one');
  FakeElement.focused = null;
  const refused = page({ 'GET config': ok(CONFIG), 'GET me': ADA, 'DELETE me': { status: 500 } });
  await refused.ctl.ready;
  await refused.els.body.button('Delete account').click();
  assert.equal(FakeElement.focused && FakeElement.focused.textContent, 'Sign out', 'refused: focus on the first control, still signed in');
});

test("only the kit's 204 is a sign-out or a deletion that happened", async () => {
  for (const status of [200, 201, 202, 205, 301, 401, 403, 404, 409, 500, 502]) {
    const p = page({ 'GET config': ok(CONFIG), 'GET me': ADA, 'POST auth/logout': { status, body: {} }, 'DELETE me': { status, body: {} } });
    await p.ctl.ready;
    await p.els.body.button('Sign out').click();
    assert.equal(p.els.note.textContent, account.NOTES.signOutFailed, status + ': not signed out');
    await p.els.body.button('Delete account').click();
    assert.equal(p.els.note.textContent, account.NOTES.deleteFailed, status + ': not deleted');
    assert.match(p.els.body.textContent, /^Signed in as ada@example\.com/, status + ': the page still says who is signed in');
  }
});

test('the entitlements api/me reports are read up to fifty', () => {
  const many = Array.from({ length: 60 }, (_, i) => 'e' + i);
  assert.deepEqual(account.readMe({ user: null, entitlements: many }).entitlements, many.slice(0, 50));
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
