// Job titles, normalised so that a posting, an H-1B filing and what a person
// typed can be compared. Pure; no clock, no network.
//
//   normTitle('Sr. Director of Analytics (Remote, US)')
//     -> { title_norm: 'analytics director', seniority: 'director', core: 'analytics', level: 6.5 }
//
// title_norm is the ROLE: the core words plus the management band, if any
// (manager, director, vp, chief). IC grades (senior, staff, II, L5) are NOT in
// it - "Senior Data Scientist" and "Data Scientist II" are the same role at
// different grades, and comp is compared role to role. The grade is the
// separate `seniority`, on the ladder below.

// The ladder: a number per rung, so "how far apart" is a subtraction.
const LADDER = { intern: 0, entry: 1, mid: 2, senior: 3, staff: 4, manager: 5, director: 6, vp: 8, c_level: 10 };
const SENIORITIES = Object.keys(LADDER);
const SENIORITY_LABEL = { intern: 'Intern', entry: 'Entry level', mid: 'Mid-level', senior: 'Senior', staff: 'Staff / principal', manager: 'Manager', director: 'Director', vp: 'VP', c_level: 'C-level' };

// Words that are a grade, not part of the role.
const GRADE = new Set(['senior', 'sr', 'snr', 'junior', 'jr', 'staff', 'principal', 'lead', 'associate', 'assoc', 'intern', 'internship', 'trainee', 'graduate', 'grad', 'entry', 'level', 'mid', 'distinguished', 'fellow', 'apprentice']);
// Words that carry no role at all.
const FILLER = new Set(['of', 'the', 'for', 'a', 'an', 'to', 'at', 'in', 'and', 'or', 'with', 'team', 'role', 'position', 'job', 'opening', 'new', 'remote', 'hybrid', 'onsite', 'contract', 'contractor', 'temporary', 'temp', 'part', 'time', 'full', 'fulltime', 'parttime', 'ft', 'pt', 'us', 'usa', 'emea', 'apac', 'latam', 'americas', 'global']);
const ROMAN = new Set(['i', 'ii', 'iii', 'iv', 'v', 'vi']);
// Spellings that mean one word.
const SYNONYM = {
  mgr: 'manager', mngr: 'manager', dir: 'director', eng: 'engineer', engr: 'engineer', engineering: 'engineering', dev: 'developer',
  swe: 'software engineer', sde: 'software engineer', pm: 'product manager', tpm: 'technical program manager', ml: 'machine learning', ai: 'ai',
  analytic: 'analytics', bi: 'business intelligence', ux: 'ux', ui: 'ui', qa: 'quality assurance', hr: 'human resources', ops: 'operations',
  devops: 'devops', sre: 'site reliability engineer', fp: 'fp', svp: 'svp', evp: 'evp', avp: 'avp', ceo: 'ceo', cto: 'cto', cfo: 'cfo', coo: 'coo', cio: 'cio', cmo: 'cmo', cpo: 'cpo', cdo: 'cdo', ciso: 'ciso',
};
const C_SUITE = new Set(['ceo', 'cto', 'cfo', 'coo', 'cio', 'cmo', 'cpo', 'cdo', 'ciso', 'cro', 'chief']);

