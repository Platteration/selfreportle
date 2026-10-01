/*
 * lib/settings.js: what comes back out of chrome.storage is input. Each
 * field falls back on its own, an enum is an own-property lookup, load()
 * never writes, and the one-time copy of the flat items written before the
 * namespaced record copies bytes, writes each record in its own call, never
 * removes the flat items, and does nothing the second time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/settings.js');

const D = S.DEFAULTS;

/* An in-memory chrome.storage: two areas, promise-returning like the real
 * one, with a switch to make a write or a remove fail, a gate that parks a
 * read after it has looked (the race), the sync area's per-item quota as
 * Chrome measures it (key length plus the JSON of the value, 8192 bytes,
 * the whole call refused), and a count of every call, so a test can say
 * "and it wrote nothing". */
const QUOTA_BYTES_PER_ITEM = 8192;
function fakeChrome(seed = {}, local = {}) {
  const calls = { get: 0, set: 0, remove: 0 };
  const faults = { setFails: false, removeFails: false, getFails: false, hold: null };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const area = (store, quota) => ({
    async get(keys) {
      calls.get++;
      if (faults.getFails) throw new Error('storage unavailable');
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (store.has(k)) out[k] = clone(store.get(k));
      if (faults.hold) { const gate = faults.hold; faults.hold = null; await gate; }
      return out;
    },
    async set(items) {
      calls.set++;
      if (faults.setFails) throw new Error('storage write refused');
      for (const [k, v] of Object.entries(items)) {
        if (quota && k.length + JSON.stringify(v).length > quota) throw new Error('Resource::kQuotaBytesPerItem quota exceeded');
      }
      for (const [k, v] of Object.entries(items)) store.set(k, clone(v));
    },
    async remove(keys) {
      calls.remove++;
      if (faults.removeFails) throw new Error('remove refused');
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
    },
  });
  const sync = new Map(Object.entries(seed));
  const loc = new Map(Object.entries(local));
  return { sync, local: loc, calls, faults, chrome: { storage: { sync: area(sync, QUOTA_BYTES_PER_ITEM), local: area(loc, 0) } } };
}

/* A host list whose JSON is exactly `bytes` long. */
function hostListOfJsonBytes(bytes) {
  const hosts = [];
  while (JSON.stringify(hosts).length + 20 <= bytes) hosts.push('h' + String(hosts.length).padStart(4, '0') + '.example');
  const short = bytes - JSON.stringify(hosts).length;   // 3..22: one more entry of the right length
  hosts.push('x'.repeat(short - 3));                       // quotes and the comma
  assert.equal(JSON.stringify(hosts).length, bytes);
  return hosts;
}

async function withChrome(fake, fn) {
  const real = global.chrome;
  global.chrome = fake.chrome;
  try { return await fn(); } finally { global.chrome = real; }
}

/* The sixteen flat items an earlier build wrote, every one away from its default. */
const LEGACY = {
  enabled: false, showPill: false, showImageBadges: false, showTextMarkers: false, markUnflaggedImages: true,
  fetchImages: false, maxImages: 7, maxImageBytes: 128 * 1024, inspectMedia: false, maxMediaBytes: 96 * 1024,
  minImageSize: 33, sensitivity: 'high', mood: 'forensic', platformLabels: false, rememberDomains: false,
  disabledHosts: ['Example.com.', 'intranet.local'],
};
const withoutHosts = (o) => { const c = { ...o }; delete c.disabledHosts; return c; };

test('defaults round-trip, and no record at all is the defaults', () => {
  assert.deepEqual(S.cleanSettings(D, D), D);
  assert.notEqual(S.cleanSettings(D, D), D, 'a fresh object, not the defaults themselves');
  for (const raw of [undefined, null, {}, [], 'x', 42, true]) assert.deepEqual(S.cleanSettings(raw, D), D, 'raw ' + JSON.stringify(raw));
  assert.notEqual(S.cleanSettings({}, D).disabledHosts, D.disabledHosts, 'the host list is a copy too');
});

test('every enum member round-trips', () => {
  for (const v of ['low', 'medium', 'high']) assert.equal(S.cleanSettings({ sensitivity: v }, D).sensitivity, v);
  for (const v of ['quiet', 'reader', 'forensic']) assert.equal(S.cleanSettings({ mood: v }, D).mood, v);
});

/* Built with JSON.parse: a `__proto__` literal sets the prototype, a parsed
 * one is an own key, and the own key is the case that matters. */
