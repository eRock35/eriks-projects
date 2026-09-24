# For Claude: Snapquote

Turn a few photos and a voice note into a professional quote in about a
minute. A tradesperson snaps the job, talks it through on site, and gets an
itemized quote — their rate, their markup, their tax, their logo and colors —
with optional Good / Better / Best options. They send a link; the customer
picks an option and signs by typing their name. A pipeline board tracks every
quote from draft to won, and a scoreboard keeps the win rate and a weekly
streak in front of them.

Built 2026-09-24 as the second of Erik's "new app every other day" series,
after Spar. **Staging only**: no custom domain until Erik decides it is worth
one.


**Where it lives:** a trial app in the Challenge Lab — `challenge/apps/snapquote`,
served at `challenge.strongtechnicalconsulting.com/snapquote/`, data in
`snapquote_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md`. Any "first deploy"
steps below apply only when it graduates to its own service.

## Why it exists (the business problem)

Painters, landscapers, handymen, cleaners, roofers, plumbers, photographers,
event vendors: the quote is the sale, and it gets written at 10pm at the
kitchen table, days after the site visit. By then the customer has had two
other quotes, and the contractor who quoted first usually won. Snapquote moves
the write-up to the driveway. The fun part is the moment — snap, talk, and an
itemized quote appears — and the pipeline and streak make "quote fast" a habit.

The money case is simple: one extra won job a month pays for years of
membership, and a drafted quote costs one or two cents.

## Where it lives

Built in `eriks-projects/apps/snapquote`; the coordinator moves it into
`challenge/apps/` next to Spar. It is an Express app that runs on its own **or
mounted as a sub-app** of the shared challenge host:

```js
hostApp.use('/snapquote', require('../snapquote/server').app);
```

Everything in the browser is **base-relative**, never absolute. `app.js`
computes `BASE` from `document.baseURI` (`/` alone, `/snapquote/` in the host)
and prefixes every fetch, the passkey endpoints, billing `returnTo` and the
share links with it. `index.html` references its assets relatively. `server.js`
exports `{ app, identity, identityStore, store }` and only listens when run
directly. `ownerView().publicUrl` is relative (`q/<token>`) for the same reason:
the server does not know where it is mounted and does not guess.

The customer's page is the same SPA served at `q/<token>`, one level down. The
server injects `<base href="../">` into that copy of `index.html`, so relative
assets and API calls resolve against the app root at `/q/x` and at
`/snapquote/q/x` alike. The test suite runs every HTTP test under a
`/snapquote` mount and asserts the base tag and the absence of absolute asset
paths.

## The decisions that matter

- **The model proposes line items; the server does the arithmetic.** Every
  total, markup, discount and tax figure is computed by `lib/quote.js`
  (`computeTotals`) from quantities and unit prices, on draft and again on
  every save — whatever the model or the page claims. The fake model returns a
  deliberate `total: 1` and the tests prove it is ignored. The page has a copy
  of the same rules so totals move as you type; the server's answer is the one
  stored.
- **Numbers from a model are clamped, not trusted.** `num()` turns NaN,
  Infinity, negatives, "12 bucks" and 1e12 into something finite in range, and
  a line with no description is dropped. `LIMITS` in `quote.js` holds the caps.
- **Markup is applied to non-labor lines only**, and baked into the price the
  customer sees. A labor rate already carries its margin; marking it up again
  is how quotes lose jobs. The customer never sees the pro's cost or margin.
- **Every model call is a forced tool** (`draft_quote`, `polish_scope`,
  `follow_up`, in `lib/ai.js`). A quote parsed out of prose breaks the first
  time a model adds a friendly preamble. All model text is `clean()`ed (angle
  brackets, control characters, length caps) before it is stored, and escaped
  again when it is drawn — the quote page is shown to someone who never signed
  up for anything.
