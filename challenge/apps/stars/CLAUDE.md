# For Claude: Stars

Find the stars on your menu - and the dogs eating your margin. For
**owners, chefs and managers of independent restaurants**.

**This is a rebuild of the 2026-11-15 drop.** Stars was first built and
reviewed on 2026-11-15, then lost with its build container on 2026-11-20
before it was pushed. Erik asked for the lost drops back on 2026-11-21. Its
code and brief did not survive; this was built fresh from the
reconstructed spec in the repo-root `HANDOFF.md` ("Stars - business"),
which kept only its name, tagline, audience, emoji and colours. Everything
that spec names is here. It drops again as drop #68 on 2026-11-22.

Menu engineering, not orders: Rush (`apps/rush`) takes holiday preorders
for food shops; Stars takes none and repeats none of it.

- **The menu.** Each dish: its name, its menu section (Starters, Mains...),
  its menu price, its plate cost and the units sold over a period (the
  period is a label, "Four weeks to 30 March"). Plate cost and units may be
  left empty: the dish is listed and waits, unrated.
- **The analysis, per section**: contribution margin, food cost % and menu
  mix for each dish, the section's margin and popularity lines, and its
  quadrant - **star, plowhorse, puzzle or dog** - with the reason in words.
  Menu-wide totals: sales, food cost %, margin earned, units.
- **The quadrant chart**, inline SVG, one section at a time or the whole
  menu: margin up the side, units along the bottom, the two lines dashed,
  every dot numbered (a dot is never told by colour alone), a hover/tap/focus
  readout, and **the same numbers in a table** under it (scrolls in its own
  box; each dish name opens the dish).
- **Plain suggestions per dish** - keep, reposition, reprice, rework the
  plate cost, cut - with the exact price that would reach the margin line,
  the exact plate cost that would, and the units a puzzle would need to be
  popular. A dish whose plate costs more than its price is flagged first.
- **A what-if price** (and units, if they would move): the new margin, food
  cost %, the section's new margin line and the new quadrant, everything
  else selling the same; "Use this price" saves it.
- **A sales CSV, parsed on the phone, with a column mapper**: Stars guesses
  which column is the dish, section, price, plate cost and units from the
  header (any case, spaces or underscores) and every one can be changed.
  Rows for the same dish add their units (a till export by day); a dish
  already on the menu (same name in the same section, case ignored) is
  updated, a new one is added and needs a price; each row says what it will
  do or what is wrong, and a refused name is shown as "(refused name)",
  never echoed. Up to 2,000 rows and 1 MB. A template to download.
- **The printable report**: every section with its lines, chart, table and
  the first move for each dish, the totals, the method in one paragraph,
  the restaurant's name (from More, kept on the phone) and the period.
  `@media print` hides the chrome; "Print or save as PDF" calls
  `window.print()`. The analysis also exports as a CSV built on the phone.
