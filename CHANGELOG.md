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
- **Any page could make the extension fetch a private address.** The worker
  fetches image, video and audio URLs with `<all_urls>` host permissions, so
  its requests are subject to neither the page's CSP, nor its mixed-content
  blocking, nor Chrome's Private Network Access checks — and the only filter
  was a scheme test. An ordinary HTTPS page could name `http://127.0.0.1:…`,
  `http://192.168.1.1/` or `http://169.254.169.254/…` in an image attribute
  and have the extension reach it from the reader's IP and inside the reader's
  network. Fetches now follow the Private Network Access rule: a page may
  reach its own address space or a less private one, never a more private one,
  and a `file:` resource is read only for a page that is itself a local file.
  Where a redirect landed is checked against the same rule. A `<video poster>`
  also has to belong to a video the page actually displays, which it did not
  before: the poster path had no rendered-size floor at all.
- **The credentials cache could answer one image with another's provenance.**
  URLs longer than 2000 characters were keyed on their first 2000 characters
  plus their length, so two signed CDN URLs differing only in a trailing token
  of the same length shared one entry — and the second image was reported with
  the first one's format, metadata and verification result. The key is now a
  SHA-256 digest of the whole URL.
- **An assertion reference with no usable hash was skipped, not counted.** A
  claim whose references carry the digest as text (or omit it) left the
  assertion check at zero checked, which removed the whole assertion clause
  from the summary and let the manifest pass on its signature and binding
  alone, with the second of the three advertised checks silently not
  performed. Such a reference is now counted and reported, and a claim that
  names assertions none of which could be checked is caution, never a pass.
- **Message handlers took the caller's word for which tab to report on.**
  `srl:get-result` returned the full analysis of any tab id the caller named.
  A content script now gets the tab it is running in; only an extension page
  may name one, and the sender's extension id is checked.
- **The worker trusted the byte caps it was handed.** `maxImageBytes` and
  `maxMediaBytes` had a floor and no ceiling although the settings normaliser
  that clamps them was already imported; the incoming object now goes through
  it, and one message can no longer queue an unbounded number of fetches.
- **The publisher page was offered to every website.** `publisher/publisher.html`
  was declared web-accessible for `<all_urls>` although the popup opens it with
  `chrome.tabs.create`, which needs no such declaration — so any site could
  frame a privileged extension page with a tab id of its choosing, and its
  buttons with it. The declaration is gone, and the page refuses to run inside
  a frame.
- **Nothing tied a manifest to the file it arrived in.** Signature, assertion
  hashes and chain were all checked, but not the hard binding, so a genuine and
  fully verifying camera manifest could be lifted byte for byte out of a real
  photograph and embedded in a generated image: every check still passed and the
  reader was shown "signature verified" beside "original digital capture". The
  claim's `c2pa.hash.data` binding is now recomputed over the file's own bytes.
  A mismatch is a broken manifest; a claim with no hard binding at all is
  invalid rather than unverified; and a binding that could not be recomputed —
  a byte-capped fetch, a BMFF or box-hash form, exclusion ranges that reach
  outside the credential store — is reported as caution, never as a pass.
- **An unsigned manifest earned the same badge as a signed one.** A hand-written
  JUMBF box with no certificate and no signature, declaring `digitalCapture`,
  produced a hard "captured" verdict and the page-level provenance tick. Capture,
  human-origin and algorithmic-origin claims now count only from a manifest that
  verified and bound; unverified ones are shown as unverified assertions and
  change no verdict. Claims of AI generation are still read either way, being
  disclosures against interest.
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
- **The saved report said signatures were never verified.** Cryptographic
  verification shipped, but three user-facing strings did not follow it: the
  exported JSON report — the artefact the reader is told to keep as evidence,
  carrying a SHA-256 digest of its own findings — the PNG receipt's footer and
  the Overview tab's provenance hint all still said credentials were parsed
  and not verified, while the same popup showed a green "Signature verified"
  row. The sentence now lives once in `lib/verdicts.js`, says what is actually
  checked and what is not (the root is never anchored), and the exported
  report adds what the manifests on that particular page did.
