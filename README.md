# Erik's Projects

Landing/hub page for `strongtechnicalconsulting.com`, and the source for the
service behind it. It started as static HTML in a GCS bucket (replacing the
old 2019 Bootstrap consulting template that used to live at the root domain);
it is now the `landing-page` Cloud Run service — `server.js`, a small Express
app serving `site/` — because a bucket cannot serve HTTPS on a custom domain.
It still scales to zero, and the bucket is kept only as a rollback.

The page is `site/index.html`: a short intro about Erik (photo and bio
brought over from the 2019 consulting site archived in the bucket), a banner
for the Challenge that names the lab's latest drop live, the project cards,
the blog signup, and contact links. Add a card whenever something new ships.
Currently linked: the College Football app, Hopscotch (craft beer passport),
Trip Planner, DataViz, Friction and Spellbook, plus a "Next up" card for the
Challenge. Each of the six has a live phone preview in the strip above the
cards; keep the strip and the cards in the same order.

The cards can carry "N views this week", and a clear leader a "Trending"
badge, from a first-party counter on this service (`lib/views.js`, fed by
`shared/beacon.js` in every app). A framed preview or a `?tour=` page is not
counted as a view.

Under the Challenge banner, "Live now" (`GET /api/activity`,
`lib/activity.js`) says what is happening across the apps: opens in the last
15 minutes or hour, people today, a new lab drop, a new Keep leader, and
Friction's strongest spike this week (its public `/api/spikes`, optional).
The banner itself carries the lab's Keep or kill top three from the same
call. It is app-level only - no person, no timestamp, and no count under two
- cached 15 s on the server, and polled every 30 s by the page only while the
tab is visible. The private family app is not tracked and never named.
`LAB_URL` and `FRICTION_URL` override where it reads from (for local runs).

Read "Settled decisions" in `DEPLOY.md` before adding a card for anything
not listed above.

The apex is the one address. `www.` answers every page with a 301 to the
same path on the apex. Served on `www.` directly instead: `/api/*` (every
app's view beacon posts there), anything but GET and HEAD, `/robots.txt` and
`/.well-known/*` (and `/healthz`, locally and in CI only — Cloud Run's edge
answers it in production). `/robots.txt` on the apex and on `www.` points at
the apex's `/sitemap.xml` and `/feed.xml`; `www./sitemap.xml` 301s to the
apex; `acct.` has no sitemap and disallows everything. Text goes out gzip- or brotli-compressed; HTML, CSS and JS cache for
five minutes, images and fonts under `/assets` for a week, so a changed image
gets a new file name. See "One canonical host" in `DEPLOY.md`.

It is no longer only a landing page:

- `/writing` is a small blog with an email newsletter attached, written from
  `/admin` on a phone with Claude helping. See "Writing and the newsletter" in
  `DEPLOY.md` for what it needs to run.
- `/admin` is Erik's overview — access requests, app health, spend and
  accounts — and `/admin/views` has the view counts behind the cards.
- `acct.strongtechnicalconsulting.com` is the page for the shared account
  every app signs in with, a domain mapping onto this same service.
- `/challenge` is a teaser for the Challenge Lab. The lab itself is
  `challenge/`, its own service at `challenge.strongtechnicalconsulting.com`:
  one service, one database and one runtime account hosting every trial app
  at `/<slug>/`, with a new app every day from a scheduled Claude Code
  routine. `challenge/CLAUDE.md` is its guide, and `challenge/TOKENS.md`
  records what each app cost to build.
- `apps/friction` and `apps/dataviz` are two apps that live here rather than
  in repos of their own.
- `shared/` holds the modules every app carries a copy of (the shared
  account, the view beacon, the preview tour and more).
  `node scripts/sync-shared.js` copies them out; `--check` fails CI when a
  copy has drifted.

`npm test` runs every suite in `test/`. `PORT=8080 node server.js` runs the
site locally on an in-memory store.

See `DEPLOY.md` for the shared GCP project details and the full deploy runbook
covering every app on this domain.
