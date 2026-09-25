# For Claude: Glowup

Give your listing a glow-up — and watch the score climb. An Airbnb or Vrbo
host, an Etsy or eBay seller, or a local service pro (Google Business profile,
Thumbtack) pastes a listing — title, description, tags, price, how many photos
and which shots they have — or snaps a screenshot of it. Glowup scores it
**0–100 like a credit score**, with five rings (Title, Hook, Details, Trust,
Photos) and **a fix for every point lost**, re-scored live as they type. A
model can then **glow it up** — three titles to A/B, a rewritten description,
tags and a photo shot list — and the same rules score the rewrite, so the
before/after is honest. Every save is a version with its score: a sparkline,
an improvement streak, a day streak, and a public **glow-up card** to share.

Built 2026-09-25 as the sixth of Erik's lab drops, after Spar, Snapquote,
Chaser, Rave and Pop Quiz. **Staging only**: no custom domain until Erik
decides it is worth one.

**Where it lives:** a trial app in the Challenge Lab — `challenge/apps/glowup`,
served at `challenge.strongtechnicalconsulting.com/glowup/`, data in
`glowup_*` collections of the lab's `challenge` database, deployed with
`gcpdeploy ship challenge`. See `challenge/CLAUDE.md` for mounting, prefixes
and graduation. Every browser URL is relative to `BASE`; keep it that way.

## Why it exists (the business problem)

A small seller's sales hang on one listing, and that listing was written once,
at 11pm, and never touched: "Cozy cabin!! PERFECT GETAWAY", one 400-character
paragraph, no Wi-Fi speed, eight photos and no bathroom. Nobody tells them
what is wrong. Marketplaces bury weak listings quietly; agencies and "listing
optimisation" services charge per listing; generic AI rewriters happily add a
hot tub the cabin does not have.

Glowup makes the problem visible (a number and five rings), makes each fix
concrete ("Say the Wi-Fi speed in Mbps"), and makes improving it feel like a
game — the dial climbs, a streak builds, and there is a card to show off.

**Who pays.** Sellers who want the rewrite. Scoring, editing, versions and the
share card never call a model and are free forever — which is most of the
value, and costs nothing to serve. A glow-up, a comparison or a screenshot
read is about a cent on Haiku. The membership buys the better model.

**How it becomes an iOS app.** Snap is the share sheet (share a screenshot of
your listing straight from the Airbnb or Etsy app); the streak is a widget;
"your score dropped / a competitor changed" becomes a notification once there
is a sender.

**The honest risk.** The rules measure what a buyer can check — facts,
length, structure, photo coverage — not taste. A listing can score 100 and
still have ugly photos, and search ranking depends on reviews, price and
availability the app never sees. The page says "reads better"; bookings say
"sells better". Glowup also never reads the live listing: no scraping, no
platform login, so the seller pastes updates in by hand.

## The decisions that matter

- **One rules file, run twice.** `public/rules.js` is UMD: the page loads it
  as `window.GlowRules`, the server `require`s it. It holds the platform
  limits, the per-type essentials and shot lists, the score, the sparkline
  and both streaks. The page scores as you type (even signed out); the server
  scores every save and every model answer. They cannot disagree.
- **The model never decides a number.** A glow-up's "after", each title
  option's score and a competitor's score all come from `R.score()`.
- **No invented facts, enforced in code** (`ai.validateGlow`, `guard*`). The
  prompt forbids adding facts and asks for `[add: …]` gaps. Then the guard:
  a sentence, title, tag or shot naming a fact the source never mentions
  (from a list of ~80 amenity/material/claim groups — hot tub, sauna, soy,
  sterling, licensed, 24/7, award-winning…) is removed; a number that is not
  in the source becomes `[add: how many minutes]`. The page lists what was
  taken out and why. "Parking: [add: where]" is a question, not a claim, and
  is kept — a label of three words or fewer in front of a gap.
- **Gaps earn nothing.** Scoring strips `[add: …]` first, and a line that is
  only a label plus a gap goes whole, so "Wi-Fi: [add: speed]" does not earn
  the Wi-Fi point. Unfilled gaps cost up to 2 Trust points. That is why the
  sample goes 41 → 74 (rewrite with gaps) → 88 (gaps filled).
