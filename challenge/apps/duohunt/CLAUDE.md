# For Claude: Duo Hunt

Find an iPhone Duo near you - Apple, Best Buy and the carriers in one place.
Pick the storage, colour and carrier, add a ZIP, and one tap checks **Apple
Store pickup** and **Best Buy** (online and in store) live, side by side,
and lays out **AT&T, Verizon and T-Mobile** as one-tap links with a "what I
saw" note each. **Watch on this tab** re-checks every five minutes while the
tab stays open, with a notification and a flashing title when one turns up.

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
  and is never stored or logged. Failures log a source name and a reason
  word (`[duohunt] apple check failed: timeout`), never a URL, a body or a
  parse error's message (V8 quotes the body in it). Tested.
- **Never polled, never on a timer.** A check happens on a tap, or on the
  browser's own five-minute timer while "Watch on this tab" is on **and the
  tab is visible** (it pauses when hidden and checks at once if one is due
  when it comes back). No server timer, no push; billed per request and
  nothing runs after a response.
- The shared account is mounted at `api/auth` for the verify banner and
  passkey client, like every lab app; nothing here needs it.

## What it checks, honestly

### Apple Store pickup (`lib/apple.js`) - live

The public JSON apple.com's own product page calls when you tap "Check
availability": `https://www.apple.com/shop/fulfillment-messages?pl=true&mts.0=regular&parts.0=<PART>&location=<ZIP>`.
The parser picks fields by name (`body.content.pickupMessage.stores[]`:
`storeName`, `storeNumber`, `city`, `state`, `storeDistanceWithUnit` /
`storedistance`, `partsAvailability[<PART>].pickupDisplay` and
`pickupSearchQuote`), strips and bounds every string, keeps 12 stores, and
calls an unknown shape a failure: "Couldn't check Apple right now - open
Apple's page." Each store row is "Available today", "Unavailable", or the
quote ("Available Tue, Nov 4").

**Unsure, said plainly:** this endpoint is undocumented and apple.com sits
behind bot protection. From a Cloud Run address it may answer 403 or an
HTML page. If it does, the card says it could not check and links Apple's
page - nothing breaks - but the live half of the app would be a link. The
sandbox cannot reach apple.com, so it was only tested against hand-written
fixtures in the shape it has sent in past years.

#### Part numbers: the owner fills them in

Apple's check is asked by part number, one per storage, colour and carrier.
**None could be confirmed from Apple** on 2026-10-24, so `lib/parts.js` is a
32-row table with every `part` set to `null`, and the Apple card says
"Apple's live check isn't set up for this model yet" with Apple's buy page.
A wrong number would not fail loudly - Apple would answer about some other
phone - so nothing is guessed. Candidates found, recorded in the table's
`seen` field and **not used**:

- `MK1E4LL/A` (256GB Star White) and `MK1F4LL/A` (256GB Night Sky): SHI's
  reseller catalog (shi.com product 52432747 and 52432748), as "iPhone Duo
  5G smartphone"; carrier not stated. An apple.com `/shop/product/MK1F4LL/A`
  URL also appears in search results, which suggests that one is real.
- `MK2P4LL/A` (1TB Star White): TechWalls' model-number article (A3447 is
  the US model).

To fill a row: on apple.com, pick the model, storage, colour and carrier,
and read the part number from "Check availability" or the bag's product
information; it looks like `MK1E4LL/A` (`PART_RE`). Carrier versions sold by
Apple have their own numbers. A row that does not match the pattern stays
"not set up". Then deploy.

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
search, and no request is made. Unsure: whether a new key is granted the
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

- Cache: five minutes per key (Apple: part + ZIP; Best Buy: the search, and
  SKU + ZIP); a failure is remembered for one minute.
- One shared in-flight request per key: twenty taps at once are one fetch.
- Per address: 20 checks in ten minutes (IPv6 by /64), then a 429 that asks
  nothing upstream. Per instance: 2,000 checks, and 300 real fetches per
  source, per ten minutes ("Lots of people are checking...").
- 6 s timeout, `redirect: 'error'`, 2 MB body cap, identifying User-Agent
  (`DuoHunt/1.0 (+https://challenge.strongtechnicalconsulting.com/duohunt/; ...)`).
- In memory, per instance, like every lab limiter: it slows a script, it
  does not stop a determined one.

## Switches

- `DUOHUNT_MEMORY=1` - memory account store (tests, laptop).
- `DUOHUNT_FAKE_UPSTREAM=1` - answers apple.com and api.bestbuy.com from
  `lib/fixtures.js` (two Apple stores available, Best Buy's AT&T version in
  two stores), with clearly fake part numbers (`Z...`) for every model;
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

Notification permission is asked only when Watch is switched on. A watch
alert fires only for something newly available since the previous check of
the same model.

## Tests

`npm test` (`test/run.js`): Apple and Best Buy parsers against hand-written
fixtures (available, unavailable, quote only, malformed, hostile strings),
caching and in-flight sharing, the instance cap, timeouts and errors
becoming the friendly sentence, no request to a carrier host for any pick,
ZIP validation and that it is never logged or stored, the Best Buy key never
leaking, the no-key state, the per-address limit, `K_SERVICE` throws, the
page's escaping and CSP rules, contrast in both themes.

## How it becomes an iPhone app

Background App Refresh and a local notification instead of "keep the tab
open", a widget ("Union Square: available today"), and links that open straight
into Apple Store, Best Buy and each carrier's own app.
