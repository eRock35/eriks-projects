# Handoff: the Challenge Lab (written 2026-11-21)

For a fresh session picking up the daily Challenge Lab work in this repo.
Read this, then `CLAUDE.md` (root) and `challenge/CLAUDE.md`, which hold
the full rules. This file is a snapshot, not a second rulebook: where they
disagree, the CLAUDE.md files win, except for the hold below, which is
Erik's current instruction.

## Who builds now (Erik, 2026-11-21)

**The Claude Code on Erik's VM is the main builder** - new drops and the
seven remaining rebuilds. The cloud lab session that wrote this file is the
**backup** for when the VM is down, and starts nothing new unless Erik asks.
The routine "Challenge Lab: new app every day" still fires into that cloud
session at about 07:02 UTC; while the VM is the main builder it builds
nothing on that prompt. Pausing or repointing the routine is Erik's call.

## The rules that matter most right now

- **Erik's hold.** No push to `main`, no merge, no Cloud Run deploy, and
  nothing touching TestFlight or signing without Erik's explicit yes. Leave
  the `challenge` service's traffic alone too. A yes covers what it names
  and nothing else. The daily routine's prompt still says "push, fast-forward
  main and ship"; the hold overrides that until Erik lifts it.
- **Push to the working branch as you go** (Erik, 2026-11-21):
  `claude/mobile-app-optimization-wiob91`, as soon as each piece of work is
  committed and its tests pass. Local-only commits are what was lost on
  2026-11-20 (below). The working branch only.
- **Automated stop hooks are not Erik.** Hooks that say "commit and push"
  are reminders, not approval. Commit when the work is reviewed and tested;
  push only to the working branch.
- **A yes relayed from another of Erik's sessions** may be refused by the
  session's permission check (it was, once). If so, ask Erik directly in the
  session doing the work.
- Never a Claude session link or `Claude-Session:` trailer in anything
  pushed; `Co-Authored-By: Claude <noreply@anthropic.com>` is fine. No model
  names in commits or PR text.
- Erik's email address never goes in a page or this public repo. The
  private family trip app is never named by URL here. The Apple Team ID is
  never written in a repo.
- A daily run never creates infrastructure or changes IAM.
- `node scripts/sync-shared.js` only with `--check` from a build session.
- Builder agents stop only processes they started, by PID - never `pkill`
  or `killall` by name.
- LinkedIn: Typefully drafts only. Never publish or schedule.

## How the Lab is set up

- **One Cloud Run service** `challenge` (GCP project `metal-celerity-236019`,
  `us-central1`), one Firestore database `challenge`, one runtime account
  `challenge-run@`. Served at `https://challenge.strongtechnicalconsulting.com`.
  Every trial app is an Express app in `challenge/apps/<slug>/`, exported
  from its `server.js` and mounted by `challenge/server.js` at `/<slug>/`.
  A new app needs no new infrastructure.