test('every name on Object.prototype is refused as an enum value and as a field', () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const raw = JSON.parse('{"sensitivity":' + JSON.stringify(name) + ',"mood":' + JSON.stringify(name) + '}');
    assert.deepEqual(S.cleanSettings(raw, D), D, 'enum value ' + name);
    assert.equal(S.has(S.SENSITIVITY, name), false, 'has() on ' + name);
    assert.equal(S.pick(name, S.MOOD, 'reader'), 'reader', 'pick() on ' + name);
    const key = JSON.parse('{' + JSON.stringify(name) + ':{"enabled":false,"sensitivity":"high"}}');
    const out = S.cleanSettings(key, D);
    assert.deepEqual(out, D, 'field named ' + name);
    assert.equal(Object.prototype.hasOwnProperty.call(out, name), false, 'no own ' + name + ' on the result');
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
  }
});

test('a field takes only the type of its default', () => {
  /* What used to reach content.js active() as a truthy string. */
  assert.equal(S.cleanSettings({ enabled: 'false' }, D).enabled, true);
  assert.equal(S.cleanSettings({ fetchImages: '0' }, D).fetchImages, true);
  assert.equal(S.cleanSettings({ showPill: 0 }, D).showPill, true);
  assert.equal(S.cleanSettings({ enabled: false }, D).enabled, false, 'a real boolean is kept');
  assert.equal(S.cleanSettings({ maxImages: '5e2' }, D).maxImages, D.maxImages, 'a numeric string is not a number');
  assert.equal(S.cleanSettings({ maxImages: 1e9 }, D).maxImages, 500, 'clamped to the ceiling');
  assert.equal(S.cleanSettings({ maxImages: -3 }, D).maxImages, 0, 'and the floor');
  assert.equal(S.cleanSettings({ maxImages: 12.7 }, D).maxImages, 12, 'an integer');
  assert.equal(S.cleanSettings({ maxImages: NaN }, D).maxImages, D.maxImages);
  assert.equal(S.cleanSettings({ maxImageBytes: 1e10 }, D).maxImageBytes, 32 * 1024 * 1024);
  assert.equal(S.cleanSettings({ maxMediaBytes: 0 }, D).maxMediaBytes, 64 * 1024);
  assert.equal(S.cleanSettings({ minImageSize: 9999 }, D).minImageSize, 2000);
  /* What used to throw inside the storage callback and hang load(). */
  const hostile = JSON.parse('{"maxImageBytes":{"toString":"x"},"disabledHosts":[{"toString":"x"}],"sensitivity":{"toString":"x"}}');
  assert.deepEqual(S.cleanSettings(hostile, D), D);
  assert.deepEqual(Object.keys(S.cleanSettings({ ...D, later: 1 }, D)).sort(), Object.keys(D).sort(), 'unknown fields are dropped');
});

test('the host list keeps strings only, canonicalised', () => {
  assert.deepEqual(S.cleanHosts([' Example.COM. ', 5, null, { toString: 'x' }, '', 'sub.Host.org', ['a']], []), ['example.com', 'sub.host.org']);
  assert.deepEqual(S.cleanHosts('example.com', ['fallback']), ['fallback']);
  assert.deepEqual(S.cleanHosts(undefined, []), []);
  const fallback = ['a.b'];
  assert.notEqual(S.cleanHosts(null, fallback), fallback, 'the fallback is copied, not shared');
  assert.equal(S.canonicalHost(42), '', 'canonicalHost takes strings only');
  const s = S.cleanSettings({ disabledHosts: ['Example.com.'] }, D);
  assert.equal(S.isHostDisabled(s, 'www.example.com.'), true);
  assert.equal(S.isHostDisabled(s, 'notexample.com'), false);
});

test('without chrome.storage, load() is the defaults', async () => {
  const real = global.chrome;
  global.chrome = undefined;
  try { assert.deepEqual(await S.load(), D); } finally { global.chrome = real; }
});

test('a fresh install reads the defaults and writes nothing, and the copy has nothing to copy', async () => {
  const fake = fakeChrome();
  await withChrome(fake, async () => {
    assert.deepEqual(await S.load(), D);
    assert.deepEqual(await S.migrate(), []);
    assert.deepEqual(fake.calls, { get: 2, set: 0, remove: 0 });
    assert.equal(fake.sync.size, 0);
  });
});

test('a storage that cannot be read is the defaults, not a hang', async () => {
  const fake = fakeChrome(LEGACY);
  fake.faults.getFails = true;
  await withChrome(fake, async () => {
    assert.deepEqual(await S.load(), D);
    assert.equal(fake.calls.set, 0);
  });
});

