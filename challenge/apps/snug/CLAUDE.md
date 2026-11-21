# For Claude: Snug

The boring jobs that keep a home working, on time - and the breaker panel
finally labelled. For **homeowners and renters, first-time buyers
especially**: nobody hands you the list.

**This is a rebuild of the 2026-11-18 drop.** Snug was first built and
reviewed on 2026-11-18, then lost with its build container on 2026-11-20
before it was pushed. Erik asked for the lost drops back on 2026-11-21. Its
code and brief did not survive; this was built fresh from the spec in the
repo-root `HANDOFF.md` ("Snug - everyday"), which summarises the original
commit message. Everything the spec names is here. It drops again as drop
#63 on 2026-11-21.

- **A few chips about the home** (`SnugCore.CHIPS`, `FEATURES`): own or
  rent, house / townhouse / apartment, how it is heated and cooled, where
  the hot water comes from, any gas, how hard the winters are, and eleven
  features (gutters, fireplace, garage door, washer and dryer, sump pump,
  septic, well...). A nickname, and an optional move-in date. **No address,
  no map, no location - ever**: the text door refuses a street address, and
  no code asks for a position (tested).
- **44 rule-based jobs** (`SnugCore.JOBS`), in our own words, each with why
  it matters, how to do it (2-4 steps), how long it takes a first-timer, how
  often, the months it belongs in, and whether it is do-it-yourself, either,
  or a pro's job. Which apply comes from the chips (`COND`). Listed safety
  first.
- **Renters**: the landlord's jobs (`landlord: true`) are marked "Landlord",
  left out of the on-time ring, and carry a polite note to send
  (`landlordNote`) - shared as plain text or copied.
- **The plan**: Overdue / This week / This month / Later. A job done before
  is due its interval on, moved into its season (`fitMonths`); a job never
  done here goes into a first round spread over eight weeks, six a week,
  safety first, so a new home is not 44 jobs due today. Done today or on a
  day (never a future one), take the last one back, "Not now" (a week),
  "Not for us" (set aside, and back). A **house-shaped on-time ring**: the
  outline of a house that fills with the share of your own jobs not overdue.
- **Winter-ready**: the 15 winter jobs that apply, each ready once done
  since 1 August.
- **The breaker panel map**: the panel's spaces (2-60) and main breaker;
  each breaker by its space, odd down the left and even down the right, a
  two-pole one taking the space below; "Not labelled yet" until named; a
  taken space or one off the panel refused with what to do. Search by what
  it runs, its amps or its space. A **printable door label** (Letter or A4).
