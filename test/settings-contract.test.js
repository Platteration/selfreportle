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

test('the storage keys', () => {
  assert.deepEqual({ ...S.KEYS }, {
    settings: 'selfreportle.settings.v1',
    disabledHosts: 'selfreportle.disabledHosts.v1',
    domains: 'srl:domains',
  });
  assert.equal(H.KEY, S.KEYS.domains, 'the domain memory reads its key from the table');
  assert.ok(Object.isFrozen(S.KEYS));
});

test('the legacy keys of 0.1.0, one item per field', () => {
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

test('About shows the manifest version, and the manifest agrees with package.json', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.version, pkg.version);
  assert.match(read('options/options.js'), /chrome\.runtime\.getManifest\(\)\.version/);
  const html = read('options/options.html');
  assert.match(html, /id="version"/);
  assert.match(html, /MIT licence · source/);
  assert.match(html, /href="https:\/\/github\.com\/Platteration\/selfreportle"/);
});

test('the accessibility floor on the options page', () => {
  const html = read('options/options.html');
  /* Every control sits inside its label; a control outside one needs a
   * name of its own. */
  const controls = [...html.matchAll(/<(input|select|textarea)\b[^>]*>/g)];
  for (const c of controls) {
    const before = html.slice(0, c.index);
    const inLabel = before.lastIndexOf('<label') > before.lastIndexOf('</label>');
    assert.ok(inLabel || /aria-label=|id="/.test(c[0]), 'unlabelled control: ' + c[0]);
  }
  for (const b of [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)]) {
    assert.ok(b[1].trim() || /aria-label=/.test(b[0]), 'a button with no text needs aria-label: ' + b[0]);
  }
  assert.match(html, /id="status" role="status" aria-live="polite"/, 'the flash is announced');
});
