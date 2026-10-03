# For Claude: Shadow

Find the software your team signed up for without asking. Drop in the
company card or expense CSV and the Google Workspace or Microsoft 365
app-access export an admin can already download - **read on this device,
never uploaded** - and Shadow lists every tool with its status, owner,
contract, DPA, the data it touches, SSO, spend a year, users and the access
people granted it. A **Shadow score** (deterministic, with "How we worked
this out"), **the fixes that lower it most** with Apply, a **trial and
renewal radar** with an .ics, a **"Can I use this?" link** staff use with
no account, and **AI that reads a vendor's terms** with every quote checked
word for word.

Built 2026-10-03 as the twentieth of Erik's lab drops - a **business** day in
the alternation (Flight and Inside Joke, the newest before it, were everyday).
**Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/shadow`,
served at `challenge.strongtechnicalconsulting.com/shadow/`, data in
`shadow_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the problem)

Inspired by the Friction problem titled "Vendors give staff free trials,
creating unapproved systems with no contract" - one of Friction's strongest
that week. Staff sign up for free trials with a work email or the company
card; the trial converts, the tool fills with customer or student data, and
nobody approved it, owns it, or has a contract or data agreement for it. IT
and finance at small companies, schools and public agencies find out at
renewal or after an incident.

Who it is for: IT, ops, finance and compliance leads at small and mid-size
companies, schools, nonprofits and local government.

Not a repeat: **Drip** finds a person's own subscriptions; **Leash** is about
what an AI agent is allowed to do; Shadow is the organisation's software
inventory and approvals.

**Who pays.** Almost nobody. Finding tools, the score, the fixes, the radar,
the CSV export and the staff requests are free; signed out, all of it works
on the example and on your own files in this browser. Saving (up to three
inventories) and the request link need a **free** account. The one metered
thing is **reading a vendor's terms** (Haiku for the free tier, Sonnet for
members via `identity.planFor`), a few cents.

**The honest risk.** Finding software in a card statement is a guess: a
descriptor can hide a vendor, a tool paid on another card is invisible, and a
trial's conversion date is an estimate (14 days, the common length). So the
rules lean towards missing a tool rather than inventing one, anything not in
the curated table is "probably software - check", every tool can be edited
or removed, the radar says "about" and "check the sign-up email", and the
page says once: "Shadow finds patterns in your exports - check a tool before
you cancel it, and read the contract before you sign it." The terms reading
says "Not legal advice - read the contract." beside every result.

**How it becomes an iOS app.** Files/Share-sheet import for the CSVs (still
read on the device), a widget with "Trial converts in 3 days", reminders in
EventKit instead of an .ics, and a share-sheet extension staff use to send
"Can I use this?" from the vendor's own sign-up page.

## The decisions that matter

- **The files never reach the server.** `public/shadow-core.js` (UMD:
  `window.ShadowCore` in the page, `require` in the server and tests) reads
  them in the browser. There is **no route** that takes one (`/api/statement`,
  `/api/upload`, `/api/csv` are 404s, tested); `test/run.js` reads `app.js`
  and holds every request it makes to an allowlist, checks the "find the
  tools" section makes no request at all, that both inventory saves send
  `savedBody()` (tools through `C.toSaved`, the fixes applied, a name), and
  the server drops anything else a save carries (tested with the raw CSV,
  the transactions and the export stuffed into a body). The browser render
  pass imported real fixture files and saw no request until Save.
- **Reading a card statement** (`parseStatement`, `parseStatements`): ported
  from Drip's approach into this core (not imported across apps). Columns by
  header name (transaction date over posting date, `Merchant`/`Vendor` over
  `Description`, `Timestamp` for expense tools), a summary block above the
  header, headerless exports by shape, Debit/Credit columns, the sign of a
  lone Amount column by majority, `CR`/`DR`, comma/semicolon/tab, BOM, CRLF,
  decimal commas. Payments, transfers, refunds, interest and other money in
  are skipped and counted. 5 MB and 20,000 rows across up to 6 files; a row
  in two files counts once.
