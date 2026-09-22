# Erik's Projects

Landing/hub page for `strongtechnicalconsulting.com`. Static HTML, no backend —
deployed to a GCS bucket configured for static website hosting (replacing the
old 2019 Bootstrap consulting template that used to live at the root domain).

Add a card to `site/index.html` whenever something new ships. Currently linked:
the College Football app, Hopscotch (craft beer passport), Trip Planner, and
Spellbook (a shared prompt library).

The cards re-order themselves by the last seven days of views and the leader
gets a "Trending" badge — both driven by Spellbook's public stats API, and both
purely decorative, so the page is unchanged if that call fails.

The Santa Rosa Beach trip app is intentionally **not** linked here — it holds
family PII and its URL is deliberately kept off public surfaces. See
`DEPLOY.md` for the reasoning before adding it.

Spellbook — the prompt library that doubles as the view-tracking backend behind
those re-ordering cards — lives in its own repo, `eRock35/spellbook`. All this
page keeps of it is one deferred `<script>`.

The page itself is now served by Cloud Run (`server.js`), not by the GCS bucket
— GCS static website hosting cannot do HTTPS on a custom domain at all, which
is why the root domain used to read "Not Secure". See the comment at the top of
`server.js`.

See `DEPLOY.md` for the shared GCP project details and the full deploy runbook
covering every app on this domain.
