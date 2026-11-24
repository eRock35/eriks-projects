// "Find relationships" for a company looked up on request.
//
// CLAUDE PICKS, THE VERIFIER DECIDES. The model is never a source. It is
// shown sentences taken from the company's own latest annual report - the
// ones that name another company and use a relationship word, found by the
// same reader the build's extract step uses - and asked which of them state
// a competitor, customer, supplier or partner, and to copy the words. Every
// answer then goes through tools/verify.js checkEdge, the build's own rule:
// the quote must be in the report's text word for word, must itself name the
// other company, and the document must be the speaker's own. Whatever fails
// is dropped and counted; nothing the model says is shown on its word.
//
// What is kept: the edges (each with the build's proof hash, sha256 of the
// source text's hash and the quote) and the sentences that were sent - a few
// dozen, bounded - so a kept quote can be re-checked on every read without
// the report. The report itself is read in memory and never stored.

const sec = require('../tools/sec');
const T = require('../tools/text');
const V = require('../tools/verify');
const E = require('../tools/extract');
const { FILERS, OTHERS, byId: SET_BY_ID } = require('../tools/companies');
const Names = require('./names');
const { LookupError, SET } = require('./lookup');

const VERSION = 1;
const MODEL = 'claude-haiku-5-5';
const TYPES = ['competitor', 'customer', 'supplier', 'partner'];
const MAX_SENTENCES = 60;            // sent to the model, and kept
const MAX_NAMED = 6;                 // companies listed beside one sentence
const MAX_TOKENS = 4096;
const MB = 1024 * 1024;
// The audit firms are on the reviewed map through the Auditor link, which
// is curated by hand; they are not looked for here.
const AUDITORS = new Set(['DELOITTE', 'PWC', 'EY', 'KPMG', 'BDO']);

const SYSTEM = [
  'You read sentences copied word for word from one company\'s annual report. That company is the speaker.',
  'Each numbered sentence names one or more other companies, listed under it as id = name.',
  'Decide which sentences plainly state that a named company is, to the speaker: a competitor; a customer; a supplier (a vendor, manufacturer, licensor or provider the speaker buys from or relies on); or a partner (a stated alliance, joint venture or collaboration).',
  'Keep only what the sentence itself says. Leave out lawsuits, acquisitions and sales of businesses, investments, lenders and credit facilities, auditors, former parents, directors\' biographies, index or peer-group lists, and anything you only know from elsewhere.',
  'For each one kept give: n, the sentence number; counterparty, one id from that sentence\'s list; type; and quote, a passage copied character for character from that sentence, 600 characters at most, that contains the counterparty\'s name exactly as the sentence writes it. Never fix, shorten inside, or reword a quote.',
  'If no sentence qualifies, return an empty list.',
].join('\n');

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['edges'],
  properties: {
    edges: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['n', 'counterparty', 'type', 'quote'],
        properties: { n: { type: 'integer' }, counterparty: { type: 'string' }, type: { type: 'string', enum: TYPES }, quote: { type: 'string' } },
      },
    },
  },
};

/** What is sent: the speaker, then each sentence with the companies it names. */
function prompt(speaker, passages) {
  const parts = [`Speaker: ${speaker}`];
  for (const p of passages) parts.push(`[${p.n}] ${p.sentence}\nNamed: ${p.named.map((x) => `${x.id} = ${x.name}`).join('; ')}`);
  return parts.join('\n\n');
}

function request(speaker, passages) {
  return {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // A reading job, not a reasoning one: thinking stays off and effort low.
    thinking: { type: 'disabled' },
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt(speaker, passages) }],
  };
}

/** The model's answer as a list of proposals; anything unreadable is none. */
function proposalsOf(res) {
  if (!res || res.stop_reason === 'refusal' || !Array.isArray(res.content)) return [];
  const text = res.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  let json;
  try { json = JSON.parse(text); } catch (e) { return []; }
  const list = json && Array.isArray(json.edges) ? json.edges : [];
  return list.filter((x) => x && Number.isInteger(x.n) && typeof x.counterparty === 'string' && TYPES.includes(x.type) && typeof x.quote === 'string').slice(0, 2 * MAX_SENTENCES);
}

/** One proposal -> a kept edge or {drop: why}. `passages` are the sentences
 *  that were sent; `src` the report's source record (with its text's sha). */
