# Selfreportle – AI Content Disclosure Detector

A Chromium (Manifest V3) extension that inspects the page you are looking at and shows, separately for the **site/code**, the **text** and the **images**, whether there are signs that the content was generated or assisted by AI, and whether that use is disclosed. It is meant as a reading aid in the context of the EU AI Act's transparency obligations (Regulation (EU) 2024/1689, Article 50), so you can decide how far to trust a page or whether to do business with its operator.

Everything runs locally in the browser. No data leaves your machine except the image fetches to the sites you visit (made without cookies).

## What it looks at

| Layer | Evidence (strong → weak) | Shown as |
| --- | --- | --- |
| **Site / code** | Fingerprints of AI site/app generators (Lovable, v0, Bolt.new, Base44, Manus, Durable, 10Web, Claude Artifacts); machine-readable disclosure hooks (`<meta name="ai-generated">` and similar, JSON-LD `digitalSourceType`, AI-generated flags, `data-ai-generated` attributes); HTML/JS comments that credit Copilot, Cursor, ChatGPT, Claude…; visible "this site was built with AI" statements; conventional builders (Wix, Framer, Squarespace…) as information only. Also "trust notes": placeholder phone numbers, e-mails, addresses, lorem ipsum and unfilled template variables. | Floating pill + panel, toolbar badge, popup card |
| **Text** | Visible disclosures ("AI-generated", "written with the help of ChatGPT", "100 % human-written"); hidden Unicode artefacts (Unicode tag characters and their decoded payload, zero-width steganographic runs, variation-selector runs, scattered zero-width characters, narrow no-break spaces outside French text); chat-transcript leakage ("As an AI language model", "Certainly! Here's…"); markdown and ChatGPT citation residue; stylometric heuristics (LLM lexicon density, sentence-length burstiness, dash density, tricolons, paragraph uniformity). | Coloured left bar + chip on each flagged block, whole-page verdict in pill and popup |
| **Images** | C2PA Content Credentials (claim generator, `c2pa.created` / `c2pa.edited` actions with IPTC digital source type, software agents, ingredients, signer certificate names); XMP/IPTC `DigitalSourceType`, `CreatorTool`, history agents, Midjourney prompt/job IDs; EXIF `Software`, `UserComment` with Stable Diffusion parameters, camera Make/Model; PNG text chunks written by Stable Diffusion WebUI, ComfyUI, NovelAI, InvokeAI, Fooocus; JPEG/SVG comments; plus DOM-side hints: captions and alt text, generator hostnames, file names. Formats: JPEG, PNG, WebP, AVIF/HEIC (C2PA + EXIF), SVG. | Badge in the corner of each image; click for the evidence |

### Who is behind the site

A separate **Trader** tab answers the question AI markers cannot: can the operator be identified? It reads the page for an imprint or legal notice, terms, privacy policy, returns or withdrawal policy, contact details, an about page, marketplace trader identification, a postal address, a telephone number, an e-mail address, VAT and company-register identifiers, and whether the page was served over HTTPS. VAT numbers are matched across EU formats plus the UK and Switzerland, tolerating the separators real imprints use; company numbers are matched per jurisdiction (UK company number, German HRB/HRA, Dutch KvK, French SIREN/SIRET, Italian REA, Spanish CIF/NIF, LEI, US EIN).

Nothing is looked up. Identifiers are checked for format only, so a well-formed number can still belong to nobody, and the panel says so. Pages that look like shops are held to the fuller set of checks. Pressure patterns are listed separately, with the reason each is restricted under EU consumer law: countdown timers, invented scarcity and viewer counts, very large discount claims measured against the Omnibus Directive's 30-day rule, and blanket "no returns" against the 14-day right of withdrawal. There is deliberately no trader score: the panel lists what is present and what is not, and leaves the judgement to the reader.

Legal background: e-Commerce Directive 2000/31/EC Article 5 and the national imprint rules built on it, the Consumer Rights Directive for distance selling, the Digital Services Act Article 31 for traders on marketplaces, and the Unfair Commercial Practices Directive as amended by the Omnibus Directive.

