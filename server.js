// Static file server for the landing page.
//
// Why this exists: the page used to be served straight from a GCS bucket, and
// GCS static website hosting cannot do HTTPS on a custom domain at all — not a
// missing setting, the capability isn't there. That's why the root domain read
// "Not Secure" while footballapp. was fine. Cloud Run gets a free
// Google-managed certificate through a domain mapping.
//
// Deliberately boring and dependency-light. It must scale to zero: a static
// page on Cloud Run with min-instances 0 sits inside the free tier, whereas an
// HTTPS load balancer would have been ~$18-25/month standing charge. Do not
// add a min-instance count, a warmup, or anything else that keeps an instance
// alive — that re-introduces exactly the cost this design avoided.

const express = require('express');
const path = require('path');

const PORT = process.env.PORT || 8080;
const app = express();

app.get('/healthz', (req, res) => res.status(200).send('ok'));

app.use(express.static(path.join(__dirname, 'site'), {
  extensions: ['html'],
  // The page changes rarely but should not go stale for long when it does.
  maxAge: '5m',
}));

// Anything unrecognised falls back to the landing page rather than a bare 404.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'site', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Landing page listening on :${PORT}`);
});
