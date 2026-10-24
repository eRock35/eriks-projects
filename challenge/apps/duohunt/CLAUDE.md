# For Claude: Duo Hunt

Find an iPhone Duo near you - Apple, Best Buy and the carriers in one place.
Pick the storage, colour and carrier and add a ZIP. **Apple** blocks server
checks (HTTP 541, measured 2026-10-24), so its card opens Apple's page for
the exact model by part number and hands out an **iPhone Shortcut** recipe
that asks Apple for pickup from the phone. **Best Buy** (online and in store)
is a live check once its key is connected. **AT&T, Verizon and T-Mobile** are
one-tap links with a "what I saw" note each. **Watch on this tab** re-checks
what is live (Best Buy) every five minutes while the tab stays open, with a
notification and a flashing title when one turns up.

**Erik's own request** (2026-10-24, in conversation): "Build me an app that
checks best buy apple att verizon T-Mobile for iPhone Duo availability and
ship it to the challenge should work from the web". It is an **everyday**
app, built on his ask rather than by the alternation rule (Pawlog, the
newest drop before it, was everyday too). Like Inside Joke and Flight, it
does not change which kind the next daily drop is: the next run still takes
the opposite of the newest drop, which is now this one, so a business day.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/duohunt`,
served at `challenge.strongtechnicalconsulting.com/duohunt/`, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting and
graduation. Every browser URL is relative to `BASE`; keep it that way.

## The facts it is built on (checked 2026-10-24)

iPhone Duo is Apple's first foldable: announced 2026-09-09, pre-orders
2026-10-16, on sale 2026-10-23 in the US; from $1,999 (256GB), also 512GB,
1TB and 2TB; Star White and Night Sky. Apple's online delivery slipped to
January 2027, stores get limited walk-in stock, and Best Buy and each
carrier have their own allocation. Best Buy sells it as AT&T and Verizon
versions; its quoted prices are $1,999.99 / $2,199.99 / $2,599.99 /
$3,199.99, which the picker shows rounded as "from".

## No model, no data, no timer

- **No model call anywhere.** No Anthropic client, no metered route, no AI
  button. Free to serve.
- **Nothing stored.** No app collection (`DUOHUNT_COLLECTION_PREFIX` is read
  in `lib/store.js` so anything ever stored goes through it, but nothing is).
  The pick, ZIP and carrier notes live in the browser's `localStorage`; the
  watch switch and the last 20 checks in `sessionStorage` (this tab only).
  Every storage access is wrapped.
- **The ZIP** travels only in the body of `POST /api/check` - never a URL,
  because Cloud Run's request log records URLs - is used for that one check
  and is never stored or logged. The Shortcut recipe puts it into a URL on
  the page, for the person to copy into their own Shortcut; filling the
  sheet sends nothing, and the Shortcut sends it only to Apple. Failures log a source name and a reason
  word (`[duohunt] apple check failed: timeout`), never a URL, a body or a
  parse error's message (V8 quotes the body in it). Tested.
- **Never polled, never on a timer.** A check happens on a tap, or on the
  browser's own five-minute timer while "Watch on this tab" is on (only
  possible when something is checked live - Best Buy connected) **and the
  tab is visible** (it pauses when hidden and checks at once if one is due
  when it comes back). No server timer, no push; billed per request and
  nothing runs after a response.
- The shared account is mounted at `api/auth` for the verify banner and
  passkey client, like every lab app; nothing here needs it.

## What it checks, honestly

### Apple Store pickup - a link and an iPhone Shortcut

The server does **not** ask Apple (see "Apple blocks servers (541)"). The
card's pill says **"Apple blocks server checks"** - neutral, not an error -
and it offers two things:

- **See this model on Apple** -> `https://www.apple.com/shop/product/<PART>`
  for the picked model: Apple's own page for that exact model, where "Check
  availability" is one tap. The part comes from `/api/meta` (every pick's
  part) or the check's answer, and only a `PART_RE` match becomes a link
  (`DuoCore.appleProductUrl`); anything else links the buy page.