### Platform labels, where metadata dies

Instagram, Facebook, Threads, TikTok, YouTube, LinkedIn, Pinterest and X strip embedded metadata on upload and add their own marker instead. The extension reads those markers ("Made with AI", "AI info", "Altered or synthetic content", "Creator labeled as AI-generated", "AI modified", "Made with Grok"), attributes each to the media in the same post, and treats it as a disclosure by the platform rather than as embedded provenance. Matching is by visible text and accessible name, not by CSS class, because platform class names rotate constantly. Informational markers such as "AI info" are surfaced without changing the verdict.

### Domain memory

With `Remember what was found per domain` on, the extension keeps counters per hostname on this device only: pages seen, pages with AI markers, how many were disclosed, images with AI provenance, and which tools were named. No URLs and no page content are stored, nothing is uploaded, the store is capped at 400 domains by recency, and it can be cleared or switched off in settings. The Overview tab reads the pattern back, for example "AI markers on 14 of 20 pages you have opened here, none of them disclosed".

### Which AI, and what it tends to do

For every layer the extension also names the tool the evidence points to, with the strength of that attribution:

* **confirmed** by embedded metadata or artefacts (C2PA claim generator and signer, XMP creator tool, Stable Diffusion parameters including the checkpoint name and front-end, ChatGPT citation markers, site-generator fingerprints);
* **declared** on the page (a caption, disclosure or meta tag that names the tool);
* **inferred** from hosting or style (weak, and labelled as a guess);
* or **unidentified**, in which case the generic tendencies of LLMs, image generators or AI-built sites are shown instead.

Each identified vendor comes with a short list of documented **skews**: sycophancy, measured political lean, content rules of the vendor's jurisdiction (for example PRC-aligned refusals in DeepSeek and Qwen), representation defaults of image generators, commercial grounding, provenance and litigation history, and the underlying model vendor behind site builders such as Lovable, Bolt, v0 and Replit Agent. Every note carries its basis and the catalogue carries a review date (`lib/attribution.js`, `REVIEWED`). These notes describe typical default behaviour reported publicly, not the specific page, and models change between versions.

### Display and accessibility

* **Three display moods**, chosen in settings. *Quiet* keeps badges invisible until the cursor nears the item and lets the pill shrink to a dot. *Reader* is the default. *Forensic* widens the panels, sets evidence in monospace and expands hidden-character views.
* **Colour-blind-safe palette** derived from the Okabe–Ito set, darkened so white badge text clears WCAG AA on every fill. Colour never carries meaning alone: each verdict has its own glyph (◆ generated, ◈ edited or likely, ✎ disclosed, ? weak, ● camera, ✋ declared human, ▦ algorithmic, ○ none, ⊘ not inspectable).
* **Dark theme** for the in-page panel and popovers, following the reader's system setting.
* **Toolbar icon changes state**, not just its count: the lens pupil takes the verdict colour, and resets to neutral on navigation.
* **Right-click actions**: "Inspect this image for AI provenance" analyses any image on demand, ignoring the size floor and per-page cap; "Check selected text for AI signals" analyses a selection in place.
* **Tabbed report** in the toolbar popup: a sticky verdict header over Overview, Site, Text, Images and Tools, each tab carrying a count badge.
* **Keep a record**: copy the report as JSON, save it as a file, or save a shareable PNG receipt. Saved reports carry a SHA-256 digest of their own findings so you can show the file has not been edited since; that digest is self-attested by the extension, not notarised by a third party.
* **Hidden-character reveal**: any flagged block whose popover contains invisible characters offers a view that names each one (ZWSP, TAG…, VS3, NNBSP) without touching the page, plus a "Copy cleaned text" button that strips them.

Verdict colours: red = AI-generated / strong indicators, orange = AI-edited or likely AI, amber = disclosed as AI, yellow = weak signals, green = capture credentials or declared human, blue = algorithmic / conventional builder, grey = no signal.

### What it cannot do (and says so)

