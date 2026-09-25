# For Claude: Friction

Reads what people complain about online, scores the complaints as problems,
and keeps a board of the ones worth building. Built for Erik as his own
deal-flow instrument: the point is not to read Reddit, it is to notice which
problems keep coming back.

## Why it lives in `eriks-projects/apps/friction`

It should have its own repo. It does not have one because the GitHub App
installed on this account cannot create repositories - `POST /user/repos`
returns 403 "Resource not accessible by integration". If Erik creates
`eRock35/friction` by hand, moving it is a `git mv` and a one-line change to
`apps.json`; nothing in the code knows where it lives.

`gcpdeploy` resolves an app's source as `$REPO_ROOT/<repo>`, so the registry
entry sets `repo: "eriks-projects/apps/friction"` and packaging picks up this
subdirectory alone. Note that the uncommitted-changes guard still checks the
*whole* `eriks-projects` repo, which is the behaviour you want anyway.

## The design decision that matters: recurrence

A one-shot search tells you what was loud this morning. This runs daily and
**merges** into what it already knows, so a problem seen four times over a
month outranks one that got a lot of upvotes once. That merge is in
`lib/scan.js#upsertSignal` and it must keep two guarantees:

- **Never clobber a decision.** `status` and `notes` are Erik's. A scan
  updates scores, evidence and counts, never those two fields.
- **Never duplicate a row.** The document id is `<lensId>:<slug>`, and the
  model is told to keep slugs stable across batches. A new sighting raises
  `seenCount` and appends evidence, capped at 12 quotes.

`peakScore` is kept alongside `score` so a problem that scored 8 once does not
silently look mediocre because a later batch of weaker evidence scored it 6.

## The pulse: ticker, trend arrows, spikes (2026-09-25)

Recurrence says a problem keeps coming back; the pulse says whether it is
getting *louder*. All of it is `lib/pulse.js`, pure functions with no clock of
their own, tested with a fixed "now" in `test/friction.js`.

- **A sighting is one distinct source item** a scan filed under a problem -
  not a `seenCount` bump. With one lens per day each problem is looked at
  about once a week, so passes-per-week is 0 or 1 and could never spike;
  complaints-per-week can.
- **The weekly rollup lives on the signal**: `weekly: [{week, n}]`, `week`
  the Monday (UTC) it started, newest 12 kept. `upsertSignal` bumps it inside
  the scan request - no aggregate job, no timer. An **array, not a map**:
  Firestore's merge-write deep-merges maps, so a pruned week would never
  leave a map field; an array is replaced whole.
- **Rows from before the rollup** read as a lower bound - one sighting in the
  week first seen, one in the week last seen (`weeklyOf`) - and the next
  scan that touches them starts from that. Inventing a spread for the
  seenCount in between would draw a trend nobody measured.
- **Trend** (`trend`): this week vs last. From nothing it says `new` (first
  seen this week) or `back`; under a base of 3 it is the plain difference
  ("+4"), never "+400%"; only then a percentage. The sparkline is the last 8
  weeks.
- **Spike** (`spikeOf`): this week >= 3x the trailing 4-week average AND at
  least 4 sightings. A baseline under one a week counts as one, so seven from
  nothing is "x7", not Infinity, and still has to clear the floor.
- **The ticker feed** is one document, `control/pulse` - newest 60
  sightings `{at, signalId, title, lensId, lensLabel, itemId, source,
  excerpt (<=160 chars of the evidence quote), url (https only)}` - rewritten
  once at the end of each run. Until a scan writes it, each problem's newest
  quote at its `lastSeenAt` stands in (`fallbackPulse`).
- The pages poll every 45 s **only while visible** (and, on the board, only
  on the Board tab); `visibilitychange` stops the interval. The board poll is
  one document read.
- **Text inks** (`--ink-2`, `--hot-ink`, `--tint-ink`, `--green-ink`,
  `--src-*`) are in both pages' tokens, each checked at >= 4.5:1 on the card
  and on its own tinted chip in light and dark. The system `--red`/`--tint`/
  `--green` are fills; as small text on white they measure 2.2-4:1, which is
  why the existing tags now use the inks too. Everything the pulse draws -
  excerpts included - goes through `esc()`.

### Routes

- `GET /api/pulse` (gated) - the feed with excerpts and links. `no-store`.
- `GET /api/signals` now carries `pulse: {series, trend, spike}` on every row
  and a `spiking` list over every problem not passed, whatever the filter.
