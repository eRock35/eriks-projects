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

Who has paid is decided by the **shared identity record**, never by this
app's own `users` row. `attachProfile` strips `plan` and the rest of the
entitlement fields off the local row before merging it, because the local row
exists only so the `customer.subscription.updated` webhook can find an account
by `stripeCustomerId` - the shared store has no query-by-field. Letting the
local copy speak is how this app once agreed with itself that someone was a
member while the other four served them the free tier.
