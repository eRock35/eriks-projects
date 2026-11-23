// Prompt caching for the whole lab, from the host (2026-11-23, CLAUDE.md
// "Prompt caching from the host"). Off unless LAB_CLAUDE_CACHE=1.
//
// Every app builds its client from the host's shared SDK, and the host
// already swaps the SDK's Anthropic class for federation (lib/claude-auth.js).
// This adds one more thin subclass on top of whatever class is there, so it
// composes with federation and with a member's own key (BYOK) alike: it only
// edits the request body, never the auth.
//
// What it does to a messages.create / messages.stream request:
//   - nothing, if the request already has any cache_control of its own
//     (top level, tools, system or messages) - the app has decided;
//   - nothing, if the model's minimum cacheable prefix is not met by
//     system + tools (estimated at 4 characters a token, which undercounts,
//     so a borderline prompt is left alone), or the model is unknown;
//   - nothing, the FIRST time a given model+tools+system prefix is seen in
//     the last 5 minutes. A breakpoint costs a 1.25x write; a prefix that
//     differs on every request (a date, a name in the system prompt) would
//     pay that premium every time and never read it back. So a prefix is
//     only marked once it has repeated, which is exactly when a read can
//     follow. One uncached request per idle prefix is the price.
//   - otherwise: cache_control {type:'ephemeral'} on the LAST system block
//     (a string system becomes one text block). That caches tools + system
//     together (render order is tools -> system -> messages). Exactly one
//     breakpoint, so the 4-breakpoint limit is never in play.
// The caller's params object is never mutated.
//
// The lab's monthly cap: apps report input/output tokens to the guard, and
// with a host-added breakpoint input_tokens no longer counts the cached
// prefix. So for a lab-key call this module marked, it records the cache
// part itself (guard.record, app "lab-cache"), and tags the usage object so
// a later priceUsd({ usage }) does not count it twice. A BYOK call is the
// member's own spend and is not recorded. The identity ledger (meter /
// recordUsage) prices the whole usage object and needs nothing from here.

const crypto = require('crypto');

// Minimum cacheable prefix, tokens (Claude API skill, shared/prompt-caching.md).
const MIN_TOKENS = {
  'claude-opus-5-5': 512, 'claude-opus-5': 512, 'claude-sonnet-5-5': 512, 'claude-haiku-5-5': 512,
  'claude-fable-5': 512, 'claude-fable-5-1': 512, 'claude-fable-5-2': 512,
  'claude-mythos-5': 512, 'claude-mythos-5-1': 512, 'claude-mythos-5-2': 512,
  'claude-opus-4-8': 1024, 'claude-sonnet-5': 1024, 'claude-sonnet-4-6': 1024, 'claude-sonnet-4-5': 1024,
  'claude-opus-4-7': 2048,
  'claude-opus-4-6': 4096, 'claude-opus-4-5': 4096, 'claude-haiku-4-5': 4096,
};
const CHARS_PER_TOKEN = 4;
const SEEN_MS = 5 * 60 * 1000;
const SEEN_MAX = 500;
const CHARGED = Symbol.for('lab.claudeCache.charged');

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Does the request carry any cache_control of its own? */
function hasOwnBreakpoint(p) {
  if (!p || typeof p !== 'object') return false;
  if (p.cache_control) return true;
  const blocks = (x) => (Array.isArray(x) ? x : []);
  if (blocks(p.tools).some((t) => t && t.cache_control)) return true;
  if (blocks(p.system).some((b) => b && b.cache_control)) return true;
  for (const m of blocks(p.messages)) {
    if (m && m.cache_control) return true;
    if (blocks(m && m.content).some((b) => b && b.cache_control)) return true;
  }
  return false;
}

function systemChars(system) {
  if (typeof system === 'string') return system.length;
  if (!Array.isArray(system)) return 0;
  return system.reduce((n, b) => n + (b && typeof b.text === 'string' ? b.text.length : 0), 0);
}

