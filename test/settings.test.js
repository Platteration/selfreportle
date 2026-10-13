const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/settings.js');

test('existing settings keep markers-only text until the reader opts in', () => {
  assert.equal(S.normalize({ mood: 'forensic' }).textStyle, 'markers');
  for (const textStyle of ['markers', 'highlight', 'font', 'both']) {
    assert.equal(S.normalize({ textStyle }).textStyle, textStyle);
  }
  for (const textStyle of [undefined, null, '', 'unknown', {}, ['both']]) {
    assert.equal(S.normalize({ textStyle }).textStyle, 'markers');
  }
});

test('text appearance survives save/load and disabling markers without changing detection', async () => {
  let stored = { sensitivity: 'low', mood: 'quiet' };
  const previous = globalThis.chrome;
  globalThis.chrome = { storage: { sync: {
    get(defaults, done) { done({ ...defaults, ...stored }); },
    set(next, done) { stored = { ...next }; done(); },
  } } };
  try {
    await S.save({ textStyle: 'both' });
    await S.save({ showTextMarkers: false });
    const loaded = await S.load();
    assert.equal(loaded.textStyle, 'both');
    assert.equal(loaded.showTextMarkers, false);
    assert.equal(loaded.sensitivity, 'low');
    assert.equal(loaded.mood, 'quiet');
  } finally {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  }
});
