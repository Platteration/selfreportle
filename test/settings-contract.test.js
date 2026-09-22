/*
 * The settings contract, pinned as literals: the storage keys, the fields
 * and their defaults, the enum tables, and the options page that offers
 * them. A renamed key or a dropped member fails here before it orphans a
 * user's stored record or leaves a row on the page with nothing behind it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const S = require('../lib/settings.js');
const H = require('../lib/history.js');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const APP_NAME = 'Selfreportle';
const SOURCE_URL = 'https://github.com/Platteration/selfreportle';

test('the storage keys', () => {
  assert.deepEqual({ ...S.KEYS }, {
    settings: 'selfreportle.settings.v1',
    disabledHosts: 'selfreportle.disabledHosts.v1',
    domains: 'srl:domains',
  });
  assert.equal(H.KEY, S.KEYS.domains, 'the domain memory reads its key from the table');
  assert.ok(Object.isFrozen(S.KEYS));
});

/* The flat items written before the namespaced record. They are read
 * whenever the namespaced key is absent and never removed: sync storage is
 * one store per browser profile, and a device still on the old build writes
 * only these and reads only these. */
test('the legacy keys, one item per field, kept for the old build', () => {
  assert.deepEqual([...S.LEGACY_KEYS], [
    'enabled', 'showPill', 'showImageBadges', 'showTextMarkers', 'markUnflaggedImages', 'fetchImages',
    'maxImages', 'maxImageBytes', 'inspectMedia', 'maxMediaBytes', 'minImageSize', 'sensitivity', 'mood',
    'platformLabels', 'rememberDomains', 'disabledHosts',
  ]);
});

test('the fields and their defaults', () => {
  assert.deepEqual(S.DEFAULTS, {
    enabled: true,
    showPill: true,
    showImageBadges: true,
    showTextMarkers: true,
    markUnflaggedImages: false,
    fetchImages: true,
    maxImages: 60,
    maxImageBytes: 4194304,
    inspectMedia: true,
    maxMediaBytes: 524288,
    minImageSize: 80,
    sensitivity: 'medium',
    mood: 'reader',
    platformLabels: true,
    rememberDomains: true,
    disabledHosts: [],
  });
  assert.deepEqual({ ...S.RANGES }, {
    maxImages: [0, 500],
    maxImageBytes: [65536, 33554432],
    maxMediaBytes: [65536, 8388608],
    minImageSize: [16, 2000],
  }, 'every numeric field has its bounds');
  assert.deepEqual(Object.keys(S.RANGES).sort(), Object.keys(S.DEFAULTS).filter((k) => typeof S.DEFAULTS[k] === 'number').sort());
});

test('the enum tables', () => {
  assert.deepEqual({ ...S.SENSITIVITY }, { low: true, medium: true, high: true });
  assert.deepEqual({ ...S.MOOD }, { quiet: true, reader: true, forensic: true });
  for (const t of [S.SENSITIVITY, S.MOOD]) assert.ok(Object.isFrozen(t));
});

/* The rows: one control per field on the options page, the selects offering
 * exactly the table members and the number inputs declaring the same bounds
 * the validator applies. */