function decide(p, { speaker, passages, src, docId }) {
  const passage = passages.find((x) => x.n === p.n);
  if (!passage) return { drop: 'no such sentence' };
  const other = passage.named.find((x) => x.id === p.counterparty);
  if (!other) return { drop: 'that company is not named in the sentence' };
  // Who supplies whom: a supplier supplies the speaker, the speaker sells
  // to a customer; the other two have no direction.
  const [from, to] = p.type === 'supplier' ? [other.id, speaker.id] : [speaker.id, other.id];
  const e = { by: speaker.id, from, to, type: p.type, quote: p.quote, lead: null, section: null, source: docId };
  // The build's verifier, on the one sentence the model pointed at: a quote
  // cannot be stitched from two sentences.
  const res = V.checkEdge(e, {
    byId: { [speaker.id]: { id: speaker.id, name: speaker.name }, [other.id]: { id: other.id, name: other.name, aliases: other.aliases } },
    sources: { [docId]: src }, texts: { [docId]: passage.sentence }, rawTexts: { [docId]: passage.sentence }, sectionsOf: { [docId]: [] }, concentration: {},
  });
  if (!res.ok) return { drop: res.why };
  const quote = T.norm(p.quote);
  const says = { competitor: `${speaker.name}’s annual report names ${other.name} as a competitor.`, customer: `${speaker.name}’s annual report names ${other.name} as a customer.`, supplier: `${speaker.name}’s annual report names ${other.name} as a supplier or provider.`, partner: `${speaker.name}’s annual report names ${other.name} as a partner.` }[p.type];
  return { edge: { from, to, type: p.type, by: speaker.id, source: docId, section: passage.section || 'Annual report', date: src.date, quote, gloss: `${says} The sentence was picked by a model; the words were checked against the report.`, url: src.url, proof: V.proof(src.sha, quote), lookup: true }, other };
}

