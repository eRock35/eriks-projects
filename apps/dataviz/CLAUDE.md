# For Claude: DataViz

Point at a link or paste a table, get a visual that plays. Open to anyone with
no account; an account exists only so work can be saved.

## Same subdirectory arrangement as Friction

Lives in `eriks-projects/apps/dataviz` because the installed GitHub App cannot
create repositories (`POST /user/repos` returns 403). `apps.json` sets `repo`
to the path and `gcpdeploy` packages the subdirectory alone. Moving it to its
own repo is a `git mv` and one line.

## The design decision that matters: the model never emits data

`lib/shape.js` sends the model a HEADER and twelve sample rows and gets back a
MAPPING - which column is the name, the time, the value. `lib/build.js` then
constructs every frame from the full table, deterministically, on the server.

Do not "simplify" this by having the model return the chart data. A model
asked to re-emit a table will round, reorder and occasionally invent numbers,
and a chart that lies is worse than no chart. It also means a 2,000-row table
costs exactly as much to interpret as a 20-row one.

`build.js` falls back rather than failing: a mapping onto a column that does
not exist is dropped, and the guesses that replace it refuse year-like columns
as values and prefer text columns as names. Summing a year column produces a
chart that is arithmetically valid and completely meaningless.

## fetchsafe.js is a security control, not a utility

This app fetches URLs that strangers type, from inside Google's network, where
`169.254.169.254` will hand out an access token for the runtime service
account. `lib/fetchsafe.js` resolves the hostname itself, refuses every private,
loopback, link-local, CGNAT and multicast range in both IPv4 and IPv6
(including IPv4-mapped forms), and re-checks on every redirect hop because a
public hostname can redirect to a private one.

Redirects are followed BY HAND for exactly that reason. Never replace this
with `redirect: 'follow'`, and never skip the per-hop check.

