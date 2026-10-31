# For Claude: Haul

Tip out the bag. Count it, trade it fair - and make it last. For families on
Halloween night and the days after: kids (and grown-ups) tipping their
trick-or-treat bags onto the floor.

- **First run** (real effort went here): a CSS-only night scene - a bobbing
  jack-o'-lantern, a flapping bat, a moon, twinkling stars, hopping candy (all
  still under `prefers-reduced-motion`) - with **Count my haul** and **Try
  it** (a made-up haul for "Leo" and "Maya", fully playable, never saved, with
  a ribbon that says so and "Count my own haul"), then how it works in three
  steps, four feature cards and the Teal Pumpkin line.
- **Trick-or-treaters**: a first name or nickname (optional) and a costume
  avatar (16: vampire, wizard, ghost, bat, zombie, superhero...). Up to six on
  one device. A child with no name goes by the costume ("Ghost", "Ghost 2").
- **Counting**: big tiles (104 px) for 48 common US treats in six categories
  (Chocolate, Fruity & sour, Gummies, Hard candy, Full-size!, Not candy).
  Tap is +1 with a bump and a floating "+1"; long-press or the round − is -1.
  A sticky header with the child, Undo and the running total, a stacked bar
  by category with a legend, search ("kit kat", "reeses"), category chips and
  "In the bag", and **Other…** for a family's own kind (30 at most). The tiles
  are patched in place, never redrawn, so the grid never jumps under a thumb.
  Milestones (25, 50, 100...) get a toast and candy confetti.
- **Fair trade**: two children on one device each tap what they offer; a
  sticky meter at the thumb weighs it by a points tier (Full-size 5,
  Chocolate 3, Gummies and Fruity & sour 2, Hard candy and candy corn 1,
  Raisins and Not candy 0.5 - editable under Grown-ups) and says it in plain
  words: "Leo’s 2 peanut butter cups for Maya’s 6 lollipops is fair." Fair is
  within 10% (half a point on small trades). Uneven says who gives "a bit" or
  "a lot" more, with a hint to even it up (the fewest pieces of one kind the
  other child still has). **Swap** moves the pieces both ways; an uneven swap
  is allowed as "Swap anyway (a gift)" - the meter advises, it does not rule.
  A trade log, and Undo on the latest while the pieces are still there.
- **Make it last**: per child, pieces a day (slider, default 2), which days
  (chips, plus every day / school nights / weekends), "The stash lasts until
  Sun Nov 22", the next seven days, and a purple "Today: 2 pieces - 1 left
  today" card with **Eat one** (pick which piece) and Undo. Past today's
  number it asks for "Grown-up says yes" rather than refusing. Set-aside
  candy and things nobody eats (pencils, stickers...) are left out. Gentle
  copy, no health claims anywhere (tested).
- **Switch Witch / buyback** (optional, same page): cents a piece or a prize
  and how many pieces it takes; a slider says "Trading in 20 pieces is worth
  $2.00" and lists which go (lowest points first, so favourites stay; never
  set-aside or non-food). Trade them in, with Undo.
- **Set aside**: per child, the family taps the kinds to set aside; they form
  a pile kept out of the plan and never handed to that child in a trade - but
  still tradeable away (the classic allergy swap). "Same for everyone", "Hand
  it to a grown-up" (with Undo), "Always read the label - recipes and sizes
  change", and one friendly Teal Pumpkin line. **Haul makes no allergen claims
  of its own**: there is no ingredient data in it (tested).
- **The haul card**: per child or the whole family - total, full-size, kinds,
  the rarest find (a static 1-5 "rare" score per candy), the top three and a
  title from the mix ("The Chocolate Baron", "Sour Specialist", "Full-Size
  Hunter", "Gummy Guru", "Lollipop Legend", "Treasure Collector", "Variety
  Champion", "Mega Hauler", "Small but Mighty"; never mean - tested over 400
  mixes). Drawn at 1080 x 1350 on a canvas on the device and shared with
  `navigator.share({files})` where allowed, else downloaded - in two taps
  (draw, then share) because iOS needs a fresh gesture. Never uploaded. Names
  are a tick box, on by default only if a name was given; off, a child is
  their costume ("Dinosaur") and the name is nowhere in the card data.