- **Metered AI: "Read the menu"** - one or two photos of the menu, or its
  text pasted, read into dishes, sections and prices for a person to confirm
  (each editable, unticked if it had no readable price), added with no
  plate cost and no units.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/stars`,
served at `challenge.strongtechnicalconsulting.com/stars/`, data in
`stars_*` collections of the lab's `challenge` database. See
`challenge/CLAUDE.md`. Every browser URL is relative to `BASE`. Staging only.

## Why it exists

A **business** drop. An independent restaurant changes its menu a few times
a year, usually on gut feel. The classic menu-engineering exercise - which
dishes earn their place, which are popular but thin, which are profitable
but hidden - is a spreadsheet nobody finishes. Stars does it from three
numbers per dish and says what to do about each.

## The method (public/stars-core.js)

**This is the classic menu-engineering method** from the hospitality
literature - deliberately cited here without naming any person or company:

- Contribution margin (CM) = menu price - plate cost, per plate.
- Within a section of n rated dishes with T units sold and TCM = the sum of
  CM x units: the **margin line** is the average contribution margin
  **weighted by units sold**, TCM / T. A dish **at or above** it is high
  margin.
- The **popularity line** is 70% of an even share: **(1 / n) x 0.7** of T
  units. A dish **at or above** it is popular.
- Star = high margin and popular; plowhorse = popular, low margin;
  puzzle = high margin, not popular; dog = neither.

**The arithmetic is exact.** Money is kept in **whole cents** and units in
whole numbers; prices are read digit by digit, never through `parseFloat`.
Nothing is divided before it is compared: CM >= TCM / T is tested as
CM x T >= TCM, and units >= 0.7 T / n as 10 x n x units >= 7 x T - so a dish
exactly on a line is decided by integers, never by a float. Percentages and
the displayed lines are rounded once, a half up, in BigInt.

The edges, decided and tested (`test/run.js`, "hand-worked" 1-8, each with
its sums in comments):

- **On a line counts as high** (a star, not a dog).
- **One dish alone in a section** is compared with itself: its margin is the
  line and its share 100%, so it is a star by definition when it sold; the
  page says so and points at the whole-menu chart.
- **Zero sales**: a dish that sold none is never popular. A section where
  nothing sold has no popular dish, and its margin line falls back to the
  plain average of the margins.
- **A negative margin** (the plate costs more than the price) is rated like
  any other - it drags the line down - and flagged "loses $X on every
  plate", with repricing above the plate cost as the first suggestion.
- **The price that reaches the line moves the line**: raising a dish's
  price raises TCM by Δ x its units, so it is solved for:
  Δ >= (TCM - CM x T) / (T - s), the smallest whole cent. The plate cost
  that does the same is the cost less that Δ. A puzzle's units:
  s' >= 7 (T - s) / (10n - 7), at least 1. The suggested "try" price rounds
  the line price up to the next quarter.
- A dish with no plate cost or no units waits, unrated, and is listed.

## The decisions that matter

- **Everything happens on the phone.** The core (`stars-core.js`) is run in
  the page, the server and the tests, with no clock, no dice, no network and
  no storage. The page passes in times and ids.
- **Per section, with the whole menu as a view.** Comparing a dessert with
  a main is the classic mistake; the sections are the fair test. The chart
  offers "Whole menu" with that caveat on it.
- **Plate costs and sales are never sent to the model.** The AI request is
  rebuilt to exactly `{images}` or `{text}`; any other field (costs, sold,
  the menu already in Stars) is a 400 before any model call, and the tool
  has no field for a cost or a count. A reading never sets one.
- **Text through a door, refused not cleaned**: a dish name, a section or
  the period may not carry an @, a link, a phone number, nine digits, a card
  number, markup, a leading formula or invisible characters. Person names
  are NOT refused - dishes are named after people ("Shirley Temple") and a
  menu holds no customer's data.

## The example (`public/demo.js`)

Saltmarrow Kitchen, invented, seventeen dishes in five sections over "Four
weeks of sales". Mains: braised short rib (star), beer-battered fish and
smash burger (plowhorses), wild mushroom risotto (puzzle), confit duck leg
and lobster linguine (dogs; the linguine loses $1.40 a plate). T = 875,
TCM = $10,645.00, margin line $12.17, popularity line 102.1 units. The fish
reaches the line at $21.52 (the tour tries $21.75: a star); the risotto
needs 107 sold. Starters and Desserts show every kind; Kids is one dish
alone (a lone star); Sides is one dish read from a menu with no costs yet.
An example till export (duplicate rows, a new dish, one without a price, a
phone number as a name, a typo) and an example menu page with its reading
(a plate cost, units and a phone number among it, dropped). A six-step
guided tour: the menu, a plowhorse and its what-if, the chart, the sales
file, reading a menu, the report. Never kept, sent or synced.

## Storage: one module, on this phone

`public/stars-store.js` is the only thing that touches browser storage:
IndexedDB (`stars`), with a memory fallback that says so. Keys: `book` (the
menu, through `cleanBook`), `device` (the tour flag and the restaurant's
name for the report - never synced) and `sync` (the account copy's version).
Never kept: a menu photo or pasted text, or a sales CSV (only the rows
applied). The service worker caches the app's own files only (`stars-*`),
never `api/`.

## Sync (signed in, free) and the merge

`books/<tag>` = `{owner, book, updatedAt}`, the tag an HMAC of the account
id under a key derived from the session secret (`"stars owner v1"`). `PUT
/api/sync` saves only against the version the phone last saw; otherwise 409
with the account's copy, and the phone merges: each dish by its own time
(a removal is a change), the period label by its own, and a dish both
phones changed since they last agreed keeps the later one plus the other as
"<name> (other phone)". Symmetric and idempotent (tested over 150 random
pairs). Bodies are refused whole for any unknown field, an @, nine digits,
a link, markup, an invisible character, a non-integer cent or unit, more
than 400 dishes or ~400 KB. 120 saves per account in ten minutes.

## The model call

`POST /api/ai/menu`: `requireUser`, `requireBudget`, `requireDailyCap`, then
its own 5 MB parser, then `ai.brief` (the request rebuilt; each photo
sniffed by its bytes, at most 1.5 MB and 1600 px, metadata stripped again;
pasted text through `pasteProblem`, which asks for the phone number and web
address to come out), then one forced tool `record_menu_items` (items: name,
section, price as printed, unsure; at most 80), `max_tokens` 4000 with the
arithmetic in `lib/ai.js`, then `cleanAiMenu` (names through the door,
prices through the money reader and range; "market price" left empty to
check; any other field dropped and named). Haiku free, Sonnet for members,
via `identity.planFor` and the `MODELS` constant in `server.js` - the only
place a model is named. Nothing is stored or logged. `STARS_FAKE_AI=1`
(refused on Cloud Run) answers with a made-up reading and logs what it was
sent, so the tests can prove what reached "the model" and what did not -
plate costs and sales are **never sent to the model**.

## The look

Warm paper surfaces in light and dark; the original card's raspberry
(`#b0175c`) and walnut brown (`#5b3a29`) in the app. The four quadrant
colours (marks only) were checked as a categorical palette in both themes
and hold 3:1 on the cards; the number on each dot holds 4.5:1. Every text
token holds 4.5:1 (tested from the CSS). 44 px targets, nothing sideways at
390 px, tables scroll in their own box, reduced motion respected, a print
sheet. The lab card's colours were nudged (see `lab.js`); ⭐ is shared with
Rave, kept as the original.

## Files

`server.js` (routes, gates, sync), `lib/ai.js`, `lib/fakeai.js`,
`lib/image.js` (Reset's, but for words), `lib/store.js`, the five shared
`lib/` files and three shared `public/` files (synced by
`scripts/sync-shared.js`; never edit the copies), `public/stars-core.js`,
`public/stars-store.js`, `public/demo.js`, `public/app.js`, `public/app.css`,
`public/sw.js`, `test/run.js`. `npm test` runs with
`REQUIRE_VERIFIED_FOR_FREE_AI=0 STARS_MEMORY=1 STARS_FAKE_AI=1`; `npm run
dev` serves it at `http://localhost:8179/stars/` with the memory store and
the fake model.
