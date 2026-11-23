// Gemini on Vertex AI for lab apps (2026-11-23, CLAUDE.md "Lab AI guard").
// Reached as global.LAB_AI_GUARD.gemini.generate(...). No SDK: global fetch,
// a token from the Cloud Run metadata server (the runtime account,
// challenge-run@), one POST to generateContent. JSON out only, against the
// caller's responseSchema, so an app never parses free text.
//
// Fake when LAB_FAKE_AI=1 (the host sets it under LAB_MEMORY=1) or when the
// caller passes `fake` - tests never touch the network. This helper does NOT
// call allow()/record(): the app does, around it (it knows the request, and
// a priced record needs the usage this returns).

const PROJECT = 'metal-celerity-236019';
const TOKEN_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const ENDPOINT = (model) => `https://aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/global/publishers/google/models/${model}:generateContent`;
const MODELS = ['gemini-3.8-flash', 'gemini-3.5-flash-lite']; // the priced ones (ai-guard GEMINI_PRICES)
const TOKEN_TIMEOUT_MS = 3000;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_BODY = 2 * 1024 * 1024;

class VertexError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'VertexError';
    this.code = code; // 'timeout' | 'token' | 'http' | 'blocked' | 'bad-json' | 'too-large'
    if (status) this.status = status;
  }
}

/** Pure: a minimal value that satisfies an OpenAPI-style responseSchema. */
function sampleFor(schema = {}) {
  const type = String(schema.type || 'object').toLowerCase();
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (type === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(schema.properties || {})) out[k] = sampleFor(v);
    return out;
  }
  if (type === 'array') return [sampleFor(schema.items || { type: 'string' })];
  if (type === 'string') return 'Sample';
  if (type === 'integer' || type === 'number') return 1;
  if (type === 'boolean') return false;
  return null;
}

/** Pure: usageMetadata -> { inputTokens, outputTokens }. Thinking tokens bill
 *  as output, so they are counted there. */
function usageOf(meta) {
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
  const m = meta || {};
  return { inputTokens: n(m.promptTokenCount), outputTokens: n(m.candidatesTokenCount) + n(m.thoughtsTokenCount) };
}

function create({ env = process.env, fetch: fetchImpl, now = Date.now } = {}) {
  const doFetch = (...args) => (fetchImpl || globalThis.fetch)(...args);
  let token = null; // { value, until }

  async function accessToken() {
    // Local real-Gemini checks only (never set on Cloud Run): a short-lived
    // token from `gcloud auth print-access-token`, so an app's real request
    // can be tried on a workstation, which has no metadata server.
    if (env.LAB_VERTEX_ACCESS_TOKEN) return env.LAB_VERTEX_ACCESS_TOKEN;
    if (token && now() < token.until) return token.value;
    let r;
    try {
      r = await doFetch(TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' }, redirect: 'error', signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS) });
    } catch (err) {
      throw new VertexError(err && err.name === 'TimeoutError' ? 'timeout' : 'token', 'Could not get a Vertex AI token.');
    }
    if (!r.ok) throw new VertexError('token', 'Could not get a Vertex AI token.', r.status);
    const body = await r.json().catch(() => null);
    if (!body || typeof body.access_token !== 'string') throw new VertexError('token', 'Could not get a Vertex AI token.');
    const life = Number(body.expires_in) > 0 ? Number(body.expires_in) : 300;
    token = { value: body.access_token, until: now() + Math.max(0, life - 60) * 1000 };
    return token.value;
  }

  /**
   * @param model             one of MODELS
   * @param contents          Vertex `contents` (array), or a string for one user turn
   * @param responseSchema    required: the JSON shape the answer must have
   * @param systemInstruction optional string
   * @param generationConfig  optional extra config (temperature, maxOutputTokens, ...)
   * @param timeoutMs         default 30 s
   * @param fake              optional (request) => json, or true for a schema sample
   * @returns { json, usage: { inputTokens, outputTokens }, model }
   */
  async function generate({ model, contents, responseSchema, systemInstruction, generationConfig = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fake } = {}) {
    if (!MODELS.includes(model)) throw new TypeError(`vertex: unknown model "${model}"`);
    if (!responseSchema || typeof responseSchema !== 'object') throw new TypeError('vertex: responseSchema is required');
    const turns = typeof contents === 'string' ? [{ role: 'user', parts: [{ text: contents }] }] : contents;
    if (!Array.isArray(turns) || !turns.length) throw new TypeError('vertex: contents is required');

    const body = {
      contents: turns,
      generationConfig: { ...generationConfig, responseMimeType: 'application/json', responseSchema },
    };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: String(systemInstruction) }] };

    if (fake || env.LAB_FAKE_AI === '1') {
      const json = typeof fake === 'function' ? await fake(body) : sampleFor(responseSchema);
      return { json, usage: { inputTokens: 100, outputTokens: 50 }, model, fake: true };
    }

    const bearer = await accessToken();
    let r;
    let text;
    try {
      r = await doFetch(ENDPOINT(model), {
        method: 'POST',
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await r.text();
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new VertexError('timeout', 'Gemini took too long.');
      throw new VertexError('http', 'Could not reach Gemini.');
    }
    if (text.length > MAX_BODY) throw new VertexError('too-large', 'Gemini answered with too much.');
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) token = null;
      throw new VertexError('http', `Gemini answered ${r.status}.`, r.status);
    }
    let data;
    try { data = JSON.parse(text); } catch { throw new VertexError('bad-json', 'Gemini sent something unreadable.'); }
    const usage = usageOf(data.usageMetadata);
    const cand = Array.isArray(data.candidates) ? data.candidates[0] : null;
    const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
    const out = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
    if (!out) {
      const e = new VertexError('blocked', 'Gemini gave no answer.');
      e.usage = usage; // still billed: record it
      throw e;
    }
    let json;
    try { json = JSON.parse(out); } catch {
      const e = new VertexError('bad-json', 'Gemini sent something unreadable.');
      e.usage = usage;
      throw e;
    }
    return { json, usage, model };
  }

  return { generate, MODELS: [...MODELS] };
}

module.exports = { create, sampleFor, usageOf, VertexError, MODELS, ENDPOINT, TOKEN_URL };
