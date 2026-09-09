# Selfreportle — security & upgrade review (2026-09-09)

Two independent reviewers read every first-party file in this repository; a third then re-read each security or bug claim against the code and tried to refute it. Only claims that survived that check are listed as findings; the ones that did not are recorded at the end so they are not re-raised.

## Summary

Selfreportle is a dependency-free Chromium MV3 extension (about 8.7k lines of plain-script JS) that reads AI-provenance and disclosure signals from a page's code, text and media, cryptographically verifies C2PA Content Credentials in the browser, checks trader identification against EU consumer law, and offers a publisher self-check, all framed around EU AI Act Article 50. The core libraries are unusually well engineered for a side project: real-crypto test fixtures, a permanent ReDoS guard, fuzzed binary parsers, a false-positive regression suite and an honest changelog. The weaknesses are around the edges: one confirmed ReferenceError (attributeSite on ai-host sites) that aborts the whole page analysis and that a linter would have caught; a class of caption false positives from common-word tool names (imagen, runway, veo, sora); stale 'not verified' copy left over from before verification shipped; no LICENSE, privacy policy, packaging script, lint or type check; CI on unpinned actions with no permissions block; and a manifest that is Chrome-only where a few keys would make it load in Firefox. Headline recommendations: fix the attributeSite crash and caption false positives, add ESLint plus a LICENSE and PRIVACY.md, tighten the manifest for the Web Store (drop the fingerprintable web_accessible_resources, add Firefox keys, packaging script), and then invest in the two big product gaps the README itself names: a bundled C2PA trust list and hard-binding verification so a transplanted manifest cannot read as verified.

## Attack surface

