// Public compensation rows: the Department of Labor's LCA (H-1B) disclosure
// data and BLS OEWS, each mapped to a comp_public row. Pure.
//
// LCA: every Labor Condition Application an employer files to hire on an
// H-1B, E-3 or H-1B1 visa is public, with the job title, the worksite and the
// wage offered. It is the largest public set of actual offered salaries by
// employer and title in the US. Kept: CERTIFIED, full-time cases. Read: only
// the columns below - the files also carry the employer's contact person, the
// filing attorney and their emails and phone numbers, and none of that is
// ever copied (the whitelist is the point; test/run.js holds it).
//
// OEWS: BLS's occupational wage estimates - one row per occupation and area,
// with the 25th, 50th and 75th percentile annual wage. A benchmark beside
// the filings, never mixed into their percentiles.

const { clean } = require('./text');
const { normTitle } = require('./titles');
const { annualise, readNumber } = require('./pay');

const STATE_CODE = /^[A-Z]{2}$/;
const MIN_WAGE = 15000;
const MAX_WAGE = 2000000;

/** The fiscal year and quarter a DOL file covers, from its name ("..._FY2026_Q1.xlsx"). */
function lcaPeriod(urlOrName) {
  const m = String(urlOrName || '').match(/FY\s*(\d{4})(?:[_\s-]*Q([1-4]))?/i);
  if (!m) return null;
  return { year: Number(m[1]), quarter: m[2] ? Number(m[2]) : null };
}

/**
 * One LCA record (header-keyed) -> a comp_public row, or null when it is not
 * a certified full-time case with a usable wage.
 */
function lcaRow(rec, period) {
  if (!rec || !period) return null;
  const status = String(rec.CASE_STATUS || '').trim();
  if (!/^certified$/i.test(status)) return null;
  const visa = String(rec.VISA_CLASS || 'H-1B').trim();
  if (visa && !/^(H-1B|E-3|H-1B1)/i.test(visa)) return null;
  const ft = String(rec.FULL_TIME_POSITION || 'Y').trim().toUpperCase();
  if (ft && ft !== 'Y' && ft !== 'YES') return null;
  const wage = annualise(rec.WAGE_RATE_OF_PAY_FROM, rec.WAGE_UNIT_OF_PAY);
  if (wage === null || wage < MIN_WAGE || wage > MAX_WAGE) return null;
  const title = clean(rec.JOB_TITLE, 160);
  if (!title) return null;
  const n = normTitle(title);
  if (!n.title_norm) return null;
  const state = String(rec.WORKSITE_STATE || '').trim().toUpperCase();
  const soc = String(rec.SOC_CODE || '').trim().match(/^\d{2}-\d{4}/);
  return {
    source: 'h1b_lca',
    year: period.year,
    quarter: period.quarter,
    employer: clean(rec.EMPLOYER_NAME, 160) || null,
    job_title: title,
    title_norm: n.title_norm,
    seniority: n.seniority,
    soc_code: soc ? soc[0] : null,
    wage_annual: wage,
    wage_p25: null,
    wage_p75: null,
    employment: null,
    worksite_city: titleCaseCity(rec.WORKSITE_CITY),
    worksite_state: STATE_CODE.test(state) ? state : null,
    case_status: 'Certified',
  };
}

function titleCaseCity(v) {
  const s = clean(v, 80);
  if (!s) return null;
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** OEWS value: '*' (not released) and '#' (above the top bracket) are no figure. */
function oewsNumber(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === '*' || s === '**' || s === '#' || s === '~') return null;
  const n = readNumber(s.replace(/[$\s]/g, ''));
  return n === null ? null : n;
}

/** The OEWS reference year from a file name ("oesm24nat.zip" / "state_M2024_dl.xlsx"). */
function oewsYear(name) {
  const s = String(name || '');
  const a = s.match(/M(20\d{2})/i);
  if (a) return Number(a[1]);
  const b = s.match(/oesm(\d{2})/i);
  return b ? 2000 + Number(b[1]) : null;
}

/** One OEWS record -> a comp_public row (national or state, cross-industry, detailed occupations). */
function oewsRow(rec, year) {
  if (!rec || !year) return null;
  const group = String(rec.O_GROUP || rec.OCC_GROUP || 'detailed').toLowerCase();
  if (group !== 'detailed') return null;
  if (rec.I_GROUP && String(rec.I_GROUP).toLowerCase() !== 'cross-industry') return null;
  // Cross-industry rows only; an industry breakdown would count people twice.
  if (rec.NAICS && String(rec.NAICS).trim() !== '000000') return null;
  const areaType = String(rec.AREA_TYPE || '').trim();
  let state = null;
  if (areaType === '2') { state = String(rec.PRIM_STATE || '').trim().toUpperCase(); if (!STATE_CODE.test(state)) return null; }
  else if (areaType && areaType !== '1') return null; // metro and nonmetro areas: not loaded
  const soc = String(rec.OCC_CODE || '').trim().match(/^\d{2}-\d{4}$/);
  if (!soc) return null;
  const title = clean(rec.OCC_TITLE, 160);
  const median = oewsNumber(rec.A_MEDIAN);
  if (median === null) return null;
  const n = normTitle(title);
  const emp = oewsNumber(rec.TOT_EMP);
  return {
    source: 'bls_oews',
    year,
    quarter: null,
    employer: null,
    job_title: title,
    title_norm: n.title_norm,
    seniority: null,
    soc_code: soc[0],
    wage_annual: median,
    wage_p25: oewsNumber(rec.A_PCT25),
    wage_p75: oewsNumber(rec.A_PCT75),
    employment: emp === null ? null : Math.round(emp),
    worksite_city: null,
    worksite_state: state,
    case_status: null,
  };
}

// The only columns that may ever leave this module (asserted in tests).
const COMP_COLUMNS = ['source', 'year', 'quarter', 'employer', 'job_title', 'title_norm', 'seniority', 'soc_code', 'wage_annual', 'wage_p25', 'wage_p75', 'employment', 'worksite_city', 'worksite_state', 'case_status'];

module.exports = { lcaPeriod, lcaRow, oewsRow, oewsYear, oewsNumber, COMP_COLUMNS, MIN_WAGE, MAX_WAGE };
