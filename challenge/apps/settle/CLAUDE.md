# For Claude: Settle

Where are we eating? Settle it in a minute - everyone swipes, nobody argues.
For friends, couples, families and housemates stuck in the group-chat loop
of "I don't mind, what do you want?" - dinner, a takeaway, a movie, the
weekend plan, a holiday, a board game, a baby-name shortlist. One person
types a question and some options (or picks a built-in deck), drops one link
in the chat, and everyone swipes **Yes / No / Love** on their own phone - no
app, no account. The first thing everyone said yes to is **a match**; a tie
goes to a **spinning wheel** that lands the same way on every phone.

Built 2026-10-14 as an **everyday** drop: Triage (2026-10-13) was a business
one, so today was the other kind. A free pick from ordinary life (friends,
family, time) - not from the inbox, not a holiday. Not a repeat: Pickup
organises who plays, Dibs splits a bill, Inside Joke and Flight are games;
nothing in the lab or the portfolio decides between options as a group.
**Staging only**: no custom domain until Erik decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab - `challenge/apps/settle`,
served at `challenge.strongtechnicalconsulting.com/settle/` once it has a
`lab.js` entry, data in `settle_*` collections of the lab's `challenge`
database, deployed with `gcpdeploy ship challenge`. See `challenge/CLAUDE.md`
for mounting, prefixes and graduation. Every browser URL is relative to
`BASE`; keep it that way.

## Why it exists

Every group chat has the same ten-minute loop: someone asks where to eat,
four people say "anything's fine", one says "not sushi", and nothing is
decided until the hungriest person books something. Polls in chat apps are
one option per tap and show the running tally, so the first two votes steer
the rest. Settle is the one link someone drops instead: everyone answers
privately, in about thirty seconds, and the answer is what the group
actually likes - including "everyone was fine with tacos", which nobody
would have said out loud.

**Who pays.** Almost nobody. The demo, the decks, typing options, starting a
decision, joining, swiping, ranking, vetoes, the reveal, the runoff, the
wheel and "settle another" are free, need no account, and make no model
call. The one metered thing is **"Fill the deck for me"** (Haiku for the
free tier, Sonnet for members via `identity.planFor`; Gemini Flash Lite once
`SETTLE_AI_PROVIDER=gemini` is set), about a cent, and only the creator needs
to be signed in for it. Voters never sign in.

**How it becomes an iPhone app.** It already is one in shape: a card stack,
three thumb buttons, a share sheet. The obvious next steps are an App Clip
from the QR code (joiners install nothing), an iMessage extension that
posts the card into the thread, and haptics on the match.

## The decisions that matter

- **One rules file, run three times.** `public/settle-core.js` is UMD
  (`window.SettleCore` in the page, `require` in the server and tests):
  cleaning, the decks, a decision, swipes, top 3s, vetoes, closing, both
  result rules, the wheel, the member's view (`memberView`), the share lines
  and the demo. The server checks and stores; the page draws the demo and
  every real decision with the very same functions; the tests check one file.
