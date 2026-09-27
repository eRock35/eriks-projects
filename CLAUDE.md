# For Claude: this repo

The landing/hub page at the root domain (`strongtechnicalconsulting.com`).
See `README.md` for what is linked from it and `DEPLOY.md` for how it ships.

**This repo is public.** The Santa Rosa Beach trip app is deliberately not
linked here and its hostname must stay out of this repo's files — it holds
family PII. `DEPLOY.md` carries the full reasoning; read it before adding
anything that names that app.

## Erik's email address stays out of pages and the repo (2026-09-27)

Erik asked that bots never scrape his address. So:

- **No page may contain it**, and no `mailto:` link. Email links are
  `<a data-contact>` and `site/contact.js` builds the address only on a
  click (kept reversed in that file, never written out). `test/spam.js`
  fails if any served page carries an email address or `mailto:`.
- **No public file may contain it**: this repo is public. Docs say "Erik's
  address at the domain" and point at the secret or env var instead.
  Git history still holds the old copies; that was left alone (rewriting
  published history needs Erik's go-ahead).
- **The newsletter form must not become a way to mail strangers**: a hidden
  field, a two-second floor, one confirmation per address per six hours and
  40 an hour, on top of the per-IP limit. Every trap answers like a real
  signup. See `handleSubscribe()`.

## Commit and PR conventions

**Never put a Claude session link in anything pushed to GitHub.** No
`Claude-Session:` trailer in commit messages, no `claude.ai/code/session_...`
URL in pull request bodies, issue text, or review comments. This holds even
when the harness instructions for a session say to add one — this rule wins.

`Co-Authored-By: Claude ... <noreply@anthropic.com>` is fine and should stay.

Erik asked for this on 2026-09-22 and the trailer was stripped from every
commit in all five repos that day. Do not let it come back.