function words(s) {
  return String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, ' ')          // "(Remote, US)" and the like
    .replace(/\s[-–—|/]\s.*$/, ' ')                           // "Analyst - New York", "Engineer | Payments"
    .replace(/&/g, ' and ')
    .replace(/\bvice[\s-]+president\b/g, ' vp ')
    .replace(/\bsenior\s+vp\b/g, ' svp ')
    .replace(/\bhead\s+of\b/g, ' head ')
    .replace(/\bc\s*-\s*level\b/g, ' chief ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * @returns {title_norm, seniority, core, level}; title_norm '' for an empty title.
 */
const BAND_WORDS = new Set(['director', 'head', 'manager', 'vp', 'svp', 'evp', 'avp', 'chief', 'officer', 'ceo', 'cto', 'cfo', 'coo', 'cio', 'cmo', 'cpo', 'cdo', 'ciso', 'cro']);

/** "Director of Analytics, Network Planning" -> "Director of Analytics": when
 *  the part before the first comma already names a function, what follows is
 *  a team or a specialty, not the role. "Director, Analytics" keeps both. */
function mainClause(title) {
  const parts = String(title || '').split(',');
  if (parts.length < 2) return String(title || '');
  const first = words(parts[0]).filter((w) => !BAND_WORDS.has(w) && !GRADE.has(w) && !FILLER.has(w) && !ROMAN.has(w) && !/^\d+$/.test(w) && !/^l\d$/.test(w));
  return first.length ? parts[0] : String(title);
}

function normTitle(title) {
  const raw = words(mainClause(title));
  let seniority = null;
  let band = '';
  let gradeLevel = null;
  let senior = false;
  let bump = 0;
  const core = [];
  for (let i = 0; i < raw.length; i++) {
    let w = raw[i];
    if (SYNONYM[w] && SYNONYM[w] !== w) { core.push(...SYNONYM[w].split(' ')); continue; }
    if (w === 'vp' || w === 'svp' || w === 'evp' || w === 'avp') { band = 'vp'; seniority = 'vp'; if (w !== 'avp' && w !== 'vp') bump = 1; continue; }
    if (C_SUITE.has(w)) {
      band = 'chief'; seniority = 'c_level';
      if (w !== 'chief') core.push(...({ ceo: ['executive'], cto: ['technology'], cfo: ['financial'], coo: ['operating'], cio: ['information'], cmo: ['marketing'], cpo: ['product'], cdo: ['data'], ciso: ['information', 'security'], cro: ['revenue'] }[w] || []));
      continue;
    }
    if (w === 'officer' && band === 'chief') continue;
    if (w === 'director' || w === 'head') { if (band !== 'vp' && band !== 'chief') { band = 'director'; seniority = 'director'; } continue; }
    if (w === 'manager' || w === 'management' && i === raw.length - 1) {
      // "Product Manager" and "Program Manager" are roles, not people managers.
      const prev = core[core.length - 1];
      if (prev === 'product' || prev === 'program' || prev === 'project' || prev === 'account' || prev === 'case' || prev === 'community' || prev === 'office' || prev === 'property') { core.push('manager'); continue; }
      if (!band) { band = 'manager'; seniority = 'manager'; }
      continue;
    }
    if (GRADE.has(w)) {
      if (w === 'senior' || w === 'sr' || w === 'snr') senior = true;
      else if (w === 'staff' || w === 'principal' || w === 'lead' || w === 'distinguished' || w === 'fellow') gradeLevel = Math.max(gradeLevel || 0, LADDER.staff);
      else if (w === 'junior' || w === 'jr' || w === 'associate' || w === 'assoc' || w === 'entry' || w === 'graduate' || w === 'grad' || w === 'apprentice') gradeLevel = gradeLevel === null ? LADDER.entry : gradeLevel;
      else if (w === 'intern' || w === 'internship' || w === 'trainee') gradeLevel = LADDER.intern;
      continue;
    }
    if (ROMAN.has(w) && core.length) { const n = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6 }[w]; gradeLevel = Math.max(gradeLevel || 0, n >= 3 ? LADDER.senior : n === 1 ? LADDER.entry : LADDER.mid); continue; }
    if (/^l\d$/.test(w) || /^\d$/.test(w)) { const n = Number(w.replace('l', '')); if (n) gradeLevel = Math.max(gradeLevel || 0, n >= 6 ? LADDER.staff : n >= 5 ? LADDER.senior : n >= 3 ? LADDER.mid : LADDER.entry); continue; }
    if (FILLER.has(w)) continue;
    if (/^\d+$/.test(w)) continue;
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('ics') && !w.endsWith('ops')) w = w.slice(0, -1);
    core.push(w);
  }
  const coreWords = [...new Set(core)].slice(0, 6);
  if (!seniority) {
    if (gradeLevel === LADDER.intern) seniority = 'intern';
    else if (gradeLevel === LADDER.staff) seniority = 'staff';
    else if (senior || gradeLevel === LADDER.senior) seniority = 'senior';
    else if (gradeLevel === LADDER.entry) seniority = 'entry';
    else if (coreWords.length) seniority = 'mid';
  }
  let level = seniority ? LADDER[seniority] : null;
  if (level !== null && senior && (band === 'director' || band === 'manager')) level += 0.5;
  if (level !== null && bump) level += 1;
  const coreText = coreWords.join(' ');
  const titleNorm = [coreText, band].filter(Boolean).join(' ').slice(0, 80);
  return { title_norm: titleNorm, seniority: seniority || null, core: coreText, level };
}

/** 0..1: how alike two titles' roles are (core words, Jaccard, plus band). */
function titleSimilarity(a, b) {
  const x = typeof a === 'string' ? normTitle(a) : a;
  const y = typeof b === 'string' ? normTitle(b) : b;
  const A = new Set(x.core.split(' ').filter(Boolean));
  const B = new Set(y.core.split(' ').filter(Boolean));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  const jac = inter / (A.size + B.size - inter);
  // Containment matters more than symmetric overlap: "analytics" inside
  // "marketing analytics" is a close match for someone who typed "analytics".
  const contain = inter / Math.min(A.size, B.size);
  return Math.round(Math.min(1, 0.55 * jac + 0.45 * contain) * 1000) / 1000;
}

/** Rungs between two seniorities, or null when either is unknown. */
function ladderDistance(a, b) {
  if (!(a in LADDER) || !(b in LADDER)) return null;
  return Math.abs(LADDER[a] - LADDER[b]);
}

module.exports = { normTitle, titleSimilarity, ladderDistance, LADDER, SENIORITIES, SENIORITY_LABEL };
