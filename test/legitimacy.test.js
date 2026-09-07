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