- **Trader analysis could stall the page on VAT context words.** `findVat`
  compiled all twenty-nine country formats afresh for every VAT-context word
  it found, and the "stop after six numbers" guard never fires on a page that
  has the words and no number: a 300 KB body of "vat " repeated cost about
  400 ms of the page's own main thread, repeatable roughly once a second
  through the SPA-navigation poller. The formats are compiled once and the
  scan is bounded by hit count as well.
- **Domain memory was a timestamped visit log.** Records carried a
  millisecond `lastSeen` and never expired, so the store was a
  hostname-granularity reading log kept until 400 other domains displaced it.
  Times are now kept to the day and records expire after 90 days. The file's
  own header claimed the feature was off by default while the settings said
  otherwise; the header now matches the code.
- **One tag could silence the whole extension.** Three attacker-reachable
  inputs each threw out of `analyze()` before any result existed, so nothing
  was posted to the worker, the mutation observer and the SPA-navigation poller
  never started, and the popup reported "nothing analysed yet" for the rest of
  the page's life: a Replit fingerprint (by hostname *or* by the dev-banner
  script src, which any page can add) reached an undeclared variable in
  `attributeSite`; a malformed percent-escape in an image URL — `<img src="/%">`
  — threw `URIError` out of `analyzeImageHints`; and an unparseable
  `<video poster="http://[">` threw `TypeError` out of `new URL`. Each input is
  fixed, page-supplied URLs now resolve through a helper that answers null
  rather than throwing, and `analyze()` and the per-image loop are guarded so
  the next such defect cannot do it either. The failure is reported in the
  popup instead of being swallowed.
- **The tool accused ordinary pages.** An AI-disclosure meta tag holding any
  value other than a literal "false"/"no"/"none" was read as declaring AI
  content — including an empty one, and including `content="no AI was used"`.
  A JSON-LD author called Randall Cooper, Leonardo Rossi or Dallas Herald was
  read as an AI system, because the generator pattern matched those fragments
  unanchored. "Here is a summary of what our team achieved" scored the
  strongest AI verdict on its own. An EXIF description reading "Flight test
  parameters recorded at Cape Town" was attributed to Stable Diffusion with
  *confirmed* confidence.
- **Signals that could never fire.** A generator tag behind another one was
  never matched, so a site declaring "Next.js" before "v0 by Vercel" read as
  having no generator at all. `<html lang="DE">` dropped every German
  disclosure because the language was not lower-cased. Whole-page paragraph
  statistics were unreachable, since the text was flattened before the code
  that measures paragraphs ran. A phrase repeated across a page used up the
  disclosure budget before the patterns for a human-authorship claim were
  reached.
- **Curly apostrophes were invisible to the lexicon**, which is backwards:
  U+2019 is exactly what text pasted out of a chat window contains. Quotes are
  now normalised before matching.
- An unprofiled AI site builder was attributed to Lovable by name.
- Attribution confidence was chosen by sniffing rendered text for the word
  "comment" instead of reading which signal matched.
- Two tabs finishing at the same time could silently lose one domain's history
  counters; writes are now serialised.
- The floating pill could never be hidden: an author `display` beat the UA
  `[hidden]` rule, so its dismiss button, the "floating summary pill" setting
  and the Alt+Shift+A toggle all did nothing to it.
- Pausing a site only hid the result. The extension kept fetching image bytes,
  updating the toolbar badge and recording domain history for a site the
  reader had asked to be left alone; it now stops the work and clears the tab.
- Navigating a tab left the previous page's report attached to it, so the
  popup could describe the page you had just left.
- Switching to Quiet mood without reloading made every badge invisible,
  because the listener that reveals them was only attached at startup.
- The media byte budget was never sent to the worker, so the setting was inert.
- A single timed-out image fetch pinned that URL to "could not fetch" for the
  worker's lifetime, including on explicit right-click re-inspection.
- Right-clicking an image that was still being inspected left two badges on it.
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
