# For Claude: Tells

See the tells of AI in a post, a page, a picture or a video. Paste text, give
a link, drop a picture or a video, and Tells shows the **evidence**: the exact
passages that read as model-written and why, what the file's metadata says
about where it came from, what a visual read noticed, and - scored
separately - how original the ideas are, with the earlier sources a web
search found. A likelihood with a confidence band, never a verdict.

Built 2026-09-27 at Erik's request (the same day as Tipout, so two drops share
that date): "an ai detector where you can pass it text a link or picture or
anything else ... highlighting the specific parts that are likely ai and give
it a score. Want to know if the ideas are original or not. So think also
plugin for LinkedIn post twitter anything else." His choices: its own app in
the lab; the result reads as **signals + likelihood**; plugins as a LinkedIn +
X Chrome extension, right-click on any page, an iPhone share-sheet Shortcut,
and (added mid-build) a bookmarklet for Safari and Chrome; uploads of videos,
links and pictures. **Staging only**: no custom domain until Erik decides.

**Where it lives:** `challenge/apps/tells`, served at
`challenge.strongtechnicalconsulting.com/tells/`, data in `tells_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md`. Every browser URL is
relative to `BASE`; keep it that way.

## The honesty spine (why there is no verdict)

AI-text detection is unreliable. It false-flags human writing - especially
people writing in a second language, and polished professional prose - and
light editing makes AI text pass. A bare "87% AI" aimed at a real person's
post is an accusation, not a measurement. So:

- The meter is **"Reads as AI" 0-100 with a confidence and a range**
  (low ±25, medium ±15, high ±7), always drawn next to the passages and
  signals that drive it, and always with `LIMITS_LINE`: "A signal, not proof.
  Formal human writing can score high; edited AI text can score low." The
  page, the extension panel, the Shortcut's text answer and the server's
  `plainSummary` all carry it. The words "is AI", "written by AI" and "fake"
  never appear as a verdict (tested over every rule reason).
- The **quick scan is always low confidence.** The deep read is capped at
  medium under 80 words. A **visual read is never high** and is labelled "a
  weak signal". **Metadata naming an AI generator is the one strong signal**
  (Content Credentials, IPTC `trainedAlgorithmicMedia`, generator settings)
  and the page says so; camera EXIF "points to a camera" and says it is easy
  to write.
- The deep-read prompt tells the model the limits and not to score formal,
  academic, legal or non-native writing as AI on formality alone.
- **Originality is scored separately** (0-100), from sources the search
  actually returned, with what overlaps (idea / phrasing / near-copy), a date
  when known, and what the piece adds. With no sources the page says "No close
  earlier match found in a web search. That is not the same as proven
  original." - never "100% original". A near-copy caps the score at 30.
- The test suite keeps a formal human paragraph that scores ~40 on the quick
  scan, on purpose: it asserts the limits line is present, not that the score
  is low. The false-positive risk is disclosed, not hidden.

## No share links - on purpose

Every other lab app with a result has a share link or a brag card. Tells does
not, and must not: a public page saying "this person's post is 87% AI" would
be an accusation machine aimed at real people, indexed and unfurled under
their name. Results live on the screen of the person who asked, and in their
own browser's history list. Don't add one "for virality".

## What is and is not stored

- **Nothing a user checks.** No text, URL, image, frame or result reaches
  Firestore or a log. `fail()` logs the first stack lines of unexpected errors
  only, never a body. The test suite dumps the store and the identity store
  after every kind of check and looks for the submitted text, URLs and
  generator names.
- **Photos and frames** go to Anthropic once for the read and are dropped.
  The model gets a ~1024 px JPEG the browser drew (a canvas redraw strips
  metadata); if an original has to double as the preview (the Shortcut sent
  no preview), `images.stripMeta()` cuts its EXIF/XMP/IPTC/comment segments
  (JPEG, keeping APP14) or text/EXIF chunks (PNG) first. A fetched og:image
  is stripped the same way.
- **Videos never leave the device.** The browser scans the file's metadata
  and pulls 6 frames; only the frames are sent, and only on a tap.