- **Finding the software** (`findSoftware`): `KNOWN` is a curated table of
  225 business services (CRM, HR and payroll, LMS and classroom tools, file
  sharing, e-signature, design, AI assistants, analytics, scheduling, chat
  and phones, video, projects, docs, forms, email marketing, accounting, help
  desks, developer and automation, passwords and security, websites, health
  records) - names, a category and the data such a tool typically holds,
  **no links and no claims about any vendor**. Anything else is software only
  with a strong hint (`.io`, `.ai`, `.app`, "software", "subscription",
  "license", "seats", "labs", "HQ", "cloud") or a weak one (`app`, `pro`,
  `.com`, `platform`...) **and** a steady bill on a cadence - and is marked
  `probable` ("Probably software - check"). `NOT_SOFTWARE` (restaurants,
  travel, office and library supplies, Amazon, utilities and telecoms...)
  is never software whatever its name. Spend a year: the last billing cycle
  x the cadence (a mid-month seat is folded into its cycle); an irregular
  bill annualised; one charge of $100+ with 40 days after it is "probably
  yearly" and gets a renewal date. **Trials**: a charge of $1 or less then
  the full price 3-45 days later (converted), or alone and recent (converts
  about 14 days after), or "trial" in the descriptor.
- **Sign-in exports** (`parseAccess`): Google Workspace's app-access list and
  OAuth token log, Microsoft Entra's enterprise apps and sign-in logs, or
  anything shaped like them - by header names with variants (app name /
  application / displayName; users / user count; user / username / UPN;
  scopes / requested services / permissions). Rows of one app per user are
  counted into distinct users. Google's and Microsoft's own apps are left out
  and counted (`BUILTIN`). Every scope becomes a risk id (`scopeRisk`, `RISKS`)
  with plain words and a breadth 0-1: `gmail.readonly`/`Mail.Read` "read all
  mail" 0.9, `https://mail.google.com/` "read, send and delete all mail" 1,
  `drive`/`Files.ReadWrite.All` "read and write all files" 0.9,
  `drive.file` "only files it made or was given" 0.2, Classroom/Edu rosters
  "read classes, rosters and coursework" (student records), sign-in only
  0.05. A grant's usual data joins the tool's data.
- **Merging** (`mergeSources`, `mergeInto`): one row per `toolKey` - the
  curated id, else the first meaningful word (or the first two run together
  when the first is short or generic), so "INKSWIFT SIGN SOFTWARE" on the
  card and "InkSwift" in sign-ins meet. Spend from the card, users and scopes
  from sign-ins, the export's spelling for an unknown name. Importing again
  keeps every decision (status, owner, paperwork, data, SSO, notes) and
  refreshes what was measured; new tools join as "Not approved".
- **The score** (`toolRisk`, `scoreAll`), drawn on the page as "How we worked
  this out" and in each tool's sheet as its factors. Per tool, every factor is
  1 in good shape and grows as it gets worse:
  - status: approved 0.3, retiring 0.45, under review 0.65, not approved 1;
  - data: the most sensitive kind - student/health 1, customer/employee/
    financial 0.8, confidential 0.5, none 0.1, not set 0.5 - plus 0.1 per
    further personal kind, at most 1.3;
  - access: 1 + breadth (above); users: 1 + 0.5 x log10(1 + users)/2, at most
    1.5; spend: 1 + 0.3 x log(1 + dollars)/log(20,001), at most 1.3;
  - contract: none 1.3, click-through 1.15, signed 1; DPA: personal data
    without one 1.35 (1.5 for student or health); SSO: 1.15 without it when
    2+ people (or unknown) use it; owner: 1.15 with nobody named.
  raw = 40 x all of them; tool score = 100 (1 - e^(-raw/100)).
  **Overall**: R = 0.75 x (mean raw of the ten riskiest tools, empty places
  0) + 0.25 x (mean raw over every tool); score = 100 (1 - e^(-R/100)).
  Bands Low <25, Watch 25+, High 50+, Severe 75+. Tested monotonic over 400
  random inventories (each of the nine factors made worse never lowers a tool
  or the overall). An earlier sum-based overall saturated at ~86 and moved a
  point a fix; this one moves 1-3 points a fix on a 30-tool estate.