test('before the copy, load() reads the flat items and writes nothing', async () => {
  const fake = fakeChrome(LEGACY);
  await withChrome(fake, async () => {
    const s = await S.load();
    assert.deepEqual(s, { ...LEGACY, disabledHosts: ['example.com', 'intranet.local'] }, 'the reader sees the old values');
    assert.deepEqual([...fake.sync.keys()].sort(), Object.keys(LEGACY).sort(), 'the store is as it was');
    assert.deepEqual(fake.calls, { get: 1, set: 0, remove: 0 });
  });
});

test('the copy, flat items only: each record under its key in its own call, the flat items kept', async () => {
  const fake = fakeChrome(LEGACY);
  await withChrome(fake, async () => {
    assert.deepEqual(await S.migrate(), [S.KEYS.settings, S.KEYS.disabledHosts]);
    assert.deepEqual([...fake.sync.keys()].sort(), [...Object.keys(LEGACY), S.KEYS.disabledHosts, S.KEYS.settings].sort(), 'the flat items stay: a device on the old build reads only them');
    assert.deepEqual(fake.sync.get(S.KEYS.settings), withoutHosts(LEGACY), 'the object carries every field but the hosts');
    assert.deepEqual(fake.sync.get(S.KEYS.disabledHosts), LEGACY.disabledHosts, 'the hosts as they were stored, uncanonicalised');
    assert.deepEqual(fake.calls, { get: 1, set: 2, remove: 0 });
    const s = await S.load();
    assert.deepEqual(s, { ...LEGACY, disabledHosts: ['example.com', 'intranet.local'] });
  });
});

test('the copy carries bytes; validation happens on the read', async () => {
  const fake = fakeChrome({ sensitivity: 'constructor', maxImages: 'abc', enabled: 'false', disabledHosts: [3, 'A.b.'] });
  await withChrome(fake, async () => {
    await S.migrate();
    assert.equal(fake.sync.get(S.KEYS.settings).sensitivity, 'constructor', 'stored as it was');
    assert.equal(fake.sync.get(S.KEYS.settings).maxImages, 'abc');
    assert.deepEqual(fake.sync.get(S.KEYS.disabledHosts), [3, 'A.b.']);
    const s = await S.load();
    assert.equal(s.sensitivity, 'medium', 'read as its default');
    assert.equal(s.maxImages, 60);
    assert.equal(s.enabled, true);
    assert.deepEqual(s.disabledHosts, ['a.b']);
  });
});

test('namespaced only: read as is, nothing written by the copy or the read', async () => {
  const fake = fakeChrome({ [S.KEYS.settings]: withoutHosts(LEGACY), [S.KEYS.disabledHosts]: ['x.test'] });
  await withChrome(fake, async () => {
    assert.deepEqual(await S.migrate(), []);
    assert.deepEqual(await S.load(), { ...LEGACY, disabledHosts: ['x.test'] });
    assert.deepEqual(fake.calls, { get: 2, set: 0, remove: 0 });
  });
});

test('both present: the namespaced record wins and the flat items are left untouched', async () => {
  const seed = { ...LEGACY, [S.KEYS.settings]: { sensitivity: 'low' }, [S.KEYS.disabledHosts]: ['new.test'] };
  const fake = fakeChrome(seed);
  await withChrome(fake, async () => {
    const s = await S.load();
    assert.equal(s.sensitivity, 'low');
    assert.equal(s.enabled, true, 'a field the namespaced record lacks is its default, not the flat item');
    assert.deepEqual(s.disabledHosts, ['new.test']);
    assert.deepEqual(await S.migrate(), [], 'nothing to copy');
    assert.deepEqual(Object.fromEntries(fake.sync), seed, 'every item exactly as it was');
    assert.deepEqual(fake.calls, { get: 2, set: 0, remove: 0 });
  });
});

test('one record only: the copy writes just that one, the other reads as its default', async () => {
  const fake = fakeChrome({ disabledHosts: ['only.test'] });
  await withChrome(fake, async () => {
    assert.deepEqual(await S.migrate(), [S.KEYS.disabledHosts]);
    assert.deepEqual([...fake.sync.keys()].sort(), ['disabledHosts', S.KEYS.disabledHosts].sort());
    assert.deepEqual(await S.load(), { ...D, disabledHosts: ['only.test'] });
    assert.deepEqual(fake.calls, { get: 2, set: 1, remove: 0 });
  });
});

