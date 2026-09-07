/*
 * lib/legitimacy.js — who is behind this site, and can they be identified?
 *
 * AI markers say how content was made. They do not say whether the operator
 * is real. EU law already requires a trader to identify itself: the
 * e-Commerce Directive (2000/31/EC Art. 5) and the national imprint rules
 * built on it, the Consumer Rights Directive for distance selling, and the
 * Digital Services Act (Art. 31) for traders on marketplaces. A page that
 * cannot say who runs it is worth a second look before money changes hands.
 *
 * This module only reads the page it is given. It performs no lookups, so a
 * VAT number is checked for format, never for existence. Every finding is a
 * fact about the page, never a judgement about the business.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.SRL = root.SRL || {};
  root.SRL.legitimacy = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Imprint / legal-notice links across the languages an EU reader meets. */
  const IMPRINT_RE = /\b(?:impressum|imprint|legal\s*notice|legal\s*information|mentions?\s*l[ée]gales?|aviso\s*legal|informazioni\s*legali|note\s*legali|colofon|juridische\s*informatie|wettelijke\s*informatie|prawne|informa[çc][õo]es\s*legais|oikeudelliset|juridisk|selskabsoplysninger|impres+um)\b/i;
  const TERMS_RE = /\b(?:terms(?:\s*(?:&|and)\s*conditions|\s*of\s*(?:service|use|sale))?|conditions?\s*g[ée]n[ée]rales|allgemeine\s*gesch[äa]ftsbedingungen|\bagb\b|algemene\s*voorwaarden|t[ée]rminos|condizioni\s*generali|regulamin|villkor|k[äa]ytt[öo]ehdot)\b/i;
  const PRIVACY_RE = /\b(?:privacy(?:\s*(?:policy|notice|statement))?|datenschutz\w*|politique\s*de\s*confidentialit[ée]|privacybeleid|pol[íi]tica\s*de\s*privacidad|informativa\s*(?:sulla\s*)?privacy|prywatno[śs]ci|integritetspolicy|tietosuoja\w*)\b/i;
  const RETURNS_RE = /\b(?:returns?(?:\s*(?:policy|and\s*refunds?))?|refunds?\s*policy|right\s*of\s*withdrawal|widerruf\w*|r[üu]ckgabe\w*|droit\s*de\s*r[ée]tractation|herroepingsrecht|desistimiento|recesso|zwrot\w*|[åa]ngerr[äa]tt)\b/i;
  const CONTACT_RE = /\b(?:contact(?:\s*us)?|kontakt\w*|contacto|contatti|contactez|neem\s*contact|yhteystiedot)\b/i;
  const ABOUT_RE = /\b(?:about(?:\s*us)?|[üu]ber\s*uns|wir\s*[üu]ber\s*uns|[àa]\s*propos|qui\s*sommes|sobre\s*nosotros|chi\s*siamo|over\s*ons|om\s*oss|meist[äa])\b/i;
  const DSA_TRADER_RE = /\b(?:trader\s*(?:information|details)|seller\s*information|informations?\s*sur\s*le\s*(?:vendeur|professionnel)|h[äa]ndlerinformation\w*|verk[äa]uferinformation\w*|informaci[óo]n\s*del\s*(?:vendedor|comerciante)|informazioni\s*sul\s*venditore|sold\s*by)\b/i;

  /* EU (plus UK and CH) VAT identifier formats. Format only: a well-formed
   * number can still belong to nobody, and checking that needs a lookup. */
  const VAT_FORMATS = {
    AT: /ATU\d{8}/, BE: /BE0?\d{9}/, BG: /BG\d{9,10}/, CY: /CY\d{8}[A-Z]/, CZ: /CZ\d{8,10}/,
    DE: /DE\d{9}/, DK: /DK\d{8}/, EE: /EE\d{9}/, EL: /EL\d{9}/, ES: /ES[A-Z0-9]\d{7}[A-Z0-9]/,
    FI: /FI\d{8}/, FR: /FR[A-Z0-9]{2}\d{9}/, HR: /HR\d{11}/, HU: /HU\d{8}/, IE: /IE\d{7}[A-Z]{1,2}/,
    IT: /IT\d{11}/, LT: /LT(?:\d{12}|\d{9})/, LU: /LU\d{8}/, LV: /LV\d{11}/, MT: /MT\d{8}/,
    NL: /NL\d{9}B\d{2}/, PL: /PL\d{10}/, PT: /PT\d{9}/, RO: /RO\d{2,10}/, SE: /SE\d{12}/,
    SI: /SI\d{8}/, SK: /SK\d{10}/, GB: /GB\d{9}(?:\d{3})?/, CHE: /CHE-?\d{3}\.?\d{3}\.?\d{3}/,
  };
  /* Trailing \b is deliberately absent on the abbreviations: German writes
   * "USt-IdNr.", Dutch "BTW-nummer", so a boundary after "id" would miss them. */
  const VAT_CONTEXT_RE = /\b(?:vat\b|ust[.\-\s]?id|umsatzsteuer|mwst|tva\b|btw\b|btw[-\s]?nummer|p(?:artita)?\.?\s?iva\b|nip\b|moms\b|alv\b|cvr\b|n[úu]mero\s*de\s*iva|tax\s*id)/i;

  /* National company-register identifiers. */
  const REGISTRATION_PATTERNS = [
    { id: 'uk-company', label: 'UK company number', re: /\b(?:company\s*(?:no\.?|number|reg(?:istration)?\s*(?:no\.?|number)?)|registered\s+in\s+england(?:\s+and\s+wales)?(?:\s+(?:no\.?|number))?)\s*:?\s*((?:SC|NI|OC|SO|NC)?\d{6,8})\b/i },
    { id: 'de-hr', label: 'German commercial register', re: /\b(HR[AB]\s*\d{1,6}(?:\s*[A-Z]{1,3})?)\b/ },
    { id: 'nl-kvk', label: 'Dutch Chamber of Commerce number', re: /\b(?:kvk|handelsregister)\s*(?:nummer|nr\.?|no\.?)?\s*:?\s*(\d{8})\b/i },
    { id: 'fr-siren', label: 'French SIREN / SIRET', re: /\b(?:siren|siret|rcs)\s*:?\s*((?:\d[\s.]?){9,14})\b/i },
    { id: 'it-rea', label: 'Italian REA number', re: /\b(?:rea)\s*:?\s*([A-Z]{2}[\s-]?\d{5,7})\b/i },
    { id: 'es-cif', label: 'Spanish CIF / NIF', re: /\b(?:cif|nif)\s*:?\s*([A-Z]\d{7}[A-Z0-9])\b/i },
    { id: 'lei', label: 'Legal Entity Identifier', re: /\b(?:lei)\s*:?\s*([A-Z0-9]{18}\d{2})\b/i },
    { id: 'us-ein', label: 'US employer identification number', re: /\b(?:ein)\s*:?\s*(\d{2}-\d{7})\b/i },
  ];

  /* Contact and address shapes. Placeholder forms are excluded by
   * lib/signals.js PLACEHOLDER_PATTERNS, which the site analyser reports. */
  const PHONE_RE = /(?:\+\d{1,3}[\s.\-()]?){0,1}(?:\(?\d{2,5}\)?[\s.\-]?){2,4}\d{2,4}/;
  /* Every quantifier bounded: unbounded `[\w.+-]+` before an `@` walks the
   * whole remaining string from every word boundary, which is quadratic on
   * text like "a.a.a.a…". RFC 5321 caps the local part at 64 and each label
   * at 63 anyway. Unicode-aware so internationalised domains (müller.de) are
   * seen, and the lookbehind means a run of "a.a.a." offers one start, not
   * one per character. */
  const EMAIL_RE = /(?<![\p{L}\p{N}._+-])[\p{L}\p{N}._+-]{1,64}@(?:[\p{L}\p{N}-]{1,63}\.){1,5}\p{L}{2,12}(?![\p{L}\p{N}-])/iu;
  /* Unicode-aware: `\w` is ASCII only, so it fails on Zürich, Köln, Genève. */
  const POSTAL_RE = /\b(?:\d{4,5}\s+\p{Lu}[\p{L}'’-]{1,40}|\d{3}\s\d{2}\s+\p{Lu}[\p{L}'’-]{1,40}|\p{Lu}{1,2}\d{1,2}\p{Lu}?\s*\d\p{Lu}{2}|\d{5}(?:-\d{4})?)\b/u;
  /* German street names are compounds ("Musterstrasse"), so the common
   * suffixes must match without a leading word boundary.
   *
   * The compound prefix is anchored at a word boundary and bounded to 30
   * characters. Both matter: unanchored and unbounded, `[a-zäöüß]{3,}` walks
   * back one character at a time from every position in the text, which turns
   * a long run of letters — a base64 blob rendered as text, say — into
   * quadratic work and freezes the tab. No real street name is longer. */
  const STREET_RE = new RegExp([
    // Compounds: "Hauptstrasse", "Bahnhofsweg", "Keizersgracht", "Storgatan".
    '(?:stra(?:ss|ß)e|\\b[a-zäöüß]{3,30}(?:weg|platz|allee|gasse|ring|gracht|kade|dijk|singel|gatan|gata|vagen|vägen))\\b',
    // Whole words.
    '\\b(?:street|road|avenue|lane|drive|boulevard|rue|voie|calle|avenida|via|viale|piazza|straat|laan|plein|vej|ulica|utca|ulice)\\b',
    // Abbreviations. A trailing \\b can never hold after a literal dot, so
    // these need their own branch; requiring the dot or an immediately
    // following comma is what separates "Pennsylvania Ave," from "Ave Maria".
    '\\b(?:st|rd|ave|blvd)[.,]',
    // German abbreviates as a compound too: "Musterstr. 12".
    '\\b[a-zäöüß]{0,30}str\\.',
  ].join('|'), 'i');

  /* Pressure and urgency patterns. Under the Unfair Commercial Practices
   * Directive, false urgency and fake scarcity are prohibited; a real
   * countdown is legitimate, so these are flagged as worth checking. */
  const PRESSURE_PATTERNS = [
    { id: 'countdown', label: 'Countdown timer', re: /\b(?:offer|sale|deal|discount|price)\s*(?:ends|expires)\s*in\b|\b\d{1,2}\s*:\s*\d{2}\s*:\s*\d{2}\b(?=[\s\S]{0,80}(?:left|remaining|ends|hurry))/i, note: 'A timer that resets on reload is a prohibited unfair practice; check by reloading.' },
    { id: 'scarcity', label: 'Scarcity claim', re: /\bonly\s+\d{1,2}\s+(?:left|remaining|in\s+stock)\b|\b\d{1,3}\s+(?:people|others)\s+are\s+(?:viewing|watching|looking)\b|\blast\s+\d{1,2}\s+items?\b/i, note: 'Invented stock counts and viewer counts are a prohibited unfair practice.' },
    { id: 'discount', label: 'Very large discount claim', re: /\b(?:-\s*)?(?:[89]\d|9\d)\s*%\s*(?:off|discount|rabatt|de\s*(?:remise|descuento))\b/i, note: 'Discounts must be measured against the lowest price of the previous 30 days (Omnibus Directive).' },
    { id: 'no-returns', label: 'Claims no returns are accepted', re: /\b(?:no\s+returns?|all\s+sales\s+(?:are\s+)?final|non[- ]refundable)\b/i, note: 'EU distance selling normally carries a 14-day right of withdrawal; blanket refusal is usually unlawful.' },
  ];

  const CHECK_LABELS = {
    imprint: 'Imprint / legal notice',
    terms: 'Terms and conditions',
    privacy: 'Privacy policy',
    returns: 'Returns or withdrawal policy',
    contact: 'Contact page or details',
    about: 'About page',
    vat: 'VAT identification number',
    registration: 'Company register number',
    address: 'Postal address',
    phone: 'Telephone number',
    email: 'E-mail address',
    trader: 'Marketplace trader identification',
    https: 'Served over HTTPS',
  };

  /*
   * snapshot: { url, hostname, bodyText, links: [{ rel, href, text }],
   *             isCommercial? }
   * Returns { checks, identifiers, pressure, commerce, missingCritical }.
   */
  function analyzeLegitimacy(snap) {
    const text = String(snap.bodyText || '');
    const flat = text.replace(/\s+/g, ' ');
    const links = (snap.links || []).map((l) => ({ text: String(l.text || ''), href: String(l.href || '') }));
    const linkBlob = links.map((l) => l.text + ' ' + l.href).join(' | ');
    const checks = {};

    const linkOrText = (re) => {
      const link = links.find((l) => re.test(l.text) || re.test(decodeURIComponentSafe(l.href)));
      if (link) return { status: 'present', detail: (link.text || link.href).slice(0, 120), via: 'link' };
      if (re.test(flat)) return { status: 'weak', detail: 'Mentioned in the page text but not linked', via: 'text' };
      return { status: 'missing', detail: '' };
    };

    checks.imprint = linkOrText(IMPRINT_RE);
    checks.terms = linkOrText(TERMS_RE);
    checks.privacy = linkOrText(PRIVACY_RE);
    checks.returns = linkOrText(RETURNS_RE);
    checks.contact = linkOrText(CONTACT_RE);
    checks.about = linkOrText(ABOUT_RE);
    checks.trader = linkOrText(DSA_TRADER_RE);

    const identifiers = { vat: findVat(flat), registration: findRegistrations(flat) };
    checks.vat = identifiers.vat.length
      ? { status: 'present', detail: identifiers.vat.map((v) => v.value + ' (' + v.country + ', format only)').join(', ') }
      : { status: 'missing', detail: '' };
    checks.registration = identifiers.registration.length
      ? { status: 'present', detail: identifiers.registration.map((r) => r.label + ' ' + r.value).join(', ') }
      : { status: 'missing', detail: '' };

    const email = EMAIL_RE.exec(flat);
    checks.email = email ? { status: 'present', detail: email[0] } : { status: 'missing', detail: '' };
    const tel = links.find((l) => /^tel:/i.test(l.href));
    const phone = tel ? tel.href.replace(/^tel:/i, '') : phoneInText(flat);
    checks.phone = phone ? { status: 'present', detail: phone } : { status: 'missing', detail: '' };
    const addr = addressIn(flat);
    checks.address = addr ? { status: 'present', detail: addr } : { status: 'missing', detail: '' };

    checks.https = /^https:/i.test(snap.url || '')
      ? { status: 'present', detail: '' }
      : { status: 'concern', detail: 'This page was not served over HTTPS. Do not enter payment or personal details.' };

    const pressure = [];
    for (const p of PRESSURE_PATTERNS) {
      const m = p.re.exec(flat);
      if (m) pressure.push({ id: p.id, label: p.label, detail: excerpt(flat, m.index, m[0].length), note: p.note });
    }

    const commerce = detectCommerce(flat, linkBlob);
    const critical = commerce ? ['imprint', 'terms', 'privacy', 'returns', 'contact'] : ['imprint', 'privacy', 'contact'];
    const missingCritical = critical.filter((k) => checks[k].status === 'missing');

    return {
      checks: Object.entries(checks).map(([id, c]) => ({ id, label: CHECK_LABELS[id], ...c })),
      identifiers,
      pressure,
      commerce,
      missingCritical,
      note: 'Read from this page only. No lookups were made, so identifiers are checked for format, not existence.',
    };
  }

  function decodeURIComponentSafe(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  /* Looks only in a short window after a VAT-context word, with separators
   * removed, so "USt-IdNr.: DE 123 456 789" is found without turning the
   * whole page into one long digit string that invents matches. */
  function findVat(text) {
    const ctx = new RegExp(VAT_CONTEXT_RE.source, 'gi');
    const out = [];
    const seen = new Set();
    let m;
    while ((m = ctx.exec(text)) && out.length < 6) {
      const window = text.slice(m.index, m.index + 60).replace(/[\s.\u2013\u2014-]/g, '').toUpperCase();
      for (const [country, re] of Object.entries(VAT_FORMATS)) {
        const hit = new RegExp(re.source.replace(/-\?/g, '')).exec(window);
        if (!hit || seen.has(hit[0])) continue;
        seen.add(hit[0]);
        out.push({ country, value: hit[0] });
        break;
      }
    }
    return out;
  }

  function findRegistrations(text) {
    const out = [];
    for (const p of REGISTRATION_PATTERNS) {
      const m = p.re.exec(text);
      if (m) out.push({ id: p.id, label: p.label, value: m[1].trim() });
      if (out.length >= 5) break;
    }
    return out;
  }

  function phoneInText(text) {
    const near = /(?:tel(?:efon|ephone)?|phone|call|fon|t[ée]l|tlf)\.?\s*:?\s*([+\d][\d\s.\-()]{6,20}\d)/i.exec(text);
    if (near) return near[1].trim();
    const intl = /\+\d{1,3}[\s.\-]?(?:\(?\d{1,5}\)?[\s.\-]?){2,4}\d{2,4}/.exec(text);
    return intl ? intl[0].trim() : null;
  }

  function addressIn(text) {
    const g = new RegExp(STREET_RE.source, 'gi');
    let m;
    while ((m = g.exec(text))) {
      const around = text.slice(Math.max(0, m.index - 60), Math.min(text.length, m.index + 90));
      if (POSTAL_RE.test(around) && /\d/.test(around)) return around.trim().slice(0, 140);
    }
    return null;
  }

  function detectCommerce(text, links) {
    const blob = text + ' ' + links;
    const hits = [
      /\badd\s+to\s+(?:cart|basket|bag)\b/i, /\bcheckout\b/i, /\bshopping\s*(?:cart|basket)\b/i,
      /\bbuy\s+now\b/i, /\bwarenkorb\b/i, /\bpanier\b/i, /\bwinkelwagen\b/i, /\bcarrito\b/i,
      /\bsubscribe\s+for\s+[€$£]/i, /[€$£]\s?\d+(?:[.,]\d{2})?\b/,
    ].filter((re) => re.test(blob)).length;
    return hits >= 2;
  }

  function excerpt(text, index, len) {
    return text.slice(Math.max(0, index - 50), Math.min(text.length, index + len + 50)).trim().slice(0, 160);
  }

  return { analyzeLegitimacy, VAT_FORMATS, REGISTRATION_PATTERNS, PRESSURE_PATTERNS, CHECK_LABELS, findVat, findRegistrations };
});