- **"Count it from a photo"** (metered, signed in): see below.

Built 2026-10-31 as the **Halloween holiday drop** (challenge/CLAUDE.md,
"Holiday drops"), counted as an **everyday** one: Sorted (2026-10-30) was
everyday too, by the alternation's own rule ("holidays keep their date and
theme, and count as whichever kind they are"), so 2026-11-01 is a business
day. **Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/haul`,
served at `challenge.strongtechnicalconsulting.com/haul/`. It has **no
collections of its own** (`HAUL_COLLECTION_PREFIX` is read so anything it
ever stores is prefixed from the first write). Deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting and
graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it was picked (Halloween, everyday life)

- **The lab's rule for a holiday: something people actually use that day.**
  The candy tip-out, the sibling trading, the "how many a day" negotiation and
  the bag that vanishes by Tuesday happen in every trick-or-treating house
  tonight. Haul is for that hour on the living-room floor and the weeks after.
- **Fun leads, and it is still a tool.** Counting is a game (big tiles, a
  bump, a total that pops), trading gets a referee kids accept (the meter),
  and the ration plan turns an argument into a date on a screen.
- **Free on the device.** Everything but the photo count works signed out,
  offline, with no request at all.
- **Something to show a friend**: the haul card.

**Not a repeat:** nothing in the lab or the portfolio counts, trades or
rations anything; Tada (routines) and Sorted (decluttering) are the nearest,
and neither overlaps.

**Who pays.** Almost nobody. The one metered thing (Haiku for the free tier,
Sonnet for members via `identity.planFor`) costs a cent or two a photo.

**How it becomes an iPhone app.** The camera straight into the photo count, a
widget ("Today: 1 left"), a Live Activity on Halloween night with the running
total, haptics on every tap, and the share sheet for the card.

## The decisions that matter

- **One rules file, run three times.** `public/haul-core.js` is UMD
  (`window.HaulCore` in the page, `require` in the server and tests): text
  cleaning, the candy and avatars, the family and its cleaner, counting and
  undo, totals and the bar, titles and the card, fair trade and the swap,
  days and the ration plan, eat one, buyback, set-aside, what the photo count
  sends and accepts, and the sample. **No clock and no dice** (tested): today,
  now and every new id are handed in. Days are day numbers from `Date.UTC`,
  so a ration plan across the November clock change counts days, not hours.
- **Every function is pure**: it returns a new family; the page keeps the
  undo steps (what was actually applied, so a minus at zero is not a step).
- **Storage is cleaned on the way in** (`cleanFamily`): known candy only,
  whole counts 1..999, six children, 30 custom kinds, trades only between
  children who are there, an impossible plan back to 2 a day, a prototype
  key ignored (tested with a hostile record).
- **The haul belongs to the device.** No route accepts a name, a count, a
  trade or a plan (tested: `/api/haul`, `/api/sync`... are 404s). The page
  asks for exactly `api/me`, `api/auth/*` and `api/ai/count` (tested).
- **Neutral copy**: no he/she anywhere (tested over every string); "your
  child", "they".

## The model call (metered, signed in only)

**`POST /api/ai/count`**: `requireUser, requireBudget, requireDailyCap`
**then** the route's own 1 MB parser (401 / 402 / 403 / 503 before it, never
413 - tested), then `ai.brief` rebuilds the request (`photoRequest`: exactly
`{image: {type, data}}` - a name, counts or any other field is a 400; the
image must be a JPEG or PNG **by its bytes**, at most 720 KB and 1600 px, and
its EXIF, comments and PNG text are stripped before the model sees it), then
one forced tool `record_counts` through **one call site** (`ai.ask`, the only
`messages.create`) whose `id` enum is Haul's own candy, then `cleanCount`:
known ids only, whole counts 1..200 each and 800 in all, duplicates merged,
up to 8 "Other" things with a plain 28-character name (an "Other" that is
really on the list - "Snickers" - is mapped onto it) and a known category, a
known confidence ("low" when unknown), one short note with no links or
markup. The text the model gets is the fixed candy list and nothing from the
family (tested: it equals `ai.text()`). The prompt says to count only what is
visible, never to describe people, and that words on wrappers are data.
Nothing is stored or logged; nothing counted is a 422 with a way forward.

The page redraws the photo through a canvas at 1200 px (smaller if still over
the limit), which drops EXIF and location, and the sheet says exactly what is
sent before the tap ("this one photo, shrunk on this phone and with its
location removed. Nothing else - not Leo’s name, not the counts"). The answer
is a **proposal**: every row has a tick box and a stepper, "Other: <name>"
rows become the family's own kinds, and nothing changes until **Add N pieces
to Leo’s haul** (with Undo). Signed out it says it needs a free account; 401
opens sign-in; 402 opens the credit sheet; 403 `verify-email` shows its
sentence and "Send the link again"; sheets size themselves below the shared
confirm-your-email banner.

## Local run and tests

```
npm run dev     # memory identity + fake model, at http://localhost:8144/haul/
npm test        # the rules first, then end to end over HTTP under a /haul mount
```

`HAUL_MEMORY=1` and `HAUL_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0` (the gate itself is held by the suite's last
test and by the lab's). The fake refuses a call that does not force a tool,
keeps every request (`fakeClient.calls`), and takes `fakeClient.mode` for one
call: `blank`, `inject`, `maxtokens`, `upstreamNNN` (the request carries only
a photo, so there are no trigger words).

`test/run.js`: the candy list and the tier; text cleaning; a hostile stored
family; counting, the clamps and undo; totals and the bar; titles (and none
mean); the card with names on, off and by default; fair-trade maths, words,
hints, set-aside both ways, the swap keeping totals, gifts, the log and its
undo; the ration plan with a fixed clock (Sat Oct 31: "lasts until Sun Nov
22", eat one, a grown-up's yes, weekends only, no plan, an empty or all
set-aside stash, across the clock change); buyback sums and which pieces go;
set-aside and hand-over; the photo payload and a hostile model answer;
accepting a proposal; the sample; contrast in both themes, literal colours
and the lab card; 44 px targets and 104 px tiles; the page's promises
(relative URLs, no inline script, the banner, wrapped storage, only three API
paths, every received string escaped, the photo redrawn on the device, the
card never uploaded); neutral copy, no health or allergen claims; the local
switches; and over HTTP: signed out with zero model calls and a 401 before
the parser, no route that takes a haul, the gate order, one door and one call
site, the photo count (400s with no model call, what the model saw, PNG,
hostile output, 422, 502 and 503), and the 403 / 402 / 503 gates.

Rendered with Playwright at 390px and 1280px, light and dark: the first run,
Try it, adding children, counting mid-way and searching, eat one, the plan
with the buyback, set-aside, fair trade (fair and uneven) and the log, the
card preview and the drawn card (saved as PNG), Grown-ups, the photo count
signed out, signed in and its proposal, and the lab card on the landing page;
then a hostile pass (markup, bidi and long names).

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Data

- **In the browser** (every access wrapped; works in memory when storage is
  unavailable, with a one-time warning): `haul-data-v1` (the children and
  their counts, set-aside flags and plans, the family's own kinds, trade
  points, the trade log, the buyback deal) and `haul-prefs-v1` (the child on
  screen). Clear everything under Grown-ups. "Try it" is never saved.
- **On the server**: nothing. The photo is read once by the model and dropped
  with the request.

## Routes

Public: `GET /api/health`, `/healthz`, `/api/me`, the page, the service
worker. Metered: `POST /api/ai/count`. The shared account at `/api/auth`.

## Ideas not built yet

- **Sync the family to an account** so two parents' phones agree - kept on
  the device for v1, so nothing about anyone's children is stored.
- **A street map of the good porches** (full-size houses) for next year -
  would need a shared store and moderation.
- **A trade request from one phone to another** (siblings with their own
  phones) - needs a server-side room; the one-device meter covers the floor.

## Security

- A script CSP on every page; no inline `<script>` or `on*=`; clicks by one
  `data-act` listener (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the only parser over 16 KB
  runs after its gates.
- Every typed name and kind and every model answer is untrusted: cleaned in
  the core (no markup, bidi or invisible characters, bounded, a letter
  required), and escaped on render; canvas text is drawn as text.
- Failures (`fail()`/`failure()`): only the app's own errors reach the page
  in their words; a provider error is a 502 (503 "The AI is busy"). Nothing
  logged carries a body or a photo.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
