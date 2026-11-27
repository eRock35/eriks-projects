# For Claude: Doorbuster

Will this deal make money? Know your break-even before the sign goes up.

Built 2026-11-27 as drop #73: **the Black Friday holiday drop** (see
"Holiday drops" in `challenge/CLAUDE.md`; the table's seed was "small-shop
deal builder, price-drop sanity check"). A **business** app by kind, so the
next regular drop is an everyday one. It is for Small Business Saturday, a
summer clearance or any short promotion as much as for today: nothing in it
is tied to the date.

## Why it exists

A small shop - a gift shop, a boutique, a bakery, a bike shop, a bookshop -
feels it has to run a deal this weekend. The owner picks "30% off" out of
the air, sells a lot, and never learns that the weekend made less than an
ordinary one. Doorbuster turns the deal into numbers before the sign goes
up, and keeps count on the day.

It is **not a repeat** of Hike (a permanent price rise: its break-even and
the announcement) or Stars (menu engineering). It is about ONE SHORT
PROMOTION: the lift a deal needs, safer shapes of the same deal, an honest
sign, and a live tally.

## What it does

- **A sale in a minute, no sign-in** (`#new`): the owner's first name, the
  shop's name (it goes on the signs), the sale's name, its first and last
  day (at most 14 days), a currency symbol ($, £, € - display only) and the
  shop's usual margin on everything else (a percent, default 50; used only
  for loss leaders and spend-and-save).
- **Items** (Items tab): name, usual price, what it costs you, how many
  you'd usually sell over these days with no deal (`base`), optional stock.
  Up to 40.
- **Deals** (Deals tab): five shapes, each with the arithmetic below, a
  verdict in words beside a status, a goal to tap, sanity flags and up to
  three kinder shapes to apply in a tap and undo. Up to 20.
- **Signs** (Signs tab): a printable shelf card per deal (one a page), the
  same words as a short post and a one-line text to copy.
- **Today** (the first tab): before the sale, "starts Friday" and the plan;
  during it, the live tally (+1 / −1 per deal, a bar to break-even, the
  stock left); after it, the verdict.
- **Team**: one link or six-character code for the staff.
- **Fill from a price list** (signed in, metered - the one model call).
- **See a made-up shop** (`#try`): Juniper & Wren, a gift shop, on the
  Saturday of its Black Friday weekend - drawn by the same code and changed
  by the same rules, in memory only; one tap shows it as staff see it.

**Where it lives:** `challenge/apps/doorbuster`, served at
`challenge.strongtechnicalconsulting.com/doorbuster/`, data in
`doorbuster_*` collections of the lab's `challenge` database. See
`challenge/CLAUDE.md`. Every browser URL is relative to `BASE`; keep it
that way.

## The arithmetic: `public/doorbuster-core.js`

One UMD rules file, run three times (the page, the server, the tests). No
clock and no dice: `today`, `now` and every new id are handed in (tested).
**Nothing worked out is stored** - a break-even, a verdict, a sign's words
are computed from the items and deals on every draw. No model touches any
of it.

### Money

**All money is whole cents** (integers). What is typed in a money box is
read as digits (`parseMoney`), never as a float. Rounding, always in the
direction that keeps a claim true:

- a price with N% off: to the cent, half a cent rounds up (`pctOff`);
- a **break-even is rounded UP** to a whole sale (`ceilDiv`) - 44.4 sales is
  45; an exact one is itself;
- a multiple of usual sales ("2.3x") is tenths, **rounded up**;
- a percentage shown to a shopper is **rounded DOWN** (31.86% is "31%"), so
  a sign never promises more than the deal gives;
- "needs $X of other shopping" is rounded up; "about $412" in a verdict is
  to the whole unit, and says "about".

### One vocabulary for every shape

A deal is sold in **counts**: a unit, a set (multi-buy), a bundle, a use
(spend and save). `offer(s, d)` is what the SHOPPER sees and reads prices
only (a staff phone can run it): `pay`, `full` (the same at usual prices),
`save`, `pct`. `analyse(s, d)` is what the SHOP makes and reads costs (owner
only):