- **Fixes** (`candidates`, `fixes`, `topFixes`): DPA (personal data, none
  yet), signed contract (personal data or $1,000+), SSO (2+ users), cut broad
  access (grants of breadth 0.7+, never Classroom rosters - that is the job),
  name an owner (Apply asks for a name), retire (not approved, no owner, 3 or
  fewer users), and doubles in the overlap categories ("Retire one of the two
  e-signature tools - InkSwift costs $1,200 a year": keep the approved,
  most-used one). Each is applied to a copy and re-scored; `delta` is exactly
  the drop, to a tenth of a point (the overall is drawn whole; most fixes are
  worth less than one). The first three shown are the best fix for three
  different tools. Apply marks it done (the `done` list is saved), Undo goes
  back, the ring counts down (instant with reduced motion).
- **The radar** (`radar`, `ics`): trials converting (and one that probably
  converted in the last week), yearly/quarterly renewals and contract ends in
  the next 60 days, sorted. The .ics: an all-day event the day before a trial
  converts, a week before a renewal, two weeks before a contract ends, never
  before today; RFC 5545 (escaped text, CRLF, 75-octet folding, a 9am alarm,
  UIDs from the tool and the kind so a moved date moves the event).
- **"Can I use this?"** Each saved inventory gets a request link
  `r/<rid>` (16 random bytes; the page is the SPA under `<base href="../">`,
  `Referrer-Policy: no-referrer`). Staff need no account: they name the tool,
  why, the data it would touch, whether a trial is running, how many people,
  and their name. They ask **as themselves only** - status, conditions and
  any key are never taken from the body - and see and withdraw **only their
  own** requests, through an HttpOnly browser key (`shadow_k`, path-scoped);
  each request keeps sha256(key + rid), never the key. The link shows the
  org's name and nothing from the inventory; a GET never sets a cookie. The
  owner sees the queue with names, approves with conditions or declines; the
  decision is a transaction (decided once, 409 after) and is folded into the
  inventory (`applyDecision`: approved and owned by the requester, or Not
  approved; a declined new tool is added only when a trial is running, so
  it is on the radar). Pause/reopen the link. Limits: 200 open per org, 20
  open per browser, 10 new requests an hour per address (IPv6 by /64), 30
  distinct wrong links per address per 15 minutes, then 429.
- **Read a vendor's terms** (`POST /api/terms`): `requireUser, requireBudget,
  requireDailyCap`, **then** a 512 KB parser, then the length checks (300 to
  60,000 characters, 400s before any spend), then the whitespace stream and
  ONE forced tool `review_terms`: trains AI (yes/no/opt-out/unclear),
  retention, location, subprocessors, breach notice, DPA offered
  (yes/no/unclear), auto-renewal, cancellation notice - each with a detail, a
  verbatim quote and a confidence. `Core.cleanTerms`: enums from fixed lists
  (anything else "unclear"), strings bounded and stripped, unknown items
  dropped, and **every quote looked for in the pasted text** as an exact
  substring after Covenant's normalisation (curly quotes, dashes, whitespace;
  the text is scrubbed of markup the same way the quote was; under 12
  characters never counts). Not found: kept, marked "Not found in the text -
  check it", counted above the list. "Add this to <tool>'s notes" writes one
  line of answers, no quotes. The text is never stored, logged or sent back
  (tested with a marker string).
- **Saving** (signed in, free): up to 3 inventories per account under
  `orgs/<uid>/items/<orgId>`, each `{name, kind, tools, done, rid}`; tools
  are `SAVED_FIELDS` only. 500 tools, 1 MB body after `requireUser`, 120
  saves per account per 10 minutes, a per-inventory queue. Every org route is
  a 404 for anyone else's. Deleting an inventory deletes its link and every
  request. Signed out, the inventory lives in `localStorage` `shadow-v1`
  (tools only, every access in try/catch); a saved one's local copy is
  cleared on sign-out. **Export CSV** (`toCsv`): every column, a BOM, and a
  formula guard - a cell starting (after any whitespace) with `= + - @` gets
  a `'`, control and bidi characters become spaces.
- **Failures** (`fail()`/`failure()`): only the app's own errors reach the
  page with their words; a provider error is a 502 (503 "The AI is busy")
  sentence. Nothing logged carries a tool, a name, a request or pasted text.

## The first run

