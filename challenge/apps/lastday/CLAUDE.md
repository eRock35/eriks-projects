# For Claude: Lastday

When someone leaves, every account leaves with them. For **IT managers, MSP
technicians and office managers** at small and mid-size companies who handle
leavers.

- **Orphan finder** (the core, deterministic): the identity provider's user
  export (Okta, Microsoft Entra ID, Google Workspace, JumpCloud or any CSV)
  and up to 20 **app user exports**, read in a Web Worker on the device. Every
  app account comes back **Orphan**, **Suspended in the IdP but active
  here**, **External**, **Shared / service**, **Dormant**, **Already off**
  or **OK**; admins and owners with no active person behind them are
  **critical** and lead. A summary ("7 orphaned accounts in 4 apps · 2 are
  admins · oldest leaver: 94 days"), filters by finding and by app, the
  findings as one wide table on a desktop and cards on a phone, and a
  **per-person view** ("Jordan Reyes: suspended in Okta since Aug 1 - still
  active in Accounting (admin), File share, Video meetings · already off in
  Team chat").
- **Leaver checklist**: from a leaver (name, address, last day and time,
  manager, who takes over files and mail, voluntary or not) and the
  company's **system inventory**, a timed checklist - before the last day,
  at the moment they leave (or the moment of notice), within 24 hours,
  within 30 days. Every step: a 44px tick, who did it, when, and an
  **evidence** note (typed, never uploaded). Apps the orphan finder found the
  person in are pre-filled; an app export that was loaded without them says
  so ("Not in the Accounting export you loaded" - one tap makes that the
  evidence). Progress, still open, overdue.
- **Paste the request**: a deterministic reader turns an email or ticket
  into the leaver's fields - each with **the words it came from** - and lists
  what is missing as questions.
- **Exports**: the findings as CSV, a checklist as CSV, as JSON for a PSA
  (`lastday.checklist.v1`, below) and as Markdown for the ticket. All made on
  the device; CSV formula-safe; Markdown escaped.
- **Signed in (free)**: the system inventory and settings follow the
  account. Never a person.
- **Metered AI**: "Read a messy request" - masked on the device first.

Built 2026-11-03 as a **business** drop: Takeback (2026-11-02) was everyday,
so today was the other kind. **Staging only**: no custom domain until Erik
decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/lastday`,
served at `challenge.strongtechnicalconsulting.com/lastday/`, data in
`lastday_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

Inspired by two Friction problems, named by title only: **"Removing a user
from the IdP leaves orphaned accounts and live sessions in apps"** and
**"MSP joiner/leaver requests arrive as prose and get re-keyed into the
PSA"**.

- **Disabling someone in the identity provider is not the end of it.** It
  does not reach apps that are not on single sign-on (the accounting app,
  the file share bought on a card, the video tool with its own logins), it
  does not end sessions already open or revoke API tokens and app passwords,
  and it does not give the licence back.
- **So leavers keep access for months, and nobody can prove otherwise.** The
  only way to know is to put the identity provider's list beside every
  app's list - by hand, in a spreadsheet, which nobody has time for.
- **The request itself arrives as prose** - "Sam's last day is Friday, keep
  their mailbox for the manager" - and someone re-types it into a ticket and
  a checklist, from memory, every time.
- **Lastday does both on the device, free**: it finds the orphans from the
  exports, and turns the email into a checklist with evidence a person can
  show an auditor or a client.

**Not a repeat.** **Firstday** (2026-10-23) is its sibling: a new hire's
first week, planned for a manager. Lastday is the other half - the leaver -
and is for whoever does IT. **Shadow** (2026-10-03) finds *tools* nobody
approved, from card statements and app-access exports; Lastday is about
*people who left* and the accounts they still hold in tools everyone knows
about. **Leash** maps an AI agent's permissions. Nothing in the lab or the
portfolio matches an identity provider's users against app user lists.

**Who pays.** Almost nobody. The demo, reading files, the orphan finder,
checklists, the request reader, every export and keeping it on the device
are free, need no account and make no request. A free account keeps the
system list across devices. The one metered thing (Haiku for the free tier,
Sonnet for members via `identity.planFor`) costs about a cent.

**How it becomes an iPhone app.** Not for loading 50,000-row exports on a
phone: for the checklist on site - a technician in the server room ticking
"wiped the laptop" with the evidence, offline, and the office manager seeing
it. Push when a step goes overdue. The core is one dependency-free UMD file
that an MSP's PSA integration or a nightly job could run as is.

## The decisions that matter

- **No user row, name or address ever reaches the server or a model** -
  except, for the one AI call, a request text that is *masked first*.
  `public/lastday-core.js` (UMD: `window.LastdayCore` in the page,
  `importScripts` in `public/lastday-worker.js`, `require` in the server and
  tests) holds every rule. There is **no route that takes a person**
  (`/api/scan`, `/api/upload`, `/api/users`, `/api/orphans`, `/api/findings`,
  `/api/leavers`, `/api/checklist`, `/api/request`, `/api/match`,
  `/api/people` are 404s, tested); the page's requests are listed by the test
  (`api/me`, `api/inventory`, `api/ai/request`, the auth and billing routes);
  the core, the demo and the worker contain no `fetch`, no storage, no clock
  and no dice (tested). "Today" and "now" are handed in.
- **The worker** reads the File itself (the text never passes through the
  page), keeps the parsed tables and the last result per workspace (the
  demo's and one's own, so one never answers for the other), and answers
  `parse`, `analyse`, `lookup` and `drop` - all `LastdayCore.createEngine()`.
  Without a Worker the page runs the same engine itself. 60,000 rows are
  capped to 50,000 and read and matched in well under a second in Node.
- **Reading** (`parseTable`): RFC 4180 - quoted delimiters, doubled quotes,
  line breaks in quotes; CRLF, LF, CR; a BOM; the delimiter sniffed (`,` `;`
  tab `|`), Excel's `sep=` honoured; a report title above the header skipped;
  a headerless file becomes Column 1..n; ragged rows padded or cut and
  counted. **Caps**, said in words on the page: 20 MB a file, 50,000 rows a
  file, 20 apps, 80 columns, 300 characters a cell (cut as it reads);
  control, zero-width and bidi characters removed and counted; an unclosed
  quote noted. Markup and formulas stay text.
- **Dates** (`readDate`): ISO with times and zones, `2026/10/01 14:32:11`,
  n/n/yyyy with the order detected per column, `Aug 1, 2026 9:12 AM`,
  `1 Aug 2026`; Unix seconds or milliseconds and yyyymmdd only in a column
  mapped as a date; "Never logged in" is never.
- **Column guessing** (`guessColumns`): header points (camelCase split and
  brackets dropped, so `userPrincipalName` and `Email Address [Required]`
  read) plus value-shape points (addresses, dates, two-word names, role and
  status words, yes/no). A job title is never a name (`NOT_PERSON`), a
  Created or Activated date is never a sign-in (`NOT_ACTIVITY`), a second
  address or a date column is only guessed from its header, "Is admin:
  true/false" is a role, a "status" column of Owner / Admin / Deactivated is
  read as the role. Each field is recognised / likely / check this; when
  every field is sure the page shows one line ("Every column recognised")
  with "Check or change". The identity provider is named from its headers
  (`guessIdp`) only for the words ("suspended in Okta").

### Matching and verdicts (`findOrphans`, `judge`)

- **By address first** (`normEmail`): case folded, `Name <a@b>` and
  `mailto:` dropped, plus-addressing dropped (`dana+files@`), the company's
  alias domains mapped to the first (settings: `example.com` =
  `example.co.uk`), an Entra guest UPN (`jo_partner.example#EXT#@tenant`)
  read as the guest's own address, and an IdP "other address" column
  (mail beside UPN, proxy addresses) counted. Each such match says how
  ("matched through the alias ...").
- **Then by name** (`nameKey`: accents, case, punctuation, honorifics and
  word order folded - "Reyes, Jordan" = "Dr. jordan reyes"), only when
  exactly one IdP user carries it - **flagged "matched by name - check"**.
  Two people with the same name: no guess.
- **Company domains**: the settings' list, or, empty, the domains holding at
  least 2 (and 5%) of the IdP's users.
- **Verdicts**, in this order:

  | Verdict | When |
  |---|---|
  | Already off | the app row says deactivated / disabled / inactive |
  | Shared / service | the local part fits a pattern (editable; `svc-*`, `reception`, `it`...), the role says bot or integration, or the name says shared |
  | Suspended in IdP | the matched IdP user is suspended |
  | Orphan | the matched IdP user is deprovisioned, or no IdP user at a company domain (left and deleted, or never added) |
  | External | no IdP user and another domain (or a match at another domain) |
  | Dormant | an active person, no activity here in N days (setting, default 90, inclusive) or never signed in |
  | OK | an active person, active here |

  **Critical** = owner or admin AND orphan or suspended. Sort: critical,
  then orphan/suspended by days since they left (status changed, else last
  sign-in), external, shared, dormant (longest idle first), off, OK.
- **The summary** (`summarise`): orphaned = orphan + suspended; the apps
  they are in; how many are admins; the oldest leaver in days.
- **The per-person view** (`peopleOf`, `personLine`): grouped by IdP user,
  else address, else name; leavers (critical first, longest gone first),
  outside accounts, dormant; shared accounts listed apart by address ("anyone
  who leaves may know the password"). A leaver opens a checklist in one tap,
  with the status-changed date as the last day (so every step shows overdue).

### The checklist (`buildChecklist`)

Each system in the inventory: a name, single sign-on yes/no, the steps it
needs (`STEPS`), and the **role** that does them (`OWNERS` - never a person).

| Step | Voluntary | Involuntary |
|---|---|---|
| Disable or remove the account, end sessions, revoke tokens, remove MFA, lock or wipe devices, collect hardware | at the moment they leave | at the moment of notice |
| Hand over admin and owner roles | before the last day | at the moment of notice |
| Transfer file ownership | before the last day | within 24 hours |
| Rotate shared passwords and codes | within 24 hours | at the moment of notice |
| Convert or forward the mailbox | within 24 hours | within 24 hours |
| Reclaim the licence | within 30 days | within 30 days |

Plus general steps: confirm the day (or, involuntary, line it all up for the
moment of notice and change nothing early), agree the handover, ask which
shared codes they know, collect hardware (dropped when a system collects
it), an auto-reply, tell the team, re-run the orphan finder at 30 days,
decide retention. **Due**: before = the working day before the last day;
the moment = the last day at the time given (else 5:00 PM, or 9:00 AM when
involuntary - shown as "assumed - set the time"); 24 hours later; 30 days
later. SSO and local systems get different wording ("Suspending them in the
identity provider does not end sessions already open here"). Within a phase:
general steps, then systems in the inventory's order, each system's steps
together. Ids are stable (`disable:files`), so an edit or "Rebuild from
systems" keeps every tick, name, time and note (`mergeTasks`). An admin
found in an app gets that app's "hand over admin roles" step; an app found
but missing from the inventory is added as a local-account system.

### The request reader (`parseRequest`)

Deterministic. The sender from a `From:` line; the leaver's name ("Sam
Okafor's last day", "last day for X", "X is leaving / resigned / let go",
"offboard X", "Leaver - X", "Employee: X" - names on one line, keywords
case-insensitive, a first name widened from the text or from the IdP export
with a note); the address that carries their name; the date nearest a
trigger ("last day", "leaving", "effective", "terminated"...) - weekdays
(today counts, with a note), this/next (next = the week after, with a note),
tomorrow, end of the week / month / next week, `11/14` and `14/11` (day first
when the browser writes dates that way or a part is over 12; a note when
both read), month names, "the 14th" (this month or next, with a note), "in
two weeks", "effective immediately" (now); the time near it (3pm, 17:30,
noon, "end of day" read as 5:00 PM with a note); involuntary words
(terminated, let go, for cause, effective immediately, laid off...) against
voluntary ones (resigned, retiring, moving on, notice...) - both: involuntary
with a note; mailbox keep / convert / forward / delete and to whom; files to
whom; manager; hardware. "me" is the sender. **Nothing is guessed
silently**: every field shows the words it came from and any note, and what
is missing becomes a question ("What time should their access end on Fri
Nov 6?").

## Storage: opt-in, and the inventory only in the account

- **Everything on the device** - systems, checklists, the last findings
  (names and addresses included) - touches the browser's storage only when
  "Keep this on this device" is ticked (off by default, with Clear), under
  `lastday-v1`. Too big for the quota: the findings are dropped and the rest
  kept. Every access is wrapped in try/catch (tested: three accesses).
- **Lab database**: `lastday_inventory/<owner tag>` = `{owner, inventory,
  updatedAt}` and nothing else (tested). The tag is an HMAC of the account id
  under a key derived from `IDENTITY_SESSION_SECRET` ("lastday owner v1").
  `PUT /api/inventory {inventory, base}` saves in a transaction only if
  `base` is the account copy this device last saw, else **409 with the
  account copy**; the page offers **Merge them** (`mergeInventory`: every
  system from both, this device's winning a name both have; both lists of
  domains and patterns), **Use the account's copy** or **Keep this
  device's**. Only one's own workspace syncs; the demo never does.
  `cleanInventory(strict)` refuses the whole body (400, nothing saved) for
  unknown fields anywhere (`users`, `leavers`, `members`...), more than 60
  systems / 11 steps / 10 domains / 80 patterns, an owner that is not a role
  from the list, a step that is not a step, and **anything shaped like a
  person's address**: an `@` in a system name or domain, a `first.last`
  pattern. No secret: 503, and it stays on the device. No query anywhere.

## The model call (metered): "Read a messy request"

`requireUser, requireBudget, requireDailyCap` **then** the route's own 8 KB
parser (401 / 402 / 403 / 503 before it, never 413 - tested), then the body
rebuilt by `aiRequest` - `{text, today, dayFirst?}` and nothing else. **The
page masks first** (`maskRequest`): every address `[email1]`, link
`[link1]`, phone `[phone1]`, run of 6+ digits or 9+ digits with separators
`[number1]`, each person the reader found and each known IdP name in the
text `[person1]` (a first or last name standing alone is the same token),
and any word the person chooses `[word1]` - with capitalised words that
look like names offered as "Hide more?" chips. The sheet shows **exactly the
masked text** before the tap. **The server refuses a text that still holds
an address** (`unmasked-email`) **or a long run of digits**
(`unmasked-number`), dates and times excepted - with a 400 and no model
call. One forced tool (`read_request`) through **one call site**
(`ai.ask`); the text is fenced (`<<<REQUEST`) as untrusted. Back:
`cleanAiAnswer` keeps known fields only - the address only as an `[emailN]`
token the request carried, a real date within a year of today, HH:MM, a
boolean, a mailbox choice from the list, hardware from the list, people as
tokens or a few plain words - and drops markup, links, addresses, bidi and
any token the request did not carry; a source quote is kept only if it is in
the masked text. The page **unmasks on the device** and shows each field
with its words as a proposal ("AI-read - check each one"); "Use these"
fills the fields, each marked "AI - check". Nothing stored, nothing logged.
Signed out, the sheet still shows the masked text and offers a free account;
402 opens the credit sheet; 403 `verify-email` shows its sentence and "Send
the link again"; sheets size themselves below the confirm-your-email banner.

## The demo (`public/demo.js`)

A **made-up** dental practice, **Harbor & Pine Dental** (14 staff,
`harborpine.example` and its alias `harborpinedental.example`), with an
Okta-style export and four app exports with their own header styles: Team
chat, Accounting, File share, Video meetings. Dates count back from the day
the page hands in. The test holds every finding on every 7th day for a year:

| Account | Shows | Finding |
|---|---|---|
| Jordan Reyes, Accounting | a hygienist suspended 94 days ago, still Company admin | Suspended, **critical** |
| Wren Halvorsen, File share | an associate deprovisioned 41 days ago, still Team admin | Orphan, **critical** |
| Jordan Reyes, File share and Video meetings | the same leaver's other accounts | Suspended |
| Wren Halvorsen, Team chat and Video meetings | | Orphan |
| Casey Morgan, Team chat | a front-desk temp never added to Okta | Orphan |
| Pat Delgado, Accounting | the outside accountant, another domain | External |
| reception@ (Team chat, File share), svc-scanner@ (File share) | shared and service logins | Shared |
| Marcus Bell, Video meetings | 133 days without a call | Dormant |
| Jordan Reyes, Team chat | already deactivated there | Already off |
| Felix Brandt, Accounting (`felix.b@`) | a short address | OK, matched by name - check |
| Dana's `+files` address, Hana's alias-domain address, Lena's capitals | | OK, each matched and said how |

"7 orphaned accounts in 4 apps · 2 are admins · oldest leaver: 94 days".
**Dana's email** (the office manager to the IT provider) reads into: Sam
Okafor, `sam.okafor@`, last day Friday, a resignation ("moving on"), keep
their mailbox for "the office manager (Dana Whitlock)" ("me" is the sender),
files to Hana Sato, a laptop and a key fob - and two questions: the time,
and the manager. Its checklist: **29 steps** (4 / 14 / 6 / 5) from the
practice's 9 systems, Team chat, File share and Video meetings pre-filled
with what the exports showed, Accounting marked "not in the export you
loaded". "A messier one" (a nickname, "after the 14th", "not a happy exit")
is there for the AI reader. The first-run screen offers **Try the demo**
(one tap to the orphan list with a "Start here" hint on the critical row,
which pulses) and **Use my own exports** ("Read on this device, never
uploaded", and where each export is found, in generic words).

## Exports

- **Findings CSV**: `app, account, name, verdict, critical, role,
  last_active, idp_status, idp_status_changed, days_since_left, days_idle,
  matched, why` - every finding and up to 2,000 OK accounts.
- **Checklist CSV**: `leaver, leaver_email, phase, due, system, step,
  detail, owner, status, done_by, done_at, evidence`.
- **Checklist JSON for a PSA** (`checklistJson`):

  ```
  { "format": "lastday.checklist.v1",
    "generated": "2026-11-03T10:20",            // local time, no zone
    "leaver": { "name", "email", "lastDay" (YYYY-MM-DD|null), "lastTime" (HH:MM|null),
                "involuntary" (true|false|null), "manager", "filesTo", "mailTo",
                "mailbox" ("shared"|"forward"|"keep"|"delete"|null), "hardware": [..] },
    "progress": { "total", "done", "open", "overdue" },
    "tasks": [ { "id" ("disable:files", stable), "phase" ("before"|"moment"|"day1"|"day30"),
                 "phaseLabel", "due" ("2026-11-06T17:00" or "2026-11-05", or null),
                 "system" (null for general steps), "sso", "action" (a step key or "general"),
                 "title", "detail", "foundInExport", "owner" (a role key), "ownerLabel",
                 "status" ("open"|"done"), "doneBy", "doneAt", "evidence" } ] }
  ```

  One task per step, ready to map onto PSA tasks or ticket notes.
- **Markdown** for the ticket: the details, then every step by phase as
  `- [x]` / `- [ ]` with the owner, who, when and the evidence. Every string
  is Markdown-escaped. CSV cells starting `= + - @`, a tab or a carriage
  return get a leading `'`.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8147/lastday/
npm test        # the rules, the demo across a year, the worker in a thread, the page, then HTTP under a /lastday mount
```

`LASTDAY_MEMORY=1` and `LASTDAY_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `LASTDAY_COLLECTION_PREFIX`
(`lastday_` from the lab host) prefixes every collection. `npm test` runs
with `REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that
does not force a tool, keeps every request (`fakeClient.calls`), reads the
masked text deterministically, and takes `fakeClient.mode` (`blank`,
`inject`, `maxtokens`, `upstream401`, `upstream529`) for one call.

`test/run.js` (32 tests): CSV quoting, line endings, BOM, delimiters, `sep=`,
a preamble, no header, ragged rows, duplicate headers; dates; Okta, Entra,
Google Workspace and JumpCloud headers and statuses; awkward app headers
(a status column of roles, "Is admin", a job title, a Created date, no
header); addresses (case, plus, aliases, guests, wrappers) and names; every
verdict and the critical order; dormant maths on a fixed clock; matching by
name (and never on a shared name); the per-person lines; **the demo's
findings on every 7th day for a year**, its email read on every day of a
week, its 29-step checklist; voluntary and involuntary timing, admin
handover, added apps, progress and overdue, ticks kept through a rebuild;
the reader's names, dates, times, kinds, mail, files, manager, hardware and
"me"; masking round trip; the AI request and answer checks; exports (CSV
injection, the JSON shape, Markdown escaping); strict inventory cleaning
and merge; hostile files (60,000 rows, a 2 MB cell, 90 columns, bidi,
markup, formulas) and hostile requests; **the real worker in a worker
thread** (a File read, analysis, lookup per workspace, the 20 MB refusal);
contrast in both themes and the lab card; the page's promises (no inline
script, storage opt-in and wrapped, no eval, every markup line escaped, the
service worker); neutral copy, no invisible characters and no key-shaped
strings in any file; the local switches; and over HTTP: signed out with
zero model calls and 401 before every parser, no route that takes a person,
the gate order, one model call site, inventory sync (409, people refused,
nothing identifying stored), the AI route (unmasked addresses refused before
any call, what the model saw, hostile output, errors not passed on) and the
401 / 402 / 403 / 503 gates.

Screenshots at 390px and 1280px, light and dark - first run, the demo's
orphan list with the hint, the person sheet, People, the request parsed
with its questions, the task sheet, the checklist part done with evidence,
exports, the AI sheet signed out and signed in with the masked text and its
proposal, own exports with awkward files (a BOM and a report title with
semicolons, a headerless list, an "Is Admin" column with day-first dates)
mapped and found, systems synced, a stale save's merge choice - and a
hostile pass were taken with Playwright.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, the worker, the
service worker. Signed in, free: `GET|PUT|DELETE /api/inventory`. Metered:
`POST /api/ai/request`. The shared account at `/api/auth`.

## Ideas not built yet

- **XLSX** exports read on the device (today: save as CSV).
- **Group and license exports** (who holds which paid seat) for a
  licence-reclaim total in money.
- **Session and token exports** (OAuth grants, API tokens per user) to prove
  "revoked" with data rather than a typed note.
- **Joiners** - the same inventory read the other way - would overlap
  Firstday; only if Erik keeps both.
- **A PSA push** (ConnectWise, Autotask, HaloPSA) - needs their API keys,
  which is infrastructure, so not a daily drop.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; no eval or
  `new Function` (a shared-account pattern becomes a `RegExp` with every
  character but `*` escaped); the worker is a same-origin file; clicks by
  one `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; every metered and inventory
  parser runs after its gates.
- File contents, typed notes, the server's answers and the model's answers
  are untrusted: cleaned in the core (control, bidi and zero-width
  characters removed and counted), bounded, and escaped on render (the test
  cuts out every `esc(...)` and fails on any field still concatenated into
  a line of markup). Tables scroll in their own box.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
