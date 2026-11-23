// The Lab AI guard (2026-11-23, challenge/CLAUDE.md "Lab AI guard").
//
// Erik approved moving some lab apps to Gemini (Vertex AI) and keeping others
// on Claude, with two guards enforced here, in the apps, on top of his Google
// Cloud budget alerts:
//
//   - a monthly cap PER PROVIDER (claude, gemini), $25 each by default, kept
//     as a month-to-date dollar total in Firestore (`lab_ai_spend`,
//     `<provider>-<YYYY-MM>` UTC, field `usd`, FieldValue.increment);
//   - burst limits per person: AI calls a minute and a day per signed-in
//     account and, separately, per client address (IPv6 by its /64).
//
// Every redesigned app's model call goes
//   guard.allow() -> (the app's existing identity gates) -> the call -> guard.record()
// Apps not yet redesigned never touch this and work exactly as before.
//
// Why a global (`global.LAB_AI_GUARD`, set by the host before any app is
// required): each app is its own package, mounted by the host and also run on
// its own for its tests. It cannot `require('../../lib/ai-guard')` without
// breaking that, and a copy per app would mean one cap counter cache and one
// burst book per app - 57 apps, 57 views of "how much is left". One instance
// for the whole lab is the point, for the same reason SHARED_DEPS gives the
// lab one copy of the heavy dependencies. An app run on its own simply has no
// guard (it should treat `global.LAB_AI_GUARD` being undefined as "not in the
// lab": its own tests use their fake AI).
//
// Failure policy: the CAP fails closed (no readable month-to-date total and no
// cached one -> deny with `monthly-cap`), the BURST counters fail open (they
// are in memory; a bug there must not stop the lab's AI).

const fs = require('fs');
const path = require('path');

const PROVIDERS = ['claude', 'gemini'];
const COLLECTION = 'lab_ai_spend';
const CACHE_MS = 30 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_KEYS = 10000; // burst book entries; each holds at most `perDay` timestamps

const MESSAGES = {
  'burst-minute': 'Lots of people are using AI right now - try again in a minute.',
  'burst-day': "That's a lot of AI answers for one day - try again tomorrow.",
  'monthly-cap': 'AI answers are resting until next month; everything else still works.',
};

/* ---------------- prices ---------------- */

// Gemini on Vertex AI, USD per 1M tokens. A row with `until` applies through
// the end of that UTC day; the next row takes over. gemini-3.8-flash doubles
// on 2027-01-01. Thinking tokens bill as output (gemini.generate counts them).
const GEMINI_PRICES = {
  'gemini-3.8-flash': [
    { until: '2026-12-31', input: 0.75, output: 3.75 },
    { input: 1.5, output: 7.5 },
  ],
  'gemini-3.5-flash-lite': [{ input: 0.3, output: 2.5 }],
};

// Claude prices are the identity's table (shared/identity.js PRICES/priceOf),
// read, never copied, so a price change there reaches the cap too. The host's
// image has no shared/ folder - every app carries a synced copy (sync-shared
// --check keeps them identical) - so read the first app's copy, falling back
// to shared/ in a checkout. Loaded on first use: by then the host's
// SHARED_DEPS hook is in place, so the copy's dependencies are the host's.
const CACHE_CHARGED = Symbol.for('lab.claudeCache.charged');
let identityLib = null;
function identity() {
  if (identityLib) return identityLib;
  const apps = path.join(__dirname, '..', 'apps');
  let candidates = [];
  try {
    candidates = fs.readdirSync(apps).sort().map((d) => path.join(apps, d, 'lib', 'identity.js'));
  } catch { /* no apps folder */ }
  candidates.push(path.join(__dirname, '..', '..', 'shared', 'identity.js'));
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    try {
      const lib = require(file);
      if (lib && lib.PRICES && typeof lib.priceOf === 'function') return (identityLib = lib);
    } catch { /* try the next copy */ }
  }
  throw new Error('ai-guard: the identity price table could not be loaded');
}

/**
 * Dollars for one call. Throws on an unknown provider or model - a call is
 * never priced as zero.
 * Claude may also pass cacheWriteTokens, cacheReadTokens and webSearches,
 * and `iterations` (usage.iterations) so the advisor tool's consultations are
 * charged at the advisor model's rates on top of the executor's tokens - or
 * simply `usage`, the response's whole usage object, which then wins over the
 * separate counts (per-TTL cache writes and all).
 */
