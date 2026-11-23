# For Claude: Duly

Every bill on time - without paying them yourself. The household's bills in
one list - who each is from, about how much, when it is due, how it is paid -
with an **AutoPay health** score and the steps to switch the rest on, **the
month** (paid, due soon, late, still to come), **amounts over time** with a
"higher than usual" flag, and every due date **in your own calendar** as an
.ics file. Optional AI: **Snap a statement** - a photo (or pasted text) read
for the due date, the amount due, the minimum and whether it says AutoPay,
which the person confirms before anything is saved.

Built 2026-10-20 as an **everyday** drop: Drill (2026-10-19) was a business
one, so today was the other kind. **Staging only**: no custom domain until
Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/duly`,
served at `challenge.strongtechnicalconsulting.com/duly/`, data in `duly_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (everyday life)

Erik asked for agents that pay his bills. The safe version of "I never have
to do it" is not an agent with a bank login: it is **every bill on its
provider's own AutoPay**, plus something that watches them and only speaks up
when a bill is wrong (higher than usual), late, new, or not on AutoPay. That
is Duly. It **never pays, never signs in to a bank, card or utility, and never
holds a password or an account number** - the page says so plainly on the
first screen, in the add form, in the reader and in the account sheet, and
the code refuses account numbers rather than promising not to keep them.

**Who it's for:** anyone running a household's bills.

**Not a repeat:** Drip finds forgotten *subscriptions* in a bank statement and
helps cut them; Duly is the household's *bills* - due dates, AutoPay health,
amounts that jump. Chaser is a business's receivables. Nothing else in the lab
or the portfolio tracks bills.

**Who pays.** Almost nobody. The bill list, the sample, AutoPay health and its
checklists, the month, logging amounts, the flags, the calendar export and the
settings are free, need no account and make no model call. A **free** account
adds sync. The one metered thing is **"Snap a statement"** (today: Haiku for
the free tier, Sonnet for members via `identity.planFor`; Gemini once
`DULY_AI_PROVIDER=gemini` is set - see below), about a cent.

