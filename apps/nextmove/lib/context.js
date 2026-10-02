// The process's shared pieces, built once and used by the web service and
// the jobs alike: the app store (Firestore `nextmove`), the shared account
// (Firestore `identity`), BigQuery, and Anthropic clients metered to a person.
//
// One module so that in memory mode (tests, `npm run dev`) the service and a
// job run in the same process see the same data.

const Anthropic = require('@anthropic-ai/sdk');
const identityLib = require('./identity');
const { store, MEMORY, memoryIdentityStore } = require('./store');
const bq = require('./bq');

const FAKE_AI = process.env.NEXTMOVE_FAKE_AI === '1';
if (FAKE_AI && (process.env.K_SERVICE || process.env.CLOUD_RUN_JOB)) throw new Error('NEXTMOVE_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - decided in one place by
// identity.planFor, as every sibling does. Both take a forced tool_choice;
// moving to a model that refuses forced tools (Sonnet 5.5, Opus 5.5) means
// switching these calls to tool_choice auto + strict tools first.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const identityStore = MEMORY ? memoryIdentityStore() : require('./identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'nextmove',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Next Move',
  mountPath: '/api/auth',
});

// In memory mode the user key needs a secret too; never on Cloud Run.
if (MEMORY && !process.env.IDENTITY_SESSION_SECRET) process.env.IDENTITY_SESSION_SECRET = 'local-dev-secret';

function rawClient(apiKey) {
  if (FAKE_AI) return require('./fakeai').create({ delayMs: Number(process.env.NEXTMOVE_FAKE_DELAY_MS || 0) });
  return new Anthropic(apiKey ? { apiKey } : { apiKey: process.env.ANTHROPIC_API_KEY });
}

// The web routes' client: charges whoever the request is signed in as.
const requestClient = identity.meter(rawClient());

/**
 * A client that charges `uid` for every call, for work no request stands
 * behind (the daily scoring, the weekly sweep). One per person per process -
 * the meter is attached to the client, so a shared one would charge whoever
 * the current request is, and a job has no request.
 */
const perUser = new Map();
function clientForUid(uid, route) {
  const key = `${uid}|${route}`;
  if (!perUser.has(key)) {
    if (perUser.size > 2000) perUser.clear();
    perUser.set(key, identity.meter(rawClient(), { uid, route }));
  }
  return perUser.get(key);
}

/** A person's own key when they have one on file (and pay the platform fee), else the metered app client. */
async function spendingClient(account, route) {
  const fallback = clientForUid(account.id, route);
  if (FAKE_AI) return fallback;
  return identity.clientFor(account, fallback, (apiKey) => new Anthropic({ apiKey }));
}

function bqClient() { return bq.client(); }

module.exports = { store, identityStore, identity, identityLib, MEMORY, FAKE_AI, MODELS, requestClient, clientForUid, spendingClient, bqClient, rawClient };