A Manifest V3 Chromium extension with host_permissions <all_urls> and content scripts injected into every http/https/file top-level document. Every byte it reasons about is attacker-controlled: page text, DOM attributes, inline scripts, JSON-LD, image/video/audio bytes fetched cross-origin by the service worker, and the C2PA/JUMBF/COSE/X.509 structures inside them. The service worker holds the only privileged capabilities (cross-origin fetch that bypasses the page's CORS, CSP, mixed-content and Private Network Access rules; per-tab result storage; local per-domain counters) and exposes them over chrome.runtime.onMessage with no sender validation. There is no externally_connectable, so a web page cannot message the extension directly, but publisher/publisher.html is declared web_accessible to <all_urls>, so any site can probe for the extension and frame a privileged extension page that then issues those messages with attacker-chosen parameters. The other page-facing surface is the data-srl-text attribute the overlay writes onto the page's own elements, which lets any site detect the extension and read its per-paragraph verdicts. Rendering in the popup, overlay and publisher page is done exclusively with createElement/textContent, so the classic DOM-XSS path is genuinely closed. The realistic adversaries are a hostile or merely AI-generated web page trying to evade or crash the detector, and a forger trying to make a C2PA manifest read as verified camera provenance.

## Already done well

- No HTML injection anywhere: every innerHTML use is a literal `= ''` clear (content/overlay.js:190,220,319,331; popup/popup.js:86,97; publisher/publisher.js:55) and all page-derived strings go through document.createTextNode / textContent / el(tag, cls, text). No eval, no new Function, no document.write, no srcdoc.
- Real cryptography, really tested. lib/c2pa-verify.js verifies COSE_Sign1 with WebCrypto, re-hashes each assertion against the signed claim, and checks chain links by actual signature verification; test/c2pa-verify.test.js generates P-256 keys, issues genuine certificates and attacks them one change at a time (tampered signature, swapped assertion, broken chain link, replayed signature, injected unreferenced assertion, deleted assertion).
- The signature-replay fix is correct and load-bearing: an inline COSE payload is accepted only when byte-identical to the claim actually reported (lib/c2pa-verify.js:130-134), and only assertions the signed claim references may speak for the asset (lib/image-metadata.js:458-466, lib/c2pa-verify.js:272-283, trustedLabels at lib/image-metadata.js:683-688).
- The absence of a trust list is stated rather than papered over: chain.anchored is always false and anchorNote says so (lib/c2pa-verify.js:216), and the popup's verification row repeats it verbatim (popup/popup.js:479-489).
- ReDoS is treated as a first-class threat with a permanent guard: test/redos.test.js scans every regex literal in lib/, runs 19 hostile shapes at 2 KB and 16 KB against a flat budget and a growth ratio, and separately runs the text, legitimacy and site analysers over 300 KB hostile bodies.
- Binary parsers are defensive: depth caps and container whitelists in walkIso/parseJumbfBoxes, IFD entry and size caps in parseTiff (lib/image-metadata.js:283-291), bounds checks and a 4-byte length ceiling in lib/x509.js:23-38, and truncation errors in lib/cbor.js:113-115.
- Fetches omit credentials, are byte-capped with a streaming reader that cancels early, and carry a 20 s AbortController timeout (background/service-worker.js:231-267); the tail request is only used when it actually parses as a credential store.
- Per-tab results live in chrome.storage.session (trusted contexts only) and are cleared on tab removal, on navigation and when a host is paused (background/service-worker.js:70-89).
- Settings are normalised and clamped on every read, including a hostname allowlist that is lower-cased and trimmed (lib/settings.js:29-51).
- History writes are serialised through a promise chain that survives a failed write (lib/history.js:94-108), and the domain store is capped and clearable.

## Findings (18)

| # | Severity | Category | Title | Where | Effort | Status |
|---|---|---|---|---|---|---|
| SEC-4 | High | security | C2PA verification never checks the hard binding, so a valid manifest can be transplanted onto a different image | `lib/c2pa-verify.js:77` | large | confirmed |
| BUG-1 | High | bug | ReferenceError in attributeSite aborts all analysis on Replit-hosted pages | `lib/attribution.js:384` | trivial | confirmed |
| BUG-2 | High | bug | A malformed percent-escape in any image URL crashes the whole page analysis | `lib/image-hints.js:38` | trivial | confirmed |
| MISSED-1 | High | bug | A malformed <video poster> URL crashes the whole analysis, the same one-attribute kill switch as BUG-2 in a different file | `content/content.js:371` | trivial | found by second reviewer |
| SEC-3 | Medium | security | Any page can make the service worker fetch arbitrary URLs, including loopback, private-network and file: targets | `background/service-worker.js:169` | medium | confirmed |
| MISSED-2 | Medium | security | A C2PA manifest with no signature at all still produces a hard 'captured' verdict and the page-level ✓ provenance badge | `lib/image-metadata.js:604` | small | found by second reviewer |
| SEC-1 | Low | security | publisher/publisher.html is web-accessible to every site although nothing needs it | `manifest.json:63` | trivial | confirmed, severity lowered |
| SEC-2 | Low | security | Service-worker message handlers validate neither the sender nor the tabId/host they are asked about | `background/service-worker.js:34` | small | confirmed, severity lowered |
| SEC-5 | Low | security | Certificate validity dates, CA status and key usage are parsed but never affect the verdict | `lib/c2pa-verify.js:360` | medium | confirmed, severity lowered |
| SEC-6 | Low | bug | The report the user saves as evidence says signatures were not verified, contradicting the code and the rest of the UI | `popup/popup.js:609` | trivial | confirmed |
| PRIV-1 | Low | privacy | The extension marks the page's own DOM, letting any site detect it and read its verdicts | `content/overlay.js:197` | medium | confirmed |
| PRIV-2 | Low | privacy | Domain memory is a timestamped per-site visit log, on by default, readable by any extension context for any host | `lib/history.js:20` | small | confirmed |
| BUG-4 | Low | reliability | findVat recompiles 28 regexes per VAT-context hit, with no bound on the number of hits | `lib/legitimacy.js:191` | small | confirmed |
| CI-1 | Low | supply-chain | CI actions unpinned, no lockfile, default-write token, and no repository security metadata | `.github/workflows/test.yml:9` | small | confirmed |
| MISSED-3 | Low | security | An assertion reference whose hash is not a byte string is silently skipped, so a manifest can verify 'ok' with zero assertions actually checked | `lib/c2pa-verify.js:280` | trivial | found by second reviewer |
| MISSED-4 | Low | security | The service worker trusts caller-supplied byte caps, ignoring the normaliser that exists to clamp them | `background/service-worker.js:143` | trivial | found by second reviewer |
| MISSED-5 | Low | bug | The image cache key truncates URLs at 2000 characters, so two long URLs sharing a prefix and a length share one provenance verdict | `background/service-worker.js:172` | trivial | found by second reviewer |
| BUG-3 | Info | security | CBOR maps decode into plain objects, so an untrusted manifest can set the decoded object's prototype | `lib/cbor.js:46` | trivial | confirmed, severity lowered |

### SEC-4 · C2PA verification never checks the hard binding, so a valid manifest can be transplanted onto a different image

**Severity:** High · **Category:** security · **Effort:** large · **Where:** `lib/c2pa-verify.js:77`

The verifier answers three questions — is the signature valid, do the assertions hash as the claim recorded, is the chain internally consistent — but never the fourth one that ties the manifest to the asset. There is no handling of the c2pa.hash.data / c2pa.hash.bmff hard-binding assertion anywhere in the repository (grep for hash.data, hardBinding, exclusions returns nothing in lib/), so the pixel/byte digest the claim records over the asset is never recomputed. An attacker can therefore lift a genuine, fully verifying manifest out of a real camera photograph and embed those exact bytes in a completely different, AI-generated JPEG: the signature still verifies over the same claim, every assertion still hashes to the same value, the chain is still consistent, and lib/image-metadata.js:601-602 emits c2pa-verified while the digitalSourceType digitalCapture path emits a hard 'captured' signal. The reader sees a green "Signature verified" plus "Content Credentials: Original digital capture (camera)", and verdicts.js:112 makes 'captured' the image verdict and verdicts.js:146 makes the page overall 'provenance' with a check mark on the toolbar. This is precisely the failure the README says cannot happen ("Three rules keep a valid signature from vouching for the wrong thing", README:27-31) and it is not listed under "What it cannot do" (README:98-104).

Evidence:

```
lib/c2pa-verify.js:77-159 (verifyManifest: signature, assertions, chain — no asset binding)
lib/c2pa-verify.js:363
  ok: v.signature === 'valid' && !broken && !caution,
lib/image-metadata.js:601-602
  } else if (vs && vs.ok) {
    push({ id: 'c2pa-verified', ... label: 'Content Credentials signature verified', ...});
$ grep -rn "hash.data|hardBinding|hash\.bmff|exclusions" lib/ test/  ->  (no matches)
```

**Recommendation.** As written, plus: the check needs the asset bytes the worker already has, so implement it in background/service-worker.js where `bytes` is in scope rather than inside image-metadata's parse pass; treat 'no hard-binding assertion among the hash-verified labels' as broken (the C2PA claim is invalid without one), and 'present but the byte cap or a bmff exclusion range put it out of reach' as caution. Until it ships, stop returning ok:true: make summarize() report caution whenever no hard binding was checked, and correct README:27-31 and the popup's 'What this does and does not prove' text, which currently tells the reader the manifest belongs to this asset.

### BUG-1 · ReferenceError in attributeSite aborts all analysis on Replit-hosted pages

**Severity:** High · **Category:** bug · **Effort:** trivial · **Where:** `lib/attribution.js:384`

In attributeSite the identifier p is declared with const inside the first if-block (line 363) and is therefore out of scope at line 384, where it is assigned without a declaration. The module runs under 'use strict', so this throws ReferenceError: p is not defined. The branch is reached whenever the site fingerprint is an 'ai-host' (the Replit entry in lib/signals.js:160) and no code-comment/meta/JSON-LD signal already matched a profile — i.e. on any page served from *.replit.app, *.repl.co or *.replit.dev, or any page that loads the Replit dev banner script. content/content.js:164 calls attributeSite inside analyze() with no try/catch, and analyze() is awaited by main() with no .catch(), so the exception aborts the whole analysis before `result` is even assigned: nothing is posted to the worker, the mutation observer and the SPA-navigation poller are never started, the overlay never gets a summary, and the popup reports "Nothing analysed yet for this tab". The user gets a silent total failure on exactly the class of AI-built app hosting the tool is meant to flag. No test covers the ai-host branch (test/attribution.test.js only exercises ai-builder, code-comment and no-signal).

Evidence:

```
lib/attribution.js:361-386
    if (s.builder && s.builder.kind === 'ai-builder') {
      const p = matchProfile(s.builder.name, ['site']);      // line 363, block-scoped
      ...
    }
    ...
    if (s.builder && s.builder.kind === 'ai-host') {
      p = matchProfile(s.builder.name, ['site']);            // line 384, undeclared
$ node -e "const SA=require('./lib/site-analyzer.js'),A=require('./lib/attribution.js'); const site=SA.analyzeSite({hostname:'demo.replit.app',...}); A.attributeSite(site,{})"
  site verdict: ai-assisted builder: {"name":"Replit","kind":"ai-host"}
  ReferenceError: p is not defined
content/content.js:164  site.attribution = S.attribution.attributeSite(site, snapshot);
```

**Recommendation.** Same fix (declare it, e.g. `const hit = matchProfile(...)`), but the test to add should assert the ai-host branch through analyzeSite rather than a hand-built object, and should include the script-src trigger, since that is the reachable path an attacker uses. The try/catch around analyze() is the load-bearing half of the recommendation — see also my MISSED-1, which is the same class of crash in a different file and is not fixed by patching attribution.js.

### BUG-2 · A malformed percent-escape in any image URL crashes the whole page analysis

**Severity:** High · **Category:** bug · **Effort:** trivial · **Where:** `lib/image-hints.js:38`

analyzeImageHints calls decodeURIComponent on the last path segment of the image URL without a try/catch. decodeURIComponent throws URIError on any malformed escape, and URL parsing does not normalise those away, so `<img src="/%" width=100 height=100>` (or any src ending in a truncated %E0%A4) produces pathname "/%" and a URIError. content/content.js:410 (and 115, the context-menu path) calls analyzeImageHints from processImages inside the per-item loop, with no try/catch anywhere up the chain to analyze() and main(), so the exception aborts image analysis, the platform-label pass, the mutation observer and the SPA poller for the rest of the page's life. Because the page controls its own markup, this is not just a crash: it is a one-tag kill switch. Any site that does not want its AI markers read can add a single broken-escape image and the detector permanently stops inspecting images on that page while still showing a (stale, partial) site/text verdict, which is worse than showing nothing.

Evidence:

```
lib/image-hints.js:38
  const file = decodeURIComponent(pathname.split('/').pop() || '');
content/content.js:410
  const hints = S.imageHints.analyzeImageHints(item);
$ node -e "require('./lib/image-hints.js').analyzeImageHints({url:'https://evil.test/%'})"
  URIError: URI malformed
```

**Recommendation.** As written. Note the same one-attribute blackout also exists at content/content.js:371 via new URL(poster, ...) (MISSED-1), so the durable fix is the try/catch around analyze() and around the per-item body of processImages/collectMedia, not only the decodeURIComponent guard.

### MISSED-1 · A malformed <video poster> URL crashes the whole analysis, the same one-attribute kill switch as BUG-2 in a different file

**Severity:** High · **Category:** bug · **Effort:** trivial · **Where:** `content/content.js:371`

collectMedia() resolves every <video poster> attribute with `new URL(poster, location.href)` and no try/catch. new URL throws TypeError on a string that parses as an absolute URL with invalid structure — 'http://[', 'http://a b', 'https://:@', 'http://%' all throw against a page base. collectMedia is called from analyze() at content/content.js:177 inside the array spread, before processImages, and analyze() is awaited by main() (line 564) with no .catch, so a single `<video poster="http://[">` tag anywhere on the page kills image analysis, applyPlatformLabels(), observeMutations() and the SPA poller for the page's lifetime, exactly like BUG-2. It also survives the fix the first auditor recommends for BUG-2, because that patch touches lib/image-hints.js only. The tag needs no size, no source and no visibility: the poster branch at lines 369-376 runs regardless of the video's rendered dimensions (the >=24px floor at line 365 applies only to the video's own src).

Evidence:

```
content/content.js:369-372
      const poster = m.tagName === 'VIDEO' ? m.getAttribute('poster') : null;
      if (poster) {
        const abs = new URL(poster, location.href).href;
        if (!posterSeen.has(abs)) {
content/content.js:177  const imgs = [...collectImages(), ...collectMedia()];
$ node -e "new URL('http://[', 'https://page.test/x/')"  ->  TypeError: Invalid URL   (same for 'http://a b', 'https://:@', 'http://%')
```

**Recommendation.** Resolve it defensively: `let abs = null; try { abs = new URL(poster, location.href).href; } catch (e) { /* skip */ } if (abs && !posterSeen.has(abs)) {...}`. Then wrap the body of analyze() in try/catch and report the failure through the overlay, so that no single analyser defect — this one, BUG-1, BUG-2 or the next — can silently disable the content script; add a fixture page carrying `<img src="/%">`, `<video poster="http://[">` and a Replit banner script to the e2e suite and assert the summary still appears.

### SEC-3 · Any page can make the service worker fetch arbitrary URLs, including loopback, private-network and file: targets

**Severity:** Medium · **Category:** security · **Effort:** medium · **Where:** `background/service-worker.js:169`

The content script harvests img/video/audio src and video poster values straight from the DOM and hands them to the worker, which fetches them with <all_urls> host permissions. The only filter is a scheme test that allows https, http, data and file. Because the request originates from the extension, it is not subject to the page's CSP, its mixed-content blocking, or Chrome's Private Network Access checks — so an HTTPS page that could not itself load http://192.168.1.1/ or http://127.0.0.1:11434/ can get the extension to load it, follow redirects, and read up to 4 MB of the body. Nothing excludes loopback, RFC1918, link-local (169.254.169.254) or .local hosts. The size floor is trivially satisfied (<img src="http://10.0.0.1/x" width=100 height=100> renders at 100x100 even when broken), the per-page cap of 60 resets on every location.href change (content/content.js:42-45 polls once a second and re-runs analyze(true), which resets imageState), and maxImageBytes defaults to 4 MB — so a page can drive roughly 60 arbitrary-host fetches per second at up to 4 MB each using the victim's IP and network position. file: is in the allowlist, so on a profile where the user granted "Allow access to file URLs" a page can also name file:///... targets. README:175 justifies <all_urls> by saying fetches "only ever target files the page already loaded", which is not what the code does: a URL that only ever appeared in an attribute is fetched regardless of whether the page loaded it.

Evidence:

```
background/service-worker.js:169-171
  if (!/^(https?|data|file):/i.test(url)) {
    return { ...base, signals: [{ id: 'unavailable', ... }] };
  }
background/service-worker.js:236
  const res = await fetch(url, { headers, credentials: 'omit', redirect: 'follow', signal: controller.signal });
content/content.js:386-398 (collectImages: url = img.currentSrc || img.src, only a rendered-size floor)
content/content.js:42-45
  hrefTimer = setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; analyze(true); } }, 1000);
```

**Recommendation.** Reject non-public targets before fetching (localhost, *.local, 127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1, fc00::/7) and re-validate every hop with redirect:'manual'. Do NOT drop file: unconditionally — the extension deliberately runs on file:///* pages where local images are the page's own resources; instead allow file: only when the requesting tab's own URL is a file: URL. Require the element to have actually loaded (img.complete && img.naturalWidth > 0; HAVE_METADATA for media) before handing a URL to the worker, add a per-tab byte budget, and stop resetting the per-page URL counter on same-document navigations.

### MISSED-2 · A C2PA manifest with no signature at all still produces a hard 'captured' verdict and the page-level ✓ provenance badge

**Severity:** Medium · **Category:** security · **Effort:** small · **Where:** `lib/image-metadata.js:604`

deriveSignals returns early only when the verification summary is `broken`. When it is merely not ok — including signature:'absent', i.e. a JUMBF store containing a claim and assertions with no COSE structure whatsoever — it pushes a 'c2pa-unverified' informational row and then falls through to the claim-reading branches, which emit c2pa-capture as a hard signal. Because trustedLabels() falls back to the claim's own referencedAssertions when verification produced no verified labels (lib/image-metadata.js:684-687), every assertion the attacker's unsigned claim names is allowed to speak. I confirmed end to end with the real modules: an unsigned manifest declaring c2pa.created with digitalSourceType=digitalCapture yields image verdict 'captured' at score 0.9 and page overall 'provenance', which background/service-worker.js:133 renders as a ✓ on the toolbar. So the cheapest forgery of camera provenance needs no certificate, no key and no crypto — it is a hand-written JUMBF box — which is both easier than SEC-4's transplant and in direct conflict with README:25 ('an unanswered question is never reported as a pass') and with the CHANGELOG entry claiming a tampered manifest can no longer produce 'a green camera-provenance result'. The popup's Images tab does show a 'Signature not verified' row beside it, which is why this is medium rather than high, but the toolbar badge and the Overview verdict — the only things most readers look at — say pass.

Evidence:

```
lib/image-metadata.js:596-606
      if (vs && vs.broken) { ... return signals; }
      else if (vs && vs.caution) { ... }
      else if (vs && vs.ok) { push({ id: 'c2pa-verified', ... }) }
      else if (v) { push({ id: 'c2pa-unverified', ... 'Content Credentials signature not verified' ... }) }
      // falls through:
lib/image-metadata.js:611  if (capture) push({ id: 'c2pa-capture', hard: true, verdict: 'captured', strength: capture.strength, ... })
lib/image-metadata.js:683-688  function trustedLabels(active) { ... if (active.referencedAssertions) return new Set(active.referencedAssertions); return null; }
$ node -e "deriveSignals(meta with verification={signature:'absent'} and a digitalCapture c2pa.created action)"
  c2pa-unverified | hard=false | no-signal
  c2pa-capture   | hard=true  | captured | 'Content Credentials: Original digital capture (camera)'
  combineImageSignals -> {"verdict":"captured","score":0.9}
  verdicts.overall  -> 'provenance'
background/service-worker.js:133  text: n > 0 ? ... : (overall === 'provenance' ? '✓' : '')
```

**Recommendation.** Treat an unverified manifest like an unverified one: when the summary is neither ok nor caution, cap what its claims may produce — emit the digital-source-type reading as a soft signal (hard:false, low strength) so combineImageSignals cannot return 'captured' on it, and require at least one verified manifest before verdicts.overall reports 'provenance' with a ✓. The AI-generation branches can stay hard, since a self-declared 'this is AI' is a disclosure against interest; it is only the exculpatory claims (captured / human-created) that must not be free.

### SEC-1 · publisher/publisher.html is web-accessible to every site although nothing needs it

**Severity:** Low (reported as medium, adjusted after review) · **Category:** security · **Effort:** trivial · **Where:** `manifest.json:63`

The manifest exposes publisher/publisher.html as a web-accessible resource matching <all_urls> with no use_dynamic_url. The page is only ever opened by the extension itself (popup/popup.js:275 uses chrome.tabs.create + chrome.runtime.getURL), which does not require a web_accessible_resources entry at all, so the declaration buys nothing and costs two things. First, any page can probe chrome-extension://<id>/publisher/publisher.html and learn the extension is installed — for a tool whose whole purpose is to catch sites that hide AI provenance, being detectable lets a site serve different markup to readers who are checking. Second, any page can frame that privileged extension page with an attacker-chosen ?tabId=N; publisher.js:43-51 then autonomously sends srl:get-result for that tab id and renders another tab's full report (URL, title, flagged text excerpts, trader findings) inside the attacker's frame, and its Re-check button sends srl:rescan to an arbitrary tab. The frame's DOM is not readable cross-origin, so this is a fingerprinting and UI-redress problem rather than direct exfiltration — but it is a privileged surface that exists for no reason. README:177-179 claims "no externally_connectable, so a web page cannot talk to it", which this entry contradicts.

Evidence:

```
manifest.json:63-72
  "web_accessible_resources": [ { "resources": [ "publisher/publisher.html" ], "matches": [ "<all_urls>" ] } ]
popup/popup.js:275
  chrome.tabs.create({ url: chrome.runtime.getURL('publisher/publisher.html') + '?tabId=' + tab.id });
publisher/publisher.js:16,49
  const tabId = parseInt(params.get('tabId'), 10);
  try { result = await chrome.runtime.sendMessage({ type: 'srl:get-result', tabId }); }
```

**Recommendation.** Delete the web_accessible_resources block — that alone closes it, and chrome.tabs.create keeps working. Also make publisher.js refuse a tabId it was not handed by the popup (e.g. require window.top === window, or pass the tab id through chrome.storage.session instead of the query string). Do not rely on "frame-ancestors" in content_security_policy.extension_pages: Chromium's extension-page CSP parser has historically ignored or rejected that directive, so it is not a dependable frame guard; removing the WAR entry is.

*Reviewer note (confirmed, severity lowered):* The facts are right: the web_accessible_resources entry exists, matches <all_urls>, has no use_dynamic_url, and is not needed because the page is only ever opened with chrome.tabs.create + chrome.runtime.getURL (which never requires a WAR entry). The framing consequence is also real: publisher.js reads tabId from location.search and acts on it with no check. But 'medium' overstates the impact. (a) A framed extension page is cross-origin to the attacker, so nothing it renders is readable; the auditor concedes this. (b) The fingerprinting half buys the attacker nothing new: the overlay appends a plain <srl-overlay data-srl-ui="1"> element straight into the page's own DOM on every enabled page (content/overlay.js:111-138), and content.css is injected into every page, so `document.querySelector('srl-overlay')` or `getComputedStyle` on a self-made `[data-srl-text]` element already detects the extension unconditionally, before any verdict exists. (c) The only novel capability is making the framed page fire srl:rescan at an arbitrary tab id and clickjacking its 'Copy all snippets' button. Real hardening item, small blast radius.

### SEC-2 · Service-worker message handlers validate neither the sender nor the tabId/host they are asked about

**Severity:** Low (reported as medium, adjusted after review) · **Category:** security · **Effort:** small · **Where:** `background/service-worker.js:34`

chrome.runtime.onMessage checks only that msg.type is a string. It never checks sender.id, never checks whether the sender is a content script or an extension page, and never checks that the tabId or host being asked about belongs to the caller. srl:get-result returns the complete analysis of any tab id (page URL, title, flagged paragraph excerpts, trader findings, image URLs); srl:get-history returns the per-domain counters for any hostname the caller names; srl:clear-history destroys the user's whole domain memory; srl:analyze-images makes the worker fetch any URL the caller supplies (see SEC-3). srl:page-result and srl:paused do correctly derive the tab from sender.tab, which shows the pattern was available and simply not applied to the rest. On its own this is only reachable from inside the extension, but combined with SEC-1 the framed publisher page is an attacker-parameterised caller, so this is the second half of that chain rather than a purely theoretical hardening item.

Evidence:

```
background/service-worker.js:34-68
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return false;
    ...
    case 'srl:get-result':
      getResult(msg.tabId).then(sendResponse);
    case 'srl:get-history':
      S.history.get(msg.host).then(...)
    case 'srl:clear-history':
      S.history.clear().then(...)
```

**Recommendation.** Keep the sender.id === chrome.runtime.id check and the sender.tab-derived tabId for content-script senders, but skip the sender.url allowlisting per message type as over-engineering for a surface with no external caller; the one that actually matters is srl:get-result, because it is the only handler that returns another tab's content.

*Reviewer note (confirmed, severity lowered):* The code is exactly as described — the listener validates only typeof msg.type, and srl:get-result / srl:get-history / srl:clear-history / srl:analyze-images all act on caller-supplied parameters while srl:page-result and srl:paused correctly use sender.tab. But there is no external caller to defend against: the manifest declares no externally_connectable (verified: the string does not appear in manifest.json), and a different extension reaching chrome.runtime.sendMessage lands on onMessageExternal, not onMessage, so only this extension's own content scripts and pages can be senders. The SEC-1 chain adds only parameter choice on a page the attacker cannot read. That makes this a hardening item, not a live confused-deputy: low, not medium.

### SEC-5 · Certificate validity dates, CA status and key usage are parsed but never affect the verdict

**Severity:** Low (reported as medium, adjusted after review) · **Category:** security · **Effort:** medium · **Where:** `lib/c2pa-verify.js:360`

checkChain computes chain.timeValid (false for expired or not-yet-valid, null for dates it could not read) but summarize's broken/caution triage ignores it entirely, so a manifest signed with an expired certificate, a not-yet-valid certificate, or a certificate whose dates could not be parsed still returns ok:true. Verified by evaluating summarize on such a result: it yields {ok:true, broken:false, caution:false} with 'certificate expired' merely appended to the free-text string. The user-visible consequence is a green "Signature verified" badge and the explanatory sentence "The manifest has not been altered since it was signed" (popup/popup.js:472-489). This contradicts README:25 ("broken — the signature, an assertion hash or the chain verifiably does not add up") and undercuts CHANGELOG:71 ("Certificate dates that could not be parsed were treated as valid"), which they still effectively are. Compounding it, the C2PA time-stamp countersignature (c2pa.time-stamp / RFC 3161) is never read, so there is no way to distinguish "expired now but valid at signing" from "expired"; and lib/x509.js:185 parses keyUsage, isCA and ekus but nothing enforces them, so a CA certificate or an ordinary TLS server certificate can act as a C2PA signer and verify clean.

Evidence:

```
lib/c2pa-verify.js:226-228
  chain.timeValid = (chain.expired.length === 0 && chain.notYetValid.length === 0 && chain.unreadableDates.length === 0) ? true : (...)
lib/c2pa-verify.js:360-363
  const broken = v.signature === 'invalid' || mismatched || (v.chain && v.chain.linked === false) || (missing && !a.truncated);
  const caution = !broken && v.signature === 'valid' && (inconclusive || (missing && a.truncated));
  return { ok: v.signature === 'valid' && !broken && !caution, ... }
$ node -e "...summarize({signature:'valid', chain:{linked:true,timeValid:false,expired:['CN=Signer'],...}})"
  { ok: true, broken: false, caution: false, text: '... certificate expired ...' }
```

**Recommendation.** Fold time validity into the triage as caution (not broken) when chain.timeValid is false or null, and say so in the badge word rather than only in the detail line. Reading the RFC 3161 time-stamp is the right long-term fix but is a much larger job than the rest of this item, so gate it: until a signing time is available, 'expired' can only ever be caution. Enforcing keyUsage/isCA/EKU is worth doing for spec conformance but should be labelled as such, since without a trust list it blocks no attacker.

*Reviewer note (confirmed, severity lowered):* The mechanism is exactly as reported and I reproduced it: summarize() on a result carrying chain.timeValid === false (or null) returns {ok:true, broken:false, caution:false}, so an expired, not-yet-valid or unparseable-date certificate still lights the green 'Signature verified' badge; keyUsage/isCA are parsed at x509.js:185 and only echoed into chain.certificates at c2pa-verify.js:213, never enforced; ekus are parsed and not even surfaced. The C2PA profile does require the signing certificate to be valid at the time of signing (established by an RFC 3161 time-stamp) or, absent one, at validation time, and does constrain keyUsage/EKU, so this is a genuine deviation. But 'medium' overstates the security value: because no trust list ships and chain.anchored is always false, an attacker who wants a green badge simply issues a fresh self-signed certificate with any CN they like — an expired or CA certificate gives them nothing extra. The realistic victim is an honest signer whose certificate has since expired, i.e. a misreport rather than a bypass, and the popup does print 'certificate expired' in the detail line immediately under the green tag. Also note test/c2pa-verify.test.js:64 ('expired certificates are reported without failing the signature') shows the current behaviour is deliberate, not an oversight.

### SEC-6 · The report the user saves as evidence says signatures were not verified, contradicting the code and the rest of the UI

**Severity:** Low · **Category:** bug · **Effort:** trivial · **Where:** `popup/popup.js:609`

Cryptographic verification shipped (CHANGELOG:9-14) but three user-facing strings were never updated. The exported JSON report — the artefact the user is told to keep as evidence, complete with a SHA-256 digest of its own findings — carries the caveat "C2PA signatures are parsed, not cryptographically verified"; the PNG receipt footer says "signatures parsed, not verified"; and the Overview tab's trust hint for the 'provenance' verdict says "Credentials were parsed, not cryptographically verified." Meanwhile popup.html:38 and README:19-25 say the opposite, and the Images tab shows a green "Signature verified" row. So the same popup asserts both things at once, and the saved evidence understates what the tool actually checked. lib/image-metadata.js:14 carries the same stale claim in its header comment. For a tool whose value proposition is accurate reporting about provenance, self-contradiction in the exported record is a correctness problem, not a typo.

Evidence:

```
popup/popup.js:609
  'C2PA signatures are parsed, not cryptographically verified.',
popup/popup.js:669
  '... signals only, not proof of authorship · signatures parsed, not verified'
popup/popup.js:152
  case 'provenance': return 'Some content carries capture or human-creation credentials. Credentials were parsed, not cryptographically verified.';
popup/popup.html:38
  'C2PA signatures are cryptographically verified against the embedded certificate ...'
```

**Recommendation.** Derive the caveat list in buildReport from the verification summaries actually present in the findings, and keep the one true blanket caveat honest in both directions: signatures are verified against the embedded certificate; the root is not anchored to any trust list; and the manifest is not bound to the asset bytes (SEC-4). Put that sentence in one exported constant (lib/verdicts.js is already shared by popup, overlay and publisher) so the four copies cannot drift again.

### PRIV-1 · The extension marks the page's own DOM, letting any site detect it and read its verdicts

**Severity:** Low · **Category:** privacy · **Effort:** medium · **Where:** `content/overlay.js:197`

Text markers are drawn by writing data-srl-text="<verdict>" onto the page's own elements, styled by an injected stylesheet. The page can read those attributes at any time: document.querySelectorAll('[data-srl-text]') reveals both that the extension is installed and its per-paragraph AI verdicts, and a MutationObserver sees them appear. Combined with SEC-1 (a probe-able web-accessible resource) this makes the extension trivially fingerprintable and, worse, evadable: a site can detect a reader who is checking for undisclosed AI content and serve different markup, or simply strip the attribute so nothing is highlighted. It is also a stable cross-site fingerprinting bit for ordinary trackers. README:180-182 acknowledges the attribute but not this consequence.

Evidence:

```
content/overlay.js:197
  m.el.setAttribute('data-srl-text', m.verdict);
content/content.css:3
  [data-srl-text] { box-shadow: -4px 0 0 0 var(--srl-mark, #7a7f87) !important; }
```

**Recommendation.** Moving the text marker into the shadow layer (as image badges already are) is the right change and removes the verdict leak, but do not sell it as making the extension undetectable — that also requires giving the host element a randomised tag name and dropping the manifest-level CSS, and even then the shadow-hosted badges remain visible as an element in the page tree. If detectability matters, say so in README:180-182 rather than implying the attribute is the only tell.

### PRIV-2 · Domain memory is a timestamped per-site visit log, on by default, readable by any extension context for any host

**Severity:** Low · **Category:** privacy · **Effort:** small · **Where:** `lib/history.js:20`

rememberDomains defaults to true (lib/settings.js:25) and every page load folds a record into chrome.storage.local keyed by hostname, carrying pages, aiPages, disclosedPages, images, aiImages, a per-tool tally and firstSeen/lastSeen timestamps, retained for the 400 most recently seen domains with no expiry. The README describes this accurately as counters rather than URLs, but with lastSeen it is a browsing log at hostname granularity, which is the same category of data a history-sync feature would need consent for, kept by default. It is also readable in full for any host the caller names via srl:get-history with no sender check (see SEC-2), and lib/history.js:100 assigns into a plain object keyed by a hostname, which is fine today because location.hostname can never be __proto__ but is one refactor away from being unsafe.

Evidence:

```
lib/settings.js:25
  rememberDomains: true,     // keep local per-domain counters
lib/history.js:20-21
  return { host, pages: 0, aiPages: 0, ..., firstSeen: 0, lastSeen: 0 };
lib/history.js:100
  all[result.hostname] = fold(all[result.hostname], result, now);
```

**Recommendation.** Either default rememberDomains to false (which is what lib/history.js:6-7 already claims) or reword that comment; whichever way it goes, the code and the comment must agree. Round lastSeen to the day and add a 90-day prune alongside the 400-domain cap. Skip the Object.create(null) suggestion — the key is always location.hostname.

### BUG-4 · findVat recompiles 28 regexes per VAT-context hit, with no bound on the number of hits

**Severity:** Low · **Category:** reliability · **Effort:** small · **Where:** `lib/legitimacy.js:191`

findVat scans for VAT context words and, for each hit, compiles all 28 country VAT_FORMATS with new RegExp and runs each against a 60-character window. The `out.length < 6` guard only stops the loop once six numbers have been found, so a page with many context words and no valid VAT number runs the full 28-regex compile for every hit. Measured on the 300 KB body cap the content script allows: 'vat ' repeated takes 501 ms and 'nip ' repeated 472 ms of main-thread time inside analyzeLegitimacy (against roughly 10-40 ms for the other hostile shapes). analyze() re-runs on every location.href change (once-a-second poll), so an SPA-style page can make this jank repeat. It stays under the suite's 4-second budget, which is why test/redos.test.js does not catch it: neither 'vat' nor 'nip' is one of its six body shapes.

Evidence:

```
lib/legitimacy.js:191-207
  const ctx = new RegExp(VAT_CONTEXT_RE.source, 'gi');
  while ((m = ctx.exec(text)) && out.length < 6) {
    ...
    for (const [country, re] of Object.entries(VAT_FORMATS)) {
      const hit = new RegExp(re.source.replace(/-\?/g, '')).exec(window);
$ measured over a 300 000-char body: 'vat repeated' legitimacy 501 ms, 'nip repeated' 472 ms
```

**Recommendation.** Compile the stripped patterns once at module load (freeze the array) and bound the scan by context-hit count as well as by out.length. When adding 'vat '/'nip ' shapes to test/redos.test.js, assert against a per-analyser budget rather than tightening the shared 4 s one — the growth-ratio check in that suite is designed for backtracking and will not detect this class.

### CI-1 · CI actions unpinned, no lockfile, default-write token, and no repository security metadata

**Severity:** Low · **Category:** supply-chain · **Effort:** small · **Where:** `.github/workflows/test.yml:9`

The workflow uses actions/checkout@v4 and actions/setup-node@v4 by mutable tag (0 of 4 uses pinned to a SHA), installs Playwright at run time with `npm install --no-save playwright@1.56.1` rather than `npm ci`, and there is no lockfile, so playwright's transitive dependency graph is resolved fresh on every run — a compromised or typosquatted transitive package executes with whatever the workflow token grants. No top-level `permissions:` block is declared, so the GITHUB_TOKEN gets the repository default rather than `contents: read`. `npx playwright install --with-deps chromium` also downloads browser binaries over the network on every run. The repository has no LICENSE (which leaves the code legally unusable by anyone who clones it), no SECURITY.md, no Dependabot configuration and no CODEOWNERS. The blast radius is small — the workflow has no secrets and publishes nothing — but the fixes are one-liners.

Evidence:

```
.github/workflows/test.yml:9,10,22-23
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm install --no-save playwright@1.56.1
      - run: npx playwright install --with-deps chromium
(no `permissions:` key anywhere in the file; no package-lock.json in git ls-files)
```

**Recommendation.** As written. One caveat on the lockfile advice: package.json currently declares no dependencies at all and `npm test` needs none, so committing a lockfile means adding playwright as a devDependency, which changes `npm ci` on a bare checkout from instant to a browser-sized install. Pinning the two actions to SHAs and adding `permissions: { contents: read }` are the zero-cost half; do those first.

### MISSED-3 · An assertion reference whose hash is not a byte string is silently skipped, so a manifest can verify 'ok' with zero assertions actually checked

**Severity:** Low · **Category:** security · **Effort:** trivial · **Where:** `lib/c2pa-verify.js:280`

checkAssertions skips any assertion reference whose `hash` is not a Uint8Array before incrementing out.checked, so a claim whose hashed_uri entries carry the digest as a text string (or omit it) leaves checked at 0, rows empty and trustedLabels empty. summarize's assertion clause is gated on `a.checked`, so it prints nothing about assertions and returns ok:true purely on the signature; image-metadata's trustedLabels() then falls back to referencedAssertions, so every assertion the claim names is trusted anyway. The result is a green 'Signature verified' with the second of the extension's three advertised checks silently not performed — README:22 says 'each assertion's JUMBF box is re-hashed and compared with the hash the claim recorded', and README:30 says 'once hashes verify, only the assertions that matched are read'. C2PA requires a hash on every assertion reference and requires validation to fail when one cannot be checked. Low rather than higher because a forger who is already signing their own claim gains nothing they could not get by hashing honestly; it matters for spec conformance and for the 'unanswered question is never a pass' promise.

Evidence:

```
lib/c2pa-verify.js:277-283
    for (const ref of refs) {
      const label = String(ref.url || '').split('/').pop();
      const expected = ref.hash;
      if (!(expected instanceof Uint8Array)) continue;
      out.checked++;
lib/c2pa-verify.js:341  if (a && a.checked) { ... }        // whole assertion clause skipped when checked === 0
lib/c2pa-verify.js:363  ok: v.signature === 'valid' && !broken && !caution,
lib/image-metadata.js:684-687  if (v && v.trustedAssertionLabels && v.trustedAssertionLabels.length) return new Set(...); if (active.referencedAssertions) return new Set(active.referencedAssertions);
```

**Recommendation.** Count the reference before the type test and record it as inconclusive (or missing) rather than skipping it: `out.checked++; if (!(expected instanceof Uint8Array)) { out.inconclusive = true; continue; }`. Additionally, when refs.length > 0 but rows.length === 0, summarize should report caution rather than ok, so 'the claim named assertions and none of them could be checked' can never read as a pass.

### MISSED-4 · The service worker trusts caller-supplied byte caps, ignoring the normaliser that exists to clamp them

**Severity:** Low · **Category:** security · **Effort:** trivial · **Where:** `background/service-worker.js:143`

analyzeImages takes maxImageBytes/maxMediaBytes straight from msg.settings and applies only a floor: `Math.max(65536, settings.maxImageBytes || DEFAULTS.maxImageBytes)`. There is no ceiling, even though S.settings.normalize (lib/settings.js:29-40) already clamps these to 32 MB and 8 MB respectively and the module is imported at line 6. fetchBytes then buffers up to that many bytes per resource in chunks in the worker's heap, four at a time (CONCURRENCY = 4). A caller that sets maxImageBytes to 1e10 makes the worker accumulate until the service worker is killed for memory, taking the per-tab results with it. Today only extension contexts can send that message, which is why this is low, but it is the same missing-clamp pattern as SEC-2's missing sender check and it is one line to fix — and the msg.images array is likewise unbounded, so a single message can queue arbitrarily many fetches.

Evidence:

```
background/service-worker.js:142-144
  async function analyzeImages(images, settings) {
    const maxBytes = Math.max(65536, settings.maxImageBytes || S.settings.DEFAULTS.maxImageBytes);
    const maxMedia = Math.max(65536, settings.maxMediaBytes || S.settings.DEFAULTS.maxMediaBytes);
lib/settings.js:31-33  s.maxImageBytes = clampInt(s.maxImageBytes, 64 * 1024, 32 * 1024 * 1024, DEFAULTS.maxImageBytes);
background/service-worker.js:246-252 (chunks accumulated until total > maxBytes)
```

**Recommendation.** Run the incoming object through the normaliser that already exists: `const s = S.settings.normalize(settings || {});` and use s.maxImageBytes / s.maxMediaBytes. Cap images.length as well (the content script never sends more than six per message, so a bound of, say, 32 costs nothing).

### MISSED-5 · The image cache key truncates URLs at 2000 characters, so two long URLs sharing a prefix and a length share one provenance verdict

**Severity:** Low · **Category:** bug · **Effort:** trivial · **Where:** `background/service-worker.js:172`

The worker's cross-tab imageCache is keyed by `url.slice(0, 2000) + '#' + url.length` for URLs longer than 2000 characters. Two distinct resources whose URLs agree on the first 2000 characters and have the same total length therefore collide, and the second one is answered from the first one's parsed result — format, byte count, metadata, C2PA verification summary and all — with only the base {id, url} taken from the real request. That is realistic for long signed CDN URLs that differ only in a trailing token of fixed length, and for pages carrying several long data: URIs, and it produces the worst possible failure for a provenance tool: image B is reported with image A's credentials. The cache is also shared across tabs and origins and holds successes for the life of the worker, so the misattribution can cross pages.

Evidence:

```
background/service-worker.js:172-173
  const cacheKey = url.length > 2000 ? url.slice(0, 2000) + '#' + url.length : url;
  if (imageCache.has(cacheKey)) return { ...base, ...imageCache.get(cacheKey), cached: true };
background/service-worker.js:199-202  if (!failed) { if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value); imageCache.set(cacheKey, outcome); }
```

**Recommendation.** Key the cache on a digest of the whole URL rather than a prefix — the worker already has WebCrypto, so `await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url))` hex-encoded is a fixed-size, collision-free key — or simply do not cache URLs over the truncation length. Either keeps the memory bound the prefix was there to provide.

### BUG-3 · CBOR maps decode into plain objects, so an untrusted manifest can set the decoded object's prototype

**Severity:** Info (reported as low, adjusted after review) · **Category:** security · **Effort:** trivial · **Where:** `lib/cbor.js:46`

readItem builds maps as `const out = {}` and assigns `out[String(key)] = value`. A C2PA manifest inside an image on any page is fully attacker-controlled, so a map whose key is the text string "__proto__" replaces the decoded object's prototype with an attacker-supplied object rather than adding a property. Confirmed by hand-building the bytes: the decoded value has no own keys yet resolves v.alg to the injected value. This is object-local, not Object.prototype pollution, so nothing global is affected, and lib/c2pa-verify.js:162-165 correctly guards its one header lookup with Object.prototype.hasOwnProperty.call. The reachable effect is that later reads such as claim.alg (c2pa-verify.js:284), claim.assertions and content.actions can resolve to inherited values the attacker planted, which is a confusing footgun for anyone adding a new field read.

Evidence:

```
lib/cbor.js:46
  const put = () => { const k = readItem(st); const v = readItem(st); out[typeof k === 'string' ? k : String(k)] = v; };
$ node -e "decode(map{'__proto__': map{'alg':'sha512'}})"
  own keys: []
  v.alg (inherited via proto): sha512
  proto is attacker object: true
```

**Recommendation.** Keep the one-line fix (Object.create(null) for map decoding, or skip a '__proto__' key) and the regression test, but file it as hardening rather than a finding — nothing downstream currently gains anything from the inherited value.

*Reviewer note (confirmed, severity lowered):* The behaviour is exactly as described and I reproduced it byte-for-byte: decoding a CBOR map whose single key is the text string '__proto__' and whose value is a map yields an object with no own keys whose prototype is the attacker's map, so v.alg resolves to the injected value while Object.prototype is untouched. But no privilege boundary is crossed anywhere it is reachable. Every object built by this decoder is entirely attacker-authored to begin with — the COSE headers, the claim, and each assertion — so an inherited claim.alg or claim.assertions is worth exactly as much to an attacker as an own property they could have set directly, and the two lookups where a distinction could matter already use Object.prototype.hasOwnProperty.call (c2pa-verify.js:162-165, used by collectChain at :170). That makes it a latent footgun for whoever adds the next field read, i.e. informational, not a low-severity vulnerability.

## Upgrades

| Value | Effort | Upgrade | Now | Move to |
|---|---|---|---|---|
| high | trivial | Add a LICENSE file | No LICENSE anywhere; package.json has no license field; README says nothing about terms. | Add an explicit licence (MIT or Apache-2.0 suit a solo extension with no deps) and set "license" in package.json and a Licence line in the README. |
| high | trivial | Write PRIVACY.md and host a privacy policy URL for the Web Store | Privacy statements are spread across README.md, options.html and popup.html; there is no standalone policy and no URL to give the store. | Add PRIVACY.md covering what is fetched (media bytes, credentials omitted), what is stored (sync settings, session per-tab results, local per-domain counters), retention, and that nothing leaves the device; publish it via GitHub Pages and reference it in the store listing and in manifest 'homepage_url'. |
| high | trivial | Bump Node engines and pin the version with .nvmrc | package.json engines '>=18', README says 'Node >= 18', CI runs Node 22, no .nvmrc. | Set engines to '>=22', add .nvmrc with 22, and have setup-node read node-version-file so CI and README agree. |
| high | small | Add ESLint (flat config) and run it in CI | `npm run lint` is only `node --check` per file, which catches syntax errors and nothing else. | Add eslint with a flat config using js.configs.recommended plus browser/webextensions/node globals; enable no-undef, no-unused-vars, no-implicit-globals; run `eslint .` in the unit job. |
| high | medium | Make the manifest load in Firefox: gecko id, background.scripts fallback, optional-permission onboarding | manifest.json declares only background.service_worker and relies on importScripts; no browser_specific_settings; host_permissions assumed granted at install. | Add `browser_specific_settings.gecko: { id, strict_min_version: '128.0' }`; add `background.scripts: [lib/lexicons.js, ..., background/service-worker.js]` alongside service_worker (Chrome ignores scripts, Firefox ignores service_worker) and guard the importScripts call with `if (typeof importScripts === 'function')`; add an onboarding page that calls `chrome.permissions.request({ origins: ['<all_urls>'] })` because Firefox MV3 treats host_permissions as optional and will not run the content script until granted. Run `npx web-ext lint` in CI. |
| high | small | Add a packaging script, version-sync check and release section to CHANGELOG | *.zip is gitignored but nothing produces one; manifest.json and package.json both say 0.1.0 with no check that they agree; CHANGELOG has only 'Unreleased'. Note: the publisher/ directory is the self-check page, not store listing assets; there are no store screenshots or promo tiles in the repo. | Add scripts/package.js that zips manifest.json, lib/, background/, content/, popup/, options/, publisher/, icons/ only (no test/, scripts/, .github); add a `npm run check:version` that fails if the two versions differ; cut a 0.1.0 section in CHANGELOG; add a store/ folder with 1280x800 screenshots and a 440x280 tile. |
| medium | trivial | Add SECURITY.md with a disclosure route | No SECURITY.md; the changelog documents a real security fix (signature replay) but there is no way for a researcher to report the next one privately. | Add SECURITY.md naming a contact (or GitHub private vulnerability reporting), supported versions and the response expectation. |
| medium | small | Harden the CI workflow: permissions, SHA pins, concurrency, Dependabot for actions | .github/workflows/test.yml uses actions/checkout@v4 and actions/setup-node@v4 by tag, no permissions block, no concurrency group, no Dependabot config. | Add top-level `permissions: contents: read`, pin both actions to full commit SHAs with a version comment, add `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }`, and add .github/dependabot.yml for the github-actions ecosystem so pins are kept current. |
| medium | small | Make Playwright a pinned devDependency with a lockfile instead of an ad-hoc install | CI runs `npm install --no-save playwright@1.56.1` (October 2025 release); no devDependencies, no lockfile, so `npm ci` is impossible and the e2e environment differs from local. | Add playwright as a devDependency at the current 1.5x/1.6x release, commit package-lock.json, use `npm ci` in CI, and cache ~/.cache/ms-playwright keyed on the lockfile. Runtime stays dependency-free; only the dev toolchain gains a lockfile. |
| medium | medium | Type-check with tsc --checkJs and JSDoc on the shared result shapes | No types; the page-result object, signal objects and settings are implicit contracts shared by content.js, service-worker.js, popup.js and publisher.js. | Add a jsconfig.json with checkJs, strict and @types/chrome (dev only), declare the Signal, PageResult, ImageState and Settings shapes once in lib/types.d.ts via JSDoc typedefs, and run `tsc --noEmit` in CI. |
| medium | trivial | Report unit-test coverage with Node's built-in coverage | node:test with no coverage output; image-hints.js, settings.js and service-worker.js have no unit tests at all. | Run `node --test --experimental-test-coverage --test-coverage-include='lib/**'` in CI and fail below a floor (start at the current figure); zero new dependencies. |
| medium | trivial | Remove the web_accessible_resources entry for publisher.html (or set use_dynamic_url) | manifest.json exposes publisher/publisher.html to <all_urls> via web_accessible_resources. The popup opens it with chrome.tabs.create(chrome.runtime.getURL(...)), which does not need WAR. | Delete the web_accessible_resources block; if a page ever needs to link to it, add `use_dynamic_url: true`. |
| medium | large | Internationalise the UI with _locales and chrome.i18n | Detection covers eight languages but every popup, overlay, options and publisher string is hard-coded English; manifest has no default_locale. | Add _locales/en/messages.json plus de/fr/es/nl/it/pt/pl, set default_locale, use chrome.i18n.getMessage in the four UIs and __MSG_ keys in manifest name/description; ship store listings in the same languages. |
| medium | small | Serve image fetches from the HTTP cache before falling back to Range requests | background/service-worker.js fetchBytes always sends `Range: bytes=0-N`, which bypasses the HTTP cache, so every image the page already downloaded is downloaded a second time. | Try `fetch(url, { cache: 'force-cache', credentials: 'omit' })` first, stream and cancel at maxBytes; only if that misses or the body is very large fall back to the Range request. Keep the suffix-range tail fetch for media. |
| medium | small | Accessibility pass on the in-page overlay and popup | Overlay popover (.pop) has no role='dialog', focus is not moved into it or returned on close; the pill toggles the panel without aria-expanded; popup tab count badges (.n) are bare numbers with no accessible context; the quiet-mood opacity transition ignores prefers-reduced-motion. | Give .pop role='dialog' aria-modal='false' with aria-labelledby on the header, focus the close button on open and restore focus on Escape; set aria-expanded on the pill and aria-controls to the panel; render counts as `<span class='n' aria-label='3 flagged'>3</span>`; wrap transitions in @media (prefers-reduced-motion: no-preference). |
| medium | medium | Use Element.checkVisibility and CSS anchor positioning instead of per-block getComputedStyle and a JS reposition loop | content.js isRendered calls getClientRects + getComputedStyle for up to 600 blocks per pass; overlay.js repositions every marker with getBoundingClientRect on every scroll frame plus a 1200 ms setInterval for the page lifetime. | Replace isRendered with `elm.checkVisibility({ visibilityProperty: true })` (Chrome 105+, Firefox 106+); for badges use CSS anchor positioning (`anchor-name` on a per-element attribute, `position-anchor` on the badge; Chrome 125+) with the existing rAF loop as the fallback, and drop the interval in favour of a ResizeObserver on document.documentElement. |
| medium | small | Use Playwright's supported headless extension mode and replace fixed sleeps | test/e2e/run.js launches with headless:false plus a manual '--headless=new' arg and uses 12 `waitForTimeout` fixed sleeps (3-4 s each), so the suite is slow and timing-dependent. | Launch with `channel: 'chromium'` (supported for extensions since Playwright 1.49) and replace each sleep with a polling helper that waits until the stored `tab:<id>` result exists and `images.pending === 0`; capture a screenshot and the SW console on failure. |
| medium | small | Update the Article 50 framing now that the application date has passed | README, popup footer, overlay footer and publisher page all say Article 50 obligations 'apply from 2 August 2026'; today is after that date. None mention the Commission's Article 50 guidelines or the Code of Practice on marking and labelling, nor the November 2025 Digital Omnibus proposal that would give a transitional period for the Art. 50(2) marking duty for generative systems already on the market. | Reword to 'in force since 2 August 2026'; add one sentence noting that the Art. 50(2) provider marking duty may be subject to a transitional period under the Digital Omnibus if adopted (verify current status before publishing) while the Art. 50(4) deployer duties are unaffected; link the Commission guidelines/Code of Practice. Keep the legal text in one shared string (lib/legal-text.js) so the four copies cannot drift. |
| medium | small | Prepare the store listing for the single-purpose and broad-permissions reviews | The extension has <all_urls> host permission, a content script on every http/https/file page, and a Trader tab (consumer-law checks) that a reviewer may see as a second purpose beside AI disclosure. | Write the listing and permission justification around one purpose ('trust signals for the page you are reading: AI provenance and who is behind it'); explain the <all_urls> need (cross-origin media bytes) in the justification field; consider offering an 'on demand' mode using activeTab + optional_host_permissions for users who refuse broad access. |
| low | medium | Safari packaging via safari-web-extension-converter | No Safari build; README targets Chrome, Edge and Brave only. | Add a documented `xcrun safari-web-extension-converter` step and a scripts/safari.sh; keep the existing `chrome.action.setBadgeTextColor &&` guard (Safari lacks it) and feature-detect chrome.storage.session with a storage.local fallback for older Safari. |
| low | trivial | Align minimum_chrome_version with the APIs actually used | minimum_chrome_version '116' and README 'Chrome 116 or newer', but WebCrypto Ed25519 (used for COSE alg -8 and cert OID 1.3.101.112) shipped unflagged in Chrome 137, and Element.checkVisibility / CSS anchor positioning proposed below need 105 / 125. | Either raise minimum_chrome_version to 137 and say so, or keep 116 and document that Ed25519-signed credentials report 'unsupported' on older Chrome. Add a tiny unit test asserting COSE_ALGS entries all have a WebCrypto mapping. |
| low | small | Replace the 1-second href polling with the Navigation API and popstate | content.js runs `setInterval` every 1000 ms for the tab's lifetime to detect SPA navigation by comparing location.href. | Listen to `navigation.addEventListener('navigatesuccess')` where available (Chrome 102+), falling back to popstate/hashchange plus a wrapped history.pushState, and keep a much slower safety poll. |
| low | trivial | Add .editorconfig and Prettier (check-only) for consistent formatting | No formatter or editor config; files are consistently 2-space but that is by discipline only. | Add .editorconfig and a prettier check script (printWidth 160 to match the existing long-line style), run in CI. |

- **Add a LICENSE file** (high value, trivial, `/home/user/selfreportle/package.json`). Without a licence nobody may legally reuse, fork or redistribute the code, the Chrome Web Store and AMO listings ask for it, and GitHub cannot display it. Trivial and blocks every kind of adoption.
- **Write PRIVACY.md and host a privacy policy URL for the Web Store** (high value, trivial, `/home/user/selfreportle/README.md`). Chrome Web Store requires a privacy policy for any extension with broad host permissions or that handles user data; <all_urls> plus per-domain history qualifies on both counts. The content already exists, it just needs one canonical document.
- **Bump Node engines and pin the version with .nvmrc** (high value, trivial, `/home/user/selfreportle/package.json`). Node 18 reached end of life in April 2025 and Node 20 in April 2026; the test runner already relies on Node 21+ glob support in `node --test "test/*.test.js"`, so the stated floor is wrong.
- **Add ESLint (flat config) and run it in CI** (high value, small, `/home/user/selfreportle/package.json`). The confirmed ReferenceError in lib/attribution.js attributeSite (assignment to undeclared `p` on the ai-host branch) is exactly what no-undef reports; the unused PHONE_RE and AI_TEXT_TOOLS would be flagged by no-unused-vars. Cheapest possible bug net for a plain-JS codebase.
- **Make the manifest load in Firefox: gecko id, background.scripts fallback, optional-permission onboarding** (high value, medium, `/home/user/selfreportle/manifest.json`). Every API the extension uses (storage.session, action.setBadgeTextColor, contextMenus, commands, DecompressionStream, WebCrypto Ed25519) is available in current Firefox; only the manifest shape and the permission model differ. This is the cheapest route to a second store and to the EU audience Firefox still has.
- **Add a packaging script, version-sync check and release section to CHANGELOG** (high value, small, `/home/user/selfreportle/package.json`). The changelog says nothing has shipped to a store; these are the mechanical prerequisites for doing so and for reproducible uploads later.
- **Add SECURITY.md with a disclosure route** (medium value, trivial). This project verifies signatures and tells people whether media is trustworthy; that is exactly the kind of code that attracts security researchers, and the replay hole shows the class of bug is real.
- **Harden the CI workflow: permissions, SHA pins, concurrency, Dependabot for actions** (medium value, small, `/home/user/selfreportle/.github/workflows/test.yml`). Tag-pinned actions are mutable and the default token is read/write; both are cheap to fix and are the standard supply-chain baseline for a project that ships to app stores.
- **Make Playwright a pinned devDependency with a lockfile instead of an ad-hoc install** (medium value, small, `/home/user/selfreportle/.github/workflows/test.yml`). Reproducible e2e runs and a Dependabot-updatable browser driver; the project's 'no dependencies' principle applies to the shipped extension, not to test tooling.
- **Type-check with tsc --checkJs and JSDoc on the shared result shapes** (medium value, medium). Six consumers of the same untyped objects (e.g. `it.metadata.c2pa.verification.summary`) is where silent undefined-property bugs live; JSDoc typing needs no build step and keeps the plain-script architecture.
- **Report unit-test coverage with Node's built-in coverage** (medium value, trivial, `/home/user/selfreportle/package.json`). Makes the untested modules visible and stops coverage regressing as pattern catalogues grow.
- **Remove the web_accessible_resources entry for publisher.html (or set use_dynamic_url)** (medium value, trivial, `/home/user/selfreportle/manifest.json`). Any website can probe chrome-extension://<id>/publisher/publisher.html and fingerprint that this extension is installed, contradicting the README's 'a web page cannot talk to it' claim.
- **Internationalise the UI with _locales and chrome.i18n** (medium value, large, `/home/user/selfreportle/manifest.json`). The product's stated audience is EU readers meeting disclosures in their own language; an English-only report undercuts that and store search is per-locale.
- **Serve image fetches from the HTTP cache before falling back to Range requests** (medium value, small, `/home/user/selfreportle/background/service-worker.js`). Halves bandwidth on image-heavy pages and reduces the visible cost of the extension to CDNs and to users on metered connections; no behaviour change in the parser.
- **Accessibility pass on the in-page overlay and popup** (medium value, small, `/home/user/selfreportle/content/overlay.js`). The README advertises 'keyboard throughout' and a colour-blind-safe palette; the remaining gaps are focus management and announcement, which screen-reader users hit immediately.
- **Use Element.checkVisibility and CSS anchor positioning instead of per-block getComputedStyle and a JS reposition loop** (medium value, medium, `/home/user/selfreportle/content/content.js`). Removes the main forced-layout cost the extension adds to long pages and the always-on timer on every tab.
- **Use Playwright's supported headless extension mode and replace fixed sleeps** (medium value, small, `/home/user/selfreportle/test/e2e/run.js`). Cuts a ~40 s run to a few seconds and removes the main source of CI flakiness.
- **Update the Article 50 framing now that the application date has passed** (medium value, small, `/home/user/selfreportle/README.md`). A legal-framing tool that states a future date after the date has passed looks unmaintained, and the marking-duty timeline is exactly the point readers will check.
- **Prepare the store listing for the single-purpose and broad-permissions reviews** (medium value, small, `/home/user/selfreportle/manifest.json`). Broad host permissions trigger manual review and the single-purpose policy is the commonest rejection reason for multi-tab utilities; a prepared justification avoids a round-trip.
- **Safari packaging via safari-web-extension-converter** (low value, medium). The codebase has no Chrome-only dependencies beyond those two calls, so the port is mostly packaging; worth doing after Firefox since it needs an Apple developer account.
- **Align minimum_chrome_version with the APIs actually used** (low value, trivial, `/home/user/selfreportle/manifest.json`). The Ed25519 path is silently caught today (`signature: 'unsupported'`), which is honest but undocumented; the README promises Ed25519 support unconditionally.
- **Replace the 1-second href polling with the Navigation API and popstate** (low value, small, `/home/user/selfreportle/content/content.js`). One fewer permanent timer per tab; the Navigation API is the purpose-built signal.
- **Add .editorconfig and Prettier (check-only) for consistent formatting** (low value, trivial). Low cost; mainly matters once contributors or automated refactors touch the pattern catalogues.

## Features worth adding

- **Ship a C2PA trust list so verified signatures can be anchored** (high value, medium). The README states four times that no trust list ships and the root is never anchored. Bundle the public C2PA conformance trust list (the known-certificate PEM bundle published by the C2PA conformance program) plus a user-importable anchors box in options; in lib/c2pa-verify.js checkChain, hash each chain certificate's DER and compare against the bundle, set `anchored: true` with the matching anchor name, and have image-metadata.js deriveSignals emit a distinct 'c2pa-anchored' signal so verdicts, popup verificationRow and the receipt can say 'signer verified as X'. Keep the current 'intact, not anchored' wording for the unanchored case. Add a scripts/update-trust-list.js that records the bundle's source URL and date.
- **Verify the hard binding (c2pa.hash.data / c2pa.hash.bmff) so a transplanted manifest is caught** (high value, large). Today a manifest copied byte-for-byte from a genuine AI image onto a photograph (or vice versa) reports 'Signature verified' because only the claim and assertions are checked, never the pixels. When the fetch was not truncated, parse the c2pa.hash.data assertion (exclusions list plus hash) in lib/image-metadata.js parseManifest, compute SHA-256 over the asset bytes minus the exclusion ranges (for JPEG/PNG/WebP) or implement the bmff.v2 box-hash for ISOBMFF, and add a `binding: 'valid'|'invalid'|'unchecked'` field to the verification result; a mismatch must be 'broken'. Hook: c2pa-verify.verifyManifest gets the asset bytes as an option; the service worker passes `truncated` so the check is skipped rather than failed when the cap was hit.
- **A calibration corpus and precision regression test for stylometry** (high value, medium). The verdict thresholds in lib/text-analyzer.js (0.75/0.45/0.22, lexScore = clamp((points-6)/22)*0.42, CV cut-offs 0.28/0.38) have no recorded basis. Add test/corpus/{human,llm}/<lang>/*.txt (a few dozen short public-domain or self-written human samples and LLM samples per language) and a test that asserts a maximum false-positive rate on the human set and a minimum recall on the LLM set at each sensitivity, printing the confusion matrix. This turns every lexicon edit into a measurable change and is the only way to justify the sensitivity setting to users.
- **Evaluate certificate validity at signing time using the COSE timestamp (sigTst / sigTst2)** (medium value, medium). checkChain compares notBefore/notAfter with `new Date()`, so any credential whose certificate has since expired is reported 'certificate expired' even though C2PA treats a trusted RFC 3161 timestamp as proof it was signed while valid. Parse the sigTst / sigTst2 unprotected header in lib/c2pa-verify.js, decode the TimeStampToken's genTime (the DER/CMS reader in lib/x509.js can be extended for the SignedData envelope), verify the timestamp signature when its certificate is present, and use that instant for the validity comparison; report 'validity checked at signing time (timestamped)' versus 'at time of viewing'. Add fixtures in test/helpers.js with a synthetic timestamp token.
- **Read remote and sidecar manifests** (medium value, medium). C2PA allows the manifest to live outside the file: an HTTP `Link: <url>; rel="c2pa-manifest"` response header, an XMP `dcterms:provenance` pointer, or a sibling `.c2pa` file. The service worker already has the response headers in fetchBytes; return the Link header, and in analyzeOne fetch the referenced manifest (same byte cap and credentials:'omit') and run it through extractC2pa + verifyManifest with a `remote: true` flag that the popup surfaces as 'credentials referenced, not embedded'. Extend lib/image-metadata.js parseXmp to capture dcterms:provenance.
- **Analyse embedded frames (YouTube, social and media embeds)** (medium value, medium). content.js returns immediately when `window.top !== window`, so media inside iframes (YouTube embeds, Instagram embeds, ad units) is never inspected and platform labels inside embeds are missed. Set `all_frames: true` in the manifest, let child frames run only collectImages/collectMedia/applyPlatformLabels (not text or trader analysis), and post their image states to the top frame via chrome.runtime messaging keyed by frameId; the top frame merges them into imageState before refreshSummary. The badge/overlay stays in the top frame; nested badges can be skipped initially.
- **Add the remaining major EU languages to the lexicons** (medium value, medium). lib/lexicons.js covers de/fr/es/nl/it/pt/pl while lib/legitimacy.js already carries Swedish, Danish and Finnish imprint/terms/privacy words, so the trader checks outrun the text checks. Add sv, da, fi, cs, ro, el and hu packs with the same shape (disclosures at four levels, tier1/tier2, selfRefStrong/Medium) and MARKERS function-word sets; reuse the Polish explicit letter-class approach for cs/hu/ro diacritics and add Greek script handling to countWords/splitSentences. The 'every language pack is well formed' test in test/lexicons.test.js enforces the shape automatically.
- **Tell the reader whether an Article 50 disclosure duty plausibly applies** (medium value, small). The reader popup's strongest verdict is 'AI signals without disclosure' in vermillion, but publisher.js already explains that most pages carry no legal duty to disclose. Reuse that duty logic on the reader side: in popup.js overviewPanel add an 'Article 50 applicability' row that classifies the page (JSON-LD @type NewsArticle/Article plus site-analyzer generator, versus product/shop signals from legitimacy.detectCommerce, versus media that looks like real people or events) and states one of 'deployer disclosure duty likely applies', 'probably no duty; disclosure is good practice', or 'cannot tell', with the reason. Adjust trustHint('undisclosed-ai') so 'without disclosure' does not read as 'unlawful'.
- **First-run onboarding page explaining permissions and privacy** (medium value, small). On chrome.runtime.onInstalled with reason 'install', open onboarding/onboarding.html that explains the three permissions in the README's own words, shows the display moods, lets the user decide 'remember per-domain counters' (currently on by default with a lib/history.js comment claiming otherwise), and, on Firefox, requests the optional <all_urls> host permission. Hook: background/service-worker.js onInstalled listener; reuse options.js fill/read for the two settings shown.
- **Detect TIFF/DNG containers** (low value, trivial). lib/image-metadata.js detectFormat recognises JPEG, PNG, WebP, ISOBMFF, GIF and SVG but not bare TIFF/DNG (`II*\0` / `MM\0*`), even though parseTiff already exists and DNG is common on photography sites that care about provenance. Add the magic check, route to parseTiff on the whole buffer plus the generic XMP/JUMBF scans, and add a fixture using H.tiff in test/image-metadata.test.js.
- **Link out to Content Credentials Verify and expose the raw manifest** (low value, trivial). Beside the reverse-image links in popup.js lookupLinks, add a 'Verify at contentcredentials.org' link for images that carry a manifest, and a 'Copy manifest JSON' button that copies the trimmed c2pa object (claim generator, actions, signer, verification) so readers can cross-check the extension's reading against Adobe's verifier. Both are user-initiated links, consistent with the existing privacy stance.
- **Retry and explain unreachable media** (low value, small). Images that fail to fetch get an 'unavailable' signal with a truncated error string and no recovery. In content.js applyImageVerdict, when st.signals has only 'unavailable', add a 'Retry' action in the popover (overlay.js details can carry an action callback) that re-sends the single image with the same forced path used by inspectImage, and classify the failure (CORS/opaque response, HTTP 403 hotlink protection, timeout) so the publisher page's 'Media is reachable' check and the reader's popover can name the cause.

## Code quality

- **ReferenceError in attributeSite aborts analysis of every ai-host site** (high value, trivial, `/home/user/selfreportle/lib/attribution.js`). In attributeSite the ai-host branch does `p = matchProfile(s.builder.name, ['site'])` but `p` is only declared with `const` inside the earlier ai-builder block, so in strict mode this throws `ReferenceError: p is not defined` (confirmed with node: attributeSite({builder:{name:'Replit',kind:'ai-host'},signals:[]}) throws). content.js analyze() calls attributeSite with no try/catch, so on any *.replit.app / *.repl.co page with no other signal the whole analysis dies, nothing is stored and the popup says 'Nothing analysed yet'. Fix: `const p = ...` in that branch; add a test in test/attribution.test.js for the ai-host path and wrap the per-layer attribution calls in content.js so one attributor cannot take the page down.
- **Common-word tool names in AI_IMAGE_TOOLS produce caption false positives** (high value, small, `/home/user/selfreportle/lib/signals.js`). image-hints.js runs matchTools(AI_IMAGE_TOOLS, alt+title+caption) and emits a 0.45 'caption-tool' signal, which alone yields verdict 'suspected' and flips the page to 'weak-ai'. Confirmed: alt 'Imagen del producto' (Spanish for image) -> Google Imagen; 'Model walking the runway' -> Runway; 'Veo la ciudad' (Spanish 'I see') -> Google Veo; 'Sora Tanaka, portrait' -> Sora. Pika, Kling, Luma, Krea, Lexica and Firefly are similarly exposed. Fix: for caption text require the tool name to appear with a generation verb or 'with/by' context (reuse DISCLOSURE_PATTERNS' AI_TOOL_WORDS), or split the list into 'safe on prose' and 'metadata-only' names; add these strings to test/false-positives.test.js. The existing exclusion list (Gemini|Grok|Meta AI|Replicate|Hugging Face|Canva) shows the problem was half-seen.
- **Missing tests for critical paths** (high value, medium, `/home/user/selfreportle/test`). Add: (1) test/x509.test.js for timeOf with UTCTime and seconds-less GeneralizedTime (the changelog fix has no regression test; grep finds no GeneralizedTime coverage) and for readTLV long-form lengths; (2) c2pa-verify cases for RS256/PS256/Ed25519 signers (only ES256 is exercised; helpers.js makeKeyPair is P-256 only); (3) test/image-hints.test.js covering caption disclosure, human caption, host, filename/path and svg branches (module has zero tests); (4) test/settings.test.js for normalize clamping, invalid mood/sensitivity and isHostDisabled subdomain logic; (5) service-worker fetchBytes/analyzeOne extracted into lib/fetch-bytes.js and tested with a stubbed fetch for the content-range truncation flag, 206 handling and tail fallback; (6) image-metadata cases for zTXt, eXIf, extended-XMP reassembly, SVG comments, GIF, and a top-level ISOBMFF uuid box; (7) verdicts.overall cases for site.disclosed and scope coverage; (8) attribution.attributeSite ai-host branch (currently throws).
- **Overlapping lexicon entries double- and triple-count the same phrase** (medium value, small, `/home/user/selfreportle/lib/signals.js`). LEXICON_TIER1 contains both /\bin the realm of\b/ and /\bthe realm of\b/, both /\bmyriad\b/ and /\ba myriad of\b/, and 'dive into' / 'deep dive' / "let's dive" variants, while LEXICON_TIER2 adds /\brealm\b/; confirmed: a text repeating 'in the realm of' scores 1167 points per 1k words with the detail listing the phrase twice. Deduplicate so each token is counted once (longest match wins, or make the sub-phrases negative-lookbehind the super-phrase), and add a test that no two tier entries match the same span of a fixed sentence.
- **Markdown-leak scoring runs over <pre> and code blocks** (medium value, small, `/home/user/selfreportle/content/content.js`). BLOCK_SEL includes `pre`, and analyzeText scans it for MARKDOWN_LEAK_PATTERNS and SELF_REFERENCE patterns, so documentation pages showing markdown syntax or shell examples with ``` fences are flagged (confirmed: a snippet with **bold**, ###, a fence and a citation marker scores 'possible-ai' via markdown-leak). Exclude `pre`, `code`, `kbd`, `samp` from the markdown/self-reference checks (keep hidden-character scanning, which is still meaningful there), and add a case to test/false-positives.test.js.
- **Stale 'parsed, not verified' copy contradicts the shipped verifier** (medium value, trivial, `/home/user/selfreportle/popup/popup.js`). popup.js trustHint('provenance') says 'Credentials were parsed, not cryptographically verified', buildReport's caveats array says 'C2PA signatures are parsed, not cryptographically verified', the PNG receipt footer prints 'signatures parsed, not verified', and the header comment of lib/image-metadata.js still lists it as a limitation. All four predate lib/c2pa-verify.js. Replace with the README's accurate wording ('signature verified against the embedded certificate; root not anchored') and, for the exported report, include the per-image verification summary instead of a blanket caveat. Consider one shared string in lib/verdicts.js so these cannot drift again.
- **historySeen dedupe is keyed by hostname and lives only in worker memory** (medium value, small, `/home/user/selfreportle/background/service-worker.js`). content.js posts srl:page-result several times per page load (every refreshSummary debounces a postResult). recordHistory dedupes with historySeen.get(hostname) === url+'|'+at, so two tabs loading the same host concurrently alternate stamps and each post re-records (A, B, A, B ... each counted as a new page), and the Map is empty again whenever the service worker is restarted mid-page. Key the dedupe by tabId+stamp (or keep a small Set of recent stamps) and persist it in chrome.storage.session; add a unit test with interleaved posts from two tabs.
- **content.css text-marker colours diverge from the verdicts palette** (medium value, trivial, `/home/user/selfreportle/content/content.css`). The left-bar colours (#d64545, #e07b1a, #b8b400, #c99a00, #2f9e5f) are not the Okabe-Ito-derived palette in lib/verdicts.js (#c43d0f, #a24c7e, #8a6d00, #a56200, #0b7a5b), and likely-ai is orange on the bar but purple on its badge. Generate content.css from V.COLORS (or set the CSS custom property from overlay.js upsertMarker using info.color) so the two never disagree.
- **extractCertNames re-implements X.509 name parsing with a byte scan** (medium value, small, `/home/user/selfreportle/lib/image-metadata.js`). extractCertNames/derNames scan the DER for OID byte patterns and take the last CN/O, with a comment admitting it relies on issuer-before-subject ordering; lib/x509.js parseCertificate is already loaded in the same contexts and returns subject.cn/o properly. Replace with X509.parseCertificate(cert).subject and delete derNames; it removes about 30 lines and a heuristic that a crafted certificate could mislead.
- **JSON-LD is interpreted with regular expressions rather than JSON.parse** (medium value, small, `/home/user/selfreportle/lib/site-analyzer.js`). analyzeSite matches creator/author/digitalSourceType/aiGenerated inside the raw JSON-LD text, so the 'namedPerson' guard triggers on any Person anywhere in the graph, nested @graph arrays are conflated, and a value in a different key with the same name is read. JSON.parse each block (try/catch), walk the graph, and read the fields structurally; keep the regex path only as a fallback for malformed blocks. Extend test/site-analyzer.test.js with a @graph fixture containing both a Person author and an Organization creator named 'ChatGPT'.
- **Undocumented magic numbers in the text analyser** (medium value, small, `/home/user/selfreportle/lib/text-analyzer.js`). Verdict cut-offs 0.75/0.45/0.22, the lexicon formula clamp((points - 6) / 22) * 0.42, the 0.55 soft-score cap, burstiness CV thresholds 0.28/0.38 with mean >= 12, tricolon ratio 0.3, em-dash 1.2 per 100 words and the 50/120-word minimums are all bare literals. Hoist them into a named THRESHOLDS object with a one-line rationale each, export it for the calibration test, and reference it from the README's 'Stylometry is a heuristic' note.
- **Reposition loop and always-on timers scale with marker count** (medium value, small, `/home/user/selfreportle/content/overlay.js`). reposition() calls getBoundingClientRect for every marker on every scroll frame (up to 600 text + 60 image markers) and a 1200 ms setInterval runs for the life of every tab even with zero markers; content.js adds a 1000 ms href poll. Track visibility with an IntersectionObserver so only on-screen markers are repositioned, start the interval only while markers exist, and see the Navigation API and CSS anchor-positioning upgrades.
- **contextMenus.create errors are not caught by the surrounding try/catch** (low value, trivial, `/home/user/selfreportle/background/service-worker.js`). chrome.contextMenus.create reports duplicate-id failures through chrome.runtime.lastError in a callback, not by throwing, so the try/catch in onInstalled does nothing and every extension update logs 'Unchecked runtime.lastError'. Call chrome.contextMenus.removeAll() first, or pass a callback that reads lastError.
- **Dead code and unused exports** (low value, trivial, `/home/user/selfreportle/lib/legitimacy.js`). PHONE_RE in lib/legitimacy.js is defined and never used (phoneInText has its own patterns); AI_TEXT_TOOLS in lib/signals.js is exported and consumed nowhere; the AI_IMAGE_HOSTS entry for googleusercontent.com with weight 0.0 is filtered out at definition time; the `[data-srl-hidden="1"]` rule in content/content.css is never set by any script; S.overlay.stripInvisible is exported but only used internally. Remove them or wire them up (AI_TEXT_TOOLS could back the Article 50 applicability row).
- **Duplicated DOM and byte helpers across the four UIs and the worker** (low value, small, `/home/user/selfreportle/popup/popup.js`). el() is defined in overlay.js, popup.js and publisher.js; tint() and flash() in popup.js and publisher.js (and a variant in options.js); concat() exists in lib/image-metadata.js and test/helpers.js while service-worker.js fetchBytes reimplements it inline; toBase64/fromBase64 sit in content.js and service-worker.js. Add lib/dom.js (el, tint, flash) and lib/bytes.js (concat, base64) in the same UMD shape and load them where needed.
- **history.js says domain memory is off by default; settings.js turns it on** (low value, trivial, `/home/user/selfreportle/lib/history.js`). The module comment reads 'off by default for anyone who would rather keep no record' while lib/settings.js DEFAULTS.rememberDomains is true, and README/options describe it as a setting without stating the default. Decide (privacy-by-default argues for false, or for asking on first run) and make comment, README and DEFAULTS agree.
- **Invisible characters written literally in source** (low value, trivial, `/home/user/selfreportle/lib/text-analyzer.js`). The ZERO_WIDTH map keys, the JOINER_SCRIPT_RE class and comparisons like `ch === '\u00AD'` are written as the literal invisible characters, which editors render as empty strings and diffs cannot show. Use \uXXXX escapes (the same file already does so for the tag-character range).
- **popup.js and content.js are the two largest files and mix concerns** (low value, medium, `/home/user/selfreportle/popup/popup.js`). popup.js (713 lines) holds tab plumbing, six panel renderers, export/report building, SHA-256 digest and a canvas receipt painter; content.js (565 lines) holds lifecycle, snapshot, text, image, media, platform-label and reporting logic. Split popup into popup/panels/*.js and popup/export.js, and content into content/snapshot.js, content/text.js, content/images.js loaded in manifest order; no behaviour change, but it makes the untested UI code reviewable and lets the receipt/export code get unit tests under jsdom-free Node (buildReport is pure apart from chrome.runtime.getManifest).
- **Ignore the e2e fixture output directory** (low value, trivial, `/home/user/selfreportle/.gitignore`). test/e2e/fixtures.js writes to test/e2e/site when run directly, and that directory is not in .gitignore, so a local fixture build would be committed by a careless `git add -A`. Add test/e2e/site/ (and the Playwright profile dir if it is ever moved out of tmp).

## Shared across all Platteration repositories

The same gaps recur in every repository; fixing them once as a template and copying it is cheaper than fixing them fourteen times.

### CI and supply chain

1. **No workflow sets `permissions:`** (except the two Pages deploy jobs). Add `permissions: { contents: read }` at the top of every workflow so the `GITHUB_TOKEN` handed to third-party actions cannot write to the repository.
2. **No action is pinned to a commit SHA** (0 of 50 `uses:` lines across the fourteen repositories). `actions/checkout@v4` follows a movable tag; pin to the full 40-character SHA with the version in a comment, and let Dependabot bump it.
3. **No repository has Dependabot or Renovate.** Add `.github/dependabot.yml` with `npm` (or `pip`) and `github-actions` ecosystems, weekly.
4. **No CI step runs `npm audit`** (two workflows pass `--no-audit` explicitly). Add `npm audit --audit-level=high` after `npm ci`; for the Expo apps the current transitive advisories are build-time only (`uuid` via `xcode` via `@expo/config-plugins`), so gate on `high` rather than `moderate` until Expo ships the fix.
5. **`tvsham` runs `npm ci || npm install` in CI and in its Dockerfile.** The fallback silently discards the lockfile guarantee; drop it and fix the lockfile instead.
6. **`selfreportle`, `simplacad` and `phonogeometry` have no lockfile** and install Playwright ad hoc in CI. Add a `package-lock.json` (even with devDependencies only) and use `npm ci`.
7. **Enable secret scanning and push protection** in each repository's settings; nothing is committed today, and this keeps it that way.

### Repository hygiene

8. **Ten repositories have no `LICENSE`** (battleshiple, collectcollect, drawdraw, multidcheckers, multidconnect4, notenote, randostats, selfreportle, simplacad, tvsham). Without one, nobody else may legally use or contribute to the code. The siblings that have one use MIT.
9. **Only `simplacad` has a `SECURITY.md`.** Copy it to the others with a private reporting address.
10. **No repository has a `main` branch.** In all fourteen the default branch is the original `claude/...` feature branch, so branch protection, Dependabot targets and the two GitHub Pages workflows (`abientnoiser`, `chesscheatser` both trigger on `main`/`master`) all point at a branch that does not exist; those deploys have never run. Create `main` from the current branch, make it the default, and protect it.
11. **`drawdraw` is the one repository still on Expo SDK 53** (the rest are on 57). Its eight high-severity `npm audit` findings (`image-size`, `metro`) disappear with the SDK upgrade; it is also the only app not written in TypeScript and the only one pinned to Node 20 in CI.
12. **`multidcheckers` and `multidconnect4` are near-identical copies** (same branch name, same 65-file layout, same dependencies). The timeline/multiverse engine, persistence and share code should live in one shared package so fixes land in both.

### A hardened workflow to copy

```yaml
name: CI
on:
  push:
    branches: ["**"]
  pull_request:
permissions:
  contents: read
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - uses: actions/checkout@<full-sha> # v4
      - uses: actions/setup-node@<full-sha> # v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm audit --audit-level=high
      - run: npm run lint --if-present
      - run: npm run typecheck --if-present
      - run: npm test
```