- **Swipe: a match is unanimous.** Each option gets Yes / No / Love from each
  voter; Love counts double in a score (Yes 1, Love 2, No 0 - objecting is
  what the veto is for). A **match** is an option every voter who has voted
  said Yes or Love to; someone who stopped halfway has not said yes, so they
  block a match on what they never saw (honest, and the page says how many
  have finished). The winner is the **best-loved match** - "first" in the
  brief, read as "first by how much the group wants it" rather than by the
  order the creator typed, which would be arbitrary. With no match, the top
  score wins, ties shown as shared places (1, 2, 2, 4; then fewer Nos, then
  the list's order). A tie at the top - two matches level, or two top
  scores - goes to the wheel.
- **Rank: instant runoff, said in words.** Each voter orders a top 3 (1-3
  options). Each ballot counts for its highest choice still in; more than
  half of the ballots still counting wins; otherwise the fewest goes out and
  its ballots move on - or run out ("exhausted", and stop counting toward
  the half). A tie for fewest goes out by fewer points (3/2/1 over all
  ballots = fewer 2nd and 3rd picks), then by the wheel's hash; everyone
  level with three or more left is split by points too; two left level go to
  the wheel. Every round is a sentence: "Round 1: Pizza (2) · Ramen (2) ·
  Thai (1). Thai had the fewest, so Thai's vote moved to Pizza." Counts are
  in brackets because option names can end in numbers ("Paddington 2").
- **The wheel is a hash, never a dice roll.** `spin(id, round, ids)` picks
  `sorted(ids)[fnv(id|round|sorted ids) % n]`: the same on every phone and
  every reload, independent of the order asked, and a new round can land
  differently. The page animates six turns to the chosen slice (4.2 s,
  `transitionend`), or jumps straight there under reduced motion; "Skip to
  the winner" is always offered. Spun wheels are remembered per decision and
  round in `localStorage` so a reload shows the winner. No `Math.random` in
  the core or the page (tested).
- **Vetoes: one each, first come.** On by default for the food decks, off
  otherwise, switchable. A veto removes an option for everyone, at once
  (`vetoed.<option> = voter`). Vetoing an option someone already vetoed
  changes nothing and **the second voter keeps theirs** (`status:
  'already'`). Moving your veto gives the first option back; null takes it
  back; the last option standing cannot go. "Vetoed by someone" unless
  votes are named. No vetoes in a second round (they were spent). The page
  asks for a second tap before vetoing ("Tap again: veto Sushi for
  everyone"), not a `confirm()`.
- **Closing is worked out on read.** Closed when the host taps Reveal, when
  the deadline has passed, or when `max` people ("How many of you?") have
  all finished - `status()` decides on every read, no timer (billed per
  request). A poll with `?since=v` is answered in full once a deadline has
  passed, so phones notice it without anyone writing. Nothing changes after
  close: votes, vetoes and joins answer 409.
- **Hidden until the reveal.** Before the reveal a member's view carries
  their own ballot, who has *finished* (taking part, not a vote) and the
  vetoes - never anyone else's votes, not even for the host. With "show the
  tally as people vote" (`live`) it adds the totals, never who. After the
  reveal, named votes add who said Yes / Love / No and everyone's top 3 (by
  name, never by voter id); anonymous ones stay counts only. Tested over
  HTTP by grepping one member's responses for another's votes.
- **Re-open with the top 3** (host): a second round on the three best (the
  winner first, then by score or points, shown in the list's order); votes
  cleared, vetoes spent, the deadline dropped, the first round kept as a
  line. Fewer than two scored is a 409.
- **Settle another with the same people.** The host's "Settle another" opens
  the form with `?after=<id>`; creating it sets `next: {code, question}` on
  the old decision (only if this browser is its host), and everyone still on
  the old reveal gets a "Next up" strip that joins them with their saved
  name in one tap.
- **The demo** ("Friday dinner?", `DEMO` in the core): 8 options and three
  made-up friends whose votes land as you swipe (Sam after your 2nd card,
  Maya after the 4th, Jordan after the 6th - avatar pops and a toast) and
  the rest once you finish. Between them Ramen, Tacos and Thai are yes all
  round, so what you swipe decides a clean match (Thai has two loves), a
  tie for the wheel, or no match. `max: 4`, so it reveals itself by the real
  closing rule. Every tap works; nothing is saved.
- **The decks** (`DECKS`, free, no model): cuisines (24), takeaway (16),
  date night (18), weekend plans (20), board & party games (20), movie
  genres & moods (20), rainy-day ideas (16), holiday vibes (18), each item
  with an emoji. Picking a deck ticks its first 12 ("about a dozen keeps it
  quick"); the rest are a tap away. Tested: every item survives cleaning
  unchanged, has a clean emoji, no repeats.

### Many phones, one decision (trip-planner's packing lesson)

A decision is one document (`decisions/<id>`) whose voters, ballots, top 3s
and vetoes are maps keyed by voter and option. Every write - a join, a
swipe, a top 3, a veto, close, re-open - goes through `store.transactKeys`:
read the decision inside a transaction, let the core decide, then write
**only the keys it changed** (`ballots.<voter>.<option>`, `ranks.<voter>`,
`vetoed.<option>`, `voters.<voter>`) with Firestore's `update()`. Twelve
phones firing 96 swipes at once keep all 96, and two phones vetoing the
same option at once give one veto and one "already" (`test/run.js` holds
both, and shows the same two writes as a plain read-change-write losing
one). Phones poll `?since=v` every 4 s while visible (one read when nothing
moved), skipping while a card is being dragged.

## Who may do what

- **Everyone is a browser.** An HttpOnly cookie `settle_k` (22 random
  characters, path-scoped to the app) is minted when you start or join; the
  decision keeps only `sha256(key + decision id)` (`keyHash` per voter,
  `hostHash` for the creator), so one phone is unlinkable across decisions.
- **Voters** swipe or rank for themselves, use their own veto, and can
  invite (the code is in their view). **The host** (the creator's browser)
  also reveals, re-opens with the top 3, starts "another" and deletes.
- **A stranger gets the same 404 a missing decision gets** on every route;
  host-only routes are the same 404 to members.
- **Limits** (`lib/decisions.js` LIMITS and `Core.LIMITS`; per instance, in
  memory): 10 new decisions per address an hour, 40 new voters per address
  an hour, 600 writes per address in 10 minutes, 30 **distinct** wrong codes
  or ids per address in 15 minutes (then even the right one waits; one dead
  id polled is not guessing); IPv6 counts by its /64. 30 options, 50
  voters (and `max` if set), labels 60 characters, questions 120, names 24,
  notes 80. A decision nobody has touched in 14 days is deleted by the read
  that finds it. Ids are 16 random base64url characters (96 bits); codes 6
  from 32 unambiguous ones (no I, O, 0, 1), typed however ("abc-def").

## Fill the deck for me (the one model call)

`POST /api/suggest {prompt, have}`: `requireUser, requireBudget,
requireDailyCap` **then** the route's own 16 KB parser (a stranger's body is
never read; tested 401/402/403, never 413), then the input checks (a prompt
with letters, 200 characters) before anything is spent, then one forced tool
`suggest_options` -> `{options: [{label, emoji, note}]}` (8-20). The system
prompt says it has no live data and must never name a restaurant, an
address, a showtime or a price; the sheet says plainly that it suggests
**ideas, not real places, prices or showtimes**. `ai.cleanSuggestions` puts
every option through `Core.cleanOption` (the typed door), drops repeats and
anything already on the list, keeps 20; fewer than 3 is a 422. Shown
ticked, added on tap. The prompt is read once, never stored or logged.
Signed out, the button explains and offers a free account (the prompt is
kept); 402 opens the credit sheet; 403 `verify-email` shows its sentence and
"Send the link again".

### On Gemini Flash Lite, behind `SETTLE_AI_PROVIDER=gemini` (2026-11-23)

Erik's per-app AI plan gives Settle "Gemini (flash-lite): fills the deck of
places from a short description, instantly - a fast, light task". It is built
and **off**: `providerNow()` in `server.js` is `gemini` only when the env var
is exactly `gemini`, read per request; unset or anything else is Claude, as
before. **Switching it on is Erik's call** (a Cloud Run env change; it also
needs Vertex AI enabled for `challenge-run@`, see `challenge/CLAUDE.md` "Lab
AI guard"). `/api/me` reports `ai: 'claude' | 'gemini'`.

- **What it does.** One line in ("cheap tacos near downtown, open late, 4 of
  us"), and `gemini-3.5-flash-lite` (the Lite model the guard prices, $0.30 /
  $2.50 per 1M) returns `{question, cards: [{label, emoji, why}]}` against a
  `responseSchema` (`lib/gemini.js`): the question to put to the group and
  8-12 cards. The answer is `{options, question, cards: true}`.
- **Cards are kinds of places, never places.** Settle has no place data, so
  there is nothing real to pick among and the model is told so. The code does
  not take its word: `cleanDeck` runs every card through `Core.cleanOption`,
  then drops a card whose label carries a link, a handle, a phone-shaped
  number, a street address, a rating, a price or an opening time (`factual`),
  blanks a "why" that carries one, drops a question that does, folds repeats
  and anything already on the list, and keeps 12. The schema has no field
  that could hold a real place's details (tested).
- **The person edits and removes.** The sheet lists the cards as rows: each
  label is an input, each row has a remove button, the dealt question has a
  "Use this as the question" switch (offered only when the form's question is
  empty or a deck's default). Nothing reaches the deck until "Add N cards to
  my deck". The same sheet serves the Claude answer (no question there).
- **Order of a call, both providers:** `requireUser, requireBudget,
  requireDailyCap` -> the 16 KB parser -> the ask checked -> the lab guard's
  `allow({provider, req, app: 'settle'})` (its "no" is sent in its own words,
  429 or 503, and no model is called) -> ONE call -> `guard.record` with
  `guard.priceUsd`. With no guard loaded (the app on its own) Claude works as
  before and Gemini answers only from the stand-in. A member's own Claude key
  is not counted against the lab's cap.
- **Charged to the person too.** The identity ledger prices Claude models
  only, so a Gemini call is written there at its real dollars as the Haiku
  input tokens that cost the same, route `suggest:gemini-3.5-flash-lite`
  (`chargeGemini`, Pawlog's pattern). A call that failed after it billed
  (`err.usage`) is still recorded and charged. Provider errors are a 502 (503
  for busy or a timeout) with the route's own sentence.
- `lib/gemini.js` opens no connection and logs nothing: the call is
  `global.LAB_AI_GUARD.gemini.generate`. The stand-in is `fakeai.gemini`
  (triggers `BLANK`, `INJECT`, `UPSTREAMnnn`; otherwise nine taco-night
  cards). Local: `SETTLE_AI_PROVIDER=gemini npm run dev`.
- **Fallback (2026-11-23)** (`fillGeminiFirst`): any Gemini failure but a
  burst refusal (Vertex error, a deck under `suggestMin` cards, Gemini's
  `monthly-cap`, no helper) runs the Claude path unchanged and answers with
  Claude's plain list (no `question`/`cards`); one log line `[settle] gemini
  failed (<code>); used claude`. `burst-minute`/`burst-day` are sent as is.

## Local run and tests

```
npm run dev     # memory store + fake model, at http://localhost:8131/settle/
npm test        # pure rules first, then end to end over HTTP under a /settle mount
```

`SETTLE_MEMORY=1` and `SETTLE_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE`) - in `lib/store.js`, `lib/fakeai.js` and `server.js`; the tests
spawn each with `K_SERVICE` to prove it. `SETTLE_COLLECTION_PREFIX` (set to
`settle_` by the lab host) prefixes every top-level collection. `npm test`
runs with `REQUIRE_VERIFIED_FOR_FREE_AI=0`. The fake model refuses a call
that does not force a tool. Triggers in the prompt: `BLANK`, `INJECT`,
`MAXTOKENS`, `UPSTREAMnnn`; anything else is ten winter date ideas.

`public/qr.js` is Pickup's copy of the vendored Kazuhiko Arase MIT "QRCode
for JavaScript", only its global renamed to `SettleQR`. The shared files
(`lib/identity.js`, `identity-store.js`, `byok.js`, `stripe.js`,
`webauthn.js`; `public/desktop.css`, `passkey-client.js`,
`verify-banner.js`) are synced copies - edit them in `eriks-projects/shared/`.

## Data (Firestore: `settle_*` in the lab database `challenge`)

- `decisions/<id>` - `{question, mode, opts: [{id, label, emoji, note}],
  active: [oid], vetoes, named, live, deadline, max, round, past: [{round,
  winner, line, top}], closed: {at, why} | null, next: {code, question} |
  null, code, hostHash, createdAt, updatedAt, v, voters: {<vid>: {name,
  host, at, keyHash}}, ballots: {<vid>: {<oid>: yes|no|love}}, ranks:
  {<vid>: [oid]}, vetoed: {<oid>: <vid>}}`.

That is the only collection: no email, no account id, no address, no browser
key (tested: the stored keys are listed exactly). Queries are single-field
equality (`code ==`), so **no composite index**. This phone remembers its
decisions (`settle-recent-v1`), its name (`settle-name-v1`) and the wheels it
has spun (`settle-spun-v1`) in `localStorage`, every access wrapped.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/me`, the page, `d/:id`,
`j/:code`. No account: `POST /api/decisions`, `GET|POST /api/join/:code`.
Members: `GET /api/d/:id[?since=v]`, `PUT /api/d/:id/vote {oid, v}`, `PUT
/api/d/:id/rank {order}`, `PUT /api/d/:id/veto {oid}`. Host: `POST
/api/d/:id/close`, `POST /api/d/:id/reopen`, `DELETE /api/d/:id`. Metered:
`POST /api/suggest`.

## Design (redesigned 2026-11-23, the HOA Desk look)

Erik's brief for every lab app: clean white, Apple-like, lots of space.
`public/app.css` holds the rules at its top; keep them when adding anything.

- **Pure white page** (#FFFFFF; true black in dark, sheets and the swipe card
  on #1c1c1e), 1 px hairlines (#E5E5EA), 12 px cards, 10 px inputs and tiles,
  pill buttons and chips. **Lists over boxes**: the ranking, the runoff, the
  steps, the rank pool and the AI cards are hairline-divided rows; only the
  reveal, the "you're done" panel and the desktop preview are boxed. No
  shadows except a faint one on what floats (nav, sheet, swipe card, toast).
- **One accent**, Settle violet `#6d28d9` from `lab.js` (`#c4b5fd` in dark):
  the primary button, links, the active nav item, a chosen chip. Green, red,
  pink and amber are status only (Yes, No, Love, veto) and always carry
  their word.
- **Type**: the system stack only; five sizes (13, 15, 17, 22 and the big
  heading, `--t-cap` to `--t-big`), tight-tracked headings, tabular numbers
  for counts and tallies. Spacing on 4/8, 40-64 px between sections.
- **Navigation**: one `<nav class="tabs">` inside the header (Home, New,
  Join, Sign in/Account). Phones: a floating translucent pill at the bottom,
  1.5 px line icons, the label only on the current item with a small accent
  mark, safe-area aware. Desktop (900 px+): the same buttons as a top nav
  with a quiet underline. The header's blur is on `.top::before` - a
  backdrop-filter on the header itself would make it the containing block of
  the fixed nav. **While a swipe card is up on a phone the nav steps aside**
  (`body.swiping`), so nothing sits over the three thumb buttons; the brand
  goes home. It does not use the shared `.dk-tabbar` rail.
- **Home** is a centred hero: the headline, one line, "Start a decision" and
  "Try the demo", "Have a code?" under them, then Your decisions and How it
  works as lists.
- **Taps from home**: start a decision 1, the demo 1, join with a code 1,
  re-open a recent decision 1, account 1, fill the deck with AI 2.
- **Motion** (press states, the sheet and view fades, cards dealing in, the
  card flying off, the wheel, confetti) is all inside `@media
  (prefers-reduced-motion: no-preference)`; every page is complete at rest.
- **No `style=` attribute** in the HTML or written by script (tested). Sizes
  that depend on data (bar widths, confetti) are `data-*` attributes applied
  through the style object by `applyDyn()` after each draw.
- Measured in the browser at 390, 320 and 1440 px, both themes: lowest text
  contrast 4.57:1 light (the Match tag) and 6.43:1 dark; nothing wider than
  the window; every target 44 px or more.

## The page

Swipe by **touch or mouse drag** (pointer events, `touch-action: none` on
the card only; past 100 px right is Yes, left is No, up is Love, with YES /
NOPE / LOVE stamps fading in), by the **buttons** (68 px, each with its
word), or by the **keyboard** (right / left / up arrows; Backspace or down
goes back a card). The card is a focusable group with an `aria-label` that
says what it is and how to answer; outcomes are announced in a live region.
"Back" revisits a card and shows what you said. Rank mode: tap options in
order, reorder by dragging a row or with ↑ / ↓ buttons. The reveal: the
winner pops in under CSS confetti (only the first time this page sees it),
the ranking with bars and Match / Vetoed tags, who loved what when named,
the runoff in words for rank mode, Share / Copy the result line, and for the
host Re-open with the top 3 / Settle another. Motion is off under
`prefers-reduced-motion`. Rendered at 390, 320 and 1440, light and dark.

## What is deliberately not built

- **Live place data** (open now, menus, showtimes, prices): no maps or
  listings API here, and a daily drop adds no keys. The AI suggests ideas
  and says so.
- **Accounts for voters** or "my decisions" across devices: a decision
  follows the browser that made or joined it.
- **Push or reminders**: there is no sender; the share sheet is the channel.
- **Weighted voters, more than one veto, a "maybe" swipe**: each would make
  "everyone said yes" mean less.

## Security

- A script CSP on every page (`script-src 'self'; object-src 'none';
  base-uri 'self'` + `frame-ancestors`); no inline `<script>` or `on*=`,
  handlers by one `data-act` listener (tested here and by
  `challenge/test/lab.js`).
- No model call for a signed-out visitor or any voter; the metered route's
  gates run before its parser.
- Every typed string and every model suggestion is untrusted: cleaned,
  bounded, stripped of markup, control and bidi characters, and escaped on
  render. The wheel's SVG labels are escaped too.
- `d/*`, `j/*`, `/api/d/*`, `/api/join/*` and `/api/decisions` answer with
  `no-referrer` and `noindex`; a code and an id are keys.
- Failures (`fail()`/`failure()`, Receipt's): only the app's own errors reach
  the page in their words; a provider error is a 502 (503 "The AI is busy").
  Nothing logged carries a question, an option, a name or a prompt.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