- **Everything that calls a model is behind `requireUser, requireBudget,
  requireDailyCap`** (`spend` in `server.js`): draft, polish, follow-up. Same
  rule as every sibling: never a model call behind a sign-in alone.
  Everything else is free — a blank quote, a quote from a template, editing,
  sending, duplicating, the customer page — and the tests assert that a user
  with an exhausted allowance can still do all of it.
- **No model call for a signed-out visitor.** The sample quote is hand-written
  (`lib/demo.js`), stored in the same shape a drafted quote has, and served
  through the same `publicView()` a customer's link uses, so it is drawn by the
  real renderer and cannot drift from what customers receive.
- **Photos are never stored.** They are shrunk in the browser (1024px, JPEG,
  under 1.4 MB), validated on the server by magic number and size *before*
  anything is spent (`lib/photos.js`), handed to the model as image blocks, and
  dropped with the request. Only `photoCount` is kept. They are pictures of the
  inside of a customer's house; nothing here needs them kept. The draft route
  alone gets a 9 MB body limit; every other route stays at 128 KB.
- **The public link is the credential.** `q/<token>` is 16 random bytes
  (22 url-safe characters). Responses on `/q/*` and `/api/public/*` carry
  `Referrer-Policy: no-referrer` and `X-Robots-Tag: noindex`, and are
  `no-store`. Deleting a quote deletes its link.
- **`publicView()` is built field by field, never by copying the quote and
  deleting fields.** A private field added next month must not leak by default.
  What stays private: the owner's uid and account email, internal notes, cost
  prices and margin, the job description they dictated (it is often notes to
  self), follow-up drafts, view counts. The tests grep the public JSON for each.
- **Accepting is a typed full-name signature, once.** First and last name
  required; a tiered quote requires a chosen option. Accept is exclusive per
  token (a double tap cannot write twice), an accepted quote is **locked**
  (edits 409 — duplicate to change it), and the owner cannot accept their own
  quote from the link. `expired` is never stored: it is derived from
  `validUntil` at read time, and an expired link answers 410.
- **The owner previewing their own link is not a view.** First view is recorded
  once (`viewedAt`) and never overwritten; `views` counts opens.
- **Polish is a suggestion, not a save.** It returns a rewritten scope; the
  owner taps "Use this" and saves. Same confirm-before-save shape as
  trip-planner's itinerary chat.
- **Templates and duplicates carry the work, never the customer.** A template
  drops customer, notes and messages; a duplicate is a fresh draft with no
  link, response, messages or send date.
- **The scoreboard is computed, not counted.** `stats()` adds up the quotes on
  every read — counters drift the first time something is deleted. Win rate is
  accepted over *decided* (accepted + declined + expired), so a quote sent this
  morning is not a loss. The streak is consecutive weeks with a quote sent,
  ending this week or last (so Monday does not reset it). The chart buckets by
  the week each quote was sent, so "won" is always part of "quoted".
  Chart colors were run through the dataviz palette validator for both themes
  (`--c-quoted` / `--c-won` in `app.css`).

