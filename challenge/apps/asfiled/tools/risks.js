// What is new in a company's risk factors: the risk-factor section of its
// latest annual report beside the one before, heading by heading.
//
// A "heading" is how a report itself sets out a risk: one sentence on a
// line of its own, followed by the paragraphs that discuss it. Each heading
// of the newer report is compared with the older report's risk section:
//
//   same      - the same words (case and punctuation aside)
//   reworded  - a heading or sentence of the older section shares at least
//               THRESHOLD of its word pairs (Dice coefficient on adjacent
//               word pairs): a few changed words are a rewording, not a new risk
//   new       - nothing in the older section comes that close
//
// and the other way round for headings that are no longer there. It is
// deliberately conservative: where the section cannot be found in both
// reports, or the two are laid out too differently to line up, nothing is
// compared and the page says so. Every heading shown is quoted word for
// word and goes through tools/verify.js `checkQuote` like any other quote.

const T = require('./text');

const THRESHOLD = 0.5;
const MIN_SECTION = 15000;             // characters: anything shorter is a cross-reference, not the section
const MIN_HEADINGS = 8;
const MAX_LISTED = 24;

// Reports that do not use "Item 1A." headings in their body (Intel, ASML):
// the section starts at a line that is just "Risk Factors" followed by
// prose, and ends at the first of these lines after it.
const NEXT = /^(Other Key Information|Sales and Marketing|Information About Our Executive Officers|Quantitative and Qualitative Disclosures About Market Risk|Cybersecurity|Properties|Legal Proceedings|Unresolved Staff Comments|Market for Our Common Stock|Controls and Procedures)$/;

/** The risk-factor section of a report's raw text: {start, end} (offsets), or null. */
function riskSection(text, form) {
  const secs = T.sections(text, form);
  const want = form === '20-F' ? /^Item 3\./ : /^Item 1A\./;
  let best = null;
  secs.forEach((s, i) => {
    if (!want.test(s.label)) return;
    let end = text.length;
    for (let j = i + 1; j < secs.length; j += 1) if (secs[j].label !== s.label) { end = secs[j].pos; break; }
    if (!best || end - s.pos > best.end - best.start) best = { start: s.pos, end };
  });
  if (best && best.end - best.start >= MIN_SECTION) {
    if (form === '20-F') {
      // Item 3 is "Key Information"; its risk factors start at their own heading.
      const m = /^Risk Factors\s*$/im.exec(text.slice(best.start, best.end));
      if (m) best.start += m.index;
    }
    return best;
  }
  // No usable item heading: a line that is just "Risk Factors", followed by prose.
  const lines = text.split('\n');
  let pos = 0; let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (start < 0 && /^Risk Factors$/.test(lines[i].trim()) && (lines[i + 1] || '').length >= 60) start = pos;
    else if (start >= 0 && NEXT.test(lines[i].trim()) && pos - start >= MIN_SECTION) return { start, end: pos };
    pos += lines[i].length + 1;
  }
  return null;
}

