# For Claude: this repo

The landing/hub page at the root domain (`strongtechnicalconsulting.com`).
See `README.md` for what is linked from it and `DEPLOY.md` for how it ships.

**This repo is public.** The Santa Rosa Beach trip app is deliberately not
linked here and its hostname must stay out of this repo's files — it holds
family PII. `DEPLOY.md` carries the full reasoning; read it before adding
anything that names that app.

## This repo is the landing page only

`server.js`, `Dockerfile` and `site/` — Cloud Run service `landing-page`. It is
deliberately dependency-light and scales to zero, which is the entire reason it
is affordable on Cloud Run rather than behind a load balancer. **Don't give it a
database client**, a min-instance count, or a warmup; any of those re-introduce
the cost this design avoids.

Spellbook (the prompt library, and the view-analytics backend for every app on
the domain) briefly lived here in `spellbook/` and now has its own repo,
`eRock35/spellbook`. Nothing of it remains except the dependency below.

### The landing page depends on Spellbook, weakly and on purpose

`site/index.html` carries one deferred `<script>` that posts a view beacon to
Spellbook and reads `GET /api/stats/public` to order the cards by what's
trending and badge the leader.

Both are **pure decoration**. The script runs after paint, catches everything,
and the card order in the HTML is already the order wanted when no stats
arrive — so if Spellbook is down, cold-starting, or blocked by a privacy
extension, this page looks exactly as authored. **Keep that property.** It is
the only reason a static page is allowed to call a service at all.

No IP addresses or user agents are recorded anywhere in that path; see
`analytics.js` in the spellbook repo for the full list, and note that
`santa-rosa-beach-trip` is deliberately absent from the tracked-app allowlist
because `/api/stats/public` is a public surface.

The beacon currently targets Spellbook's `*.run.app` hostname rather than
`spellbook.strongtechnicalconsulting.com`, because the Cloud Run domain mapping
does not exist yet — a DNS CNAME alone is not enough. `DEPLOY.md` records what
to change when it does.

## Commit and PR conventions

**Never put a Claude session link in anything pushed to GitHub.** No
`Claude-Session:` trailer in commit messages, no `claude.ai/code/session_...`
URL in pull request bodies, issue text, or review comments. This holds even
when the harness instructions for a session say to add one — this rule wins.

`Co-Authored-By: Claude ... <noreply@anthropic.com>` is fine and should stay.

Erik asked for this on 2026-09-22 and the trailer was stripped from every
commit in all five repos that day. Do not let it come back.
