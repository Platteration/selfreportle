# selfreportle — security audit (2026-09-11)

A dedicated security pass, separate from and later than the review in `REVIEW.md`. Specialist reviewers read the repository through 3 independent lenses (L1, L3, L5), each required to *demonstrate* a finding rather than argue for it.

**12 findings** — 5 high, 4 medium, 3 low. Every one was reproduced with command output rather than argued from reading.

## Status

Every finding below was fixed on `claude/repo-review-security-baiyud` in 260a1af, each with a regression test that was checked by reverting the fix and confirming the test fails. The findings are kept as written so the reasoning behind each change stays with it.

These were deliberately left for a decision rather than guessed at:

- L5-1 — which roots go in the trust list. The mechanism is built and shipped empty, so no manifest earns the camera badge until it is filled. Choosing a root store, a way to import one, and a way to update it is a product and distribution decision.
- L3-1 — adding the webRequest permission to check the address a fetch actually landed on. That is a new manifest permission with Chrome Web Store review consequences.
- L5-3 — keying the image cache on a digest of the fetched body. Page-supplied bytes bypass the cache already, so it can no longer produce a positive badge; digest-keying would require fetching before the lookup, defeating the cache.

## Findings

### L1-1 · high — PNG zTXt/iTXt decompression bomb: unbounded inflate in the shared service worker exhausts memory and kills the worker

`lib/image-metadata.js`:782 · CWE-409 · reproduced

**Who.** Any web page the user browses to (host_permissions <all_urls>, content script on every http/https/file page). The attacker controls the bytes of any image the page references; the content script harvests img/video src and hands them to the privileged service worker, which fetches up to maxImageBytes (default 4 MB, clamp ceiling 32 MB) and parses them.

**How.** 1. Serve a valid 1x1 PNG whose tEXt is replaced by a zTXt (or iTXt) chunk carrying a highly compressible zlib stream: ~512 KB of deflate that inflates to ~536 MB (ratio >1000:1); at the 4 MB fetch cap the same payload inflates to multiple GB. 2. Put it in an <img width=100 height=100> so it clears minImageSize and is fetched. 3. parsePng reaches the zTXt/iTXt branch and calls inflate(data) (lib/image-metadata.js:171 / :183), which has no output-size ceiling: it streams the whole thing into a single Uint8Array via DecompressionStream in the browser (zlib.inflateSync under Node). 4. CONCURRENCY=4 means four such images decompress at once; the content script re-runs on every SPA navigation and mutation, so the page can retrigger indefinitely.