- **Stored:** `tells_devices/<sha256(key)>` = `{uid, label, createdAt,
  lastUsedAt}`. That is the only collection.
- **History** is `localStorage['tells-history-v1']` (last 12: kind, a 70-char
  label, the score), wrapped in try/catch, with a Clear button.
- The `?q=` a bookmarklet or Shortcut opens with is removed from the address
  bar (`history.replaceState`) once read, and every response carries
  `Referrer-Policy: no-referrer`, so what someone was checking does not ride
  out in a Referer.

## The checks

**Quick scan** - `public/tells-core.js` (UMD: page, server, extension, tests;
free, no network). Rules with a weight, a cap and exact spans: stock openers
and closers, set-up lines ("The result?", "Let that sink in"), "it's not X,
it's Y" / "not just X, but Y", AI-favoured vocabulary (delve, tapestry,
testament, landscape, leverage, seamless, robust...), filler hedges, em-dash
*density*, emoji-bullet lines, hashtag stacks, symmetric headers, repeated
lists of three; plus two measured signals: one-thought-per-paragraph
"broetry", and a very flat sentence rhythm (coefficient of variation under
0.22 over 8+ sentences - loosened after it flagged the human sample). Score:
points P scaled by √(words/150) past 150 words, `100·p/(p+12)`, capped 97.
`segments()` cuts overlapping highlights into runs; `combine()` makes the one
meter (metadata AI ≥ 95 high > deep read > visual (≤ medium) > quick (low)).

**Deep read** (metered) - forced tool `record_reading`. The server locates
every quote as an **exact substring** of the submitted text and drops any it
cannot find (`ai.locate`): a highlight on words the text does not contain is
a fabrication. Offsets are ours; a repeated quote takes the next unused
occurrence; 25 spans max; every string stripped of markup and bounded; enums
from fixed lists. The page says how many quotes were dropped.

