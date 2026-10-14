// The website's API as this site deploys it: server/catalogue.js through the kit, by both ways in
// (functions/api/[[path]].js on Cloudflare Pages, server/start.mjs on a host of its own), with a
// fake Google and a fake Stripe handed to the kit through its `fetch` (test/api-fakes.mjs), never
// through a variable that names another host. Run by `npm test` beside the kit's own self-test
// (server/kit/selftest.mjs), which covers every guard of the kit itself; this covers what this
// repository adds: the catalogue, the entries, the files the site publishes for the API, and the
// page's reading of what the API answers (web/account.js).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import catalogue from '../server/catalogue.js';
import { priceVariable, validateCatalogue } from '../server/kit/app.js';
import { pagesHandler } from '../server/kit/cloudflare.js';
import { start } from '../server/start.mjs';
import { AMOUNT, createFakes, envFor, signedDelivery } from './api-fakes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const require = createRequire(import.meta.url);
const account = require('../web/account.js');
const site = require('../scripts/build-site.js');

/** What every test here must never do: reach the network. The fakes are injected instead. */
const realFetch = globalThis.fetch;
const escaped = [];
let local = null;
before(() => {
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    // the tests' own requests to the API they started on loopback
    if (local && url.startsWith(local)) return realFetch(input, init);
    escaped.push(url);
    throw new Error(`a test reached for the network: ${url}`);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  assert.deepEqual(escaped, []);
});

describe('the catalogue', () => {
  it('sells one "Support this app" payment, granting supporter, and nothing else', () => {
    const checked = validateCatalogue(catalogue);
    assert.equal(checked.app, 'selfreportle', 'the cookies are __Host-selfreportle-*, and every payment is tagged selfreportle');
    assert.deepEqual(checked.products.map((p) => [p.id, p.name, p.mode, p.grants]), [['supporter', 'Support this app', 'payment', 'supporter']]);
    assert.equal(priceVariable('supporter'), 'STRIPE_PRICE_SUPPORTER');
    // the page asks for that product and reads that entitlement
    assert.equal(account.SUPPORTER, 'supporter');
  });

  it('is what the API is built from, and the fakes are not', () => {
    for (const file of ['server/start.mjs', 'server/catalogue.js', 'functions/api/[[path]].js']) {
      for (const line of read(file).match(/^import .*$/gm) ?? []) assert.doesNotMatch(line, /fakes|test/, `${file} imports nothing of the tests`);
    }
    // nothing here, or in the kit, reads a variable that could point the kit at another Google or Stripe
    for (const file of [...fs.readdirSync(path.join(root, 'server/kit')).filter((f) => f.endsWith('.js')).map((f) => `server/kit/${f}`), 'server/start.mjs', 'server/catalogue.js']) {
      assert.doesNotMatch(read(file), /process\.env\.(?!KIT_)|GOOGLE_[A-Z_]*(URL|HOST|BASE)|STRIPE_[A-Z_]*(URL|HOST|BASE)/, file);
    }
  });
});