**How it becomes an iPhone app.** Local notifications on the due dates (no
sender needed - the phone's own reminder), EventKit instead of the .ics, a
widget with "Next: Rent, Nov 1 - by hand", the camera for "Snap a statement".
Later, with Erik's say-so, FinanceKit could confirm an AutoPay went through -
it too would stay on the device.

## The decisions that matter

- **One rules file, run three times.** `public/duly-core.js` is UMD
  (`window.DulyCore` in the page, `require` in the server and tests):
  cleaning, the account-number rule, the category guess, a bill
  (`cleanBill`), its cycle and due dates, money, AutoPay health and the
  checklists, the month, the spike rule, the alerts, the .ics, the sample. No
  clock and no dice: everything that needs "today" is handed it as
  `YYYY-MM-DD` in the viewer's own day (tested).
- **Dates are civil days, sums on UTC midnights.** A daylight-saving change
  can never move a due date or miscount a gap: the suite runs the same sums
  under five time zones across both changes and gets identical answers.
- **Cycles** (`cleanCycle`): monthly on day N; every N (2-12) months on day N
  from an anchor month (counted back from it too); yearly on a month and day
  (Feb 29 falls on Feb 28 outside leap years); per statement (a due date
  entered per cycle, up to 24 kept). Day 29-31 means "or the month's last
  day" everywhere - the page, the month, the .ics.
- **How it is paid:** AutoPay on, AutoPay off (offered, not switched on), or
  I pay it by hand. Health is on / all; both of the others get a checklist.
- **Status of one due date** (`dueStatus`): paid when marked, or on AutoPay
  and the day has come (*assumed* on the due date, and it says so), or before
  the bill was added; today; late (a past date on a bill not on AutoPay, not
  marked); soon (seven days); later. Chips always carry words.
- **The spike rule** (`amountFlags`): more than N% (20 by default, 10-50 in
  Settings) over the **median of the amounts before it** (the last 12), so a
  jump never drags its own baseline up. With fewer than two before it, a
  fixed bill is judged against its typed amount and a varying one is not
  judged at all. A spike in the last 60 days is called out at the top.
- **Alerts** (`alerts`) are the only things Duly speaks up about: late, a
  bill due within three days with nothing paying it, higher than usual, a
  statement bill with no next date, a new bill (added in the last 14 days, or
  its first amount), and one line for the bills not on AutoPay. Otherwise
  "All quiet".
- **The checklists are generic by category**, never a claim about where a
  particular company keeps a setting (tested: no company names, no menu
  paths). Cards: the statement balance, not the minimum; from checking.
  Utilities: under Billing or Payments. Rent: ask, else your own bank's bill
  pay. Every card ends with the honest notes: keep a buffer, watch the first
  payment, Duly can't switch it on and will never ask for your login.
- **The calendar file** (`buildIcs`): RFC 5545, CRLF, folded at 75 octets
  (never inside a character), text escaped. All-day events (so no zone can
  move them), one recurring event per bill with an RRULE -
  `BYMONTHDAY=28,29,30,31;BYSETPOS=-1` for "the 31st or the last day",
  `INTERVAL` for every N months, `BYMONTH=2;BYMONTHDAY=28,29;BYSETPOS=-1` for
  Feb 29 - and one event per future date for a statement bill. A VALARM N
  days before at 9 am (0-7 in Settings). The phone downloads it; nothing in
  the cloud writes any calendar.
- **The first run** is a centred hero ("Every bill on time."), two pill
  buttons (**Try a sample household**, Add my first bill) and a text link
  (Or snap a statement), the promise as one quiet paragraph, a small mock of
  the "Coming up" list with a "31% higher than usual" flag, and "How it
  works". The sample (`sample(today, nowMs)`, dated from today) is nine
  made-up bills with history: one spike (the internet bill whose promo
  ended), two not on AutoPay (water: off and four days late; rent: by hand),
  one statement-based card, one new bill. Tested on several dates, including
  leap day and New Year's Eve. A strip says it is made up, with **Start my
  own** and **Clear the sample**; adding a real bill clears it.

## Account numbers: never kept (`duly-core.js`)

- **A field named like one** - account, acct, routing, IBAN, sort code, card
  number, CVV, SSN, password, PIN, login - at any depth of a bill, is refused
  with one sentence (`REFUSAL`, code `account-number`), whatever it holds.
- **A value shaped like one** - eight or more digits in a row, spaces and
  dashes allowed - in the payee or the note is refused the same way. Dates
  (2026-10-14, 10/14/2026) and phone numbers written the usual ways are read
  first and left alone; "ending 4421" is fine. The add form, the amount box,
  the sync routes and the merge all apply it; a merged bill that carries one
  stays on the phone (`refused` in the answer).
- **Text a model sends back is stripped, not refused**
  (`stripAccountNumbers`), and a pasted statement is stripped **before** the
  model sees it.

## Snap a statement (the one model call)

`POST /api/read {text | photo: {type, data}, today}`: `requireUser,
requireBudget, requireDailyCap` **then** the route's own 9 MB parser (a
stranger's body is never read; tested 401/402/403/503, never 413), then
`ai.brief` (exactly one of text or photo; text under 20,000 characters with
words and a digit, stripped of account-shaped numbers; a photo checked by its
bytes, 4 MB, by `lib/photo.js` - a 400 costs nothing), then the **lab AI
guard** (`global.LAB_AI_GUARD?.allow({provider, req, app: 'duly'})`; its
message and status go to the page and no call is made), then ONE call, then
`guard.record` with `guard.priceUsd`. With no guard loaded (the app on its
own) the identity gates stand alone. Nothing is stored or logged; the photo is
shrunk on the phone to ~1600 px JPEG (a canvas, which also drops its EXIF),
re-drawn smaller if it is still over **1.5 MB** and not sent at all if it
cannot fit (`PHOTO_MAX_BYTES`), and read once.

**The provider switch: `DULY_AI_PROVIDER`** (read per request in
`providerNow()`). Only the exact value `gemini` moves the call; unset or
anything else is **Claude, the provider Duly has always used**, so merging
changed nothing live. Turning it on is Erik's call (a Cloud Run env change),
and needs Vertex AI enabled with `aiplatform.user` for `challenge-run@`.
`/api/me` reports `reader: 'claude' | 'gemini'` so the sheet can say who
reads the photo.

**Fallback (2026-11-23).** With the switch on, if Gemini fails - a thrown
`VertexError`, a reading with no amount and no date, Gemini's `monthly-cap`,
or no helper - the same request goes down the Claude path unchanged (its own
`allow('claude')`, meter, record), with one log line `[duly] gemini failed
(<code>); used claude`. A burst refusal is sent as it is. `/api/read` answers
`reader: 'claude' | 'gemini'` (who actually read) and the sheet shows that.

- **Claude (the default).** One forced tool `record_bill` -> `{payee,
  category, amount, minimumDue, dueDate, statementDate, autopay:
  on|off|unknown}`, max 600 tokens, exactly as before (`lib/ai.js`). The tool
  has no field that could hold a number; the prompt says never to return one;
  `ai.cleanProposal` reads only the known fields, strips every string, bounds
  the dates (due -90..+180 days, statement -180..+1) and the amounts. The
  identity meter charges the person; the guard is told the cost unless the
  member's own key paid.
- **Gemini (`lib/gemini.js`, `gemini-3.8-flash`).** Through
  `guard.gemini.generate` - the app has no Vertex client of its own. The
  model reads **four things only**, through a `responseSchema` with no
  free-text field: `dueDate` (YYYY-MM-DD or ""), `amountDue`, `minimumDue`
  (numbers or null), `autopay` (`on | off | not_stated`). No payee: there is
  nowhere an account number or a name could come back. `cleanReading` takes
  only those four (a string is never an amount; whole cents within the app's
  bounds; a minimum above the amount is dropped; a real day within
  -90..+180), and answers in the page's proposal shape with `payee: ''`. A
  provider error is a status only (502, or 503 when busy or timed out); a
  failure that was still billed (`err.usage`) is recorded. **The person's
  ledger**: identity's price table is Claude's, so `chargeGemini` writes the
  call through `identity.recordUsage` at its real Gemini dollars, expressed
  as the Haiku input tokens that cost the same, with `route:
  'read:gemini-3.8-flash'` - so the $2 credit and the free tier's daily
  ceiling keep working. A Gemini row in `shared/identity.js` `PRICES` would
  be the cleaner fix; that file is shared and was not touched.

**The confirm step (the page).** "Read from the statement" lists the four
readings (plus who it's from when Claude gave a name). **"Which bill is
this?"** is a select of the person's bills plus "A new bill", preset by the
name when there is one, otherwise by `DulyCore.guessBill` - a guess from the
due date and the amount alone (points for a due date within four days, an
amount within 2% or 35% of the usual, a minimum on a card; 3 or more wins, a
tie is no guess; tested) - and it says it is a guess. Under it, what the
reading means for that bill, worked out on the phone from its own history,
never by the model: "25% higher than usual - it's usually $694.02", whether
the statement's AutoPay line agrees with Duly, the date Duly expected, and
"pay the statement balance, not the minimum". Then one button: **Save to
<bill>** (the amount for that cycle, the statement's due date, AutoPay on
when it says on, off when it clearly says off) or **Check and add it** (the
add form, prefilled). Nothing is saved before that tap. Signed out, the
sheet explains it needs a free account and that adding by hand stays free;
402 opens the credit sheet; 403 `verify-email` shows its sentence; the
guard's 429/503 show its own words.

## Sync (signed in, free)

`bills/<account tag>` = `{bills: {<id>: bill}, createdAt, updatedAt}`, the tag
an HMAC of the account id under a key derived from `IDENTITY_SESSION_SECRET`
("duly bills owner v1") - never the id or the email. With no secret, sync
answers 503 and the bills stay on the phone. Every write is a transaction;
`PUT /api/bills/:id` saves one bill, `DELETE /api/bills/:id` one,
`POST /api/bills/merge` brings a phone's bills in on sign-in (added if the
account lacks it, replaced only by a newer `updatedAt`), `DELETE /api/bills`
forgets the account's copy. Only `SAVED_FIELDS` are kept, never the sample;
documents are read by key, so **no query and no index**. Twelve saves from two
phones at once all stick (tested).

## On the phone

`localStorage`: `duly-bills-v1` (the bills), `duly-settings-v1` (the spike %
and the reminder days), `duly-tab-v1`. Every access is wrapped. A service
worker (`sw.js`, network first) keeps the app's own files for offline use,
never `api/`. Views: Home (what needs a look as the headline, Snap a
statement / Add a bill, heads-up, coming up, the score, this month, the
calendar), Month (a calendar grid and the list by status), Bills (a list
with sparklines), AutoPay (the score and a checklist per bill).

## Design (redesigned 2026-11-23, the lab's clean white look)

The rules are at the top of `public/app.css`; keep them.

- **Pure white page** (`#ffffff`; true black in a quiet dark mode that
  follows the system). No tinted or gradient backgrounds, no heavy boxes:
  space and type make the hierarchy. **Lists divided by 1 px hairlines**
  (`--line`, `#e5e5ea`) instead of stacks of cards; a `.card` / `.proposal`
  (white, hairline, 12 px corners) only where grouping truly helps. 10 px
  inputs and tiles, pill buttons and chips. No shadows except the faint
  `--float` on the phone nav, a sheet and a toast.
- **Type:** the system font stack only (never bundle or download a font);
  five sizes (13, 15, 16, 20, 28 - the first screen's headline goes larger),
  tight-tracked headings, tabular figures wherever numbers line up. Spacing
  on a 4/8 scale, 40 px between sections.
- **One accent**, the lab's on-time green (`lab.js` `#0b6b4f`; `#5fd3a6` in
  dark), for the page's primary action, links and the current view. Late /
  soon / paid / high / info colours are for status only, and a chip always
  carries its words.
- **Navigation.** Phone: a slim floating translucent pill (1.5 px line
  icons, the label only on the current view, a small accent mark,
  safe-area aware, 46 px targets). Desktop (900 px and up): a top nav in the
  bar with a quiet underline. The markup is still `.tabbar.dk-tabbar` and
  the shared `desktop.css` is still loaded (its `.dk-split`, `.dk-sheet`);
  its left rail and body padding are **overridden at the end of
  `app.css`** (`html body.dk`, `body.dk #tabbar.dk-tabbar`) - the shared
  file is never edited.
- **Icons:** one small set of line icons in `app.js` (`ICONS`, 1.5 px
  stroke). A bill's category keeps its emoji glyph in a neutral tile.
- **No `style=` anywhere** - not in `index.html`, not written by script
  (tested); spacing is classes. No inline script or handlers, as before.
- **Motion** (press states, the sheet rising, the score ring, the reading
  spinner) lives only inside `@media (prefers-reduced-motion:
  no-preference)`; every view is complete at rest.
- **Taps from Home:** snap a statement 1 (the sheet), add a bill 1 (the
  form), mark a bill paid 1, AutoPay steps 1, the month 1, download the
  calendar 1, a bill's detail 1, log "same as last time" 2.
- **Measured in Chromium** (390, 320 and 1440 px, both themes, every view
  and sheet): lowest text contrast 5.50:1 light and 6.61:1 dark; nothing
  wider than the screen; every target 44 px or more (at 320 px the calendar
  runs 14 px wider each side so a day stays 44 px).

## Data (Firestore: `duly_*` in the lab database `challenge`)

- `bills/<account tag>` - as above, until the account deletes it.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page. Signed in, free:
`GET|DELETE /api/bills`, `PUT|DELETE /api/bills/:id`, `POST
/api/bills/merge`. Metered: `POST /api/read`.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8132/duly/
npm test        # pure rules first, then end to end over HTTP under a /duly mount
```

`DULY_MEMORY=1` and `DULY_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`)
- in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn each
with `K_SERVICE` to prove it. `DULY_COLLECTION_PREFIX` (set to `duly_` by the
lab host) prefixes every top-level collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that does not
force a tool; it reads a pasted bill the dumb way and a photo as a fixed
made-up bill. Triggers in the text: `BLANK`, `INJECT`, `LEAK`, `MAXTOKENS`,
`UPSTREAMnnn`. With `DULY_AI_PROVIDER=gemini` the stand-in is
`fakeai.gemini` (handed to the guard's helper as `fake`, or used directly
when there is no guard): a photo is a made-up card statement due in twelve
days; `BLANK`, `INJECT` and `UPSTREAMnnn` work there too. Tests never touch
the network.

`test/run.js` (27 tests): cleaning; the account-number rule (fields, values,
dates and phones allowed, stripping); the category guess; due dates across
month ends, every-N-months across years, leap years and statements; DST in
five zones; money; AutoPay health and the checklists (no company named); the
spike rule and its alert; the month's statuses, totals and alerts; .ics
validity (CRLF, folding, BEGIN/END, RRULEs, VALARM, escaping, unique UIDs);
the sample on five dates; contrast in both themes; the local-only switches;
the prefix; the page (no inline script or handlers, relative URLs, wrapped
storage, no email, no clock in the core); and over HTTP: signed out with zero
model calls, the gate order, sync across two phones with refusals and nothing
identifying stored, reading a statement on Claude (bad requests before spend, stripping,
hostile output, a photo, errors not passed on, nothing stored), what the model
sees, and the 401/402/403/503 gates; then the AI guard and Gemini: the
provider switch and its default, the four-field schema, `cleanReading`'s
clamps, `guessBill`, the whole Gemini route against an injected guard (gates
and 400s before `allow`, `allow` -> call -> `record`, the photo inline, text
stripped first, hostile output, the person's ledger charged, a refusal's
words and no call, provider errors not passed on, nothing stored), and the
guard around the Claude call. The shared files (`lib/identity.js`,
`identity-store.js`, `byok.js`, `stripe.js`, `webauthn.js`;
`public/desktop.css`, `passkey-client.js`, `verify-banner.js`) are synced
copies - edit them in `eriks-projects/shared/`.

## What is deliberately not built

- **Paying anything, or signing in anywhere.** That is the point.
- **Reading a bank feed.** Aggregators hold bank logins; Duly does not.
- **Reminders from a server.** There is no sender, and the phone's calendar
  does it better from the .ics.
- **Confirming an AutoPay went through.** Without a bank connection Duly can
  only assume it on the due date - and it says "assumed" every time.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`, handlers by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the metered route's gates run
  before its parser, and the merge route's 256 KB parser runs after sign-in.
- Every typed string and every model field is untrusted: cleaned in the core
  and escaped on render. Checked in Chromium with a hostile payee
  (`"><img src=x onerror=…>`) through the list, the sheets and the toasts,
  with no CSP violation and no injected element.
- Failures (`fail()`/`failure()`, Receipt's): only the app's own errors reach
  the page in their words; a provider error is a 502 (503 "The AI is busy").
  Nothing logged carries a payee, an amount, a note, a pasted bill or a photo.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
