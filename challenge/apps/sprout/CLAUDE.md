# For Claude: Sprout

Know which plants need you today - and hand them to a plant-sitter in one
link. For anyone with houseplants, from one pothos to a jungle, who waters on
vibes, drowns some and forgets others, and panics before a trip. Sprout keeps
a list of your plants on your phone, sorts them every morning into **Thirsty
today / Check soil / Coming up / Happy**, learns each plant's real pace from
"Not yet" (the soil was still damp), stretches the gaps in winter for your
hemisphere, warns when a plant sits in the wrong light ("A calathea in direct
sun will crisp - try a few metres back"), keeps a streak of on-time care, a
history and a photo diary - and when you go away, builds your sitter a
day-by-day care sheet that travels **inside the link itself**.

Built 2026-10-10 as an **everyday** drop: Parity (2026-10-09) was a business
one, so today was the other kind. A free pick from ordinary life (home,
hobbies) - not from the inbox, not a holiday. Not a repeat: Shelf Life tracks
food in the kitchen; nothing in the lab or the portfolio cares for plants.
**Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/sprout`,
served at `challenge.strongtechnicalconsulting.com/sprout/` once it has a
`lab.js` entry, deployed with `gcpdeploy ship challenge`. See
`challenge/CLAUDE.md` for mounting, prefixes and graduation. Every browser
URL is relative to `BASE`; keep it that way. **It stores nothing in the lab
database** (see Data).

## Why it exists

Most houseplants that die are drowned, not forgotten - and the forgotten
ones are the rest. Watering "every Sunday" ignores that a snake plant in a
dim hall drinks half as often as a fern in a bright bathroom, and that both
drink less in December. The fix is **checking the soil first** and **knowing
which plant to check today**. Sprout is that one screen, a little learning
behind it, and the thing people actually panic about: who waters them when
we're away, and how do they know which ones?

**Who pays.** Almost nobody. The example jungle, adding plants (89 in the
catalogue), the board, every action, the learning, seasons, streaks, the
diary, the sitter link, the calendar file and export/import are free, need
no account, and make no request. The one metered thing is **"What plant is
this? / What's wrong with it?"** (Haiku for the free tier, Sonnet for
members via `identity.planFor`), about a cent.

## The decisions that matter

- **One rules file, run three times.** `public/sprout-core.js` is UMD
  (`window.SproutCore` in the page and the sitter's page, `require` in the
  server and tests): the catalogue, `cleanPlant`, dates, seasons, the
  schedule, bands and headline, every action and undo, streaks, light
  warnings, the sitter plan and link codec, the calendar, export/import and
  the AI answer's cleaner. The tests check one file.
- **The catalogue** (`ROWS`, 89 plants and kitchen herbs): emoji, group,
  light (min / ideal / max on low, medium, bright-no-sun, direct sun), a base
  watering interval, the **soil rule** to check first (keep lightly moist /
  top 2-3 cm dry / mostly dry / fully dry / no soil - air plants, a
  staghorn mount, lucky bamboo in water), humidity, **pet safety** (`safe` /
  `toxic` from the ASPCA's well-known lists; `check` where the listing is
  unclear or the plant is not on it - 12 of them), a care tip and the classic
  mistake. Every screen that shows it says **guidance, not gospel**.
- **One door for every plant.** `cleanPlant` takes a typed plant, an
  imported file, the example and one the AI recognised alike: catalogue id
  only if real (`__proto__` is not), a custom plant needs a name (40
  characters, markup, control and bidi characters stripped), nickname 30,
  room / light / pot from their lists, events of known kinds on real dates
  no later than tomorrow, history capped at 150 events.
- **Dates are 'YYYY-MM-DD' in the phone's time zone.** "Today" is the
  phone's; the page redraws when the date turns (a minute check while
  visible, and on coming back to the foreground). Intervals are counted in
  calendar days, so DST never moves a due date (tested on both changes).
- **The schedule** (`dueOf`): last drink + the **effective** interval, which
  is the plant's learned interval x the season at the time of that drink. A
  `hold` (after "Not yet" or a snooze) pushes the next look later, never
  earlier. No history ("Not sure" when added) means "feel the soil today".
- **Bands** (`bandOf`), never by colour alone - each has words and an icon:
  due today or late -> **Thirsty today** (a snooze comes back as thirsty);
  due tomorrow, or due after a "Not yet" or with no history -> **Check soil**
  (the card shows that plant's soil rule); 2-3 days -> **Coming up**; later,
  or watered today -> **Happy** (folded). The headline: "3 plants want water
  today - Bert the monstera first." (most overdue first, then the thirstiest
  kind).
- **Learning, bounded.** "Not yet" adds a step (an eighth of the catalogue's
  interval, at least half a day) and looks again in a fifth of an interval;
  "It was fine" (offered on the toast after any late drink) adds half a
  step. The learned interval stays within **0.6x-1.8x the
  catalogue's** (and 1-90 days): it can learn that your bathroom fern drinks
  more, never "water the cactus daily". On-time drinks and snoozes teach
  nothing. "Bert drinks every 9 days here, not 7" once it has learned.
- **Seasons** (`seasonFactor`): summer 1; deep winter (Dec-Feb northern
  months) the group's factor - 1.4 most plants, 1.25 ferns, 1.8 succulents,
  2.0 cacti - stepping through autumn and spring. The hemisphere is guessed
  from the phone's IANA zone (`hemisphereOf`: Australia, New Zealand, South
  America's southern zones, southern Africa, Indonesia...), with a toggle in
  More: Automatic / Northern / Southern / **No seasons** (tropics).
- **Actions** (`act`) return a new plant and an event that records what it
  changed (`prev`): water, not yet, it was fine, mist, fertilise, snooze a
  day, repot (pot size), move (room and light), note. **Undo** (`undo`) takes
  the latest event away and puts `prev` back - only the latest, so an older
  undo can never overwrite what happened since. Every action's toast has
  Undo; a late drink's also has "It was fine".
- **Flags** on a card: watered twice inside 40% of an interval ("let it dry
  out"), repotted in the last fortnight (water lightly, no feed for a
  month), **feed due** (growing season, the group is fed at all, not after a
  repot), and the light warning.
- **Streaks** (`streakOf`): drinks given no more than a day after they were
  due, counted back from the latest; "Not yet" never breaks one (checking IS
  care); a rough "a few days ago" from the add form earns nothing. At risk
  when the plant is more than a day late now.
- **Personality, not twee:** each plant "says" one line on its page and in
  the headline card ("Bert says: Is it drink o'clock? It's drink o'clock."),
  picked by plant and day so it changes daily but not on every redraw;
  nicknames suggested per plant (Sir Hiss, Figgy, Cookie Monstera) with a
  dice for another.
- **First run** is three doors: *See an example jungle*, *Add my plants*
  (straight to the catalogue), *What plant is this?*.

### The example jungle (`public/demo.js`)

Fourteen plants across the living room, bedroom, kitchen and bathroom of an
invented flat ("Sam"), with watering histories **worked out from today in
the viewer's zone and hemisphere by the app's own rules**: each last drink is
placed so the schedule lands where the story wants it - Bert the monstera
three days late, Figgy, Lily and Basil Fawlty thirsty today, Spidey and
Fernando to feel tomorrow, Calvin waiting on yesterday's "Not yet", Minty and
Orla coming up, and five happy - Zed the ZZ watered twice in four days,
Polly repotted two days ago, Pearl in light she doesn't like, Sir Hiss who
has learned he drinks every 17 days not 14. Where a season boundary leaves no
exact day (an interval jumping 3 -> 4), a hold carries it. The test holds
every band on **every second day of a year in both hemispheres**. Taps work
and are never saved; adding a plant starts your own jungle.

### The plant-sitter link

- **Away** tab: leaving and back dates (42 days at most), your name, a note
  (280 characters). `sitPlan` projects every plant's drinks from today to the
  end of the trip as if each were given on its day: the ones before you leave
  are yours ("Before you go: Bert today"), the rest the sitter's, and plants
  with none are **Leave alone**. 60 plants at most a link.
- **The fragment.** The plan (`{v, s, e, f, t, p: [[nick, catalogue id, room,
  pot, drain, day offsets, mist, note]]}`) is JSON, deflated with
  `CompressionStream('deflate')` and base64url'd: `sit#v1.z.<...>`; a browser
  without it writes `v1.p.<plain base64url>`. **Browsers never send a
  fragment to a server** - the page says so plainly - so the plan never
  touches one: the test records every request the server receives while a
  link is fetched and finds only `/sprout/sit`. The biggest possible plan
  (60 long-named plants, 42 days, a full note) is under 16,000 characters.
- **Decoded defensively** (`decodeSit`, never throws): a version and charset
  check, 16,000 characters at most, inflate capped at 96 KB (a deflate bomb
  is refused), strict UTF-8 and JSON, then `cleanSit` - the same rules as
  the owner's phone: dates real and in order, 42 days, 60 plants, names
  cleaned, catalogue ids only if real, rooms and pots from their lists, day
  offsets integers in range. The sitter's page (`sit.html`, `sit.js`) makes
  **no request at all** and escapes everything; amounts, soil rules and tips
  come from its own copy of the catalogue, not the link.
- **The sitter's view:** today's list with amounts and ticks (kept in their
  own browser, keyed by a hash of the link), how to water, day by day, each
  plant's card, leave-alone, a **"done" update** through their own share
  sheet (`sitSummary`, or copied) and a **printable** version (print CSS).
  A cut-short link says so kindly instead of breaking.

### The calendar, and moving phones

- **No reminders** (there is no sender on the platform). Instead **Add
  watering days to my calendar**: `icsFor` writes an .ics of the next four
  weeks on the phone, one all-day event per watering day ("💧 Water Bert,
  Lily and Figgy", each plant's soil rule in the description), RFC 5545
  folded at 75 octets on whole characters, escaped, CRLF. A snapshot, said so.
- **Export / import** a JSON file (`exportHome`, `importHome`): every plant
  through `cleanPlant`, 200 at most, duplicate ids made unique, 2 MB cap.
  Diary photos stay behind (said so).
- The home-screen icon opens `./#today`. A service worker (`sw.js`, Parity's
  pattern) keeps the app and the sitter's page working with no signal once
  opened: network first, own scope only, never `api/`, only `sprout-*` caches.

## The one model call (metered)

**What plant is this? / What's wrong with it?** - `POST /api/look {photo,
hint?}`: `requireUser, requireBudget, requireDailyCap` **then** a 6 MB parser
(401/402/403, never 413 - tested), then the photo checked by its magic bytes
(JPEG/PNG/WebP, 4 MB decoded) before anything is spent, then one forced tool
`record_plant` `{relevant, identification: {catalogueId?, name, confidence},
health: {issues: [{issue, likely_cause, fix}], urgency}, note}`, then
`SproutCore.cleanLook`: a catalogue id only if real, confidence and urgency
from their lists, five issues, bounded strings, markup stripped, and **every
sentence that claims anything about pets or toxicity dropped** - pet safety
always comes from the catalogue (the card says "From Sprout's list, not the
AI"). The prompt tells the model not to claim certainty it does not have,
to say "likely", and not to talk about toxicity. `hint` (a catalogue id, or
nothing) tells it what the owner thinks it is. Not a plant: 422. The photo
is shrunk on the phone to 1600px JPEG, read once, never stored or logged.
The answer is a card with **Save to Bert's diary** (the photo and a summary,
on the phone) or **Add as a new plant**. Signed out, the sheet explains and
offers a free account; 402 opens the credit sheet; 403 `verify-email` shows
its sentence and a resend.

## Local run and tests

```
npm run dev     # memory identity + fake model, at http://localhost:8127/sprout/
npm test        # pure rules, the pages, then end to end over HTTP under /sprout
```

`SPROUT_MEMORY=1` (the shared account in memory - Sprout has no store of its
own) and `SPROUT_FAKE_AI=1` both **throw on Cloud Run** (`K_SERVICE`) - in
`lib/store.js`, `lib/fakeai.js` and `server.js`; the tests spawn each with
`K_SERVICE` to prove it. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`.
The fake model refuses a call that does not force a tool, logs each request
with the photo replaced by its length, and reads triggers from the photo's
bytes: `BLANK` (not a plant), `SICK` (a peace lily with three problems),
`INJECT` (markup, bidi, a made-up id, pet claims, 40 issues), `MAXTOKENS`,
`UPSTREAMnnn`; anything else is a healthy monstera. Screenshots at 390px and
1280px, light and dark, were taken with playwright-core against `npm run dev`.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`.

## Data

**None in the lab database.** No plant, photo, plan or answer is stored
(tested: the identity store holds only `users`, `usage`, `events`,
`control`). `lib/store.js` reads `SPROUT_COLLECTION_PREFIX` so that anything
Sprout ever stores is prefixed from its first write. **On the phone:**
`localStorage` `sprout-home-v1` (settings and plants; every access in
try/catch, read back through `cleanPlant`; a browser that refuses storage is
told once, and the jungle lasts the tab), IndexedDB `sprout-diary` (photos
shrunk to 1200px, deleted with their plant or by "Delete all"), and on a sitter's
phone `sprout-sit-<hash>` (their ticks).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, `/sw.js`, `/sit` (the
sitter's page), the page. Metered: `POST /api/look`. The shared account at
`/api/auth`. There is deliberately no route for plants.

## Ideas not built yet

- **Reminders** - a push sender would need infrastructure; the .ics covers it.
- **Two people, one jungle** (a couple sharing the watering) - Shelf Life's
  online-kitchen pattern would fit; today a jungle is one phone's.
- **Sitter ticks back to the owner live** - needs a server; the "done"
  message through the share sheet is the no-server version.
- **Light from the phone's camera** (a lux reading) and **pot moisture from
  weight** ("lift it") as a logged measurement.
- **The iPhone shape:** a widget with today's thirsty three, Live Activity
  for a trip, the sitter link as an App Clip.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=` in
  either page; handlers by `data-act` from one listener (tested here and by
  `challenge/test/lab.js` once mounted).
- No model call for a signed-out visitor, ever; the metered route's gates run
  before its parser.
- Nicknames, notes, imported files, sitter links and model output are
  untrusted: cleaned, bounded, stripped of markup, control and bidi
  characters, and escaped on render. The sitter link is attacker-writable
  and is decoded with caps and no `eval`, never drawn as HTML.
- `/sit` answers `Referrer-Policy: no-referrer` and `noindex`.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body or a photo.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
