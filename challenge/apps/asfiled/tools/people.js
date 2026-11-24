// How many people a company says it employs: one sentence of its annual
// report, quoted word for word, with the number in it.
//
// `findEmployees` proposes a sentence by a strict rule; it decides nothing.
// For the reviewed companies the proposals were read by hand and the kept
// ones are in tools/curated-employees.json; for a company looked up on
// request the proposal goes straight to the same check. Either way
// tools/verify.js `checkQuote` is what lets a sentence through: it must be
// in the report word for word, and the number must be in the sentence,
// whole, right before the word for the workforce.

const T = require('./text');

const NUM = '([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{3,6})';
const WHO = '(?:employees|EMPLOYEES|people|persons|team members|associates|colleagues|coworkers|workers)';
// "had approximately 42,000 [full-time] employees", "employed 31,360 people",
// "workforce of 78,865 employees", "headcount was 15,109 employees".
const SAYS = new RegExp(`\\b(?:had|have|has|employed|employ|employs|workforce (?:of|consisted of|consists of|totaled)|headcount was|team includes)\\s+(?:a total of\\s+|a global workforce of\\s+)?(?:approximately|about|nearly|over|more than)?\\s*${NUM}\\s+(?:(?:regular|global|total|permanent|active)\\s+)?(?:full-time equivalent\\s+|full-time,? (?:and )?part-time(?: and temporary)?\\s+|full-time\\s+|full and part-time\\s+)?${WHO}\\b`);
const WHEN = /\b(As of|as of|At |at the end of|At the end of|end of fiscal|fiscal year end)\b/;
// A part of the workforce, or a change in it, is not the workforce.
const NOT = /reduc|restructur|sales and marketing|research and development organization|engineering organization|recogni[sz]ed|headcount increased|hired|laid off|termination|contractor workforce|joint venture/i;

const digits = (s) => Number(String(s).replace(/,/g, ''));
/** "42,000" for 42000: how a report writes a head count. */
const written = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** The first sentence of a report's text that states the workforce by the
 *  strict rule: {n, quote} or null. */
function findEmployees(text) {
  for (const line of String(text).split('\n')) {
    for (const sentence of line.split(/(?<=[.!?]["”)]?)\s+(?=[A-Z“"(])/)) {
      if (sentence.length < 30 || sentence.length > 600 || NOT.test(sentence) || !WHEN.test(sentence)) continue;
      const m = SAYS.exec(sentence);
      if (!m) continue;
      const n = digits(m[1]);
      if (n < 50) continue;
      return { n, quote: T.norm(sentence) };
    }
  }
  return null;
}

/** Whether a quote states `n` as a head count: the number, whole (not part
 *  of a longer one), followed closely by the word for the workforce. */
function statesHeadcount(quote, n) {
  if (!Number.isInteger(n) || n < 1) return false;
  for (const form of [written(n), String(n)]) {
    const re = new RegExp(`(?<![0-9,.])${form.replace(/,/g, ',')}(?![0-9]|,[0-9]|\\.[0-9])[^.;]{0,60}?\\b${WHO}\\b`);
    if (re.test(quote)) return true;
  }
  return false;
}

module.exports = { findEmployees, statesHeadcount, written };
