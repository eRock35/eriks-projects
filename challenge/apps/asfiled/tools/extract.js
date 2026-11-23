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

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(sec.CACHE, 'manifest.json'), 'utf8'));
  const all = [...FILERS, ...OTHERS].map((c) => ({ id: c.id, res: c.aliases.map(aliasRe) }));
  fs.mkdirSync(path.join(sec.CACHE, 'text'), { recursive: true });
  const candidates = [];
  for (const c of FILERS) {
    const a = manifest[c.id].annual[0];
    const html = fs.readFileSync(path.join(sec.CACHE, 'docs', c.id, a.accn, a.doc), 'utf8');
    const text = T.htmlToText(html);
    const doc = `${c.id}-${a.accn}`;
    fs.writeFileSync(path.join(sec.CACHE, 'text', `${doc}.txt`), text);
    const secs = T.sections(text, a.form);
    // Sentences: split each line on a full stop followed by a capital.
    let pos = 0; let n = 0;
    for (const line of text.split('\n')) {
      const parts = line.split(/(?<=[.!?]["”)]?)\s+(?=[A-Z“"(])/);
      let off = 0;
      for (const sentence of parts) {
        const at = pos + line.indexOf(sentence, off);
        off = line.indexOf(sentence, off) + sentence.length;
        if (sentence.length < 40 || sentence.length > 1200) continue;
        const names = all.filter((x) => x.id !== c.id && x.res.some((r) => r.test(sentence))).map((x) => x.id);
        if (!names.length) continue;
        n += 1;
        candidates.push({ id: `${c.id}-${String(n).padStart(3, '0')}`, by: c.id, doc, section: T.sectionAt(secs, at), names, key: KEY.test(sentence), sentence: T.norm(sentence) });
      }
      pos += line.length + 1;
    }
    console.log(`${c.id}: ${text.length} chars, ${secs.length} headings, ${n} sentences naming a company`);
  }
  // The XBRL labels of each report, as text (one label a line): a customer
  // a report names only in its tagged data is quoted from here.
  const { unescape } = require('./xbrl');
  for (const c of FILERS) {
    const a = manifest[c.id].annual[0];
    if (!a.labels) continue;
    const xml = fs.readFileSync(path.join(sec.CACHE, 'docs', c.id, a.accn, a.labels), 'utf8');
    const lines = [...xml.matchAll(/<link:label\b[^>]*>([\s\S]*?)<\/link:label>/g)].map((m) => T.norm(unescape(m[1].replace(/<[^>]+>/g, ''))));
    fs.writeFileSync(path.join(sec.CACHE, 'text', `${c.id}-${a.accn}.labels.txt`), [...new Set(lines)].join('\n'));
  }
  // Apple's Supplier List (a PDF): pages separated by a form feed.
  const pdf = path.join(sec.CACHE, 'apple', 'Apple-Supplier-List.pdf');
  if (fs.existsSync(pdf)) {
    const buf = fs.readFileSync(pdf);
    const pages = require('./pdftext').pdfText(buf);
    const text = pages.map((p) => p.join('\n')).join('\f');
    fs.writeFileSync(path.join(sec.CACHE, 'text', 'APPLE-SUPPLIER-LIST.txt'), text);
    const made = /\/CreationDate\s*\(D:(\d{4})(\d{2})(\d{2})/.exec(buf.toString('latin1'));
    const fy = /as of the end of (fiscal year \d{4})/.exec(T.norm(text));
    manifest['APPLE-SUPPLIER-LIST'] = { url: 'https://www.apple.com/supply-chain/pdf/Apple-Supplier-List.pdf', date: made ? `${made[1]}-${made[2]}-${made[3]}` : null, period: fy ? fy[1] : null };
    fs.writeFileSync(path.join(sec.CACHE, 'manifest.json'), JSON.stringify(manifest, null, 1));
    console.log(`Apple Supplier List: ${pages.length} pages, ${manifest['APPLE-SUPPLIER-LIST'].period}, PDF dated ${manifest['APPLE-SUPPLIER-LIST'].date}`);
  }
  fs.writeFileSync(path.join(sec.CACHE, 'candidates.json'), JSON.stringify(candidates, null, 1));
  console.log(`${candidates.length} candidate sentences -> ${path.join(sec.CACHE, 'candidates.json')}`);
}

main();
