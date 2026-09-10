const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../lib/legitimacy.js');

const shop = {
  url: 'https://shop.example/product',
  hostname: 'shop.example',
  bodyText: 'Acme GmbH, Musterstraße 12, 10115 Berlin. Telefon: +49 30 1234567. E-Mail: hallo@acme.de. USt-IdNr.: DE 123 456 789. HRB 12345 B. Add to cart. Checkout. Preis €49,99',
  links: [
    { text: 'Impressum', href: '/impressum' }, { text: 'Datenschutz', href: '/datenschutz' },
    { text: 'AGB', href: '/agb' }, { text: 'Widerrufsrecht', href: '/widerruf' }, { text: 'Kontakt', href: '/kontakt' },
  ],
};

function status(r, id) { return r.checks.find((c) => c.id === id).status; }

test('a complete German shop page passes every critical check', () => {
  const r = L.analyzeLegitimacy(shop);
  assert.equal(r.commerce, true);
  assert.deepEqual(r.missingCritical, []);
  for (const id of ['imprint', 'terms', 'privacy', 'returns', 'contact', 'vat', 'registration', 'address', 'phone', 'email', 'https']) {
    assert.equal(status(r, id), 'present', id);
  }
  assert.equal(r.identifiers.vat[0].value, 'DE123456789');
  assert.equal(r.identifiers.registration[0].id, 'de-hr');
});

test('a bare shop page reports what is missing without inventing a score', () => {
  const r = L.analyzeLegitimacy({ url: 'http://sketchy.test/', hostname: 'sketchy.test', bodyText: 'Only 2 left in stock! 90% off. All sales are final. Add to cart. Checkout €19', links: [] });
  assert.deepEqual(r.missingCritical.sort(), ['contact', 'imprint', 'privacy', 'returns', 'terms']);
  assert.equal(status(r, 'https'), 'concern');
  assert.deepEqual(r.pressure.map((p) => p.id).sort(), ['discount', 'no-returns', 'scarcity']);
  assert.equal(r.checks.some((c) => 'score' in c), false);
});

test('a non-commercial page is held to the lighter set of checks', () => {
  const r = L.analyzeLegitimacy({ url: 'https://blog.example/post', hostname: 'blog.example', bodyText: 'A post about birds.', links: [{ text: 'Privacy policy', href: '/privacy' }, { text: 'Contact', href: '/contact' }, { text: 'Legal notice', href: '/legal' }] });
  assert.equal(r.commerce, false);
  assert.deepEqual(r.missingCritical, []);
});

test('an unlinked mention is weaker evidence than a link', () => {
  const r = L.analyzeLegitimacy({ url: 'https://a.test/', hostname: 'a.test', bodyText: 'See our privacy policy for details.', links: [] });
  assert.equal(status(r, 'privacy'), 'weak');
});

test('VAT identifiers are read across formats and separators', () => {
  const cases = [
    ['USt-IdNr.: DE 123 456 789', 'DE', 'DE123456789'],
    ['VAT: NL123456789B01', 'NL', 'NL123456789B01'],
    ['Partita IVA IT12345678901', 'IT', 'IT12345678901'],
    ['BTW-nummer: NL 8232.65.155.B01', 'NL', 'NL823265155B01'],
    ['Numéro de TVA : FR12345678901', 'FR', 'FR12345678901'],
    ['VAT no. GB123456789', 'GB', 'GB123456789'],
  ];
  for (const [text, country, value] of cases) {
    const got = L.findVat(text);
    assert.equal(got.length, 1, text);
    assert.equal(got[0].country, country, text);
    assert.equal(got[0].value, value, text);
  }
});

test('digits without VAT context are not read as a VAT number', () => {
  assert.deepEqual(L.findVat('Order DE123456789 shipped'), []);
  assert.deepEqual(L.findVat('Call us on 123 456 789'), []);
});