function priceUsd({ provider, model, inputTokens = 0, outputTokens = 0, at = new Date(), cacheWriteTokens = 0, cacheReadTokens = 0, webSearches = 0, iterations = null, usage = null } = {}) {
  const n = (v, name) => {
    const x = Number(v);
    if (!Number.isFinite(x) || x < 0) throw new TypeError(`ai-guard: ${name} must be a non-negative number`);
    return x;
  };
  const inTok = n(inputTokens, 'inputTokens');
  const outTok = n(outputTokens, 'outputTokens');
  if (provider === 'gemini') {
    const rows = Object.prototype.hasOwnProperty.call(GEMINI_PRICES, model) ? GEMINI_PRICES[model] : null;
    if (!rows) throw new Error(`ai-guard: no Gemini price for model "${model}"`);
    const when = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(when.getTime())) throw new TypeError('ai-guard: `at` is not a date');
    const day = when.toISOString().slice(0, 10);
    const p = rows.find((r) => !r.until || day <= r.until);
    return (inTok * p.input + outTok * p.output) / 1e6;
  }
  if (provider === 'claude') {
    const lib = identity();
    if (!Object.prototype.hasOwnProperty.call(lib.PRICES, model)) throw new Error(`ai-guard: no Claude price for model "${model}"`);
    let u;
    if (usage && typeof usage === 'object') {
      for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) n(usage[k] || 0, k);
      u = usage;
      // The host's prompt cache (lib/claude-cache.js) already recorded the
      // cache part of a breakpoint it added; count it once.
      if (usage[CACHE_CHARGED]) u = { ...usage, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: undefined };
    } else {
      u = {
        input_tokens: inTok,
        output_tokens: outTok,
        cache_creation_input_tokens: n(cacheWriteTokens, 'cacheWriteTokens'),
        cache_read_input_tokens: n(cacheReadTokens, 'cacheReadTokens'),
        server_tool_use: { web_search_requests: n(webSearches, 'webSearches') },
      };
      if (Array.isArray(iterations)) u.iterations = iterations;
    }
    // An advisor on a model the table does not know is never priced as free:
    // priceOf returns null and this throws, like an unknown executor.
    const usd = lib.priceOf(model, u);
    if (typeof usd !== 'number' || !Number.isFinite(usd)) throw new Error(`ai-guard: no Claude price for model "${model}"`);
    return usd;
  }
  throw new Error(`ai-guard: unknown provider "${provider}"`);
}

/* ---------------- addresses ---------------- */

