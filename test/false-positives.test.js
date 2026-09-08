const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../lib/signals.js');
const T = require('../lib/text-analyzer.js');
const A = require('../lib/site-analyzer.js');
const AT = require('../lib/attribution.js');
const H = require('../lib/history.js');

/*
 * This tool tells a reader that a page may be machine-made. Saying so wrongly
 * has a cost — it maligns whoever wrote the page — so the cases below are the
 * ones where an earlier version accused ordinary content, kept here so a
 * pattern edit cannot quietly bring them back.
 */

const site = (o) => A.analyzeSite(Object.assign({ hostname: 'x', bodyText: '' }, o));

test('an unrecognised AI-disclosure meta value is not read as a declaration of AI', () => {
  for (const content of ['', 'unknown', 'no AI was used', 'n/a', 'see policy']) {
    assert.notEqual(site({ metas: [{ name: 'ai-generated', content }] }).verdict, 'ai-disclosed', JSON.stringify(content));
  }
  for (const content of ['true', 'yes', 'assisted', 'generated', 'AI-generated']) {
    assert.equal(site({ metas: [{ name: 'ai-generated', content }] }).verdict, 'ai-disclosed', JSON.stringify(content));
  }
  assert.equal(site({ metas: [{ name: 'ai-generated', content: 'false' }] }).signals[0].id, 'meta-human');
});

test('a person whose name collides with a product name is not an AI system', () => {
  // "Runway" is deliberately still matched: as a creator it means the product
  // far more often than a surname, and the Person guard below covers the rest.
  for (const name of ['Randall Cooper', 'Leonardo Rossi', 'Dallas Herald', 'Luca Playground', 'Sora Tanaka Photography'.replace('Sora ', '')]) {
    assert.equal(S.AI_GENERATOR_RE.test(name), false, name);
  }
  for (const tool of ['OpenAI', 'DALL-E 3', 'Leonardo.Ai', 'Playground AI', 'Midjourney', 'Stability AI', 'ComfyUI']) {
    assert.equal(S.AI_GENERATOR_RE.test(tool), true, tool);
  }
  // Structured data that types the creator as a Person is naming a human.
  assert.equal(site({ jsonLd: ['{"@type":"Person","author":{"name":"Randall Cooper"}}'] }).verdict, 'no-signal');
  assert.equal(site({ jsonLd: ['{"@type":"Organization","creator":{"name":"ChatGPT"}}'] }).verdict, 'ai-disclosed');
});

test('"Here is a summary" is ordinary prose, not an assistant transcript', () => {
  assert.equal(T.analyzeText('Here is a summary of what our team achieved last year. We opened two shops and hired four people.').verdict, 'no-signal');
  assert.equal(T.analyzeText('Here is the guide our engineers wrote for fitting the bracket by hand.').verdict, 'no-signal');
  // The distinctive forms still land.
  assert.equal(T.analyzeText('Here is a 300-word article about roofing in Ohio. Roofs matter a great deal.').verdict, 'ai');
  assert.equal(T.analyzeText('Certainly! Here is a summary of our services. We fix roofs.').verdict, 'ai');
});

test('prose mentioning "parameters" is not Stable Diffusion metadata', () => {
  const ai = [{ verdict: 'ai-generated', hard: true, strength: 0.9 }];
  assert.equal(AT.attributeImage(ai, { exif: { imageDescription: 'Flight test parameters recorded at Cape Town.' } }).id, null);
  // The actual PNG text chunk of that name still attributes.
  assert.equal(AT.attributeImage(ai, { pngText: { parameters: 'a cat\nSteps: 20, Sampler: Euler' } }).id, 'stability');
});

test('an unprofiled AI builder is named as itself, never as some other company', () => {
  const r = AT.attributeSite({ verdict: 'ai-built', builder: { name: 'Some New Builder', kind: 'ai-builder' } });
  assert.equal(r.id, null);
  assert.equal(r.name, 'Some New Builder');
  assert.ok(r.skews.length, 'generic site skews still offered');
});

/* False negatives: signals that were silently unreachable. */

test('a generator tag behind another one is still found', () => {
  assert.equal(site({ metas: [{ name: 'generator', content: 'Next.js' }, { name: 'generator', content: 'v0 by Vercel' }] }).verdict, 'ai-built');
  assert.equal(site({ metas: [{ name: 'generator', content: 'Elementor 3.2' }, { name: 'generator', content: 'WordPress 6.5' }] }).builder.name, 'WordPress');
});

test('a declared language in upper case still selects its lexicon', () => {
  const de = 'Diese Website wurde mit Hilfe von KI erstellt.';
  for (const lang of ['de', 'DE', 'de-DE', 'DE-de']) {
    assert.equal(site({ lang, bodyText: de }).verdict, 'ai-disclosed', lang);
  }
});

test('curly apostrophes, which is what pasted chat output uses, are read the same', () => {
  // Long enough that stylometry actually runs, so the comparison is meaningful.
  const straight = "In today's fast-paced digital landscape, let's dive into what it's important to note about modern business. "
    + "It's no secret that whether you're a startup or an enterprise, we'll explore the realm of innovation together. "
    + "It's not just about tools; it's important to note that the landscape keeps shifting under everyone who works in it today.";
  const curly = straight.replace(/'/g, '’');
  const a = T.analyzeText(straight);
  const b = T.analyzeText(curly);
  assert.equal(a.verdict, b.verdict, 'verdict must not turn on the apostrophe glyph');
  assert.equal(a.score, b.score);
  assert.ok(a.score > 0, 'the lexicon actually fired, so the comparison means something');
  // And in disclosures.
  assert.equal(S.findDisclosures("Here’s the thing: this article was generated by AI.").length, 1);
});

test('a repeated phrase does not use up the budget before other levels are scanned', () => {
  const text = 'This image was generated by AI. '.repeat(30) + 'All our text is 100% human-written.';
  const levels = S.findDisclosures(text).map((d) => d.level);
  assert.ok(levels.includes('generated'));
  assert.ok(levels.includes('human'), 'the human claim must still be found');
});

test('whole-page mode can actually measure paragraphs', () => {
  const para = 'This is a paragraph of roughly equal length written to measure uniformity across a page. '.repeat(2);
  const r = T.analyzeText(Array.from({ length: 6 }, () => para).join('\n\n'), { mode: 'page' });
  assert.equal(typeof r.stylometry.paragraphLengthCV, 'number', 'paragraph statistics were unreachable before');
  assert.ok(r.signals.some((s) => s.id === 'paragraph-uniformity'));
});

test('concurrent tabs do not lose each other history writes', async () => {
  const store = {};
  const realChrome = global.chrome;
  global.chrome = { storage: { local: {
    get: (k) => new Promise((r) => setTimeout(() => r({ [k]: JSON.parse(JSON.stringify(store[k] || {})) }), 3)),
    set: (o) => new Promise((r) => setTimeout(() => { Object.assign(store, o); r(); }, 3)),
  } } };
  try {
    const page = (host) => ({ hostname: host, url: 'https://' + host + '/', overall: 'undisclosed-ai', images: { total: 1, counts: {} }, aiSystems: [] });
    await Promise.all([H.record(page('a.test')), H.record(page('b.test')), H.record(page('a.test')), H.record(page('c.test'))]);
    const all = store[H.KEY];
    assert.deepEqual(Object.keys(all).sort(), ['a.test', 'b.test', 'c.test']);
    assert.equal(all['a.test'].pages, 2);
  } finally {
    global.chrome = realChrome;
  }
});
