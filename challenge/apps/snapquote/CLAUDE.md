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
  alone gets a 9 MB body limit, read only after the sign-in and budget
  checks; every other route stays at 128 KB.
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

## Design (redesigned 2026-11-23)

The lab's shared look, written out at the top of `public/app.css`: a pure
white page (true black in dark mode), hairlines instead of boxes, lists over
cards, system type in five sizes, a 4/8 spacing scale, one accent, pill
buttons, 10 px inputs, 12 px cards, no shadows except on what floats.

- **One accent: the lab card's emerald**, deepened to `#047857` in light
  (5.48:1 under white text and as link text on white) and `#34d399` in dark.
  `lab.js` colours are unchanged. Status colours (grey draft, blue sent,
  violet viewed, amber changes, green won, red lost) are for a quote's status
  only and every pill carries its word.
- **A customer's quote wears the pro's brand colour as a fill only** - the
  logo tile, the Accept button, the chosen option's dot - with an ink picked
  by `inkFor()` (near-black above a luminance of 0.179, else white, whichever
  contrasts more). Never brand-coloured text: a pro can pick any colour.
- **Navigation.** Phones: a slim floating translucent pill, four 1.5 px line
  icons, the label only on the current one. From 900 px: the same four
  buttons in the top bar with a quiet underline (the shared `desktop.css`
  rail is overridden at the end of `app.css`). In the editor and on "Check
  the lines" a phone shows the action bar instead of the pill
  (`body.has-bar`); the back arrow returns.
- **Taps from home (the pipeline):** new quote 1; open a quote 1; scoreboard
  1; business 1; read a job 2 (New quote, then Read the job, once a photo or
  a voice note is in); send a quote 2 (open it, Send).
- **No `style=` attribute anywhere**, in the HTML or written by script.
  Values only known at run time (a brand colour, a bar's width) are written
  as `data-css="--brand:#0891b2;--brand-ink:#fff"` by `css()` and applied as
  custom properties through the CSSOM by one `MutationObserver` (`paint`) -
  nothing but a `--name` is ever applied. The suite checks the page writes no
  style attribute, inline script or `on*=` handler.
- **Motion** (press states, the sheet rising, review lines settling in, the
  recording pulse, confetti) sits only inside `prefers-reduced-motion:
  no-preference`; every page is complete at rest.
- **Measured in headless Chrome, 390 / 320 / 1440 px, both themes:** lowest
  text contrast 5.48:1 light and 7.22:1 dark for the app's own colours
  (5.15:1 for the ink on a sample brand-colour fill); nothing sideways at
  390 or 320; every control 44 px or more; no CSP or console error.

## Read the job: Gemini, behind `SNAPQUOTE_AI_PROVIDER` (2026-11-23)

Erik's AI plan for this app: *job photos plus a voice note become priced line
items; the server does the maths.* It is built and **switched off**:
`SNAPQUOTE_AI_PROVIDER=gemini` turns it on, anything else (and unset) is
`claude`, the app as it was. The switch is read per request (`providerNow()`),
so it is a Cloud Run setting and nothing else; `/api/me` reports `ai` and
`voice`. **Turning it on is Erik's call**, and needs Vertex AI reachable by
`challenge-run@` (see `challenge/CLAUDE.md`, "Lab AI guard").

- **Claude stays the default reader and stays beside it.** "Snap my quote"
  (`POST /api/quotes/draft`, Claude drafts a whole quote, prices included) is
  untouched, and with Gemini on it is still there as "Draft a whole quote
  instead". Polish and follow-up stay on Claude either way.
- **What Gemini is asked for** (`lib/gemini.js`, one `responseSchema` call):
  `relevant`, a `title`, `heard` (one or two sentences of what the voice note
  said), up to 20 `items` - `task`, `category`, `quantity` (nullable), `unit`
  (the app's list), `materials`, `confidence` (high / medium / low) - and up
  to four `questions` to check on site.
- **The model never outputs money.** The schema has no price, cost, rate,
  total, tax or margin field (tested by name); anything like it in the answer
  is never read; and `noMoney()` takes currency amounts out of every string.
  The fake's `MONEY` trigger is a model that prices anyway, and the suite
  proves none of it reaches a line, a price or a total.
- **Prices come from the pro's own numbers** (`lib/rates.js`), in order:
  their **price list** (new: `rates` on the profile, up to 40, edited under
  Business), a line on one of their templates, a line on one of their last 60
  quotes, then their hourly rate for a labor line in hours. A match needs the
  same unit and the same side of the labor line. **No match is a 0 flagged
  "Needs your price" - never a guess.** Every line says where its price came
  from. Totals, markup and tax are `lib/quote.js`, as everywhere.
- **Nothing is saved by a read.** `POST /api/quotes/read` answers a proposal;
  the page's "Check the lines" screen (`#/review`) is where the person edits,
  removes and adds lines, with unsure lines and guessed quantities flagged in
  amber. "Save as quote" is the free `POST /api/quotes` with `read: {…}`,
  which cleans the lines like any edit, computes the totals and stores an
  ordinary quote (`source: 'read'`; a stored line keeps its usual shape - no
  confidence or flags). What was heard is kept only as the private
  description, like dictated notes always were.
- **Media.** Up to four photos, shrunk on the device as before. The voice
  note is recorded in the page (`MediaRecorder`, 32 kbps), **stops by itself
  at 60 seconds and says so**, or is a chosen file checked for length;
  `lib/audio.js` checks it by its bytes, 2 MB at most, a WAV over a minute
  refused. Photos and the recording go to the model inline once and are
  **never stored or logged** - the same promise the photos always had. The
  read route alone has a 12 MB parser, mounted after the gates.
- **Order of a read:** `requireUser` -> the switch (404 `ai-off`) ->
  `requireBudget` -> `requireDailyCap` -> the parser -> photos, audio and note
  validated (a 400 costs nothing) -> `LAB_AI_GUARD.allow` ->
  `LAB_AI_GUARD.gemini.generate` -> `LAB_AI_GUARD.record` with `priceUsd`, and
  the person's own ledger charged the same dollars (`chargeGemini`, written
  as the Haiku input tokens that cost that much, route
  `read:gemini-3.8-flash`). A call that failed after billing is still
  recorded. The provider's words never reach the page (502 / 503 with the
  route's sentence); the guard's "no" shows its own message.
- **No Claude fallback (2026-11-23).** Read the job is Gemini-only: Claude's
  "Snap my quote" is a different request (no audio, prices, saves a quote), so
  a Gemini failure keeps the read's friendly 502/503/422 and the guard's
  message, and the person can still draft or build by hand. Tested.
- **Claude first (2026-11-23).** `SNAPQUOTE_AI_PROVIDER=claude-first` turns
  Read the job on exactly as `gemini` does (Gemini-only, same friendly
  errors; `/api/me` says `ai: 'claude-first', voice: true`). Draft, polish and
  follow-up stay Claude, unchanged.
- **Claude's three calls now ask the guard too** (`withClaude`: `allow`
  `claude`, the call, `record` at the Claude price unless the member's own
  key paid). With no guard loaded (the app on its own) nothing changes.