test('the options page offers every field, every enum member and the same bounds', () => {
  const html = read('options/options.html');
  const names = [...html.matchAll(/name="([^"]+)"/g)].map((m) => m[1]);
  const onPage = names.map((n) => (n === 'maxImageKB' ? 'maxImageBytes' : n === 'maxMediaKB' ? 'maxMediaBytes' : n));
  assert.deepEqual(onPage.sort(), Object.keys(S.DEFAULTS).sort());
  const options = (name) => [...html.match(new RegExp('<select name="' + name + '">[\\s\\S]*?</select>'))[0].matchAll(/value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(options('sensitivity'), ['low', 'medium', 'high']);
  assert.deepEqual(options('mood'), ['quiet', 'reader', 'forensic']);
  const bounds = (name) => { const m = html.match(new RegExp('name="' + name + '" min="(\\d+)" max="(\\d+)"')); return [Number(m[1]), Number(m[2])]; };
  assert.deepEqual(bounds('maxImages'), S.RANGES.maxImages);
  assert.deepEqual(bounds('minImageSize'), S.RANGES.minImageSize);
  assert.deepEqual(bounds('maxImageKB').map((n) => n * 1024), S.RANGES.maxImageBytes);
  assert.deepEqual(bounds('maxMediaKB').map((n) => n * 1024), S.RANGES.maxMediaBytes);
});

test('the options page confirms what it cannot undo, and only that', () => {
  const js = read('options/options.js');
  const handler = (id) => js.slice(js.indexOf("getElementById('" + id + "')"), js.indexOf('});', js.indexOf("getElementById('" + id + "')")));
  assert.match(handler('reset'), /window\.confirm\(/, 'Reset asks first');
  assert.match(handler('clearHistory'), /window\.confirm\(/, 'Clear domain memory asks first');
  assert.doesNotMatch(handler('clearCache'), /confirm\(/, 'a re-fetchable cache asks nothing');
  assert.match(handler('reset'), /S\.reset\(\)/, 'Reset goes through the module, which names the keys');
  assert.doesNotMatch(js, /chrome\.storage\./, 'the options page touches no storage key of its own');
});

test('About: the name, the manifest version (equal to package.json), the source link that opens beside the page', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.short_name, APP_NAME);
  assert.match(read('options/options.js'), /chrome\.runtime\.getManifest\(\)\.version/);
  const html = read('options/options.html');
  assert.match(html, /<strong>Selfreportle<\/strong> <span id="version"><\/span>/, 'the app name beside the version');
  /* options_ui.open_in_tab: a link without target navigates the options tab
   * itself to the source host. */
  assert.ok(html.includes(`<a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">MIT licence · source</a>`), 'the licence and source link');
  assert.match(html, /Privacy: all analysis runs in this browser/, 'the privacy sentence');
});

/* Every storage key the extension writes is spelled in lib/settings.js and
 * nowhere else in the shipped scripts, so a new key added beside its own
 * module lands here. The one exemption is stated: the worker's per-tab
 * results under 'tab:<id>' in chrome.storage.session are a cache that ends
 * with the tab, not a record, and are built where they are used. */
test('no storage key string is spelled outside lib/settings.js', () => {
  const files = [];
  for (const dir of ['lib', 'background', 'content', 'popup', 'options', 'publisher']) {
    for (const name of fs.readdirSync(path.join(root, dir))) if (name.endsWith('.js')) files.push(path.join(dir, name));
  }
  assert.ok(files.length > 15, 'the walk found the shipped scripts');
  const spelled = [];
  for (const f of files) {
    if (f === path.join('lib', 'settings.js')) continue;
    const src = read(f);
    for (const m of src.matchAll(/['"`](srl:domains|selfreportle\.[A-Za-z][A-Za-z0-9.]*)['"`]/g)) spelled.push(f + ': ' + m[1]);
    for (const m of src.matchAll(/chrome\.storage\.(sync|local)\.(get|set|remove|clear)\(/g)) {
      assert.equal(f, path.join('lib', 'history.js'), f + ' reaches chrome.storage.' + m[1] + ' directly; only lib/settings.js and lib/history.js (through S.KEYS.domains) do');
    }
    for (const m of src.matchAll(/chrome\.storage\.session\b/g)) assert.equal(f, path.join('background', 'service-worker.js'), f + ' uses the session area, which only the worker\'s tab cache does');
  }
  assert.deepEqual(spelled, [], 'strings outside the table that look like a storage key');
});

/* The one-time copy of the flat items runs from the worker's onInstalled,
 * and load() only reads: a reader that writes can land a stale copy over a
 * save that completed in between (test/settings.test.js stages the race). */
test('the copy runs from onInstalled, and load() is read-only', () => {
  const SW = read('background/service-worker.js');
  assert.match(SW, /chrome\.runtime\.onInstalled\.addListener\([\s\S]*?S\.settings\.migrate\(\)/, 'the worker copies on install and update');
  assert.doesNotMatch(String(S.load), /\.set\(|\.remove\(|migrate\(/, 'load() writes nothing');
  assert.doesNotMatch(String(S.migrate) + String(S.save) + String(S.reset), /\.remove\(|\.clear\(/, 'nothing removes the flat items');
});

test('the accessibility floor on the options page', () => {
  const html = read('options/options.html');
  /* A control has a name when a <label> wraps it, a <label for> names its
   * id, or it carries aria-label/aria-labelledby. An id alone names
   * nothing. */
  const labelFor = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]));
  const controls = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/g)];
  assert.ok(controls.length >= 16, 'the walk found the controls');
  for (const c of controls) {
    const before = html.slice(0, c.index);
    const wrapped = before.lastIndexOf('<label') > before.lastIndexOf('</label>');
    const id = (c[0].match(/\bid="([^"]+)"/) || [])[1];
    const named = wrapped || (id !== undefined && labelFor.has(id)) || /\baria-label(?:ledby)?="[^"]+"/.test(c[0]);
    assert.ok(named, 'unlabelled control: ' + c[0]);
  }
  for (const b of [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)]) {
    assert.ok(b[1].trim() || /aria-label=/.test(b[0]), 'a button with no text needs aria-label: ' + b[0]);
  }
  assert.match(html, /id="status" role="status" aria-live="polite"/, 'the flash is announced');
});
