// Finding other SEC registrants named in a sentence, conservatively.
//
// The reviewed set has hand-picked aliases (tools/companies.js). For a
// company looked up on request there is nobody to pick them, so a name here
// comes from the SEC's own registrant list (company_tickers) by rule, and
// the rule errs toward missing a company rather than inventing one:
//
//   - legal endings are dropped ("Inc", "Corp", "Holdings", "/DE/"), and
//     what is left must be either two or more words (eight letters or more
//     in all), or one word of six letters or more that is not a common word;
//   - a ticker is never a name ("ON", "IT", "ALL" are words);
//   - in the sentence every word of the name must start with a capital, and
//     a one-word name does not count as the sentence's first word;
//   - a name two registrants share is nobody's.
//
// A match is only a CANDIDATE. Nothing here says a relationship exists: the
// sentence still has to be chosen, and every quote passes tools/verify.js.

const ENDINGS = new Set(['inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'companies', 'ltd', 'limited', 'plc', 'llc', 'lp', 'sa', 'nv', 'ag', 'se', 'ab', 'asa', 'spa', 'bv', 'holdings', 'holding', 'group', 'trust', 'adr', 'de', 'new', 'the', 'cos', 'intl', 'international', 'worldwide', 'global', 'enterprises', 'industries', 'technologies', 'technology', 'systems', 'solutions', 'partners']);
// Endings that are dropped only when something distinctive is left.
const SOFT = new Set(['international', 'worldwide', 'global', 'enterprises', 'industries', 'technologies', 'technology', 'systems', 'solutions', 'partners', 'intl', 'trust', 'new', 'group', 'holdings', 'holding']);
const JOIN = new Set(['of', 'and', '&', 'the', 'for', 'de', 'la']);
// One-word names that are also ordinary words (or places, or first names).
const COMMON = new Set(('target progressive discover carnival republic frontier national general american united first international global digital service services energy partners capital financial federal southern northern western eastern pacific atlantic central premier summit pioneer liberty alliance reliance standard universal continental dominion match square block unity amplitude confluent elastic fastly marathon insight insights express compass vertex vector matrix nucleus catalyst element enterprise enterprises equity essential evergreen exact focus franklin genesis guardian harmony horizon hudson ideal impact infinity innovative integral intrepid keystone kinetic landmark legacy lincoln magnolia mission momentum monarch mosaic navigator noble option origin paragon patriot phoenix pinnacle platform premium prospect quantum radiant ranger regency renaissance resolute select sentinel signature sovereign spectrum spirit sprout sterling strategic superior synergy triumph trinity valley vantage venture victory village vision vistra voyager washington jackson madison hamilton douglas columbia cambridge oxford america canada mexico europe pacific arizona texas florida georgia virginia carolina montana nevada oregon alaska hawaii indiana kansas dakota research holdings company corporation management resources materials products industries systems solutions technologies technology networks network software security mobile online payments payment credit consumer commercial industrial medical health healthcare pharma biotech science sciences education learning realty property properties housing storage transport transportation logistics shipping airlines airways motors electric power water natural mining metals steel chemical chemicals plastics packaging paper forest timber foods beverage brands retail stores markets exchange investors investment investments advisors bancorp bancshares savings mutual insurance assurance casualty annuity pension reserve treasury markets clearing agency bureau reports reporting analytics verification identity workforce employer employers lenders lending mortgage banking business customer customers supplier suppliers partner competitor competitors report annual quarter fiscal december january february october november september august').split(' '));

/** A word as compared: lower case, no dots, apostrophes or hyphens. */
const plain = (w) => w.toLowerCase().replace(/[.'’-]/g, '');

const STATE = /\s*[\\/][A-Za-z]{2,4}[\\/]?\s*$/;        // "/DE/", "\\NEW\\" after a name

function acceptable(toks) {
  if (!toks.length || toks.length > 6) return false;
  const letters = toks.join('').length;
  if (toks.length === 1) return letters >= 6 && !COMMON.has(toks[0]) && !ENDINGS.has(toks[0]) && !/^\d+$/.test(toks[0]);
  if (letters < 8) return false;
  if (toks.every((x) => COMMON.has(x) || JOIN.has(x) || ENDINGS.has(x))) return false;
  return !JOIN.has(toks[0]) && !JOIN.has(toks[toks.length - 1]);
}

/** A registrant's title -> the word lists that name it (longest first), or
 *  none when the rule above says the name is too short or too ordinary to
 *  look for. "Quillfeather Systems Inc" is looked for as "Quillfeather
 *  Systems" and as "Quillfeather"; "Global Payments Inc" only whole. */
function coresOf(title) {
  let words = String(title || '').replace(STATE, ' ').replace(/[,()"]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.length && plain(words[0]) === 'the') words = words.slice(1);
  const out = [];
  const add = (ws) => { const toks = ws.map(plain).filter(Boolean); if (acceptable(toks) && !out.some((o) => o.join(' ') === toks.join(' '))) out.push(toks); };
  while (words.length > 1 && ENDINGS.has(plain(words[words.length - 1]))) {
    const last = plain(words[words.length - 1]);
    // A soft ending ("Systems", "Global") is part of the name people write.
    if (SOFT.has(last)) add(words);
    words = words.slice(0, -1);
  }
  add(words);
  return out;
}
const coreOf = (title) => coresOf(title)[0] || null;

/** entries: [{id, title}] -> an index for `find`. `skip` holds plain names
 *  already covered elsewhere (the reviewed set's own aliases). */
function buildIndex(entries, skip = new Set()) {
  const byKey = new Map();          // joined words -> entry, or null when two registrants share it
  for (const e of entries) {
    for (const toks of coresOf(e.title)) {
      const key = toks.join(' ');
      if (skip.has(key)) continue;
      const prev = byKey.get(key);
      byKey.set(key, byKey.has(key) && (!prev || prev.id !== e.id) ? null : { id: e.id, toks });
    }
  }
  const first = new Map();
  for (const v of byKey.values()) {
    if (!v) continue;
    if (!first.has(v.toks[0])) first.set(v.toks[0], []);
    first.get(v.toks[0]).push(v);
  }
  for (const list of first.values()) list.sort((a, b) => b.toks.length - a.toks.length);
  return { first, size: [...byKey.values()].filter(Boolean).length };
}

const WORD = /[A-Za-z0-9&]+(?:[.'’-][A-Za-z0-9&]+)*/g;
const capital = (w) => /^[A-Z0-9]/.test(w);

/** The registrants a sentence names: [{id, surface}] where `surface` is the
 *  name exactly as the sentence writes it (what a quote must then contain). */
function find(index, sentence) {
  const words = [];
  let m;
  WORD.lastIndex = 0;
  while ((m = WORD.exec(sentence))) {
    // "Equifax's" is the word Equifax; the name ends before the possessive.
    const poss = /['’]s$/i.test(m[0]) ? 2 : 0;
    words.push({ at: m.index, raw: m[0], end: m.index + m[0].length - poss, p: plain(m[0]), q: poss ? plain(m[0].slice(0, -poss)) : null });
  }
  const out = []; const seen = new Set();
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    const list = index.first.get(w.p) || (w.q && index.first.get(w.q));
    if (!list || !capital(w.raw)) continue;
    for (const cand of list) {
      const n = cand.toks.length;
      if (i + n > words.length) continue;
      if (n === 1 && i === 0) continue;
      let ok = true;
      for (let k = 0; k < n && ok; k += 1) {
        const x = words[i + k];
        const lastWord = k === n - 1;
        ok = (x.p === cand.toks[k] || (lastWord && x.q === cand.toks[k])) && (capital(x.raw) || JOIN.has(x.p));
        // Words of one name sit side by side: nothing but spaces between.
        if (ok && k > 0 && /[^\s]/.test(sentence.slice(words[i + k - 1].at + words[i + k - 1].raw.length, x.at))) ok = false;
      }
      if (!ok) continue;
      const lastW = words[i + n - 1];
      const surface = sentence.slice(w.at, lastW.q === cand.toks[n - 1] && lastW.p !== cand.toks[n - 1] ? lastW.end : lastW.at + lastW.raw.length);
      const key = `${cand.id}|${surface}`;
      if (!seen.has(key)) { seen.add(key); out.push({ id: cand.id, surface }); }
      break;
    }
  }
  return out;
}

/** An all-capitals registrant name set in ordinary case for display
 *  ("EQUIFAX INC" -> "Equifax Inc"); short words that may be initials stay. */
function display(title) {
  const t = String(title || '').replace(STATE, '').replace(/\s+/g, ' ').trim();
  if (/[a-z]/.test(t)) return t;
  return t.split(' ').map((w) => (!/[&0-9]/.test(w) && (w.length >= 4 || ENDINGS.has(plain(w)) || JOIN.has(plain(w))) ? w.charAt(0) + w.slice(1).toLowerCase() : w)).join(' ').replace(/\b(Of|And|The|For)\b/g, (x, _w, at) => (at ? x.toLowerCase() : x));
}

module.exports = { coreOf, coresOf, buildIndex, find, display, plain };
