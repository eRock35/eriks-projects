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
- **Every model call is a forced tool** (`write_chase` → subject, body, sms;
  `read_invoice` → typed fields) and **the model never decides a number.**
  A chase is written from `ladder.factsFor()`: amounts, dates and the fee
  arrive as finished strings, and the prompt says to use them exactly and
  invent nothing (no links, bank details, fees or consequences). A read
  invoice's amount goes through `book.toCents` and its dates through
  `book.isoDay`; anything that fails is left blank for the person. All model
  text is `clean()`ed (angle brackets, control characters, lengths) before it
  is returned, and escaped again when drawn.
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

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8092/chaser/
npm test        # end-to-end over HTTP under a /chaser mount, plus fixed-date rules
```

`CHASER_MEMORY=1` and `CHASER_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE` set) — in `lib/store.js`, `lib/fakeai.js` and `server.js`.
`CHASER_COLLECTION_PREFIX` (set to `chaser_` by the lab host) prefixes every
top-level collection. The fake model answers both tools deterministically and
refuses any call that does not force a tool; `INJECT` anywhere in a chase's
facts puts markup in the answer, and a photo whose bytes contain `BLANK`
reads as "not an invoice".

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

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