- **Check from my iPhone** -> a sheet with a Shortcuts recipe that asks Apple
  *from the phone* for the picked part near the ZIP in the page's ZIP box,
  and reports the stores that have it:
  1. **Text**: `https://www.apple.com/shop/fulfillment-messages?pl=true&mts.0=regular&parts.0=<PART>&location=<ZIP>`,
     prefilled, with a Copy button. Built by `DuoCore.fulfillmentUrl(part,
     zip)` - the same builder the server uses - which is null unless the
     part matches `PART_RE` and the ZIP is five digits, so nothing else can
     get into it. No ZIP in the box: step 1 says to add one ("Add my ZIP"
     closes the sheet and focuses the box) instead of showing a link.
  2. **Get Contents of URL** (GET).
  3. **Get Dictionary Value** `body` -> `content` -> `pickupMessage` ->
     `stores`, one action per key, or the key path
     `body.content.pickupMessage.stores` if Shortcuts takes it (the sheet
     says both).
  4. **Repeat with Each** store: `partsAvailability` -> `<PART>` (Copy) ->
     `pickupDisplay`; **If** it is `available`, `storeName` and
     `pickupSearchQuote` go into a Text and **Add to Variable** `Found`.
  5. **If** `Found` has any value: **Show Notification** "iPhone Duo in
     stock: ..." and **Open URLs** the model's product page (Copy);
     otherwise "No iPhone Duo pickup near <ZIP> yet", or nothing in the
     scheduled version.
  6. Automatic: Shortcuts -> Automation -> + -> Time of Day -> a time ->
     Daily -> Run Immediately; several automations for several times a day.

**Unsure, said plainly (and on the sheet):** the recipe has **not been tested
on a phone**. Apple may answer a phone differently than we expect (or block
it too), and may change the JSON's shape; whether Get Dictionary Value takes
a dotted key path is not confirmed, which is why both forms are given. If it
stops working, "See this model on Apple" still works. Shortcuts names the
action "Open URLs" (plural), so the sheet does too.

**No Apple Store app link.** Apple documents no URL scheme for the Apple Store
app (searched 2026-10-24: `itms-apps://` is the App Store, a different app,
and the schemes on forums are undocumented), so none is drawn. Don't guess
one; the tests fail on `applestore:`.

#### The server path, kept for the day Apple stops blocking (`lib/apple.js`)

With `DUOHUNT_APPLE_SERVER_CHECK=1` (read per request; off by default), the
server asks that same URL - the public JSON apple.com's own product page calls
when you tap "Check availability". The parser picks fields by name
(`body.content.pickupMessage.stores[]`: `storeName`, `storeNumber`, `city`,
`state`, `storeDistanceWithUnit` / `storedistance`,
`partsAvailability[<PART>].pickupDisplay` and `pickupSearchQuote`), strips and
bounds every string, keeps 12 stores, and calls an unknown shape (or a 541) a
failure: "Couldn't check Apple right now - open Apple's page." Each store row
is "Available today", "Unavailable", or the quote ("Available Tue, Nov 4").
Switched on, the card is a live check again, the watch can watch Apple, and
the history counts its stores. Tested against hand-written fixtures only (the
sandbox cannot reach apple.com). Off, `apple.check()` answers `{state:
'blocked', part, message, link}` without touching its cache or fetch.

### Apple blocks servers (541)

Measured 2026-10-24 by Cloud Build steps run from Google's network - the
network Cloud Run sits on:

- The buy page, `https://www.apple.com/shop/buy-iphone/iphone-duo`, answers
  **200**. That is where the part numbers below came from.
- The pickup lookup, `https://www.apple.com/shop/fulfillment-messages`,
  answers **HTTP 541** - Apple's bot block, a ~128 KB HTML page - to **every**
  request tried: with and without `fae=true`, with a browser User-Agent, with
  the cookies the buy page had just set, with the buy page as `Referer`, and
  with the XHR headers Apple's own page sends.

So a server-side Apple stock check cannot work from Cloud Run, and asking on
every tap would spend a fetch to learn nothing. It is off by default and
`/api/check` answers Apple `blocked` with **no request to apple.com** (the
tests intercept fetch across all 32 picks). The code and its tests stay, for
the day Apple stops blocking: set `DUOHUNT_APPLE_SERVER_CHECK=1` on the
service - an env var, no code change - after one request from Cloud Run shows
a 200 with JSON.

Why a phone Shortcut is the answer:

- Apple's block is about **where a request comes from**. A data centre
  address looks like a bot; a phone on a home or mobile network looks like a
  person making the request Apple's own product page makes.
- **The web page cannot ask instead.** A browser lets a page read another
  site's answer only when that site allows it (CORS), and nothing suggests
  apple.com lets other sites read its pickup JSON - assumed, not measured,
  since the sandbox cannot reach apple.com. A Shortcut is not a web page, so
  that rule does not apply to it.
- Shortcuts can run on a schedule (Automation -> Time of Day -> Run
  Immediately) and notify, which is what "Watch on this tab" did for Apple -
  without a tab left open.
- It costs nothing to serve, holds no credential, and the ZIP never reaches
  Duo Hunt.

#### Part numbers (confirmed)