test('company register numbers are read per jurisdiction', () => {
  assert.equal(L.findRegistrations('Registered in England and Wales No. 09876543')[0].id, 'uk-company');
  assert.equal(L.findRegistrations('KvK nummer: 34567890')[0].id, 'nl-kvk');
  assert.equal(L.findRegistrations('SIREN : 123 456 789')[0].id, 'fr-siren');
  assert.deepEqual(L.findRegistrations('Just some prose.'), []);
});

test('German compound street names are recognised as an address', () => {
  const r = L.analyzeLegitimacy({ url: 'https://a.test/', hostname: 'a.test', bodyText: 'Hauptstraße 4, 20095 Hamburg', links: [] });
  assert.equal(status(r, 'address'), 'present');
});

test('marketplace trader identification is detected', () => {
  const r = L.analyzeLegitimacy({ url: 'https://m.test/i', hostname: 'm.test', bodyText: 'x', links: [{ text: 'Seller information', href: '/seller' }] });
  assert.equal(status(r, 'trader'), 'present');
});

/* The publisher page is UI, but the duty labelling it depends on is a
 * factual claim about the law, so it is pinned here. */
test('trader checks expose the ids the publisher self-check labels', () => {
  const r = L.analyzeLegitimacy({ url: 'https://a.test/', hostname: 'a.test', bodyText: '', links: [] });
  for (const id of ['imprint', 'privacy', 'contact', 'terms', 'returns']) {
    assert.ok(r.checks.some((c) => c.id === id), id + ' must exist for the self-check to label it');
  }
  assert.ok('vat' in r.identifiers && 'registration' in r.identifiers);
});

test('addresses are recognised across European conventions', () => {
  const should = [
    'Hauptstraße 4, 20095 Hamburg', 'Musterstrasse 12, 10115 Berlin', 'Bahnhofsweg 12, 8000 Zürich',
    'Marktplatz 3, 50667 Köln', '12 Baker Street, London NW1 6XE', 'Rue de la Paix 5, 75002 Paris',
    'Calle Mayor 1, 28013 Madrid', 'Via Roma 2, 00184 Roma', 'Keizersgracht 10, 1015 CJ Amsterdam',
    '1600 Pennsylvania Ave, Washington 20500', 'Drottninggatan 5, 111 51 Stockholm',
  ];
  for (const t of should) {
    const r = L.analyzeLegitimacy({ url: 'https://a/', hostname: 'a', bodyText: t, links: [] });
    assert.equal(status(r, 'address'), 'present', t);
  }
  for (const t of ['Just some prose about nothing', 'Order 12345 shipped today', 'We drove 300 km yesterday']) {
    const r = L.analyzeLegitimacy({ url: 'https://a/', hostname: 'a', bodyText: t, links: [] });
    assert.equal(status(r, 'address'), 'missing', t);
  }
});

/* A trailing \b can never hold after a literal dot, which silently made every
 * abbreviated street form unreachable. */
test('abbreviated street forms are matched, in both word and compound shapes', () => {
  for (const t of ['Musterstr. 12, 10115 Berlin', 'Bahnhofstr. 3, 80331 München', '742 Elm St., Springfield 62704', '100 Main Blvd., Austin 78701']) {
    const r = L.analyzeLegitimacy({ url: 'https://a/', hostname: 'a', bodyText: t, links: [] });
    assert.equal(status(r, 'address'), 'present', t);
  }
});

/* Allowing a bare "Ave"/"Rd"/"Blvd" would turn ordinary prose near any
 * five-digit number into a reported address, which overstates how findable
 * the trader is. The dot or an immediately following comma is required. */
test('prose that merely contains a street word is not reported as an address', () => {
  for (const t of [
    'Ave Maria, gratia plena. 12345 copies sold. Ordered 5 items',
    'Version 1.2.3 released to 40000 users named Bob',
    'See fig. 4 and table 12345 in Chapter Nine',
  ]) {
    const r = L.analyzeLegitimacy({ url: 'https://a/', hostname: 'a', bodyText: t, links: [] });
    assert.equal(status(r, 'address'), 'missing', t);
  }
});