Since 2026-09-27 (ported from Tells' `linkfetch.js`): IPv6 spellings of an
IPv4 address - `[::ffff:a9fe:a9fe]` (what the URL parser makes of
`::ffff:169.254.169.254`), NAT64 `64:ff9b::`, IPv4-compatible `::a.b.c.d`,
6to4 - are unwrapped and judged as the IPv4 inside, and **the socket is
pinned to the address that was checked** (a `lookup` hook on
`http(s).request`), so a DNS answer that changes between the check and the
connection cannot slip a private address in. That is why the fetch is not
global `fetch()` any more; do not put it back. `test/dataviz-fetchsafe.js`
(root suite) holds the literals.

## Samples cost nothing, and must stay that way

Each sample in `lib/datasets.js` carries a baked `spec` - the column mapping
the model would otherwise be asked for. The data is fixed, so the answer is
fixed, so there is nothing to ask.

This was a live cost leak before it was fixed: six buttons on a public page,
open to any stranger, each one an Opus call, bounded only by the global daily
cap. If you add a sample, **give it a spec**. `datasets.isFree()` is what the
route checks, and a sample without one silently falls back to the model and
starts costing money again.

Because they are free to serve, samples are answered BEFORE `quota.check()`
and never count against it. That is deliberate: metering something that costs
nothing only teaches people the free tier is stingy.

## Cost ceilings

`/api/viz` runs a model only for an account (2026-09-27): the samples with a
baked spec are open to anyone and never reach the gate, and everything else
goes through `requireBudget` AND `requireDailyCap` (`vizSpend`), which refuse
a visitor with no account. Beyond that,
`/api/viz` is open to the public and costs Anthropic tokens on every call, so
`lib/quota.js` enforces a per-visitor cap, a higher per-user cap and a global
daily cap. The visitor key is an HMAC of the IP salted with the session secret
and the date, so no address is stored and nothing accumulates across days.

## Renderer notes worth keeping

`public/render.js` is dependency-free Canvas 2D. Two things in it were earned
the hard way and should not be undone:

- **Every frame lookup goes through `frameAt()`.** A NaN or out-of-range index
  silently yields `undefined`, the renderer throws mid-frame, and the
  animation freezes with nothing on screen to explain it. `draw()` also clamps
  time once for all four renderers, because Canvas throws on a non-finite
  coordinate.
- **Bars are pushed apart during an overtake.** Interpolating rank linearly
  means two bars trading places pass through the same slot - at the exact
  moment the viewer is watching for - and draw on top of each other with
  their labels overlapping. A separation pass keeps a visible sliver between
  them while they still finish in the swapped order.

## Deploy

GCP `metal-celerity-236019`, `us-central1`, same REST pipeline as the siblings.

- Cloud Run service `dataviz`; Firestore database `dataviz` (Native, us-central1).
- Secret: `dataviz-session-secret`. `anthropic-api-key` is the shared one.
- Env: `GOOGLE_CLOUD_PROJECT`, `FIRESTORE_DATABASE_ID=dataviz`, `SHAPE_MODEL`,
  `QUOTA_PER_VISITOR`, `QUOTA_PER_USER`, `QUOTA_GLOBAL`.
- No scheduler job. Nothing here runs on its own.

## Billing

Stripe live account `acct_1UHo8nFbShmvZtSf`.

- **One subscription, and it is not DataViz's**: the $5/month all-apps
  membership, product `prod_VIn0vs6b1CRsxS`, price
  `price_1UIBQdFbShmvZtSffjKYqbOV`. The $9 "DataViz Pro" plan is retired and
  its prices and products are archived in Stripe. Do not reintroduce a
  DataViz-only tier: the membership already buys this app's own-data feature,
  and a second product that is a strict subset of the first only makes people
  choose between two things they cannot tell apart.
- Webhook endpoint `we_1UIBRBFbShmvZtSfLdov6BsT` -> the service's
  `*.run.app` URL, not the custom domain. Deliberate: the run.app hostname
  works regardless of what DNS is doing, and Stripe does not care how pretty
  the URL is.
- Secrets: `stripe-webhook-secret`, `stripe-secret-key`,
  `stripe-member-price` - all domain-wide names, because the membership is
  for every app and the `dataviz-` prefix they used to carry said otherwise.
  The SECRET KEY still cannot be automated: Stripe only issues keys
  programmatically to an approved Stripe App holding `api_key_write`, which
  this is not, so it is copied from the Dashboard by hand and mounted as
  `STRIPE_SECRET_KEY`. The price ID and the webhook endpoint CAN be created
  through the API, and were.

**With no secret key mounted the whole app is free and fully working**, because
`stripe.enabled()` is false and `isPaid()` then returns true for everyone. That
is the state it is in now, and it is the state to leave it in if the key is
ever removed. Do not "fix" that by defaulting to locked - an app that locks
itself when its billing config goes missing is worse than one that gives
itself away.

It went live on 2026-09-21: live price, live webhook endpoint with its own
signing secret, live secret key. None of the code changed, which was the
point.

**Completed is not paid (2026-09-27).** `checkout.session.completed` grants
only when `payment_status` is `paid` (or, for a subscription,
`no_payment_required`: a trial or full coupon, nothing owed). A delayed
method completes `unpaid`; its money is `async_payment_succeeded` (granted)
or `async_payment_failed` (logged, nothing granted). Each event is claimed
**atomically** with `create()` on `billing-events/<event id>` before it is
applied, released if applying fails (so Stripe's retry applies it), and a
second delivery meeting a claim still being applied gets a 409 (Stripe
retries) rather than a 200. Subscribe the endpoint to both async events.

Who has paid is decided by the **shared identity record**, never by this
app's own `users` row. `attachProfile` strips `plan` and the rest of the
entitlement fields off the local row before merging it, because the local row
exists only so the `customer.subscription.updated` webhook can find an account
by `stripeCustomerId` - the shared store has no query-by-field. Letting the
local copy speak is how this app once agreed with itself that someone was a
member while the other four served them the free tier.

## Share links unfold into the chart, and the samples keep score (2026-09-26)

Erik asked for features that "draw users in ... and make it fun". Three, with
**no model call in any of them**, so none is metered.

### The still a share link unfolds into

A `/v/<shareId>` link pasted into iMessage, X, LinkedIn or Slack used to
unfold as a bare "DataViz": every path fell through to the same static
`index.html`, and scrapers run no script.

- **Drawn by the owner's browser, not the server.** `public/render.js` is
  Canvas 2D in a page. Running it in Node means a native canvas (node-canvas
  and a Cairo build in the image) or a second SVG renderer to keep in step
  with four animations - both large, for one picture per share. The browser
  already drawing the chart draws one more frame: `DataViz.still(viz, {title,
  subtitle})`, 1200x630, the END of the animation (the race's final order, the
  lines fully drawn; flow mid-flight, it has no end state), title set large
  because at preview size only the title is read.
- **Sent on Save**, on opening a saved project that has none, and by the
  backfill below. PNG first; JPEG at falling quality only if it is over
  400 KB. Best effort: a failed still leaves the link on the app's own card.
- **`PUT /api/projects/:id/still`**, raw body. `requireUser`, then ownership
  (404 on someone else's, before the body is read - a stranger's 400 KB is
  never buffered), then `express.raw` capped at 400 KB (413 as JSON), then
  `lib/still.js`: a PNG or JPEG **by its own bytes**, dimensions from the PNG
  IHDR or by walking the JPEG segment chain to its SOF, **exactly** 1200x630,
  a PNG must end in IEND and a JPEG in EOI (nothing appended), and a declared
  Content-Type that disagrees with the bytes is refused. 415 / 422 / 413.
- **Stored in `stills/<projectId>`**, not on the project: `GET /api/projects`
  reads whole project documents and sixty stills would make "Saved" a 25 MB
  read. The bytes are a Firestore bytes field (a Buffer), so no base64
  inflation - at most 400 KB of a 1 MB document. The project gets a pointer
  `still: {hash, type, ext, bytes, updatedAt}`, written after the picture.
  Deleting a project deletes its still. There is no Cloud Storage bucket for
  this app, deliberately not created for this.
- **Served at `/still/<shareId>/<hash>.<png|jpg>`** with `nosniff`, `default-src
  'none'` and a year's `immutable` cache - safe because a new picture is a new
  hash. An old hash still answers, with the current picture and five minutes'
  cache; no still at all is a 302 to `/og-card.png`. The bytes are sniffed
  again on the way out.
- **Tags are injected server-side** (`lib/og.js`) between `<!-- og:start -->`
  and `<!-- og:end -->` in `index.html`, for `/`, `/v/:shareId` and the
  catch-all. `express.static` runs with `index: false` so `/` goes through it.
  Title and subtitle are a user's or a model's text: attribute-escaped,
  control and bidi characters stripped, cut to length. The absolute origin is
  `PUBLIC_ORIGIN` if set, else the Host header only when it is hostname-shaped,
  else the custom domain. An unknown share id is a 404 with the generic tags.
- `public/og-card.png` is the static card for the front page and for shares
  with no still. Rendered once in Chromium from HTML; redo it the same way.

**Privacy.** Every saved project already has a `shareId`, and its chart was
already readable by anyone holding that link. The still makes the same chart
visible as a picture to anyone with the link, and to every service that
unfolds it (Apple, X, LinkedIn, Slack fetch and cache the image). Deleting the
project removes it here; a platform's cached copy is theirs.

### "Most played" samples

`counters/samples` - one document, one field per sample id, moved with
`FieldValue.increment`. **No per-person data**: no uid, no IP, no cookie. An
in-memory throttle (HMAC of address + sample, 30 minutes, bounded) stops one
person moving the ranking alone. The page posts `POST
/api/datasets/:id/play` once per sample per browser session, and **never from
a framed preview or `?tour=1`** - the landing page's phones tap samples on a
loop, beacon.js's lesson. `GET /api/datasets` carries `plays` (read cached for
a minute); the gallery shows "1.2k plays" and a Featured / Most played sort
(remembered in localStorage).

### Share video

"Save video" is now "Share video": the recording opens a sheet with the file
playing, and **Share is a second tap** - iOS refuses `navigator.share` without
a fresh gesture, and the tap that started a seconds-long recording is stale.
`navigator.share({files})` is offered only where `canShare({files})` says yes;
otherwise the sheet offers the download it always did. "Copy link" became
"Share link": the phone's share sheet on a touch device (straight from the
tap), the clipboard elsewhere.

