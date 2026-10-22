# For Claude: Kindly

Never miss the people who matter - and always know what to give. The people
in someone's life and their dates - birthdays (year optional), anniversaries,
any custom day ("Gotcha day") - with **Coming up** (the next 60 days, a
countdown, the milestones, a nudge at each person's lead time and "order by
Oct 26 to arrive"), **gift ideas kept all year** (idea -> bought -> given,
"given before", a warning before a repeat), **a budget per occasion** and what
has been spent, **notes that help** (sizes, likes, dislikes, allergies, "has
everything"), **every date in your own calendar** (.ics), and a **wishlist
link** the person fills in themselves. Optional AI suggests **five gift ideas**
from the notes, never told the name.

Built 2026-10-22 as an **everyday** drop: Rota (2026-10-21) was a business
one, so today was the other kind. **Staging only**: no custom domain until
Erik decides it is worth one. The Christmas holiday drop (2026-12-25: "gift
budget + list sharing") may build on it rather than repeat it.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/kindly`,
served at `challenge.strongtechnicalconsulting.com/kindly/`, data in
`kindly_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (everyday life)

Birthdays and anniversaries slip; the gift idea someone mentioned in July is
gone by December; the same scarf gets given twice. Phone contacts hold a
birthday and nothing else, and a notes app does not count down or remember
what was given in which year.

**Who it's for:** anyone with friends and family.

**Not a repeat:** Duly is bills, Boomerang is lent things, Jars is pocket
money. Nothing in the lab or the portfolio keeps people's dates and gift
ideas.

**Who pays.** Almost nobody. People, dates, Coming up, ideas, history,
budgets, notes, the sample, the calendar export and wishlist links are free,
need no account and make no model call. A **free** account adds sync. The one
metered thing is **"Gift ideas for them"** (Haiku for the free tier, Sonnet for
members via `identity.planFor`), about a cent.

**How it becomes an iPhone app.** Local notifications at each lead time (no
sender needed), EventKit instead of the .ics, a widget with "Maya - 4 days -
gift ready", Contacts' birthdays as an import (read on the device, never
uploaded), and the share sheet for the wishlist link.

## The decisions that matter

- **One rules file, run three times.** `public/kindly-core.js` is UMD
  (`window.KindlyCore` in the page, `require` in the server and tests):
  cleaning, a person (`cleanPerson`), dates and their next occurrence, ages
  and milestones, Coming up, the no-repeat rule, budgets, the AI brief, the
  .ics, the sample. **No clock and no dice**: everything that needs "today" is
  handed it as `YYYY-MM-DD` in the viewer's own day (tested: no `Date.now`,
  `new Date()` or `Math.random` in the file).
- **Dates are civil days, sums on UTC midnights**, so a clock change never
  moves a birthday or miscounts the days to it. The suite runs the same sums
  in six time zones and gets byte-identical Coming up and .ics.
- **A date** is `{month, day, year|null}`; a year that would put the date in
  the future, or a Feb 29 in a year without one, is dropped. **Feb 29** carries
  `leap: 'feb28' | 'mar1'` - the person's choice of day in other years
  (`dayIn`). The next occurrence counts today, and rolls over the year end.
- **Ages and milestones** (`milestone`): birthdays 1, 16, 18, 21, 30, 40 ... 100
  (and every fifth after); anniversaries by their names (5th wood, 25th silver,
  40th ruby, 50th golden ...); a custom date at 1 and every fifth year. A date
  without a year has no age and no milestone.
- **Lead time** per person (0-60 days, 10 by default): inside it the row says
  "Time to choose" (ideas saved) or "Time to think of something"; before it,
  "Nudge from Oct 28". **Order by** is the date minus the shipping days (5 by
  default, a setting); past it, "too late to ship - shop local or give an
  experience". A gift already bought for that occasion says "Gift ready" and
  no shipping hint.
- **Ideas** are `{text, link (https only), price, status idea|bought|given,
  occasion, year, from me|them|ai}` on the person. **Bought** and **Given** ask
  which occasion and year (and the price, which counts toward the budget).
  **Given before** is the given ones, newest first. **The no-repeat rule**
  (`similar`, `repeatOf`): folded words without filler, rough singulars; a
  match if one set holds the other (two words or more when the longer has
  over three) or a Jaccard of 0.5. It warns - on typing an idea, on a saved
  idea, and on each AI suggestion - and never blocks.
- **Budgets** are per date (`budgets: {birthday: 6000}`), spent is what was
  bought or given for that date in that occurrence's year.
- **The calendar file** (`buildIcs`): RFC 5545, CRLF, folded at 75 octets,
  text escaped, all-day events, one yearly event per date
  (`FREQ=YEARLY;BYMONTH;BYMONTHDAY`; Feb 29 kept on Feb 28 is
  `BYMONTHDAY=28,29;BYSETPOS=-1`, kept on Mar 1 is `BYYEARDAY=60`, which is Feb
  29 in a leap year and Mar 1 otherwise), a VALARM at the person's lead time
  (9 am) and one on the day. **No gift ideas go in it**: calendars get shared,
  and a surprise would not survive. Nothing in the cloud writes any calendar.
- **The first run** is the hero, two doors (**Try a sample circle**, Add my
  first person), the privacy promise in a box of its own, a small mock of
  Coming up with a "Turns 40" flag, and "How it works". The sample
  (`sample(today, nowMs)`) is eight made-up people dated from today: a
  birthday in 4 days with a gift ready and a budget part spent, a 40th about
  a month out, a 5th (wood) anniversary, a dog's gotcha day, a grandmother
  born on Feb 29 who celebrates on Mar 1, a nephew with an allergy, a
  colleague, and a friend whose idea was heard "at the July barbecue". Tested
  on six dates including leap day and New Year's Eve. A strip says it is made
  up, with **Start my own** and **Clear the sample**; adding a real person
  clears it.

## Wishlist links (`lib/wishlists.js`, Boomerang's pattern)

Made by a browser with **no account**, opened by the person with **no
account**. `POST /api/w {first}` makes one; `w/<token>` is the page.

- **What it reveals:** the first name (one word, cleaned again on the server
  with `firstName`), when it closes, and how many more ideas fit. Nothing else
  - not the owner, not the dates, **not the owner's list** (so surprises stay
  surprises). Tested by the exact key list. The page HTML carries nothing of
  it.
- **Additions** `{text, link (https only), price}` wait on the document until
  the owner's phone **collects** them (`POST /api/w/:token/collect`, owner key
  only), which removes them from the server. The owner's phone collects when
  it opens, when it comes back to the foreground, and on "Check for new
  ideas"; they arrive as ideas marked "From them".
- **Tokens** are 16 random bytes (22 characters); the document id is
  `sha256(token)`, so the token is never stored. The **owner key** (a second
  secret, kept with the person on the phone and in the synced circle) rides
  in `X-Kindly-Key`, never a URL, and is stored only as `sha256(key + id)`.
  `no-referrer` and `noindex` on every wishlist path.
- **Limits** (per instance, in memory - they slow a script, they do not stop
  a determined one): 20 new links per address an hour (IPv6 by its /64) and
  2,000 across the instance; **50 live links per account or device** (an HMAC
  tag of the account, else a hash of an HttpOnly `kindly_k` device cookie);
  **30 ideas waiting per link** (checked inside the transaction, so a burst
  cannot pass it); 40 additions per address an hour; 300 writes per address
  in 10 minutes; 30 **distinct** wrong tokens per address in 15 minutes.
- **Expiry:** 60 days from creation, checked on every read and deleted by the
  read that finds it (no timer - billed per request). Closing it (owner key) or
  deleting the person deletes it. Closed, expired, unknown and malformed all
  answer the same 404, word for word.

## "Gift ideas for them" (the one model call)

`POST /api/ideas`: `requireUser, requireBudget, requireDailyCap` **then** the
route's own 8 KB parser (a stranger's body is never read; tested
401/402/403/503, never 413), then `ai.brief`, then one forced tool
`suggest_gifts` -> exactly five `{title, why, priceRange, searchQuery}`, max
900 tokens.

- **What the model is told** is only what `ai.brief` reads: the relationship,
  an age (or years together), the occasion (a custom one by its label), a
  budget, and likes, dislikes, sizes, allergies and other notes, plus "has
  everything". **Never the name**: the page builds the brief with
  `aiBrief`, which takes the person's name out of every note
  (`redactName` -> "them"), and the server never reads a `name` (or any other
  unknown) key. Tested twice: on the brief, and on what the fake model was
  actually sent over HTTP with a `name` and an email in the body. The sheet
  shows the exact line that will be sent, ending "Never their name."
- **No links from the model.** The tool has no field for one; anything
  URL-shaped (`http`, `www.`, `javascript:`, a bare domain) is taken out of
  every field (`cleanSuggestions`); a price range must look like one. The page
  builds a plain DuckDuckGo search from `searchQuery`.
- Proposed, saved only on tap (`from: 'ai'`); each suggestion is checked
  against "given before". Nothing is stored or logged. Signed out, the sheet
  explains it needs a free account and everything else stays free; 402 opens
  the credit sheet; 403 `verify-email` shows its sentence.

## Sync (signed in, free)

`circles/<account tag>` = `{people: {<id>: person}, createdAt, updatedAt}`,
the tag an HMAC of the account id under a key derived from
`IDENTITY_SESSION_SECRET` ("kindly circle owner v1") - never the id or the
email. With no secret, sync answers 503 and the circle stays on the phone.
Every write is a transaction; `PUT /api/people/:id` (64 KB, after sign-in),
`DELETE /api/people/:id`, `POST /api/people/merge` (512 KB, after sign-in;
added if the account lacks it, replaced only by a newer `updatedAt`),
`DELETE /api/people` forgets the account's copy. Only `SAVED_FIELDS` are
kept, never the sample. Read by key; the only query is the wishlist cap's one
equality filter (`creator ==`), which needs no composite index.

## On the phone

`localStorage`: `kindly-people-v1`, `kindly-settings-v1` (shipping days),
`kindly-tab-v1`. Every access wrapped. A service worker (`sw.js`, network
first) keeps the app's own files, never `api/`. Views: Coming up (This week /
This month / Further out, and an aside with the 60-day totals, the calendar
and the wishlist explainer), People (cards, a search over six), Gift ideas
(wrapped and waiting, then each person's open ideas in date order). A person
opens as a sheet: dates with budgets, a quick-add box, ideas, notes, given
before, the wishlist link. Bottom tab bar on a phone, a left rail on a desktop
(`desktop.css`). Confetti on "Given", none under reduced motion.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `w/:token`.
No account: `POST /api/w`, `GET /api/w/:token`, `POST /api/w/:token/add`,
`POST /api/w/:token/collect` and `DELETE /api/w/:token` (owner key). Signed
in, free: `GET|DELETE /api/people`, `PUT|DELETE /api/people/:id`,
`POST /api/people/merge`. Metered: `POST /api/ideas`.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8133/kindly/
npm test        # pure rules first, then end to end over HTTP under a /kindly mount
```

`KINDLY_MEMORY=1` and `KINDLY_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `KINDLY_COLLECTION_PREFIX` (set to
`kindly_` by the lab host) prefixes every top-level collection. `npm test`
runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0` (run the dev server with it too to
try the AI sheet on a fresh account). The fake model refuses a call that does
not force a tool, keeps what it was sent (`fakeClient.seen`, exported by the
server for the tests), and reads triggers in the likes: `BLANK`, `INJECT`,
`MAXTOKENS`, `UPSTREAMnnn`.

`test/run.js` (22 tests): cleaning and links; the next occurrence across year
ends; Feb 29 both ways (2027, 2028, 2100, 2000); ages and milestones; lead
times, order-by and stages; six time zones and a DST change; given before and
the no-repeat rule; budgets and money; .ics validity (CRLF, folding, rules,
both Feb 29 rules checked against `dayIn`, alarms, escaping, no ideas, unique
UIDs); the sample on six dates; the AI brief without the name; contrast in
both themes; the local-only switches; the prefix and the one query; the page
(no inline script or handlers, relative URLs, wrapped storage, no email, no
clock in the core, every typed string escaped); and over HTTP: signed out with
zero model calls, the gate order, sync across two phones, wishlist links (what
the friend sees, collecting, the cap under a burst, closing, expiry, one 404
for everything, only the owner collects or closes), their limits, gift ideas
(bad requests before spend, the name never sent, hostile output, errors not
passed on, nothing stored), and the 401/402/403/503 gates. The shared files
(`lib/identity.js`, `identity-store.js`, `byok.js`, `stripe.js`,
`webauthn.js`; `public/desktop.css`, `passkey-client.js`, `verify-banner.js`)
are synced copies - edit them in `eriks-projects/shared/`.

## What is deliberately not built

- **Reminders from a server.** There is no sender; the phone's calendar does
  it from the .ics, and an iPhone app would use local notifications.
- **Reading contacts.** A browser cannot, and uploading an address book is the
  opposite of the promise. An iPhone app could read birthdays on the device.
- **Buying anything, or affiliate links.** The model gives no links; the page
  gives a plain search.
- **A shared family list.** The Christmas drop may want one (secret-Santa,
  "who is getting what"); it would need the circle as a shared document, not
  a per-account one.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`, handlers by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the metered route's gates run
  before its parser, and the sync parsers run after sign-in.
- Every typed string, every friend's addition and every model field is
  untrusted: cleaned in the core (or `lib/wishlists.js`) and escaped on
  render. Checked in Chromium with a hostile name, idea, note and wishlist
  addition through every view, sheet and the friend's page, with no CSP
  violation and no injected element.
- Failures (`fail()`/`failure()`, Receipt's): only the app's own errors reach
  the page in their words; a provider error is a 502 (503 "The AI is busy").
  Nothing logged carries a name, a note, an idea or a brief.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