* **Invisible pixel or token watermarks** such as SynthID, Stable Signature or OpenAI's text watermark need the vendor's keys. They are not detected.
* **C2PA signatures are parsed, not verified.** The extension reads who claims to have signed; it does not validate the certificate chain or the hashes. Treat the signer name as a claim.
* **Metadata can be stripped or forged.** "No provenance signals" is not proof of human origin, and most social platforms strip metadata on upload.
* **Stylometry is a heuristic.** It is capped so that it can never produce the strongest verdict on its own, and sensitivity is adjustable.
* **Disclosures are self-reports.** A page that says "human-written" is only telling you what it says.

## EU AI Act, Article 50 in one paragraph

Providers of generative AI systems must ensure their outputs are marked in a machine-readable format and detectable as artificially generated (Art. 50(2)). Deployers must disclose deepfakes (Art. 50(4)) and AI-generated text published to inform the public on matters of public interest, unless a human has reviewed it and someone holds editorial responsibility. These obligations apply from **2 August 2026**. C2PA Content Credentials and IPTC digital source types are the most widely deployed machine-readable markers today, which is why the image analyser leans on them; there is no equivalent standard yet for text or for whole sites, so those layers rely on conventions and heuristics.

## Install (unpacked)

1. Clone this repository.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`), enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Browse. The pill appears bottom-right; the toolbar icon shows a count of flagged items and opens the full report. **Copy** in the popup puts the whole report on the clipboard as JSON, for keeping evidence. Settings live under the ⚙ button and apply immediately.

Requires Chrome/Chromium 116 or newer.

## Development

```
npm test          # unit tests (Node ≥ 18, no dependencies)
npm run lint      # syntax check of every script
npm run e2e       # loads the extension into Chromium via Playwright and checks a fixture site
npm run icons     # regenerate icons/*.png
```

The end-to-end run needs `playwright` resolvable (locally or globally) and a Chromium build; set `PW_CHROMIUM=/path/to/chrome` to pin the binary. Both suites run in GitHub Actions (`.github/workflows/test.yml`).

Layout:

```
manifest.json               MV3 manifest
lib/signals.js              pattern catalogue (tools, builders, disclosures, lexicon, hosts)
lib/text-analyzer.js        text signals
lib/site-analyzer.js        site/code signals (works on a serialisable DOM snapshot)
lib/image-hints.js          DOM-side image hints (captions, hosts, file names)
lib/attribution.js          vendor/product profiles, attribution rules, documented skews
lib/platform-labels.js      AI labels applied by Instagram, TikTok, YouTube, LinkedIn, Pinterest, X
lib/history.js              local-only per-domain counters
lib/legitimacy.js           trader identification, policies, identifiers, pressure patterns
lib/image-metadata.js       JPEG/PNG/WebP/ISOBMFF parsing: EXIF, XMP, PNG text, C2PA/JUMBF
lib/cbor.js                 minimal CBOR codec for C2PA claims and COSE
lib/verdicts.js             verdict vocabularies, colours, combination and overall rules
lib/settings.js             defaults and storage
background/service-worker.js  fetches image bytes cross-origin, caches, stores per-tab results, badge
content/content.js          orchestrates the analyses on the page and reports results
content/overlay.js          shadow-DOM pill, panel, badges and popovers
popup/                      toolbar report
options/                    settings page
test/                       node:test suites with synthetic JPEG/PNG/WebP/C2PA fixtures
test/e2e/                   Playwright run against a fixture site with the extension loaded
```

Every `lib/*.js` file is a plain script in the extension and a CommonJS module under Node, so the analysers are unit-tested with synthetic fixtures (`test/helpers.js` builds PNG chunks, TIFF/EXIF blocks, XMP packets, JUMBF boxes and CBOR claims from scratch).

## Privacy

* No analytics, no remote calls to the author.
* Image bytes are fetched from the page's own sources with `credentials: 'omit'`, limited to the first few MB (configurable), and cached in memory only.
* Results are kept in `chrome.storage.session` per tab and discarded when the tab closes.
* Hosts can be excluded in the settings.
* Domain memory holds counters per hostname, never URLs or page content, on this device only. It is capped, clearable and can be switched off.