### Also

- The line renderer reserves right padding for series names; on the last
  frame they used to run off the canvas.
- No composite index: `shareId ==` and `ownerId ==` are single-field.
- Tests: `test/engagement.js` (81 assertions: hostile uploads, someone else's
  project, headers, escaping, the Host header, delete, the counter). It uses
  the repo's shared harness (`../../../test/harness.js`), so run it from this
  checkout: `npm test` here. The root `test/run.js` does not pick it up.

### Stills for projects saved before stills existed (2026-09-27)

Shares made before 2026-09-26 kept the generic card until their owner reopened
that one project. Now a signed-in owner's browser fills them in quietly
whenever the app is opened. The code is `public/backfill.js`: `pick`, `allowed`
and `run`, loaded as `window.StillBackfill`. It is started from `refreshMe()`
once per page load.

- **The owner's own projects only.** It reads `GET /api/projects` (which
  carries `hasStill`), then `GET /api/projects/:id` for the viz, and uploads
  through the same `PUT /api/projects/:id/still`, so every server check
  applies. It has no route of its own and no server change.
- **Gentle on the owner's device.** Projects go one at a time, each after
  `requestIdleCallback` (or a 1.5 s timeout where that does not exist). The
  cap is `MAX_PER_VISIT` (6) per visit, newest first. A person with sixty old
  charts is caught up over ten visits, not on one.
- **When it does not run:**
  - on Save-Data (`navigator.connection.saveData`) or
    `prefers-reduced-data`;
  - in a hidden tab, in a framed preview or in the `?tour=1` demo.
  - It checks `document.hidden` before every project and after each load, and
    stops as soon as the tab goes to the background.
- **One try per session.** A project that failed once (it cannot draw, or the
  server refused it) is kept in `sessionStorage` under `dv-still-tried` and is
  not retried until the next browser session. That stops a bad project from
  eating the cap on every reload.
- Tests: `test/backfill.js` (30 assertions): the pick, the cap, what counts as
  tried, prototype-named ids, one upload in flight at a time, stopping when
  hidden, and failures not stopping the rest. Checked in Chromium against nine
  seeded old projects: nothing ran with Save-Data or a hidden tab; the first
  visit made 6 stills, the next made the other 3, and the one after made none.
  Another owner's project kept the generic card.
