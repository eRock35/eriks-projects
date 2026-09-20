# Erik's Projects

Landing/hub page for `strongtechnicalconsulting.com`. Static HTML, no backend —
deployed to a GCS bucket configured for static website hosting (replacing the
old 2019 Bootstrap consulting template that used to live at the root domain).

Links out to other projects hosted on this domain (Cover Sheet at
`coversheet.strongtechnicalconsulting.com`, etc.) — add a new card in
`index.html` whenever something new ships.

See `eRock35/college-football-app`'s `docs/gcp-deployment.md` for the shared
GCP project details (`metal-celerity-236019`) and deploy pipeline notes.
Deploying this one is simpler than the Node apps — it's just a
`gsutil`/Storage-API sync of `index.html` to the root bucket, no Cloud
Build/Cloud Run needed.
