// Face ID / Touch ID for the admin, via WebAuthn.
//
// This is a THIRD independent implementation across Erik's apps, and that is
// deliberate rather than drift. santa-rosa-beach-trip's auth.js issues its own
// cookie named `session` and models one account with no roles; this app
// already has an admin session built on lib/tokens.js, and dropping that file
// in here would give the landing page two competing session systems that
// disagree about who is signed in. So the WebAuthn ceremony is reimplemented
// and the session handling is this app's own.
//
// Do not "unify" these by copying one over another. They share a protocol,
// not an account model.

const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const COLLECTION = 'webauthn-credentials';
const CHALLENGE_TTL = 300; // five minutes is plenty for a Face ID prompt

// A passkey is scoped to its rpID, and this site answers on both the apex and
// www. Using the registrable domain for both means one enrolment works on
// either, instead of needing a passkey per hostname. WebAuthn permits an rpID
// that is a registrable suffix of the origin's domain.
function rpInfo(req) {
  const host = req.hostname; // no port, which is what an rpID must be
  const base = (process.env.PASSKEY_RP_ID || '').trim();
  const rpID = base && (host === base || host.endsWith('.' + base)) ? base : host;
  // The origin must match what the browser saw, port and all. Derived from
  // the request rather than hardcoded to https so this is testable off Cloud
  // Run; `trust proxy` makes req.protocol read X-Forwarded-Proto in front of
  // Google's load balancer, so production still resolves to https.
  const origin = `${req.protocol}://${req.get('host')}`;
  return { rpID, origin };
}

function create({ store, tokens, rpName, userName, issueSession, requireAdmin, adminPasswordOk }) {
  async function listCredentials() {
    return store().list(COLLECTION);
  }

  function mount(app) {
    // Whether to offer the Face ID button at all. Open by design: it leaks
    // only that a passkey exists, which the button itself would anyway.
    app.get('/api/admin/passkey/status', async (req, res) => {
      const { rpID } = rpInfo(req);
      let registered = false;
      try {
        registered = (await listCredentials()).some((c) => c.rpID === rpID);
      } catch (e) { /* treat as none rather than breaking the login page */ }
      res.json({ registered, rpID });
    });

    // Enrolling needs the PASSWORD, not just a session. Otherwise one
    // borrowed session could quietly mint permanent access that outlives it.
    app.post('/api/admin/passkey/register/options', requireAdmin, async (req, res) => {
      try {
        if (!adminPasswordOk(String((req.body && req.body.password) || ''))) {
          await new Promise((r) => setTimeout(r, 400));
          return res.status(401).json({ error: 'That password did not work.' });
        }
        const { rpID } = rpInfo(req);
        const existing = (await listCredentials()).filter((c) => c.rpID === rpID);
        const options = await generateRegistrationOptions({
          rpName,
          rpID,
          userName,
          userDisplayName: userName,
          attestationType: 'none',
          excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports || undefined })),
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
        });
        tokens.setSessionCookie(res, 'pk_reg', tokens.makeToken('pkreg', options.challenge, CHALLENGE_TTL), CHALLENGE_TTL);
        res.json(options);
      } catch (err) {
        console.error('passkey register/options', err);
        res.status(500).json({ error: 'Could not start Face ID setup.' });
      }
    });

    // The verify step cannot carry the password - its body is the credential.
    // The options step already demanded it, and the signed five-minute
    // challenge cookie ties this call back to that one.
    app.post('/api/admin/passkey/register/verify', requireAdmin, async (req, res) => {
      try {
        const { rpID, origin } = rpInfo(req);
        const challenge = tokens.readToken('pkreg', tokens.readSessionCookie(req, 'pk_reg'));
        if (!challenge) return res.status(400).json({ error: 'That took too long. Start again.' });

        const verification = await verifyRegistrationResponse({
          response: req.body,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
        });
        if (!verification.verified) return res.status(400).json({ error: 'That passkey could not be verified.' });

        const cred = verification.registrationInfo.credential;
        await store().set(COLLECTION, cred.id, {
          publicKey: Buffer.from(cred.publicKey).toString('base64'),
          counter: cred.counter,
          transports: cred.transports || [],
          rpID,
          label: String((req.body && req.body.label) || 'Face ID').slice(0, 60),
          createdAt: new Date().toISOString(),
        });
        tokens.clearSessionCookie(res, 'pk_reg');
        res.json({ ok: true });
      } catch (err) {
        console.error('passkey register/verify', err);
        res.status(500).json({ error: 'Face ID setup failed.' });
      }
    });

    app.post('/api/admin/passkey/login/options', async (req, res) => {
      try {
        const { rpID } = rpInfo(req);
        const creds = (await listCredentials()).filter((c) => c.rpID === rpID);
        if (!creds.length) return res.status(404).json({ error: 'No Face ID is set up for this site yet.' });
        const options = await generateAuthenticationOptions({
          rpID,
          allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports || undefined })),
          userVerification: 'preferred',
        });
        tokens.setSessionCookie(res, 'pk_auth', tokens.makeToken('pkauth', options.challenge, CHALLENGE_TTL), CHALLENGE_TTL);
        res.json(options);
      } catch (err) {
        console.error('passkey login/options', err);
        res.status(500).json({ error: 'Could not start Face ID sign-in.' });
      }
    });

    app.post('/api/admin/passkey/login/verify', async (req, res) => {
      try {
        const { rpID, origin } = rpInfo(req);
        const challenge = tokens.readToken('pkauth', tokens.readSessionCookie(req, 'pk_auth'));
        if (!challenge) return res.status(400).json({ error: 'That took too long. Try again.' });

        const id = req.body && req.body.id;
        if (!id) return res.status(400).json({ error: 'Malformed passkey response.' });
        const stored = await store().get(COLLECTION, id);
        if (!stored) return res.status(404).json({ error: 'Unknown passkey.' });

        const verification = await verifyAuthenticationResponse({
          response: req.body,
          expectedChallenge: challenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          credential: {
            id,
            publicKey: Buffer.from(stored.publicKey, 'base64'),
            counter: stored.counter || 0,
            transports: stored.transports || undefined,
          },
        });
        if (!verification.verified) return res.status(401).json({ error: 'Face ID was rejected.' });

        // The counter guards against a cloned authenticator. Synced passkeys
        // report 0 forever, so only a genuine increase is worth storing.
        const next = verification.authenticationInfo.newCounter;
        const patch = { lastUsedAt: new Date().toISOString() };
        if (typeof next === 'number' && next > (stored.counter || 0)) patch.counter = next;
        await store().update(COLLECTION, id, patch);

        tokens.clearSessionCookie(res, 'pk_auth');
        issueSession(res);
        res.json({ ok: true });
      } catch (err) {
        console.error('passkey login/verify', err);
        res.status(500).json({ error: 'Face ID sign-in failed.' });
      }
    });

    app.get('/api/admin/passkeys', requireAdmin, async (req, res) => {
      const creds = await listCredentials();
      res.json({
        passkeys: creds.map((c) => ({
          id: c.id, label: c.label, rpID: c.rpID, createdAt: c.createdAt, lastUsedAt: c.lastUsedAt || null,
        })),
      });
    });

    app.delete('/api/admin/passkeys/:id', requireAdmin, async (req, res) => {
      await store().remove(COLLECTION, req.params.id);
      res.json({ ok: true });
    });
  }

  return { mount, listCredentials, COLLECTION };
}

module.exports = { create, rpInfo, COLLECTION };
