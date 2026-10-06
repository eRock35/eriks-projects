# For Claude: Shelf Life

Eat what's about to go off first - and stop binning food. For households,
couples, roommates and anyone who opens the fridge to find the spinach has
turned again. Shelf Life keeps a list of what is in the fridge, freezer and
pantry with a typical use-by date for each, sorts it into **Past its date /
Today / Tomorrow / This week / Later**, ranks **forty-odd simple recipes** by
how much of what is going off they use, and keeps score on a **Saved** tab:
eaten vs binned, a rough estimate of money rescued, the streak of days with
nothing binned, and what keeps ending up in the bin ("You've binned spinach 3
times this month - buy the small bag, or freeze some for smoothies?").

Built 2026-10-06 as an **everyday** drop: Tieout (2026-10-05) was a business
one, so today was the other kind. A free pick from ordinary life (home,
money, food) - not from the inbox (it was empty), not a holiday. Not a
repeat: no lab or portfolio app touches food at home. **Staging only**: no
custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/shelflife`,
served at `challenge.strongtechnicalconsulting.com/shelflife/`, data in
`shelflife_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists

A household throws away a real share of the food it buys, and almost none of
it on purpose: the berries are behind the yoghurt, the half chicken is
forgotten, the second bag of spinach was bought because nobody remembered the
first. The fix is not willpower; it is knowing **what to eat first** and
having **an idea for it tonight**. Shelf Life is that one screen, plus a score
that makes not wasting food a little bit of a game.

**Who pays.** Almost nobody. The example kitchen, a kitchen on one phone,
adding food (150-food catalogue, weekly-shop grid, leftovers), the board,
every action, the recipes, the stats, the shopping nudge, putting a kitchen
online and joining one are free and make no model call. Only the host of an
online kitchen needs a **free** account (so it is theirs to run and delete);
everyone else joins with a code and **no account**. Two things are metered
(Haiku free, Sonnet for members via `identity.planFor`), about a cent each,
paid by whoever asks: **Snap it** (a photo of the fridge or a receipt) and
**Chef's idea** (a new recipe from what is going off).

## The decisions that matter

- **One rules file, run three times.** `public/shelf-core.js` is UMD
  (`window.ShelfCore` in the page, `require` in the server and tests): the
  catalogue, `cleanItem`, the date maths, bands and headline, every action,
  the recipes and their ranking, stats and streak, the shopping nudge. The
  server checks and stores; the page draws and runs the kitchen on this phone
  and the example with the very same functions; the tests check one file.
- **The catalogue** (`ROWS`, 150 foods): emoji, usual place, days sealed,
  days once opened (milk 5, salsa 7 and it moves to the fridge), freezer days
  by group (0 = does not freeze well: it still freezes, with a sentence
  saying so), thaw days, a typical price, and for the most-binned foods a
  buying tip. Shelf lives are **typical guidance for a home fridge**: raw
  chicken 2 days, leftovers 4, cooked rice 1, bread 5 in the pantry, eggs 28.
- **One door for every item.** `cleanItem` takes a typed item, a tapped tile,
  a model's reading of a photo and a phone's kitchen brought online alike:
  name (40 characters, a letter required, markup, control and bidi
  characters stripped), one emoji or the catalogue's, a place from the list,
  quantity 1-99, a real date within -400..+1100 days (or `daysLeft`), else
  the catalogue's shelf life for where it is. A name the catalogue knows
  ("zucchini", "half a roast chicken") is matched to it; `__proto__` is not.
- **Dates are 'YYYY-MM-DD' in the kitchen's IANA time zone** (`tz`, from the
  creator's phone). "Today" is always the kitchen's: the same instant is
  Today in Los Angeles and Past in Auckland, and the tests hold that. The
  page redraws when the day turns (a minute check while visible, and on
  coming back to the foreground); the server has no timer and needs none.
- **The actions** each return a patch of the keys they change
  (`{set: {'items.<id>': item, 'history.<id>': event}, del: [...]}`):
  - *Ate it / Binned it* - one unit (a pack of 3 yoghurts becomes 2), one
    history event with the days left, the price estimate and who.
  - *I opened it* - `min(current date, today + opened days)`, a jar moves
    pantry -> fridge; unknown foods keep their date and say so.
  - *Froze it* - into the freezer, good for the food's freezer time from
    today. *Thaw* - back to the fridge, use within its thaw days.
  - *+days* - from today when the date has passed, so +1 on "3 days past"
    means tomorrow. Edit (name, quantity, where, date) and *take it off*
    (added by mistake, no history).
  - *Cook this* - one of each ticked item eaten, under the dish's name.
  - *Undo* - the event goes and the item comes back (its own id, its own
    date).
  History is capped at 600 events and 120 days, pruned in the same patch.
- **Bands** never by colour alone: each has its word and an icon (⚠️ Past
  its date, ⏰ Today, 🌙 Tomorrow, 📅 This week, 🌿 Later), the item a day
  chip ("2 days", "1 day past"), and a past item says *Check it first -
  look, sniff. When in doubt, throw it out.* Later is folded away.
- **Tonight** (`rankRecipes`): each recipe slot is one food or a list any
  one of which will do; each slot takes the most urgent item that fits
  (two slots never take the same item). Score = urgency of what it uses
  (today 5, tomorrow 4, 2-3 days 3, this week 2, later 0.5, frozen 0.2, past
  2.5 - it gets checked first) + 0.3 x the nice-to-haves - 2.5 per missing
  slot. Shown: uses something, misses at most two, and - when anything is
  going off - uses something that is. "Uses 3 things going off: spinach,
  eggs and feta · 15 min", what you would need, chips coloured by band, the
  steps folded, and *Cook this* (main items ticked, extras not).
- **Saved and wasted** (`stats`, computed on read from the history): this
  week (today and the six days before) and four weeks (28 days); a
  **rescue** is something eaten on its date, the day before, or after, and
  its catalogue price is the "about $X rescued" - labelled a rough estimate
  from typical prices, never receipts. The **streak** is days in a row,
  today included, with nothing binned, counted from the kitchen's first day;
  best run kept. **Most binned**: twice or more in four weeks, with the tip.
- **Before you shop** (`shopping`): *Don't buy* is what is here and good for
  two days or more (leftovers left out); *Running out?* is what was eaten
  twice in four weeks and is gone (or only some going today). Shared through
  the phone's share sheet or copied. **Shelf Life never sends anything.**
- **First run** is three doors: *Look at an example kitchen*, *Start my
  kitchen* (straight to Add, with a welcome card and the weekly-shop grid),
  *Join a household kitchen*.

### Two phones, one kitchen (trip-planner's packing lesson)

An online kitchen is one document (`kitchens/<id>`) whose `items` and
`history` are **maps keyed by id**. Every busy write - add, ate, binned,
opened, froze, thawed, +days, edit, cook, undo - goes through
`store.transactKeys`: read the kitchen inside a transaction, let the core
decide, then write **only the keys it changed** (plus `v` and `updatedAt`)
with Firestore's `update()` - never the whole document. Two phones adding,
eating or editing at once cannot write back a copy missing the other's
change, and two phones tapping *Ate it* on the last yoghurt give one 200 and
one 404 ("That's not in the kitchen any more"). `test/run.js` adds 18 things
from six phones at once, eats or bins all 18 at once, races the last
yoghurt, freezes one thing while another phone renames another, and shows
two adds as a plain read-change-write losing one. Name and member changes are
whole-document transactions (rare, still safe). Phones poll `?since=v` every
5 s while visible (one read when nothing moved).

### Where a kitchen lives

- **The example** ("Sam & Priya's kitchen", `public/sample.js`): 27 things
  dated relative to today in the viewer's zone - coriander a day past;
  spinach, half a roast chicken and strawberries today; milk and mushrooms
  tomorrow; eight this week; thirteen later across freezer and pantry - and
  four weeks of history (spinach binned three times, nothing binned for six
  days). Every item goes through `cleanItem`; the stats, streak, recipes and
  shopping nudge are the app's own sums. Ate it / Binned it / Freeze / +1
  and Cook this work and are never saved; editing or adding offers "Make it
  yours". Chef's idea works on it for a signed-in visitor.
- **On this phone** (`localStorage` `shelflife-kitchen-v1`, every access
  wrapped, read back through `cleanKitchen`): no account, no server.
- **Online** (`k/<id>`): from Kitchen, **Share with my household -> Put it
  online** (sign in free, then a name and an emoji) sends the kitchen, its
  items and history (`cleanKitchen`: 400 items, 600 events in 120 days) to
  `POST /api/kitchens`, clears the phone's copy and lands on the invite card -
  code, QR (full screen on tap), Share link. A friend opening `j/<code>` sees
  the kitchen's name and size (not what is in it, not who) and joins with a
  name and an emoji.

## Who may do what (online)

- **Members** are this browser (an HttpOnly cookie `shelf_k`, path-scoped,
  22 random characters, stored only as `sha256(key + kitchenId)`) or a
  signed-in account that holds the seat (`acct`, an HMAC of the account id
  under a key derived from `IDENTITY_SESSION_SECRET`, "shelflife account
  v1"). The kitchen holds no account id and no email.
- Anyone in the kitchen does everything to the food. Your own name and emoji
  are yours (the host may change anyone's). The host renames, rotates the
  code (old link and QR die), removes people and deletes the kitchen. A
  member can leave; the host can't (delete instead).
- **A stranger gets the same 404 a missing kitchen gets** on every route,
  signed in or not.
- **Limits** (`lib/kitchens.js` LIMITS and `Core.LIMITS`; per instance, in
  memory, like Chorus): 400 items, 60 added at once, 12 people, 5 kitchens a
  host; 30 new members per address an hour; 30 **distinct** wrong codes or ids
  per address in 15 minutes, then even the right code waits; 600 writes per
  address in 10 minutes. IPv6 counts by its /64. A kitchen nobody has touched
  in 180 days is deleted by the read that finds it (no timer).

## The model (two calls, metered)

Both: `requireUser, requireBudget, requireDailyCap` **then** the route's own
parser (a stranger's body is never read; 401/402/403, never 413), then the
input checks before anything is spent, then one forced tool, then everything
cleaned. Signed out, the buttons explain and offer a free account; 402 opens
the credit sheet; 403 `verify-email` shows its sentence and "Send the link
again".

- **Snap it** - `POST /api/snap {photo, tz}`, 6 MB parser, the photo checked
  by its magic bytes (JPEG/PNG/WebP, 4 MB) -> `record_items` `{relevant,
  items: [{name, emoji, place, qty, daysLeft, catalogueId?}]}`. The system
  prompt carries the catalogue's ids. `ai.cleanItems` puts each through
  `cleanItem`, folds repeats (adding quantities), keeps 40. Shown ticked;
  nothing is added until *Add the ticked items*. The photo is shrunk to
  ~1600px on the phone, read once, never stored or logged (tested).
- **Chef's idea** - `POST /api/idea {items: [{id, name, daysLeft, place}],
  avoid}`, 64 KB parser. The page sends what is in the kitchen (a kitchen on
  a phone has nothing on the server to read): ids, names, days left, place -
  nothing else, 80 at most, most urgent first. -> `propose_recipe` `{title,
  emoji, minutes, uses: [item ids], extra, steps}`. `ai.cleanRecipe` keeps
  only ids it was given (deduped), bounds the title, steps (2-8) and extras
  (8), and refuses a recipe that uses nothing real (422). Offered as a card
  with *Cook this*.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8120/shelflife/
npm test        # pure rules first, then end to end over HTTP under a /shelflife mount
```

`SHELFLIFE_MEMORY=1` and `SHELFLIFE_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `SHELFLIFE_COLLECTION_PREFIX` (set to
`shelflife_` by the lab host) prefixes every top-level collection. `npm test`
runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call
that does not force a tool. Triggers in the photo's bytes or an item's name:
`BLANK`, `RECEIPT` (photo), `INJECT`, `MAXTOKENS`, `UPSTREAMnnn`; anything
else is an open fridge (eight things) or a recipe using the three most urgent
ids.

`public/qr.js` is Chorus's vendored copy of Kazuhiko Arase's MIT "QRCode for
JavaScript", only its global renamed to `ShelfQR`. The shared files
(`lib/identity.js`, `identity-store.js`, `byok.js`, `stripe.js`,
`webauthn.js`; `public/desktop.css`, `passkey-client.js`, `verify-banner.js`)
are synced copies - edit them in `eriks-projects/shared/`.

## Data (Firestore: `shelflife_*` in the lab database `challenge`)

- `kitchens/<id>` (16 random base64url characters) - `{name, code, tz,
  created, ownerTag, acctTags, createdAt, updatedAt, v, members: [{id, name,
  emoji, host, keyHash, acct, joinedAt}], items: {<id>: {id, name, emoji,
  place, qty, cat, added, use, opened, frozen, leftover}}, history: {<id>:
  {id, iid, name, emoji, cat, place, outcome, date, left, price, by, at,
  dish?, snap}}}`.

That is the only collection: no email, no account id, no browser key, no
photo (tested). Queries are single-field equality (`code ==`, `ownerTag ==`,
`acctTags array-contains`), so **no composite index**. Kitchens this phone
joined are remembered in `localStorage` `shelflife-kitchens-v1`; the last one
opened in `shelflife-last-v1`, so the home-screen icon opens it.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `k/:id`,
`j/:code`. Joining (no account): `GET|POST /api/join/:code` (`{name,
emoji}`). Members: `GET /api/kitchens/:kid[?since=v]`, `PATCH|DELETE
/api/kitchens/:kid/members/:mid`, `POST /api/kitchens/:kid/items` (`{items:
[...]}` or one), `PATCH /api/kitchens/:kid/items/:iid` (`{action: open|freeze|
thaw|extend, days}` or an edit), `DELETE /api/kitchens/:kid/items/:iid`,
`POST /api/kitchens/:kid/items/:iid/done` (`{outcome: ate|binned}`), `POST
/api/kitchens/:kid/cook` (`{ids, title}`), `POST /api/kitchens/:kid/undo/:eid`.
Signed in (free): `GET|POST /api/kitchens`, `PATCH|DELETE /api/kitchens/:kid`,
`POST /api/kitchens/:kid/code`. Metered: `POST /api/snap`, `POST /api/idea`.

## What is deliberately not built

- **Reminders and push.** There is no sender on this platform, and a fridge
  app that pings is one people mute. The board is for when you are deciding
  what to eat; the shopping list goes out through the person's own share
  sheet.
- **Barcode scanning and real use-by dates from packs.** A barcode does not
  carry the date, and a database of products is a different, much bigger
  app. The printed date wins; the edit sheet takes it in one tap.
- **Safety claims.** The dates are typical guidance, said on every screen
  that shows them ("use your eyes and nose; when in doubt, throw it out").
  Nothing here says food is safe.
- **Nutrition, meal plans, calorie counts.** Different products.
- **"Keep my seat" for members** (Flight has it). A browser that joined is
  that browser; a signed-in joiner is recognised by account anywhere.
- **The obvious iPhone shape**: a widget with today's three things, VisionKit
  for receipts, a share extension from the supermarket's app.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`,
  handlers by one `data-act` listener (tested here and by
  `challenge/test/lab.js`).
- No model call for a signed-out visitor or a member without an account; the
  metered routes' gates run before their parsers, and going online's 512 KB
  parser runs after its sign-in.
- Model output and every typed string are untrusted: cleaned, bounded,
  stripped of markup, control and bidi characters, and escaped on render.
- `k/*`, `j/*`, `/api/kitchens/*` and `/api/join/*` answer with `no-referrer`
  and `noindex`; a code and a kitchen id are keys.
- Failures (`fail()`/`failure()`, Receipt's): only the app's own errors reach
  the page in their words; a provider error is a 502 (503 "The AI is busy").
  Nothing logged carries a name, a food or a photo.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