Models: free tier Haiku 4.5, members Sonnet 5, via `identity.planFor` — the
same split as the siblings. Both read images. A draft with four photos is
roughly 6k input and 1.5k output tokens: about 1.5¢ on Haiku, so the $2 free
allowance is on the order of 100 quotes.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8091/snapquote/
npm test        # 33 end-to-end tests over HTTP, under a /snapquote mount
```

`SNAPQUOTE_MEMORY=1` and `SNAPQUOTE_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE` set). A deployment that silently kept quotes in memory or drafted
canned ones would look fine and be broken. `SNAPQUOTE_DEV_MOUNT` (set by
`npm run dev`) mounts the app under a prefix the way the host does, with the
bare prefix redirected to its slash form — by exact path, because Express's
non-strict routing would otherwise redirect `/snapquote/` to itself forever.

The fake model (`lib/fakeai.js`) answers all three tools deterministically and
refuses any call that does not force a tool. Two trigger words exist for tests:
`INJECT` puts markup into a line description, `BADNUMBERS` adds negative and
absurd lines.

## Data (Firestore, database `snapquote`)

`SNAPQUOTE_COLLECTION_PREFIX` (letters, digits, underscore) is prepended to
every top-level collection in the Firestore backend, for when it shares a
database with sibling apps in the combined host.

- `pros/<uid>` — the business profile (name, trade, color, logo, phone, email,
  license, taxPct, markupPct, hourlyRate, terms, validDays) and `quoteSeq`,
  the per-pro counter behind `Q-1001`, `Q-1002`…
- `pros/<uid>/quotes/<id>` — a quote: customer, title, description (private),
  scope, `items`, optional `tiers` (`good`/`better`/`best`, each with the lines
  it adds on top of `items`), assumptions, exclusions, timeline, terms, notes
  (private), markupPct, taxPct, discount, validDays, `totals` (server-computed),
  status (`draft|sent|viewed|changes|accepted|declined`), sentAt, lastSentAt,
  viewedAt, views, validUntil, response, messages, followUp, publicId,
  photoCount. Under the pro so "mine, newest first" needs no composite index.
- `pros/<uid>/templates/<id>` — reusable work (max 50).
- `links/<token>` — `{ uid, quoteId }`: how a public link finds its quote.

Accounts are the shared identity (`identity` database), mounted at `/api/auth`.

## Deploy (first time — not done yet)

Built in a session with no GCP key, so it has **never been deployed**. If it
ships as its own service rather than inside the challenge host, the first
deploy needs these, in order:

1. Firestore database `snapquote`, Native mode, `us-central1`.
2. Runtime service account `snapquote-run@` holding `logging.logWriter`,
   `datastore.user` conditioned to the `snapquote` **and** `identity`
   databases, and `secretAccessor` on `anthropic-api-key` and
   `identity-session-secret`. The deployer cannot grant IAM — **this step is
   Erik's**, same as every other runtime account
   (`docs/phase4-runtime-service-accounts.md`).
3. Build the image (Cloud Build, as `gcpdeploy ship` does) and `POST` the
   service once (DEPLOY.md → "Creating a service") with `cpuIdle: true`,
   `minInstanceCount: 0`, `allUsers` as invoker, and env:
   `GOOGLE_CLOUD_PROJECT=metal-celerity-236019`,
   `FIRESTORE_DATABASE_ID=snapquote`, `IDENTITY_DATABASE_ID=identity`,
   `ANTHROPIC_API_KEY` (secret `anthropic-api-key`), `IDENTITY_SESSION_SECRET`
   (secret `identity-session-secret`).
4. Leave `PASSKEY_RP_ID` **unset** while it lives on `*.run.app`: the shared
   cookie and passkeys are scoped to `strongtechnicalconsulting.com`, which a
   run.app host cannot use. Accounts still work (host-only cookie), and the
   page hides every passkey button on `*.run.app` hosts (`pkOk()` in `app.js`,
   copied from Spar). Set it when the subdomain is mapped — then sessions are
   shared with the other apps.
5. No Stripe env yet: without `STRIPE_SECRET_KEY` the 402 links to a service
   that can sell. Add `stripe-secret-key` / `stripe-member-price` with the
   subdomain.

This service runs with `cpuIdle: true`, so nothing may keep working after a
response is sent. Nothing here does: every route awaits its writes.

After that, `gcpdeploy ship snapquote` handles every later deploy.

## Ideas not built yet

- **No notifications.** The pro sees views, change requests and acceptances
  when they open the app (pipeline banner, unread dot); nothing is pushed or
  emailed. There is no mail sender on this project, and the customer page says
  only that the pro "can see" their acceptance.
- **No PDF export.** The public page prints reasonably; a real PDF would be
  the next thing contractors ask for.
- **No deposit collection.** Accepting could take the deposit through Stripe
  Connect — the obvious paid feature.
- **No rate limit on the public POSTs** beyond: accept once, 20 change
  requests per quote, and one in-flight write per token.
- Voice is browser-only (Web Speech API); Safari on iOS supports it, Firefox
  does not, and the mic button hides where it is missing.
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