- **Platform limits are data** (`R.PLATFORMS`): Airbnb title 50 / description
  500, Etsy 140 and 13 tags of ≤20, eBay 80, Google description 750 (all
  `hard: true`); Vrbo, Poshmark/Mercari, Thumbtack and "own site" are
  *targets* where search results cut off, and the fix text says so rather
  than claiming a platform rule. Titles from the model are trimmed at a word
  boundary to the limit, or dropped when no boundary fits; over-long Etsy tags
  are dropped (a cut tag is nonsense); descriptions are cut at a line or
  sentence end.
- **Google names are locked.** A Google Business profile's name must be the
  real business name — keyword stuffing gets profiles suspended. The rules
  never ask for search words in it and flag "Name | Best Plumber Near Me"; the
  glow-up returns the name unchanged.
- **A model only proposes.** `POST …/glowup` writes nothing (the tests dump
  the store before and after). The seller picks a title, edits the text —
  still re-scored live — and applies it with an ordinary `PUT`, which saves a
  version marked `glowup`. Snap is the same: a proposal fills the Add form.
- **History is append-only.** Every changed save, applied glow-up and revert
  is a new version; saving identical content is a no-op; going back saves the
  old text as a new version. Past 50, the oldest go — **except version 1**, so
  "before" never moves.
- **Every model call is a forced tool** (`glow_up`, `compare_listings`,
  `read_listing`) behind `requireUser, requireBudget, requireDailyCap`
  (`spend` in `server.js`), and the listing is loaded before the call, so a
  stranger's id 404s and an empty wallet 402s with no model call. Tests count
  usage rows to prove it.
- **The screenshot is read once and kept nowhere.** Shrunk in the browser
  (1600px JPEG), checked by magic number and size before anything is spent
  (`lib/photo.js`, 400), read by the model, dropped. Unreadable → 422. The
  6 MB parser mounts after the gates on that route only; everything else is
  128 KB.
- **The competitor's text is not kept.** A comparison stores their title and
  both scores on your listing; their description goes to the model and is
  dropped. Their Photos ring is estimated from the count they give (we cannot
  see their shots), and the page says so.
- **The card is frozen and minimal.** `POST …/share` snapshots, field by
  field: type, platform, the *current* title, before/after scores and rings,
  the score trail and the number of saves. The description and tags only when
  "include the text" is ticked; never the original title or text, keywords,
  account or ids. One token per listing (22 chars from 16 random bytes);
  Update re-freezes the same link, Revoke deletes it. `/s/*` and
  `/api/shared/*` are GET-only (405 otherwise), `no-store`, `noindex`,
  `no-referrer`; the page is the app itself with `<base href="../">`.