const SENT = /(?<=[.!?]["”)]?)\s+(?=[A-Z“"(])/;
const oneSentence = (line) => !/[.!?]["”)]?\s+[A-Z“"(]/.test(line.replace(/\b(U\.S|U\.K|Inc|Corp|Ltd|No|vs|e\.g|i\.e)\.\s/g, '$1 '));
// A sentence that carries on from the one before is discussion, not a heading.
const CONTINUES = /^(In addition|In the event|For example|For instance|Additionally|Further|Furthermore|Moreover|However|These|This|Such|As a result|Unless|Any of these|Although|While|Also|Similarly|Accordingly|Therefore|Finally|See|Refer)\b/;

/** The headings of a risk section: one-sentence lines, each followed by a longer line. */
function headings(section) {
  const lines = section.split('\n').map((l) => l.trim()).filter((l) => l.length >= 3 && !/^\d{1,3}$/.test(l) && !/^(Table of Contents|Risk Factors)$/i.test(l));
  const out = [];
  for (let i = 0; i < lines.length - 1; i += 1) {
    const l = lines[i].replace(/^[•▪●■-]\s*/, '');
    if (l.length < 40 || l.length > 400 || !/^[A-Z“"]/.test(l) || !/[.!?]["”)]?$/.test(l) || !oneSentence(l) || CONTINUES.test(l)) continue;
    const next = lines[i + 1];
    if (next.length < Math.max(250, l.length * 1.5)) continue;
    out.push(l);
  }
  return [...new Set(out)];
}
/** Every sentence of a section (for "does anything here come close?"). */
function sentences(section) {
  const out = [];
  for (const line of section.split('\n')) for (const s of line.split(SENT)) if (s.length >= 30) out.push(s.trim());
  return out;
}

const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
const key = (s) => words(s).join(' ');
function pairs(s) { const w = words(s); const set = new Set(); for (let i = 0; i < w.length - 1; i += 1) set.add(`${w[i]} ${w[i + 1]}`); return set; }
/** Dice coefficient on adjacent word pairs: 1 for the same words in the same order, 0 for nothing shared. */
function similarity(a, b) {
  const A = a instanceof Set ? a : pairs(a); const B = b instanceof Set ? b : pairs(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n += 1;
  return (2 * n) / (A.size + B.size);
}

/** Compare two reports' risk sections. `now` and `before` are raw texts. */
function compare(now, before, form) {
  const sn = riskSection(now, form); const sb = riskSection(before, form);
  if (!sn || !sb) return { compared: false, why: 'The risk-factor section could not be found in both reports.' };
  const tn = now.slice(sn.start, sn.end); const tb = before.slice(sb.start, sb.end);
  const hn = headings(tn); const hb = headings(tb);
  if (hn.length < MIN_HEADINGS || hb.length < MIN_HEADINGS) return { compared: false, why: 'The risk factors of one or both reports are not set out as headings this reader can line up.' };
  const close = (list, others, otherSentences, otherHeadings) => {
    const keys = new Set(otherHeadings.map(key));
    const sp = otherSentences.map(pairs); const hp = otherHeadings.map(pairs);
    const res = { same: 0, reworded: [], gone: [] };
    for (const h of list) {
      if (keys.has(key(h))) { res.same += 1; continue; }
      const p = pairs(h);
      let best = 0; let bi = -1;
      hp.forEach((x, i) => { const s = similarity(p, x); if (s > best) { best = s; bi = i; } });
      let any = best;
      if (any < THRESHOLD) for (const x of sp) { const s = similarity(p, x); if (s > any) any = s; if (any >= THRESHOLD) break; }
      if (best >= THRESHOLD) res.reworded.push({ quote: h, was: otherHeadings[bi], sim: Math.round(best * 100) / 100 });
      else if (any >= THRESHOLD || others.includes(T.norm(h))) res.same += 0, res.moved = (res.moved || 0) + 1;
      else res.gone.push(h);
    }
    return res;
  };
  const fwd = close(hn, T.norm(tb), sentences(tb), hb);
  const back = close(hb, T.norm(tn), sentences(tn), hn);
  // Too many "new" ones means the two reports are laid out differently, not that the risks changed.
  if (fwd.gone.length > hn.length * 0.5 || back.gone.length > hb.length * 0.5) return { compared: false, why: 'The two reports set out their risk factors too differently to compare heading by heading.' };
  return {
    compared: true, threshold: THRESHOLD,
    counts: { now: hn.length, before: hb.length, same: fwd.same, reworded: fwd.reworded.length, elsewhere: fwd.moved || 0, new: fwd.gone.length, removed: back.gone.length },
    new: fwd.gone.slice(0, MAX_LISTED), removed: back.gone.slice(0, MAX_LISTED),
    reworded: fwd.reworded.sort((a, b) => a.sim - b.sim).slice(0, 12),
    ranges: { now: sn, before: sb },
  };
}

/** A section's [start, end) in the normalised text (what checkQuote wants). */
function normRange(raw, sec) {
  const start = T.norm(raw.slice(0, sec.start)).length;
  return [Math.max(0, start - 1), start + T.norm(raw.slice(sec.start, sec.end)).length + 2];
}

module.exports = { THRESHOLD, MAX_LISTED, riskSection, headings, sentences, similarity, compare, normRange, key };
