# For Claude: Chaser

Get paid without the awkward part. A freelancer, agency or small service
business adds what they are owed — by hand, or by snapping the invoice — and
Chaser tells them who to chase today, writes the chase in their own voice,
hands it to their own mail or messages app, and makes every "paid" a small
celebration. Scorecards say which clients pay late and what gets them to pay;
a four-week forecast says what cash is likely coming.

Built 2026-09-24 as the third of Erik's lab drops, after Spar and Snapquote.
**Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab — `challenge/apps/chaser`,
served at `challenge.strongtechnicalconsulting.com/chaser/`, data in
`chaser_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

Late payment is one of the most common cash-flow problems a small business
has, and the cause is rarely a client who cannot pay. It is a client who has
not been asked, because asking is awkward and the freelancer puts it off —
the invoice goes 30, 45, 60 days, and the longer it goes the harder the
message is to write. Accounting tools send one robotic reminder; nobody helps
with the second, third and fourth message, which is where the money is.

Chaser makes the ask one tap a morning: the list is already ranked, the words
are already written (in the person's own tone, with their payment link), and
logging a payment throws confetti. The fun is the point — a chore that feels
like a win gets done.

**Who pays.** Freelancers and small agencies with 5–50 open invoices: one
invoice collected a week earlier pays for years of membership, and a drafted
chase costs a fraction of a cent. Templates are free forever, so the free tier
is genuinely useful and the membership buys the better model and the credit.

**How it becomes an iOS app.** Everything is already phone-shaped: Today is a
morning notification ("Harbor & Pine is 45 days late — chase?"), Snap is the
camera, Send is the share sheet / `MFMailComposeViewController` /
`MFMessageComposeViewController` — which is exactly what mailto:/sms: already
approximate. The next steps are a push at 9am local and a widget with the
forecast bar.

**The honest risk.** Chasing is a feature inside FreshBooks, QuickBooks, Xero
and Stripe Invoicing, all of which also *send* the invoice and can
auto-remind. Chaser only wins if the ranking, the voice and the fun are
clearly better than "auto-reminder on", and if people will type invoices they
already have elsewhere (snapping helps; an import from those tools would be
the real fix). And an app that writes debt-collection messages must stay on
the right side of tone — the prompt forbids threats, invented consequences
and credit-report talk, and the final notice stays courteous.

## The decisions that matter

- **No mail service, so Send hands the message to the person's own apps.**
  `mailto:` with subject and body, `sms:` with the text, or Copy. The chase
  comes from their own address, which is better for deliverability and for
  the relationship, and nothing is sent by Chaser — the sheet says so in one
  line. Adding a sender would be a standing cost and a spam-reputation
  problem for a few users; don't, without Erik.
- **Nothing is sent or charged silently.** Drafting never climbs the ladder;
  only the person's own "I sent it — log it" tap does (`POST
  /invoices/:id/chases`). Opening Mail does not log anything by itself.
- **The ladder.** Friendly nudge → Follow-up → Firm → Final notice, plus a
  Payment-plan offer off the ladder and Pause. `stage` is how many rungs were
  logged; logging a later rung skips ahead; a plan offer does not move it.
  Each rung waits a gap (5 days after a nudge, 7 after the rest) before the
  invoice is due for a chase again — **unless a promise broke since**, which
  makes it due at once.
- **Today's order is money × time × broken promises.** `score = balance ×
  (days late + 1) × (1 + 0.6 × broken promises)` (`book.scoreOf`). A
  45-day-late $5,000 outranks a 3-day-late $200 by orders of magnitude, and a
  broken promise lifts an otherwise equal invoice. A live promise takes an
  invoice off the list until its day; the next draft names a broken one.
- **Late fees are shown, never added.** `book.lateFee()` computes what the
  settings' policy (none / flat / % a month pro rata by day, after grace
  days) would add. It is drawn on the invoice and offered as a checkbox in the
  chase sheet; ticked, the amount (as a finished string) goes into the draft.
  It never touches the balance, the statement, the forecast or the totals.
  The tests assert all of that.
- **Every model call is a forced tool** (`write_chase` → two or three
  options; `read_invoice` → typed fields) and **the model never decides a
  number** - since 2026-11-23 it never even writes one. See "Chases in your
  voice" below. A read invoice's amount goes through `book.toCents` and its
  dates through `book.isoDay`; anything that fails is left blank for the
  person. All model text is `clean()`ed and escaped again when drawn.
- **`requireUser, requireBudget, requireDailyCap` on both model routes**
  (`spend` in `server.js`): `/invoices/:id/draft` and `/invoices/read`. Never
  a model call behind a sign-in alone. The 402 comes before any model call —
  the tests count usage rows to prove it.
- **The template is always there and always free.** `ladder.template()`
  writes every rung from the same facts and voice, deterministically. A free
  user out of credit can still chase, log payments, share statements —
  everything but the two model calls.
- **No model call for a signed-out visitor.** The demo is a hand-written book
  (`lib/demo.js`: Northlight Studio, 6 clients, 13 invoices across every
  state) run through the real `todayView`, `scorecards` and `lateFee`, with
  sample drafts from the template writer. Labelled SAMPLE DATA everywhere, and
  every action on it asks to sign up.
- **Snap reads once and keeps nothing.** One photo, shrunk in the browser
  (1600px JPEG), checked by magic number and size on the server *before*
  anything is spent (`lib/photo.js`, 400), read by the model, dropped with
  the request. Not an invoice → 422. The answer is a proposal filled into the
  Add form; only the person's Save stores anything. The tests dump the whole
  memory store to prove the photo is nowhere.
- **The share copy is frozen.** `POST /clients/:id/share` stores a snapshot
  of the statement under a 22-character random token (`shares/<token>`); the
  client sees that copy and nothing live. "Update the copy" re-freezes the
  same link; Revoke deletes it and the link 404s for good. The statement is
  built field by field (`statementOf`), never by copying records: the
  business name, the contact line the person typed for statements, how to
  pay, open invoices, recent payments, balances. Never the account email,
  notes, chase history, promises, grades or fees. `/s/*` and `/api/shared/*`
  are `no-store`, `noindex` and `no-referrer`; GET is the only verb there.
- **Everything is computed, nothing is counted.** Balance, status (open /
  promised / paid / written off), broken promises, grades, the streak and the
  forecast are derived from stored invoices on every read (`book.derive`).
  Badges are the one exception: earned once, stamped with the day, kept — so
  "Clean slate" does not vanish when the next invoice goes late.
- **Money is integer cents; dates are ISO days; currency is per invoice.**
  Totals and the forecast are in the user's default currency; other
  currencies are listed separately and **never converted**. `toCents` refuses
  "free" and "-40" rather than reading them as 0 or 40. "Late" is measured
  against the page's own date (`X-Local-Date`, accepted within a day of UTC).
- **Another user gets 404 on everything**, never 403 — ids are not confirmed.

### The scorecard

Per client (`book.scorecard`): average days late and on-time % over paid
invoices, total paid, outstanding, broken promises, write-offs, and a grade
from points out of 100 — minus half a point per average day late (max 35),
up to 15 for rarely paying on time, half a point per day currently late
(max 30), 10 per broken promise (max 30), 25 per write-off (max 50). Nobody
without a paid invoice scores above 85; nobody with no history gets a grade
at all. A ≥ 90, B ≥ 80, C ≥ 65, D ≥ 50. "The chase style that works" is the
median rung a client's paid invoices were paid after. Clients sort by risk:
outstanding × (100 − points).

### The forecast

`book.forecast`: each open invoice gets an expected date (a live promise's
day; else due date + the client's average days late, or the book's, or 7) and
a likelihood (0.85 for a promise, 0.95 − 0.005 × avg days late for a paying
client, 0.75 for a new one; less for broken promises, 60+/90+ days late and
past write-offs). Already past its expected date → a week from today. The
balance × likelihood lands in that week. Drawn as four bars (inline SVG,
`--c-likely`, validated with the dataviz palette checker in both themes),
direct labels, hover/focus tips and a screen-reader table. The page calls it
a planning number, not a promise.

Models: free tier Haiku 4.5, members Sonnet 5, via `identity.planFor` — the
same split as the siblings. A chase is ~1k input / ~350 output tokens: well
under a cent on Haiku, so the $2 free allowance is hundreds of drafts. A snap
is ~1.5k input: about a cent.

## Chases in your voice (2026-11-23)

Erik's AI plan for Chaser: **Claude - "Payment chases that get firmer over
time, in your voice."** `POST /api/invoices/:id/draft` was the app's one
writing call; it was extended, not replaced. Code in `lib/ai.js`.

- **The step is the app's.** Gentle reminder → follow-up → firm → final
  notice comes from the ladder (`book.derive` → `nextKind`, from what was
  logged and when), or from the person's own pick in the sheet. The model is
  told the step; it never chooses one.
- **Every fact is a slot the server fills.** The model writes
  `{first_name}`, `{invoice_number}`, `{balance}`, `{due_date}`,
  `{days_overdue}`, `{payment_link}` (and `{promise_date}`, `{paid_so_far}`,
  `{late_fee}`… only when the invoice has them - `slotsFor`). `cleanOptions`
  fills them from `ladder.factsFor` and appends the saved sign-off itself.
  **The request carries no client name, amount, date, link or business
  name** - less leaves the building than before, and nothing can be
  misquoted. A test reads the prompt to prove it.
- **Two or three wordings** of the same step (`warm`, `plain`, `brief` →
  "Warmer", "Straight", "Shortest"). The answer keeps its old shape (subject,
  body, sms = the first option) and adds `options` and `voiced`.
- **An option is dropped whole, never patched** (`refuse`), when its wording
  - checked BEFORE the slots are filled, so every digit in it is the
  model's own - carries: a digit or a spelled-out sum; a month, weekday or
  "tomorrow"; a deadline ("by the end of the week", "within 3 days"); a fee
  when none was ticked, interest, a percentage; a link, email or bank
  detail; courts, lawyers, collections, credit reports; abuse or guilt; any
  markup; a slot the invoice lacks; or it leaves out the invoice, the
  balance, the payment link when one is set, or the ticked fee. **The one
  deadline a draft may state is the ladder's own "within 7 days"**, on a
  firm reminder or final notice only (`DEADLINE_DAYS`). A bad subject or text
  message falls back to the template's (the app's own words) rather than
  losing a good email. Nothing left → 422, and the template is one tap away.
  It is a word list, not a judge: the person still reads and edits.
- **The voice** is the tone slider plus an **optional sample of the person's
  own writing**, pasted on Your voice. It is kept in this browser only
  (`localStorage` `chaser-voice`), rides in the draft request as `voice`
  (≤ 1,200 characters, 400 if far longer), goes to the model between
  markers as a style sample, and is **never stored or logged server-side**
  (tested by dumping both stores). A new device has no sample until it is
  pasted there - the price of storing nothing new.
- **Chaser still sends nothing.** The person picks a wording, edits it, and
  hands it to their own Mail or Messages; only "I sent it" climbs the ladder.
- **Gates, in order:** `requireUser, requireBudget, requireDailyCap`, the
  invoice's own checks (404/409/400), **the lab's AI guard**
  (`global.LAB_AI_GUARD?.allow({provider: 'claude', req, app: 'chaser'})` -
  its sentence plus "The free template still works." when it says no), the
  call, then `record` with `priceUsd` in a `finally` (a call that came back
  is paid for even if every option was dropped). The snap route does the
  same. No guard (tests, `npm run dev`) → the identity gates stand alone.
- **Provider:** Claude through the lab's existing client (`identity.meter`,
  models by `identityLib.planFor`: Haiku 4.5 free, Sonnet 5 members). No
  provider switch and no federation were added. Three wordings are ~700
  tokens in, ~500-900 out: about half a cent on Haiku, a cent or so on Sonnet.
- **The stand-in** (`CHASER_FAKE_AI=1`) answers with three slotted options;
  `BADDEADLINE`, `BADFEE`, `BADTHREAT`, `BADSLOT`, `ALLBAD`, `INJECT` and
  `UPSTREAM<nnn>` in the voice sample make it misbehave for the tests (the
  model no longer sees a client's name, so the triggers moved there).

## Design (2026-11-23, the HOA Desk style)

- White page (`#fff`), true black in the dark; one accent, Chaser's violet
  from `lab.js` a step darker in light (`#5b45e0`) so white text holds
  4.5:1, lighter in the dark (`#a99bff`). Status colours only for status,
  always with words. No gradients, no tints, no shadows except on what
  floats. System fonts; five sizes (13, 15, 16, 20, 28) plus the hero and
  one big number a page. 4/8 spacing.
- **Lists over boxes:** chases, invoices, clients, forms and timelines are
  hairline rows. Cards (1px hairline, 12px) only for the late-fee note, the
  snap tile, share links and badges. The statement stays a white document in
  both themes and in print.
- **Navigation:** phones - a floating translucent pill bar, five line icons,
  the label only on the current one; 900px and up - a top nav with an
  underline (and "Your voice"). `desktop.css` (the old rail) is still synced
  into `public/` but no longer loaded.
- **Signed out:** a centred hero, two pill buttons, then the sample book.
- **No `style=` anywhere**, in the HTML or written by the script: classes
  only, `<progress>` for the bars, and one constructed stylesheet (`dynCss`)
  for the two computed things (the chart tip's position, confetti).
- Motion (press states, the sheet, confetti, the spinner) only inside
  `prefers-reduced-motion: no-preference`; every page is complete at rest.
- Targets are 44px or more, main actions 48px. From Today: chase = 1 tap,
  chase written in your voice = 2, mark paid = 2, add an invoice = 1 (then
  the form), snap = 2.
- Measured in headless Chrome at 390, 320 and 1440px: lowest text contrast
  4.66:1 light, 6.61:1 dark; nothing scrolls sideways. `test/run.js` holds
  the page rules.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8092/chaser/
npm test        # end-to-end over HTTP under a /chaser mount, plus fixed-date rules
```

`CHASER_MEMORY=1` and `CHASER_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE` set) — in `lib/store.js`, `lib/fakeai.js` and `server.js`.
`CHASER_COLLECTION_PREFIX` (set to `chaser_` by the lab host) prefixes every
top-level collection. The fake model answers both tools deterministically and
refuses any call that does not force a tool; see "Chases in your voice" for
its trigger words, and a photo whose bytes contain `BLANK` reads as "not an
invoice".

## Data (Firestore: `chaser_*` in the lab database `challenge`)

- `settings/<uid>` — the voice (businessName, yourName, signOff, tone 0–100,
  paymentLink (https only), paymentInstructions, contact for statements),
  defaults (currency, termsDays), `lateFee {mode, flatCents, pctPerMonth,
  graceDays}`, `badges {key: day earned}`, `invoiceSeq` (behind `INV-1001`…).
- `clients/<uid>/items/<id>` — name, contactName (chases greet them), email,
  phone, notes, shareToken, sharedAt.
- `invoices/<uid>/items/<id>` — clientId, number, amountCents, currency,
  issued, due, terms, notes, source (manual|snap), `payments [{id, cents,
  date, note, at}]`, `promises [{date, note, at}]`, `chases [{kind, channel,
  source, subject, body, at}]`, stage, lastChasedAt, paused, writtenOff.
  Under the uid, so "mine" is a path and needs no composite index.
- `shares/<token>` — `{uid, clientId, createdAt, statement}`: the frozen copy.

Limits (`book.LIMITS`): 500 invoices and 200 clients a book, 60 payments and
60 chases and 20 promises an invoice, $100M an amount. JSON bodies 128 KB
except the snap route (6 MB; photo 4 MB decoded).

Accounts are the shared identity (`identity` database), mounted at
`/api/auth` — one account and one $2 credit across the lab and every app.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/demo`, `/api/shared/:token`,
page `s/:token`. Signed in: `GET /api/me`, `GET|PUT /api/settings`,
`GET /api/today`, `GET /api/wins`, `GET|POST /api/clients`,
`GET|PUT|DELETE /api/clients/:id`, `GET /api/clients/:id/statement`,
`POST|DELETE /api/clients/:id/share`, `GET|POST /api/invoices`,
`GET|PUT|DELETE /api/invoices/:id`, `POST /api/invoices/:id/payments`
(`{full:true}` is Mark paid), `DELETE …/payments/:pid`,
`POST|DELETE …/promise`, `POST …/chases`, `POST …/pause`,
`POST …/write-off`, `POST …/template`. Metered: `POST /api/invoices/read`,
`POST /api/invoices/:id/draft`.

## Ideas not built yet

- **Import** from FreshBooks / QuickBooks / Xero / Stripe (CSV first) — the
  biggest adoption blocker is re-typing invoices that live elsewhere.
- **A morning push** ("3 to chase, $8k likely this month") — the iOS app's
  headline, and the reason Today is ranked server-side.
- **Chase log from the mail app**: we cannot know a mailto: was sent; the
  "I sent it" tap is the honest substitute.
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Security fixes (2026-09-27)

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