function create({ store, lookup, now = Date.now } = {}) {
  const running = new Map();           // cik -> the one run in flight

  /** The matcher for one speaker: the reviewed set's own aliases (as the
   *  extract step uses them) and every other registrant by rule. */
  async function matcher(selfCik) {
    const t = await lookup.tickers();
    if (!t.index) {
      const skip = new Set();
      for (const c of [...FILERS, ...OTHERS]) for (const a of c.aliases) skip.add(a.split(/\s+/).map(Names.plain).join(' '));
      t.index = Names.buildIndex(t.list.filter((e) => !SET.has(e.cik)).map((e) => ({ id: `X${e.cik}`, title: e.title })), skip);
    }
    const curated = [...FILERS, ...OTHERS].filter((c) => !AUDITORS.has(c.id)).map((c) => ({ c, res: c.aliases.map(E.aliasRe) }));
    const self = `X${selfCik}`;
    const info = new Map();            // sentence (normalised) -> [{id, name, aliases}]
    const namesIn = (sentence) => {
      const named = [];
      for (const x of curated) if (x.res.some((r) => r.test(sentence))) named.push({ id: x.c.id, name: x.c.name, aliases: x.c.aliases, layer: x.c.layer, set: true });
      const hits = {};
      for (const h of Names.find(t.index, sentence)) if (h.id !== self) (hits[h.id] = hits[h.id] || []).push(T.norm(h.surface));
      for (const [id, surfaces] of Object.entries(hits)) {
        const e = t.byCik.get(Number(id.slice(1)));
        named.push({ id, name: Names.display(e.title), aliases: [...new Set(surfaces)], cik: e.cik, ticker: e.ticker });
      }
      if (named.length) info.set(T.norm(sentence), named.slice(0, MAX_NAMED));
      return named.slice(0, MAX_NAMED).map((x) => x.id);
    };
    return { namesIn, info };
  }

  /** Stored relations for a CIK and annual report, re-checked on the way
   *  out: an edge whose quote is not in a stored sentence, or whose proof
   *  does not match, is not returned. */
  async function read(cik, accn) {
    let doc; let pas;
    try { [doc, pas] = await Promise.all([store.get('relations', String(cik)), store.get('passages', String(cik))]); } catch (e) { return null; }
    if (!doc || doc.v !== VERSION || doc.accn !== accn || !pas || pas.accn !== accn) return null;
    let out; let sentences;
    try { out = JSON.parse(doc.json); sentences = JSON.parse(pas.json).map((p) => p.sentence); } catch (e) { return null; }
    out.edges = out.edges.filter((e) => sentences.some((s) => s.includes(e.quote)) && V.proof(pas.sha, e.quote) === e.proof);
    const keep = new Set(); out.edges.forEach((e) => { keep.add(e.from); keep.add(e.to); });
    out.nodes = out.nodes.filter((n) => keep.has(n.id));
    // Which named companies have been looked up already (a link, not a button).
    await Promise.all(out.nodes.map(async (n) => { if (n.cik) n.present = Boolean(await lookup.read(n.cik)); }));
    out.at = doc.at;
    return out;
  }

  /** Run it for one looked-up company. `call(params)` makes the model call
   *  and resolves the SDK's response; `step(text)` reports progress. Returns
   *  {relations, usage} - usage null when nothing was asked of the model. */
  async function find(cik, { ip, call, step = () => {} }) {
    const got = await lookup.company(cik, { ip });
    if (got.inSet) throw new LookupError(409, 'That company is in the reviewed set; its relationships are already read by hand.', 'in-set');
    const part = got.part; const co = part.company;
    const have = await read(co.cik, co.annual.accn);
    if (have) return { relations: have, usage: null };
    // A second caller waits for the same run; the call is paid for once.
    if (running.has(co.cik)) return running.get(co.cik).then((r) => ({ relations: r.relations, usage: null }));
    const p = (async () => {
      const docId = co.annual.source;
      const src0 = part.sources[docId];
      step(`Fetching the Form ${src0.form} from sec.gov`);
      let text;
      try { text = T.htmlToText(await sec.get(src0.url, { maxBytes: 40 * MB, timeoutMs: 45000 })); } catch (e) { throw lookup.secFail(e); }
      const sha = T.sha(T.norm(text));
      const src = { ...src0, sha };
      step('Reading it for sentences that name another company');
      const m = await matcher(co.cik);
      const found = E.sentencesNaming(text, src.form, m.namesIn);
      text = null;
      const picked = found.filter((f) => f.key && f.sentence.length <= 1200).slice(0, MAX_SENTENCES);
      const passages = picked.map((f, i) => ({ n: i + 1, section: f.section, sentence: f.sentence, named: m.info.get(f.sentence) || [] })).filter((x) => x.named.length);
      const stats = { sentences: found.length, sent: passages.length, proposed: 0, kept: 0, dropped: {} };
      let usage = null; const edges = []; const nodes = new Map();
      if (passages.length) {
        step(`Asking Claude which of ${passages.length} sentences state a relationship`);
        const res = await call(request(co.name, passages));
        usage = (res && res.usage) || null;
        if (res && res.stop_reason && res.stop_reason !== 'end_turn') stats.stop = String(res.stop_reason).slice(0, 20);
        const proposals = proposalsOf(res);
        stats.proposed = proposals.length;
        step(`Checking ${proposals.length} proposed ${proposals.length === 1 ? 'quote' : 'quotes'} against the report, word for word`);
        const seen = new Set();
        for (const pr of proposals) {
          const d = decide(pr, { speaker: { id: co.id, name: co.name }, passages, src, docId });
          const key = d.edge && `${d.edge.from}>${d.edge.to}|${d.edge.type}`;
          if (d.edge && seen.has(key)) d.drop = 'said twice';
          if (d.drop) { stats.dropped[d.drop] = (stats.dropped[d.drop] || 0) + 1; continue; }
          seen.add(key);
          edges.push({ id: `x${co.cik}-${edges.length + 1}`, ...d.edge });
          const o = d.other;
          if (!o.set) nodes.set(o.id, { id: o.id, name: o.name, layer: 'lookup', filer: false, lookup: true, cik: o.cik, ticker: o.ticker });
          else if (!SET_BY_ID[o.id].cik) nodes.set(o.id, { id: o.id, name: o.name, layer: o.layer, filer: false });
        }
      }
      stats.kept = edges.length;
      const out = { v: VERSION, model: MODEL, accn: co.annual.accn, edges, nodes: [...nodes.values()], source: { id: docId, ...src }, stats };
      try {
        await store.set('passages', String(co.cik), { v: VERSION, accn: co.annual.accn, sha, json: JSON.stringify(passages.map((x) => ({ n: x.n, section: x.section, sentence: x.sentence }))) });
        await store.set('relations', String(co.cik), { v: VERSION, at: now(), accn: co.annual.accn, json: JSON.stringify(out) });
      } catch (e) { console.error('asfiled: relations not stored'); }
      const stored = await read(co.cik, co.annual.accn);
      return { relations: stored || { ...out, at: now() }, usage };
    })().finally(() => running.delete(co.cik));
    running.set(co.cik, p);
    return p;
  }

  return { find, read };
}

module.exports = { create, MODEL, TYPES, SCHEMA, SYSTEM, request, prompt, proposalsOf, decide, MAX_SENTENCES, MAX_TOKENS };