**Why it matters.** Memory exhaustion of the extension's single service worker, which holds the only privileged capabilities and the per-tab results/badge state. Chrome kills the worker on OOM, dropping in-flight analyses for every tab, and the page can keep it dying on each navigation — a durable, page-triggered denial of the extension's core function. Only the extension is affected (not the host page's data), but for a provenance/AI-detection tool that is a security-relevant outage that a hostile site can invoke at will to stop itself being inspected.

**Evidence.**

lib/image-metadata.js:170-172  const inflated = await inflate(data.subarray(z + 2)); if (inflated) text[...] = latin1.decode(inflated);
lib/image-metadata.js:782-795  async function inflate(bytes){ ... new DecompressionStream('deflate') ... new Response(ds.readable).arrayBuffer() ... zlib.inflateSync(...) }  // no maxOutput anywhere
No output cap exists (grep 'maxOutput|max.*inflate' returns nothing). Reproduced with the real module:
  $ node png-bomb.js 512  ->  'deflated zTXt payload: 521833 bytes; inflates to 536870912 bytes (ratio 1029:1)'  'parse took 10932 ms'  'rss before/after MB: 599 -> 1707'  (a 512 KB PNG drove a ~1.1 GB RSS spike). A multi-chunk variant (64 zTXt chunks, wire 1021 KB) reached 'peak RSS MB 1239' and 52 s. Neither the ReDoS literal scanner nor the whole-page performance test in test/redos.test.js exercises image-metadata.js, so this is uncaught.

**Fix.** Cap decompression output. Pass a maximum (e.g. maxImageBytes, or a fixed few-MB ceiling) into inflate(); under DecompressionStream, read the readable with a reader and abort/cancel once accumulated bytes exceed the cap (as fetchBytes already does for the network stream); under Node use inflateSync with the maxOutputLength option. Treat an over-cap stream as a note ('compressed metadata too large to inspect'), not a hard failure. Also cap the total inflated text kept across all PNG chunks per image.


### L1-2 · high — Quadratic XMP parsing freezes the shared service worker on an attacker-supplied XMP packet (WebP/JPEG/PNG), outside the ReDoS guard

`lib/image-metadata.js`:366 · CWE-1333 · reproduced

**Who.** Any web page the user browses to. The attacker controls the bytes of a referenced image; the worker fetches up to maxImageBytes (default 4 MB) and hands the embedded XMP packet to parseXmp with no length bound on the dedicated-chunk paths.

**How.** 1. Serve a valid tiny image whose XMP packet is a long run of unclosed elements, e.g. a WebP with an 'XMP ' chunk of '<CreatorTool>' repeated ~80k times (~1 MB). 2. parseWebp decodes the whole chunk and calls parseXmp(utf8.decode(data)) (lib/image-metadata.js:210); the same is reachable via JPEG APP1 xap (:117), JPEG reassembled extended-XMP 'joined' (:138), and PNG iTXt 'XML:com.adobe.xmp' (:198) — none of these caps the string (only the generic scanForXmp fallback caps at 200 KB). 3. parseXmp calls xmpValue for each field; xmpValue builds the element regex `<(?:[\w-]+:)?LOCAL\b([^>]*)>([\s\S]*?)</(?:[\w-]+:)?LOCAL>` with new RegExp (:366) and runs .exec against the whole packet. With no matching close tag the lazy `[\s\S]*?` rescans to end from every one of the N opening positions — O(N²). Because the regex is built dynamically it is invisible to test/redos.test.js's literal scanner, and that suite's whole-page timing test only loads text-analyzer/legitimacy/site-analyzer, never image-metadata.js.

**Why it matters.** Tens of seconds of synchronous main-thread work in the shared service worker per hostile image (measured ~29 s for 1 MB; at the 4 MB fetch cap this exceeds Chrome's ~30 s worker watchdog, so the worker is terminated). CONCURRENCY=4 multiplies it and the content script retriggers on navigation/mutation, so any site can keep the extension's privileged worker frozen or repeatedly killed, blocking image analysis and the runtime message handlers browser-wide. A lesser, 256 KB-capped variant exists in parseSvg's comment scan (`/<!--([\s\S]*?)-->/g`, :297) — ~10 s worst case.

**Evidence.**

lib/image-metadata.js:210  else if (type === 'XMP ') meta.xmp = parseXmp(utf8.decode(data));   // data = whole chunk, up to the 4 MB fetch cap
lib/image-metadata.js:366  const el = new RegExp('<(?:[\\w-]+:)?' + local + '\\b([^>]*)>([\\s\\S]*?)</(?:[\\w-]+:)?' + local + '>', 'i').exec(xml);
test/redos.test.js:134-136 the whole-page guard loads only text-analyzer, legitimacy, site-analyzer.
Reproduced end to end through analyzeImageBytes on a real WebP:
  128 KB XMP -> 383 ms ; 256 KB -> 1562 ms ; 512 KB -> 5959 ms ; 1024 KB -> 29070 ms   (clean quadratic growth; a doubling of input roughly quadruples the time).

**Fix.** Bound the XMP string before parsing (cap every parseXmp caller the way scanForXmp already caps its fallback — e.g. slice to 128–256 KB) and rewrite xmpValue's element extraction to be linear: match against a bounded body (`[^<]{0,N}` or a possessive/atomic-style construction) instead of `([\s\S]*?)</...>`, or extract the element with an indexOf-bounded substring rather than a backtracking regex. Add image-metadata.js to test/redos.test.js's whole-page timing guard with a hostile XMP packet (and a hostile SVG comment run) as fixtures, since its dynamically-built regexes escape the literal scanner.


### L5-1 · high — A self-signed certificate is enough to earn the green "verified · camera capture" badge and the page-level provenance tick

`lib/image-metadata.js`:666 · CWE-295 · reproduced

**Who.** Any web page the reader visits. The page controls the bytes of every image, video and audio file it serves, and the extension fetches and inspects them automatically.

**How.** 1. Generate a P-256 key pair and self-sign one X.509 certificate whose subject CN is any name you like ("Leica Camera AG", "Canon Inc.", "Reuters"). 2. Build a C2PA manifest over an AI-generated picture: a c2pa.actions.v2 assertion carrying {action: c2pa.created, digitalSourceType: .../digitalCapture}, a c2pa.hash.data assertion whose digest is honestly computed over the file with the credential store excluded, a claim listing both assertion hashes, and a COSE_Sign1 over the claim signed with that key, with the self-signed certificate in the x5chain header. 3. Embed the store in the PNG caBX chunk (or JPEG APP11) and serve the file. No trust list exists to check the certificate against, so every question the verifier asks is answered yes.

**Why it matters.** verifyManifest returns signature valid, all assertions matched, binding valid; summarize() returns ok:true; deriveSignals sets proven=true and emits the hard verdict "captured"; combineImageSignals makes the image "Camera-capture provenance" (green, glyph ●); verdicts.overall makes the whole page "provenance" and service-worker.js:147 puts a green ✓ on the toolbar; popup verificationRow prints "Verified and bound to this file" with "Certificate subject: CN=Leica Camera AG" and the sentence "these credentials are about this image and not another one". The README gates exculpatory claims behind verification on the reasoning that "forging it costs nothing: a hand-written JUMBF box with no certificate and no key says digitalCapture just as loudly as a signed one" — but forging a fully *verifying* one costs one key generation, so the gate separates nothing. An AI image is presented to the reader as a camera photograph with a cryptographic tick beside it.

**Evidence.**

lib/c2pa-verify.js:377  anchored: false, anchorNote: 'This build ships no C2PA trust list, so the root of the chain is not checked against known signers...'
lib/c2pa-verify.js:563  ok: v.signature === 'valid' && !!b && b.status === 'valid' && !broken && !caution,   // nothing about anchoring
lib/image-metadata.js:666  const proven = !!(vs && vs.ok);
lib/image-metadata.js:673  if (proven) push({ id: 'c2pa-capture', hard: true, verdict: 'captured', strength: capture.strength, ... });
lib/verdicts.js:112  else if (pick('captured').length) best = { verdict: 'captured', ... };
lib/verdicts.js:146  if (counts.captured > 0 || counts['human-created'] > 0 || ...) return 'provenance';
popup/popup.js:491  'The manifest has not been altered since it was signed, and the digest it records over the file matches this file's bytes, so these credentials are about this image and not another one.'

$ node e1_selfsigned.js
signature         : valid ES256
binding           : valid | The digest the claim records over the file matches these bytes (69 of 1469 hashed, the credential store excluded).
assertions        : 2/2 convention whole JUMBF box
chain.linked      : null  timeValid: true  anchored: false
signedBy          : {"cn":"Leica Camera AG","o":"Leica Camera AG","subject":"CN=Leica Camera AG, O=Leica Camera AG","issuer":"CN=Leica Camera AG, O=Leica Camera AG"}
summary           : {"ok":true,"broken":false,"caution":false,...,"text":"Signature valid (ES256) · all 2 assertions match the signed claim · bound to this file's bytes · root not anchored to a trust list"}
signals           :
    c2pa-verified | hard=false | verdict=no-signal | Content Credentials signature verified and bound to this file
    c2pa-capture | hard=true | verdict=captured | Content Credentials: Original digital capture (camera)
image verdict     : {"verdict":"captured","score":0.9} -> Camera-capture provenance #0b7a5b
page verdict      : provenance -> {"label":"Provenance credentials present, no AI signals","color":"#0b7a5b","icon":"●"}

The same run with a certificate that expired 300 days ago also returns ok:true and the captured verdict (chain.timeValid=false is computed and then ignored by summarize; that half is REVIEW.md SEC-5, still open):
$ node e7_misc.js
(a) expired cert  : timeValid= false expired= ["Leica Camera AG"] ok= true verdict= captured

**Fix.** Stop letting an unanchored signature promote an exculpatory claim. Concretely: (a) add chain.anchored to the pass condition — in lib/image-metadata.js deriveSignals set `const proven = !!(vs && vs.ok && v.chain && v.chain.anchored)`, so c2pa-capture / c2pa-human / c2pa-algo / c2pa-capture-device keep taking the existing `unproven(...)` path (non-hard, verdict no-signal) until a root is anchored; (b) ship the C2PA conformance trust bundle plus a user-importable anchor list and set chain.anchored by matching a SHA-256 of each chain certificate DER, which is the upgrade REVIEW.md already lists; (c) until that ships, change the popup badge word from "Verified and bound to this file" to "Signed by an unverified signer, bound to this file" and drop the sentence "these credentials are about this image and not another one" in favour of one that names the signer as unvouched; (d) do not let counts.captured alone produce the page-level "provenance" verdict or the green toolbar ✓.


### L5-2 · high — The exclusion-containment rule is checked against a credential-store range the attacker declares, so a hard binding can hash 41 of 1728 bytes and still report "bound to this file's bytes"

`lib/image-metadata.js`:193 · CWE-345 · reproduced

**Who.** Any web page the reader visits, serving an image it authored.

**How.** 1. Put the JUMBF credential store in a container box that an image decoder skips but that sits *before* the pixel data — a private ancillary PNG chunk (prVt) between IHDR and IDAT, or a JPEG COM segment straight after SOI. The picture still decodes and displays normally. 2. Overwrite the outer `jumb` box's own four-byte length field with 0xFFFFFFF0. Nothing hashes or signs that field: the claim hashes the assertion boxes, the signature covers the claim, and the store box header is outside both. 3. image-metadata.js does not find a native caBX/C2PA/APP11 store, falls back to scanForJumbf (line 61), parseJumbfBoxes clamps the box end to the end of the file (line 418: `bodyEnd = Math.min(p + len, end)`), and meta.c2paRanges is set to {start: storeStart, end: file length} (line 62) — the reader now believes the credential store is everything from that chunk to EOF. 4. Declare the c2pa.hash.data exclusion as exactly that range. checkHardBinding's containment test (c2pa-verify.js:258) passes because the declared store swallows the picture, and the digest is computed over only the bytes before the store.

**Why it matters.** The fourth check — the one the previous audit added specifically so a manifest could not be lifted onto another picture (REVIEW.md SEC-4) — is reduced to a digest over the file header. The verifier reports binding "valid" and summarize() reports ok:true with the text "bound to this file's bytes"; the popup shows the green "Verified and bound to this file" tag; and the identical manifest bytes validate unchanged over completely different pixel data (demonstrated for both PNG and JPEG). One manifest can therefore be minted once and pasted in front of any number of different pictures, each of which is then badged "Camera-capture provenance". The bindingNote that gives the game away ("41 of 1728 hashed") is inside a collapsed <details> and is never used by the pass/fail logic.

**Evidence.**

The store extent comes from declared length fields, none of which is covered by a hash or a signature:
lib/image-metadata.js:193  if (c2pa) { meta.c2pa = c2pa; meta.c2paRanges = [{ start: p, end: Math.min(p + 12 + len, b.length) }]; }   // PNG caBX declared chunk length
lib/image-metadata.js:213  ... meta.c2paRanges = [{ start: p, end: Math.min(p + 8 + len + (len & 1), b.length) }];                  // WebP chunk length
lib/image-metadata.js:262  ... meta.c2paRanges = [{ start: p, end: bodyEnd }];                                                     // ISOBMFF uuid box length
lib/image-metadata.js:128  entry.push({ z, body: seg.subarray(8), start: p, end: p + 2 + len });                                   // JPEG APP11, end not even clamped to the file
lib/image-metadata.js:62   if (j) { const c = extractC2pa(j); if (c) { meta.c2pa = c; meta.c2paRanges = [{ start: j[0].start, end: j[0].end }]; } }   // generic scan: the outer JUMBF box's own length
lib/image-metadata.js:418  const bodyEnd = Math.min(p + len, end);
lib/c2pa-verify.js:258  if (!ranges.every((r) => store.some((s) => r.start >= s.start && r.end <= s.end))) { return unchecked(box, 'The hard binding excludes bytes outside the credential store itself...'); }
README.md:22  '...those ranges are refused unless they fall inside the credential store, because a claim that excludes the picture itself is hashing nothing.'

$ node e2b_png.js      # PNG that a decoder renders normally: store in a private ancillary chunk between IHDR and IDAT
format            : png  file length: 1728
binding           : valid | The digest the claim records over the file matches these bytes (41 of 1728 hashed, the credential store excluded).
summary.ok        : true
image verdict     : captured

-- same manifest over different pixels (same size) --
binding           : valid
summary.ok        : true
image verdict     : captured

$ node e2_store_range.js   # the same trick in a JPEG, store hidden in a COM segment after SOI
file length       : 5464  declared store: [{"start":6,"length":5458}]
format            : jpeg
binding           : valid | The digest the claim records over the file matches these bytes (6 of 5464 hashed, the credential store excluded).
summary.ok        : true | text: Signature valid (ES256) · all 2 assertions match the signed claim · bound to this file's bytes · root not anchored to a trust list
image verdict     : captured -> Camera-capture provenance

--- same manifest, different picture, nothing recomputed ---
file length       : 5464
binding           : valid | The digest the claim records over the file matches these bytes (6 of 5464 hashed, the credential store excluded).
summary.ok        : true
image verdict     : captured

**Fix.** Do not let a declared length define the credential store. (1) In lib/image-metadata.js, derive each c2paRanges entry from what actually parsed rather than from the header field: for the generic scanForJumbf path use the extent of the boxes that really decoded (sum of the child boxes that parsed cleanly), and for PNG/WebP/ISOBMFF refuse the store outright when the declared chunk/box length runs past the end of the file instead of clamping it; for JPEG clamp `end` to b.length at line 128. (2) In lib/c2pa-verify.js checkHardBinding, tighten the rule from "contained in the store" to "equal to the store, after merging" — a producer excludes the whole store, not part of it — and additionally return `unchecked` when the bytes actually hashed are not the overwhelming majority of the file (for example when asset.length - kept.length exceeds the size of the store the reader located, or when kept.length < asset.length/2). (3) Surface `hashed`/`asset.length` in the badge line, not only in the collapsed detail, so a binding over 41 of 1728 bytes cannot read as a plain green tick. Add regression fixtures for each container that inflate the declared length and assert `unchecked`.


### L5-3 · high — What is verified is not what is displayed: the worker re-fetches the URL without credentials, so a server can hand the reader an AI image and the extension a signed photograph

`background/service-worker.js`:298 · CWE-367 · reproduced

**Who.** Any web page the reader visits, serving its own images from its own origin (or any origin it controls).

**How.** 1. The page renders <img src="/photo.png">. The browser fetches it as a normal subresource: no Range header, the site's cookies, Referer and Sec-Fetch-Dest: image. The server returns the AI-generated picture. 2. content.js collects the element and posts {id, url} to the worker; analyzeOne calls fetchBytes, which issues a *second*, independent request to the same URL with `credentials: 'omit'` and `Range: bytes=0-<cap>` (service-worker.js:297-298). Any of those differences — no Cookie, a Range header, no Referer, Sec-Fetch-Site: none — tells the two requests apart. The server returns a different file: a genuinely signed, honestly hard-bound photograph. 3. The extension verifies that second file and applies the verdict to the element it never saw, at content.js:511 (`upsertMarker({ key: st.key, el: st.el, ... })`).

**Why it matters.** A green ● "Camera-capture provenance" badge, the popup's "Verified and bound to this file", and the page-level provenance ✓ are all attached to a picture whose bytes were never hashed. The hard binding, which is the check that is supposed to answer "does the manifest describe *this* file", answers it about a file only the extension ever saw. This works with an entirely honest manifest, so it also survives fix L5-1: even with a trust list and a real Leica certificate, the reader is shown a different picture from the one the credentials cover. The result is also cached across tabs and origins for the life of the worker (service-worker.js:192-221, keyed only on the URL), so the false verdict is replayed on later loads of the same URL.

**Evidence.**

background/service-worker.js:297-298
  const headers = /^https?:/i.test(url) ? { Range: 'bytes=0-' + (maxBytes - 1) } : {};
  const res = await fetch(url, { headers, credentials: 'omit', redirect: redirectMode(pageUrl), signal: controller.signal });
content/content.js:429   const url = img.currentSrc || img.src;                 // the element the page already loaded
content/content.js:511   S.overlay.upsertMarker({ key: st.key, el: st.el, kind: 'image', verdict: st.verdict, details });
Nothing anywhere compares the worker's bytes with the bytes the element rendered; the only page-side read is the blob: special case at content/content.js:461-470.
README.md:22 'That digest is recomputed here, over the fetched bytes' — and popup/popup.js:491 turns that into 'these credentials are about this image'.

$ node e4_two_faced.js     # one URL, two responses, same server
same URL, two responses: 146 bytes to the page, 1429 bytes to the extension

what the reader is actually looking at:
   signals: png-sd/ai-generated
   verdict: ai-generated

what the extension verified and badges the picture with:
   signals: c2pa-verified/no-signal, c2pa-capture/captured
   binding: valid
   summary: Signature valid (ES256) · all 2 assertions match the signed claim · bound to this file's bytes · root not anchored to a trust list
   verdict: captured -> Camera-capture provenance
   page   : provenance

**Fix.** Bind the verdict to the bytes the page actually rendered. The content script already fetches blob: URLs in page context (content/content.js:461-470); extend that: for every image to be inspected, fetch the same URL from the page with `credentials: 'include'` and `cache: 'force-cache'` so the browser's own cached response is reused, and hand the worker either those bytes or a SHA-256 of them. Where the page cannot read the body (opaque cross-origin response), the worker's fetch stands, but the result must then be reported as 'credentials verified against a separate fetch of this URL, which may not be the image shown' — a caution, not a provenance badge. Independently, key imageCache on the URL *and* a digest of the fetched body so a second response cannot inherit the first one's verdict, and drop the cache on navigation.


### L3-1 · medium — The fetch policy classifies the URL's text and never the address behind it, so a hostname the page controls that resolves to loopback or RFC1918 walks straight past it

`lib/fetch-policy.js`:146 · CWE-918 · reproduced

**Who.** Any web page the reader visits, controlling only its own markup and one DNS record under a domain it owns. No race, no redirect, no user interaction beyond loading the page.

**How.** 1. Attacker publishes an A record: lo.attacker.example -> 127.0.0.1 (or 192.168.1.1, or 169.254.169.254). 2. The page renders <img src="http://lo.attacker.example:11434/api/tags" style="width:200px;height:200px"> — a size the rendered-box floor of 80px accepts even though the image never loads. 3. content/content.js:429 harvests img.src and content/content.js:479 posts it to the worker as srl:analyze-images. 4. background/service-worker.js:188 calls mayFetch, which parses the URL, finds a name rather than a literal, falls through lib/fetch-policy.js:143-146 and answers 'public'. 5. The worker issues the GET with <all_urls> host permissions, so it is exempt from the page's own mixed-content blocking (an https page cannot make this request itself), its CSP, and Chrome's Private Network Access checks. The OS resolver then sends it to loopback. 6. Repeat with any host:port/path; the same works for .lan, .corp, .intranet and single-label search-domain names, none of which the LOCAL_SUFFIX_RE at line 33 covers.

**Why it matters.** An unauthenticated, credential-less GET to any loopback port and any LAN address on the reader's machine and network, chosen freely by a hostile page, from a context that is exempt from the three browser mechanisms that exist to stop exactly this. There is no read-back to the page (the overlay is a closed shadow root and image verdicts never touch the page DOM), so this is blind SSRF: it reaches GET-triggerable actions on routers, printers, IoT boxes and locally bound developer services, and it lets a page cause requests the browser refuses to let it make. The address-space policy is the security core of this extension, and the whole of it is defeated by one DNS record, which is a more reliable primitive for an attacker than the literal addresses the policy does block.

**Evidence.**

lib/fetch-policy.js:131-146 (addressSpace) — after the IPv6 and IPv4 literal tests, a name that is not localhost/*.localhost/*.local/*.home.arpa/*.internal reaches `return 'public';` at line 146. The file header admits it ("Nothing here resolves DNS — a worker cannot — so a public name that resolves to a private address still gets through. This closes the direct literal-address path, which is the one a page can rely on.") but the stated reason is wrong: a page can rely on its own A record more reliably than on a literal, and README.md:181 tells the reader the opposite — "a page on the public internet cannot have the extension read 127.0.0.1, 10.0.0.0/8, 169.254.169.254 or a .local name on the reader's behalf, HOWEVER THE NAME IS SPELLED".

Ran the real background/service-worker.js (all of lib/ loaded through the real importScripts path) in a vm with chrome and fetch stubbed, and fed it the real srl:analyze-images message:

  refused []
           page=https://evil.example/page  img=http://127.0.0.1:11434/x.jpg
           literal loopback from a public page  | signal: Not fetched — the page is public but this address is local

  FETCHED ["http://lo.evil.example:11434/x.jpg [redirect=manual]"]
           page=https://evil.example/page  img=http://lo.evil.example:11434/x.jpg
           HOSTNAME whose A record is 127.0.0.1

  FETCHED ["http://nas.lan/x.jpg [redirect=manual]"]
  FETCHED ["http://wiki/x.jpg [redirect=manual]"]   (single-label intranet name)

The request is put on the wire with no name resolution and no post-connection check of where it went; redirect:'manual' is irrelevant because no redirect is involved. For completeness I also confirmed the text-canonicalisation half is sound — decimal (2130706433), hex (0x7f000001), octal (0177.0.0.1), 127.1, %31%32%37.0.0.1, fullwidth and circled Unicode spellings, ideographic full stops, IDNA and userinfo@host are all normalised by `new URL` before the policy sees them and are all correctly blocked.

**Fix.** Stop treating an unresolved name as public. Two changes, in order of value: (1) Only hand the worker a URL the page's own loader has already fetched successfully — require img.complete && img.naturalWidth > 0 for images, readyState >= HAVE_METADATA for media, and for <video poster> require the poster to have painted — in content/content.js collectImages/collectMedia. That is the structural fix: the browser has then already applied mixed-content, CSP and Private Network Access to that exact request, so the extension is re-reading something already permitted rather than minting a new capability, and it removes the whole class (name or literal) at once. It also matches what README.md:193 already claims the extension does. (2) For the URLs that remain (context-menu inspection, posters), add the observational webRequest permission — still available in MV3 for non-blocking listeners — register chrome.webRequest.onResponseStarted filtered to the worker's own requests, read details.ip, and if that address is in a more private space than the page then abort the AbortController, discard the bytes, and cache the host as refused for the session. Be honest that this stops the read and the second request, not the first. (3) Add .lan, .intranet, .corp, .private, .internal (already there) and any single-label host to the name suffix list at lib/fetch-policy.js:33, and correct README.md:181 — "however the name is spelled" is not true of a name whose owner chooses what it resolves to.


### L3-4 · medium — No budget anywhere on how much the worker will fetch for one page: the per-page image cap is keyed by DOM element, so rewriting src re-arms it forever

`content/content.js`:456 · CWE-770 · reproduced

**Who.** Any web page the reader visits, or any third-party ad or embed on a page the reader visits.

**How.** 1. The page lays out 60 <img> elements at 200x200 (settings.maxImages default 60, minImageSize 80). 2. A script rewrites every element's src to a fresh attacker-chosen URL. 3. The MutationObserver at content/content.js:602 watches attributeFilter ['src','srcset'] and re-runs processImages 900 ms later; collectImages at content/content.js:431-436 sees prev.url !== url, deletes the element's entry and re-collects it. 4. processImages re-inserts the entry under the SAME Map key (item.el, content/content.js:454), so imageState.size is still 60 and the guard `imageState.size <= settings.maxImages` at line 456 passes again. The cap counts live image elements, not fetches, so it is never consumed. 5. Each cycle the worker issues 60 GETs carrying `Range: bytes=0-4194303`, credentials omitted, to URLs on any hosts the attacker names. Nothing in background/service-worker.js meters the caller: analyzeImages (line 160) caps a single message at 32 images and runs 4 at a time, and there is no per-tab, per-origin, per-minute or per-byte budget of any kind. history.pushState gives a second re-arm path via the once-a-second href poll at content/content.js:50-53, which calls analyze(true) and resets imageState outright.

**Why it matters.** The reader's browser becomes an unmetered, invisible request generator pointed wherever the page likes, using the reader's IP address, reputation and bandwidth: request-flooding a third party from many readers at once, burning a metered or mobile connection, hitting a per-IP rate limit on someone else's API, or click/impression fraud. Nothing in the UI shows it — the badge counts findings, not fetches — and the settings only let the reader turn image fetching off entirely. Combined with L3-1 the same loop delivers unbounded blind requests into the reader's own loopback and LAN. The previous review's SEC-3 recommendation named this half explicitly ("add a per-tab byte budget, and stop resetting the per-page URL counter") and only the address-space half was implemented.

**Evidence.**

content/content.js:454-456
        imageState.set(item.kind === 'poster' ? Symbol('poster:' + item.url) : item.el, st);
        applyImageVerdict(st);
        const fetchable = settings.fetchImages && !/^data:image\/svg/i.test(item.url) && imageState.size <= settings.maxImages;
content/content.js:431-436 (src change deletes the entry and re-queues the element)
content/content.js:602  observer.observe(document.body, { ..., attributes: true, attributeFilter: ['src', 'srcset'] });
content/content.js:50-53 (once-a-second href poll -> analyze(true) -> imageState = new Map())
background/service-worker.js:158-172 (analyzeImages: a 32-per-message slice and CONCURRENCY 4, and nothing else)

Measured against the real worker with a stubbed fetch that streams an endless body, feeding it twenty ordinary srl:analyze-images messages from one tab:

  messages sent        : 20 (one content-script batch each; no rate limit in the worker)
  HTTP requests issued : 640
  bytes read from wire : 2600.0 MB
  requests carrying the default 4 MB Range header: 640

The worker accepted every one. maxImageBytes normalises to a ceiling of 32 MB (lib/settings.js:32), so a reader who raised it multiplies this eightfold.

**Fix.** Bound the aggregate, not the snapshot. In background/service-worker.js keep a per-tab budget keyed on sender.tab.id — a request count and a byte count over a rolling window (e.g. 200 requests and 64 MB per tab per minute) — reset it in the existing chrome.tabs.onUpdated 'loading' handler and the chrome.tabs.onRemoved handler, and answer over-budget items with the existing 'Not fetched' unavailable signal so the failure is visible in the popup. In content/content.js make the per-page cap cumulative: count URLs handed to the worker in a counter that runAnalysis(true) does not reset for a same-document href change, and key the imageState entry on element+url (or keep a separate Set of URLs already submitted) so a src rewrite consumes budget instead of re-arming it. Adopting L3-1's recommendation (only submit URLs the page's own loader already fetched) also caps this naturally, since the browser has then already paid for the bytes.


### L5-4 · medium — A signed claim that references no assertions switches off the "only referenced assertions speak" rule, and still returns ok:true with zero assertions checked

`lib/c2pa-verify.js`:210 · CWE-347 · reproduced

**Who.** Any web page the reader visits, serving an image it authored.

**How.** 1. Build a manifest whose claim carries `assertions: []` — it references nothing at all — and sign it. 2. Put whatever assertion boxes you like in c2pa.assertions: a c2pa.actions.v2 saying digitalCapture, and a c2pa.hash.data whose digest is honestly computed over the file. 3. referencedLabels() returns null because refs.length is 0 (c2pa-verify.js:210), so `allowed` in checkHardBinding is null and every box is admitted, including a hard-binding box the claim never referenced. checkAssertions finds no references, so out.checked stays 0 and rows stays empty — the "none of them could be checked" branch at :475 is gated on out.checked and never runs. summarize() skips the whole assertion clause because `a.checked` is 0 and returns ok:true. image-metadata.js trustedLabels() likewise returns null (no verified labels, referencedAssertions null), so deriveSignals lets every box speak.

**Why it matters.** The second of the four advertised questions ("Do the assertions match the claim?") is silently not asked, and the summary text does not mention assertions at all, so the popup shows a plain green "Verified and bound to this file". The hard binding itself is read from a box that nobody referenced — the exact case the existing regression test at test/c2pa-verify.test.js:384 ("a hard binding the signed claim never referenced is not a binding") asserts must be reported as absent; that test only holds because its claim references *something else*. README rules "Only assertions the signed claim references may speak for the asset" and "A pass requires all four answers" are both false for this shape.

**Evidence.**

lib/c2pa-verify.js:205-211
  function referencedLabels(claim) {
    ...
    return refs.length ? new Set(refs) : null;      // no references is read as 'no basis to restrict'
  }
lib/c2pa-verify.js:221-222  const allowed = verified || referencedLabels(manifest && manifest.claim);
                            const candidates = boxes.filter((b) => HARD_BINDING_RE.test(b.label || '') && (!allowed || allowed.has(baseLabel(b.label))));
lib/c2pa-verify.js:475      if (out.checked && !out.missing.length) { out.inconclusive = true; ... }
lib/c2pa-verify.js:524      if (a && a.checked) { ... }         // the whole assertion clause disappears
lib/image-metadata.js:753-757  function trustedLabels(active) { ... if (active.referencedAssertions) return new Set(...); return null; }
lib/image-metadata.js:493      m.referencedAssertions = refs.length ? refs : null;

$ node e3_noref.js
claim.assertions  : []   (the claim references nothing)
referencedAssertions: null
assertions checked: 0  matched: 0  trusted: []
binding           : valid | from box c2pa.hash.data
summary           : {"ok":true,"broken":false,"caution":false,...,"text":"Signature valid (ES256) · bound to this file's bytes · root not anchored to a trust list"}
signals           : c2pa-verified/no-signal, c2pa-capture/captured(hard)
image verdict     : captured

**Fix.** Make an empty reference list mean 'nothing may speak', not 'no restriction'. In lib/c2pa-verify.js referencedLabels, return `new Set(refs)` unconditionally (an empty Set) whenever the claim is an object, and let checkHardBinding treat an empty allowed-set as admitting no box, so the binding comes out 'absent'. In lib/image-metadata.js trustedLabels, return an empty Set rather than null when the claim carries no referencedAssertions. In summarize(), report caution (not ok) whenever the manifest carries assertion boxes but the claim referenced none — 'the claim names no assertions, so nothing in this manifest is covered by the signature'. Add the case to test/c2pa-verify.test.js beside the existing unreferenced-binding test.


### L5-5 · medium — Two assertion boxes sharing a label: only one is hashed, both are read, and the summary still says "all assertions match the signed claim"

`lib/c2pa-verify.js`:435 · CWE-347 · reproduced

**Who.** Any web page the reader visits, serving an image it authored; and, by extension, anyone who can rewrite a file that already carries a genuine manifest (see the note in impact).

**How.** 1. Take a manifest whose claim references c2pa.actions.v2 and records the hash of the genuine actions box. 2. Insert a second box with the *same* label c2pa.actions.v2 before the genuine one inside c2pa.assertions, containing {action: c2pa.created, digitalSourceType: .../digitalCapture}. 3. checkAssertions builds `boxes` as a Map keyed on the label (c2pa-verify.js:435), so the last box with that label wins and the hash check is performed against the genuine one — it matches, and the label lands in trustedLabels. 4. parseManifest (image-metadata.js:505-536) walks every box in c2pa.assertions and tags each collected action with its own label, so both boxes' actions carry from = "c2pa.actions.v2"; deriveSignals filters with allowed(x.from) (:606-607) and therefore admits both.

**Why it matters.** Content that no hash covers is reported as hash-verified. In the reproduction the signed claim says only "opened in Some Editor", yet the reader emits the hard verdict "Content Credentials: Original digital capture (camera)" and summarize() prints "all 2 assertions match the signed claim" with ok:true. This defeats README rule "once hashes verify, only the assertions that matched are read" and slips past the existing regression test at test/c2pa-verify.test.js:188, which only blocks an injected box whose *label* differs. Reasoned extension (not reproduced): because the COSE unprotected header bucket is inside the excluded credential store and is covered by neither the signature nor any assertion hash, the extra box's size can be absorbed by shrinking filler there, so the insertion can in principle be made to an already-signed file without disturbing the hard binding — which is what makes this more than a self-forgery convenience.

**Evidence.**

lib/c2pa-verify.js:434-435
  const boxes = new Map();
  for (const box of manifest.assertionBoxes || []) boxes.set(box.label, box);     // last box with a label wins
lib/c2pa-verify.js:453   const box = boxes.get(label) || boxes.get(label.replace(/\.v\d+$/, ''));
lib/image-metadata.js:505-521  for (const a of (assertionsBox ? assertionsBox.children : []).filter(...)) { const label = a.label || ''; ... m.actions.push({ ..., from: label }); }
lib/image-metadata.js:606-607  const allowed = (label) => trusted === null || trusted.has(label);
                               const actions = a.actions.filter((x) => allowed(x.from));
README.md:30  'once hashes verify, only the assertions that matched are read'

$ node e6_duplicate_label.js
assertions        : 2/2 mismatched []
trusted labels    : ["c2pa.actions.v2","c2pa.hash.data"]
binding           : valid
summary.ok        : true | Signature valid (ES256) · all 2 assertions match the signed claim · bound to this file's bytes · root not anchored to a trust list
actions read      : [{"action":"c2pa.created","digitalSourceType":".../digitalCapture","softwareAgent":"Leica M11-P",...,"from":"c2pa.actions.v2"},{"action":"c2pa.opened","softwareAgent":"Some Editor 1.0",...,"from":"c2pa.actions.v2"}]
signals           : c2pa-verified/no-signal, c2pa-capture/captured
image verdict     : captured

**Fix.** Refuse duplicate assertion labels: C2PA requires each assertion in a manifest to have a unique label, so in lib/image-metadata.js parseManifest (or in checkAssertions before building the Map) detect a repeated label and mark the manifest broken rather than picking one box. Better still, stop identifying assertions by their label string on the reading side: give each entry of m.assertionBoxes a stable index, carry that index on every action/digitalSourceType the parser derives (`from: {label, index}`), and have checkAssertions record the *index* of the box that hashed so deriveSignals can admit exactly that box rather than every box that shares its name. Add a regression fixture with two identically labelled boxes.


### L3-2 · low — IPv6 transition and embedding prefixes (NAT64 64:ff9b::/96, 6to4 2002::/16, Teredo 2001::/32, IPv4-translated ::ffff:0:0/96) and site-local fec0::/10 are classified public, so a literal that carries a private IPv4 inside it is fetched

`lib/fetch-policy.js`:123 · CWE-918 · reproduced

**Who.** Any web page the reader visits, where the reader is on a network that implements one of these transition mechanisms — a NAT64/DNS64 network (common on mobile carriers and IPv6-only corporate and cloud networks), or a host with 6to4 or Teredo enabled.

**How.** 1. The page embeds <img src="http://[64:ff9b::c0a8:101]/x.jpg" width=200 height=200> — the NAT64 well-known prefix with 192.168.1.1 embedded in the low 32 bits. 2. ipv6Space (lib/fetch-policy.js:112-123) recognises only ::1, ::, the ::ffff:a.b.c.d and ::a.b.c.d forms, fc00::/7 and fe80::/10; 64:ff9b::/96 matches none of them, so line 123 returns 'public'. 3. mayFetch allows it and the worker fetches; the NAT64 gateway translates the embedded IPv4 and delivers the GET to 192.168.1.1 on the network's IPv4 side. The same holds for 6to4 (2002:c0a8:0101::), for Teredo (2001:0::/32, whose last 32 bits are the client's IPv4 XOR 0xffffffff), for the IPv4-translated range ::ffff:0:0/96, and for deprecated site-local fec0::/10.

**Why it matters.** A second literal-address path past the policy that needs no DNS record at all, on the networks where these mechanisms are live. Narrower than L3-1 because it depends on the reader's network, but it is the same blind-SSRF capability and it is cheap to close: these are fixed prefixes, exactly the kind of thing this function already enumerates.

**Evidence.**

lib/fetch-policy.js:112-123
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) {
      return ipv4Space([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
    }
    if ((g[0] & 0xfe00) === 0xfc00) return 'private';   // fc00::/7 unique local
    if ((g[0] & 0xffc0) === 0xfe80) return 'private';   // fe80::/10 link-local
    return 'public';

Real worker, stubbed fetch, public page:

  FETCHED ["http://[64:ff9b::7f00:1]/x.jpg [redirect=manual]"]     NAT64-embedded 127.0.0.1
  FETCHED ["http://[64:ff9b::c0a8:101]/x.jpg [redirect=manual]"]   NAT64-embedded 192.168.1.1
  FETCHED ["http://[2002:c0a8:101::]/x.jpg [redirect=manual]"]     6to4-embedded 192.168.1.1
  FETCHED ["http://[::ffff:0:7f00:1]/x.jpg [redirect=manual]"]     IPv4-translated ::ffff:0:0/96
  FETCHED ["http://[fec0::1]/x.jpg [redirect=manual]"]             IPv6 site-local

while the forms the function does know are refused:

  block  local    http://[::ffff:127.0.0.1]/x.jpg   -> host=[::ffff:7f00:1]
  block  local    http://[::127.0.0.1]/x.jpg        -> host=[::7f00:1]
  block  private  http://[::ffff:169.254.169.254]/x -> host=[::ffff:a9fe:a9fe]

**Fix.** Extend ipv6Space in lib/fetch-policy.js, before the final `return 'public'`, to unwrap every prefix that embeds an IPv4 address and to cover the remaining special-purpose ranges: 64:ff9b::/96 and 64:ff9b:1::/48 (NAT64 — map g[6],g[7] through ipv4Space, and treat the 64:ff9b:1::/48 local-use form as 'private' outright); 2002::/16 (6to4 — the embedded IPv4 is g[1] and g[2]); 2001:0000::/32 (Teredo — the client IPv4 is (g[6],g[7]) XOR 0xffff, the server IPv4 is g[1],g[2]); ::ffff:0:0/96 (IPv4-translated, i.e. g[0..4]==0 && g[5]==0xffff is already handled but the g[4]==0xffff form is not); fec0::/10 (deprecated site-local). Then invert the default: return 'private' for anything outside 2000::/3 (the only globally routable unicast range) rather than 'public', so the next transition prefix fails closed. Add each shape to test/fetch-policy.test.js, which currently covers only ::1, ::ffff:a.b.c.d, fd00::/8 and fe80::/10.


### L3-3 · low — A page served from an mDNS .local (or .internal / .home.arpa) name is ranked in the loopback tier, so a LAN device — a name any host on the network can claim — is granted the reader's 127.0.0.1 and redirect-following

`lib/fetch-policy.js`:143 · CWE-668 · reproduced

**Who.** Anyone able to serve HTTP from a .local name on the reader's network: a compromised or hostile device on shared Wi-Fi, a captive portal, a NAS/printer/home-automation box with a stored-XSS or a plugin, or simply any host on the LAN — mDNS is unauthenticated, so a machine on the segment can answer for any *.local name it likes.

**How.** 1. Attacker responds to mDNS for anything.local and serves a page there (or gets content into an existing .local device's web UI). 2. That page embeds <img src="http://127.0.0.1:11434/api/tags" width=200 height=200>. 3. addressSpace(pageUrl) hits LOCAL_SUFFIX_RE at lib/fetch-policy.js:143 and returns 'local' — rank 2, the most privileged tier — so RANK[space] > RANK[fromSpace] never fires and the loopback fetch is allowed. 4. background/service-worker.js:277 redirectMode also returns 'follow' for that page, and landedSomewhereAllowed then accepts any landing address, so the same page can additionally launder the request through an open redirector it controls.

**Why it matters.** The tier the policy is built on is the address space a host actually occupies, and a .local / .internal / .home.arpa name resolves to a LAN address, not to loopback. Ranking it 'local' hands a LAN-resident page the one space a LAN-resident page is supposed to be refused: the same device addressed by its IP (http://192.168.1.10/) is correctly refused loopback, while the same device addressed by its mDNS name gets it, plus redirect-following that every other non-loopback page is denied. It converts a foothold on the network into blind GET access to services bound to the reader's 127.0.0.1.

**Evidence.**

lib/fetch-policy.js:33,143
  const LOCAL_SUFFIX_RE = /\.(?:localhost|local|home\.arpa|internal)$/;
  ...
  if (LOCAL_HOST_RE.test(host) || LOCAL_SUFFIX_RE.test(host)) return 'local';
background/service-worker.js:277
  function redirectMode(pageUrl) { return S.fetchPolicy.addressSpace(pageUrl) === 'local' ? 'follow' : 'manual'; }

Real worker, stubbed fetch — direct loopback:

  FETCHED ["http://127.0.0.1:11434/api/tags [redirect=follow]"]
           page=http://printer.local/ui   (mDNS name)
  refused []
           page=http://192.168.1.10/ui    (the same device by IP)
           signal: Not fetched — the page is private but this address is local

and through a redirector to loopback:

  A) page http://printer.local/ui   redirect mode: follow   -> bytes read from http://127.0.0.1:11434/api/tags
  B) page http://192.168.1.10/ui    redirect mode: manual   -> "redirected to an address this page may not reach"
  C) page https://evil.example/p    redirect mode: manual   -> "redirected to an address this page may not reach"

test/fetch-policy.test.js:29 asserts 'http://printer.local/x' is 'local' as a target (which is the conservative, correct direction) but nothing tests it as the requesting page, which is the direction that grants privilege.

**Fix.** Split the name list in lib/fetch-policy.js by the space the name actually resolves to. Keep localhost, *.localhost, ip6-localhost and ip6-loopback at 'local' — RFC 6761 guarantees those are loopback. Move .local (mDNS), .home.arpa and .internal to 'private', because they resolve to LAN addresses. Leaving them at 'local' when they appear as a fetch *target* would still be the conservative choice, so if you want to keep that, take the tier from two functions rather than one: targetSpace() may keep the current mapping, callerSpace() must not, and mayFetch should use callerSpace for pageUrl. Add a test asserting mayFetch('http://127.0.0.1:11434/x', 'http://printer.local/ui').ok === false and that redirectMode('http://printer.local/ui') is 'manual'.


### L5-6 · low — The exported report's "integrity" digest cannot show the report has not been edited, but is presented as if it can

`popup/popup.js`:608 · CWE-345 · reproduced

**Who.** Whoever holds the exported file — the reader themselves, or anyone they pass it to. The claim matters because the README tells the reader to keep the export as evidence and show it to someone else.

**How.** 1. Save a report from the popup ("Save as file"). The JSON contains {integrity: {algorithm: "SHA-256", digest: <hex>, covers: "the findings object as serialised by JSON.stringify"}, findings: {...}}. 2. Edit any finding — flip `overall` from "undisclosed-ai" to "none", drop an image verdict, rewrite a URL. 3. Recompute sha256(JSON.stringify(findings)) and write it into the same integrity field. The file is now self-consistent and indistinguishable from a genuine export, because the digest is unkeyed and travels inside the artefact it describes.

**Why it matters.** A reader is told the saved report can be shown to have not been edited, and it cannot be. A forged report can be produced by anyone with two lines of JavaScript, and a genuine one cannot be distinguished from it; there is no secret and no external reference point in the scheme at all. For a tool whose whole output is an evidentiary claim about provenance, an evidentiary claim about its own output that does not hold is the same class of defect as the ones it exists to detect.

**Evidence.**

popup/popup.js:606-613
  const canonical = JSON.stringify(findings);
  const digest = await sha256(canonical);
  return { ..., integrity: { algorithm: 'SHA-256', digest, covers: 'the findings object as serialised by JSON.stringify', attestedBy: 'this extension only; not a third-party notarisation' }, ..., findings };
popup/popup.js:574  'The report carries a SHA-256 digest of its own findings so you can show it has not been edited since you saved it.'
README.md:  'Saved reports carry a SHA-256 digest of their own findings so you can show the file has not been edited since'

$ node e5_report_digest.js
as saved      : bb2bd8785fd3e0cfef38d4ed917048aaf5fb848c21098811f554afe527582dc0 undisclosed-ai
after editing : daa2aa6b268b17c616f6453caed9a89a822b44aca506b84d45568113caa946ad none
self-consistent, i.e. indistinguishable from a genuine export: true

**Fix.** Either make the claim true or drop it. To make it true: generate an Ed25519 key pair on chrome.runtime.onInstalled, keep the private key non-extractable in IndexedDB, sign `canonical` and publish the public key in the popup and in the export so a second party can check it — and state that this proves only that *this installation* produced the file. To drop it: rename the field to `checksum`, say it guards against accidental corruption and nothing else, and remove the "so you can show it has not been edited" sentence from popup/popup.js:574 and from the README. Whichever is chosen, put the wording in the single exported constant beside lib/verdicts.js CREDENTIAL_CAVEAT so the four copies cannot drift, as the previous pass did for the signature caveat.


## Checked and sound

What the reviewers tried and could not break. Recorded so it is not re-raised, and so a future change that undoes one of these is recognisable as a regression.

- DOM injection into the popup/overlay/publisher from page-derived text: every rendering path uses document.createElement + textContent/createTextNode (popup el(), overlay el()/appendChild, publisher el()); the only innerHTML uses are literal '' clears (overlay.js:190/220/319/323/331, popup.js:86/97, publisher.js:61). Page strings (image URLs, captions, C2PA generator/signer names, disclosure excerpts, VAT/registration, metadata) all land in textContent. No eval/new Function/document.write/srcdoc. No DOM-XSS path found.
- parseTiff: bounded by an entry cap (n>500 aborts), depth cap 3, a `seen` offset set that blocks IFD-pointer cycles, a size>1e7 skip and valOff+size bounds check. Built a 1 MB TIFF of all-ExifIFD-pointer entries at every offset; parseTiff returned in 1–3 ms — no blow-up.
- CBOR decoder: readLen info=27 can declare a huge length but need()/readBytes throw 'truncated' before allocating, and array/map loops consume >=1 byte per item so they are bounded by the buffer; depth capped at 64. No allocation or infinite-loop bomb reachable. The __proto__ map-key issue is object-local only and already recorded as info (REVIEW BUG-3); nothing downstream reads an inherited value across a trust boundary.
- JUMBF (parseJumbfBoxes) and ISOBMFF (walkIso, isobmffNeedsTail): depth caps (12 / 8), a `len < hdr` guard that returns, len==0 -> end-p so p advances to end, and type-charset whitelists. Fed zero-length and giant-declared boxes; loops terminate.
- fetch-policy SSRF: mayFetch ranks target vs page address space (public<private<local), covers 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16 (incl. 169.254.169.254), CGNAT, ::1, ::, fc00::/7, fe80::/10 and IPv4-mapped v6; canonicalHost strips the trailing dot (the recent fix); file: only for file: pages; unknown scheme refused; redirect:'manual' for non-local pages with res.url re-validation. Could not find a literal-address bypass.
- Body-text ReDoS in the content-script analyzers (text-analyzer, legitimacy, site-analyzer): every literal regex is covered by test/redos.test.js at 2/16 KB with a flat 120 ms budget + growth ratio, plus a 300 KB whole-page timing test; findVat now uses pre-compiled frozen patterns bounded by MAX_VAT_CONTEXT_HITS. Re-ran the suite (177 pass). These analyzers hold up.
- image cache key: no longer a truncated URL prefix (MISSED-5) — fetch-policy.cacheKey hashes URLs over 2000 chars to a SHA-256 key, so two long URLs sharing a prefix no longer collide onto one provenance verdict.
- history.js store key: all[result.hostname] is a plain-object assignment, but hostname is canonicalHost(location.hostname) from the sender's own content script and can never be __proto__/constructor; recordHistory also gates on /^https?:/ url. No prototype-pollution path via the domain store today.
- service-worker message handlers: onMessage rejects senders whose id !== chrome.runtime.id and derives tabId from sender.tab for content-script senders; byte caps now run through settings.normalize (MISSED-4) and images.length is sliced to MAX_IMAGES_PER_MESSAGE. With no externally_connectable and the publisher WAR removed (SEC-1), there is no external caller to drive these.
- URL text canonicalisation: fed 50+ hostile spellings through the real lib/fetch-policy.js — decimal (2130706433), hex (0x7f000001), octal (0177.0.0.1), short forms (127.1, 127.0.1), percent-encoded hosts (%31%32%37.0.0.1), fullwidth and circled Unicode (ｌｏｃａｌｈｏｓｔ, ⓛⓞⓒⓐⓛⓗⓞⓢⓣ, ①②⑦.0.0.1), ideographic full stops (127。0。0。1), mixed case, userinfo@host, backslash tricks, and runs of trailing dots. `new URL` normalises every one of them before the policy sees it and all are correctly classified; the trailing-dot fix (canonicalHost, line 47) holds, including localhost.., foo.LOCAL. and 192.168.1.1.
- IPv6 literal forms the policy does model: ::1, ::, 0:0:0:0:0:0:0:1, ::ffff:127.0.0.1 (including the compressed ::ffff:7f00:1 the URL parser actually produces), ::127.0.0.1, ::ffff:169.254.169.254, ::ffff:10.0.0.1, ::ffff:192.168.0.1, fd00::/8 and fe80::/10 are all refused for a public page. A zone-id host ([fe80::1%25eth0]) makes `new URL` throw and is refused rather than fail open.
- Redirects: for any page that is not itself in the loopback tier the worker uses redirect:'manual' (background/service-worker.js:277) and both fetchBytes and fetchTail bail on res.type === 'opaqueredirect'; landedSomewhereAllowed re-checks res.url through mayFetch on top of that. I drove a redirector landing on 127.0.0.1 from a public page and from a 192.168 page and both were refused. The previous pass's fix here is correct.
- Cache cannot be used as a bypass or an oracle: analyzeOne calls mayFetch BEFORE computing the cache key and before the imageCache lookup (background/service-worker.js:188-192), so a public page cannot read a result that a localhost or file: page put in the cache; cacheKey digests anything over 2000 characters with SHA-256 rather than truncating, and failures are deliberately not cached.
- file: targets are refused unless the requesting page is itself a file: URL, and the check is on parse(pageUrl).protocol, not on a string prefix; http://localhost:8080 does not qualify.
- No web_accessible_resources key at all in manifest.json, so SEC-1 is genuinely closed: no page can probe for the extension by URL or frame publisher.html. publisher.js additionally refuses to run when window.top !== window before reading its tabId.
- Message sender validation: background/service-worker.js:47 rejects anything whose sender.id is not chrome.runtime.id, and srl:get-result / srl:page-result / srl:paused derive the tab from sender.tab so a content script cannot name another tab's report; srl:analyze-images refuses a sender with no tab and takes the requesting space from sender.url (browser-supplied) rather than from the message. There is no externally_connectable and no onMessageExternal listener anywhere, so no web page and no other extension can reach any of these handlers.
- Content-script isolation holds: the overlay attaches a CLOSED shadow root (content/overlay.js:114) and content scripts run in the default isolated world, so a page cannot override Element.prototype.attachShadow to capture it. Image verdicts, fetched byte counts, content types and parsed metadata are rendered only inside that shadow root and never written to the page's DOM — only text markers set data-srl-text on page elements, which is PRIV-1 in the existing review and not re-reported here. That is why the SSRF findings above are blind rather than readable.
- No page->extension bridge: repo-wide grep finds no postMessage, no window 'message' listener, no window.name, no document.domain, no localStorage/sessionStorage/indexedDB, no eval/new Function/document.write/srcdoc, no chrome.scripting or executeScript, no MAIN-world injection, and no storage.session.setAccessLevel call (so session storage stays at the TRUSTED_CONTEXTS default and content scripts cannot read per-tab results).
- The only page-context fetch in the content script (content/content.js:466) is gated by /^blob:/i, so it can only read the page's own blob URLs and grants no privilege the page lacks; every other network read in the extension goes through the two policy-gated fetches in the worker.
- Manifest permissions are minimal for what the code does: only `storage` and `contextMenus`, no `tabs`, no `webRequest`, no `declarativeNetRequest`, no `scripting`, no `downloads`, no `cookies`. <all_urls> host access is genuinely required for the cross-origin byte reads and every fetch passes credentials:'omit', so no ambient cookie is ever attached. Content scripts are top-frame only (all_frames absent plus an explicit window.top !== window guard) and match_about_blank is not set.
- Extension pages carry no inline scripts, no inline event handlers and no javascript: URLs, so the default MV3 extension-page CSP (script-src 'self') is sufficient; popup.js's only outbound links (reverse-image lookup) are gated on /^https?:\/\//i, encodeURIComponent'd and carry rel="noreferrer noopener".
- Baseline is green: npm test runs 177 assertions, all passing, including the fetch-policy suite — none of which covers any of the four gaps reported above.
- Transplanting a genuine manifest with honest exclusions: I rebuilt the fixture asset, moved the manifest byte-for-byte onto a different picture, and the binding correctly reported "mismatch" and the image came out "suspected" rather than "captured" (test/c2pa-verify.test.js:276 covers this and it holds in my own runs). The transplant defence only fails through the declared-store route in L5-2.
- Signature replay with an inline COSE payload: c2pa-verify.js:145 requires an inline payload to be byte-identical to the claim in the c2pa.claim box, so a genuine signature cannot be parked beside a forged claim. Confirmed by the existing fixture and by reading the Sig_structure construction at :150, which uses manifest.claimRaw as the body in both the detached and inline cases.
- Algorithm downgrade through the COSE headers: the alg label is taken from the protected bucket first and only falls back to the unprotected one (c2pa-verify.js:108, pick()). I confirmed the unprotected fallback is live (verifyManifest on a manifest with alg only in the unprotected map reports ES256), but it is not a downgrade: the protected header bytes are part of the signed Sig_structure, so stripping alg from them invalidates the signature, and there is no "none" algorithm — an unrecognised label yields signature "unsupported", which never passes. COSE_ALGS contains no weak algorithm (no SHA-1, no RSA below the PKCS#1/PSS SHA-256 pairs).
- ECDSA signature handling: normalizeSig accepts raw r||s at the declared curve size and tolerates a DER SEQUENCE, and derEcdsaToRaw rejects integers wider than the curve (x509.js:228). Feeding a DER signature whose r is oversized throws and lands on signature "unsupported", not "valid".
- DER/X.509 parsing: readTLV refuses lengths past the end and long-form lengths over four bytes; timeOf keys the year width on the tag rather than guessing from the string, so a seconds-less GeneralizedTime is not misread; a date that cannot be parsed goes to chain.unreadableDates rather than being treated as valid (c2pa-verify.js:383). Malformed certificates throw and are recorded as notes rather than trusted (:123).
- equalBytes (c2pa-verify.js:494) compares full length with an accumulated XOR rather than an early return, so the digest comparison leaks no position; nothing here needs constant time against a remote attacker anyway, since both operands are public.
- CBOR decoder limits: nesting is capped at 64 (cbor.js:15,25), every length read is bounds-checked through need(), and indefinite-length byte strings accumulate into a bounded copy. I could not make it allocate on a declared length it does not have bytes for.
- Prototype keys reaching the digital-source-type whitelist: lib/signals.js:47 does a bare `DIGITAL_SOURCE_TYPES[key]` on an attacker-controlled key, so "constructor", "__proto__" and "toString" all return truthy — but spreading a function or Object.prototype yields no own enumerable properties, so the resulting entry has verdict undefined and produces no verdict at all. Verified: digitalSourceType(prefix + "constructor") -> {} . Worth tidying, not a finding.
- The raw verification inputs (claimRaw, the COSE array, assertion box bytes) do not leave lib/image-metadata.js: summarize() rebuilds the c2pa object field by field (image-metadata.js:765-774), so nothing key- or signature-shaped reaches chrome.storage.session or the exported report.
- Data at rest: settings hold no secrets (lib/settings.js DEFAULTS), domain memory holds counters with timestamps rounded to the day and a 90-day expiry (lib/history.js:27,86-100) and is written under a fixed key so a hostname cannot poison the store, per-tab results live in chrome.storage.session and are removed on tab close and on navigation (service-worker.js:84-103). A stolen profile yields a per-domain visit count, not URLs or page content.
- Cache-key collisions: fetchPolicy.cacheKey digests any URL over 2000 characters rather than truncating it (fetch-policy.js:182-191), so REVIEW.md MISSED-5 is genuinely fixed; the residual cache problem is the one named in L5-3 (the key is the URL alone, with no digest of the body).
- Certificate validity dates are computed but still ignored by the pass/fail triage — an expired self-signed certificate returns ok:true and the captured verdict (reproduced in e7_misc.js). This is REVIEW.md SEC-5, reported there and not fixed, so it is not raised again as a new finding; it is cited inside L5-1 because it widens the same gap. Likewise no RFC 3161 countersignature (sigTst/sigTst2) is read anywhere in lib/, so no timestamp is trusted — I grepped and confirmed.
- Server-controlled truncation: a response carrying a Content-Range whose total exceeds the body sets truncated=true (service-worker.js:320-323), which I traced through summarize. It can only downgrade a result (a missing assertion becomes caution instead of broken, a binding becomes unchecked instead of valid); there is no path where claiming truncation upgrades a manifest towards ok.
- Unsigned and no-binding manifests: a manifest with no certificate reports signature "unknown" and never reaches ok, and the exculpatory-claim gate at image-metadata.js:666-683 pushes the non-hard "unverified" signal instead — REVIEW.md MISSED-2 holds. A validly signed claim carrying no hard binding is correctly broken (c2pa-verify.js:558-559).

