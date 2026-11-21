# For Claude: Ladle

Save the family recipes before the cards fade - then scale, shop and cook
from your phone. For **anyone with family recipes on index cards**.

**This is a rebuild of the 2026-11-16 drop.** Ladle was first built and
reviewed on 2026-11-16, then lost with its build container on 2026-11-20
before it was pushed. Erik asked for the lost drops back on 2026-11-21. Its
code and brief did not survive; this was built fresh from the
reconstructed spec in the repo-root `HANDOFF.md` ("Ladle - everyday"),
which kept only its name, tagline, audience, emoji and colours. Everything
that spec names is here. It drops again as drop #64 on 2026-11-21, timed for
Thanksgiving (Thursday 26 November 2026).

- **Save a card.** Type it as the card says - "1 1/2 c. flour", "2 T
  butter" (a capital T is a tablespoon), "1 t salt" (a small t a teaspoon),
  "1 (15 oz) can pumpkin", "2-3 apples" - one ingredient a line, one step a
  line; a "How Ladle reads them" list shows how each line was read before
  Save. **Whose recipe it is** is its own field, typed by the person - never
  read off a card by a model. Photograph the card (front, and the back if
  it has one): the photo is redrawn through a canvas (location and camera
  details gone) and **kept on this phone only**, shown beside the form.
- **Type it up** (metered, signed in): the card's photos go to one forced
  tool; the reading fills the form for the person to check beside the card,
  with the lines the model found hard to read listed, and "Left out by
  Ladle's checks: ..." naming what was dropped.
- **Scale with real fractions** (`LadleCore`, whole-number fractions, no
  floats): serves 8 to 16 doubles ¾ cup to 1 ½ cups; to 14 it is 21/16 cup,
  said exactly as "1 cup + 5 tbsp". A cook's fraction (halves, thirds,
  quarters, eighths) is exact; anything else rounds to the nearest eighth
  or third and is marked "~". Scaled US volumes are **tidied the way a cook
  says them** (4 tbsp is ¼ cup, ⅛ cup is 2 tbsp, 3 tsp is 1 tbsp); as
  written (1x) stays as written. A recipe without "serves" scales ½x to 3x.
  Amounts inside the steps are not rewritten, and the page says so.
- **Units**: As written, US cups or Metric, one tap, remembered on this
  phone. Metric is rounded the way a metric recipe would say it; a US
  amount from metric goes to the nearest eighth and is marked. Oven
  temperatures in the steps get the other scale beside them (350°F
  (175°C)), rounded to 5. Flour in cups never becomes grams: there is no
  one density, so volume stays volume.
- **One shopping list** across the recipes picked, each at the size it
  will be cooked: lines for the same thing added up exactly (US volumes in
  teaspoons, weights in ounces, metric in ml and g, counts by their unit -
  "butter, melted" and "butter, soft" are one line; sugar and brown sugar
  two), an unmeasured "salt to taste" folded into the measured salt, sorted
  by aisle in shop order, ticked as you go (ticked lines sink), typed extras,
  sent as plain text, and "Start a new list".
- **Cook mode**: one big step at a time, Back / Next (and the arrow keys),
  the ingredients a tap away, the **screen kept awake** with the Wake Lock
  API where the browser has it (asked again when the page comes back to the
  front; said plainly where it cannot), and **timers from the words of the
  step** ("bake 40-50 minutes" offers 40, "1 1/2 hours" 90): several at once,
  pause and clear, by their end time, a chime, a vibration and a spoken
  announcement when done.