- **Stand-in.** `SNAPQUOTE_FAKE_AI=1` answers Gemini from `lib/fakeai.js`
  (`gemini`, `geminiCalls`); triggers `BLANK`, `EMPTY`, `UNSURE`, `MONEY`,
  `INJECT`, `UPSTREAMnnn`. Tests never touch the network.
- Local, with it on:
  `SNAPQUOTE_AI_PROVIDER=gemini npm run dev`.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8091/snapquote/
npm test        # 46 end-to-end tests over HTTP, under a /snapquote mount
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
- With Claude as the reader, voice is browser-only dictation (Web Speech
  API); Safari on iOS supports it, Firefox does not, and the mic button hides
  where it is missing. With Gemini on, the voice note is a real recording.
- A read gives one price; Good / Better / Best is added in the editor.
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Security fixes (2026-09-27)

- **The 9 MB parser mounts after the gates.** It was app-wide for the draft
  path, so a signed-out 9 MB body was read before the 401. The global parser
  now skips `/api/quotes/draft` and the route mounts its own after `spend`
  (Chaser's shape). Tested: a signed-out 8 MB non-JSON body and a 10 MB one
  are both 401, not 400 and 413.
- **Provider errors never reach the page.** `fail()` is Receipt's: only
  errors the app made (`httpError`, marked `expose`) keep their status and
  words; an Anthropic error (which carries a `.status` and the provider's raw
  JSON) is logged and answered 502 with the route's own sentence, 503 when
  the provider is overloaded or rate-limited. Before, an upstream 401 told a
  signed-in person to sign in. The fake model throws a provider error when
  `UPSTREAM<nnn>` appears in its messages; the tests use it.
- **A script CSP.** Every page now sends `script-src 'self'; object-src
  'none'; base-uri 'self'` with the existing `frame-ancestors`. Every app on
  the lab shares one origin, so injected script in one would run as all of
  them. The pages have no inline `<script>` or `on*=` handler; keep it that
  way (`challenge/test/lab.js` checks every `index.html`).

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
