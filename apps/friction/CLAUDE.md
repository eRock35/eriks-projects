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

## Sources, and the licensing trap

**Hacker News** via the Algolia API: free, keyless, public, no platform risk.

**Reddit** via the public `.json` endpoints. Read this before building on it:
GummySearch - the leader in exactly this category - shut down on 2025-11-30
because it could not obtain a Reddit **commercial** API licence. One person
reading public JSON for their own research is a different thing from selling
access to it. So Reddit is isolated behind `ENABLE_REDDIT`, every item records
its `source`, and **if this app is ever sold to anyone, Reddit must be
licensed or dropped.** Do not quietly widen its use.

Be a good citizen: `lib/sources.js` sleeps 1.1s between Reddit requests. Do
not remove that to make scans faster.

## One lens per run, round robin

Six lenses x four subreddits x six phrases would be 144 rate-limited requests
in one HTTP handler, which does not fit a request timeout. So a run scans the
single stalest lens (`pickNext`, ordered by `lastScannedAt`) and the Cloud
Scheduler job fires every 4 hours - six lenses, so each comes round about once
a day. `scope=all` exists for manual use and will be slow.

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
- Cloud Scheduler job `friction-scan`, every 4 hours, POSTing
  `/api/cron/scan` with `X-Cron-Key`.