- **Print a fresh card**: a 4 x 6 index card (`@page` set by a style
  element) or a full page, at the size and units on screen.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/ladle`,
served at `challenge.strongtechnicalconsulting.com/ladle/`, data in
`ladle_*` collections of the lab's `challenge` database. See
`challenge/CLAUDE.md`. Every browser URL is relative to `BASE`. Staging only.

## Why it exists

An **everyday** drop. The recipes families care most about live on index
cards in a drawer, in a hand that is getting harder to read, and the week
they all come out is Thanksgiving. Ladle saves them, then does the sums
nobody wants to do at the counter: doubling ¾ cup, adding the eggs on three
cards, 350°F in Celsius. Free first: everything works signed out and
offline.

**Not a repeat**: Again (the lab's meal-plan drop) plans weeknight dinners
from scratch; Rush is a bakery's preorders. Neither keeps a family's own
cards.

**No real brands, anywhere** - no food, grocery, appliance or kitchenware
company; the demo says "evaporated milk", "shortening", "corn syrup". The
suite checks every file for a list built from pieces.

**The colours.** The original card was terracotta #8e452c and index-card
blue #466e9e; both were too close to newer cards in CIE Lab, so the lab
card moved to a cocoa #644642 and a faded-ink #706ea0 (the reasoning is
in `lab.js`). The app itself keeps the original terracotta and blue.

**Who pays.** Almost nobody. A free account keeps one recipe box in step
across two phones. The one metered thing - typing up a card - costs a cent
or two (Haiku for the free tier, Sonnet for members, via
`identityLib.planFor`).

**How it becomes an iPhone app.** The camera straight into "Type it up",
timers as Live Activities, a share extension for the shopping list.

## The decisions that matter

- **One rules file, run three times.** `public/ladle-core.js` is UMD
  (`window.LadleCore` in the page, `require` in the server and the tests).
  **No clock and no dice**: every time stamp and id is passed in (tested).
- **Amounts are fractions, never floats**: `[numerator, denominator]`,
  reduced, stored that way (`q`, and `q2` for the top of a range). Floats
  appear only for metric.
- **Text is refused, never cleaned** (`refuse`): markup, bidi and invisible
  characters, an @ in any width, a link, a formula, a card number, nine
  digits in a row in any script, a phone number. A recipe's own numbers
  ("2 1/4 tsp", "9 x 13 inch", "350°F", "- 2 cups" as a bullet) pass.
- **The one door** (`cleanBox`): strict on the server (anything out of shape
  is an error and the whole body is refused), lenient for this phone's own
  copy (the bad bit dropped).

## The example (`public/demo.js`)

**Nana Dot's recipe box** is invented, family and all (Nana Dot, Aunt Lou,
Uncle Ray, Grandpa Walt, Mom): six cards - pumpkin pie, cornbread dressing,
sweet potato casserole, cranberry sauce, butter rolls and Uncle Ray's chili
(written the old way, with T and t). Thursday's list is two pies, the
dressing and the sweet potatoes: 24 lines and a hand-typed coffee - 8 eggs
from three cards, 1 cup butter, 2 cups sugar, 2 tsp salt, 2 cans pumpkin
(the suite checks each). Every view and the printed card say it is made up;
it keeps no photos and is never kept, sent or synced.

**The tour**, five steps: the box (open the pumpkin pie), scaling (make it
serve 16), the list (tick the eggs), cook mode (start the 15 min timer on
step 5), and saving a card (type up the example card - Aunt Lou's pecan pie
on a lined index card drawn as SVG; its pre-made reading carries a "from"
name, calories and a nutrition line, which the same check as a real reading
drops), then "Save my first recipe".

## Storage: one module, photos on this phone only

`public/ladle-store.js` is the only module that touches browser storage
(IndexedDB `kv`, every access wrapped, falling back to memory and saying
so): the box (through `cleanBox`), this phone's flags (tour, units, card
size), the sync base, and **card photos** - JPEG data URLs under
`<recipe id>-1` / `-2`, at most 120, **never synced** (a recipe carries only
how many photos its card has, so the other phone can say "the photo is on
the phone that took it"). `app.js` touches no storage itself (tested).

## Sync (signed in, free) and the merge

`ladle_boxes/<owner tag>` = `{owner, box, updatedAt}`, the tag an HMAC of
the account id under a key derived from `IDENTITY_SESSION_SECRET` ("ladle
owner v1"). One box per account. `PUT /api/sync {data, base}` saves in a
transaction only if `base` matches the stored `updatedAt`, else **409 with
the account's copy** (`code: 'conflict'`); a box removed on another phone is
409 `removed`. Refused whole (400) for an unknown field anywhere, an @,
nine digits, a phone or card number, a link, a formula, markup, an
invisible character, an unknown unit, an amount that is not a fraction,
serves outside 1-48, more than 250 recipes, 60 ingredient lines or 40
steps; ~600 KB stored (413); the 1.5 MB parser after the sign-in; 120 saves
per account per 10 minutes. The page re-asks when it comes to the front and
every minute.

**The merge** (`LadleCore.merge`): each recipe, each recipe's place on the
list, each tick and each typed extra by its own time; a removal is a change
like any other. **A recipe both phones changed since they last agreed**
(the sync base) keeps the later one, and the other is kept beside it as
"Name (other phone)" with a note - no typing is lost. Symmetric and
idempotent (by hand and over 150 random pairs, each result passing the
strict door).

## The model call (metered, signed in only)

**`POST /api/ai/card`** - "Type it up". `requireUser, requireBudget,
requireDailyCap` **then** the route's own 5 MB parser (401 / 402 / 403 / 503
before it, never 413 - tested), then `cardRequest` rebuilds the body to **the
photos alone** - exactly `{images: [{type, data}]}`, one or two; a recipe, a
name, a question is a 400 `extra-field` with no model call. Each photo is
checked by its magic bytes (JPEG, PNG or WebP; 1.5 MB decoded; 1600 px a
side) and its metadata stripped again (`lib/image.js`, Snug's and Rush's
but for words).

One forced tool, `record_recipe`: title, serves, ingredient lines (amount,
unit and the rest as written, an unclear flag), steps (text, unclear),
notes, unsure. **No field for a person.** One fixed sentence ("Type up this
recipe card." / "... The second photo is the back of the same card.").
`max_tokens` 4,400 with the arithmetic in `lib/ai.js` (the schema's caps:
40 lines, 24 steps of 300 characters). `cleanAiCard` keeps only those
fields: any other (a name, calories, a price) is dropped and named; a line
with an email, a phone number, a link, markup or a nutrition, allergy or
health claim is dropped and counted; every amount goes through Ladle's own
reader; nothing readable is a 422. The page fills the form, never saves:
**Save** keeps it, on the phone. Before the tap the sheet shows the exact
JPEGs and says "nothing else". Signed out it offers a free account and the
example. No model call for a signed-out visitor, ever.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8177/ladle/
npm test        # the rules, the demo, storage, the look, the page, the copy, then HTTP under /ladle
```

