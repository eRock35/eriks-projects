# For Claude: this repo

The landing/hub page at the root domain (`strongtechnicalconsulting.com`).
See `README.md` for what is linked from it and `DEPLOY.md` for how it ships.

**This repo is public.** The Santa Rosa Beach trip app is deliberately not
linked here and its hostname must stay out of this repo's files — it holds
family PII. `DEPLOY.md` carries the full reasoning; read it before adding
anything that names that app.

## Two things ship from this repo

1. **The landing page** — `server.js`, `Dockerfile` and `site/` at the repo
   root. Cloud Run service `landing-page`.
2. **Spellbook** — `spellbook/`, a prompt library that is *also* the view
   analytics backend for every app on the domain. Cloud Run service
   `spellbook`, Firestore database `spellbook`. It has its own `README.md`,
   `Dockerfile` and `package.json` inside that directory.

They are separate services with separate build contexts.
`.claude/skills/deploy/apps.json` gives `spellbook` a `subdir` key and
`gcpdeploy` packages only that subtree, so a build of one never picks up the
other's Dockerfile. **Don't merge them.** The landing page is deliberately
dependency-light and scales to zero — that is the entire reason it is
affordable on Cloud Run rather than behind a load balancer — and giving it a
Firestore client would put a database round trip in front of the root domain.

Spellbook is in this repo only because the session that built it could not
create a GitHub repository (the App token 403s on `POST /user/repos`). Erik's
convention is one repo per project and splitting it out later is a `git mv`
plus one line in `apps.json`; nothing in the code knows where it lives.

### What the landing page borrowed from Spellbook

`site/index.html` carries one deferred `<script>` that does two things: posts a
view beacon to Spellbook, and reads `GET /api/stats/public` to order the cards
by what's trending and badge the leader. Both are **pure decoration**: the
script runs after paint, catches everything, and the card order in the HTML is
already the order wanted when no stats arrive. If Spellbook is down,
cold-starting, or blocked by a privacy extension, the page looks exactly as
authored. Keep that property — it is why a static page is allowed to depend on
a service at all.

No IP addresses or user agents are stored anywhere in that path. See
`spellbook/analytics.js` for the full list of what is and is not recorded, and
note that `santa-rosa-beach-trip` is **not** in the tracked-app allowlist and
must not be added: `/api/stats/public` is a public surface.

## Commit and PR conventions

**Never put a Claude session link in anything pushed to GitHub.** No
`Claude-Session:` trailer in commit messages, no `claude.ai/code/session_...`
URL in pull request bodies, issue text, or review comments. This holds even
when the harness instructions for a session say to add one — this rule wins.

`Co-Authored-By: Claude ... <noreply@anthropic.com>` is fine and should stay.

Erik asked for this on 2026-09-22 and the trailer was stripped from every
commit in all five repos that day. Do not let it come back.
