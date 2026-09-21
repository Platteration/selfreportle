/*
 * lib/settings.js: what comes back out of chrome.storage is input. Each
 * field falls back on its own, an enum is an own-property lookup, and the
 * migration from the flat keys of 0.1.0 copies bytes, removes the old keys
 * only after the copy is stored, and does nothing the second time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/settings.js');

const D = S.DEFAULTS;

/* An in-memory chrome.storage: two areas, promise-returning like the real
 * one, with a switch to make a write or a remove fail and a count of every
 * call, so a test can say "and it wrote nothing". */
function fakeChrome(seed = {}, local = {}) {
  const calls = { get: 0, set: 0, remove: 0 };
  const faults = { setFails: false, removeFails: false, getFails: false };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const area = (store) => ({
    async get(keys) {
      calls.get++;
      if (faults.getFails) throw new Error('storage unavailable');
      const out = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) if (store.has(k)) out[k] = clone(store.get(k));
      return out;
    },
    async set(items) {
      calls.set++;
      if (faults.setFails) throw new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
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
  return { sync, local: loc, calls, faults, chrome: { storage: { sync: area(sync), local: area(loc) } } };
}

async function withChrome(fake, fn) {
  const real = global.chrome;
  global.chrome = fake.chrome;
  try { return await fn(); } finally { global.chrome = real; }
}

/* The sixteen flat items of 0.1.0, every one away from its default. */
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

test('a fresh install reads the defaults and writes nothing', async () => {
  const fake = fakeChrome();
  await withChrome(fake, async () => {
    assert.deepEqual(await S.load(), D);
    assert.deepEqual(fake.calls, { get: 1, set: 0, remove: 0 });
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

test('migration, old only: copied under the new keys, then the old ones go', async () => {
  const fake = fakeChrome(LEGACY);
  await withChrome(fake, async () => {
    const s = await S.load();
    assert.deepEqual(s, { ...LEGACY, disabledHosts: ['example.com', 'intranet.local'] }, 'the reader sees the old values');
    assert.deepEqual([...fake.sync.keys()].sort(), [S.KEYS.disabledHosts, S.KEYS.settings].sort(), 'only the two new items remain');
    assert.deepEqual(fake.sync.get(S.KEYS.settings), withoutHosts(LEGACY), 'the object carries every field but the hosts');
    assert.deepEqual(fake.sync.get(S.KEYS.disabledHosts), LEGACY.disabledHosts, 'the hosts as they were stored, uncanonicalised');
    assert.deepEqual(fake.calls, { get: 1, set: 1, remove: 1 });
  });
});

test('migration copies bytes; validation happens on the read, not in the copy', async () => {
  const fake = fakeChrome({ sensitivity: 'constructor', maxImages: 'abc', enabled: 'false', disabledHosts: [3, 'A.b.'] });
  await withChrome(fake, async () => {
    const s = await S.load();
    assert.equal(fake.sync.get(S.KEYS.settings).sensitivity, 'constructor', 'stored as it was');
    assert.equal(fake.sync.get(S.KEYS.settings).maxImages, 'abc');
    assert.deepEqual(fake.sync.get(S.KEYS.disabledHosts), [3, 'A.b.']);
    assert.equal(s.sensitivity, 'medium', 'read as its default');
    assert.equal(s.maxImages, 60);
    assert.equal(s.enabled, true);
    assert.deepEqual(s.disabledHosts, ['a.b']);
  });
});

test('migration, new only: read as is, nothing written', async () => {
  const fake = fakeChrome({ [S.KEYS.settings]: withoutHosts(LEGACY), [S.KEYS.disabledHosts]: ['x.test'] });
  await withChrome(fake, async () => {
    const s = await S.load();
    assert.deepEqual(s, { ...LEGACY, disabledHosts: ['x.test'] });
    assert.deepEqual(fake.calls, { get: 1, set: 0, remove: 0 });
  });
});

test('migration, both present: new wins and the old keys are removed', async () => {
  const fake = fakeChrome({ ...LEGACY, [S.KEYS.settings]: { sensitivity: 'low' }, [S.KEYS.disabledHosts]: ['new.test'] });
  await withChrome(fake, async () => {
    const s = await S.load();
    assert.equal(s.sensitivity, 'low');
    assert.equal(s.enabled, true, 'a field the new record lacks is its default, not the old value');
    assert.deepEqual(s.disabledHosts, ['new.test']);
    assert.deepEqual([...fake.sync.keys()].sort(), [S.KEYS.disabledHosts, S.KEYS.settings].sort());
    assert.deepEqual(fake.sync.get(S.KEYS.settings), { sensitivity: 'low' }, 'the new record is untouched');
    assert.deepEqual(fake.calls, { get: 1, set: 0, remove: 1 });
  });
});

test('migration, one record only: the other stays absent and reads as its default', async () => {
  const fake = fakeChrome({ disabledHosts: ['only.test'] });
  await withChrome(fake, async () => {
    const s = await S.load();
    assert.deepEqual(s, { ...D, disabledHosts: ['only.test'] });
    assert.deepEqual([...fake.sync.keys()], [S.KEYS.disabledHosts]);
    const again = await S.load();
    assert.deepEqual(again, s);
    assert.deepEqual(fake.calls, { get: 2, set: 1, remove: 1 });
  });
});

test('migration, write fails: the old keys stay for next time and the reader still sees them', async () => {
  const fake = fakeChrome(LEGACY);
  fake.faults.setFails = true;
  await withChrome(fake, async () => {
    const s = await S.load();
    assert.equal(s.sensitivity, 'high', 'the values the user chose, not the defaults');
    assert.deepEqual([...fake.sync.keys()].sort(), Object.keys(LEGACY).sort(), 'nothing removed, nothing added');
    assert.deepEqual(fake.calls, { get: 1, set: 1, remove: 0 });
    fake.faults.setFails = false;
    await S.load();
    assert.deepEqual([...fake.sync.keys()].sort(), [S.KEYS.disabledHosts, S.KEYS.settings].sort(), 'the next load completes it');
  });
});

test('migration, remove fails: both present until the next load, which reads new and retries', async () => {
  const fake = fakeChrome(LEGACY);
  fake.faults.removeFails = true;
  await withChrome(fake, async () => {
    const s = await S.load();
    assert.equal(s.sensitivity, 'high');
    assert.ok(fake.sync.has(S.KEYS.settings) && fake.sync.has('sensitivity'), 'copied, old not removed');
    fake.faults.removeFails = false;
    fake.sync.set(S.KEYS.settings, { ...fake.sync.get(S.KEYS.settings), sensitivity: 'low' }); // a later build wrote NEW
    const again = await S.load();
    assert.equal(again.sensitivity, 'low', 'new wins over the stale old copy');
    assert.deepEqual([...fake.sync.keys()].sort(), [S.KEYS.disabledHosts, S.KEYS.settings].sort());
    assert.deepEqual(fake.calls, { get: 2, set: 1, remove: 2 });
  });
});

test('migration runs once: the second load writes nothing', async () => {
  const fake = fakeChrome(LEGACY);
  await withChrome(fake, async () => {
    const first = await S.load();
    const second = await S.load();
    assert.deepEqual(second, first);
    assert.deepEqual(fake.calls, { get: 2, set: 1, remove: 1 });
  });
});

test('concurrent loads during the migration agree and leave one consistent store', async () => {
  const fake = fakeChrome(LEGACY);
  await withChrome(fake, async () => {
    const [a, b, c] = await Promise.all([S.load(), S.load(), S.load()]);
    assert.deepEqual(a, b);
    assert.deepEqual(b, c);
    assert.equal(a.sensitivity, 'high');
    assert.deepEqual([...fake.sync.keys()].sort(), [S.KEYS.disabledHosts, S.KEYS.settings].sort());
    assert.deepEqual(fake.sync.get(S.KEYS.settings), withoutHosts(LEGACY));
  });
});

test('save() writes the two records, hosts apart, and returns the cleaned merge', async () => {
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
  });
});

test('save() rejects when the browser refuses the write', async () => {
  const fake = fakeChrome();
  fake.faults.setFails = true;
  await withChrome(fake, async () => {
    await assert.rejects(S.save({ disabledHosts: ['a.b'] }), /quota/);
    assert.equal(fake.sync.size, 0);
  });
});

test('reset() removes the settings records and any legacy item, and nothing in local', async () => {
  const fake = fakeChrome({ [S.KEYS.settings]: { sensitivity: 'high' }, [S.KEYS.disabledHosts]: ['a.b'], sensitivity: 'low' }, { [S.KEYS.domains]: { 'a.b': { pages: 3 } } });
  await withChrome(fake, async () => {
    await S.reset();
    assert.equal(fake.sync.size, 0, 'sync is empty');
    assert.deepEqual(await S.load(), D, 'and a stale legacy item cannot migrate back over the defaults');
    assert.deepEqual(fake.local.get(S.KEYS.domains), { 'a.b': { pages: 3 } }, 'domain memory is not a setting');
  });
});
