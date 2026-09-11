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
- **A self-signed certificate earned the green "camera capture" badge.** Every
  question the verifier asked — signature, assertion hashes, chain
  consistency, hard binding — was answered yes by a certificate minted in five
  seconds with "Leica Camera AG" typed into its subject, because nothing
  checked the root against anything. An exculpatory claim now needs three
  things, not one: a manifest that verified and bound, a chain reaching a
  certificate this build knows (`TRUST_ANCHORS` in `lib/c2pa-verify.js`, empty
  here, filled by `setTrustAnchors`), and bytes the page itself loaded. Until
  a trust list ships, a capture or human-origin claim is shown as the
  unverified assertion it is and produces no camera badge, no page-level
  provenance tick and no green toolbar ✓; the popup says "signed by an
  unvouched signer" rather than "verified". The page-level tick also stopped
  resting on the `captured` count, which camera EXIF and an XMP
  `DigitalSourceType` attribute — fields anyone can type — also produce.
- **A forgeable text attribute earned the same green badge as a signed
  manifest.** Closing the C2PA path above raised the price of a camera badge to
  an anchored, bound, page-loaded manifest — and left a shorter path open at
  the old price: an `Iptc4xmpExt:DigitalSourceType` of `digitalCapture` is one
  line of XML, and camera EXIF is a `Make` string, and either produced the
  green "Camera-capture provenance" badge on its own. (`captured` and
  `algorithmic` also needed no *hard* signal to win, which `human-created`
  already did, so even a soft EXIF reading reached it.) An exculpatory verdict
  now requires a hard signal, which only a manifest meeting all four conditions
  produces; everything else lands in a new neutral tier, "Origin claimed by the
  file, not verified" — slate, ranked no higher than no evidence at all, and
  worded as the file's own claim. It is a tier rather than silence on purpose:
  the claim is real evidence, and an unverified Content Credentials claim used
  to disappear from the report altogether, which is the wrong half of the
  problem to fix. The page-level tick lost its last free route too: a sentence
  declaring human authorship is a disclosure, not a credential.
- **What was verified was not what was displayed.** The worker re-fetched each
  URL itself: no cookies, a `Range` header, no `Referer`. A server that tells
  the two requests apart could hand the reader an AI picture and the extension
  a signed photograph, and the badge landed on the picture nobody hashed. The
  content script now reads the response the browser already holds
  (`cache: 'only-if-cached'`, which makes no request of its own and sends no
  cookies) and hands those bytes over; where it cannot — an opaque
  cross-origin response — the worker's fetch still runs but its credentials
  are not read as provenance for the picture on the page. As a side effect an
  image-heavy page is now fetched once rather than twice.
- **A declared length decided where the credential store ended.** The hard
  binding is a digest over the file with the store excluded, and the reader
  took the store's extent from length fields that no hash and no signature
  covers. Overwriting the outer JUMBF box's own length made the declared store
  swallow the picture: the binding hashed 41 bytes of 1728, reported "valid",
  and one manifest minted once validated unchanged in front of any number of
  different pictures. A store found by byte-scan now supplies no exclusion
  range at all — nothing attests its extent — and a PNG chunk, WebP chunk,
  JPEG APP11 run or ISOBMFF box is used only when it ends inside the file and
  holds nothing but the JUMBF boxes that parsed. The badge line also says how
  much of the file was hashed.
- **A claim that referenced no assertions switched off the rule that only
  referenced assertions speak.** An empty reference list was read as "no basis
  to restrict", so every box in the manifest was admitted — including a hard
  binding the claim never named — and the summary said nothing about
  assertions at all. An empty list now admits nothing, and the manifest is
  reported as bound to no file.
- **Two assertion boxes sharing a label.** C2PA requires a label to be unique
  within a manifest; the reader hashed whichever box a `Map` kept and then read
  both, so a smuggled "digital capture" action nobody hashed was reported under
  "all 2 assertions match the signed claim". A repeated label now breaks the
  manifest.
- **Two denial-of-service bombs in the shared service worker.** A PNG `zTXt`
  or `iTXt` chunk inflated without any output ceiling: 512 KB of deflate became
  536 MB, four at a time, and a hostile page could retrigger it on every
  navigation until Chrome killed the worker and every tab's analysis with it.
  Decompression is now bounded per chunk and per image, and an over-cap chunk
  is reported as too large to inspect rather than failing the parse. Separately,
  `xmpValue` built its element regex with `new RegExp` — invisible to the
  literal ReDoS scanner — and its lazy middle rescanned to the end of the
  packet from every unclosed opening tag: 29 s for a 1 MB XMP packet, past
  Chrome's worker watchdog at the 4 MB fetch cap. Element extraction is now
  linear, every XMP packet is bounded before parsing, and the SVG comment scan
  uses `indexOf` rather than a lazy global regex. `test/redos.test.js` now
  loads `lib/image-metadata.js` with both shapes as fixtures.
- **IPv6 transition prefixes and LAN name suffixes walked past the address
  policy.** NAT64 (`64:ff9b::/96`), 6to4, Teredo, the IPv4-translated
  `::ffff:0:0/96` form and site-local `fec0::/10` were classified public, so a
  literal carrying `192.168.1.1` inside it was fetched on a network running
  the matching mechanism; so were `.lan`, `.intranet`, `.corp` and single-label
  intranet names. Each is now classified by the address it actually carries,
  and anything outside `2000::/3` fails closed. A page served from a `.local`,
  `.home.arpa` or `.internal` name is ranked where it sits — on the LAN — so a
  machine on the reader's Wi-Fi can no longer claim an mDNS name and be handed
  the reader's own loopback and redirect-following.
- **Nothing bounded how much one page could make the worker fetch.** The
  per-page cap counted live `<img>` elements, so rewriting `src` re-armed it
  forever, and the worker metered the caller not at all: twenty ordinary
  content-script batches from one tab pulled 640 requests and 2.6 GB with the
  reader's IP on them. The page-side cap is now a budget spent on URLs handed
  over, which a same-document navigation does not refill, and the worker holds
  a per-tab request and byte budget over a rolling minute, released when the
  tab navigates or closes. Only a URL the page's own loader actually fetched
  is handed over at all, which is what the address policy cannot check: it
  reads the URL's text and cannot resolve a name whose owner points it at
  127.0.0.1.
- **The saved report claimed more than it could show.** Its SHA-256 digest was
  called "integrity" and described as proof the file had not been edited since
  it was saved. It is unkeyed and stored inside the report, so anyone changing
  a finding can recompute it. The field is now `checksum` and says it catches
  accidental corruption and nothing else, from one exported sentence beside
  the credential caveat.
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
  The rule is matched against the host as a resolver reads it, so writing a
  name fully qualified (`http://localhost.:11434/…`, `http://nas.local./…`)
  does not walk past it. A redirect is not followed on such a page's behalf
  at all: the worker fetches with `redirect: 'manual'`, which does not perform
  the hop, because checking where a fetch landed happens after the fact and
  can only refuse the read — the request to the private address would already
  have been delivered. The cost is deliberate: an image behind a redirect is
  reported as not fetched. A page that is itself local (a `file:` album, a
  localhost fixture) still follows redirects, since the policy already lets it
  reach every address space. A `<video poster>` also has to belong to a video
  the page actually displays, which it did not before: the poster path had no
  rendered-size floor at all.
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