**Originality** (metered, web search) - `record_originality` with the
server-side `web_search` tool (`identity.webSearchFor`, 3 searches free tier
/ 5 paid, priced at $0.01 each through the shared ledger by identity's meter).
`tool_choice: auto` so it can search before recording (a forced tool would
record first). `pause_turn` is resumed by re-sending with the paused turn
appended (no "continue" message), up to 4 times; a turn that ends without
recording gets one forced follow-up. **Every source URL must be one the
search returned** (`ai.searchUrls` walks the result blocks); others, http,
`javascript:` and credentialed URLs are dropped. If no result URLs could be
read at all (an unknown result shape), sources are kept with `matched:false`
and the page says "not matched to a search result, open it before relying on
it". `max_tokens` 8000 because searching spends it.

**Metadata** (free) - `public/tells-meta.js` (UMD, same four homes). C2PA /
Content Credentials JUMBF in JPEG APP11, PNG `caBX`, WebP `C2PA`, MP4/MOV
`uuid` (d8fec3d6-...); claim generator, software agents and actions read by
**CBOR header** (a short string's header byte is itself printable - "dSora"
- so "printable text after the key" is wrong; see `cborTextAfter` /
`cborStrings`); IPTC/XMP `DigitalSourceType` (`trainedAlgorithmicMedia`,
`compositeWithTrainedAlgorithmicMedia`, `algorithmicMedia` strong;
`digitalCapture` camera); PNG `parameters` (Automatic1111), `prompt` /
`workflow` (ComfyUI), InvokeAI keys, Software/Description naming a
generator; EXIF Make/Model/DateTimeOriginal/Lens (weak camera) and Software
naming a generator (strong); video encoder tags. Generator names are matched
only inside metadata fields, never pixel data. **Limits, said in the UI:** we
do **not** verify C2PA signatures ("found (not verified here)", linking
contentcredentials.org/verify); compressed PNG text is not inflated (its key
is still reported); HEIC/AVIF EXIF is found by a generic scan, not by walking
`iloc`; most platforms strip metadata, so finding none means nothing. For a
video the page scans the first and last 16 MB plus any `uuid`/`moov`/`meta`
box it finds by walking top-level box headers 32 bytes at a time
(`File.slice`), and says how much it scanned.

**Visual read** (metered, weak) - `record_visual` on one picture or up to 8
frames (the page sends 6, ~768 px): artefacts with where and, for video, the
frame index. Confidence capped at medium, and low when nothing is named.

**Link** (free, signed in) - `lib/linkfetch.js` + `lib/extract.js`. See the
SSRF guard below. Title, main text (longest `<article>`, else `<main>`, else
`<body>`, with script/style/nav/header/footer/aside/form/svg removed),
og:description, og:image (https only), published date. LinkedIn, X and
friends always come back as a **wall**: "LinkedIn and X hide posts from
servers. Paste the text, or use the Tells extension on the post.", with the
page's public preview line offered for a quick scan when it has one. A page
under 200 characters, or short and saying "sign in to view", is a wall too.
"Check the page's image" (metered) fetches og:image through the same guard.

## The SSRF guard (`lib/linkfetch.js`)

https only (http is refused with a sentence saying so), port 443 only, no
`user:pass@`. Hosts that only mean something inside a network are refused
before any lookup (`localhost`, `metadata.google.internal`, `.internal`,
`.local`, `.lan`, `.corp`, single-label names). The name is resolved here
(`dns.lookup all:true`); if **any** address is private the host is refused;
the socket's `lookup` is **pinned** to the checked address, so a second DNS
answer can never be used (rebinding). Blocked: 0/8, 10/8, 100.64/10, 127/8,
169.254/16 (the metadata server), 172.16/12, 192.0.0/24, 192.0.2/24,
192.88.99/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4,
240/4; `::`, `::1`, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 64:ff9b::/96,
100::/64, 2001::/32, 2001:db8::/32, 2002::/16, and IPv4-mapped/NAT64/6to4
forms checked as the IPv4 inside (canonicalised first, so
`0:0:0:0:0:ffff:7f00:1` is caught). **Do not add `::ffff:0:0/96` to the
BlockList**: Node treats that range as every IPv4 address and it blocked the
whole internet (found in testing). Every redirect is re-checked, max 3. 8 s
for everything (a timer inside the request, cleared before answering), 2 MB
per page / 8 MB per image counted as it arrives and after gzip/deflate/br,
text/html, application/xhtml+xml, text/plain only (image types for an
image). User-Agent `TellsBot/1.0 (+https://challenge.strongtechnicalconsulting.com/tells/; ...)`.
Tests fake DNS and the transport (`setFetcher`); the sandbox cannot reach the
web, so **read the production log for the first real fetches** before calling
link checks shipped.

## Device keys (extension and Shortcut)

Modelled on the site's ideas-inbox token. Settings → Device keys: `tells_` +
32 random bytes base64url, **shown once**, stored only as its SHA-256 (the
document id), a label, createdAt and lastUsedAt (stamped at most every 10
minutes). Max 5 per account; list and revoke. `Authorization: Bearer` is an
alternative to the cookie: `deviceAuth` (after `identity.mount`, before every
route) resolves the key and loads the identity user exactly as `attachUser`
does, so `requireUser`, `requireBudget`, `requireDailyCap` and the meter
treat it as that account - it adds a door and bypasses nothing. A key cannot
mint or revoke keys (`sessionOnly`, 403). 30 requests a minute per key; 20
wrong keys a minute per address. Revoked, unknown or malformed: 401.

## The Chrome extension (`extension/`)

MV3. Content scripts on `www.linkedin.com`, `x.com`, `twitter.com` add a
small "🔎 Tells" pill after each post's text (LinkedIn update containers,
`article[data-testid="tweet"]`), by MutationObserver coalesced to one sweep
per frame, idempotent (`data-tells` marks), selectors in one table, every
step in try/catch so a markup change only makes the buttons disappear.
Clicking reads that post's text (the expanded text if already in the DOM;
nothing is clicked for the user) and image URLs, and opens a panel in a
**closed Shadow DOM** with the quick scan at once; deep read, originality and
a post image's visual read are buttons. Right-click (all sites): check
selected text / this image / this page. The toolbar popup offers "Check
selection" and "Check this page" (the only way in on iOS). All API calls go
through the service worker with the device key; `ui.js` draws with
`textContent` only (tested: no `innerHTML` in extension code).

