/*
 * The example a visitor sees before signing up: a made-up person with
 * made-up matches, companies and pay data, so every screen works on first
 * open with no account, no model call and no BigQuery query.
 *
 * Everything here is invented - the person, the companies, the postings, the
 * filings and the figures. The page says so on every screen.
 *
 * UMD: window.NextMoveSample in the page, require() in the tests.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NextMoveSample = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function daysAgo(n, h) {
    var d = new Date();
    d.setUTCHours(h === undefined ? 11 : h, 20, 0, 0);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString();
  }

  var profile = {
    background: {
      headline: 'Director of Analytics, healthcare and retail',
      summary: 'Twelve years building analytics teams in healthcare and retail. Leads a 14-person team covering forecasting, experimentation and BI; known for turning analysis into decisions executives act on.',
      yearsExperience: 12,
      roles: [
        { title: 'Director of Analytics', company: 'A regional health system', years: 4, highlights: 'Built the demand-forecasting program that cut stockouts 18%.' },
        { title: 'Senior Manager, Analytics', company: 'A specialty retailer', years: 5, highlights: 'Grew the team from 3 to 11 and stood up experimentation.' },
        { title: 'Analytics Manager', company: 'A consumer bank', years: 3, highlights: 'Led credit-risk reporting.' },
      ],
      skills: ['SQL', 'Python', 'Forecasting', 'Experimentation', 'dbt', 'Looker', 'Team leadership', 'Stakeholder management'],
      industries: ['Healthcare', 'Retail'],
      education: ['MS Statistics'],
      keywords: [],
    },
    targets: { titles: ['Director of Analytics', 'Head of Data'], seniority: 'director', locations: ['Atlanta, GA'], remote: 'remote_ok', compFloor: 185000, keywords: [] },
  };

  var watchlist = [
    { companyKey: 'greenhouse:peachtreehealth', name: 'Peachtree Health Systems', provider: 'greenhouse', found: true },
    { companyKey: 'lever:northwind', name: 'Northwind Logistics', provider: 'lever', found: true },
    { companyKey: 'ashby:copperline', name: 'Copperline Fintech', provider: 'ashby', found: true },
    { companyKey: 'greenhouse:halcyonretail', name: 'Halcyon Retail Group', provider: 'greenhouse', found: true },
    { companyKey: 'name:brightwater-insurance', name: 'Brightwater Insurance', provider: null, found: false },
  ];

  function fit(o) {
    return {
      postingId: o.id, scoredAt: daysAgo(o.ago || 0), score: o.score, verdict: o.verdict,
      verdictLabel: { strong: 'Strong fit', worth_a_look: 'Worth a look', stretch: 'Stretch', skip: 'Skip' }[o.verdict],
      strengths: o.strengths, positioning: o.positioning, gaps: o.gaps, company: o.company, companyKey: o.companyKey,
      title: o.title, url: '', location: o.location, remote: Boolean(o.remote), payMin: o.payMin || null, payMax: o.payMax || null,
      payCurrency: o.payMin || o.payMax ? 'USD' : null, source: o.source || 'greenhouse', costUsd: o.costUsd || 0.0061, example: true,
    };
  }

  var fits = [
    fit({
      id: 'ex1', score: 91, verdict: 'strong', company: 'Peachtree Health Systems', companyKey: 'greenhouse:peachtreehealth',
      title: 'Director, Analytics & Insights', location: 'Atlanta, GA', payMin: 190000, payMax: 225000,
      strengths: [
        { point: 'Your forecasting program is the work they describe first.', quote: 'build and lead the demand forecasting function across our hospitals' },
        { point: 'You have run a team of this size.', quote: 'lead a team of 10-15 analysts and data scientists' },
        { point: 'Healthcare analytics is your last four years.', quote: 'experience with clinical or operational data in a health system' },
      ],
      gaps: ['They mention Epic Clarity data, which your background does not show.'],
      positioning: 'Lead with the stockout result and the size of the team you built - it is the exact shape of this role. Name Epic Clarity yourself and point to how quickly you picked up the retail stack.',
    }),
    fit({
      id: 'ex2', score: 86, verdict: 'strong', company: 'Copperline Fintech', companyKey: 'ashby:copperline', source: 'ashby',
      title: 'Head of Data', location: 'Remote (US)', remote: true, payMin: 205000, payMax: 240000,
      strengths: [
        { point: 'Experimentation at scale is a must-have and a strength.', quote: 'own our experimentation platform and the culture around it' },
        { point: 'Your consumer bank years cover their domain.', quote: 'background in lending or payments analytics is a plus' },
      ],
      gaps: ['They want hands-on ownership of the data platform (warehouse, pipelines).', 'Fintech regulatory reporting is not in your background.'],
      positioning: 'Frame yourself as the leader who makes data trusted and used: the experimentation program first, then the bank work as domain fluency. Be ready to talk about how you would partner with - or hire - a data platform lead.',
    }),
    fit({
      id: 'ex3', score: 78, verdict: 'worth_a_look', company: 'Halcyon Retail Group', companyKey: 'greenhouse:halcyonretail',
      title: 'Senior Director, Customer Analytics', location: 'Atlanta, GA or Remote', remote: true, payMin: 210000, payMax: 250000,
      strengths: [
        { point: 'Retail customer analytics is home ground.', quote: 'loyalty, pricing and personalization analytics for 900 stores' },
        { point: 'They want an executive communicator.', quote: 'translate analysis into recommendations for the executive team' },
      ],
      gaps: ['A senior director scope: two levels of managers under you.', 'Pricing science depth beyond what your resume shows.'],
      positioning: 'This is a step up in scope. Lead with the team you grew from 3 to 11 and show the managers you developed; acknowledge the pricing depth and pair it with your experimentation record.',
    }),
    fit({
      id: 'ex4', score: 71, verdict: 'worth_a_look', company: 'Northwind Logistics', companyKey: 'lever:northwind', source: 'lever',
      title: 'Director of Analytics, Network Planning', location: 'Atlanta, GA', payMin: 175000, payMax: 205000,
      strengths: [
        { point: 'Demand forecasting transfers directly.', quote: 'forecast volume across our network of distribution centers' },
      ],
      gaps: ['Logistics and network optimization experience.', 'They list operations research methods (linear programming).'],
      positioning: 'Forecasting is the bridge: show the model you built and how operations used it. Be honest that network optimization would be new, and that you would bring an OR specialist close.',
    }),
    fit({
      id: 'ex5', score: 58, verdict: 'stretch', company: 'Copperline Fintech', companyKey: 'ashby:copperline', source: 'ashby',
      title: 'VP, Data Science', location: 'New York, NY', payMin: 260000, payMax: 300000, ago: 1,
      strengths: [
        { point: 'You have led data scientists, not only analysts.', quote: 'managing managers across data science and analytics' },
      ],
      gaps: ['VP scope: org of 40+.', 'Machine learning in production.', 'New York, and your preference is Atlanta or remote.'],
      positioning: 'A real stretch on scope and ML depth. Worth a conversation only if you want to aim for VP in the next move.',
    }),
    fit({
      id: 'ex6', score: 66, verdict: 'worth_a_look', company: 'Brightwater Insurance', companyKey: 'name:brightwater-insurance', source: 'websearch',
      title: 'Director, Business Intelligence', location: 'Remote', remote: true, ago: 2,
      strengths: [
        { point: 'BI leadership with Looker and dbt.', quote: 'modernize our BI stack and reporting' },
      ],
      gaps: ['Insurance domain.', 'No pay range posted.'],
      positioning: 'Lead with the modern stack you built and the adoption numbers. Found by the weekly web search - Brightwater has no public careers board.',
    }),
  ];

  var companies = [
    { companyKey: 'greenhouse:peachtreehealth', name: 'Peachtree Health Systems', provider: 'greenhouse', found: true, openCount: 148, newThisWeek: 12, lastFetchedAt: daysAgo(0),
      newest: [{ title: 'Director, Analytics & Insights', location: 'Atlanta, GA' }, { title: 'Clinical Data Engineer', location: 'Atlanta, GA' }, { title: 'Analytics Manager, Revenue Cycle', location: 'Remote' }],
      events: [{ type: 'exec_change', typeLabel: 'Leadership change', source: 'sec', headline: 'Peachtree Health Systems filed an 8-K: officer or director change', at: daysAgo(3), url: '' },
        { type: 'earnings', typeLabel: 'Earnings', source: 'gdelt', headline: 'Peachtree Health Systems beats estimates as outpatient volume grows', at: daysAgo(9), url: '' }] },
    { companyKey: 'lever:northwind', name: 'Northwind Logistics', provider: 'lever', found: true, openCount: 63, newThisWeek: 2, lastFetchedAt: daysAgo(0),
      newest: [{ title: 'Director of Analytics, Network Planning', location: 'Atlanta, GA' }, { title: 'Senior Data Analyst', location: 'Dallas, TX' }],
      events: [{ type: 'layoff', typeLabel: 'Layoffs', source: 'gdelt', headline: 'Northwind Logistics to cut 200 jobs in restructuring', at: daysAgo(2), url: '' },
        { type: 'layoff', typeLabel: 'Layoffs', source: 'sec', headline: 'Northwind Logistics filed an 8-K: exit or disposal costs', at: daysAgo(2), url: '' }] },
    { companyKey: 'ashby:copperline', name: 'Copperline Fintech', provider: 'ashby', found: true, openCount: 41, newThisWeek: 6, lastFetchedAt: daysAgo(0),
      newest: [{ title: 'Head of Data', location: 'Remote (US)' }, { title: 'VP, Data Science', location: 'New York, NY' }, { title: 'Staff Analytics Engineer', location: 'Remote (US)' }],
      events: [{ type: 'funding', typeLabel: 'Funding', source: 'gdelt', headline: 'Copperline Fintech raises $120 million Series D', at: daysAgo(5), url: '' }] },
    { companyKey: 'greenhouse:halcyonretail', name: 'Halcyon Retail Group', provider: 'greenhouse', found: true, openCount: 207, newThisWeek: 9, lastFetchedAt: daysAgo(0),
      newest: [{ title: 'Senior Director, Customer Analytics', location: 'Atlanta, GA or Remote' }, { title: 'Pricing Analyst', location: 'Atlanta, GA' }],
      events: [{ type: 'acquisition', typeLabel: 'Acquisition', source: 'sec', headline: 'Halcyon Retail Group filed an 8-K: acquisition or disposition completed', at: daysAgo(12), url: '' }] },
    { companyKey: 'name:brightwater-insurance', name: 'Brightwater Insurance', provider: null, found: false, openCount: null, newThisWeek: null, lastFetchedAt: null, newest: [],
      events: [{ type: 'other', typeLabel: 'News', source: 'gdelt', headline: 'Brightwater Insurance opens Atlanta tech hub', at: daysAgo(6), url: '' }] },
  ];

  function s(n, p25, p50, p75) { return { n: n, p25: p25, p50: p50, p75: p75, enough: n >= 10 }; }

  var comps = [
    {
      title: 'Director of Analytics', titleNorm: 'analytics director', threshold: 10,
      posted: {
        all: s(64, 171000, 189000, 214000),
        byState: [{ state: 'NY', n: 18, p25: 192000, p50: 210000, p75: 238000, enough: true }, { state: 'GA', n: 14, p25: 168000, p50: 184000, p75: 205000, enough: true },
          { state: 'CA', n: 12, p25: 198000, p50: 219000, p75: 246000, enough: true }, { state: 'REMOTE', n: 11, p25: 165000, p50: 182000, p75: 201000, enough: true },
          { state: 'TX', n: 6, p25: 158000, p50: 176000, p75: 190000, enough: false }],
        byQuarter: [s(11, 165000, 181000, 204000), s(14, 168000, 185000, 208000), s(19, 172000, 190000, 215000), s(20, 175000, 194000, 220000)].map(function (x, i) { x.quarter = ['2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3'][i]; return x; }),
        recent: s(9, 176000, 196000, 221000), prior: s(55, 170000, 188000, 212000),
      },
      h1b: {
        all: s(412, 158000, 178000, 201000),
        byState: [{ state: 'CA', n: 96, p25: 181000, p50: 203000, p75: 228000, enough: true }, { state: 'NY', n: 71, p25: 172000, p50: 191000, p75: 215000, enough: true },
          { state: 'TX', n: 48, p25: 150000, p50: 168000, p75: 186000, enough: true }, { state: 'GA', n: 31, p25: 146000, p50: 163000, p75: 182000, enough: true },
          { state: 'WA', n: 29, p25: 176000, p50: 196000, p75: 219000, enough: true }, { state: 'NC', n: 8, p25: 141000, p50: 155000, p75: 170000, enough: false }],
        byCity: [{ city: 'New York', state: 'NY', n: 64, p25: 175000, p50: 194000, p75: 218000, enough: true }, { city: 'San Francisco', state: 'CA', n: 41, p25: 190000, p50: 212000, p75: 236000, enough: true },
          { city: 'Atlanta', state: 'GA', n: 23, p25: 148000, p50: 165000, p75: 184000, enough: true }, { city: 'Austin', state: 'TX', n: 14, p25: 152000, p50: 170000, p75: 188000, enough: true }],
        byYear: [{ year: 2023, n: 121, p25: 149000, p50: 168000, p75: 190000, enough: true }, { year: 2024, n: 138, p25: 156000, p50: 176000, p75: 199000, enough: true },
          { year: 2025, n: 129, p25: 162000, p50: 183000, p75: 207000, enough: true }, { year: 2026, n: 24, p25: 165000, p50: 186000, p75: 210000, enough: true }],
      },
      oews: { soc: '11-3021', occupation: 'Computer and Information Systems Managers', year: 2025, national: { p25: 134000, p50: 172000, p75: 214000, employment: 591000 },
        byState: [{ state: 'GA', p25: 128000, p50: 161000, p75: 199000, employment: 18900 }] },
    },
    {
      title: 'Head of Data', titleNorm: 'data director', threshold: 10,
      posted: {
        all: s(23, 188000, 212000, 245000),
        byState: [{ state: 'REMOTE', n: 9, p25: 185000, p50: 205000, p75: 236000, enough: false }, { state: 'NY', n: 7, p25: 205000, p50: 228000, p75: 260000, enough: false }],
        byQuarter: [], recent: s(4, 190000, 214000, 248000), prior: s(19, 187000, 211000, 244000),
      },
      h1b: { all: s(7, 0, 0, 0), byState: [], byCity: [], byYear: [] },
      oews: null,
    },
  ];
  comps[1].h1b.all = { n: 7, p25: null, p50: null, p75: null, enough: false };

  var digest = {
    weekKey: '', builtAt: daysAgo(0),
    counts: { fits: 14, strong: 2, worthALook: 5, events: 6, byType: { layoff: 2, exec_change: 1, funding: 1, earnings: 1, other: 1 } },
    topFits: fits.slice(0, 4),
    events: [].concat(companies[1].events, companies[0].events.slice(0, 1), companies[2].events, companies[4].events).map(function (e, i) {
      e.company = ['Northwind Logistics', 'Northwind Logistics', 'Peachtree Health Systems', 'Copperline Fintech', 'Brightwater Insurance'][i]; return e;
    }),
    compMoves: [{ title: 'Director of Analytics', recent: 196000, prior: 188000, pct: 4.3, nRecent: 9, nPrior: 55 }],
    costUsd: 0.0854,
  };

  return {
    who: 'Example: a Director of Analytics in Atlanta',
    profile: profile,
    watchlist: watchlist,
    fits: fits,
    companies: companies,
    comps: comps,
    digest: digest,
  };
});