- `after` - what one count makes at the deal price: `pay` − its unit costs;
- `before` - what ONE USUAL SALE makes (see each model below);
- `base`, `baseProfit` = `base × before` - what the usual days make;
- `breakEven` = `baseProfit / after`, rounded up - "You usually sell 20 and
  make $240. At 30% off you make $5.40 each, so you need to sell 45 - 2.3x
  as many - before this deal makes you a cent more." `null` when
  `after <= 0`; 0 when there is nothing usual to beat;
- `x10` - `breakEven / base` in tenths, rounded up.

### The model for each shape (each printed under the deal, each "an estimate from your own usual numbers - not a forecast")

- **Percent off** (5-90%) and **amount off** (less than the price). While
  the deal is on, every unit sells at the deal price - including to the
  shoppers who would have paid full. `before` = price − cost of that item.
- **Multi-buy**: buy N, get M free - or at X% off (`mpct`; 100 = free). A
  set is N+M units; the shopper pays N at full price and M at the discount.
  **The usual buyer of one now takes the set**, so `before` is ONE unit's
  usual margin and `base` the item's usual sales; the break-even is in
  sets. A buyer who still takes just one pays full price and is not
  counted. (Buy 2 get 1 free at $40 costing $22: a set makes $80 − $66 =
  $14, less than the $18 of one usual sale - but far more than the $6 of
  30% off.)
- **Bundle**: two to four different items for one price, under their
  combined price. **A bundle buyer would otherwise have bought only the
  first item** - the one people come for (the form asks for it first) - so
  `before` and `base` are the first item's. The page also says what a buyer
  who would have bought all of it anyway costs (the saving). Stock is the
  scarcest item's.
- **Spend and save**: spend T, get G off. The owner types the usual basket,
  how many baskets these days usually see, and how many of those already
  reach T. Those `clear` baskets **get the money off for nothing**
  (`free = clear × G`). Every use beyond them is counted as a NEW basket of
  exactly T, making `after` = T × usual margin − G. `extra` = `free / after`
  rounded up; `breakEven` = `clear + extra` uses. A shopper who stretches
  from the usual basket up to T adds `stretch` = (T − basket) × margin − G;
  if that is positive the page says how many stretchers pay for the free
  ones, and if not, that only new baskets pay for it.
- On any deal: a **limit per customer** (1-20) and **while supplies last**.

### The verdict (`judge`): words beside a status

For "Make more":

- `after < 0` -> **"Sells below cost: every sale loses $1.20."** - a **loss
  leader**. Then the payback ("each one needs $2.40 of other full-price
  shopping in the same basket to pay for itself", `loss × 100 / margin`
  rounded up), the exposure ("at most $36.00 if all 30 go", `loss × stock`,
  or "no cap yet" without a stock), what the usual days are giving up, and
  a nudge to set a limit. `after == 0` -> "Sells at cost".
- stock known and `breakEven > stock` -> **"You can't break even: you need
  45 and have 30 in stock."**
- otherwise by the multiple: **up to 1.5x "Makes money if you sell 45+
  (1.3x usual)"** (status good); **up to 2.5x "Tight: ..."**; beyond
  **"Unlikely to pay: ..."**. A break-even no higher than usual sales says
  so ("no more than you usually sell").

The **goal** (a tap on the deal: Make more / Clear stock / Bring people in)
changes the words and what is flagged:

- **Clear stock**: cash recovered against what the stock already cost -
  "Clears above cost: selling all 30 brings in $840.00 against the $660.00
  you already paid for them", or "Clears below cost: ... The stock is
  already paid for, so this is cash recovered - $36.00 short of what it
  cost." **Never called a loss** (tested), not flagged for stock under the
  break-even, no limit nudged.