Permissions, and why: `contextMenus` (the menu), `storage` (key, local only),
`activeTab` + `scripting` (draw the panel / read the selection in the tab the
user acted on), hosts linkedin/x/twitter (buttons), `media.licdn.com` and
`pbs.twimg.com` (a post's image for metadata), the lab host (the API).
`<all_urls>` is **not** required: `https://*/*` is an optional permission
requested the first time someone checks an image elsewhere (or from the
options page); `http://localhost` and `127.0.0.1` are optional for local
testing. No `tabs`, `history`, `cookies`, `webRequest`, `offscreen`.
`extension/README.md` has the table for reviewers.

**Safari-ready, Erik's step to package.** `globalThis.browser ||
globalThis.chrome`, promise-style calls, a classic service worker with
`importScripts`, no offscreen documents (OffscreenCanvas in the worker,
feature-detected; else the original if small; else metadata only), menus
optional. `extension/SAFARI.md`: `xcrun safari-web-extension-converter`,
signing with a team, TestFlight/App Store, and what Apple reviews. Needs a Mac
with Xcode and the $99/yr Apple Developer account.

**Chrome Web Store: Erik's step.** A developer account ($5 once), a listing
with screenshots and the privacy disclosure, Google's review. Until then the
page offers `tells-extension.zip` and "Load unpacked" steps.

`npm run extension` copies `public/tells-core.js` and `tells-meta.js` into
`extension/` byte for byte and writes a deterministic stored zip to
`public/tells-extension.zip` (plain Node, CRC-32, fixed timestamps, docs left
out). The tests fail if a copy or the zip is stale. **Run it after touching
anything in `extension/` or the two shared files.**

## The bookmarklet

`public/bookmarklet.src.js` is the one readable source; `lib/bookmarklet.js`
drops comment lines, joins, writes in the base URL and URL-encodes it behind
`javascript:` (~1,000 characters; budget 2,000). `GET /api/bookmarklet`
serves it (pointing back at itself on localhost). It takes the selection (or
the page address), cuts it until the encoded URL is under ~6,800 characters
(and says `cut=1`; never splits a surrogate pair), and **opens a new tab**
(`window.open`, falling back to `location.href`). It never fetches from the
page it runs on: LinkedIn's and X's CSP `connect-src` would block that, while
navigation is allowed. The page's "Add to your browser" section offers it as
a draggable link for desktop Chrome/Safari and as copy-the-code steps for
Safari on iPhone/iPad, beside the Shortcut and the extension.

## `?q=` never spends

The bookmarklet, the Shortcut (`src=shortcut`) and anything else can open
`/tells/?q=`. `Core.parseQ` decides text vs link (https/http URL ≤ 2048
chars, else text capped at 20,000), strips control and bidi characters, and
returns `autoSpend: false`. The page runs **only the free quick scan**, shows
"Opened from ... Only the free quick scan ran; nothing that uses credit
happens until you tap", and cleans the address. A link is fetched straight
away only when signed in (it is free: no model). A crafted link must never
spend someone's credit; the render check confirmed a signed-in `?q=` load
made no model call and spent $0.

## The iPhone Shortcut

`SHORTCUT.md` and the page's "iPhone share sheet" section: Get Images from
Input → If images: Base64 the original, Convert to JPEG with metadata off,
resize to 1024, Base64 that, POST both to `api/check/picture?format=text`
with the device key, Show Result. Otherwise: URL-encode the input and open
`/tells/?src=shortcut&q=`. `?format=text` answers `Core.plainSummary` as
text/plain (errors too).

## Costs

Free: quick scan, metadata (browser, extension and `POST
/api/check/metadata`), link fetching, the samples. Metered (`requireUser,
requireBudget, requireDailyCap`, **then** the route's body parser, then the
400s): deep read (~6k in / ~1.5k out on Haiku ≈ 1¢), originality (tokens +
3 searches ≈ 5¢; searches are most of it), visual read (≈ 0.5¢), the page
image. Free tier Haiku 4.5, members Sonnet 5, via `identity.planFor`. The $2
allowance is well over a hundred deep reads. Deep read and originality stream
whitespace (`lib/stream.js`, trip-planner's `streamedJson`): after the first
byte a failure is `200 {error}`, so every status-code failure is above it.
Picture/video are not streamed (5-15 s; plain codes suit the Shortcut).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/samples`, `/api/bookmarklet`,
`/api/me`, `POST /api/scan` (60/min/IP, `?format=text`), static files incl.
`tells-extension.zip`. Signed in, free: `POST /api/check/link`, `POST
/api/check/metadata` (12 MB after the gate). Session only: `GET|POST
/api/devices`, `DELETE /api/devices/:id`. Metered: `POST /api/check/deep`,
`/api/check/originality` (160 KB), `/api/check/picture` (17 MB,
`?format=text`), `/api/check/video` (7 MB, ≤ 8 frames of 700 KB),
`/api/check/link-image`. Everything else parses 32 KB. The page carries a CSP
with no inline script and no third-party origin.

## Local run and tests

```
npm run dev        # memory store + fake model, http://localhost:8112/tells/
npm test           # 38 tests: pure first, then HTTP under a /tells mount
npm run extension  # copy the shared scanners in, rebuild the zip
```

`TELLS_MEMORY=1` and `TELLS_FAKE_AI=1` throw on Cloud Run (tested).
`TELLS_COLLECTION_PREFIX` is set to `tells_` by the host. The fake model
always returns a quote that is not in the text, a duplicate, an invented
source and an http link, so every run exercises the cleaning; trigger words
`INJECT`, `NOSOURCES`, `PAUSE`, `NORECORD`, `UPSTREAMnnn` (in text, or in
image bytes).

`test/run.js` covers: the quick scan (casual human low, templated high,
formal paragraph with the limits line, exact spans, hostile input bounded),
segments, combine, `?q=`, highlight location (fabricated dropped, offsets,
duplicates), hostile model output for all three tools, the prompts' spine,
the samples, metadata fixtures built byte by byte in `test/fixtures.js`
(JPEG APP11 C2PA naming OpenAI; C2PA from a camera; PNG A1111, ComfyUI,
NovelAI; PNG XMP trainedAlgorithmicMedia; XMP digitalCapture; EXIF camera and
generator Software; MP4 uuid C2PA, encoder tag and chunked scanning; empty
and corrupt files), the SSRF guard (every range, redirects to private and to
http, too many redirects, oversized by header / stream / gzip bomb, wrong
type, timeout, pinning), the page reader and walls, the bookmarklet (decodes
to its source, fits, cut, blocked pop-up) run in a vm, the extension
(manifest exact permissions, Safari-readiness, no offscreen/innerHTML/eval,
copies identical, zip current) and its content script in a DOM stand-in (one
button per post, idempotent, panel with the quick scan, nothing sent),
contrast of every text token on every surface in both themes, Cloud Run
refusals, and over HTTP: signed-out 401s before any model call (and before
big bodies), gate order, deep read streamed and metered to the right uid,
originality with search pricing, pause and forced follow-up, picture/video
byte checks and `?format=text`, metadata stripping, link and page image,
device keys end to end (hash only, shown once, 5 max, bearer charged to the
right account and 402 when broke, revoke/unknown/malformed 401, 429), and
that the store holds nothing but device keys afterwards.

Rendered in headless Chromium at 390 and 1280, light and dark (text with
highlights and originality sources; a picture with Content Credentials naming
OpenAI; a WebM made in the browser for the frames path; the Settings sheet
with a new device key; the add-to-browser section); a contrast sweep of every
visible text node found nothing under 4.5:1, no horizontal overflow, no
console errors. The content script was loaded into LinkedIn- and X-shaped
pages served at their real hostnames: one button per post including one
added later, idempotent on re-injection, the panel opens with the quick scan.

## Ideas not built yet

- Cryptographic C2PA verification (needs a C2PA library with native code, or
  a WASM build; the lab image avoids native binaries).
- Audio (voice clones) - no reliable free signal to show.
- A per-author view ("this account's last 20 posts") - deliberately not: it
  turns evidence about a post into a profile of a person.
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