- **No model call for a signed-out visitor.** The demo (`lib/demo.js`: The
  Loon's Nest cabin, Wick & Ember candle, Northfield jacket — all invented)
  runs hand-written rewrites and a comparison through the real validators and
  rules; the tests assert the cabin reads 41 → 88 and the guard removes
  nothing from the samples.
- **Another user gets 404 on everything**, never 403 — listings live under
  `listings/<uid>/items`, so another person's id cannot even be looked up.

### The score

Five categories × 20. Every check says what it looked at and, when it costs
points, exactly what to do.

- **Title (20):** length vs the platform (7: over → 7, under ~45% → 4); a
  search word in it, the first one listed ideally (6); no capitals, no vague
  praise without a number, no !!! (5); tags — all 13 on Etsy, ≥3 elsewhere (2).
- **Hook (20):** first line not a greeting ("Welcome to…") (6); a fact in it —
  a digit, an essential or a search word (5); 25–160 characters (3); a call to
  action anywhere (6).
- **Details (20):** five essentials per type, 2 each (10) — stay: check-in,
  parking, Wi-Fi speed in Mbps, beds, distances; product: materials, size,
  care, shipping, who it's for; resale: condition, flaws, measurements, size,
  shipping/offers; service: area, response time, licensed/insured, pricing,
  hours. Search words in the text (4). Vague adjectives in a sentence with no
  fact, 2 per sentence (4). Numbers in a 200+ character description (2).
- **Trust (20):** doubled words (2), ALL CAPS (3), !! (2), a paragraph over
  350 characters (4), bullets in a long description (2), length vs the type's
  minimum and the platform's maximum (3), a price (2), unfilled gaps (2).
- **Photos (20):** count vs the type (rentals 20, services 10, products and
  resale 8) (10); the five-shot list, 2 each (10).

Grades: 90+ Glowing ✨, 75 Great, 60 Good, 40 Getting there, else Needs a
glow-up.

Models: free tier Haiku 4.5, members Sonnet 5, via `identity.planFor` — the
same split as the siblings. A glow-up is ~1.5k input / ~1k output tokens.

## Local run and tests

```
npm run dev     # memory store + fake model, mounted at http://localhost:8097/glowup/
npm test        # pure rules first, then end to end over HTTP under a /glowup mount
```

`GLOWUP_MEMORY=1` and `GLOWUP_FAKE_AI=1` both **throw on Cloud Run**
(`K_SERVICE` set) — in `lib/store.js`, `lib/fakeai.js` and `server.js`; the
tests spawn each with `K_SERVICE` to prove it. `GLOWUP_COLLECTION_PREFIX` (set
to `glowup_` by the lab host) prefixes every top-level collection; the default
database is `challenge`. The fake model rewrites from the listing's own
sentences and refuses any call that does not force a tool. Triggers: `INJECT`
in a listing adds markup, markdown, an over-long title, an invented hot tub,
a made-up 900 Mbps and junk tags; `EMPTY` returns nothing usable (422); a
screenshot whose bytes contain `BLANK` is unreadable (422).

## Data (Firestore: `glowup_*` in the lab database `challenge`)

- `listings/<uid>/items/<id>` — the current fields (type, platform, title,
  description, tags, keywords, price, photoCount, shots), `score`, `cats`,
  `firstScore`, `bestScore`, `versionCount`, `trail` (last 50 scores, for the
  list's sparklines), `compare` (last comparison: their title and scores, the
  points, the verdict), `shareToken`, `sharedAt`, `shareText`, timestamps.
- `listings/<uid>/items/<id>/versions/v0001…` — `{n, at, day, source
  paste|snap|edit|glowup|revert, fields, score, cats}`; one document each.
- `settings/<uid>` — `improvedDays` (the days a save raised a score; last
  120), which is the day streak.
- `shares/<token>` — `{uid, listingId, createdAt, card}`: the frozen card.

Limits (`lib/listings.js` LIMITS): 200 listings a person, 50 versions a
listing (v1 kept), title 200 characters raw (the platform limit is scored,
not refused), description 6,000, 30 tags of 60, 8 search words of 40, price
40, photos 0–100, competitor text 6,000. JSON bodies 128 KB except the snap
route (6 MB, after the gates; image 4 MB decoded).

Deleting a listing deletes its versions and its share link.

Accounts are the shared identity (`identity` database), mounted at
`/api/auth` — one account and one $2 credit across the lab and every app.

## Routes

Public: `GET /api/health`, `/api/meta`, `/api/demo`, `/api/shared/:token`,
page `s/:token`, and `rules.js` (static). Signed in: `GET /api/me`,
`GET|POST /api/listings`, `GET|PUT|DELETE /api/listings/:id`,
`GET /api/listings/:id/versions/:vid`, `POST /api/listings/:id/revert`,
`POST|DELETE /api/listings/:id/share`, `GET /api/wins`. Metered:
`POST /api/listings/read` (screenshot), `POST /api/listings/:id/glowup`,
`POST /api/listings/:id/compare`.

## Ideas not built yet

- **Title A/B tracking**: log which title was live on which dates next to the
  seller's own booking or sales counts, so "reads better" meets "sold better".
- **Photo check**: upload the photos themselves and tick the shot list
  automatically (brightness, orientation, which room) — a bigger model bill,
  and photos are the sellers' own; decide storage before building.
- **Seasonal refresh**: "It's October — your cabin listing still says
  'summer'." Needs a sender.
- **Bulk import** for Etsy shops with 50 items (their CSV export).
- No beacon/analytics until it has a subdomain and a place in `lib/views.js`.

## Commit and PR conventions

Never put a Claude session link in anything pushed to GitHub. See the repo
root CLAUDE.md.
