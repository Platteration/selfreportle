# Selfreportle – AI Content Disclosure Detector

A Chromium (Manifest V3) extension that inspects the page you are looking at and shows, separately for the **site/code**, the **text** and the **images**, whether there are signs that the content was generated or assisted by AI, and whether that use is disclosed. It is meant as a reading aid in the context of the EU AI Act's transparency obligations (Regulation (EU) 2024/1689, Article 50), so you can decide how far to trust a page or whether to do business with its operator.

Everything runs locally in the browser. No data leaves your machine except the media fetches to the sites you visit, made without cookies, and any reverse-image-lookup link you choose to click.

The same analysers are also a website: one page where you pick an image, a video, a saved web page or a text file and the report is drawn in that page, from that file, with nothing uploaded (see [The website](#the-website)).

## What it looks at

| Layer | Evidence (strong → weak) | Shown as |
| --- | --- | --- |
| **Site / code** | Fingerprints of AI site/app generators (Lovable, v0, Bolt.new, Base44, Manus, Durable, 10Web, Claude Artifacts); machine-readable disclosure hooks (`<meta name="ai-generated">` and similar, JSON-LD `digitalSourceType`, AI-generated flags, `data-ai-generated` attributes); HTML/JS comments that credit Copilot, Cursor, ChatGPT, Claude…; visible "this site was built with AI" statements; conventional builders (Wix, Framer, Squarespace…) as information only. Also "trust notes": placeholder phone numbers, e-mails, addresses, lorem ipsum and unfilled template variables. | Floating pill + panel, toolbar badge, popup card |
| **Text** | Visible disclosures ("AI-generated", "written with the help of ChatGPT", "100 % human-written"); hidden Unicode artefacts (Unicode tag characters and their decoded payload, zero-width steganographic runs, variation-selector runs, scattered zero-width characters, narrow no-break spaces outside French text); chat-transcript leakage ("As an AI language model", "Certainly! Here's…") and turn labels ("ChatGPT said:"); the shape of a chat reply (an opener, a prepared answer, an offer to do more); markdown, bold-labelled paragraphs (rendered or written out) and ChatGPT citation residue; stylometric heuristics (LLM lexicon density, sentence-length burstiness, dash density, tricolons, paragraph uniformity). | Coloured left bar + chip on each flagged block, whole-page verdict in pill and popup |
| **Images, video, audio** | C2PA Content Credentials, cryptographically verified (claim generator, `c2pa.created` / `c2pa.edited` actions with IPTC digital source type, software agents, ingredients, signer certificate names); XMP/IPTC `DigitalSourceType`, `CreatorTool`, history agents, Midjourney prompt/job IDs; EXIF `Software`, `UserComment` with Stable Diffusion parameters, camera Make/Model; PNG text chunks written by Stable Diffusion WebUI, ComfyUI, NovelAI, InvokeAI, Fooocus; JPEG/SVG comments; plus DOM-side hints: captions and alt text, generator hostnames, file names. Formats: JPEG, PNG, WebP, AVIF/HEIC, MP4/M4A/MOV (C2PA + EXIF), SVG. | Badge in the corner of each image; click for the evidence |

### Verifying Content Credentials

Reading a manifest and trusting it are different things, so the extension answers four separate questions and reports them separately.

1. **Is the signature valid?** The COSE_Sign1 signature is checked with WebCrypto against the public key in the embedded leaf certificate, covering ES256/384/512, PS256/384/512, RS256/384/512 and Ed25519, with detached payloads reconstructed from the claim bytes. A valid signature proves the claim has not been altered since it was signed.
2. **Do the assertions match the claim?** Each assertion's JUMBF box is re-hashed and compared with the hash the claim recorded. This is what stops someone swapping "made by a camera" for "made by AI" while leaving the signature intact. Producers differ over whether that hash covers the whole box or only its content, so both are tried; if neither reconciles, the result is reported as inconclusive rather than as tampering, because a false accusation would be worse than an unanswered question.
3. **Does the certificate chain mean anything?** The chain is checked for internal consistency (each certificate actually signed by the next, verified cryptographically) and for validity dates.
4. **Does the manifest describe *this* file?** A C2PA claim is only about an asset because it carries a hard binding: a digest over the asset's own bytes with the credential store excluded. That digest is recomputed here, over the fetched bytes, with the exclusion ranges the claim declares — and those ranges are refused unless together they are exactly the credential store, whole, because a claim that excludes the picture itself is hashing nothing and one that leaves part of the store hashed is not an embedding this reader has validated. In a PNG the file must also walk cleanly from its signature and `IHDR` through its image data to an `IEND` that ends it, and every excluded range must be whole `caBX` chunks of that walk. A claim carries one hard binding; only `c2pa.hash.data` is recomputed, so a BMFF or box-hash binding, a second binding, a byte-capped fetch or a range set that cannot be accounted for leaves the binding unchecked, never matched. Without this check a genuine, fully verifying camera manifest can be lifted byte for byte out of a real photograph and dropped into a generated image: signature valid, assertions intact, chain consistent, and every word of it about a different file.

**This build ships no C2PA trust list, so no chain is anchored — and an unanchored chain earns no badge.** A verified signature is reported as "the manifest is intact since signing", never as "this really is Adobe". That is not only a wording rule: a self-signed certificate with "Leica Camera AG" typed into it answers every other question yes, so until a chain reaches a signer this build knows, a claim that a camera or a human made the file is shown as the unverified assertion it is and produces no camera badge and no page-level provenance tick. Populating that list — the C2PA conformance bundle, plus an anchor list the reader can import — is the outstanding work; the mechanism that consumes it is in `lib/c2pa-verify.js` (`setTrustAnchors`).

Outcomes are three, kept visually distinct: **verified** (all four answers are yes), **broken** (the signature, an assertion hash, the chain or the hard binding verifiably does not add up, or the claim carries no hard binding at all), and **caution** (the claim is authentic but something could not be reconciled: its assertions, or the binding, because the fetch was byte-capped, the binding form is one this reader cannot recompute, the claim carries more than one, or its exclusion ranges could not be accounted for). Nothing here touches the network, and an unanswered question is never reported as a pass. In particular, a binding that could not be recomputed is never treated as one that matched.

Four rules keep a valid signature from vouching for the wrong thing:

* **The signature must cover the claim being reported.** A COSE payload carried inline is accepted only when it is byte-identical to the claim in the manifest. Without that check, a genuine signature can be lifted from one asset and attached beside an attacker's claim, and the reader shows their words under the real signer's name.
* **The claim must be bound to the file it arrived in.** Its hard binding is recomputed over the fetched bytes; a mismatch is a broken manifest, and a claim with no hard binding at all is invalid rather than merely unverified, because it describes no particular file.
* **Only assertions the signed claim references may speak for the asset.** An assertion box added afterwards disturbs no signature, so an unreferenced one is ignored; once hashes verify, only the assertions that matched are read. That includes the hard binding: one nobody referenced binds nothing.
* **A broken manifest stops speaking entirely.** No claim from it reaches the verdict, and the finding that it is broken outranks any benign claim inside it, so a tampered manifest can never produce a green camera-provenance result.

**Nothing is exculpatory for free, whatever field it is written in.** A claim that a camera or a human made the image is the one worth forging, and forging it costs nothing: a hand-written JUMBF box with no certificate and no key says "digitalCapture" just as loudly as a signed one, an `Iptc4xmpExt:DigitalSourceType` attribute is one line of XML, and an EXIF `Make` is a string whatever wrote the file chose. So the green **camera-capture** badge is reserved for a manifest that verified, is bound to these bytes, anchors to a signer this build knows, and decodes to the picture the page is actually showing — the bytes are read in the page and compared with the element, pixel for pixel, because the browser's cache can be overwritten after an image has been decoded and so says nothing about what a reader saw. Everything short of that — an unverified or unanchored manifest, an IPTC attribute, camera EXIF — is shown as **"Origin claimed by the file, not verified"**: a neutral badge, ranked no higher than no evidence at all, wording the claim rather than endorsing it. The claim is still shown, because it is real evidence and hiding it would be worse; it just never reads as a check that was performed. Claims of AI generation are read at full strength either way — a self-declaration against interest is not worth forging.

The page-level provenance tick follows the same rule: it means credentials, so only an image with a manifest that met all four conditions lights it. A sentence on the page declaring human authorship is reported as the disclosure it is, not as a credential.

The verifier is tested against real cryptography, not stubs: the test suite generates P-256 keys, issues genuine X.509 certificates, signs real COSE structures over assets whose hard bindings really do hash, and then attacks them one change at a time — a tampered signature, a swapped assertion, a broken chain link, expired dates, a replayed signature over a forged claim, an injected unreferenced assertion, an assertion deleted after signing, an unreadable certificate in the chain, a genuine manifest transplanted onto another picture, one changed byte of the asset, a claim with no hard binding, and a binding whose exclusions swallow the whole file — to confirm each is caught and correctly distinguished from the others. The end-to-end run does the same inside the browser.

### Video and audio

Video and audio carry Content Credentials in the same JUMBF store as images, so they go through the same pipeline. The ISOBMFF reader walks the box tree rather than only the top level, so credentials nested in `moov/udta` are found, and MP4, M4A, MOV, AVIF and HEIC are all covered. Many MP4s put their index, and therefore their credentials, at the end of the file where a prefix fetch never reaches; when the head shows no index, the extension makes one suffix range request for the tail, and refuses an answer longer than it asked for rather than reading it; what the head already said stands. Poster frames are inspected as separate images. Byte budgets for media are separate from images and default to 512 KB per fetch.


### Which AI, and what it tends to do

For every layer the extension also names the tool the evidence points to, with the strength of that attribution:

* **confirmed** by embedded metadata or artefacts (C2PA claim generator and signer, XMP creator tool, Stable Diffusion parameters including the checkpoint name and front-end, ChatGPT citation markers, site-generator fingerprints);
* **declared** on the page (a caption, disclosure or meta tag that names the tool);
* **inferred** from hosting or style (weak, and labelled as a guess);
* or **unidentified**, in which case the generic tendencies of LLMs, image generators or AI-built sites are shown instead.

Each identified vendor comes with a short list of documented **skews**: sycophancy, measured political lean, content rules of the vendor's jurisdiction (for example PRC-aligned refusals in DeepSeek and Qwen), representation defaults of image generators, commercial grounding, provenance and litigation history, and the underlying model vendor behind site builders such as Lovable, Bolt, v0 and Replit Agent. Every note carries its basis and the catalogue carries a review date (`lib/attribution.js`, `REVIEWED`). These notes describe typical default behaviour reported publicly, not the specific page, and models change between versions.

### Research and model coverage

The detector includes a local, cited research catalogue reviewed for the October 2021–October 2026 publication window. The inspected studies cover 2023–2025: biomedical excess vocabulary, detector bias against non-native English writers, the M4 and RAID benchmarks, statistical watermarking, and DetectGPT. The Text report links relevant findings to their inspected sources. This is a heuristic reading aid; it does not run those papers' trained classifiers or report a measured probability of AI authorship. See [the research notes](docs/detection-research.md) for the scope and limitations of each source.

Sixteen researched vocabulary families add support alongside the existing idiom and rhythm rules. Repeated instances of one word do not count as independent clues. A small vocabulary cluster, ordinary Markdown, polite closings, or punctuation alone stays below the text-flag threshold. A large, diverse cluster can produce a weak flag, and all style signals share a cap below the strongest verdict. Vocabulary and typography leave the model **unidentified**; the detector no longer guesses OpenAI from words such as “delve” or from dash usage.

Current assistants rarely use that vocabulary, so a chat reply is also read by its shape. Its register has three parts: an opener that grades or agrees with the question ("Great question", "You're absolutely right"), a line that presents a prepared answer ("Here's a step-by-step guide"), and an offer to do more ("Want me to…?", "If you tell me X, I can…", or a closing question back to the reader). People write each of these, so one part alone never flags. Two parts beside a second kind of evidence can flag, and so can all three alone, which gives only the weak flag. The other kind of evidence is usually the bold labels a chat window puts at the start of paragraphs: written out as `**…**` when a reply is copied with its markdown, or counted from the page's `<strong>`/`<b>` when the reply is rendered. Documentation introduces its examples the same way ("Here's an example:"), so that framing never counts with bold labels. A plain explanation with none of these phrases can still show the shape: it opens with a short paragraph that answers, speaks to its reader as "you" at least once in every forty words, and sits under at least three bold labels. Each of those alone is common in letters and documentation, and a page that opens with a title instead of an answer never counts. A line reading "ChatGPT said:", the label ChatGPT's conversation pages give a reply, is hard evidence that names the tool. Claude, Gemini and Grok are also people's and things' names, so a line naming one of them counts only beside a "You said:" line. Measured on replies collected after the rules were written and never used to tune them: 40 from Claude went from 0 flagged to 10–12 (pasted, as a text file, rendered), and 30 from Gemini from 2 to 21–22. Most of the Claude replies still missed are impersonal explanations under bold labels, which is also what documentation looks like. The stock moves of assistant prose are read as well: "it's not X, it's Y" and its variants, "The result? …", "No fluff. No jargon. Just results.", "Here's the thing", "Let that sink in", "That's where X comes in", "Less noise, more signal", "And that's okay", runs of very short sentences. Each is counted by kind, so a writer who leans on one move is one habit however often they use it. Three kinds in one text anchor beside other evidence, and four give the weak flag alone. Columnists use each of these, and on 60 LinkedIn posts, launch announcements and short essays written by Claude and Gemini, the moves were real but rarely stacked: a third used a reframe, and no piece used more than three kinds, so they add to a report far more often than they decide a verdict. Of 1,632 pieces of package and tool documentation and 15 conversational controls, none gained a flag at any sensitivity (four of the documents state their own AI use and were reported as disclosed, before and after).

Explicit disclosures recognize more model families and version names across all eight supported disclosure languages, including Gemma/CodeGemma, Phi, Cohere Command/Aya, Jamba, Granite, OLMo, Kimi, MiniMax, GLM, InternLM, Yi, Baichuan, Qwen, Llama and Mistral variants. Older families include EleutherAI GPT-Neo/GPT-J/GPT-NeoX/Pythia, BigScience BLOOM and MosaicML MPT; Falcon-H1 covers the verified 2025 Falcon release. Media identifiers include Hunyuan, Wan, LTX-Video, Bark, AudioCraft/MusicGen/AudioGen and ElevenLabs. Generic mentions of these products in captions do not by themselves mark an image as generated. ComfyUI identifies the interface; a named checkpoint is needed to distinguish the model it ran. The Tools report can list multiple credited models within one passage.

Documented Llama, Gemma, Harmony, MiniMax and Kimi output delimiters can identify a compatible **format family** when the required markers occur together. Shared ChatML, assistant role tags and `<think>` delimiters stay weak and identify no vendor. A copied template or a human explanation can contain the same markers. The complete names, format rules and primary documentation links live in `lib/model-catalog.js`; no page text is uploaded to run this detection.

### Platform labels, where metadata dies

Instagram, Facebook, Threads, TikTok, YouTube, LinkedIn, Pinterest and X strip embedded metadata on upload and add their own marker instead. The extension reads those markers ("Made with AI", "AI info", "Altered or synthetic content", "Creator labeled as AI-generated", "AI modified", "Made with Grok"), attributes each to the media in the same post, and treats it as a disclosure by the platform rather than as embedded provenance. Matching is by visible text and accessible name, not by CSS class, because platform class names rotate constantly. Informational markers such as "AI info" are surfaced without changing the verdict.

### Languages

Detection is not English-only. Disclosure phrasing and LLM-typical wording are carried per language for **German, French, Spanish, Dutch, Italian, Portuguese and Polish** alongside English, in `lib/lexicons.js`. Two rules keep cross-language noise out:

* Disclosure patterns for the page's language **and** English always run, because English disclosures turn up on pages in every language.
* Stylometry runs only for the detected language. Applying the English lexicon to German prose would invent signals, so it never happens.

The language is taken from the page's `lang` attribute when it names one we carry, and otherwise detected from function-word frequencies across the whole page; short or ambiguous text yields no guess rather than a wrong one. Per-language lexicons are smaller than the English one and therefore fire less often, which is the safer failure. The Text tab names which lexicon was used and how it was chosen.

One cross-cutting fix came out of this: "created with the help of AI" trips both an assistance pattern and a generation pattern over the same words, so an overlapping generation match is now dropped rather than upgrading the verdict. Separate clauses still both count.

### Who is behind the site

A separate **Trader** tab answers the question AI markers cannot: can the operator be identified? It reads the page for an imprint or legal notice, terms, privacy policy, returns or withdrawal policy, contact details, an about page, marketplace trader identification, a postal address, a telephone number, an e-mail address, VAT and company-register identifiers, and whether the page was served over HTTPS. VAT numbers are matched across EU formats plus the UK and Switzerland, tolerating the separators real imprints use; company numbers are matched per jurisdiction (UK company number, German HRB/HRA, Dutch KvK, French SIREN/SIRET, Italian REA, Spanish CIF/NIF, LEI, US EIN).

Nothing is looked up. Identifiers are checked for format only, so a well-formed number can still belong to nobody, and the panel says so. Pages that look like shops are held to the fuller set of checks. Pressure patterns are listed separately, with the reason each is restricted under EU consumer law: countdown timers, invented scarcity and viewer counts, very large discount claims measured against the Omnibus Directive's 30-day rule, and blanket "no returns" against the 14-day right of withdrawal. There is deliberately no trader score: the panel lists what is present and what is not, and leaves the judgement to the reader.

Legal background: e-Commerce Directive 2000/31/EC Article 5 and the national imprint rules built on it, the Consumer Rights Directive for distance selling, the Digital Services Act Article 31 for traders on marketplaces, and the Unfair Commercial Practices Directive as amended by the Omnibus Directive.

### Domain memory

With `Remember what was found per domain` on, the extension keeps counters per hostname on this device only: pages seen, pages with AI markers, how many were disclosed, images with AI provenance, and which tools were named. No URLs and no page content are stored, nothing is uploaded, the store is capped at 400 domains by recency, and it can be cleared or switched off in settings. The Overview tab reads the pattern back, for example "AI markers on 14 of 20 pages you have opened here, none of them disclosed".

### Display and accessibility

* **Three display moods**, chosen in settings. *Quiet* keeps badges invisible until the cursor nears the item and lets the pill shrink to a dot. *Reader* is the default. *Forensic* widens the panels, sets evidence in monospace and expands hidden-character views.
* **Optional text emphasis.** In Settings → Text → Text appearance, choose *Markers only* (the default), *Highlight*, *Robotic font* or *Font + highlight*. Weak, likely and strong AI indicators progress from a plain sans-serif face to monospace and then wider spacing; highlighting uses a stronger tint for stronger signals. These are signal levels, not probability estimates. AI-assistance and generation disclosures have their own amber highlights and remain labelled as self-reports. A live preview shows every level before saving. Turning off text markers, hiding the overlay or pausing a site removes the emphasis. No words are rewritten or wrapped; code, editing fields and blocks containing them keep their original fonts, and nested blocks are styled only from their own findings. Font changes can reflow a paragraph.
* **Colour-blind-safe palette** derived from the Okabe–Ito set, darkened so white badge text clears WCAG AA on every fill. Colour never carries meaning alone: each verdict has its own glyph. Vermillion ◆ is AI-generated or a strong indicator, purple ◈ is AI-edited or likely AI, orange ✎ is disclosed as AI, gold ? is a weak signal, green ● is camera-capture provenance and ✋ a declared human origin, blue ▦ is algorithmic media or a conventional builder, slate ○ is no signal and ⊘ could not be inspected.
* **Dark theme** for the in-page panel and popovers, following the reader's system setting.
* **Toolbar icon changes state**, not just its count: the lens pupil takes the verdict colour, and resets to neutral on navigation.
* **Right-click actions**: "Inspect this image for AI provenance" analyses any image on demand, ignoring the size floor and per-page cap; "Check selected text for AI signals" analyses a selection in place.
* **Tabbed report** in the toolbar popup: a sticky verdict header over Overview, Site, Text, Images, Trader and Tools, each tab carrying a count.
* **Keep a record**: copy the report as JSON, save it as a file, or save a shareable PNG receipt. Saved reports carry a SHA-256 checksum of their own findings, which catches accidental corruption; it is unkeyed and stored inside the report, so it cannot show the file has not been edited — anyone changing a finding can recompute it.
* **Hidden-character reveal**: any flagged block whose popover contains invisible characters offers a view that names each one (ZWSP, TAG…, VS3, NNBSP) without touching the page, plus a "Copy cleaned text" button that strips them.
* **Keyboard throughout.** `Alt+Shift+A` toggles the in-page badges, rebindable at `chrome://extensions/shortcuts`. The popup is a proper tablist: arrow keys move between tabs, `Home` and `End` jump to the ends, and each panel is a labelled `tabpanel`. `Escape` closes the in-page panel and popovers.
* **Reverse image lookup.** Links under a flagged image open Google Lens, TinEye or Bing with that image URL. They are links you choose to follow; nothing leaves the browser unless you click one.
* **Pause per site.** One button in the popup stops analysis on the current hostname, and resumes it.

### Publisher self-check

The same analysis, pointed at your own site. Open it from the popup and it shows what a reader running this extension actually sees on your page, then hands over paste-ready markup for the gaps: a machine-readable AI declaration, JSON-LD carrying the IPTC digital source type, a visible disclosure line, per-image marking, a build-pipeline note on keeping Content Credentials alive through re-encoding, and a footer linking the disclosures a visitor expects. It also lists your own files whose credentials are unsigned or fail to verify.

Every row is labelled **legal duty** or **good practice**, because conflating them would be misleading. Article 50 puts the machine-readable marking duty on the *provider* of the generative model, not on you; as a *deployer* your duties are disclosing deepfakes and disclosing AI-generated text published to inform the public on matters of public interest, unless a human reviewed it and holds editorial responsibility. A marketing page about your own products is generally neither. The page says all of this plainly, and says it is not legal advice.

### What it cannot do (and says so)

* **Invisible pixel or token watermarks** such as SynthID, Stable Signature or OpenAI's text watermark need the vendor's keys. They are not detected.
* **C2PA signatures are verified, but the signer is not vouched for.** See below.
* **Some hard bindings cannot be recomputed here.** BMFF Merkle-tree and box-hash bindings are not implemented, and a byte-capped fetch cannot hash a file it has not fully read. Those manifests are reported as *caution*, never as verified: the extension will say the credentials could not be tied to the file rather than pretending they were.
* **Metadata can be stripped or forged.** "No provenance signals" is not proof of human origin, and most social platforms strip metadata on upload.
* **Stylometry is a heuristic.** It is capped so that it can never produce the strongest verdict on its own, and sensitivity is adjustable.
* **A plain AI explanation often reads as no signal.** A reply with no opener, no offer and no announced answer, only well-formatted prose, looks like good human documentation, and is left unflagged rather than guessed at. So does a reply edited to remove its chat phrasing.
* **Disclosures are self-reports.** A page that says "human-written" is only telling you what it says.

## EU AI Act, Article 50 in one paragraph

Providers of generative AI systems must ensure their outputs are marked in a machine-readable format and detectable as artificially generated (Art. 50(2)). Deployers must disclose deepfakes (Art. 50(4)) and AI-generated text published to inform the public on matters of public interest, unless a human has reviewed it and someone holds editorial responsibility. These obligations apply from **2 August 2026**. C2PA Content Credentials and IPTC digital source types are the most widely deployed machine-readable markers today, which is why the image analyser leans on them; there is no equivalent standard yet for text or for whole sites, so those layers rely on conventions and heuristics.

## Running it

1. Clone this repository.
2. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`), enable **Developer mode**.
3. Click **Load unpacked** and select the repository folder.
4. Browse. The pill appears bottom-right; the toolbar icon shows a count of flagged items and opens the full report. **Copy** in the popup puts the whole report on the clipboard as JSON, for keeping evidence. Settings live under the ⚙ button and apply immediately.

Requires Chrome/Chromium 116 or newer.

### The website

The website is a static page, `web/index.html`, that runs the extension's own `lib/` analysers on one file the visitor picks: an image, video or audio file (C2PA Content Credentials verified with WebCrypto in the page, with the hard binding recomputed over the whole file up to 32 MB — past that the head is read, and for MP4/MOV the tail, and a binding over bytes that were not read is reported as not recomputed; XMP/IPTC; EXIF; PNG generator chunks; the file name), a web page saved as HTML (site fingerprints, disclosures, text signals, hidden characters, trader identification, and its pictures judged by caption, alt text and file name), or plain text. The file is read with the File API and never uploaded. Once the page has loaded, the only requests it makes are to the site's own `api/`, and its policy allows no other (`connect-src 'self'`): one `GET api/config`, which on every static host is answered "nothing on"; where the host runs the site's API with sign-in on, one `GET api/me` on every load, signed in or not; and, only when the visitor signs in, buys, signs out or deletes the account, the requests described under [Sign in and "Support this app"](#sign-in-and-support-this-app). None of them carries the file. A saved page is parsed into a document with no window: none of its scripts run and none of its pictures, styles or frames load, so a picture inside it is judged by what the page says about it, and its own file has to be picked to read its metadata. Six `lib/` modules are not part of it: `settings.js` and `history.js` keep their records in `chrome.storage` (the page keeps no settings and no history), `fetch-policy.js` governs the extension worker's cross-origin fetches (the page fetches nothing from another site), `byte-budget.js` bounds a stream whose sender chooses its length (the page slices the picked file to its cap instead), `platform-labels.js` pairs a platform's label with a post's media by on-screen position, which a saved file has no layout to answer, and `text-display.js` styles paragraphs in a live page's DOM whereas the website draws its own report and leaves the parsed document inert.

The host does only the hosting: the files, the response headers, the not-found page, and refusing everything that is not part of the site. Build the site into an empty folder and publish that folder, never the checkout:

```
npm run build:site -- site --host=netlify                       # Netlify: adds _headers and _redirects
npm run build:site -- site --host=cloudflare                    # Cloudflare Pages: adds _headers and _routes.json
npm run build:site -- site --host=apache --base=/selfreportle/  # Apache: adds .htaccess; --base for a sub-folder
npm run build:site -- site --host=nginx                         # nginx: the site alone; the server takes deploy/nginx.conf
npm run build:site -- site --host=pages --base=/selfreportle/   # GitHub Pages or any host that sends no headers
```

The site is the page and what it loads (`web/`), the fourteen `lib/` modules the page names, the favicon, `404.html`, `robots.txt`, `.well-known/security.txt`, `LICENSE` and `api/config` (the answer "no sign-in, no shop", for a host that runs no API), and nothing else; `node scripts/build-site.js --list` prints it. `--base` is the path the site is served under, which the not-found page (answered at any depth) and Apache's `ErrorDocument` need. The Apache and nginx configs also answer 404 to every path outside that list, so a server pointed at the wrong folder still publishes only the site. Apache needs `mod_rewrite`, `mod_headers` and `mod_mime` (`a2enmod rewrite headers`: Debian and Ubuntu leave the first two off) and `AllowOverride All`, or at least `FileInfo Indexes Options`, on the folder; nothing in `.htaccess` is wrapped in `<IfModule>`, so without a module every request is a 500 with a line in the error log, never the folder served bare. `deploy/nginx.conf` asks for HTTP/2 on its `listen` lines, the form nginx 1.22 and 1.24 load (1.25.1 and later load it with a deprecation warning; `http2 on;` would refuse the whole file before 1.25.1).

**Response headers.** The same set is in `web/_headers` (Netlify, Cloudflare Pages), `web/.htaccess` (Apache) and `deploy/nginx.conf` (nginx), and the policy and referrer policy are in the `<meta>` of `index.html` and `404.html` for a host that sends no headers; `test/website.test.js` holds every copy equal.

| Header | Value | Why |
| --- | --- | --- |
| `Content-Security-Policy` | `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'; require-trusted-types-for 'script'; trusted-types selfreportle-saved-page; frame-ancestors 'none'; upgrade-insecure-requests` | Only the site's own scripts and stylesheet; the favicon, and the preview drawn from the picked file (`blob:`); no connection but to the site's own `api/` (`account.js`). Google's sign-in and Stripe's Checkout are top-level navigations, which the policy does not govern, so nothing of theirs is loaded into the page. Trusted Types make every HTML string sink throw; the one policy named is the one that hands a saved page to `DOMParser`. Each source was measured in Chromium with the policy sent as a header: without `blob:` the preview is refused, without the policy name the checker cannot start, and with `connect-src 'none'` the page's question to `api/config` is refused (a violation on every load, with the headers and with the `<meta>` alone). |
| `X-Content-Type-Options` | `nosniff` | Files are what their type says. |
| `X-Frame-Options` | `DENY` | The old browsers' half of `frame-ancestors 'none'`: no other site may frame the checker. |
| `Referrer-Policy` | `no-referrer` | The page links to its source and nowhere else, and has nothing to tell anyone. |
| `Permissions-Policy` | thirty features, each `()`: camera, microphone, geolocation, the clipboard, payment, USB, sensors, the Topics API and the rest | The checker uses no browser feature a policy governs. Only names Chromium recognises are listed, since an unknown one is a console warning. |
| `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy` | `same-origin` | Other windows cannot reach this one, and other sites cannot embed its files. |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | Browsers remember to use HTTPS. |
| `Cache-Control` | `no-cache` | No file name carries a version, so every load revalidates (an unchanged file is a 304) and a deploy never mixes old scripts with new HTML. |

**GitHub Pages, and one origin for every app.** Pages sends no headers, so there the `<meta>` policy is the protection, without `frame-ancestors` (a `<meta>` cannot carry it): the checker can be framed by another site there, and the other headers above are missing. A project site on Pages also shares its origin, `platteration.github.io`, with every other app the account publishes, and storage, caches and service workers are per origin. This page stores nothing in the browser but, where the site's API is on, one record in the tab's `sessionStorage` while a payment is on its way (below), and the API's HttpOnly session cookie once the visitor signs in; a page published next to it could store anything; a custom domain or subdomain per app gives each its own origin, and the API needs one (see below). After a deploy there, check that `/.well-known/security.txt` answers: a branch build runs Jekyll, which skips dot-folders unless a `_config.yml` says `include: [".well-known"]`.

**Launch checklist**, with `SITE` the host name and `URL` the site's https address, ending in `/` (`https://SITE/` or `https://SITE/selfreportle/`):

```sh
curl -sI http://SITE/ | head -1                       # a 301 to https
curl -sI "$URL" | grep -iE 'content-security|strict-transport|nosniff|referrer|permissions|frame-options|cache-control'
curl -sI "${URL}.git/config" | head -1                 # 404
curl -sI "${URL}_headers" | head -1                    # 404
curl -sI "${URL}lib/settings.js" | head -1             # 404: not part of the site
curl -s  "${URL}no/such/page" | grep -c 'Page not found'   # 1
curl -s  "${URL}api/config"                            # {"auth":{"google":false},...} until the API's keys are set
```

Then open the site, pick an image and a saved page, and check the console shows no `Content Security Policy` line. Problems are reported as `SECURITY.md` says; `/.well-known/security.txt` carries the same route, and its `Expires` date (8 October 2027) needs renewing before then — the website test fails once it has passed.

### Sign in and "Support this app"

The website can offer Sign in with Google and one product, "Support this app": a one-time payment through Stripe Checkout that unlocks nothing, so the checker and the extension stay the same for everyone. The extension has no part in it: it never calls the API, and its manifest gained no permission and no host for it (`test/website.test.js` reads every extension file and the manifest for that, and `test/e2e/run.js` checks the fixture site is never asked for `api/`).

It is off until the owner supplies keys. The backend is `server/kit/`, the kit every app of this account carries, copied byte for byte but for its eight `.d.ts` type declarations, and never edited here (`server/kit/README.md` is its guide and the owner's checklist), with this site's catalogue, `server/catalogue.js`. The declarations are types for the apps written in TypeScript and nothing here reads them; the shared conventions test counts a tracked `.d.ts` as a TypeScript source and would then require a type checker, a lockfile and development dependencies, which this repository does not have. They come back once that test stops counting declaration files. It runs only where the host runs it, on the site's own origin under `api/`:

- **Cloudflare Pages** (the reference host): `functions/api/[[path]].js` is the entry, and `--host=cloudflare` writes `_routes.json` (`{"version":1,"include":["/api/*"],"exclude":[]}`, with the base path in front when there is one) so no static file invokes the function. Bind a KV namespace as `KIT_STORE` and set the variables below as encrypted environment variables. Cloudflare's documentation says `_headers` is not applied to a Function's responses (the kit sends its own headers) and `_redirects` is not applied to requests a Function serves. A site under a sub-path moves the entry to `functions/<path>/api/[[path]].js`.
- **A server of your own**: `KIT_DATA_DIR=/var/lib/selfreportle-api node server/start.mjs` (127.0.0.1:8788; one process per data directory, run as its own user), behind `deploy/nginx.conf`'s `location ^~ /api/`. That location's one header is HSTS: a location with an `add_header` of its own inherits none of the server block's, so the site's policy, `Cache-Control` and `Referrer-Policy` are not sent beside the API's own. With the process not running, nginx answers `/api/` as a site with no API does (`location @api-off`: the folder's `api/config`, "nothing on", and the not-found page everywhere else, each with the site's headers), where it used to send its own 502 page with HSTS alone; the page then draws nothing. A server that never runs the API can delete that location and `@api-off`, and the allowlist then serves the folder's `api/config`. Apache cannot proxy from `.htaccess`; once the process runs, in the virtual host, with `mod_proxy` and `mod_proxy_http`, add `ProxyPass "/api/" "http://127.0.0.1:8788/api/"` and, inside `<Location "/api/">`, `Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"`, since a proxied answer never reads the folder's `.htaccess` (with the `ProxyPass` and no process, Apache answers 503). `test/e2e/hosts.js` runs the API behind both, and stops it.
- **GitHub Pages, Netlify**: no function runs. The page asks `api/config`, the site's own copy answers "nothing on", and nothing is drawn.

The variables live in the host's environment, never in the repository or the page: `APP_URL` (the site's https address, with a trailing slash), `SESSION_SECRET`, `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (a Google OAuth client of type Web application whose redirect URI is `APP_URL` + `api/auth/google/callback`), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (for the endpoint `APP_URL` + `api/webhooks/stripe`) and `STRIPE_PRICE_SUPPORTER`. Sign-in needs the first four; the shop needs sign-in, the two Stripe keys and the price.

Where it is on, `web/account.js` adds an "Account and support" section below the checker: Sign in with Google; then "Signed in as …", Sign out and Delete account (asked first); and "Support this app" at its Stripe price, with Buy, Sign in to buy or Owned. Buy follows only an address on `https://checkout.stripe.com`. A purchase is granted only by Stripe's signed webhook, and after Checkout sends a signed-in visitor back the page asks `api/me` up to five times over fifteen seconds. Until `api/me` reports the purchase, the product reads "Payment received — processing" where Buy was: for the life of the page, and across a reload within ten minutes through one record in the tab's `sessionStorage` (`selfreportle.purchasePending.v1`: when Checkout sent the tab back), which goes once the purchase is reported or the visitor signs out or deletes the account. The kit this site carries makes a new Checkout Session for every press of Buy until the webhook records the purchase, so a second Buy there was a second payment; two tabs can still do that, until the kit refuses a second Checkout itself. A `?purchase=success` address opened by someone who is not signed in says nothing and asks nothing more. The page asks `api/me` once on every load, signed in or not, and takes the kit's flags (`?signin=failed`, `?purchase=success`, `?purchase=cancelled`) out of the address on arrival, on every host, before it knows whether the site has an API. "Owned" gates nothing, so a visitor who edits the page can show it to themselves; the server's record is what a purchase is, and the page thanks a supporter for supporting Selfreportle. The privacy line above the checker then says exactly what leaves the device: nothing, unless the visitor signs in or buys; then Google tells the site an account id and an email address, and Stripe handles the payment and is told that account id with it. The site keeps the account id, what was bought and Stripe's customer id, and the email while the visitor is signed in. Deleting the account deletes all of that here but a count of the hour's Buy presses, which names the account id and expires within two hours (so deleting is no way round the limit on them); the payment itself stays with Stripe, with the account id it was made under.

**One origin for the site.** The session is a `__Host-` cookie, so every page on the origin can act as the signed-in visitor through `api/`. Serve the site with its API from an origin of its own (a custom domain), never beside other apps on a shared one such as a GitHub Pages project site.

## Development

```
npm test                   # unit tests (Node 22, no dependencies), the website's API included, and the API kit's own self-test
npm run lint               # syntax check of every script
npm run test:conventions   # the conventions shared with the sibling repositories
npm run check              # lint, unit tests and conventions: the gate before a push
npm run test:e2e           # asks the pinned Playwright for a Chromium build on CI's runner, loads the extension into
                           # Chromium via Playwright and checks a fixture site, then the website, then the website's
                           # nginx and Apache configs in the servers installed here
node test/e2e/text-display.js       # text rendering + settings component checks in Chromium
node test/e2e/detection-research.js # detector, source-linked reports + popup component checks
npm run test:all           # unit and end-to-end suites together
npm run icons              # regenerate icons/*.png
npm run build:site -- <folder> [--host=…] [--base=…]   # the website (see "The website")
```

The end-to-end run needs `playwright` resolvable (locally or globally) and a Chromium build; set `PW_CHROMIUM=/path/to/chrome` to pin the binary. It starts with `test/e2e/runner.js`, which asks the Playwright CI pins (`playwright@1.56.1` in `ci.yml`), through its own `install --dry-run`, whether it has a Chromium build for the Ubuntu release CI's check job names (`ubuntu-24.04`, not `ubuntu-latest`, which becomes 26.04 from 2026-10-19, where 1.56.1 has none); where another Playwright resolves it says so and passes, unless `CI` is set. The extension's run follows. Then `test/e2e/site.js` builds the website, serves it at `/selfreportle/` with the headers `web/_headers` writes, and drives the checker under that policy: every kind of file, a hostile saved page, the not-found page two folders deep, a framing attempt from another origin, JavaScript off, a module that fails to load, `account.js` failing to load, and the same site from a host that sends no headers. Then the API: absent (the site's `api/config`, and a host where it is a 404), where no account and no shop are drawn; and the kit mounted at the site's `api/` with a fake Google and a fake Stripe injected through its `fetch`, where it signs in, buys, sees "Payment received — processing" in place of Buy until Stripe's signed webhook lands, draws "Owned" and the thank-you, signs out, deletes the account, opens a `?purchase=success` address signed out (nothing said, nothing more asked) and reads a forged callback. Google's and Stripe's pages are answered inside the browser through the DevTools protocol's Fetch domain, because Playwright's `page.route` does not see the hop a redirect makes. It fails on any policy violation, page or console error, Permissions-Policy complaint, or request outside the site but those two navigations. Last, `test/e2e/hosts.js` loads `deploy/nginx.conf` into the nginx installed on the machine and the built site's `.htaccess` into its Apache, with the repository's files planted beside the site, and checks every path's status and headers there, Apache behind a TLS-terminating proxy and Apache without `mod_rewrite` and `mod_headers` included, and the API behind nginx's proxy and an Apache `ProxyPass`, then the same with the API stopped; where either server is missing it says so and passes, unless `CI` is set. CI (`.github/workflows/ci.yml`) runs the lint, the unit suite, the conventions test and the end-to-end suite on every push.

## Project layout

```
manifest.json               MV3 manifest
lib/model-catalog.js        model/vendor metadata, disclosure names, documented output delimiters
lib/research.js             cited LLM-writing studies and vocabulary families
lib/signals.js              pattern catalogue (tools, builders, disclosures, lexicon, hosts)
lib/lexicons.js             per-language disclosure phrasing, LLM wording, language detection
lib/text-analyzer.js        text signals
lib/text-display.js         optional paragraph emphasis (CSS Custom Highlight API and font levels)
lib/site-analyzer.js        site/code signals (works on a serialisable DOM snapshot)
lib/image-hints.js          DOM-side image hints (captions, hosts, file names)
lib/attribution.js          vendor/product profiles, attribution rules, documented skews
lib/platform-labels.js      AI labels applied by Instagram, TikTok, YouTube, LinkedIn, Pinterest, X
lib/history.js              local-only per-domain counters
lib/legitimacy.js           trader identification, policies, identifiers, pressure patterns
lib/image-metadata.js       JPEG/PNG/WebP/ISOBMFF parsing: EXIF, XMP, PNG text, C2PA/JUMBF
lib/cbor.js                 minimal CBOR codec for C2PA claims and COSE
lib/x509.js                 minimal DER / X.509 reader for signing certificates
lib/c2pa-verify.js          COSE signature, assertion hashes, chain and hard-binding checks
lib/verdicts.js             verdict vocabularies, colours, combination and overall rules
lib/settings.js             every storage key, defaults, validation on read, the migration
lib/fetch-policy.js         which URLs the worker may fetch for a page, and how they are cached
lib/byte-budget.js          reads a fetched body or a page's own bytes up to a cap, and no further
background/service-worker.js  fetches image bytes cross-origin, caches, stores per-tab results, badge
content/content.js          orchestrates the analyses on the page and reports results
content/overlay.js          shadow-DOM pill, panel, badges and popovers
popup/                      toolbar report
publisher/                  self-check for site owners: readiness checklist and snippets
options/                    settings page
web/                        the website: the checker page (index.html, app.js), its safety net (guard.js),
                            the account and "Support this app" (account.js), stylesheet, not-found page,
                            robots.txt, security.txt, api/config (the API's "nothing on") and the host
                            configs (_headers, _redirects, _routes.json, .htaccess)
server/kit/                 the website's optional API: sign in with Google, Stripe Checkout and its webhook
                            (the shared kit, copied verbatim but for its .d.ts files; its README is the owner's guide)
server/catalogue.js         what the website sells: "Support this app"
server/start.mjs            the API on 127.0.0.1:8788 for a server of your own
functions/api/[[path]].js   the API on Cloudflare Pages
deploy/nginx.conf           the website's nginx server blocks, and the proxy to the API
scripts/build-site.js       writes the website into a folder, with the config the host reads
test/                       node:test suites with synthetic JPEG/PNG/WebP/C2PA fixtures; the website's API
                            (api.test.mjs, with a fake Google and Stripe in api-fakes.mjs) and account.js; CI's
                            runner (ci.test.js)
test/fixtures/chat/         three replies from Claude and Gemini, verbatim, that chat-reply.test.js holds flagged
test/e2e/                   the runner CI names, asked of the Playwright it pins (runner.js); Playwright runs: the
                            extension against a fixture site (run.js), and the website (site.js); and the website's
                            nginx and Apache configs in real servers (hosts.js)
```

Every `lib/*.js` file is a plain script in the extension and a CommonJS module under Node, so the analysers are unit-tested with synthetic fixtures (`test/helpers.js` builds PNG chunks, TIFF/EXIF blocks, XMP packets, JUMBF boxes and CBOR claims from scratch).

## Robustness

The analysers are regular expressions run over whatever a page happens to contain, on the page's own thread. A pattern that backtracks quadratically is therefore a denial of service any site can trigger: one long run of the wrong character freezes the tab. Three shipped that way and were found by fuzzing — an unbounded compound-street prefix, an unbounded e-mail local part, and an unbounded word class in the three-item-list detector. Each was quadratic; at the 300 KB body-text cap the street one would have hung a tab for minutes. Nine more passed that guard, because each opens with a token of its own that no generic input contains: an unclosed ChatGPT citation marker (`【1†`; 300 KB cost the text analyser 42 s), blank lines before a Markdown heading or bullet, a JSON-LD `"creator": {` that never closes (8 s per page), an EXIF UserComment of Stable Diffusion `Steps:` lines that never name a sampler, and tool names (`freepik`, `photoshop`, `canva`, `adobe express`) followed by everything but the word that completes them — 64 s for one 256 KB C2PA claim generator in the worker every tab shares. Each gap is now bounded, or stops at the next opener.

`test/redos.test.js` is the permanent guard. It scans every regex literal in `lib/` and in the website's `web/` scripts, runs each against nineteen input shapes designed to make a backtracking engine work hard, at 2 KB and again at 16 KB, and fails if any pattern exceeds a flat budget or grows superlinearly. It then derives shapes from each pattern itself — it parses the pattern, walks every alternative, and repeats the text up to each unbounded repetition, or the whole match less its last character — and runs those at 4 KB and 64 KB, where linear patterns measured at most 77x and a quadratic one is 256x. A second test runs the whole text, legitimacy and site analysers over 300 KB bodies of hostile input and requires each to finish in under four seconds, and the image parser, structured data and alt text are held to the same through their own entry points, which is how patterns built with `new RegExp` are covered.

The binary parsers were fuzzed separately with random bytes behind each container magic, a truncation sweep over every byte offset of valid files, and crafted structures: huge declared chunk lengths, zero-length box loops, six-hundred-deep nesting, twenty thousand empty JPEG segments, a TIFF claiming four hundred oversized entries, and an XML bomb. Nothing threw, and the slowest case was 20 ms.

## Permissions, and why each is needed

| Permission | Why |
| --- | --- |
| `storage` | Settings (sync), per-tab results (session), and the local per-domain counters. |
| `contextMenus` | The right-click entries for inspecting one image or a text selection. |
| `<all_urls>` host access | Reading image, video and audio bytes to find embedded provenance. Those files live on whatever hosts the page uses, and a cross-origin fetch is the only way to reach them. Fetches omit credentials and are size-capped. Only a URL the page's own loader already fetched successfully is handed over, so the browser has already applied mixed-content blocking, the page's CSP and Private Network Access to that exact request; where the bytes can be re-read from the browser's cache, those are the bytes inspected, which costs no traffic and sends no cookies; before a credential in them may speak for the picture they are also decoded and matched against the element itself, since a page can replace its own cache entry after an image has been decoded. Fetches are also refused when the target sits on a more private network than the page itself — a page on the public internet cannot have the extension read `127.0.0.1`, `10.0.0.0/8`, `169.254.169.254`, a NAT64/6to4/Teredo literal carrying one of those inside it, or a `.local`, `.lan` or single-label name on the reader's behalf. That test reads the URL and cannot resolve DNS, so a public name whose owner points it at a private address is caught by the already-loaded rule above, not by this one. A `file:` resource is read only for a page that is itself a local file, and a page on a `.local` name is ranked where it actually sits, on the LAN, not in the loopback tier. Nor is a redirect followed for such a page, since where it leads cannot be checked before it is taken: an image behind a redirect is reported as not fetched. |

The extension has no `tabs` permission, no analytics, no remote code and no
`externally_connectable`, so a web page cannot talk to it. It never talks to the
website's API either: sign-in and the shop are the website's alone. All rendering uses
`textContent`, never `innerHTML`, so page-derived strings cannot become markup.
The in-page interface lives in a closed shadow root and does not modify the
page's own DOM, except for one attribute on flagged text blocks that draws
their marker.

## Privacy

* No analytics, no remote calls to the author. The extension never signs anyone in and sells nothing.
* The website reads the picked file in the page and never uploads it. Once loaded, it asks its own site only whether sign-in is offered (`api/config`) and, where it is, who is signed in (`api/me`). Where the site runs its API, nothing more leaves the device unless the visitor signs in or buys: then Google tells the site an account id and an email address, and Stripe handles the payment and is told that account id with it; the site keeps the account id, what was bought and Stripe's customer id, and the email while the visitor is signed in. Delete account removes all of it from the site but a count of the hour's Buy presses, which names the account id and expires within two hours; the payment stays with Stripe. While a payment is on its way, the tab keeps one record of when Checkout sent it back, in its own `sessionStorage`, which ends with the tab and is not read after ten minutes.
* Image bytes are read from the browser's own cache where possible, making no request at all; otherwise fetched from the page's own sources with `credentials: 'omit'`, limited to the first few MB (configurable), and cached in memory only. One tab's fetches are budgeted (requests and bytes per minute), so a page cannot use the extension as an unmetered request generator.
* Results are kept in `chrome.storage.session` per tab and discarded when the tab closes.
* Hosts can be excluded in the settings.
* Domain memory holds counters per hostname, never URLs or page content, on this device only. Its timestamps are kept only to the day, records expire after 90 days, and it is capped, clearable and can be switched off.