/** Pure: the address a limit is counted against (IPv4 as is, IPv6 by its /64). */
function ipKey(ip) {
  const a = String(ip || '').replace(/^::ffff:/, '');
  if (!a.includes(':')) return a;
  const [head, tail = ''] = a.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return full.slice(0, 4).map((x) => (x || '0').toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** The UTC month a dollar is counted in: 'YYYY-MM'. */
const monthOf = (t) => new Date(t).toISOString().slice(0, 7);

/** A store with the host's shape (get, bump), in memory. */
function memoryStore() {
  const m = new Map();
  return {
    async get(c, id) { const v = m.get(`${c}/${id}`); return v ? { ...v } : null; },
    // Synchronous read-modify-write once running: atomic, like increment.
    async bump(c, id, d) {
      const cur = { ...(m.get(`${c}/${id}`) || {}) };
      for (const [k, v] of Object.entries(d)) cur[k] = (cur[k] || 0) + v;
      m.set(`${c}/${id}`, cur);
    },
  };
}

const envNumber = (env, name, fallback) => {
  const v = Number(env[name]);
  return env[name] !== undefined && env[name] !== '' && Number.isFinite(v) && v >= 0 ? v : fallback;
};

/* ---------------- the guard ---------------- */

/**
 * @param store  { get(collection, id), bump(collection, id, {field: n}) } -
 *               the host's store (Firestore increment, or memory). Defaults
 *               to an in-memory one.
 * @param env    process.env by default (caps, burst numbers, LAB_FAKE_AI)
 * @param now    () => ms, for tests
 * @param fetch  for the Gemini helper; defaults to global fetch
 * @param log    console-like; .warn for the cap line, .error for failures
 */
function create({ store = memoryStore(), env = process.env, now = Date.now, fetch, log = console } = {}) {
  const caps = {
    claude: envNumber(env, 'LAB_AI_CAP_CLAUDE_USD', 25),
    gemini: envNumber(env, 'LAB_AI_CAP_GEMINI_USD', 25),
  };
  const burst = {
    accountMinute: envNumber(env, 'LAB_AI_BURST_MINUTE', 5),
    accountDay: envNumber(env, 'LAB_AI_BURST_DAY', 30),
  };
  burst.ipMinute = envNumber(env, 'LAB_AI_BURST_IP_MINUTE', burst.accountMinute);
  burst.ipDay = envNumber(env, 'LAB_AI_BURST_IP_DAY', burst.accountDay);

  // Per-app allowance (Erik, 2026-11-23, for Spar: a practice round is a call
  // a turn). LAB_AI_BURST_APP_<SLUG>="<perMinute>/<perDay>" gives that app its
  // own burst book per person and per address, instead of the shared one, so
  // its calls neither use up nor are stopped by the lab-wide 5/30. Caps are
  // unchanged. A malformed value is ignored (the shared book applies).
  const appBurst = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^LAB_AI_BURST_APP_([A-Z0-9]+)$/.exec(k);
    const n = /^\s*(\d{1,4})\s*\/\s*(\d{1,5})\s*$/.exec(String(v || ''));
    if (m && n && Number(n[1]) > 0 && Number(n[2]) >= Number(n[1])) {
      appBurst[m[1].toLowerCase()] = { perMinute: Number(n[1]), perDay: Number(n[2]) };
    }
  }

  /* ----- month-to-date spend, cached ----- */

  const totals = {}; // provider -> { month, usd, at }
  const inflight = {}; // provider -> Promise
  const announced = new Set(); // `${provider}-${month}` whose crossing was logged

  const announce = (provider, month, usd) => {
    const key = `${provider}-${month}`;
    if (usd < caps[provider] || announced.has(key)) return;
    announced.add(key);
    // One line, no user data: which provider, which month, how much.
    log.warn(`[ai-guard] ${provider} monthly cap reached for ${month}: $${usd.toFixed(2)} of $${caps[provider].toFixed(2)}`);
  };

  /** Month-to-date dollars for a provider, or null when unknown. Reads the
   *  store at most every CACHE_MS; a failed read keeps this month's last
   *  value. */
  async function monthUsd(provider) {
    const t = now();
    const month = monthOf(t);
    const c = totals[provider];
    if (c && c.month === month && t - c.at < CACHE_MS) return c.usd;
    if (!inflight[provider]) {
      inflight[provider] = (async () => {
        try {
          const doc = await store.get(COLLECTION, `${provider}-${month}`);
          const usd = doc && Number.isFinite(Number(doc.usd)) ? Number(doc.usd) : 0;
          const prev = totals[provider];
          // A record() that landed while the read was in flight is kept.
          const kept = prev && prev.month === month ? Math.max(usd, prev.usd) : usd;
          totals[provider] = { month, usd: kept, at: now() };
          announce(provider, month, kept);
        } catch (err) {
          log.error(`[ai-guard] could not read the ${provider} month total:`, err && err.message);
        } finally {
          inflight[provider] = null;
        }
      })();
    }
    await inflight[provider];
    const after = totals[provider];
    return after && after.month === month ? after.usd : null;
  }

  /* ----- burst book: sliding minute and day windows ----- */

  const book = new Map(); // key -> [timestamps within the last day], oldest first

  /** Synchronous check-and-count, so parallel requests cannot all pass. */
  function takeBurst(keys) {
    const t = now();
    const rows = keys.map(({ key, perMinute, perDay }) => {
      const hits = (book.get(key) || []).filter((x) => t - x < DAY_MS);
      return { key, perMinute, perDay, hits };
    });
    for (const r of rows) {
      if (r.hits.length >= r.perDay) return 'burst-day';
    }
    for (const r of rows) {
      if (r.hits.filter((x) => t - x < MINUTE_MS).length >= r.perMinute) return 'burst-minute';
    }
    for (const r of rows) {
      r.hits.push(t);
      book.delete(r.key); // re-insert: Map order is then least recently used first
      book.set(r.key, r.hits.slice(-Math.max(1, r.perDay)));
      while (book.size > MAX_KEYS) book.delete(book.keys().next().value);
    }
    return null;
  }

  const deny = (code) => ({ ok: false, status: code === 'monthly-cap' ? 503 : 429, code, message: MESSAGES[code] });

  const checkProvider = (provider) => {
    if (!PROVIDERS.includes(provider)) throw new Error(`ai-guard: unknown provider "${provider}"`);
  };

  /**
   * May this request make one AI call? Resolves { ok: true } (and counts it
   * against the burst limits) or { ok: false, status, code, message } - send
   * `status` and `{ error: message }` and do not call the model.
   */
  async function allow({ provider, req, app } = {}) {
    checkProvider(provider);
    if (!req || typeof req !== 'object') throw new TypeError('ai-guard: allow() needs the request');
    if (typeof app !== 'string' || !app) throw new TypeError('ai-guard: allow() needs the app slug');

    const spent = await monthUsd(provider);
    if (spent === null || spent >= caps[provider]) return deny('monthly-cap');

    try {
      const keys = [];
      const own = Object.prototype.hasOwnProperty.call(appBurst, app) ? appBurst[app] : null;
      const uid = req.user && req.user.id;
      const ip = ipKey(req.ip || (req.socket && req.socket.remoteAddress));
      if (own) {
        if (uid) keys.push({ key: `a:${uid}:${app}`, perMinute: own.perMinute, perDay: own.perDay });
        if (ip) keys.push({ key: `i:${ip}:${app}`, perMinute: own.perMinute, perDay: own.perDay });
      } else {
        if (uid) keys.push({ key: `a:${uid}`, perMinute: burst.accountMinute, perDay: burst.accountDay });
        if (ip) keys.push({ key: `i:${ip}`, perMinute: burst.ipMinute, perDay: burst.ipDay });
      }
      const code = takeBurst(keys);
      if (code) return deny(code);
    } catch (err) {
      // In memory and best effort: a bug here must not stop the lab's AI.
      log.error('[ai-guard] burst check failed, allowing:', err && err.message);
    }
    return { ok: true };
  }

  /**
   * After a call: add its cost to the provider's month, atomically
   * (FieldValue.increment). Throws only on a bad argument; a store failure is
   * logged and resolves false (the call already happened - the page should
   * still get its answer).
   */
  async function record({ provider, app, usd } = {}) {
    checkProvider(provider);
    if (typeof app !== 'string' || !app) throw new TypeError('ai-guard: record() needs the app slug');
    const amount = Number(usd);
    if (typeof usd !== 'number' || !Number.isFinite(amount) || amount < 0) throw new TypeError('ai-guard: record() needs usd, a non-negative number (priceUsd)');
    const month = monthOf(now());
    const c = totals[provider];
    if (c && c.month === month) {
      c.usd += amount;
      announce(provider, month, c.usd);
    }
    try {
      await store.bump(COLLECTION, `${provider}-${month}`, { usd: amount });
      return true;
    } catch (err) {
      log.error(`[ai-guard] could not record ${provider} spend:`, err && err.message);
      return false;
    }
  }

  /** Public-safe: each provider's cap and month-to-date dollars, to the cent.
   *  No per-user data. monthUsd is null when it cannot be read. */
  async function status() {
    const out = {};
    for (const p of PROVIDERS) {
      const usd = await monthUsd(p);
      out[p] = { capUsd: Math.round(caps[p] * 100) / 100, monthUsd: usd === null ? null : Math.round(usd * 100) / 100 };
    }
    return out;
  }

  const gemini = require('./vertex').create({ env, fetch, now });

  return { allow, record, priceUsd, status, gemini, caps: { ...caps }, burst: { ...burst }, MESSAGES };
}

module.exports = { create, priceUsd, ipKey, monthOf, memoryStore, GEMINI_PRICES, PROVIDERS, COLLECTION, MESSAGES };
