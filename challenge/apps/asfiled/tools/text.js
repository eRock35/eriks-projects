// Filing HTML -> plain text, the one normalisation every tool shares, and
// the section a position in that text falls in.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { unescape } = require('./xbrl');
const sec = require('./sec');

/** Whitespace only: every run of whitespace (including no-break spaces)
 *  becomes one space. Nothing else is touched - not case, not punctuation,
 *  not quote marks. This is the only freedom a quote has when it is checked
 *  against its source. */
function norm(s) {
  return String(s).replace(/[\s  -   　]+/g, ' ').trim();
}

function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<ix:header\b[\s\S]*?<\/ix:header>/gi, ' ');
  s = s.replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|table|ul|ol)>|<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(td|th)>/gi, ' \t ');
  s = s.replace(/<[^>]+>/g, '');
  s = unescape(s);
  return s.split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n');
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** The cached plain text of a source document, by its id in the manifest. */
function sourceText(doc) {
  const file = path.join(sec.CACHE, 'text', `${doc}.txt`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

const ITEMS_10K = { 1: 'Business', '1A': 'Risk Factors', '1B': 'Unresolved Staff Comments', '1C': 'Cybersecurity', 2: 'Properties', 3: 'Legal Proceedings', 5: 'Market for Common Equity', 7: 'Management’s Discussion and Analysis', '7A': 'Market Risk', 8: 'Financial Statements and Notes', 9: 'Changes in and Disagreements with Accountants', '9A': 'Controls and Procedures', 10: 'Directors and Governance', 11: 'Executive Compensation', 13: 'Related Transactions', 15: 'Exhibits' };
const ITEMS_20F = { 3: 'Key Information (including Risk Factors)', 4: 'Information on the Company', 5: 'Operating and Financial Review and Prospects', 6: 'Directors, Senior Management and Employees', 7: 'Major Shareholders and Related Party Transactions', 8: 'Financial Information', 10: 'Additional Information', 11: 'Market Risk', 18: 'Financial Statements' };

/** Headings in a filing's text: [{pos, label}], in order. A heading is a
 *  line that starts "Item 1A." - the table of contents has them too, which
 *  is harmless: the body's own heading comes later and wins. */
function sections(text, form) {
  const names = form === '20-F' ? ITEMS_20F : ITEMS_10K;
  const out = [];
  const re = /^(?:PART\s+[IV]+\s*[,.\-–—]?\s*)?ITEM\s+(\d{1,2}[A-C]?)\s*[.:\-–—]/gim;
  let m;
  while ((m = re.exec(text))) {
    const n = m[1].toUpperCase();
    if (names[n]) out.push({ pos: m.index, label: `Item ${n}. ${names[n]}` });
  }
  return out;
}
function sectionAt(secs, pos) {
  let label = null;
  for (const s of secs) { if (s.pos <= pos) label = s.label; else break; }
  return label;
}

module.exports = { norm, htmlToText, sha, sourceText, sections, sectionAt };
