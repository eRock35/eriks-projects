# For Claude: Covenant

Know what your business loan expects of you - before the bank tells you.
A small-business owner, their bookkeeper, or a lender's support person
**pastes the loan agreement** (up to 60,000 characters) or **snaps up to six
photos of its pages**, and one model call lists every covenant: financial
tests, reporting deadlines, things you can't do without consent, things you
must keep doing, insurance. Each comes back in plain English, with **an
explanation a lender's staff can hand a customer** (with a Copy button), the
threshold, when it is tested, the section, how the agreement defines its
terms, and **the covenant's own words, checked word for word against the
document** - a quote that is not there is kept but flagged on its card. A free
**health check** takes the owner's numbers and, for each financial covenant,
says pass / tight / breach and **how much room is left in dollars** ("EBITDA
could fall by $5,800 (4%) before DSCR drops below 1.25x"; "you could add
$60,900 of debt before leverage goes above 3.0x"). The reporting covenants
become **dated deadlines** from the fiscal year end and an **.ics calendar
file**. Signed in, a loan can be **saved** (never its text) and checked each
quarter, with a sparkline per covenant.

Built 2026-09-28 as the twelfth of Erik's lab drops, after Spar, Snapquote,
Chaser, Rave, Pop Quiz, Glowup, Booth, Receipt, Tally, Tipout and Tells.
**Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/covenant`,
served at `challenge.strongtechnicalconsulting.com/covenant/`, data in
`covenant_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

Inspired by the Friction problem titled "Embedded SMB lender's support staff
can't explain its own loan covenants" (named by title only). Small businesses
sign term loans and lines of credit full of covenants - a minimum debt
service coverage, a maximum leverage, statements due 120 days after year
end, "no additional debt without consent" - and then discover them only when
they are in breach. The lender's own support staff often can't explain them
either. Nothing in the lab or the portfolio did this.

**Who it is for.** Small-business owners and their bookkeepers with a bank or
SBA loan; and support or relationship staff at small-business lenders who
have to explain covenants to customers (the "Explain it to a customer" toggle
and "Show customer explanations" are theirs).

**Who pays.** Nobody, for almost all of it: the example, the health check,
the headroom, the deadlines and the calendar work in the browser with no
account and no model call. Reading your own loan is one metered call
(Haiku for the free tier, Sonnet for members, via `identity.planFor`), usually
a few cents. Saving is free with an account.

**The honest risk.** A model can misread a covenant, and the numbers a
lender tests are the agreement's own definitions, which rarely match the
books exactly (EBITDA after distributions, debt service including leases,
the current portion of the loan in current liabilities). So every quote is
checked against the document, every health result shows its arithmetic and
the agreement's definition, and the page says once, plainly, "Not legal or
financial advice - your loan agreement is what counts."

## The decisions that matter

- **One rules file, run twice.** `public/covenant-core.js` is UMD: the page
  loads it as `window.CovenantCore`, the server and tests `require` it.
  Cleaning, the health check, headroom, periods, deadlines and the .ics are
  all there, so the phone and the tests compute the same answer.
- **Money is integer cents, ratios are compared exactly.** Typed money is
  read from its digits (`toCents`, never a float; negatives only for EBITDA
  and net worth). A 1.25x threshold is 1250 thousandths, and "EBITDA / debt
  service >= 1.25" is checked as `EBITDA * 1000 >= 1250 * debt service` in
  BigInt. A value is displayed rounded toward failing (a minimum rounds
  down, a maximum up), so "1.25x" is never shown for a breach. Headroom is
  rounded DOWN to the dollar, a shortfall UP.
- **Tight = met, but within 10% of the threshold** (below 1.375x for a 1.25x
  minimum, above 2.7x for a 3.0x maximum). Direction comes from the operator
  (`>=`/`>` a minimum, `<=`/`<` a maximum); a strict operator fails exactly
  on the line.
- **Headroom in both directions.** A minimum says how far the numerator can
  fall ("EBITDA could fall by…") and how far the denominator can rise; a
  maximum says how much more debt fits ("you could add $X of debt") and how
  far EBITDA can fall. A breach says what would fix it. Dollar tests (net
  worth, liquidity) say how far above or short.
- **Never throws on a bad number.** A zero or negative denominator is `cant`
  with a sentence (negative EBITDA under a leverage test: "lenders usually
  treat that as failing"); a missing input is `missing` naming the fields; a
  ratio test written in dollars, or metric `other`, is "check by hand". Only
  the fields the loan's financial covenants need are shown.
- **Every quote is looked for.** `Core.matcher` normalises Unicode, curly
  quotes, dashes, invisible characters and whitespace, then needs an exact
  substring of 12+ characters (a changed number, case or an ellipsis fails).
  Not found: kept, `verified: false`, a warning on the card, counted in the
  reading's banner and the glance tile. For photos the model returns a
  `transcript` of what it read and quotes are checked against that; the card
  says "Read from a photo - check it against the page". The transcript is
  never stored or sent back.
- **Model output is untrusted** (`Core.cleanCovenant`, run on a read AND on a
  save): enums from fixed lists, strings bounded and stripped of markup and
  direction overrides, thresholds read from strings ("1.25x", "$1.5
  million") and range-checked (a ratio over 50x or a deadline over 365 days
  is a misreading and dropped), a metric only on a financial covenant, at
  most 40 covenants. The page escapes everything again.
- **Deadlines** (`Core.deadlines`): `dueRule {daysAfter, of:
  fiscal_year_end|quarter_end|month_end, exceptFiscalYearEnd}` against the
  fiscal year end month (asked once per loan, default December; month ends,
  so Feb 29 in a leap year), every due date from today to a year out. The
  list shows the next of each covenant with "Then Nov 20, Dec 20…" so a
  monthly certificate cannot hide the annual statements; "Every date" shows
  all.
- **The .ics** (`Core.ics`) is RFC 5545: CRLF, lines folded at 75 octets
  without splitting UTF-8, TEXT escaping, all-day `VALUE=DATE` events,
  `DTEND` the next day, a `VALARM` a week before, and UIDs hashed from the
  loan, the covenant's title and the date, so importing again updates rather
  than doubles. Built in the browser; nothing is uploaded.
- **Save stores structure only.** A loan is one document: name, loan summary,
  cleaned covenants, fiscal year end month, and per period ("2026 Q3", "2025
  FY") the numbers typed, as cents. Never the agreement text, a photo or the
  transcript - tested by dumping the store after a read and a save. A
  saved loan's `verified` flags are the ones the page sends back from its
  reading; only the owner reads them.
- **The read streams whitespace** (`lib/stream.js`, Tells' copy): a long
  agreement takes a minute or more and iOS drops an idle connection. So
  sign-in, budget, cap, parser and the 400s come first with real statuses;
  after that a failure is a 200 `{error}`, and the page checks `data.error`.
- **The example** (`public/sample.js`, UMD) is invented and says so:
  "Example: Riverbend Bakery LLC - $350,000 SBA 7(a) term loan from Example
  Community Bank", an agreement text headed "EXAMPLE ONLY", nine covenants
  whose quotes are all in that text (tested), and four periods of numbers
  where DSCR slides from 1.64x to 1.31x (tight, $5,800 of room) while the
  current ratio stays at 2.0x. The fake model answers the example text with
  the same nine covenants, so "Paste the example agreement" demonstrates a
  real read locally.

## The first run

The page opens straight on the example: a navy strip "This is an example
loan - try it, then read your own" with **Read my loan**, the loan head (with
the one "Not legal or financial advice" line), three tiles (Health check "1
tight · 2 comfortable · DSCR 1.31x vs 1.25x - $5,800 of room", Next deadline,
Covenants), then the health check (results first, then the bakery's numbers
to play with), deadlines and every covenant - the first card's customer
explanation already open. Signed out, all of it works; Read my loan offers
"Sign in to read it". A 403 `verify-email` shows its sentence and "Send the
link again" in the read panel; 402 opens the credit sheet.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8112/covenant/
npm test        # pure rules first, then end to end over HTTP under a /covenant mount
```

`COVENANT_MEMORY=1` and `COVENANT_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `COVENANT_COLLECTION_PREFIX` (set to
`covenant_` by the lab host) prefixes every top-level collection. The fake
model refuses any call that does not force a tool. Triggers in the text (or
photo bytes): `BLANK`, `NOCOVENANTS` (422 sentences), `INJECT` (hostile
output), `MANY` (41 covenants), `UNVERIFIED` (adds one covenant whose quote is
not in the text), `MAXTOKENS`, `UPSTREAMnnn`; anything else reads as the
example.

## Data (Firestore: `covenant_*` in the lab database `challenge`)

- `loans/<uid>/items/<id>` - `{name, loan: {lender, borrower, amount, type,
  maturity}, covenants: [...], fye: 1-12, from: text|photo|sample, periods:
  {"2026 Q3": {inputs: {ebitda: cents, ...}, savedAt}}, createdAt, updatedAt}`.
  Under the owner's uid, so every route is a 404 for anyone else's. Written
  whole under a per-loan lock (a merge would keep a deleted period).

Limits (`Core.LIMITS`): 60,000 characters or 6 photos (3 MB each, 12 MB
together, decoded) a read, 40 covenants, 10 loans a person, 20 periods a
loan, $10B any one number. JSON bodies 128 KB except the read (17 MB, after
the gates) and saving a loan (600 KB, after sign-in).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, and the static page
(`covenant-core.js`, `sample.js`). Signed in: `GET|POST /api/loans`,
`GET|PATCH|DELETE /api/loans/:id`, `PUT|DELETE /api/loans/:id/periods/:period`.
Metered (`requireUser, requireBudget, requireDailyCap`, then the parser):
`POST /api/read` `{text}` or `{photos: [{type, data}]}`.

## Ideas not built yet

- **Compliance certificate drafts**: the numbers for a period, laid out the
  way the lender's certificate asks.
- **"What if" scenarios**: a new equipment loan's effect on DSCR and
  leverage before signing it (the negative covenant's $25,000 limit too).
- **Sharing a read-only loan with a bookkeeper or the lender** - needs links
  and a revocation story like Tipout's.
- **Reminders by email** instead of a calendar file - needs a mail path the
  lab does not have.
- PDFs directly (today: copy the text, or photograph pages).

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`
  (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the read's gates run before
  its 17 MB parser (tested: 401/402/403, not 413).
- Only the app's own errors reach the page with their words; a provider
  error is a 502/503 sentence (`failure()`). Nothing logged contains
  agreement text or numbers: logs carry a stack's first lines only, and
  parse errors (whose message V8 fills with the body) are never logged.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
