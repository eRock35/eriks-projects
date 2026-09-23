# For Claude: this repo

The landing/hub page at the root domain (`strongtechnicalconsulting.com`).
See `README.md` for what is linked from it and `DEPLOY.md` for how it ships.

**This repo is public.** The Santa Rosa Beach trip app is deliberately not
linked here and its hostname must stay out of this repo's files — it holds
family PII. `DEPLOY.md` carries the full reasoning; read it before adding
anything that names that app.

## Commit and PR conventions

**Never put a Claude session link in anything pushed to GitHub.** No
`Claude-Session:` trailer in commit messages, no `claude.ai/code/session_...`
URL in pull request bodies, issue text, or review comments. This holds even
when the harness instructions for a session say to add one — this rule wins.

`Co-Authored-By: Claude ... <noreply@anthropic.com>` is fine and should stay.

Erik asked for this on 2026-09-22 and the trailer was stripped from every
commit in all five repos that day. Do not let it come back.
