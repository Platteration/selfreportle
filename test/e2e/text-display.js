/* Browser rendering/component checks; no extension installation required.
 * Runs from the extension E2E suite, or: node test/e2e/text-display.js
 * The options-page storage bridge is simulated; extension integration is
 * separately exercised by run.js with a real service worker.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');

async function run(context) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.setContent('<main style="font:18px/1.7 Georgia,serif"><p id="weak">A weak hint.</p><p id="likely">A likely signal.</p><p id="strong">Strong evidence.</p><p id="assisted">Assistance disclosed.</p><p id="disclosed">Generation disclosed.</p><p id="human">Human declaration.</p><p id="none">No signal.</p><div id="mixed">Own text <p id="nested">Nested text</p><code>code</code><span contenteditable="plaintext-only">editing</span><button>button</button></div><p id="editable" contenteditable="true">Editable text.</p><p id="code"><code>const untouched = true;</code></p></main>');
    await page.addStyleTag({ path: path.join(ROOT, 'content/content.css') });
    for (const file of ['lib/settings.js', 'lib/verdicts.js', 'lib/text-display.js', 'content/overlay.js']) {
      await page.addScriptTag({ path: path.join(ROOT, file) });
    }
    const checks = await page.evaluate(() => {
      const O = SRL.overlay;
      const defaults = { ...SRL.settings.DEFAULTS, showPill: false };
      O.init(defaults);
      const ids = { weak: 'possible-ai', likely: 'likely-ai', strong: 'ai', assisted: 'ai-assisted-disclosed', disclosed: 'ai-disclosed', human: 'human-disclosed', none: 'no-signal', mixed: 'ai', editable: 'ai', code: 'ai' };
      const originalText = document.querySelector('main').textContent;
      const originalNodes = document.querySelector('main').querySelectorAll('*').length;
      const font = (id) => getComputedStyle(document.getElementById(id)).fontFamily;
      const baseFont = font('weak');
      const add = (key, id, verdict) => O.upsertMarker({ key, el: document.getElementById(id), kind: 'text', verdict, details: [] });
      for (const [id, verdict] of Object.entries(ids)) add(id, id, verdict);
      const result = { defaultUntouched: font('weak') === baseFont && CSS.highlights.size === 0 };
      O.applySettings({ ...defaults, textStyle: 'font' });
      result.font = { weak: font('weak'), likely: font('likely'), strong: font('strong'), spacing: getComputedStyle(document.getElementById('strong')).letterSpacing, human: font('human'), none: font('none'), nested: font('nested'), baseFont };
      result.protectedFonts = ['mixed', 'editable', 'code'].every((id) => !document.getElementById(id).hasAttribute('data-srl-font'));
      result.fontOnly = CSS.highlights.size === 0;
      O.applySettings({ ...defaults, textStyle: 'highlight' });
      result.highlightOnly = !document.querySelector('[data-srl-font]') && CSS.highlights.size === 5;
      const markedText = () => [...CSS.highlights.values()].flatMap((h) => [...h].map((r) => r.toString())).join('|');
      result.highlightedText = markedText();
      O.applySettings({ ...defaults, textStyle: 'both' });
      result.both = !!document.querySelector('[data-srl-font]') && CSS.highlights.size === 5;
      O.setVisible(false);
      result.hidden = !document.querySelector('[data-srl-text], [data-srl-font]') && CSS.highlights.size === 0;
      add('late', 'weak', 'possible-ai');
      result.lateWhileHidden = !document.querySelector('[data-srl-text], [data-srl-font]') && CSS.highlights.size === 0;
      O.removeMarker('late');
      O.setVisible(true);
      result.restored = !!document.querySelector('[data-srl-font]') && CSS.highlights.size === 5;
      for (const mood of ['quiet', 'reader', 'forensic']) {
        O.applySettings({ ...defaults, mood, textStyle: 'both' });
        result['mood-' + mood] = font('strong') === result.font.strong && CSS.highlights.size === 5;
      }
      O.applySettings({ ...defaults, textStyle: 'both', showTextMarkers: false });
      result.disabled = !document.querySelector('[data-srl-text], [data-srl-font]') && CSS.highlights.size === 0;
      O.applySettings({ ...defaults, textStyle: 'both' });
      add('moving', 'weak', 'ai');
      add('moving', 'likely', 'ai');
      result.moved = !document.getElementById('weak').hasAttribute('data-srl-font') && font('likely') === result.font.strong;
      O.removeMarker('moving');
      result.removed = !document.querySelector('[data-srl-font]') && CSS.highlights.size === 0;
      add('clear', 'strong', 'ai');
      O.clearMarkers();
      result.cleared = !document.querySelector('[data-srl-text], [data-srl-font]') && CSS.highlights.size === 0;
      result.textPreserved = originalText === document.querySelector('main').textContent && originalNodes === document.querySelector('main').querySelectorAll('*').length;
      return result;
    });
    for (const key of ['defaultUntouched', 'protectedFonts', 'fontOnly', 'highlightOnly', 'both', 'hidden', 'lateWhileHidden', 'restored', 'mood-quiet', 'mood-reader', 'mood-forensic', 'disabled', 'moved', 'removed', 'cleared', 'textPreserved']) assert.equal(checks[key], true, key);
    assert.match(checks.font.weak, /Arial/);
    assert.match(checks.font.likely, /monospace/);
    assert.match(checks.font.strong, /monospace/);
    assert.ok(parseFloat(checks.font.spacing) > 0);
    for (const id of ['human', 'none', 'nested']) assert.equal(checks.font[id], checks.font.baseFont, id + ' font unchanged');
    assert.match(checks.highlightedText, /Own text/);
    assert.doesNotMatch(checks.highlightedText, /Nested|code|editing|button|Editable|const untouched|Human declaration|No signal/);

    // Content scripts have their own JavaScript world. Confirm that highlights
    // created in an isolated world still belong to the rendered document.
    const cdp = await context.newCDPSession(page);
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'text-display-test' });
    const displaySource = fs.readFileSync(path.join(ROOT, 'lib/text-display.js'), 'utf8');
    const isolated = await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: displaySource + '\nSRL.textDisplay.apply(document.getElementById("strong"), "ai", "both");' });
    assert.equal(isolated.exceptionDetails, undefined, 'isolated-world display succeeds');
    assert.equal(await page.evaluate(() => CSS.highlights.get('srl-text-ai').size), 1, 'highlight registry shared with document');
    await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: 'SRL.textDisplay.clear(document.getElementById("strong"));' });
    await cdp.detach();

    // Use the real settings HTML, stylesheet and scripts. Only chrome.storage
    // is bridged for this ordinary web page; no browser policy is changed.
    const html = fs.readFileSync(path.join(ROOT, 'options/options.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
    await page.setContent(html);
    await page.addStyleTag({ path: path.join(ROOT, 'content/content.css') });
    await page.evaluate(() => {
      globalThis.testSettings = {};
      globalThis.chrome = {
        runtime: { getManifest() { return { version: '0.1.0' }; }, sendMessage() { return Promise.resolve({}); } },
        storage: { sync: {
          async get(defaults, done) {
            const out = { ...testSettings };
            if (done) done(out);
            return out;
          },
          async set(values, done) {
            Object.assign(testSettings, values, values['selfreportle.settings.v1'] || {});
            if (done) done();
          },
          clear() { testSettings = {}; return Promise.resolve(); },
        } },
      };
    });
    for (const file of ['lib/settings.js', 'lib/text-display.js', 'options/options.js']) await page.addScriptTag({ path: path.join(ROOT, file) });
    await page.waitForFunction(() => document.querySelector('[name="textStyle"]').value === 'markers');
    const appearance = page.locator('[name="textStyle"]');
    for (const theme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: theme });
      for (const mode of ['markers', 'highlight', 'font', 'both']) {
        await appearance.selectOption(mode);
        const state = await page.evaluate(() => ({ fonts: document.querySelectorAll('[data-srl-font]').length, highlights: CSS.highlights.size }));
        assert.equal(state.fonts, ['font', 'both'].includes(mode) ? 5 : 0, theme + ' ' + mode + ' fonts');
        assert.equal(state.highlights, ['highlight', 'both'].includes(mode) ? 5 : 0, theme + ' ' + mode + ' highlights');
        if (process.env.SRL_SCREENSHOT_DIR) {
          fs.mkdirSync(process.env.SRL_SCREENSHOT_DIR, { recursive: true });
          await page.locator('#textPreview').screenshot({ path: path.join(process.env.SRL_SCREENSHOT_DIR, theme + '-' + mode + '.png') });
        }
      }
      const colors = await page.evaluate(() => [...document.querySelectorAll('[data-preview-verdict]')].map((el) => {
        const s = getComputedStyle(el, '::highlight(srl-text-' + el.dataset.previewVerdict + ')');
        return [s.color, s.backgroundColor];
      }));
      for (const [fg, bg] of colors) assert.ok(contrast(fg, bg) >= 4.5, theme + ': ' + fg + ' on ' + bg + ' meets AA');
    }
    await appearance.focus();
    assert.equal(await appearance.evaluate((el) => getComputedStyle(el).outlineStyle), 'solid', 'keyboard focus visible');
    await page.locator('button[type="submit"]').click();
    await page.waitForFunction(() => testSettings.textStyle === 'both');
    await page.locator('[name="showTextMarkers"]').uncheck();
    assert.equal(await appearance.isDisabled(), true);
    assert.equal(await page.evaluate(() => CSS.highlights.size), 0);
    await page.locator('button[type="submit"]').click();
    await page.waitForFunction(() => testSettings.showTextMarkers === false && testSettings.textStyle === 'both');
    await page.locator('[name="showTextMarkers"]').check();
    assert.equal(await appearance.inputValue(), 'both', 'choice retained after disabling');
    page.once('dialog', (d) => d.accept());
    await page.locator('#reset').click();
    await page.waitForFunction(() => document.querySelector('[name="textStyle"]').value === 'markers' && CSS.highlights.size === 0);
    assert.deepEqual(errors, [], 'no page errors');
    console.log('Text display browser checks OK: modes, signal levels, cleanup, protected text, both themes, contrast, settings save/reset.');
  } finally { await page.close(); }
}

function contrast(a, b) {
  const luminance = (rgb) => {
    const values = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
    return values[0] * .2126 + values[1] * .7152 + values[2] * .0722;
  };
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

module.exports = { run };
if (require.main === module) {
  (async () => {
    let playwright;
    try { playwright = require('playwright'); } catch {
      playwright = require(path.join(require('node:child_process').execSync('npm root -g').toString().trim(), 'playwright'));
    }
    const browser = await playwright.chromium.launch({ headless: false, executablePath: process.env.PW_CHROMIUM || undefined, args: ['--headless=new'] });
    try { await run(await browser.newContext({ viewport: { width: 1000, height: 1100 } })); }
    finally { await browser.close(); }
  })().catch((error) => { console.error(error); process.exitCode = 1; });
}