| Storage | Star White | Night Sky | Price |
|---|---|---|---|
| 256GB | `MK1E4LL/A` | `MK1F4LL/A` | $1,999 |
| 512GB | `MK1G4LL/A` | `MK1H4LL/A` | $2,199 |
| 1TB | `MK1J4LL/A` | `MK1L4LL/A` | $2,599 |
| 2TB | `MK1Q4LL/A` | `MK1R4LL/A` | $3,199 |

**Source: apple.com buy page products JSON, 2026-10-24** - recorded as
`source` on every row of `lib/parts.js`. Apple's own buy page embeds a
"products" JSON with one US part per storage and colour; the carrier
variants share it, so unlocked, AT&T, Verizon and T-Mobile all get the same
number (32 rows, 8 parts, built from `BY_MODEL`). Prices are the buy page's
for the rows it priced; each storage tier has one price.

The earlier candidates, for the record: SHI's reseller catalog had
`MK1E4LL/A` and `MK1F4LL/A` right; a blog's `MK2P4LL/A` for 1TB Star White was
wrong (Apple's is `MK1J4LL/A`) - the reason no number shipped before Apple
confirmed it. A wrong part would not fail loudly: Apple would answer about
some other phone. A row that does not match `PART_RE` (`MK1E4LL/A`) is
treated as unset. A new storage or colour: read its part from the buy page's
products JSON and add it to `BY_MODEL`.

### Best Buy (`lib/bestbuy.js`) - live once a key exists

Best Buy's official Products API with the key in `BESTBUY_API_KEY`:
`/v1/products(manufacturer=apple&search=iphone&search=duo)` (one shared
answer for everyone, cached five minutes) and, for the SKU matching the
pick, `/v1/products/<sku>/stores.json?postalCode=<ZIP>` (stores with it for
pickup). Storage, colour and carrier are read from the product name ("Apple -
iPhone Duo 256GB - Star White (Verizon)"). If the store endpoint is refused
for the key, the card shows online availability and the link. Only
bestbuy.com links are drawn; the key never reaches the page or a log
(tested).

**Erik's step (not done):** create a free key at developer.bestbuy.com, put
it in a Secret Manager secret (say `bestbuy-api-key`), bind it to
`challenge-run@` with `secretAccessor`, and mount it on the `challenge`
service as `BESTBUY_API_KEY`. The deployer cannot bind IAM. Until then the
card says **"Not connected yet"** with a one-tap link to bestbuy.com's
search, and no request is made. Since Apple blocks server checks, this key
is also what gives **Watch on this tab** something to watch: without it the
switch is disabled. Unsure: whether a new key is granted the
store-availability endpoint; the card copes either way.

### AT&T, Verizon, T-Mobile - links only, never a request

No public stock API and heavy bot protection, so the server sends them
**nothing** (`lib/upstream.js` allows exactly `www.apple.com` and
`api.bestbuy.com`; the tests intercept fetch across every pick and assert no
other host). Each card has the carrier's iPhone Duo page, its store finder,
and "Checked - nothing" / "In stock!" buttons that remember when you last
looked (localStorage). URLs, found on each carrier's site by web search on
2026-10-24:

- AT&T: `https://www.att.com/buy/phones/apple-iphone-duo.html` (title "iPhone
  Duo: Prices, Colors, Specs, Features"); stores `https://www.att.com/stores/`.
- Verizon: `https://www.verizon.com/smartphones/apple-iphone-duo/` (indexed
  as its Spanish mirror `espanol.verizon.com/smartphones/apple-iphone-duo/`,
  same path); stores `https://www.verizon.com/stores/`.
- T-Mobile: `https://www.t-mobile.com/cell-phone/apple-iphone-duo` ("Pre-Order
  Apple iPhone Duo"); stores `https://www.t-mobile.com/stores` (store pages
  live under `/stores/`; the root itself was not confirmed).

The store-finder roots were not individually confirmed; if one moves, change
`CARRIER_LINKS` in `public/duohunt-core.js`.

## Limits (`server.js`, `lib/upstream.js`)

- Cache: five minutes per key (Apple, when switched on: part + ZIP; Best
  Buy: the search, and SKU + ZIP); a failure is remembered for one minute.
- One shared in-flight request per key: twenty taps at once are one fetch.
- Per address: 20 checks in ten minutes (IPv6 by /64), then a 429 that asks
  nothing upstream. Per instance: 2,000 checks, and 300 real fetches per
  source, per ten minutes ("Lots of people are checking...").
- 6 s timeout, `redirect: 'error'`, 2 MB body cap, identifying User-Agent
  (`DuoHunt/1.0 (+https://challenge.strongtechnicalconsulting.com/duohunt/; ...)`).
- In memory, per instance, like every lab limiter: it slows a script, it
  does not stop a determined one.

## Switches

- `DUOHUNT_APPLE_SERVER_CHECK=1` - the server asks Apple's pickup JSON.
  **Off by default** (Apple answers Cloud Run with 541, above); not a
  local-only switch, so it is allowed on Cloud Run for the day Apple stops
  blocking. `/api/meta` reports it as `appleServerCheck`.
- `DUOHUNT_MEMORY=1` - memory account store (tests, laptop).
- `DUOHUNT_FAKE_UPSTREAM=1` - answers apple.com and api.bestbuy.com from
  `lib/fixtures.js` (two Apple stores available, Best Buy's AT&T version in
  two stores), asked about clearly fake part numbers (`Z...`) for every
  model while the card still names and links the real part (and Apple is
  only asked with `DUOHUNT_APPLE_SERVER_CHECK=1`);
  `DUOHUNT_FAKE_APPLE` / `DUOHUNT_FAKE_BESTBUY` pick a scenario
  (`none`, `quote`, `hostile`, `malformed`, `down`, `nostores`). The lab's
  `npm run dev` sets `DUOHUNT_FAKE_AI=1` with memory, which implies it.
- All three (`_MEMORY`, `_FAKE_UPSTREAM`, `_FAKE_AI`) **throw when
  `K_SERVICE` is set**. Tested.
- `npm run dev` here: port 8137 at `/duohunt/`, fake upstream.

## The page

Phone first; on a desktop (`desktop.css`, `.dk`) the picker is a sticky
column beside the results, and each carrier card becomes a full row (what
you know on the left, what to tap on the right). Every upstream string goes
in through `textContent`; links only from `DuoCore.safeUrl` with a host
allow-list. No inline script or handlers (the lab's CSP). Light and dark,
every text colour at 4.5:1 or better (checked in the tests), 44px taps.
Rendered at 390px and 1280px, light and dark, with no horizontal scroll and
no console errors. The service worker caches the shell only and never
`api/`.

**The Shortcut sheet** is a `<dialog>`: a bottom sheet on a phone, a centred
dialog from 700px, closed by Done, Esc or the backdrop, focus back on "Check
from my iPhone". Its markup is static in `index.html`; the part, ZIP and
URLs go in through `textContent` (`[data-fill]`), and `[hidden]` beats any
class's `display` (the no-ZIP row once showed beside the link). Copy uses
`navigator.clipboard`, falling back to a textarea *inside* the dialog (while
it is modal, everything outside is inert). Rendered on 2026-10-24 at 390px
light and dark and 1280px light, results and sheet, with no horizontal
scroll or console error; Copy and the opt-in path checked in Chromium.

**Watch on this tab** watches only what the server checks live
(`DuoCore.watchPlan(meta)`): Best Buy once connected, and Apple only if its
server check is switched on. With nothing live the switch is disabled with
one line, "Nothing live to watch until Best Buy is connected - use ‘Check
from my iPhone’ for Apple.", and a watch left on in a tab resumes after a
reload only if something is still live. **Check everything** still runs:
Best Buy if connected, Apple `blocked` at once; the history and the summary
line say "Apple: check from your iPhone".

Notification permission is asked only when Watch is switched on. A watch
alert fires only for something newly available since the previous check of
the same model.

## Tests

`npm test` (`test/run.js`, 31 tests): all 32 picks carry the confirmed part
(same per carrier, `PART_RE`, the source recorded); Apple `blocked` with zero
fetches by default, for every pick, over HTTP; the opt-in path still asking
once and parsing the fixtures (and a 541 becoming the friendly failure); the
recipe URL built from the pick and ZIP, encoded, refusing anything else; the
watch disabled without Best Buy and the page obeying it; the sheet's honest
"not tested" line; Apple and Best Buy parsers against hand-written
fixtures (available, unavailable, quote only, malformed, hostile strings),
caching and in-flight sharing, the instance cap, timeouts and errors
becoming the friendly sentence, no request to a carrier host for any pick,
ZIP validation and that it is never logged or stored, the Best Buy key never
leaking, the no-key state, the per-address limit, `K_SERVICE` throws, the
page's escaping and CSP rules, contrast in both themes.

## How it becomes an iPhone app

Background App Refresh and a local notification instead of "keep the tab
open", a widget ("Union Square: available today"), and links that open straight
into Apple Store, Best Buy and each carrier's own app. A native app is the
Shortcut built in: it asks Apple from the phone's own network, so Apple
pickup could be a live check again there.