test('the copy is refused: the flat items stay, the reader still sees them, the next run completes it', async () => {
  const fake = fakeChrome(LEGACY);
  fake.faults.setFails = true;
  await withChrome(fake, async () => {
    assert.deepEqual(await S.migrate(), [], 'nothing written');
    assert.deepEqual([...fake.sync.keys()].sort(), Object.keys(LEGACY).sort(), 'nothing removed, nothing added');
    assert.equal((await S.load()).sensitivity, 'high', 'the values the user chose, not the defaults');
    assert.deepEqual(fake.calls, { get: 2, set: 2, remove: 0 });
    fake.faults.setFails = false;
    assert.deepEqual(await S.migrate(), [S.KEYS.settings, S.KEYS.disabledHosts]);
    assert.ok(fake.sync.has(S.KEYS.settings) && fake.sync.has('sensitivity'), 'copied, the flat items kept');
  });
});

/* QUOTA_BYTES_PER_ITEM counts the key, and the namespaced host-list key is
 * sixteen bytes longer than the flat one: a list of 8170 JSON bytes fitted
 * under `disabledHosts` (8183) and is refused under
 * `selfreportle.disabledHosts.v1` (8199). It must not take the settings
 * object with it, and the rest must still save. */
test('a host list that fitted under the short key: the settings still copy and still save', async () => {
  const hosts = hostListOfJsonBytes(8170);
  const fake = fakeChrome({ sensitivity: 'high', maxImages: 7, disabledHosts: hosts });
  await withChrome(fake, async () => {
    assert.deepEqual(await S.migrate(), [S.KEYS.settings], 'the object copied, the list refused');
    assert.deepEqual(fake.sync.get(S.KEYS.settings), { sensitivity: 'high', maxImages: 7 });
    assert.equal(fake.sync.has(S.KEYS.disabledHosts), false);
    const s = await S.load();
    assert.equal(s.sensitivity, 'high');
    assert.equal(s.disabledHosts.length, hosts.length, 'the list is read from the flat item');
    const saved = await S.save({ sensitivity: 'low' });
    assert.equal(saved.sensitivity, 'low');
    assert.equal(saved.disabledHosts.length, hosts.length, 'and kept across a save that did not touch it');
    assert.equal(fake.sync.get(S.KEYS.settings).sensitivity, 'low');
    assert.equal(fake.sync.has(S.KEYS.disabledHosts), false, 'an unchanged list is not rewritten, so nothing is refused');
    /* Changing the list is what asks the browser again, and the refusal
     * names the list while the rest of the save has already landed. */
    await assert.rejects(S.save({ sensitivity: 'medium', disabledHosts: [...hosts, 'one.more.example'] }), (e) => {
      assert.equal(e.code, 'hosts');
      assert.match(e.message, /paused-host list is too long/);
      return true;
    });
    assert.equal(fake.sync.get(S.KEYS.settings).sensitivity, 'medium', 'the settings object was written in its own call');
    assert.equal(fake.sync.has(S.KEYS.disabledHosts), false);
    const shorter = await S.save({ disabledHosts: hosts.slice(0, 10) });
    assert.equal(shorter.disabledHosts.length, 10);
    assert.deepEqual(fake.sync.get(S.KEYS.disabledHosts), hosts.slice(0, 10), 'a list that fits is stored and wins over the flat one');
    assert.equal((await S.load()).disabledHosts.length, 10);
  });
});

test('the copy runs once: the second run writes nothing', async () => {
  const fake = fakeChrome(LEGACY);
  await withChrome(fake, async () => {
    assert.deepEqual(await S.migrate(), [S.KEYS.settings, S.KEYS.disabledHosts]);
    assert.deepEqual(await S.migrate(), []);
    assert.deepEqual(fake.calls, { get: 2, set: 2, remove: 0 });
  });
});

test('concurrent copies agree and leave one consistent store', async () => {
  const fake = fakeChrome(LEGACY);
  await withChrome(fake, async () => {
    await Promise.all([S.migrate(), S.migrate(), S.migrate()]);
    assert.deepEqual(fake.sync.get(S.KEYS.settings), withoutHosts(LEGACY));
    assert.deepEqual(fake.sync.get(S.KEYS.disabledHosts), LEGACY.disabledHosts);
    const [a, b] = await Promise.all([S.load(), S.load()]);
    assert.deepEqual(a, b);
    assert.equal(a.sensitivity, 'high');
  });
});

