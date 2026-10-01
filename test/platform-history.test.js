const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../lib/platform-labels.js');
const H = require('../lib/history.js');

/* Minimal DOM stand-in: enough for scanLabels without a browser. */
function node(tag, opts = {}) {
  const n = {
    tagName: tag.toUpperCase(),
    attrs: opts.attrs || {},
    childNodes: (opts.text ? [{ nodeType: 3, nodeValue: opts.text }] : []),
    children: opts.children || [],
    parentElement: null,
    getAttribute(k) { return this.attrs[k] || null; },
    matches(sel) { return (opts.matches || []).some((m) => sel.includes(m)); },
    getBoundingClientRect() { return opts.rect || { width: 0, height: 0 }; },
    querySelectorAll(sel) {
      const want = sel.split(',').map((s) => s.trim().toUpperCase());
      const out = [];
      const walk = (x) => { for (const c of x.children) { if (want.includes(c.tagName)) out.push(c); walk(c); } };
      walk(this);
      return out;
    },
  };
  for (const c of n.children) c.parentElement = n;
  return n;
}

function doc(children) {
  const root = node('body', { children });
  const all = [];
  const walk = (x) => { for (const c of x.children) { all.push(c); walk(c); } };
  walk(root);
  return { querySelectorAll: () => all, root };
}

test('platform is matched by host, not by page content', () => {
  assert.equal(P.platformFor('www.instagram.com').id, 'meta');
  assert.equal(P.platformFor('m.youtube.com').id, 'youtube');
  assert.equal(P.platformFor('notinstagram.evil.com'), null);
  assert.equal(P.platformFor('example.com'), null);
});

test('Instagram "Made with AI" chip attaches to the post image', () => {
  const img = node('img', { rect: { width: 400, height: 400 } });
  const chip = node('span', { text: 'Made with AI' });
  const post = node('article', { children: [img, chip], matches: ['article'] });
  const labels = P.scanLabels('www.instagram.com', doc([post]));
  assert.equal(labels.length, 1);
  assert.equal(labels[0].level, 'generated');
  assert.equal(labels[0].media, img);
  const sig = P.toImageSignal(labels[0]);
  assert.equal(sig.verdict, 'ai-disclosed');
  assert.match(sig.label, /labels this as AI-generated/);
});

test('YouTube altered-or-synthetic disclosure is read; "AI info" is only informational', () => {
  const yt = P.scanLabels('www.youtube.com', doc([node('div', { text: 'Altered or synthetic content' })]));
  assert.equal(yt[0].level, 'generated');
  const ig = P.scanLabels('www.instagram.com', doc([node('span', { text: 'AI info' })]));
  assert.equal(ig[0].level, 'info');
  assert.equal(P.toImageSignal(ig[0]).strength, 0);
});

test('long paragraphs that merely mention AI are not labels', () => {
  const long = node('div', { text: 'We made this with AI tools and a lot of help from our editorial team, which took several weeks.' });
  assert.deepEqual(P.scanLabels('www.instagram.com', doc([long])), []);
});

test('labels on a non-matching host are ignored', () => {
  assert.deepEqual(P.scanLabels('example.com', doc([node('span', { text: 'Made with AI' })])), []);
});

const DAY = 24 * 60 * 60 * 1000;

test('history folds page results into domain counters', () => {
  let rec = H.fold(null, { hostname: 'shop.test', overall: 'undisclosed-ai', images: { total: 4, counts: { 'ai-generated': 2 } }, aiSystems: [{ id: 'openai' }] }, 1000 * DAY);
  rec = H.fold(rec, { hostname: 'shop.test', overall: 'disclosed-ai', images: { total: 2, counts: { 'ai-disclosed': 1 } }, aiSystems: [{ id: 'openai' }, { id: null }] }, 1001 * DAY);
  rec = H.fold(rec, { hostname: 'shop.test', overall: 'none', images: { total: 1, counts: {} }, aiSystems: [] }, 1002 * DAY);
  assert.equal(rec.pages, 3);
  assert.equal(rec.aiPages, 2);
  assert.equal(rec.disclosedPages, 1);
  assert.equal(rec.aiImages, 3);
  assert.equal(rec.tools.openai, 2);
  assert.equal(rec.firstSeen, 1000 * DAY);
  assert.equal(rec.lastSeen, 1002 * DAY);
});

/*
 * The store is a list of the sites someone opened. Keeping the exact minute
 * of each visit makes it a reading log; the day is all the cap and the expiry
 * need. This is also the half of the finding the code disagreed with itself
 * about — lib/history.js said the store was off by default while
 * lib/settings.js switched it on — so the header now says what is true.
 */
test('visit times are recorded to the day, not the millisecond', () => {
  const noon = 1000 * DAY + 12 * 60 * 60 * 1000 + 34567;
  const rec = H.fold(null, { hostname: 'a.test', overall: 'none', images: {}, aiSystems: [] }, noon);
  assert.equal(rec.firstSeen, 1000 * DAY, 'rounded down to the start of the day');
  assert.equal(rec.lastSeen, 1000 * DAY);
  assert.equal(rec.lastSeen % DAY, 0, 'no time of day survives');
  const later = H.fold(rec, { hostname: 'a.test', overall: 'none', images: {}, aiSystems: [] }, noon + 60 * 1000);
  assert.equal(later.lastSeen, 1000 * DAY, 'a second visit the same day moves nothing');
});

test('records expire, so a domain seen once does not stay for ever', () => {
  const now = 1000 * DAY;
  const all = {
    fresh: { host: 'fresh', lastSeen: now - 3 * DAY },
    edge: { host: 'edge', lastSeen: now - 90 * DAY },
    stale: { host: 'stale', lastSeen: now - 91 * DAY },
    ancient: { host: 'ancient', lastSeen: 0 },
  };
  const kept = H.prune({ ...all }, 400, now);
  assert.deepEqual(Object.keys(kept).sort(), ['edge', 'fresh'], 'older than 90 days is dropped');
  // Without a clock the cap still works on its own: prune is used that way
  // by callers that only want the size bound.
  assert.deepEqual(Object.keys(H.prune({ ...all }, 400)).sort(), ['ancient', 'edge', 'fresh', 'stale']);
});

test('history summary needs more than one page and reads the pattern', () => {
  assert.equal(H.summarize(H.fold(null, { hostname: 'a', overall: 'none', images: {}, aiSystems: [] }, 1)), null);
  let rec = null;
  for (let i = 0; i < 4; i++) rec = H.fold(rec, { hostname: 'a', overall: 'undisclosed-ai', images: { total: 1, counts: { 'ai-generated': 1 } }, aiSystems: [] }, i);
  const s = H.summarize(rec);
  assert.equal(s.tone, 'high');
  assert.match(s.text, /AI markers on 4 of 4 pages/);
  assert.match(s.text, /none of them disclosed/);
});

test('history prunes to the most recently seen domains', () => {
  const all = {};
  for (let i = 0; i < 10; i++) all['d' + i] = { lastSeen: i };
  const kept = H.prune(all, 3);
  assert.deepEqual(Object.keys(kept).sort(), ['d7', 'd8', 'd9']);
});
