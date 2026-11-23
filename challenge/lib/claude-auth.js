// The lab's Claude calls through workload identity federation (2026-11-23,
// CLAUDE.md "Claude through federation"). Erik asked for the lab's own
// Claude usage to run on his federated service account ("erik-apps") instead
// of the long-lived API key.
//
// How: every app builds its client as `new Anthropic({ apiKey: process.env.
// ANTHROPIC_API_KEY })`, and every one of them loads the SDK from the host's
// node_modules (SHARED_DEPS). So the host swaps the SDK's Anthropic class for
// a thin subclass, once, before any app is required. A client built with the
// LAB's key gets a fetch that puts a short-lived federated token on each
// request instead of the key. A client built with any other key (a member's
// own key, BYOK) is left exactly as it was.
//
// The token: the runtime account (challenge-run@) asks IAM Credentials for a
// Google ID token of the federated Google service account (LAB_WIF_GOOGLE_SA,
// Token Creator granted), audience LAB_WIF_AUDIENCE, with its email; that is
// exchanged at POST /v1/oauth/token for an Anthropic access token (10 minutes
// on Erik's rule), cached until a minute before it ends, one exchange at a
// time.
//
// Never breaks the lab: if the token cannot be had (or the API refuses it),
// the request goes out with the API key as before, and one line is logged at
// most once a minute. Off unless LAB_CLAUDE_AUTH=federation; unset that env
// var to go back. No id, token or key is ever logged or returned.

const META_TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const IAM_ID_TOKEN = (sa) => `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(sa)}:generateIdToken`;
const EXCHANGE_URL = 'https://api.anthropic.com/v1/oauth/token';
const TIMEOUT_MS = 5000;
const REFRESH_EARLY_MS = 60 * 1000;
const BACKOFF_MS = 60 * 1000;

function config(env = process.env) {
  const c = {
    on: env.LAB_CLAUDE_AUTH === 'federation',
    ruleId: env.LAB_WIF_RULE_ID || '',
    orgId: env.LAB_WIF_ORG_ID || '',
    serviceAccountId: env.LAB_WIF_SERVICE_ACCOUNT_ID || '',
    workspaceId: env.LAB_WIF_WORKSPACE_ID || '',
    googleSa: env.LAB_WIF_GOOGLE_SA || '',
    audience: env.LAB_WIF_AUDIENCE || 'https://api.anthropic.com',
  };
  c.complete = Boolean(/^fdrl_[A-Za-z0-9]+$/.test(c.ruleId) && /^[0-9a-f-]{36}$/.test(c.orgId)
    && /^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/.test(c.googleSa)
    && (!c.workspaceId || /^wrkspc_[A-Za-z0-9]+$/.test(c.workspaceId))
    && (!c.serviceAccountId || /^svac_[A-Za-z0-9]+$/.test(c.serviceAccountId)));
  return c;
}

function create({ env = process.env, fetchImpl = (...a) => fetch(...a), now = () => Date.now(), log = console.warn } = {}) {
  const cfg = config(env);
  const state = { token: null, expiresAt: 0, inflight: null, failUntil: 0, lastLog: 0, lastOkAt: null, lastError: null, exchanges: 0, fallbacks: 0 };

  const note = (code) => {
    state.lastError = code;
    if (now() - state.lastLog > 60 * 1000) { state.lastLog = now(); log(`[claude-auth] federation unavailable (${code}); using the API key`); }
  };

  async function getJson(url, init, code) {
    const r = await fetchImpl(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!r.ok) { const e = new Error(code); e.code = `${code}-${r.status}`; throw e; }
    return r.json();
  }

  async function exchange() {
    const meta = await getJson(META_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } }, 'metadata');
    const id = await getJson(IAM_ID_TOKEN(cfg.googleSa), {
      method: 'POST',
      headers: { authorization: `Bearer ${meta.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ audience: cfg.audience, includeEmail: true }),
    }, 'id-token');
    const body = { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: id.token, federation_rule_id: cfg.ruleId, organization_id: cfg.orgId };
    if (cfg.serviceAccountId) body.service_account_id = cfg.serviceAccountId;
    if (cfg.workspaceId) body.workspace_id = cfg.workspaceId;
    const t = await getJson(EXCHANGE_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) }, 'exchange');
    if (typeof t.access_token !== 'string' || !t.access_token) { const e = new Error('exchange'); e.code = 'exchange-shape'; throw e; }
    const life = Math.max(60, Math.min(Number(t.expires_in) || 600, 86400)) * 1000;
    state.token = t.access_token;
    state.expiresAt = now() + life - REFRESH_EARLY_MS;
    state.lastOkAt = new Date(now()).toISOString();
    state.lastError = null;
    state.exchanges += 1;
    return state.token;
  }

  /** A current token, or null (and the caller uses the key). Never throws. */
  async function token() {
    if (!cfg.on || !cfg.complete) return null;
    if (state.token && now() < state.expiresAt) return state.token;
    if (now() < state.failUntil) return null;
    if (!state.inflight) {
      state.inflight = exchange()
        .catch((e) => { state.token = null; state.failUntil = now() + BACKOFF_MS; note(e.code || (e.name === 'TimeoutError' ? 'timeout' : 'error')); return null; })
        .finally(() => { state.inflight = null; });
    }
    return state.inflight;
  }

  function forget() { state.token = null; state.expiresAt = 0; }

  /** A fetch for a lab-key client: the federated token when there is one, the key otherwise. */
  function fetchFor(base) {
    const send = base || ((...a) => fetchImpl(...a));
    return async function federatedFetch(url, init = {}) {
      const tok = await token();
      if (!tok) { state.fallbacks += 1; return send(url, init); }
      const headers = new Headers(init.headers || {});
      headers.delete('x-api-key');
      headers.set('authorization', `Bearer ${tok}`);
      const res = await send(url, { ...init, headers });
      if (res.status !== 401) return res;
      // A refused token (revoked rule, ended early): drop it, back off, and
      // send this one request with the key so the person still gets an answer.
      forget(); state.failUntil = now() + BACKOFF_MS; note('refused-401'); state.fallbacks += 1;
      return send(url, init);
    };
  }

  /** Swap the SDK's class for one that federates lab-key clients. Idempotent. */
  function install(sdkClientModule, labKey = env.ANTHROPIC_API_KEY) {
    if (!cfg.on) return false;
    if (!cfg.complete) { log('[claude-auth] LAB_CLAUDE_AUTH=federation but the LAB_WIF_* settings are incomplete; using the API key'); return false; }
    const Orig = sdkClientModule.Anthropic;
    if (!Orig || Orig.__labFederated) return Boolean(Orig && Orig.__labFederated);
    class LabAnthropic extends Orig {
      constructor(opts = {}) {
        const lab = labKey && opts && opts.apiKey === labKey && !opts.authToken;
        super(lab ? { ...opts, fetch: fetchFor(opts.fetch) } : opts);
      }
    }
    Object.defineProperty(LabAnthropic, 'name', { value: 'Anthropic' });
    LabAnthropic.__labFederated = true;
    sdkClientModule.Anthropic = LabAnthropic;
    return true;
  }

  /** Public, nothing secret: is it on, and did the last exchange work. */
  function status() {
    return { mode: cfg.on && cfg.complete ? 'federation' : 'api-key', configured: cfg.complete, lastOkAt: state.lastOkAt, lastError: state.lastError, exchanges: state.exchanges, fallbacks: state.fallbacks };
  }

  return { config: cfg, token, fetchFor, install, status, _state: state };
}

module.exports = { create, config };
