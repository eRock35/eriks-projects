# For Claude: Hike

Raise your prices without losing your regulars. A café, salon, trade, shop,
studio or freelancer who hasn't raised prices in a while gets **a number**
(the break-even: "You could lose up to 1 in 12 customers (9%) and still make
more"), **a plan** (their price list rounded like a pro and held under $10, a
rollout with dates and an .ics file), **the words** (an email, a door sign, a
social post, a text to regulars and a counter script for "why did prices go
up?") and, afterwards, **a verdict** ("Sales are down 3.9% - your break-even
was 9%. You're ahead about $827 a month").

Built 2026-09-29 as the thirteenth of Erik's lab drops, after Spar, Snapquote,
Chaser, Rave, Pop Quiz, Glowup, Booth, Receipt, Tally, Tipout, Tells and
Covenant. **Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/hike`,
served at `challenge.strongtechnicalconsulting.com/hike/`, data in `hike_*`
collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

A free pick, not from Friction: on 2026-09-29 nothing was spiking there, and
the only rising problem (an agentic-AI compliance incident) had been seen once
and would need regulatory specifics a daily drop cannot check; the finance
ones were already taken by Tally and Covenant.

The problem: small businesses sit on prices for years because raising them
feels risky. They fear losing regulars, they don't know how many they can
afford to lose, they round badly ($4.50 -> $4.86), and they dread writing the
announcement and answering "why did prices go up?" at the counter. Hike turns
it into a number, a plan and the words. Nothing in the lab or the portfolio
does this: Snapquote quotes one job, Glowup rewrites a listing, Tally
reconciles card sales.

**Who pays.** Nobody, for almost all of it: the break-even, the price list,
pasting a list, the rounding, the board preview, the templates of all five
announcement pieces, the rollout, the calendar file and the tracker work in
the browser with no account and no model call. Two things are metered and
signed in: **snapping a menu** (reading prices off up to four photos) and
**writing the announcement with AI** (Haiku for the free tier, Sonnet for
members, via `identity.planFor`), each a cent or two. Saving plans is free
with an account.

**The honest risk.** The break-even assumes the customers who leave are
average ones and that costs per sale stay put; it is an estimate from the
owner's own numbers, and the page says once, plainly, "Estimates from your
own numbers - not financial advice." The announcement could put words in the
owner's mouth, so the model may only use figures they gave (below).

## The decisions that matter

- **One rules file, run twice.** `public/hike-core.js` is UMD: the page loads
  it as `window.HikeCore`, the server and tests `require` it. The meter, the
  rounding, the list, parsing a paste, the rollout, the .ics, the verdict, the
  templates, the figure check and every `clean*` are there.
- **Money is integer cents.** Typed money is read from its digits (`toCents`:
  `$1,240.50`, `4.5`, `4`, `4,50`, `45¢`, `£3` all read; anything without a
  digit is no figure; negatives are not prices). Percentages are basis points
  (`toBp`), shares are tenths of a percent, and products of prices and
  volumes are BigInt.
- **The break-even** is `1 - m0/m1 = (p1 - p0) / (p1 - c)` when
  `m1 > m0 > 0`, **floored** to a tenth of a percent; "1 in N" uses the next
  whole N **up** (so 1/11 exactly is "1 in 12": at 1 in 11 you only break
  even). Never overstated. Edge cases each have a sentence: no price, no new
  price, the same price, a cut ("you'd need 20% more customers just to make
  the same"), cost unknown (asks for cost or margin %, with a margin field),
  cost >= price ("every sale loses money today - any raise helps"), zero
  sales (the share holds, the dollars need sales). "What if I lose x%?" gives
  the monthly profit change, gains rounded down, losses up. The working is
  one "How we worked this out" line.
- **Rounding.** Five styles: `.95/.45`, `.99/.49`, nearest 5¢, whole
  dollars, nearest $5. The new price is the style's **nearest** point to the
  exact target (a tie goes up), and never at or below the old price.
  **Hold under** (default on): a price that would cross a round number the
  old one sat under ($5, $10, $20, $50, $100... and every whole dollar under
  $5) is held at the style's last point below it - $9.50 -> $9.95, not
  $10.45 - if there is room above the old price; if not, it crosses and is
  flagged ("Crosses $50 · no room under it"). Per line: lock (keep the $3
  coffee), let it cross, or set a price by hand.
- **The blended raise** is weighted by sales (revenue now vs after) when every
  line has a volume, else a simple average of the lines' raises, and the
  page says which. With every cost and volume, the list gets its own
  break-even and "if nobody leaves: +$1,594 a month". Under the target, it
  says why and what target reaches it (`targetFor`, half-percent steps); well
  over it (a $5 grid on $20 prices), it names the biggest jump.
- **Pasting a list is deterministic and free** (`parseList`): menus with
  dot leaders, "$4.50 Latte", "Haircut - $45", tab or comma columns (name,
  price, cost, sales a month), headers skipped, headings become sections,
  sizes and counts ("16 oz", "60 min", "2 eggs") are not prices, phone
  numbers and ranges are skipped, thousands commas and decimal commas both
  read, duplicates dropped, 200 lines max, and it says what it skipped.
- **Snap the menu** (`POST /api/snap`): up to 4 photos, shrunk to ~1600px in
  the browser, checked by their bytes before anything is spent, read once by
  one forced tool `record_prices` and dropped - never stored, never logged.
  `ai.cleanPrices` runs every price through the same cents parser (a price in
  words is no price and the line is dropped), bounds and strips every string,
  dedupes and caps at 200. The page shows an editable review list (untick,
  fix a name or price) before anything joins the plan.
- **The announcement's figure check.** One forced tool `write_announcement`
  returns the email, sign (280), social (600), text (320) and up to five
  counter Q&As. The prompt forbids inventing reasons, numbers and promises.
  Then `Core.draftProblems` looks for every percentage and money figure
  (`12%`, `8 percent`, `$6`, `30 cents`, `2 dollars`) and refuses any that is
  not in the owner's inputs or the price list the **server** repriced from the
  cleaned lines (old and new prices, the changes, per-line and blended raises
  at their whole and one-decimal rounding - "about 7%"). The voice sample is
  **not** a source: its "25% off Tuesdays" is not a fact. A draft that
  invents is asked for again once, naming the figures; if the second still
  invents, each offending piece is replaced by the template's version and
  the page says which and why. Years and counts are not money.
- **Templates** (`Core.templates`) fill all five pieces from the inputs alone,
  in three tones, so signed-out visitors and anyone out of credit still get
  usable words; the suite runs the same figure check over them.
- **The .ics** is RFC 5545 (CRLF, 75-octet folding without splitting UTF-8,
  TEXT escaping, all-day `VALUE=DATE` events, `DTEND` the next day, a
  `VALARM` at 9am on the day). UIDs hash the plan and the step's **kind**,
  not its date, so re-importing after moving a date moves the event.
- **The verdict** compares the average week since the change with the week
  before, against the meter's break-even. **Revenue mode** turns money back
  into sales first (revenue / price), because revenue already includes the
  new price: 3% more revenue after a 6.5% raise is fewer sales, and it says
  so. The change is rounded toward the worse (floor), dollars as the meter.
  Under three weeks it says it is early. The chart is one line with the
  "before" and break-even lines labelled; the weeks list is its table.
- **Save stores the plan, never a photo.** One document per plan under the
  owner's uid; every route is a 404 for anyone else's. Written whole (a
  removed line stays removed). Signed out, the plan lives in localStorage
  (every access in try/catch) and is offered to the account after sign-in;
  a saved plan saves itself 1.2 s after a change.
- **Failures** (`fail()`/`failure()`, Covenant's): only the app's own errors
  reach the page with their words; a provider error is a 502 (503 "The AI is
  busy") sentence. Logs carry a stack's first lines, never a body. Both AI
  routes stream whitespace (`lib/stream.js`), so sign-in, budget, cap, the
  parser and the 400s come first with real statuses; after that a failure
  is a 200 `{error}`.

## The first run

The page opens straight on the example - "Example: Maple Street Coffee", an
invented café with 12 lines, costs and monthly sales, a locked $3.00 drip
coffee, `.95/.45` rounding, hold-under on (the $9.50 breakfast sandwich is
held at $9.95), target 8% (6.8% achieved, with the tip to reach 8%). A plum
strip says "This is an example café - try the sliders, then make it yours"
with **Start my own**; the first thing a phone sees under it is the sentence
"You could lose up to 1 in 12 customers (9%) and still make more", twelve
dots with one gone, then the inputs and the new-price slider with +5/+8/+10/
+15% and "My list" chips, and "What if I lose 4%? +$800 a month" on a
green-to-red slider marked at the break-even. Below: the list and its menu
board (Before/After, Copy, Print), the templated announcement (sign, counter
script, email, post, text), a rollout 30 days' notice with check-ins, and a
tracker four weeks after the change (dates relative to today, so the story
always holds) that says "ahead". **Start my own** clears to an empty plan,
opens the paste box and focuses it. Snap and "Write it with AI" ask a
signed-out visitor to sign in; a 403 `verify-email` shows its sentence and
"Send the link again"; a 402 opens the credit sheet.

On a desktop the meter sits in a sticky left column, so the number stays in
view while you work the list.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8113/hike/
npm test        # pure rules first, then end to end over HTTP under a /hike mount
```

`HIKE_MEMORY=1` and `HIKE_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `HIKE_COLLECTION_PREFIX` (set to
`hike_` by the lab host) prefixes every top-level collection. The fake model
refuses a call that does not force a tool. Triggers - in photo bytes:
`BLANK`, `INJECT`, `MANY` (205 lines), `MAXTOKENS`, `UPSTREAMnnn`; in the
business name or own reason: `INVENT` (first draft says 12%, retry clean),
`INVENTTWICE` (both drafts invent: template stands in), `VOICEECHO`,
`INJECT`, `UPSTREAMnnn`. Anything else reads as the example menu / a plain
draft from the facts.

## Data (Firestore: `hike_*` in the lab database `challenge`)

- `plans/<uid>/items/<id>` - `{name, meter: {price, cost, margin, costMode,
  volume, newPrice, unit, whatIf} (as typed), lines: [{id, name, price,
  cost, volume, locked, hold, manual, section}] (cents), settings: {target
  (bp), style, holdUnder, currency}, rollout: {notice, effective,
  grandfatherWeeks}, announce: {business, type, reasons, since, other, tone,
  summary, grandfather, voice}, draft: {email, sign, social, text,
  staffScript} | null, tracker: {mode, baseline, entries: [{week, value}]},
  createdAt, updatedAt}`.

Limits (`Core.LIMITS`): 10 plans a person (409), 200 lines (400 over), 52
tracker weeks (400 over), 4 photos (3 MB each, 8 MB together, decoded), $100,000
any one price. JSON bodies 128 KB except the snap (12 MB, after the gates).

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the static page. Signed
in: `GET|POST /api/plans`, `GET|PUT|PATCH|DELETE /api/plans/:id`,
`POST /api/plans/:id/duplicate`. Metered (`requireUser, requireBudget,
requireDailyCap`, then the parser for the snap): `POST /api/snap`
`{photos: [{type, data}]}`, `POST /api/announce` `{announce, lines,
settings, rollout}`.

## Ideas not built yet

- **Tiered raises**: raise the hero items less and the add-ons more, with the
  blend held to a target.
- **Competitor check**: type what the café down the road charges.
- **Staff briefing sheet** to print beside the till.
- **Sharing a plan** with a partner or bookkeeper (needs links and revocation,
  like Tipout's receipts).
- **Reminders by email** at each check-in - needs a mail path the lab does not
  have; the .ics covers it for now.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`
  (tested here and by `challenge/test/lab.js`).
- No model call for a signed-out visitor, ever; the snap's gates run before
  its 12 MB parser (tested: 401/402/403, not 413).
- Model output is untrusted: cleaned, bounded, figure-checked and escaped on
  render (`esc()` on every string the page draws).

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
