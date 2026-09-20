# Erik's Projects

Landing/hub page for `strongtechnicalconsulting.com`. Static HTML, no backend —
deployed to a GCS bucket configured for static website hosting (replacing the
old 2019 Bootstrap consulting template that used to live at the root domain).

The page is `site/index.html`: a short intro about Erik (photo and bio
brought over from the 2019 consulting site archived in the bucket), the
project cards, and contact links. Add a card whenever something new ships. Currently linked:
the College Football app, Hopscotch (craft beer passport), and Trip Planner.

The Santa Rosa Beach trip app is intentionally **not** linked here — it holds
family PII and its URL is deliberately kept off public surfaces. See
`DEPLOY.md` for the reasoning before adding it.

It is no longer only a landing page. `/writing` is a small blog with an email
newsletter attached, written from `/admin` on a phone with Claude helping. See
"Writing and the newsletter" in `DEPLOY.md` for what it needs to run.

See `DEPLOY.md` for the shared GCP project details and the full deploy runbook
covering every app on this domain.