/* A reader that had looked at the flat items and not yet acted must not be
 * able to land anything over a save that completed in between: load()
 * never writes. The gate parks the read after it has looked. */
test('load() never writes, so a read that raced a save cannot revert it', async () => {
  const fake = fakeChrome(LEGACY);
  await withChrome(fake, async () => {
    let release;
    fake.faults.hold = new Promise((r) => { release = r; });
    const parked = S.load();
    const saved = await S.save({ sensitivity: 'low', disabledHosts: ['new.example'] });
    assert.equal(saved.sensitivity, 'low');
    release();
    const stale = await parked;
    assert.equal(stale.sensitivity, 'high', 'the parked reader saw the store as it was');
    assert.deepEqual(await S.load(), saved, 'and changed nothing');
    assert.equal(fake.sync.get(S.KEYS.settings).sensitivity, 'low');
    assert.deepEqual(fake.sync.get(S.KEYS.disabledHosts), ['new.example']);
    assert.deepEqual(fake.calls, { get: 3, set: 2, remove: 0 }, 'the only writes are the save\'s two');
  });
});

test('save() writes the two records in two calls, hosts apart and only when changed, and returns the cleaned merge', async () => {
  const fake = fakeChrome();
  await withChrome(fake, async () => {
    const s = await S.save({ sensitivity: 'high', disabledHosts: ['A.b.', 7], maxImages: '3', later: true });
    assert.equal(s.sensitivity, 'high');
    assert.deepEqual(s.disabledHosts, ['a.b']);
    assert.equal(s.maxImages, 60);
    assert.equal('later' in s, false);
    assert.deepEqual(fake.sync.get(S.KEYS.disabledHosts), ['a.b']);
    const record = fake.sync.get(S.KEYS.settings);
    assert.equal('disabledHosts' in record, false, 'the object never carries the host list');
    assert.deepEqual(Object.keys(record).sort(), Object.keys(D).filter((k) => k !== 'disabledHosts').sort());
    assert.deepEqual(await S.load(), s);
    assert.equal(fake.calls.set, 2, 'one call per record');
    await S.save({ sensitivity: 'low' });
    assert.equal(fake.calls.set, 3, 'an unchanged host list is not rewritten');
    await S.save({ disabledHosts: [] });
    assert.equal(fake.calls.set, 5);
    assert.deepEqual(fake.sync.get(S.KEYS.disabledHosts), []);
  });
});

test('save() rejects when the browser refuses the write, naming the host list when that is what it was', async () => {
  const fake = fakeChrome();
  fake.faults.setFails = true;
  await withChrome(fake, async () => {
    await assert.rejects(S.save({ sensitivity: 'high' }), (e) => e.code === undefined && /refused/.test(e.message));
    assert.equal(fake.sync.size, 0);
  });
  const quota = fakeChrome();
  await withChrome(quota, async () => {
    await assert.rejects(S.save({ disabledHosts: hostListOfJsonBytes(8200) }), (e) => e.code === 'hosts' && /paused-host list is too long to store; remove some hosts/.test(e.message));
    assert.ok(quota.sync.has(S.KEYS.settings), 'the settings object was stored on its own');
    assert.equal(quota.sync.has(S.KEYS.disabledHosts), false);
  });
});

test('reset() writes the defaults under the two records and removes nothing: not the flat items, not local', async () => {
  const seed = { [S.KEYS.settings]: { sensitivity: 'high' }, [S.KEYS.disabledHosts]: ['a.b'], sensitivity: 'low', disabledHosts: ['old.b'] };
  const fake = fakeChrome(seed, { [S.KEYS.domains]: { 'a.b': { pages: 3 } } });
  await withChrome(fake, async () => {
    await S.reset();
    assert.deepEqual(await S.load(), D, 'the defaults, over whatever the flat items say');
    assert.deepEqual(fake.sync.get(S.KEYS.settings), withoutHosts(D));
    assert.deepEqual(fake.sync.get(S.KEYS.disabledHosts), []);
    assert.equal(fake.sync.get('sensitivity'), 'low', 'the flat item a device on the old build reads is untouched');
    assert.deepEqual(fake.sync.get('disabledHosts'), ['old.b']);
    assert.deepEqual(fake.local.get(S.KEYS.domains), { 'a.b': { pages: 3 } }, 'domain memory is not a setting');
    assert.deepEqual(fake.calls, { get: 1, set: 2, remove: 0 }, 'two writes, no remove');
  });
});
