#!/usr/bin/env node
// The verifier. Two jobs:
//
//   1. At build time (required by tools/build.js): decide, edge by edge,
//      whether a curated relationship may reach the app. The rule is the
//      whole point of the app:
//
//        AN EDGE IS KEPT ONLY IF ITS QUOTE IS IN THE CACHED SOURCE WORD FOR
//        WORD (whitespace aside), AND THE QUOTE ITSELF NAMES THE OTHER
//        COMPANY. Anything else is dropped, with the reason reported.
//
//   2. Run directly (`node tools/verify.js`): re-check the COMMITTED
//      dataset against the cache - every quote, every lead-in, every figure -
//      and exit 1 on the first thing that does not match. The app's tests
//      run this whenever the cache is present.

const fs = require('fs');
const path = require('path');
const T = require('./text');
const sec = require('./sec');

const TYPES = ['supplier', 'customer', 'service', 'partner', 'investor', 'competitor'];
const proof = (sourceSha, quote) => T.sha(`${sourceSha}\n${T.norm(quote)}`);

function aliasRe(a) {
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`);
}
const names = (company, quote) => (company.aliases || [company.name]).some((a) => aliasRe(a).test(quote));

/** One curated entry can state several relationships (a list of
 *  competitors, say): one edge per pair, all resting on the same quote. */
function expand(curated, companies) {
  const annual = Object.fromEntries(companies.map((c) => [c.id, c.annual.source]));
  const out = [];
  for (const e of curated) {
    const source = e.doc || (e.source === 'xbrl' ? `${annual[e.by]}.labels` : annual[e.by]);
    for (const [from, to] of e.pairs) out.push({ by: e.by, from, to, type: e.type, quote: e.quote, lead: e.lead || null, section: e.section || null, gloss: e.gloss || '', source, xbrl: e.source === 'xbrl', tripwire: Boolean(e.tripwire) });
  }
  return out;
}

/** Position of normalised offset `at` in the raw text. */
function rawOffset(raw, at) {
  let n = 0; let space = true; let started = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ws = /[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(raw[i]);
    if (ws) { if (started && !space) { n += 1; space = true; } continue; }
    if (n >= at) return i;
    started = true; space = false; n += 1;
  }
  return raw.length;
}

function checkEdge(e, ctx) {
  const fail = (why) => ({ ok: false, why });
  if (!TYPES.includes(e.type)) return fail('unknown relationship type');
  const a = ctx.byId[e.from]; const b = ctx.byId[e.to]; const by = ctx.byId[e.by];
  if (!a || !b || !by || e.from === e.to) return fail('unknown company');
  if (e.by !== e.from && e.by !== e.to) return fail('the speaker is not one of the two companies');
  const src = ctx.sources[e.source];
  const text = ctx.texts[e.source];
  if (!src || !text) return fail('its source is not in the cache');
  if (src.by !== e.by) return fail('the source is not the speaker’s own document');
  const q = T.norm(e.quote);
  if (q.length < 8 || q.length > 620) return fail('the quote is too short or too long');
  const at = text.indexOf(q);
  if (at < 0) return fail('quote not found verbatim in the source');
  const other = e.by === e.from ? b : a;
  if (!names(other, q)) return fail(`the quote does not name ${other.name}`);
  if (e.lead) {
    const l = T.norm(e.lead);
    const lat = text.lastIndexOf(l, at);
    if (lat < 0 || at - lat > 4000) return fail('lead-in not found verbatim just before the quote');
  }
  let section;
  if (src.kind === 'xbrl') {
    const hit = (ctx.concentration[e.by] || []).filter((x) => T.norm(x.raw) === q).sort((p, r) => r.fy - p.fy)[0];
    if (!hit) return fail('no tagged customer figure carries that label');
    return { ok: true, section: 'XBRL data: concentration risk, major customers', fig: hit.id };
  }
  const raw = ctx.rawTexts[e.source] || '';
  const pos = rawOffset(raw, at);
  if (src.kind === 'supplier-list') {
    section = `Supplier List, page ${raw.slice(0, pos).split('\f').length}`;
  } else if (e.section) {
    const s = T.norm(e.section);
    const sat = text.lastIndexOf(s, at);
    if (sat < 0 || at - sat > 30000) return fail('the named section heading is not found before the quote');
    section = s;
  } else {
    ctx.sectionsOf[e.source] = ctx.sectionsOf[e.source] || T.sections(raw, src.form);
    section = T.sectionAt(ctx.sectionsOf[e.source], pos) || 'Annual report';
  }
  return { ok: true, section };
}

/** Re-check a built dataset against the cache. Returns a list of problems. */
function recheck(data) {
  const problems = [];
  const texts = {};
  for (const [id, src] of Object.entries(data.sources)) {
    const raw = T.sourceText(id);
    if (raw === null) { problems.push(`${id}: not in the cache`); continue; }
    texts[id] = T.norm(raw);
    if (T.sha(texts[id]) !== src.sha) problems.push(`${id}: the cached text has changed since the dataset was built (rebuild)`);
  }
  for (const e of data.edges) {
    const text = texts[e.source];
    if (!text) { problems.push(`${e.id}: no source text`); continue; }
    if (!text.includes(T.norm(e.quote))) problems.push(`${e.id} ${e.from}->${e.to}: quote not found verbatim`);
    if (e.lead && !text.includes(T.norm(e.lead))) problems.push(`${e.id}: lead-in not found verbatim`);
    if (proof(data.sources[e.source].sha, e.quote) !== e.proof) problems.push(`${e.id}: proof does not match its quote`);
  }
  const facts = {}; const inst = {};
  const manifest = JSON.parse(fs.readFileSync(path.join(sec.CACHE, 'manifest.json'), 'utf8'));
  const X = require('./xbrl');
  for (const [id, f] of Object.entries(data.figures)) {
    if (f.x) {
      const a = manifest[f.c].annual[0];
      inst[f.c] = inst[f.c] || X.readInstance(path.join(sec.CACHE, 'docs', f.c, a.accn, a.instance)).facts;
      const ok = inst[f.c].some((x) => x.ctx.end === f.end && (x.val === f.v || (f.m === 'conc' && /÷/.test(f.tag))));
      if (!ok) problems.push(`${id}: no such value in the report's XBRL instance`);
      continue;
    }
    facts[f.c] = facts[f.c] || JSON.parse(fs.readFileSync(path.join(sec.CACHE, 'facts', `${f.c}.json`), 'utf8'));
    const [tax, tag] = f.tag.split(':');
    const rows = (((facts[f.c].facts[tax] || {})[tag] || {}).units || {})[f.u] || [];
    if (!rows.some((r) => r.accn === f.a && r.end === f.end && r.val === f.v)) problems.push(`${id}: ${f.tag} ${f.end} = ${f.v} is not in ${f.a}`);
  }
  return problems;
}

module.exports = { TYPES, proof, expand, checkEdge, recheck, names, aliasRe };

if (require.main === module) {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'dataset.json'), 'utf8'));
  const problems = recheck(data);
  if (problems.length) { console.error(problems.slice(0, 40).join('\n')); console.error(`${problems.length} problem(s).`); process.exit(1); }
  console.log(`verified against the cache: ${data.edges.length} edges, ${Object.keys(data.figures).length} figures, ${Object.keys(data.sources).length} sources`);
}