- `GET /api/public/pulse` (open) - the feed **reduced**: id, title, lens,
  source and time, and only for problems in the preview's own dozen. No
  excerpt (someone else's words - the reason the preview has no evidence),
  no link to the post, nothing passed. Memoised in-process for 60 s, because
  it polls and reads every signal.
- `GET /api/public/board` gained `id` (an identifier, not content, so the
  strip and `/api/spikes` can point at a card) and the same `pulse` fields.
- `GET /api/spikes` - for people and for the Challenge Lab's daily idea
  step. A **bare array** of `{id, title, summary, sightingsThisWeek,
  baseline, ratio, sources, firstSeen, url, hint}`, biggest ratio first.
  Without credentials it answers only from the preview's dozen (title,
  summary, sources and first-seen are what the preview already shows; the
  rest are counts), cacheable. With a session, an entitled shared account or
  `X-Cron-Key` it answers from the whole board minus what was passed, and is
  `no-store`. A wrong key is not an error - it just gets the public answer.
  `url` is `/preview#<id>` for a preview problem (the preview opens that card)
  and `/#signal=<id>` otherwise (the board opens its sheet). `hint` is a
  keyword template ("Could be an app: a reconciliation tool for ... that
  takes on ...") - **no model call**, and it should stay that way.

All of it is decoration on data the scan already paid for: no new model
calls, no Firestore writes outside the scan. `publicSelection()` in
`server.js` is the one definition of what the public may see; every open
route draws from it.

## Sources, and the licensing trap

**Hacker News** via the Algolia API: free, keyless, public, no platform risk.
It is the workhorse and the only source that needs nothing.

Two things about it, both learned the hard way on the first live run:
Algolia **ANDs every word and has no `OR` operator**, so a lens's `hn` field
is a LIST of short queries run separately. A single string of alternatives
matches nothing and reports no error, which is the worst possible failure
shape. And it is developer-heavy, so it covers `data-eng` and `it-ops` far
better than `back-office` or `lending-ops`.

**Reddit** via the **official OAuth API**, not the public `.json` endpoints.
The anonymous endpoints work from a laptop and return **403 from Cloud Run** -
Reddit blocks datacenter ranges - so the anonymous path was never going to
work for a scheduled job. `redditAuth()` does a client-credentials grant
against a free read-only app registration and talks to `oauth.reddit.com`.

Without `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` the source is skipped and
the run records *why*, rather than silently finding nothing.

The licensing point still stands and matters more now: GummySearch, the
leader in exactly this category, shut down on 2025-11-30 for want of a Reddit
**commercial** licence. A free registration covers personal research. **If
this app is ever sold to anyone, Reddit must be licensed properly or
dropped.** Do not quietly widen its use.

Be a good citizen: `lib/sources.js` sleeps 1.1s between Reddit requests, well
inside the free tier's 100/minute. Do not remove that to make scans faster.

## One lens per run, round robin

Six lenses x four subreddits x six phrases would be 144 rate-limited requests
in one HTTP handler, which does not fit a request timeout. So a run scans the
single stalest lens (`pickNext`, ordered by `lastScannedAt`) and the Cloud
Scheduler job fires **once a day, 06:15 America/New_York** - six lenses, so
each comes round about once a week. It was every 4 hours until 2026-09-21;
that measured ~$0.83/day on Opus (~$25/month), and Erik asked for less. The
recurrence design still works at a week per lens, just slower to confirm a
problem is a pattern. `scope=all` exists for manual use and will be slow.

Do not "fix" this by scanning everything in one run.

## Cost control

Three ceilings, all deliberate:
- `MAX_ITEMS_PER_RUN` (240) caps what one run sends to the model.
- The seen-set in Firestore means yesterday's posts are never paid for twice.
- One lens per run bounds a single invocation.

`SCAN_MODEL` defaults to `claude-opus-5`. Scoring is the whole product, so
this is the one place not to economise by default - the ceilings above are
what keep the bill bounded, not a cheaper model.

## The scoring prompt earns its keep by saying no

A model asked to find opportunities will always find ten. `lib/score.js`
therefore requires corroboration (two items, or one unusually specific), says
explicitly that an empty list is a correct answer, and evidence whose
`itemId` was not in the batch is dropped as fabricated. If you loosen any of
those, the board fills with noise and the scores stop meaning anything.

## Auth

One password, one signed session cookie, 30 days (`lib/auth.js`). There is no
second user to model here, so there is no registration and no reset - if the
password is lost, add a new version to `friction-app-password` and redeploy.

`/api/cron/scan` takes a session **or** the `X-Cron-Key` header. Everything
that spends Anthropic tokens is behind one of those two. Never put a scan
route behind neither.

## Deploy

GCP `metal-celerity-236019`, `us-central1`, same REST pipeline as the sibling
apps (no gcloud, no local Docker) - see `college-football-app/docs/gcp-deployment.md`.

- Cloud Run service `friction`; Firestore database `friction` (Native mode, us-central1).
- Secrets: `friction-app-password`, `friction-session-secret`,
  `friction-cron-secret`. `anthropic-api-key` is the shared one.
- Env: `GOOGLE_CLOUD_PROJECT`, `FIRESTORE_DATABASE_ID=friction`, `ENABLE_REDDIT`,
  `SCAN_MODEL`, `MAX_ITEMS_PER_RUN`.
- Cloud Scheduler job `friction-scan`, daily at 06:15 ET, POSTing
  `/api/cron/scan` with `X-Cron-Key`.
