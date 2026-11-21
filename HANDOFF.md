# Handoff: the Challenge Lab (written 2026-11-21)

For a fresh session picking up the daily Challenge Lab work in this repo.
Read this, then `CLAUDE.md` (root) and `challenge/CLAUDE.md`, which hold
the full rules. This file is a snapshot, not a second rulebook: where they
disagree, the CLAUDE.md files win, except for the hold below, which is
Erik's current instruction.

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
  - this file.
- **In progress**: **Rush, drop #62** (2026-11-21, business), a rebuild,
  in `challenge/apps/rush/`. Its builder finished (own suite 30/30; full
  suite exit 0, 62 apps, 2,165 tests) after hitting the account's usage
  limit twice; it was not yet reviewed or committed when this was written.
  Next: review, ledger row, TOKENS row, commit, push the working branch.

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
69 minutes. **On the working branch; not deployed.**

## Open decisions waiting on Erik

1. **Rebuilding the eight lost apps.** On 2026-11-21 Erik answered in the
   build session: rebuild them, one a day, each taking that day's slot on
   the business/everyday alternation (queue in `challenge/CLAUDE.md`);
   Rush first. A later request listed the choice as all, just Snug and
   Rush, or none - confirm with Erik which stands before the next rebuild.
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