function create({ env = process.env, now = () => Date.now() } = {}) {
  const on = env.LAB_CLAUDE_CACHE === '1';
  const seen = new Map();          // prefix hash -> last seen (ms)
  const stats = { marked: 0, firstSeen: 0, short: 0, own: 0 };

  function repeated(key) {
    const t = now();
    const last = seen.get(key);
    seen.delete(key);
    seen.set(key, t);              // most recent last, so the oldest goes first
    if (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value);
    return last !== undefined && t - last < SEEN_MS;
  }

  /** The request to send, and whether a breakpoint was added. Pure apart from the seen-map. */
  function prepare(params) {
    if (!on || !params || typeof params !== 'object') return { params, marked: false };
    const min = has(MIN_TOKENS, params.model) ? MIN_TOKENS[params.model] : null;
    if (!min || params.system == null || params.system === '' || (Array.isArray(params.system) && !params.system.length)) return { params, marked: false };
    if (hasOwnBreakpoint(params)) { stats.own += 1; return { params, marked: false }; }
    const toolsJson = Array.isArray(params.tools) && params.tools.length ? JSON.stringify(params.tools) : '';
    const tokens = (systemChars(params.system) + toolsJson.length) / CHARS_PER_TOKEN;
    if (tokens < min) { stats.short += 1; return { params, marked: false }; }
    const key = crypto.createHash('sha256').update(JSON.stringify([params.model, toolsJson, params.system])).digest('base64');
    if (!repeated(key)) { stats.firstSeen += 1; return { params, marked: false }; }
    const blocks = typeof params.system === 'string' ? [{ type: 'text', text: params.system }] : params.system.slice();
    const last = blocks.length - 1;
    blocks[last] = { ...blocks[last], cache_control: { type: 'ephemeral' } };
    stats.marked += 1;
    return { params: { ...params, system: blocks }, marked: true };
  }

  /** Record the cache part of a marked lab-key call against the lab's cap. */
  function chargeCache(model, usage, guard) {
    try {
      if (!usage || !guard || typeof guard.priceUsd !== 'function' || typeof guard.record !== 'function') return;
      if (!usage.cache_creation_input_tokens && !usage.cache_read_input_tokens) return;
      const whole = { input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, cache_creation_input_tokens: usage.cache_creation_input_tokens || 0, cache_read_input_tokens: usage.cache_read_input_tokens || 0 };
      if (usage.cache_creation) whole.cache_creation = usage.cache_creation;
      const usd = guard.priceUsd({ provider: 'claude', model, usage: whole })
        - guard.priceUsd({ provider: 'claude', model, inputTokens: whole.input_tokens, outputTokens: whole.output_tokens });
      Object.defineProperty(usage, CHARGED, { value: true, enumerable: false });
      if (usd > 0) Promise.resolve(guard.record({ provider: 'claude', app: 'lab-cache', usd })).catch(() => {});
    } catch (e) { /* never let accounting break the call */ }
  }

  /** Wrap one client's messages.create / messages.stream. */
  function wrap(client, { lab = false, guard = () => global.LAB_AI_GUARD } = {}) {
    const msgs = client && client.messages;
    if (!msgs || typeof msgs.create !== 'function') return client;
    const charge = (model, res) => { if (lab && !client.__byok && res && res.usage) chargeCache(model, res.usage, guard()); };
    const create = msgs.create.bind(msgs);
    msgs.create = (params, ...rest) => {
      const { params: p, marked } = prepare(params);
      const out = create(p, ...rest);
      if (marked && !p.stream) Promise.resolve(out).then((res) => charge(p.model, res), () => {});
      return out;
    };
    if (typeof msgs.stream === 'function') {
      const stream = msgs.stream.bind(msgs);
      // stream() goes through create(); marking here first means create()
      // sees the breakpoint and leaves the request alone.
      msgs.stream = (params, ...rest) => {
        const { params: p, marked } = prepare(params);
        const s = stream(p, ...rest);
        if (marked && s && typeof s.finalMessage === 'function') Promise.resolve(s.finalMessage()).then((res) => charge(p.model, res), () => {});
        return s;
      };
    }
    return client;
  }

  /** Swap the SDK's class (federated or not) for one whose clients cache. Idempotent. */
  function install(sdkClientModule, labKey = env.ANTHROPIC_API_KEY) {
    if (!on) return false;
    const Base = sdkClientModule.Anthropic;
    if (!Base || Base.__labCached) return Boolean(Base && Base.__labCached);
    class LabCachedAnthropic extends Base {
      constructor(opts = {}) {
        super(opts);
        wrap(this, { lab: Boolean(labKey && opts && opts.apiKey === labKey && !opts.authToken) });
      }
    }
    Object.defineProperty(LabCachedAnthropic, 'name', { value: 'Anthropic' });
    LabCachedAnthropic.__labCached = true;
    if (Base.__labFederated) LabCachedAnthropic.__labFederated = true;
    sdkClientModule.Anthropic = LabCachedAnthropic;
    return true;
  }

  function status() { return { on, ...stats, prefixes: seen.size }; }

  return { on, prepare, wrap, install, status, chargeCache };
}

module.exports = { create, MIN_TOKENS, CHARGED, hasOwnBreakpoint };
