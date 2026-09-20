# Erik's Projects

Landing/hub page for `strongtechnicalconsulting.com`. Static HTML, no backend —
deployed to a GCS bucket configured for static website hosting (replacing the
old 2019 Bootstrap consulting template that used to live at the root domain).

Add a card to `index.html` whenever something new ships. Currently linked:
the College Football app, Hopscotch (craft beer passport), and Trip Planner.

The Santa Rosa Beach trip app is intentionally **not** linked here — it holds
family PII and its URL is deliberately kept off public surfaces. See
`DEPLOY.md` for the reasoning before adding it.

Deploying this page is simpler than the Node apps — it's a Storage-API upload
of `index.html` to the root bucket, no Cloud Build or Cloud Run involved.

See `DEPLOY.md` for the shared GCP project details and the full deploy runbook
covering every app on this domain.
