#!/usr/bin/env node
// Step 2: turn each cached annual report into plain text, and list every
// sentence in it that names another company. Those sentences are CANDIDATES,
// written to the cache for a person to read; nothing here decides that a
// relationship exists. The kept ones are in tools/curated-edges.json.

const fs = require('fs');
const path = require('path');
const { FILERS, OTHERS } = require('./companies');
const sec = require('./sec');
const T = require('./text');

const KEY = /\b(suppl|customer|manufactur|foundr|rel(y|ies|iance)|depend|purchas|sourc|accounted for|compet|partner|licens|agreement|contract|distribut|provider|wafer|assembl|fabricat|sole|single)/i;

function aliasRe(a) {
  const esc = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`);
}

/** Every sentence of a report's text that names another company, with the
 *  section it falls in: [{section, names, key, sentence}] (plus `.sections`,
 *  the number of headings found). `namesIn(sentence)` returns the ids named.
 *  Sentences: each line split on a full stop followed by a capital. The
 *  build's extract step and the on-request lookup both read with this. */
function sentencesNaming(text, form, namesIn) {
  const secs = T.sections(text, form);
  const out = [];
  let pos = 0;
  for (const line of text.split('\n')) {
    const parts = line.split(/(?<=[.!?]["”)]?)\s+(?=[A-Z“"(])/);
    let off = 0;
    for (const sentence of parts) {
      const at = pos + line.indexOf(sentence, off);
      off = line.indexOf(sentence, off) + sentence.length;
      if (sentence.length < 40 || sentence.length > 1200) continue;
      const names = namesIn(sentence);
      if (!names.length) continue;
      out.push({ section: T.sectionAt(secs, at), names, key: KEY.test(sentence), sentence: T.norm(sentence) });
    }
    pos += line.length + 1;
  }
  out.sections = secs.length;
  return out;
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(sec.CACHE, 'manifest.json'), 'utf8'));
  const all = [...FILERS, ...OTHERS].map((c) => ({ id: c.id, res: c.aliases.map(aliasRe) }));
  fs.mkdirSync(path.join(sec.CACHE, 'text'), { recursive: true });
  const candidates = [];
  for (const c of FILERS) {
    if (!manifest[c.id]) { console.log(`${c.id}: not fetched yet`); continue; }
    const a = manifest[c.id].annual[0];
    const doc = `${c.id}-${a.accn}`;
    const raw = path.join(sec.CACHE, 'docs', c.id, a.accn, a.doc);
    const txtFile = path.join(sec.CACHE, 'text', `${doc}.txt`);
    // The raw document is read once, turned into text, and deleted: the
    // text is all the later steps read (and it is what quotes are checked
    // against). Its XBRL instance and labels stay for the build.
    let text;
    if (fs.existsSync(raw)) {
      text = T.htmlToText(fs.readFileSync(raw, 'utf8'));
      fs.writeFileSync(txtFile, text);
      fs.unlinkSync(raw);
    } else if (fs.existsSync(txtFile)) text = fs.readFileSync(txtFile, 'utf8');
    else throw new Error(`${doc}: neither the document nor its text is in the cache. Run tools/fetch.js.`);
    const found = sentencesNaming(text, a.form, (sentence) => all.filter((x) => x.id !== c.id && x.res.some((r) => r.test(sentence))).map((x) => x.id));
    const n = found.length;
    found.forEach((f, i) => candidates.push({ id: `${c.id}-${String(i + 1).padStart(3, '0')}`, by: c.id, doc, section: f.section, names: f.names, key: f.key, sentence: f.sentence }));
    const secs = { length: found.sections };
    console.log(`${c.id}: ${text.length} chars, ${secs.length} headings, ${n} sentences naming a company`);
  }
  // The XBRL labels of each report, as text (one label a line): a customer
  // a report names only in its tagged data is quoted from here.
  const { unescape } = require('./xbrl');
  for (const c of FILERS) {
    if (!manifest[c.id]) continue;
    const a = manifest[c.id].annual[0];
    if (!a.labels) continue;
    if (fs.existsSync(path.join(sec.CACHE, 'text', `${c.id}-${a.accn}.labels.txt`))) continue;
    const xml = fs.readFileSync(path.join(sec.CACHE, 'docs', c.id, a.accn, a.labels), 'utf8');
    const lines = [...xml.matchAll(/<link:label\b[^>]*>([\s\S]*?)<\/link:label>/g)].map((m) => T.norm(unescape(m[1].replace(/<[^>]+>/g, ''))));
    fs.writeFileSync(path.join(sec.CACHE, 'text', `${c.id}-${a.accn}.labels.txt`), [...new Set(lines)].join('\n'));
  }
  fs.writeFileSync(path.join(sec.CACHE, 'candidates.json'), JSON.stringify(candidates, null, 1));
  console.log(`${candidates.length} candidate sentences -> ${path.join(sec.CACHE, 'candidates.json')}`);
}

module.exports = { sentencesNaming, aliasRe, KEY };
if (require.main === module) main();
