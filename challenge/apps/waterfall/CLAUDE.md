# For Claude: Waterfall

Billings in, revenue out - the deferred revenue schedule that ties to your
ledger. For **finance leads, controllers and bookkeepers at subscription and
usage-billing companies**, and the engineers who get pulled into month-end.

- **Load a billing export** (CSV or TSV - a Stripe invoice line-item export
  is the common case, but any billing system's) in a Web Worker on the
  device: 25 MB and 250,000 lines at most, said in words. Waterfall guesses
  which column is which - invoice id, line id, customer and customer id,
  invoice date, amount, discount, tax, currency, service period start and
  end, description, product / price, line type, proration flag, invoice
  status - and the person confirms. Then it asks once about anything that
  reads two ways, each with its evidence from the file: **does a period end
  on the next period's first day (exclusive, the way Stripe writes it) or on
  its own last day** (counted: ends on the start's day of the month, ends the
  day before, 23:59 ends, periods that chain onto the customer's next one);
  day or month first (both readings shown); dollars or cents when every
  amount is whole; amount before or after its discount; amount with or
  without tax; the currency when there is no column.
- **Rules per product** - the rows of the rules table are the products
  (the product column, else the description with quantities, proration
  wording, bracketed prices and dates taken out, so "Unused time on Team
  after 12 Oct 2026" belongs to Team): over the service period by day (the
  default; a line with no period falls back to its invoice date), on the
  invoice date, over N months from the invoice date (1-60), or exclude. Void
  and draft invoices are left out; uncollectible ones stay in revenue and
  are listed apart ("a write-off is not less revenue - shown apart for your
  accountant"); tax is never revenue; negative lines follow the same rule
  over their own period.
- **The schedule**, per currency (no conversion, said everywhere):
  recognised revenue by month with a bar chart (billed as diamonds, months
  after the export hatched and labelled), the **waterfall** triangle, the
  **deferred revenue roll-forward** (opening + billed - recognised =
  closing, every closing the next opening, everything billed less
  everything recognised = the closing balance - all checked and shown), the
  **journal entries** per month, and a **customer drill-down**.
- **Why the dashboard and the ledger disagree**: type a month's dashboard
  figure (billings for the month or MRR at month end), the ledger's revenue
  and its deferred revenue balance, and rates for other currencies.
  Waterfall shows each gap and the buckets that make it up, with the exact
  lines behind each, in plain sentences, and the buckets always add up to
  the gap exactly.
- **Exports**: the schedule line by line, the waterfall, the roll-forward,
  the journal (generic CSV, account names the person chose), all
  formula-safe with customer names maskable; and a one-page Markdown close
  memo for the month.
- **Signed in (free)**: settings follow the account - never a customer.
- **Metered AI**: "Suggest rules for my products" - product descriptions
  and their shapes only.

Built 2026-11-11 as a **business** drop: Pencil (2026-11-10) was everyday,
so today was the other kind. **Staging only**: no custom domain until Erik
decides it is worth one. **"Waterfall applies the rules you choose - your
accountant decides the policy"** - said on the page, in the memo, in every
AI answer's framing. The only general statement it makes is that
subscription revenue is commonly recognised over the service period; it
cites no standard or paragraph (tested).

**Where it lives:** a trial app in the Challenge Lab -
`challenge/apps/waterfall`, served at
`challenge.strongtechnicalconsulting.com/waterfall/`, data in `waterfall_*`
collections of the lab's `challenge` database, deployed with `gcpdeploy ship
challenge`. See `challenge/CLAUDE.md` for mounting, prefixes and graduation.
Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Inspired by the Friction problem titled **"Stripe/billing numbers never tie
to QuickBooks/NetSuite at month-end close"** (named by title only).

- **Billing dashboards show MRR and cash; the books need recognised and
  deferred revenue.** The two are different numbers on purpose, and nothing
  in either system says by how much, or why.
- **Prorations, annual prepayments, usage billed in arrears, credits and
  voids are handled in spreadsheets** - a deferred revenue schedule kept by
  hand, re-built every month.
- **Finance and engineering argue at close** because nobody can say, line by
  line, why the billing system's October is not the ledger's October.
- **It runs on the device because billing exports carry customer names and
  amounts.** That is the only way a finance team could try a lab app on its
  real export.

**Not a repeat.** **Tally** reconciles a café's card takings against
deposits; **Tieout** turns statement PDFs into CSV; **Feedfix** fixes bank
import files; **Burnrate** tracks coding-agent token spend; **Canon** keeps
metric definitions. Nothing in the lab or the portfolio recognises
subscription revenue or reconciles a billing system to a ledger.

**Who pays.** Almost nobody. The demo, reading an export, the rules, the
schedule, the waterfall, the roll-forward, the journal, the tie-out, the
drill-down and every export are free, need no account and make no request.
A free account keeps presets, rules and account names across devices. The
one metered thing (Haiku for the free tier, Sonnet for members via
`identity.planFor`) costs about a cent.

**How it becomes an iPhone app.** Not for loading 250,000 lines on a phone:
for the close - the controller checks "is October explained?" from wherever
they are: the tie-out's three headlines, the biggest bucket, and the memo to
forward. The core is one dependency-free UMD file a company's own close job
could run as is.

## The mechanics (pure, in `public/waterfall-core.js`)

- **Integer minor units** (cents; 0 decimals for JPY and friends, 3 for
  KWD...), **UTC day numbers** (civil-from-days, no Date object), months as
  `year * 12 + month - 1`. A period's end is stored **exclusive** whatever
  the file wrote; a zero-length period (Stripe's one-off items) is no
  period.
- **The day split** (`splitDays`): each month gets the whole part of
  amount x its days / the period's days; the minor units left over go one
  each to the months with the largest remainders (the earlier month on a
  tie), so **a line's months always add up to exactly its amount** -
  property-tested on 20,000 random lines, each month within one cent of its
  exact share. Remainders are corrected in integer arithmetic.
- **The roll-forward** tracks each line's own balance month by month:
  billed so far less recognised so far. From its invoice month on that is
  **billed ahead** (deferred); before it, revenue **earned before it was
  billed** (usage in arrears). The closing balance is the net, and the
  split is shown and checked on every row.
- **The journal** per month, two entries, each balanced: Billing - Dr
  Accounts receivable (revenue lines plus their tax) / Cr Revenue (lines
  recognised on the invoice date) / Cr Deferred revenue (lines recognised
  over time) / Cr Sales tax payable; Recognition - Dr Deferred revenue / Cr
  Revenue. A negative total swaps sides (the demo's $150 service credit is a
  debit to revenue). Account names are the person's (settings).

## The tie-out (`reconcile`)

Each typed figure is compared with Waterfall's own number, and the gap is
split into buckets, **each a set of lines** (every line in at most one timing
bucket), plus "Not explained by the lines" so the sum is always exactly the
gap.

- **Billings for the month**: the timing buckets are, per line, billed in the
  month less recognised in the month - **annual and multi-month
  prepayments**, **lines outside the month** (periods that cross a month
  end), **prorations**, **usage billed in arrears**, **credits and
  refunds**, **setup and one-time fees** - plus lines a rule excludes. How
  the dashboard counts (amounts before discounts, tax, void invoices,
  leaving out uncollectible ones) is found by trying every reading and
  keeping the **smallest one that ties to the cent**; the person can tick
  them by hand. Other currencies come in at the rate typed for each.
- **MRR at month end**: subscriptions in force on the month's last day, an
  annual plan at 1/12 a month; the buckets say why revenue differs (days vs
  months, usage, one-time fees, prorations and credits are not in MRR).
- **The ledger's revenue**: the smallest set of known differences that ties
  - a bucket "booked when billed", lines a rule excludes, uncollectible
  invoices taken off revenue, tax booked as revenue, other currencies.
- **The ledger's deferred revenue**: the smallest set - a bucket the ledger
  does not defer, usage earned but not yet billed kept in its own account,
  other currencies.
- The biggest bucket carries "Start here" (the example always; a real file
  until "Got it").

## The example (`public/demo.js`)

**Brightwell Analytics** - made up, said so everywhere; 120 invented
customers (compound words like "Quorvane Robotics", ids `cus_DEMO0001`,
invoices `in_DEMO10001`), 14 months of invoices (September 2025 to October
2026, plus ten days of November: the export ran on 10 Nov 2026), a seeded
generator, the file `EXAMPLE-brightwell-invoice-lines.csv` in an invented
Stripe-shaped layout. Planted: monthly plans on each customer's own day of
the month; 14 annual plans with **exactly three billed in October 2026**
(Quorvane Robotics and Glimmerford Media renewing, Saltmoth Logistics new);
usage overages billed in arrears; four Team-to-Business upgrades with their
two proration lines (one on 12 Oct 2026); onboarding fees with the
example's one rule (over 12 months); a $150 service credit; Brimbleton
Clinic's October invoice issued twice and voided; Ottercap Dental's August
quarterly invoice uncollectible; 12 customers in EUR; sales tax, VAT and a
launch discount.

`D.RECON` is October 2026 as the close typed it: the dashboard's billings
(before discounts, the void counted, EUR at 1.08), the ledger's revenue
(onboarding booked when billed, the uncollectible invoice's October revenue
taken off, EUR at 1.08) and deferred balance (no onboarding deferred,
unbilled usage kept apart, EUR at 1.08). Each ties to the cent and the
readings are found automatically; the test re-adds the dashboard figure from
the raw rows and works October's revenue day by day in floating point.

First run: two lines on the job, **Try the demo** (a guide bar steps through
columns -> rules -> schedule -> the tie-out with "Start here" on the biggest
bucket -> a customer) and **Load my billing export** ("Read on this device,
never uploaded"). The example's rules are never saved.

## Storage: one module, billing lines never

`public/waterfall-store.js` is the only module that touches browser storage
(IndexedDB, one `kv` store, every access wrapped, memory fallback): the
settings (through `cleanSettings`), two device flags and the home currency,
and the sync base. **No customer, invoice, amount or date is ever stored** -
an export lives only in the worker's memory, and the figures typed into the
tie-out only in the tab. `app.js` touches no storage itself (tested).

## Settings sync and the model call

- **Settings only**: `waterfall_settings/<owner tag>` = `{owner, settings,
  updatedAt}`; the tag is an HMAC of the account id under a key derived from
  `IDENTITY_SESSION_SECRET` ("waterfall owner v1"). Column presets by header
  name, the rules table (product description -> rule), the four account
  names, the period-end default, masking. `PUT /api/settings {settings,
  base}` saves in a transaction only if `base` matches, else **409 with the
  account copy** (Merge / Use the account's / Keep this device's). Refused
  whole (400): unknown fields anywhere, any string with an @ or 9+ digits in
  a row, markup, more than 500 rules, a bad rule, a header that looks like
  a value. No secret: 503.
- **`POST /api/ai/rules`**: `requireUser, requireBudget, requireDailyCap`
  **then** the 48 KB parser (401 / 402 / 403 / 503 before it, never 413),
  then `rulesRequest` rebuilds `{products: [{d, period, types, len}]}` and
  refuses anything else - unknown fields, more than 200, a description over
  120 characters, an @, nine digits in a row, an amount, a date, an
  id-shaped token, markup or invisible characters - 400, no model call. One
  forced tool (`suggest_rules`) through one call site (`ai.ask`). The answer
  (`cleanAiRules`): only numbers sent, each once, only the fixed rules
  (period, invoice, months with N 1-60, exclude, unsure), reasons with
  markup, links and addresses removed. The page builds the payload with
  `aiPayload`, **holding back any description that names a customer, a
  customer id or an invoice from the file**, shows the exact JSON first,
  and the person ticks which suggestions to apply. Signed out it offers a
  free account; 402 the credit sheet; 403 `verify-email` its sentence and
  "Send the link again"; sheets clear the confirm-your-email banner.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8173/waterfall/
npm test        # the rules, the demo, exports, settings, the AI, hostile input, the worker in a thread, the page, then HTTP under /waterfall
```

`WATERFALL_MEMORY=1` and `WATERFALL_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`.
`WATERFALL_COLLECTION_PREFIX` (`waterfall_` from the host) prefixes every
collection. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake
model refuses a call that does not force a tool, keeps every request,
suggests rules from the products it was sent, and takes `fakeClient.mode`
(`blank`, `bad`, `inject`, `maxtokens`, `upstream401`, `upstream529`) for
one call.

`test/run.js` (32 tests): reading; the column guess (the demo exactly, a
Stripe-shaped API export in cents with Unix seconds, an awkward generic
export); dates (zones to UTC, Unix seconds and milliseconds, ambiguous
day/month with both readings); the period-end evidence both ways; the day
split by hand and as a property; every rule; lines of every type and status,
discounts and tax both ways, currencies apart; the waterfall's totals and the
roll-forward's continuity; the journal balancing every month and in its CSV;
the tie-out worked by hand (billings and MRR, readings found or set by hand,
the ledger's revenue and deferred) and as a property (300 random cases, the
buckets always equal the gap); **the demo's planted figures**, checked
against sums from the raw rows; the demo made up (no real company); a
customer's balance; exports (CSV injection, numbers kept numbers, masking,
escaped Markdown); settings; the AI request and answer; storage; hostile
input (markup, bidi, malformed dates and amounts, 25 MB / 250,000+ lines in
about 6 s); the real worker in a thread; contrast in both themes and the
lab card; the page's promises; no invisible characters or key-shaped
strings; the local switches; and over HTTP: signed out with zero model
calls, no route that takes a line, the gate order, one model call site,
settings sync, the AI route and its gates.

Screenshots at 390px and 1280px, light and dark (first run, the demo's
columns, the rules, the schedule with its chart, the waterfall, the
roll-forward, the tie-out with the hint, a customer, the journal and the
close memo, column mapping for an awkward file, the AI sheet signed out and
in, settings synced, the lab card) and a hostile pass were taken with
Playwright.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, the worker, the
service worker. Signed in, free: `GET|PUT|DELETE /api/settings`. Metered:
`POST /api/ai/rules`. The shared account at `/api/auth`. No route takes an
export, a line, a schedule or a figure (tested).

## Ideas not built yet

- **Revenue earned before billing as its own journal line** (an unbilled
  receivable account) rather than a debit balance on deferred revenue - the
  roll-forward already splits it.
- **An opening balance** typed per month, for plans billed before the
  export's first invoice.
- **XLSX** exports and a NetSuite / QuickBooks journal import layout.
- **Exchange rates by month** for a converted consolidated view (today each
  currency is its own schedule and the tie-out takes one rate per currency).

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks and
  changes routed by one listener each (tested here and by
  `challenge/test/lab.js`). The worker is a same-origin file.
- No model call for a signed-out visitor, ever; every settings and metered
  parser runs after its gates.
- Files, typed figures, settings and model answers are untrusted: cleaned in
  the core (control, bidi and zero-width characters removed on reading),
  bounded, and escaped on render (the test cuts out every `esc(...)` call
  and fails on anything else concatenated into markup). CSV exports defuse
  `= + - @` (and tab or CR) with a leading `'`, while plain numbers - a
  credit's -12.00 - stay numbers.
- The service worker caches the app shell only - never api/, never a file a
  person loaded.
- Failures: only the app's own errors reach the page in their words; a
  provider error is a 502 (503 "The AI is busy"). Nothing logged carries a
  body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