- **Bring people in**: the exposure and the payback lead ("A loss leader:
  every sale loses $1.20"); amber when the cost is capped by a stock or a
  limit, red when it is not. A deal that still makes something says so and
  where it matches the usual days.

### Sanity flags (`flagsFor`) - plain reasons, no legal advice

Below cost; **the "was" price**, asked as a question - "Is $22.00 what you
really charged in the last few weeks?" - and until it is ticked the sign
shows the deal with no "was" price and no "you save"
(**Only show a “was” price you really charged**: said on the page; no statute is cited and
nothing is called legal or illegal - keep it that way); stock lower than the
break-even; two deals on one item (which applies? the sign says "cannot be
combined"); spend-and-save beside other deals; a discount under 10% (a soft
note: "may be too small for shoppers to notice" - not a statistic); an
awkward price ending, with rounding to .99 / .00 / .50 offered and what each
does to the break-even (`endings`); no limit on a deal that makes nothing.

### "Same pull, kinder to your margin" (`alternatives`)

Up to three other shapes, by rule, **only from the owner's own items**, each
with its own break-even, kinder first. Offered only if kinder (a lower
multiple; or, for a deal that loses, anything that loses less) - except the
limit per customer, which changes no break-even and says so. Percent or
amount off -> the multi-buy that looks at least as big (16 / 25 / 33 / 50%),
five points less (a fifth less for an amount), a bundle with the owner's
highest-margin other item saving the shopper the same money; multi-buy ->
the next gentler one; bundle and spend-and-save -> a fifth less off. When
nothing is kinder the page says so. Applying one keeps the deal it replaced
in `undo` (a second suggestion still undoes to the FIRST deal; an edit by
hand ends it); undo restores it exactly (tested).

### The sign (`sign`) - nothing false on it

Drawn from the deal's own numbers by templates: the headline, the item, the
lines ("Now $15.40"; with the tick, "Was $22.00 · Now $15.40" and "You save
$6.60 (30%)"), the fine print ("Limit 2 per customer", "While supplies
last", "Cannot be combined with other offers" only when another deal
overlaps), the shop, the sale and its dates. A price rounded to an ending
leads with the price ("Now $14.99"), never with the percent it no longer
is. The post and the one-line text say the same words.

### The day and afterwards

- **The tally** is `tally.<deal id>` in the shared document, changed by
  `act({t: 'tally', id, n: ±1})` inside a transaction - twelve phones
  tapping at once all land (tested: 120 taps, 120 counts). **Never past the
  stock**: what is left of an item is its stock less every unit every deal
  on it has counted (two deals on one item share it), and the tap that
  would pass it is a 409 "None left in stock - pull the sign". The owner
  corrects it by typing what is really left (`act({t: 'stock'})`).
- **−1 undoes a tap of your own** (`taps.<member>.<deal>` bounds it); the
  owner may undo any.
- The tally is open from the eve of the first day to the day after the last
  (the server's day is UTC; a phone may be a day ahead or behind).
- **Progress** (owner): "31 of 45 - 14 to go", then "Past break-even at
  sale 45 - every sale now adds $5.40"; a loss leader counts what it has
  cost; clearing stock counts cash back. The **pace line** compares what
  the tallied sales have made with the usual figure pro-rated by day, and
  says it is built on the owner's own numbers.
- **After the last day, the verdict** (`wrapUp`): overall ("made about $57
  less than your usual 4 days on these items - the bundle carried it, the
  30% off did not reach break-even") and per deal, with what to do next
  time (the first kinder shape, when there is one). Two deals on one item
  share that item's usual figure once in the total.

## What staff see

**Staff phones see the deals, prices, the tally and stock -
never unit costs, margins, break-evens or profit.** `Core.view(doc, mid)`
cuts the sale down ON THE SERVER: a non-owner is sent no `cost`, no `base`, no `margin`,
no `basket` / `baskets` / `clear`, no `goal`, no `undo`, no suggestion's
words - so a staff phone cannot work a break-even out. Every response that
carries a sale goes through it (tested: every response a staff phone gets,
by key and by number). The page draws staff screens from prices alone
(`offer`, `sign`). Staff tally and undo their own taps; **only the owner**
adds, edits or removes items and deals, changes the days, corrects stock,
removes a member or deletes the sale.

## The sale (no account) - Pencil's table pattern, as Baste uses it

- **Members are browsers.** An HttpOnly cookie `doorbuster_k` (22 random
  characters, `Path` = the app's base, SameSite=Lax); the sale keeps only
  `sha256("doorbuster member v1:" + key + ":" + sale id)`.
- **One versioned document**; every change moves `v`. Phones poll every 5
  seconds **while the page is visible and a sale is on screen**;
  `?since=v` answers `{same: true}`.
- **One door for every change**: `POST /api/s/:id/act {action}` ->
  `Core.act(doc, mid, action, {now, ids, today})` inside a transaction,
  which returns exactly the keys to set or delete (`items.<id>`,
  `deals.<id>`, `tally.<id>`, `taps.<mid>.<id>`, the details). The example
  on the page runs the same function.
- A deal with sales counted keeps its shape (kind, items, N and M): its
  numbers can change, its shape cannot - remove it and add a new one.
- **Before joining**, a code shows the shop, the sale's name, its days and
  how many are in - no item, no price, no other name.
- **The same 404, word for word**, for an unknown id, a malformed one, one
  that expired and one that is not yours.
- **Expiry on read: 30 days** after the last day (`Core.expired`), by id or
  by code. No timer; the owner can delete it at once.

### Privacy

No email address, no phone number and nothing about a customer is collected
from anyone, held in code: every text field passes `Core.refuse` (an @ of
any width, a link, seven digits in a row in any script, markup - refused
with a reason). Names are first names and a shop's name. The store holds
sales and the accounts' lists and nothing else (tested: no browser key, no
account id, no email, no price list).

### Limits (per instance, in memory: they slow a script, not a determined one)

20 people, 40 items and 20 deals a sale (refused, never cut); 10 new sales
and 40 new members per address an hour; 30 distinct wrong codes or ids per
address in 15 minutes; 1,800 writes per address and 600 per member in 10
minutes (a busy till taps a lot); bodies 16 KB (the metered route 9 MB,
after its gates).

## Signed in (free): the other phone

`POST /api/s/:id/keep` writes `members.<mid>.owner` = an HMAC of the account
id AND the sale id ("doorbuster seat v1") and adds the sale to `mine/<tag>`
(`{s: {<id>: {shop, title, from, to, at}}}`, the tag an HMAC of the account
id, "doorbuster owner v1"; 30 kept). The owner's other phone is the owner;
a staff member's is still staff. Never the account id or the email in
Doorbuster's own store.

## The AI: one call, behind the usual gates (Baste's pattern)

`POST /api/read`: `identity.requireUser`, `requireBudget`, `requireDailyCap`
-> the 9 MB parser -> `ai.brief` (a 400 here costs nothing: text OR one
image, sniffed by its bytes) -> the lab's guard
(`global.LAB_AI_GUARD.allow({provider: 'claude', req, app: 'doorbuster'})`;
a no is its message plus "Typing the items in still works.") -> ONE
`messages.create` with the forced tool `record_items` -> the guard's
`record` with `priceUsd` in a `finally` (not for a member's own key). Free
tier Haiku, members Sonnet, by `identity.planFor`. Claude only.

- **A draft, never a save**: up to 20 `{name, price, cost}` rows (cents; a
  price or cost that was not printed is `null`) go into a sheet the owner
  checks, fixes and ticks before anything is added - with "usually sold" at
  0, which they then type.
- **Nothing of the list is kept or logged.** The tool has no free-text
  field but an item's name; only known fields are read; `Core.cleanDrafts`
  bounds every price and drops a name with an @, a link, digits or markup
  (nothing usable -> 422).
- A provider's own words never reach the page (502, or 503 when busy).
- The stand-in (`DOORBUSTER_FAKE_AI`) reads one item a line ("Soy candle
  22.00 10.00"); triggers BLANK, INJECT, MAXTOKENS, UPSTREAMnnn.
- **Nothing else uses a model**: every sum, verdict, suggestion and sign is
  rules, so they are free, instant and the same on every phone.

## Offline

`public/sw.js` (network first, this app's own files only, never `api/`)
plus the last copy of the sale in `doorbuster-last-v1`: once loaded, the
page opens with no signal and the deals, the signs and the last counts are
there. **Taps on the tally need the network and are not queued** for later
- the ribbon and the Today tab say so, and a failed tap says "You look
offline".

## The look

The lab's house style (the HOA Desk rules; `public/app.css` opens with
them): a pure white page (true black in the dark theme), hairlines, system
fonts, one accent - a violet, `#8f00c2` where it carries text on white
(`#dca6ff` in the dark theme), the lab card's `#c009f9` as the brand dot.
Status colours only beside a word. On phones a floating pill (Today, Deals,
Items, Signs, Team); from 900px the same five in the header. Sheets are
bottom sheets on phones and dialogs from 900px. Motion only inside
`prefers-reduced-motion: no-preference`. No style attribute anywhere: a
person's colour is a class, a bar's width is a class (`.p0`-`.p20`,
twentieths). Money and counts are tabular. The +1 is 88px tall. Signs print
one to a page through `@media print`.

## On the phone

`doorbuster-list-v1`, `doorbuster-prefs-v1`, `doorbuster-last-v1` in
localStorage through `public/doorbuster-store.js` only; every access
wrapped, memory as the fallback. A staff phone's last copy has no costs in
it: it was never sent any.

## The decisions that matter

- **One rules file, run three times.** `public/doorbuster-core.js` is UMD.
- **Whole cents everywhere**, and every rounding in the direction that
  keeps the claim true.
- **Every "usual" is the owner's own number**, so every result is called an
  estimate, on the page, next to the number.
- **The cost never leaves the server for a staff phone.**
- Queries are single-field equality (`code ==`): no composite index.

## Local run and tests

```
npm run dev     # memory store + stand-in model, at http://localhost:8185/doorbuster/
npm test        # the rules first, then end to end over HTTP under a /doorbuster mount
```

`DOORBUSTER_MEMORY=1` and `DOORBUSTER_FAKE_AI=1` both **throw on Cloud
Run**. `npm test` runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0` like every lab
app. `test/run.js` (43 tests): money; a sale's details; an item; a deal;
each shape's arithmetic by hand (percent, amount and endings, multi-buy,
bundle, spend and save); loss leaders; each goal's verdict; the flags; the
kinder shapes; the sign's words; the tally and stock; the bar and the pace
line; the wrap-up; apply and undo; the one door; what each phone is shown
and the 30-day expiry; the example; text; storage; contrast and the lab
card; the page's promises; the copy; the local switches; and over HTTP:
signed out, cross-site writes, starting and joining, building a sale,
**staff never receive a cost**, many phones tallying at once, the stock at
the counter, leaving and removing, the same 404 and expiry, the limiters,
hostile input, the account on a second phone, the price-list read, what the
model sends back, the gates and the guard, and what the store holds.

The shared files (`lib/identity.js`, `identity-store.js`, `byok.js`,
`stripe.js`, `webauthn.js`; `public/passkey-client.js`, `verify-banner.js`)
are synced copies - edit them in `eriks-projects/shared/`.

## Routes

Public: `GET /api/health`, `/healthz`, `/api/me`, `/sw.js`, the page. No
account: `POST /api/sales`, `GET|POST /api/join/:code`, `GET /api/s/:id`
(`?since=v`), `POST /api/s/:id/act`, `DELETE /api/s/:id/members/:mid`,
`DELETE /api/s/:id/me`, `DELETE /api/s/:id`. Signed in: `GET /api/mine`,
`POST /api/s/:id/keep`, `DELETE /api/mine/:id`. Signed in and metered:
`POST /api/read`. The shared account at `/api/auth`.

## What is deliberately not built

- A till: no takings, no receipts, no card payments, no per-day or
  per-hour sales history - the tally is a count per deal.
- Forecasts or demand curves: the app never guesses how many more a deal
  will sell. It says how many it NEEDS.
- A queue of offline taps; push or sound; a customer list, loyalty or
  coupons with codes; tax; a second model call; designed sign templates
  with images.
- Legal advice about reference prices or anything else: one plain line,
  and a question the owner answers.
- A per-deal custom name, and changing the shape of a deal that has sales
  counted.

## Security

A script CSP on every page; no inline `<script>`, `on*=` or `style=`;
clicks by one `data-act` listener. Every non-GET `/api/*` outside the
shared account refuses another site's request (403) and a body that is not
JSON (415). Every name is untrusted: cleaned in the core, escaped on
render. `Referrer-Policy: no-referrer` and `noindex` on the sale APIs;
codes travel in fragments only. Only the app's own errors reach the page in
their words. What a phone sends beyond an action's own fields (an owner
flag, a count, an undo) is never read.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