- **House facts**: where the water, gas and power shutoffs are, the water
  heater, the filter size, bins, paint colours, anything else - plain words,
  **never a code or a password** (the door refuses "gate code 4471", "wifi
  password", "lockbox", a PIN...). **Photos stay on the phone** (below).
- **Appliances**: what, maker, model, the year it was made (with its age in
  plain words, never a verdict), fuel, size, filter, a note. Never a serial.
- **A house manual** to print (facts, appliances, the panel, every job with
  how often, next and last) and **an .ics calendar file built on the
  phone** (each job on its next date, repeating at its interval; all-day,
  so no time zone; a renter's landlord's jobs only if ticked).

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/snug`,
served at `challenge.strongtechnicalconsulting.com/snug/`, data in `snug_*`
collections of the lab's `challenge` database. See `challenge/CLAUDE.md`.
Every browser URL is relative to `BASE`. Staging only.

## Why it exists

An **everyday** drop. Most first-time buyers learn about the furnace filter
when the furnace stops, about the hose bib when it splits in spring, and
about the breaker panel in the dark. The jobs are well known, but scattered;
Snug makes them one short, timely list for *this* home, and finally gets
the panel labelled. Free first: everything works signed out and offline.

**Not a repeat**: Glovebox keeps a car's records; Ajar and the rest have
nothing to do with a home's upkeep.

**No real brands, anywhere** - no appliance, heating, hardware, alarm or
home-services company. The demo's appliance makers are coined: **Corvane,
Aldermoss and Brindlecote** (the original's names, from its surviving commit
message; not searched again for the rebuild). The suite checks every file
for a list built from pieces.

**Who pays.** Almost nobody. A free account keeps one home in step across two
phones. The one metered thing - reading a rating plate - costs about a cent
(Haiku for the free tier, Sonnet for members, via `identityLib.planFor`).

**How it becomes an iPhone app.** Reminders through the phone's own
calendar (the .ics already), a Lock Screen widget with the next job, the
camera straight into "Read the label".

## The decisions that matter

- **One rules file, run three times.** `public/snug-core.js` is UMD
  (`window.SnugCore` in the page, `require` in the server and the tests).
  **No clock and no dice**: today, every time stamp and every id are passed
  in (tested).
- **Text is refused, never cleaned** (`refuse`): markup, bidi and invisible
  characters, an @ in any width, a link, a formula, a card number, nine
  digits in a row in any script (`\p{Nd}` after NFKC), a phone number, a code
  or password, a street address. Reading back an old copy mends (`line`).
- **The one door** (`cleanHome`): strict on the server (anything out of shape
  is an error and the whole body is refused), lenient for this phone's own
  copy (the bad bit dropped).
- **Snug gives no safety verdicts.** Every job sheet says "when in doubt,
  call a pro", and the label reading drops any verdict a model adds.

## The example (`public/demo.js`)

**The blue bungalow** is invented, with a fixed clock (Saturday 21 November
2026) and a planted story the suite checks exactly: 36 jobs; 3 overdue (the
gutters, the furnace filter, the smoke alarm test), 4 this week (the panel
look - never done here, so the first round puts it today - the hoses, put off
with "Not now", the pipes and the range hood filter), 12 this month, 17
later; 33 of 36 on time (92%; 94% after the tour's first tap); 6 of 11
winter-ready; a 40-space panel with a 200 A main, 20 breakers, two two-pole
and two never labelled; six appliances by Corvane, Aldermoss and
Brindlecote. Every view and printout says it is made up; it keeps no
photos, downloads nothing and is never kept, sent or synced.

**The tour**, five steps: the plan (tick the furnace filter done - the ring
moves), a job's why / how / how long (open the gutters), Winter-ready, the
panel (find the dishwasher), house facts and the example label (a made-up
Aldermoss dryer plate drawn as SVG with its serial blacked out; its
pre-made reading carries a serial, a recall line and advice, which the same
check as a real reading drops), then "Set up my home".

## Storage: one module, photos on this phone only

`public/snug-store.js` is the only module that touches browser storage
(IndexedDB `kv`, every access wrapped, falling back to memory and saying
so): the home (through `cleanHome`), this phone's flags, the sync base, and
**photos** - redrawn through a canvas at 1280 px (EXIF and location gone),
kept as JPEG data URLs under a known fact or appliance, at most 30, **never
sent, never synced**. `app.js` touches no storage itself (tested).

## Sync (signed in, free) and the merge

`snug_homes/<owner tag>` = `{owner, home, updatedAt}`, the tag an HMAC of the
account id under a key derived from `IDENTITY_SESSION_SECRET` ("snug owner
v1"). One home per account. `PUT /api/sync {data, base}` saves in a
transaction only if `base` matches the stored `updatedAt`, else **409 with
the account's copy** (`code: 'conflict'`); a home removed on another phone is
409 `removed`. Refused whole (400) for an unknown field anywhere, an @, nine
digits, a link, a formula, markup, an invisible character, a code or a
password, an unknown chip, job, kind or fuel, a breaker off the panel, more
than 80 circuits or 40 appliances; ~200 KB stored (413); the 1 MB parser
after the sign-in; 120 saves per account per 10 minutes. The page re-asks
when it comes to the front and every minute.

**The merge** (`SnugCore.merge`): the chips and the panel by their own
times; each job keeps **every done date from both phones** (the latest 12),
its "not now" and "not for us" from the later change; each circuit, fact and
appliance by its own time, a removal being a change like any other. Two
breakers both phones put in one space are **kept and flagged** ("Both phones
put a breaker in space 23: Shed and Garden lights. Move one?"), never
dropped. Symmetric and idempotent (by hand and over 200 random pairs, each
result passing the strict door).

## The model call (metered, signed in only)

**`POST /api/ai/label`** - "Read the label". `requireUser, requireBudget,
requireDailyCap` **then** the route's own 4 MB parser (401 / 402 / 403 / 503
before it, never 413 - tested), then `labelRequest` rebuilds the body to
**the image alone** - exactly `{image: {type, data}}`; a home, a note, a
question is a 400 `extra-field` with no model call. The photo is checked by
its magic bytes (JPEG, PNG or WebP; 2.5 MB decoded; 1600 px a side) and its
metadata stripped again (`lib/image.js`, Rush's).

One forced tool, `record_plate`: kind (enum), maker, model, year (only if a
manufacture date is printed - never worked out from a serial), fuel (enum),
size, volts, amps, unsure. **No serial field.** One fixed sentence: "Read
this rating plate." `max_tokens` 360 with the arithmetic in `lib/ai.js`.
`cleanAiLabel` keeps only those fields: any other field (a serial, a price,
a recall, a safety verdict, advice) is dropped and named; a text that strays
into a price, a recall, a safety verdict or "replace it", or carries a
serial, an email, a phone number, a link or markup, is dropped; an unknown
kind or fuel and a year outside 1950 to this year are dropped; nothing
readable is a 422. The page shows the reading as a draft appliance with the
unsure fields outlined and "Left out by Snug's checks: ..." - **Save** keeps
it. Before the tap the sheet shows the exact JPEG and says "nothing else".
Signed out it offers a free account and the example. No model call for a
signed-out visitor, ever.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8176/snug/
npm test        # the rules, the demo, storage, the look, the page, the copy, then HTTP under /snug
```

`SNUG_MEMORY=1` and `SNUG_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js` (the tests
spawn each with `K_SERVICE` set). `SNUG_COLLECTION_PREFIX` (`snug_` from the
host) prefixes every collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that does
not force a tool, keeps every request, reads a made-up Corvane furnace
plate, and takes `fakeClient.mode` (`blank`, `bad`, `inject`, `maxtokens`,
`upstream401`, `upstream529`) for one call.

`test/run.js` (28 tests): the 44 jobs and the chips that pick them; dates,
seasons, the first round and "Not now"; done / undone / set aside, the ring
and Winter-ready; the landlord's note exactly; the panel (spaces, two-pole,
refusals, search, the door label); facts and appliances; hostile text; the
strict and lenient door; the .ics (CRLF, 75-octet folding, escaping,
RRULEs); the merge by hand and as a property; the label request and answer;
the demo's planted story; the storage module; contrast in both themes, the
lab card's colours (white text and 20+ in CIE Lab from every card), 44 px;
the page's promises (no inline script, BASE-relative, the requests it
makes, every interpolation escaped, the tour); the copy (no brands, emails,
phone numbers, invisible characters, session links; model names only in
`MODELS`; the shared files byte-identical); the local switches and the
prefix; and over HTTP: signed out with zero model calls, cross-site writes
refused, the gates before every parser, sync with its 409 merge and refused
bodies, the AI route (what the model saw, the answer checked, 422 / 502 /
503 / 413), the 403 / 402 / 503 gates, and a hostile pass that leaves nothing
personal in the store.