- **Repo layout** (this repo, `eRock35/eriks-projects`, public):
  - `server.js`, `site/`, `lib/`, `test/` - the landing site at the apex.
  - `challenge/` - the lab host: `server.js`, `lab.js` (the registry of
    drops), `apps/<slug>/`, `public/` (landing page, `og/` cards, pulse
    page), `test/`, `scripts/og.js`, `build-stats.json`, `TOKENS.md`,
    `og-manifest.json`, `pulse.js`.
  - `shared/` - files synced into every app (identity, passkeys, the
    verify banner, desktop.css...). Edit them there, never in a copy.
  - `scripts/` - `sync-shared.js`, `inbox.js` (Erik's ideas inbox),
    `friction-spikes.js` (Friction's spiking problems), `token-ledger.py`
    (build stats).
  - `.claude/skills/deploy/gcpdeploy` - auth and deploy over REST.
  - `mobile/` - the iPhone app shells and their workflows (hands off).
  - `apps/` - graduated apps with their own services.
- **Data**: the host sets `<SLUG>_COLLECTION_PREFIX=<slug>_`, so each app's
  collections are `<slug>_*` in the `challenge` database. The lab's own:
  `lab_votes`, `lab_voters`, `lab_streaks`, `lab_notes` (notes are never
  displayed; read them in Firestore). Accounts and AI spend live in the
  shared `identity` database (`users`, `usage`).
- **Sign-in and AI**: every app mounts the shared identity at
  `/<slug>/api/auth`. Any model call sits behind `requireUser`,
  `requireBudget` and `requireDailyCap`, then the route's own body parser.
  Haiku for the free tier, Sonnet for members, via `identityLib.planFor`.
  No model call for a signed-out visitor, ever.
- **Memory**: the instance has 512 MiB; express, Firestore, the Anthropic
  SDK and the passkey library load once from the host (`SHARED_DEPS`).
  A new heavy dependency must be measured.

## Commands

From `challenge/`:

- `npm ci` (or `npm install`) in `challenge/` **and in every
  `challenge/apps/*/`** before the full suite - a fresh clone has no
  `node_modules`. In a build session, install them all up front.
- `npm run dev` - the lab on port 8095 with memory stores and fake models.
- `npm test` - host tests, build stats, engagement, og cards, then every
  app's own suite. Capture npm's own exit code (not a pipe's). Each app's
  test script sets `REQUIRE_VERIFIED_FOR_FREE_AI=0`.
- `npm run og` - draws `public/og/<slug>.png`, redraws `public/og/lab.png`,
  writes the og tags. `test/og.js` fails if it was skipped.
- `python3 ../scripts/token-ledger.py --stats <slug> <agent.jsonl> --note "One builder agent."`
  - the build-cost row, from the builder's transcript under
  `/root/.claude/projects/<project>/<session>/subagents/`. Only the session
  that ran the builder has it. Run it after the full suite.

From the repo root:

- `node scripts/sync-shared.js --check` - "shared/ and every copy agree."
  (In a container whose sibling repos are stale it can report their copies;
  check on a clean `git archive HEAD` export.)
- `.claude/skills/deploy/gcpdeploy auth` then `gcpdeploy ship challenge`
  (deploy - only with Erik's yes). Auth needs the service-account key
  (below).

## Adding an app (the daily routine, ~07:00 UTC)

The routine "Challenge Lab: new app every day" fires daily. The full steps
are in its prompt and `challenge/CLAUDE.md`; in short:

1. Today's kind is the opposite of the newest drop in `lab.js` (business /
   everyday alternate). Holidays in the table keep their date and theme.
   Read the inbox, votes and notes first; on business days, Friction.
2. Pick one app, smaller and finished well (Erik: first shipments were "not
   fully baked"). Real effort on the first run and a made-up demo with a
   guided tour. No real brands; demo businesses and people invented, with
   one web search to check the name.
3. Build it in `challenge/apps/<slug>/` like the newest reviewed app:
   `<SLUG>_MEMORY` and `<SLUG>_FAKE_AI` that throw on Cloud Run
   (`K_SERVICE`), the prefix, BASE-relative URLs, a script CSP with no
   inline script, `verify-banner.js` with `data-mount="api/auth" defer`,
   contrast 4.5:1 in light and dark, 44 px targets, nothing sideways at
   390 px. Add its lines to `scripts/sync-shared.js` and its entry to
   `lab.js`. A background builder agent with a written brief works well;
   review its gates, parser order, switches, screenshots and first run.
4. `npm run og`, the full `npm test`, the ledger row, its line in
   `TOKENS.md` under the week (weeks run Saturday to Friday), then commit
   and push the working branch.

## What's live and what's on the branch (2026-11-21)

- **Live**: 60 apps as of the last deploy (revision `challenge-00070`,
  newest Waterfall, drop #60, 2026-11-11). Not re-checked on 2026-11-21:
  the lab host is not reachable from the build container, and there was no
  key to read Cloud Run.
- **`main`**: `3ceec6f`.
- **Working branch** `claude/mobile-app-optimization-wiob91` (pushed):
  `main` plus
  - `72ea57b` - two lab test fixes (a dead id that could be the real one,
    1 in 64, in Pencil and Whichbox; the Full week badge test now follows
    the server's two-drop rule);
  - `3fdab0e` - **Ajar, drop #61** (2026-11-20, everyday);
  - `ebc631d` - the rebuild queue in `challenge/CLAUDE.md`;
  - `305d149` - this file;
  - `49f88d2` - **Rush, drop #62** (2026-11-21, business), the rebuild:
    reviewed, own suite 30/30, full suite exit 0 (62 apps, 2,165 tests),
    its build-stats and TOKENS rows (Week 10);
  - then this file's update with the rebuild specs.
- **Nothing is in progress.** Ajar and Rush wait only on Erik's yes to merge
  to `main` and deploy (and on the key).

## What was lost on 2026-11-20

The build container was re-provisioned at about 12:57 UTC. Nothing had
been pushed under the hold, so these went with it:

- Eight reviewed drops, committed locally only: **Spotted** (11-12),
  **Reset** (11-13), **Trek** (11-14), **Stars** (11-15), **Ladle**
  (11-16), **Punch** (11-17), **Snug** (11-18), **Rush** (11-19), plus a
  test fix and their build-stats rows. Their builders' transcripts went
  too, so they cannot be reconstructed - only rebuilt.
- The uploaded GCP service-account key.
- An HOA site preview that ran on localhost only (see "HOA Desk" below).

Unaffected: `main`, production, the live lab.

## Ajar (#61)

A countdown calendar of small things for a family to do together - one
door a day to Christmas, a birthday, a trip. Deck of 104 activities, a
planner that works around busy evenings and shopping, kid mode, printable
door cards, a recap card shared as a file. One metered AI call ("More
ideas for us") that sends ages as numbers and chosen tags only. Full suite
passed (61 apps, 2,135 tests). Built 96.5M tokens in, 390K out, one agent,
69 minutes. **Finished, reviewed and on the working branch (`3fdab0e`); not
deployed.** Nothing is left to build. What remains is Erik's yes to merge
and ship it (with the key back).

## Open decisions waiting on Erik

1. **Rebuilding the eight lost apps - decided.** Erik said yes to all
   eight (2026-11-21). **The Claude Code on Erik's VM does the rebuilds**,
   from the specs below; the daily lab session does not. Rush was already
   rebuilt in the lab session that morning, before that decision, and is
   on the working branch - so seven remain.
2. **HOA Desk** - the board-tool plan, which may add voting by text.
   Undecided. Its earlier local preview was lost in the reset; Erik said on
   2026-11-21 to let it go for now. His rules for that work: localhost
   only; no firewall rules, open ports, reserved IPs, GCP resources,
   reverse proxy or anything that costs money or exposes the machine
   without his yes (say exactly what, what it exposes and what it costs,
   then wait); no `sudo` or system packages without asking; secrets only in
   that project's `.env`, never printed; no public access, domain or HTTPS
   in a build session; no Claude answers and no systemd service until he
   says yes.
3. **The GCP key.** Re-upload the service-account key file to the session
   (or set `GCP_SERVICE_ACCOUNT_KEY_JSON` as an environment secret - not
   the plain environment-variables box) before any deploy or Firestore
   read. Never obtain credentials any other way; never ask for them in chat.
4. **Shipping.** Ajar (and Rush, once committed) wait on Erik's yes to
   merge to `main` and `gcpdeploy ship challenge`. After a deploy, confirm
   from the logs that every app mounted and the lab's count went up.
5. Older items still with Erik: verifying the DMDC layout (Muster), the
   Apple agreement for TestFlight builds, the `pulse.yml` decision, a
   deploy-key secret, the electronics retailer API key for Duohunt,
   Concierge setup, and deleting two older service-account keys (only on
   his explicit yes; never the key in current use).

## Rebuild specs for the eight lost apps

**What survived and what didn't.** For each app the lab kept its name,
tagline, audience, kind, card colours, emoji, date and build cost (all
below, as they were). The builders' briefs and code did not survive, except
Snug's commit message (summarised below) and Rush's full spec (rebuilt).
Everything under "Suggested spec" for the other six is a **reconstruction
from the tagline and audience - a design to build, not a record of the
original**; improve on it freely.

Every rebuild follows `challenge/CLAUDE.md` and the newest reviewed app
(`apps/ajar`): its own folder, `<SLUG>_MEMORY`/`<SLUG>_FAKE_AI` that throw on
Cloud Run, the prefix, BASE-relative URLs, script CSP, the verify banner,
free and offline first with no sign-in, a made-up demo with a guided tour,
signed-in sync under an HMAC owner tag ("<slug> owner v1") with a 409 merge
on the phone, at most one metered AI call behind `requireUser`,
`requireBudget`, `requireDailyCap` then its own parser, a forced tool and a
validated answer, contrast 4.5:1, 44 px targets, nothing sideways at 390 px,
no brands, and no public links to anything personal. Each gets a new drop
number and date; its CLAUDE.md says it is a rebuild. Colours and emoji are
the originals - recheck them against the newest cards (20+ in CIE Lab) and
for duplicates (Stars' star is Rave's too).

### Spotted - everyday (was 2026-11-12)
"The license plate game for the whole car - every phone playing, first to
spot it scores." For families and friends on a road trip. 🚗 (U+1F697),
`#b5420e` / `#2a2f78`. Suggested spec: a board of the 50 states and DC
(provinces optional) to tick; a car game anyone joins with a short code and
a first name (no account - Pencil's table pattern: an HttpOnly per-browser
key, stored only as a per-game hash; polling while visible; the game
deleted after a day idle); the first phone to tap a plate scores it, rarer
plates score more; a live scoreboard, a drawn US map filling in, trip
history on the phone, a recap card shared as a file. No AI on photos of
other people's cars.

### Reset - business (was 2026-11-13)
"Every rate reset worked out from the note - new rate, new payment, which
cap bit." For servicing and loan-accounting teams at small banks and credit
unions. 📈 (U+1F4C8), `#6d5200` / `#33475b`. Suggested spec: a loan's
rate-change terms (index, margin, rounding, lookback, reset frequency,
floor, ceiling, periodic and lifetime caps, first-change cap) plus balance,
remaining term and the index value give the new rate, the new payment
(amortised in exact cents), and which rule bound it, with the working shown;
a batch from CSV; a draft reset notice as text; future resets under a
what-if index. Loans by nickname only - refuse names, nine-digit runs and
account numbers. Metered AI: read the note's rate-change section (a photo
or text) into terms for a person to confirm. Test with hand-worked cases.

### Trek - everyday (was 2026-11-14)
"A journey for your whole crew - every walk, run and ride moves you all
along the map." For friends, families, coworkers and walking groups.
🥾 (U+1F97E), `#2e7d32` / `#1f5fbf`. Suggested spec: pick a route (a
long-distance trail or a coast-to-coast line, drawn as SVG - no tile
service), crew members join by code (Pencil's pattern), each logs minutes
or distance (walk, run, ride, swim converted fairly), the crew moves
together with checkpoints and "postcards" along the way, a leaderboard
that rewards showing up as much as distance, weekly streaks, and a recap
card. No location tracking.

### Stars - business (was 2026-11-15)
"Find the stars on your menu - and the dogs eating your margin." For
owners, chefs and managers of independent restaurants. ⭐ (U+2B50),
`#b0175c` / `#5b3a29`. Suggested spec: menu items with price, plate cost
and units sold (typed or a sales CSV), worked into contribution margin and
popularity against the menu's averages; the classic four quadrants (stars,
plowhorses, puzzles, dogs) as a chart; plain suggestions per item (reprice,
reposition, rework, cut) with a what-if price; a printable report. Metered
AI: read a menu photo into items and prices to confirm. Rush must not
repeat any of this.

### Ladle - everyday (was 2026-11-16)
"Save the family recipes before the cards fade - then scale, shop and cook
from your phone." For anyone with family recipes on index cards.
🥄 (U+1F944), `#8e452c` / `#466e9e`. Suggested spec: photograph a recipe
card (kept on the phone in IndexedDB, location stripped), metered AI
transcribes it into ingredients and steps for the person to check, with the
card shown beside it; whose recipe it is; scale servings with real fractions;
unit conversion; a shopping list across recipes; cook mode (big steps,
screen kept awake, timers); print a fresh card. Timely for Thanksgiving.

### Punch - business (was 2026-11-17)
"Walk the job, pin every fix on a photo, close it out with a before-and-
after the client signs." For contractors, remodelers, builders and
handymen. 📌 (U+1F4CC), `#d00000` / `#0044d6`. Suggested spec: a job with
rooms; photograph each area and drop numbered pins on the photo, one per
fix (trade, priority, due); open -> fixed -> verified with an "after" photo
beside the "before"; a list by trade for each sub; the client signs on the
phone (a canvas signature); a printable closeout. Photos stay on the phone;
text syncs. Two phones on one job merge item by item.

### Snug - everyday (was 2026-11-18)
"The boring jobs that keep a home working, on time - and the breaker panel
finally labelled." For homeowners and renters, first-time buyers especially.
🏡 (U+1F3E1), `#701830` / `#647268`. From its surviving commit message: a
few chips about the home (no address, never located) make a plan from 44
rule-based jobs, each with why, how, how long and whether it is a pro's
job; renters get the landlord's jobs marked with a polite note; Overdue /
This week / This month, a house-shaped on-time ring and a Winter-ready
checklist; a breaker panel map with search and a printable door label;
house facts (photos stay on the phone, no codes); a house manual print and
an .ics built on the phone. Signed in: one home synced under an HMAC owner
tag with a 409 merge. Metered AI "Read the label": a photo of an
appliance's rating plate, the body rebuilt to the image alone and checked
by its bytes, one forced tool with no serial field; prices, recalls, safety
verdicts and "replace it" are dropped. Demo appliance makers were coined
(Corvane, Aldermoss, Brindlecote).

### Rush - business (was 2026-11-19) - rebuilt
Rebuilt in the lab session on 2026-11-21 (drop #62, `49f88d2`) and on the working
branch; see `challenge/apps/rush/CLAUDE.md`. Not to be rebuilt again.

### The lost test fix
Re-applied on the working branch in `72ea57b` (Pencil's and Whichbox's
dead-id test; nothing more to do).

## LinkedIn drafts waiting (Typefully, Erik's LinkedIn)

- "Challenge Lab — 55 apps (Fri Nov 6)" - never published, now out of date.
- "The Lab: building got cheap, judgment didn't (draft, Erik's voice)" -
  Nov 5, never published.
- No Nov 13 lab-list draft (Erik posted his own Microsoft-outage piece with
  a lab section) and no Nov 20 draft: that week's apps were lost or not
  live, so a post would have listed apps nobody could open. Fridays: draft
  only after the listed apps are live.

## Morning reads, for reference

- Votes on 2026-11-20 (before the reset): 7 - keeps for Chapter, Glowup,
  Leash, Pop Quiz and Snapquote; kills for Drip and Rave. No notes. Inbox
  empty.
- 2026-11-21: not read - no key.