The page opens on **Harbor County Library** (`public/sample.js`), a made-up
library system: a year of a made-up purchasing card and a made-up Workspace
export run through the same rules as anyone's files, then the decisions its
IT lead has written down. 29 tools, **69 High**: "29 tools - 12 nobody
approved, 7 holding customer data with no contract, $5,628 a year on tools
without an owner." An AI note-taker (Notewise) with "read all mail" granted
by 14 people, a homework helper (HomeworkHero) holding student records with
no DPA, two e-signature tools (DocuSign and InkSwift), a social-posting trial
(Postcraft) converting in 3 days, one "probably software - check", and two
staff requests waiting. **The real services in it are only ever approved or
under review; every tool with a problem is an invented name.** The top three
fixes take it to 62. Approving or declining an example request, previewing
the staff form, Apply and Undo all work on the example, locally.

On a 390px phone the first screen is the dark strip ("This is an example
library system - try the fixes, then check your own.", a big **Find our
tools**, "read on this device. Nothing is uploaded."), the score ring with the
headline sentence, and the first fix. **Find our tools** opens three ways in,
each with a 3-step how-to: the card CSV, the sign-in export (Google
Workspace / Microsoft 365 tabs), and a pasted list (plus Add one by hand),
then a "Found N tools" list to untick, a name and a kind, and Add.

On a desktop the score, fixes, radar, requests and the explanation sit in a
left column beside the inventory and the terms reader.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8116/shadow/
npm test        # pure rules first, then end to end over HTTP under a /shadow mount
```

`SHADOW_MEMORY=1` and `SHADOW_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `SHADOW_COLLECTION_PREFIX` (set to
`shadow_` by the lab host) prefixes every top-level collection. The fake
model refuses a call that does not force a tool, quotes the sentence it found
each answer in, and always paraphrases the retention quote (so the
unverified path shows locally). Triggers in the pasted text: `NOTTERMS`,
`INJECT` (hostile output), `MAXTOKENS`, `UPSTREAMnnn`. `npm run dev` keeps
email verification on unless run with `REQUIRE_VERIFIED_FOR_FREE_AI=0`.

Fixtures (`test/fixtures/`): a Chase-style business card (negative
purchases, a payment, a return), Amex (positive purchases, card member
column), Capital One (Debit/Credit), Bank of America (summary block, a
transfer, interest, a junk row), a European semicolon file (BOM, CRLF,
decimal commas, DD.MM.YYYY), an Expensify-style report, Google's app list and
token log, Entra's enterprise apps and sign-in log.

## Data (Firestore: `shadow_*` in the lab database `challenge`)

- `orgs/<uid>/items/<orgId>` - `{name, kind, tools: [SAVED_FIELDS], done:
  [{id, text, at}], rid, createdAt, updatedAt}`. No transaction, no
  statement, no export, no email.
- `links/<rid>` - `{orgName, accepting, createdAt}`.
- `requests/<rid>/items/<qid>` - `{tool, name, why, data, trial, users,
  status (open|approved|declined|withdrawn), conditions, keyHash, at,
  decidedAt}`.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `GET /r/:rid`.
Staff, no account: `GET|POST /api/r/:rid`, `DELETE /api/r/:rid/:qid`. Signed
in, free: `GET|POST /api/orgs`, `GET|PUT|DELETE /api/orgs/:id`,
`PATCH /api/orgs/:id/link`, `GET /api/orgs/:id/requests`,
`POST /api/orgs/:id/requests/:qid`. Metered (`requireUser, requireBudget,
requireDailyCap`, then the parser): `POST /api/terms` `{text, vendor}`.
There is deliberately no route for a statement or an export.

## Ideas not built yet

- **Rotate the request link** (today: pause it, or delete and save again).
- **Owner reminders** before a renewal by mail - needs a sender per org; the
  .ics is the honest version.
- **Read a DPA against a checklist** (a second terms mode).
- **Okta and JumpCloud exports**, and Google's OAuth log over the API with
  the admin's consent - which would be the first time a file left the device,
  so it needs Erik's say-so.
- **Per-department views** from the card's cardholder column.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`
  (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the terms route's gates run
  before its parser (tested: 401/402/403, not 413), and the save parser
  after sign-in.
- Statement, export, staff and model text are untrusted: every string is
  cleaned (markup, control and bidi characters gone, bounded) and escaped on
  render; the .ics and the CSV escape theirs.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
