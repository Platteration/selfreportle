# Changelog

All notable changes to Selfreportle. Dates are the day the work landed on the
development branch.

## Unreleased

### Added
- **Cryptographic verification of Content Credentials.** COSE_Sign1 signatures
  are verified with WebCrypto against the embedded leaf certificate
  (ES256/384/512, PS256/384/512, RS256/384/512, Ed25519), every assertion is
  re-hashed against the signed claim, and the certificate chain is checked for
  internal consistency and validity dates. No trust list ships, so the root is
  never anchored and the interface says so.
- **Video and audio.** The ISOBMFF reader walks the box tree, covering MP4,
  M4A, MOV, AVIF and HEIC, and makes a suffix range request for files whose
  index sits at the end. Poster frames are inspected separately.
- **Trader tab.** Imprint, terms, privacy, returns, contact, marketplace trader
  identification, VAT and company-register identifiers across jurisdictions,
  address, phone, e-mail and HTTPS, plus pressure patterns with the EU rule
  that restricts each. No trader score.
- **Platform labels.** The markers Instagram, Facebook, Threads, TikTok,
  YouTube, LinkedIn, Pinterest and X apply after stripping embedded metadata.
- **Domain memory.** Per-domain counters kept on this device only, capped,
  clearable and switchable off.
- **Attribution and skews.** Which AI system the evidence points to, with
  confidence, and that vendor's publicly documented tendencies.
- **Seven more languages.** Disclosure phrasing and LLM-typical wording for
  German, French, Spanish, Dutch, Italian, Portuguese and Polish, with language
  detection that declines to guess on short or ambiguous text.
- **Publisher self-check.** The same analysis pointed at your own site, with an
  Article 50 readiness checklist that labels legal duty separately from good
  practice, and paste-ready markup.
- **Tabbed popup** with a sticky verdict header, per-tab counts, full keyboard
  navigation, and export as JSON, as a file carrying a SHA-256 digest of its
  own findings, or as a shareable PNG receipt.
- **Display moods** (Quiet, Reader, Forensic), a dark theme for the in-page
  panel, per-state toolbar icons, and a colour-blind-safe palette where every
  verdict also carries its own glyph.
- **On-demand inspection** from the context menu for a single image or a text
  selection, a hidden-character reveal that names each invisible code point,
  reverse-image-lookup links the reader chooses to follow, a per-site pause
  button, and a keyboard shortcut for the badges.

### Changed
- "Created with the help of AI" no longer counts as full generation: an
  overlapping generation match is suppressed in favour of the assistance
  clause. Separate clauses still both count.
- Images carrying a platform label are reported even when they show no other
  signal, so an informational marker is visible without inflating the verdict.

### Security
- **A genuine signature could be replayed over a forged claim.** The COSE
  payload was verified as the signed body while the claim and assertions
  reported to the reader came from a separate box, so an attacker's claim
  displayed as verified under an honest signer's name. The signature must now
  cover the claim being reported.
- **A broken manifest kept speaking.** The finding that credentials do not
  verify was dropped before it reached the verdict, so a tampered manifest
  could still yield a green camera-provenance result. Broken credentials now
  outrank every claim inside the manifest, and those claims are suppressed.
- **Unreferenced assertions were trusted.** Actions were read from every
  assertion box, including ones the signed claim never named and which anyone
  can add without disturbing a signature.
- **Assertions deleted after signing were passed over**, leaving "signature
  verified" on a manifest whose evidence was gone.
- A byte-capped fetch that clipped an assertion was reported as tampering;
  it is now reported as incomplete evidence.
- One unparsable certificate anywhere in the chain stopped the leaf signature
  being checked at all.
- Certificate dates that could not be parsed were treated as valid, and a
  seconds-less GeneralizedTime was misread by about eighteen months.
- The "box content" assertion hashing convention could never match, because
  the hashed range wrongly included the inner box header.

### Fixed
- **Three quadratic regexes that any page could have used to freeze a tab**,
  found by fuzzing: the German compound-street prefix, the e-mail local part
  and the three-item-list detector all had unbounded, unanchored quantifiers.
  All quantifiers are now bounded and anchored, and `test/redos.test.js`
  guards every pattern in `lib/` against the whole class.
- Abbreviated street forms ("Musterstr. 12", "742 Elm St.") never matched: a
  trailing word boundary cannot hold after a literal dot, so those branches
  were unreachable. Bare "Ave"/"Rd"/"Blvd" now require a dot or a following
  comma, so ordinary prose near a five-digit number is no longer reported as
  an address.
- Addresses were missed where they are commonest: "Musterstrasse" written with
  a double s, non-ASCII city names such as Zürich and Köln, Dutch canal-street
  compounds, Nordic street suffixes and the Swedish postcode format.
- E-mail detection now sees internationalised domains (müller.de).

### Notes
- Nothing in this changelog has shipped to a store. The extension is loaded
  unpacked.