**Rendered** in headless Chrome (driven over the DevTools Protocol - there is
no Playwright on the build VM) at 390 px and 1280 px, light and dark: the
first run, every tour step, a job sheet, Winter-ready, the panel (search,
a breaker's sheet), house facts, the example label draft, More and the .ics
sheet, a renter's setup and plan with a landlord's note, an empty panel and
house, and the signed-out label sheet. No console error or CSP violation,
nothing sideways, no target under 44 px. Found on the way: circuits and
appliances listed without their ids (the panel drew every space empty),
"pin" in "the pin and seal" read as a PIN, and a landlord's note that said
"is coming up" for a job due today.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/healthz`, `/api/meta`, `/api/me`, the page, the
service worker. Signed in, free: `GET|PUT|DELETE /api/sync`. Metered:
`POST /api/ai/label`. The shared account at `/api/auth`. No route hosts a
home, a manual or a photo (tested).

## Deliberately not built

- **Push reminders**: there is no sender here; the .ics puts the jobs in the
  phone's own calendar, which already reminds.
- **Finding or booking a pro, prices, recalls or "time to replace it"**: a
  list of tradespeople needs brands and reviews; a price or a verdict from a
  photo would be guessed. Snug says when, never who or how much.
- **A share link for the house manual**: it would publish where the
  shutoffs are and what is in the house. It prints instead.
- **Codes, passwords and the address**: refused everywhere they could be
  typed.
- **Syncing photos**: they stay on the phone that took them.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks and
  changes routed by one listener each (tested here and by
  `challenge/test/lab.js`).
- Writes come from this page: every non-GET `/api/*` outside the shared
  account refuses `Sec-Fetch-Site` other than same-origin/none (403), an
  `Origin` naming another host (403) and a body that is not JSON (415).
- No model call for a signed-out visitor, ever; every sync and metered
  parser runs after its gates.
- Everything typed, synced or written by a model is untrusted: refused at
  the door or cleaned in the core, bounded, and escaped on render.
- The service worker caches the app shell only - never api/, never a home.
- Only the app's own errors reach the page in its words; a provider error is
  a 502 (503 "The AI is busy"). Nothing logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