describe('Cloudflare Pages: functions/api/[[path]].js', () => {
  it("is the kit's three-line entry with this site's catalogue, and the build's _routes.json sends it /api/* alone", () => {
    const entry = 'functions/api/[[path]].js';
    assert.equal(read(entry), [
      "import { pagesHandler } from '../../server/kit/cloudflare.js';",
      "import catalogue from '../../server/catalogue.js';",
      'export const onRequest = pagesHandler(catalogue);',
      '',
    ].join('\n'));
    for (const target of ['../../server/kit/cloudflare.js', '../../server/catalogue.js']) {
      assert.ok(fs.existsSync(path.resolve(root, path.dirname(entry), target)), target);
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'srl-routes-'));
    try {
      for (const [base, include] of [['/', '/api/*'], ['/selfreportle/', '/selfreportle/api/*']]) {
        const out = path.join(tmp, base.replace(/\//g, '_'));
        const written = site.build(out, { host: 'cloudflare', base });
        assert.ok(written.includes('_routes.json'), 'the Cloudflare build carries _routes.json');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, '_routes.json'), 'utf8')), { version: 1, include: [include], exclude: [] }, `${base}: no static file invokes the function`);
      }
      for (const host of ['pages', 'nginx', 'netlify', 'apache']) {
        assert.ok(!site.build(path.join(tmp, host), { host }).includes('_routes.json'), `${host} gets no _routes.json`);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  /** A Workers KV namespace in memory, as much of one as the kit uses. */
  const kv = () => {
    const data = new Map();
    return {
      data,
      get: async (key) => (data.has(key) ? JSON.parse(data.get(key)) : null),
      put: async (key, value) => void data.set(key, value),
      delete: async (key) => void data.delete(key),
    };
  };
  const onRequest = pagesHandler(catalogue);
  const call = (url, env) => onRequest({ request: new Request(url), env });

  it('reports nothing on, and answers nothing else, with no variables set', async () => {
    const env = { KIT_STORE: kv() };
    const config = await call('https://selfreportle.example/api/config', env);
    assert.equal(config.status, 200);
    const body = await config.json();
    assert.deepEqual(body, { auth: { google: false }, shop: { products: [] } });
    assert.equal(account.readConfig(body), null, 'which the page reads as: nothing to draw');
    assert.equal(config.headers.get('cache-control'), 'public, max-age=60');
    assert.equal(config.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'", "the API's own policy: a function's answer gets nothing from _headers");
    for (const route of ['me', 'auth/google/start', 'checkout', 'portal', 'webhooks/stripe', 'nothing']) {
      assert.equal((await call(`https://selfreportle.example/api/${route}`, env)).status, 404, route);
    }
    assert.equal(env.KIT_STORE.data.size, 0, 'and writes nothing');
  });

  it('starts a sign-in towards Google once sign-in is configured, and sells nothing without Stripe', async () => {
    const { STRIPE_SECRET_KEY: _key, STRIPE_WEBHOOK_SECRET: _hook, STRIPE_PRICE_SUPPORTER: _price, ...signIn } = envFor('https://selfreportle.example/');
    const env = { ...signIn, KIT_STORE: kv() };
    const body = await (await call('https://selfreportle.example/api/config', env)).json();
    assert.deepEqual(body, { auth: { google: true }, shop: { products: [] } });
    assert.deepEqual(account.readConfig(body), { supporter: null }, 'the page draws the account and no shop');
    const started = await call('https://selfreportle.example/api/auth/google/start?return=%2F', env);
    assert.equal(started.status, 302);
    const google = new URL(started.headers.get('location') ?? '');
    assert.equal(`${google.origin}${google.pathname}`, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.equal(google.searchParams.get('redirect_uri'), 'https://selfreportle.example/api/auth/google/callback');
    assert.match(started.headers.get('set-cookie') ?? '', /^__Host-selfreportle-oauth=[^;]+; .*HttpOnly/);
  });
});

describe('the static api/config the site publishes for a host with no API', () => {
  it('is, byte for byte, what the kit answers with nothing configured, and is part of the site', async () => {
    const kit = await (await pagesHandler(catalogue)({ request: new Request('https://x.example/api/config'), env: {} })).text();
    assert.equal(read('web/api/config'), `${kit}\n`);
    assert.equal(account.readConfig(JSON.parse(read('web/api/config'))), null, 'so the page draws nothing there');
    assert.equal(site.siteMap()['api/config'], 'web/api/config', 'published at api/config, beside the page');
  });
});

describe('a host of its own: server/start.mjs through the Node adapter', () => {
  // The public address is the proxy's (deploy/nginx.conf), not the loopback port the API listens
  // on: the kit takes every absolute URL from APP_URL, and the CSRF gate the origin.
  const APP_URL = 'https://selfreportle.example/';
  const ORIGIN = 'https://selfreportle.example';
  let fakes;
  let api;
  let dataDir;
  const logs = [];

  before(async () => {
    fakes = await createFakes();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfreportle-api-'));
    api = await start({ env: envFor(APP_URL), dataDir, port: 0, fetch: fakes.fetch, log: (level, message) => logs.push(`${level}: ${message}`) });
    local = api.url;
  });
  after(async () => {
    await api?.close();
    local = null;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  /** One browser's cookies, kept by name as the browser would keep them. */
  const jar = () => {
    const cookies = new Map();
    return {
      header: () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; '),
      take(response) {
        for (const line of response.headers.getSetCookie()) {
          const [pair, ...attrs] = line.split(';');
          const [name, value] = [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)];
          if (attrs.some((a) => /^\s*Max-Age=0$/i.test(a))) cookies.delete(name);
          else cookies.set(name, value);
        }
      },
      has: (name) => cookies.has(name),
    };
  };
  const ask = async (browser, route, init = {}) => {
    const headers = { ...(init.headers ?? {}), ...(browser.header() ? { cookie: browser.header() } : {}) };
    const response = await realFetch(`${api.url}api/${route}`, { redirect: 'manual', ...init, headers });
    browser.take(response);
    return response;
  };
  const signIn = async (browser, person) => {
    const started = await ask(browser, `auth/google/start?return=${encodeURIComponent('/?keep=1')}`);
    assert.equal(started.status, 302);
    const back = fakes.consent(started.headers.get('location'), person);
    assert.equal(`${back.origin}${back.pathname}`, `${ORIGIN}/api/auth/google/callback`, "Google sends the browser back to the site's callback");
    const done = await ask(browser, `auth/google/callback${back.search}`);
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), `${ORIGIN}/?keep=1`, 'and the site sends it back to the page it left');
    assert.ok(browser.has('__Host-selfreportle-session'));
  };
  const me = async (browser) => account.readMe(await (await ask(browser, 'me')).json());
  const post = (browser, route, body) => ask(browser, route, {
    method: 'POST', headers: { origin: ORIGIN, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const webhook = (delivery) => realFetch(`${api.url}api/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': delivery.signature, 'content-type': 'application/json' }, body: delivery.body });

  it('is on, and offers "Support this app" at its Stripe price', async () => {
    assert.deepEqual(api.features, { signIn: true, shop: true });
    const config = account.readConfig(await (await ask(jar(), 'config')).json());
    assert.deepEqual(config, {
      supporter: { id: 'supporter', name: 'Support this app', description: catalogue.products[0].description, price: { unitAmount: AMOUNT, currency: 'eur' } },
    });
    assert.equal(account.formatPrice(config.supporter.price, 'en-GB'), '€5.00');
  });

  it('signs in, sells, grants on the signed webhook alone, signs out and deletes', async () => {
    const browser = jar();
    assert.deepEqual(await me(browser), { user: null, entitlements: [] });
    assert.equal((await post(browser, 'checkout', { product: 'supporter' })).status, 401, 'signed out, nothing is sold');

    await signIn(browser, { sub: '1001', email: 'ada@example.com' });
    assert.deepEqual(await me(browser), { user: { email: 'ada@example.com' }, entitlements: [] });

    const bought = await post(browser, 'checkout', { product: 'supporter' });
    assert.equal(bought.status, 200);
    const checkout = account.checkoutAddress(await bought.json());
    assert.match(checkout ?? '', /^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/, "the page follows Stripe's hosted page and nothing else");
    const asked = fakes.sessions.get(new URL(checkout).pathname.split('/').pop());
    assert.equal(asked.get('success_url'), `${APP_URL}?purchase=success`);
    assert.equal(asked.get('cancel_url'), `${APP_URL}?purchase=cancelled`);
    assert.equal(asked.get('metadata[app]'), 'selfreportle');
    assert.equal(asked.get('metadata[product]'), 'supporter');
    assert.equal(asked.get('mode'), 'payment');
    assert.deepEqual((await me(browser)).entitlements, [], 'a session created is not a purchase: nothing is granted before Stripe says it was paid');

    const forged = signedDelivery(fakes.paid(checkout), { secret: 'whsec_notTheSiteSecret0000000000' });
    assert.equal((await webhook(forged)).status, 400, 'an event signed with another secret is refused');
    assert.deepEqual((await me(browser)).entitlements, []);

    const delivery = signedDelivery(fakes.paid(checkout));
    assert.equal((await webhook(delivery)).status, 200);
    assert.deepEqual((await me(browser)).entitlements, ['supporter'], "Stripe's signed event grants it");
    assert.equal((await webhook(delivery)).status, 200, 'a delivery Stripe repeats is answered and changes nothing');
    assert.equal((await post(browser, 'checkout', { product: 'supporter' })).status, 409, 'and it is not sold twice');

    assert.equal((await post(browser, 'auth/logout')).status, 204);
    assert.deepEqual(await me(browser), { user: null, entitlements: [] });
    await signIn(browser, { sub: '1001', email: 'ada@example.com' });
    assert.deepEqual((await me(browser)).entitlements, ['supporter'], 'a purchase belongs to the Google account, not to the browser session');

    const forbidden = await ask(browser, 'me', { method: 'DELETE' });
    assert.equal(forbidden.status, 403, "deleting without the site's Origin is refused (CSRF)");
    const deleted = await ask(browser, 'me', { method: 'DELETE', headers: { origin: ORIGIN } });
    assert.equal(deleted.status, 204);
    assert.deepEqual(await me(browser), { user: null, entitlements: [] });
    await signIn(browser, { sub: '1001', email: 'ada@example.com' });
    assert.deepEqual((await me(browser)).entitlements, [], 'deleting the account deleted the purchase records with it');
    assert.deepEqual(fakes.unexpected, []);
    assert.deepEqual(logs, []);
  });

  it('a failed sign-in comes back to the page as ?signin=failed, which the page reads once', async () => {
    const browser = jar();
    const failed = await ask(browser, 'auth/google/callback?code=x&state=y');
    assert.equal(failed.status, 302);
    const back = failed.headers.get('location');
    assert.equal(back, `${APP_URL}?signin=failed`);
    assert.deepEqual(account.landingOf(back), { landing: { signIn: 'failed', purchase: null }, without: '/' });
  });
});

/* What README and the page's privacy line say Stripe is told, and what README says Delete account
 * leaves, held to the kit as this site runs it: a data directory of its own, read file by file. */
describe('what Stripe is told, and what Delete account leaves', () => {
  const APP_URL = 'https://selfreportle.example/';
  const ORIGIN = 'https://selfreportle.example';
  const SUB = 'subWhatIsLeft42';
  const EMAIL = 'left@example.com';

  it("Stripe is told the account id with a payment, and never the email; after Delete account only the hour's count of Buy presses names the account, for two hours at most", async () => {
    const fakes = await createFakes();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfreportle-api-left-'));
    const api = await start({ env: envFor(APP_URL), dataDir, port: 0, fetch: fakes.fetch, log: () => {} });
    local = api.url;
    try {
      const cookies = new Map();
      const ask = async (route, init = {}) => {
        const response = await realFetch(`${api.url}api/${route}`, { redirect: 'manual', ...init, headers: { ...(init.headers ?? {}), cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') } });
        for (const line of response.headers.getSetCookie()) {
          const [pair, ...attrs] = line.split(';');
          const name = pair.slice(0, pair.indexOf('='));
          if (attrs.some((a) => /^\s*Max-Age=0$/i.test(a))) cookies.delete(name);
          else cookies.set(name, pair.slice(pair.indexOf('=') + 1));
        }
        return response;
      };
      const started = await ask('auth/google/start?return=%2F');
      await ask(`auth/google/callback${fakes.consent(started.headers.get('location'), { sub: SUB, email: EMAIL }).search}`);
      const bought = await ask('checkout', { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: '{"product":"supporter"}' });
      assert.equal(bought.status, 200);
      const url = (await bought.json()).url;
      const asked = fakes.sessions.get(new URL(url).pathname.split('/').pop());
      const user = `google:${SUB}`;
      assert.equal(asked.get('client_reference_id'), user, 'the account id, as the privacy line says');
      assert.equal(asked.get('metadata[user]'), user);
      assert.equal(asked.get('payment_intent_data[metadata][user]'), user, 'and on the payment itself');
      assert.ok(![...asked.values()].some((v) => v.includes(EMAIL) || v.includes('@')), 'no email is sent to Stripe');
      const delivery = signedDelivery(fakes.paid(url));
      assert.equal((await realFetch(`${api.url}api/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': delivery.signature, 'content-type': 'application/json' }, body: delivery.body })).status, 200);
      const before = Date.now();
      assert.equal((await ask('me', { method: 'DELETE', headers: { origin: ORIGIN } })).status, 204);
      const naming = fs.readdirSync(dataDir).map((f) => JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'))).filter((e) => JSON.stringify(e).includes(SUB) || JSON.stringify(e).includes(EMAIL));
      assert.deepEqual(naming.map((e) => e.key.replace(/:\d+$/, ':<hour>')), [`selfreportle:test:ratelimit:${user}:<hour>`], 'only the count of Buy presses this hour names the account');
      assert.ok(naming[0].expires > before && naming[0].expires <= Date.now() + 2 * 3600 * 1000, 'and it expires within two hours');
      assert.ok(!naming.some((e) => JSON.stringify(e).includes(EMAIL)), 'the email is gone');
    } finally {
      await api.close();
      local = null;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('README and the page say so', () => {
    const readme = read('README.md');
    assert.ok(readme.includes('Stripe handles the payment and is told that account id with it'), 'README, the sign-in section and Privacy');
    assert.equal(readme.split('Stripe handles the payment and is told that account id with it').length - 1, 2, 'in both places README says what leaves the device');
    assert.ok(readme.includes("Deleting the account deletes all of that here but a count of the hour's Buy presses, which names the account id and expires within two hours"), 'README, the sign-in section');
    assert.ok(readme.includes("Delete account removes all of it from the site but a count of the hour's Buy presses, which names the account id and expires within two hours"), 'README, Privacy');
    assert.ok(read('web/index.html').includes('Stripe handles the payment and is told that account id with it.'), 'the privacy line the page draws');
    assert.ok(account.NOTES.deleteBody.includes('The payment itself stays with Stripe, with the account id it was made under.'), 'the question before Delete account');
  });
});

describe('server/start.mjs keeps its own catalogue', () => {
  it('a catalogue passed in by a caller does not replace this site\'s', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfreportle-api-cat-'));
    const fakes = await createFakes();
    const other = { app: 'other', name: 'Other', products: [{ id: 'pro', name: 'Pro', description: 'x', mode: 'payment', grants: 'pro' }] };
    const api = await start({ env: { ...envFor('https://selfreportle.example/'), STRIPE_PRICE_PRO: 'price_x' }, dataDir, port: 0, fetch: fakes.fetch, log: () => {}, catalogue: other });
    local = api.url;
    try {
      const body = await (await realFetch(`${api.url}api/config`)).json();
      assert.deepEqual(body.shop.products.map((p) => p.id), ['supporter'], 'still "Support this app", and nothing else');
      assert.match((await realFetch(`${api.url}api/auth/google/start?return=%2F`, { redirect: 'manual' })).headers.get('set-cookie') ?? '', /^__Host-selfreportle-oauth=/, "the cookies are this app's");
    } finally {
      await api.close();
      local = null;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('server/start.mjs with nothing set', () => {
  it('reports nothing on, and every other route is a 404', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'selfreportle-api-off-'));
    const quiet = [];
    const api = await start({ env: {}, dataDir, port: 0, fetch: () => Promise.reject(new Error('no network')), log: (level, message) => quiet.push(message) });
    local = api.url;
    try {
      assert.deepEqual(api.features, { signIn: false, shop: false });
      const config = await realFetch(`${api.url}api/config`);
      assert.equal(await config.text(), read('web/api/config').trimEnd(), 'the same answer the static file gives');
      for (const route of ['me', 'auth/google/start', 'checkout', 'webhooks/stripe']) assert.equal((await realFetch(`${api.url}api/${route}`)).status, 404, route);
      assert.deepEqual(quiet, [], 'no configuration at all is not a warning');
      assert.equal(new URL(api.url).hostname, '127.0.0.1', 'and it listens on loopback alone');
    } finally {
      await api.close();
      local = null;
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