`LADLE_MEMORY=1` and `LADLE_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js` (the tests
spawn each with `K_SERVICE` set). `LADLE_COLLECTION_PREFIX` (`ladle_` from the
host) prefixes every collection. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call that does
not force a tool, keeps every request, reads a made-up molasses cookie
card, and takes `fakeClient.mode` (`blank`, `bad`, `inject`, `maxtokens`,
`upstream401`, `upstream529`) for one call.

`test/run.js` (26 tests): fractions; reading a line as a card writes it;
scaling and tidying; US and metric; temperatures, timers and clocks; the
shopping list (adding up, aisles, ticks, text); hostile text; the editor's
door; the strict and lenient box door; the merge by hand and as a property;
the card request and answer; the demo's planted story; the storage module;
contrast in both themes, the lab card (white text, 20+ in CIE Lab from
every card, drop #64), 44 px; the page's promises (no inline script,
BASE-relative, the requests it makes, every interpolation escaped, the wake
lock and timers, the tour); the copy (no brands, emails, phone numbers,
invisible characters, session links; model names only in `MODELS`; the
shared files byte-identical); the local switches and the prefix; and over
HTTP: images by their bytes, signed out with zero model calls, cross-site
writes refused, the gates before every parser, sync with its 409 merge and
refused bodies, the AI route (what the model saw, the answer checked, 422 /
502 / 503 / 413), the 403 / 402 / 503 gates, and a hostile pass that leaves
nothing personal in the store.

**Rendered** in headless Chrome (driven over the DevTools Protocol - there is
no Playwright on the build VM) at 390 px and 1280 px, light and dark: the
first run, the box, a recipe at 1x, 2x and metric, the shopping list, cook
mode with a timer running, the example card typed up beside its picture,
the saved example, the print sheet, More, an empty "Add a card", a recipe
typed in from scratch, its cook mode and list. No console error or CSP
violation, nothing sideways, no target under 44 px. Found on the way: the
full-width plus and the ballot x drew as empty boxes in a font without
them (now "+" and "×"), the clear-timer and remove-item buttons were 41 px
wide, and the "How Ladle reads them" summary was 24 px tall.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`
(and `eriks-projects/lib/` for `identity-store.js`).

## Routes

Public: `GET /api/health`, `/healthz`, `/api/meta`, `/api/me`, the page, the
service worker. Signed in, free: `GET|PUT|DELETE /api/sync`. Metered:
`POST /api/ai/card`. The shared account at `/api/auth`. No route hosts a
recipe, a list or a photo (tested).

## Deliberately not built

- **A share link for a recipe or the box**: it would publish a family's
  cards (and their names) at a URL. The card prints; the list goes as text.
- **Nutrition, allergens, substitutions or "healthier" versions**: a card
  does not say them and a guess could hurt someone. Ladle copies the card.
- **Cups to grams for dry goods**: needs a density per ingredient, and
  would be wrong as often as right. Volume stays volume.
- **Scaling the numbers inside the steps**: "the remaining 1/2 cup" needs
  the step understood, not just read. The page says to scale those by eye.
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
- The service worker caches the app shell only - never api/, never a recipe.
- Only the app's own errors reach the page in its words; a provider error is
  a 502 (503 "The AI is busy"). Nothing logged carries a body.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