test('e-mail detection covers internationalised domains without false positives', () => {
  for (const t of ['info@example.com', 'first.last+tag@sub.domain.co.uk', 'hello@müller.de', 'büro@österreich.at']) {
    const r = L.analyzeLegitimacy({ url: 'https://a/', hostname: 'a', bodyText: 'Write to ' + t + ' today', links: [] });
    assert.equal(status(r, 'email'), 'present', t);
    assert.equal(r.checks.find((c) => c.id === 'email').detail, t);
  }
  for (const t of ['price @ 5 euros', 'follow @handle on social', 'no address here']) {
    const r = L.analyzeLegitimacy({ url: 'https://a/', hostname: 'a', bodyText: t, links: [] });
    assert.equal(status(r, 'email'), 'missing', t);
  }
});

/*
 * BUG-4. findVat compiled all 29 country formats with `new RegExp` inside the
 * per-hit loop, and the `out.length < 6` guard only stops the loop once six
 * numbers have been found — never on a page that has context words and no
 * number. A 300 KB body of "vat " repeated therefore spent about 400 ms of
 * the page's own main thread here, repeatable once a second through the SPA
 * href poll. The patterns are compiled once now and the scan is bounded by
 * hit count as well as by findings.
 */
test('the VAT patterns are compiled once, not per context word', () => {
  assert.equal(L.VAT_PATTERNS.length, Object.keys(L.VAT_FORMATS).length, 'one compiled pattern per format');
  assert.ok(Object.isFrozen(L.VAT_PATTERNS), 'and shared, so nothing may edit them');
  for (const p of L.VAT_PATTERNS) {
    assert.ok(p.re instanceof RegExp);
    assert.equal(p.re.global, false, 'a shared regex must not carry lastIndex between calls');
    assert.ok(!p.re.source.includes('-?'), 'separators are stripped once, to match the stripped window');
  }
  // Reused across calls: a stateful regex would make the second call differ.
  const once = L.findVat('VAT: GB123456789');
  assert.deepEqual(L.findVat('VAT: GB123456789'), once);
});

test('a page of nothing but VAT context words does not scale with how many there are', () => {
  const cap = L.MAX_VAT_CONTEXT_HITS;
  // Both bodies have at least the cap of context hits, so both do the same
  // bounded amount of work. The bound comes from the cap, not from a
  // measured time on this machine, so it holds wherever the suite runs.
  const atCap = 'vat '.repeat(cap);
  const wellPast = 'vat '.repeat(cap * 20);
  // The fastest of several runs: a single sub-millisecond measurement picks
  // up whatever else the machine is doing, and it is the denominator here.
  const time = (body) => {
    let best = Infinity;
    for (let i = 0; i < 7; i++) {
      const t0 = process.hrtime.bigint();
      L.findVat(body);
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms < best) best = ms;
    }
    return best;
  };
  time(atCap); time(wellPast);   // warm up
  const a = Math.max(time(atCap), 0.1);
  const b = time(wellPast);
  assert.ok(b / a < 6, 'twenty times the context words took ' + (b / a).toFixed(1) + 'x the time (' + a.toFixed(1) + 'ms → ' + b.toFixed(1) + 'ms)');
});

test('bounding the scan does not lose the numbers that are actually there', () => {
  assert.deepEqual(L.findVat('USt-IdNr.: DE 123 456 789'), [{ country: 'DE', value: 'DE123456789' }]);
  assert.deepEqual(L.findVat('NIP: PL 123-456-78-90'), [{ country: 'PL', value: 'PL1234567890' }]);
  // One 60-character window can hold two numbers; the first format that
  // matches wins, which is the order VAT_FORMATS is written in.
  assert.deepEqual(L.findVat('VAT GB123456789').map((v) => v.country), ['GB']);
  assert.deepEqual(L.findVat('BTW-nummer NL123456789B01').map((v) => v.country), ['NL']);
  // A number after a wall of empty context words is beyond the bound, and
  // that is the deliberate trade: the page still gets analysed either way.
  const found = L.findVat('vat '.repeat(4) + 'USt-IdNr.: DE123456789');
  assert.deepEqual(found, [{ country: 'DE', value: 'DE123456789' }]);
});
