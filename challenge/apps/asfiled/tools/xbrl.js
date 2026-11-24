// A small reader for an XBRL instance document (the *_htm.xml the SEC
// extracts from an inline-XBRL annual report) and its label linkbase.
// Regex-based on purpose: no dependency, and the files are machine-written.

const fs = require('fs');

function unescape(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

const readInstance = (file) => parseInstance(fs.readFileSync(file, 'utf8'));
/** The same, from the document's text (the on-request lookup holds it in memory). */
function parseInstance(xml) {
  const contexts = {};
  const ctxRe = /<(?:xbrli:)?context\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/g;
  let m;
  while ((m = ctxRe.exec(xml))) {
    const body = m[2];
    const dims = [];
    const dimRe = /<xbrldi:explicitMember\b[^>]*dimension="([^"]+)"[^>]*>\s*([^<\s]+)\s*</g;
    let d;
    while ((d = dimRe.exec(body))) dims.push([d[1], d[2]]);
    const typed = /<xbrldi:typedMember\b/.test(body);
    const start = (/<(?:xbrli:)?startDate>\s*([^<\s]+)/.exec(body) || [])[1] || null;
    const end = (/<(?:xbrli:)?endDate>\s*([^<\s]+)/.exec(body) || [])[1] || (/<(?:xbrli:)?instant>\s*([^<\s]+)/.exec(body) || [])[1] || null;
    contexts[m[1]] = { dims, typed, start, end };
  }
  const units = {};
  const unitRe = /<(?:xbrli:)?unit\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?unit>/g;
  while ((m = unitRe.exec(xml))) {
    const measures = [...m[2].matchAll(/<(?:xbrli:)?measure>\s*([^<\s]+)/g)].map((x) => x[1].replace(/^.*:/, ''));
    units[m[1]] = /<(?:xbrli:)?divide>/.test(m[2]) ? measures.join('/') : measures[0];
  }
  const facts = [];
  const factRe = /<([a-zA-Z][\w.-]*:[\w.-]+)\b([^>]*\bcontextRef="[^"]+"[^>]*)>([^<]*)<\/\1>/g;
  while ((m = factRe.exec(xml))) {
    const attrs = m[2];
    const ctx = (/contextRef="([^"]+)"/.exec(attrs) || [])[1];
    const unit = (/unitRef="([^"]+)"/.exec(attrs) || [])[1] || null;
    if (!unit || !contexts[ctx]) continue;
    const v = Number(m[3].trim());
    if (!Number.isFinite(v)) continue;
    facts.push({ tag: m[1], ctx: contexts[ctx], unit: units[unit] || unit, val: v });
  }
  return { contexts, facts };
}

/** element QName -> its standard (or terse) label, from a *_lab.xml. */
const readLabels = (file) => parseLabels(fs.readFileSync(file, 'utf8'));
function parseLabels(xml) {
  const locs = {};
  let m;
  const locRe = /<link:loc\b[^>]*>/g;
  while ((m = locRe.exec(xml))) {
    const href = (/xlink:href="[^"#]*#([^"]+)"/.exec(m[0]) || [])[1];
    const label = (/xlink:label="([^"]+)"/.exec(m[0]) || [])[1];
    if (href && label) locs[label] = href;
  }
  const texts = {};
  const labRe = /<link:label\b([^>]*)>([\s\S]*?)<\/link:label>/g;
  while ((m = labRe.exec(xml))) {
    const id = (/xlink:label="([^"]+)"/.exec(m[1]) || [])[1];
    const role = (/xlink:role="([^"]+)"/.exec(m[1]) || [])[1] || '';
    if (!id) continue;
    const kind = role.endsWith('/terseLabel') ? 'terse' : role.endsWith('/label') ? 'std' : null;
    if (!kind) continue;
    (texts[id] = texts[id] || {})[kind] = unescape(m[2].replace(/<[^>]+>/g, '')).trim();
  }
  const out = {};
  const arcRe = /<link:labelArc\b[^>]*>/g;
  while ((m = arcRe.exec(xml))) {
    const from = (/xlink:from="([^"]+)"/.exec(m[0]) || [])[1];
    const to = (/xlink:to="([^"]+)"/.exec(m[0]) || [])[1];
    const el = locs[from];
    const t = texts[to];
    if (!el || !t) continue;
    const q = el.replace(/_/, ':');           // us-gaap_Revenues -> us-gaap:Revenues
    out[q] = out[q] || {};
    if (t.terse) out[q].terse = t.terse;
    if (t.std) out[q].std = t.std;
  }
  return out;
}

// Tags tried for each annual number, in order of preference when one filing
// reports two of them for the same period (tools/build.js).
const TAGS = {
  revenue: ['us-gaap:Revenues', 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax', 'us-gaap:RevenueFromContractWithCustomerIncludingAssessedTax', 'us-gaap:SalesRevenueNet', 'ifrs-full:Revenue', 'ifrs-full:RevenueFromContractsWithCustomers'],
  cost: ['us-gaap:CostOfRevenue', 'us-gaap:CostOfGoodsAndServicesSold', 'us-gaap:CostOfGoodsSold', 'ifrs-full:CostOfSales'],
  gross: ['us-gaap:GrossProfit', 'ifrs-full:GrossProfit'],
  rd: ['us-gaap:ResearchAndDevelopmentExpense', 'us-gaap:ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost', 'us-gaap:ResearchAndDevelopmentExpenseSoftwareExcludingAcquiredInProcessCost', 'ifrs-full:ResearchAndDevelopmentExpense'],
  capex: ['us-gaap:PaymentsToAcquirePropertyPlantAndEquipment', 'us-gaap:PaymentsToAcquireProductiveAssets', 'ifrs-full:PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities'],
  inventory: ['us-gaap:InventoryNet', 'ifrs-full:Inventories', 'ifrs-full:CurrentInventories'],
};

// Cash, capital return, the balance sheet's cash and debt, and what a
// report tags about the future (Erik, 2026-11-24). Same rule as TAGS: one
// number per fiscal year, from the earliest annual report that reported it.
// The debt tags are kept as separate figures and added up on the page, which
// names every tag in the sum (Core.derived 'debt').
const FIN = {
  ocf: ['us-gaap:NetCashProvidedByUsedInOperatingActivities', 'us-gaap:NetCashProvidedByUsedInOperatingActivitiesContinuingOperations', 'ifrs-full:CashFlowsFromUsedInOperatingActivities'],
  opinc: ['us-gaap:OperatingIncomeLoss', 'ifrs-full:ProfitLossFromOperatingActivities'],
  netinc: ['us-gaap:NetIncomeLoss', 'us-gaap:ProfitLoss', 'ifrs-full:ProfitLossAttributableToOwnersOfParent', 'ifrs-full:ProfitLoss'],
  sbc: ['us-gaap:ShareBasedCompensation', 'us-gaap:AllocatedShareBasedCompensationExpense', 'ifrs-full:AdjustmentsForSharebasedPayments'],
  buybacks: ['us-gaap:PaymentsForRepurchaseOfCommonStock', 'us-gaap:PaymentsForRepurchaseOfEquity', 'ifrs-full:PaymentsToAcquireOrRedeemEntitysShares'],
  dividends: ['us-gaap:PaymentsOfDividendsCommonStock', 'us-gaap:PaymentsOfDividends', 'us-gaap:PaymentsOfOrdinaryDividends', 'ifrs-full:DividendsPaidClassifiedAsFinancingActivities', 'ifrs-full:DividendsPaidToEquityHoldersOfParentClassifiedAsFinancingActivities'],
  cash: ['us-gaap:CashAndCashEquivalentsAtCarryingValue', 'ifrs-full:CashAndCashEquivalents'],
  sti: ['us-gaap:ShortTermInvestments', 'us-gaap:MarketableSecuritiesCurrent', 'us-gaap:AvailableForSaleSecuritiesDebtSecuritiesCurrent', 'us-gaap:DebtSecuritiesAvailableForSaleExcludingAccruedInterestCurrent'],
  debtLong: ['us-gaap:LongTermDebtNoncurrent', 'us-gaap:LongTermDebtAndCapitalLeaseObligations', 'us-gaap:ConvertibleNotesPayableNoncurrent', 'us-gaap:ConvertibleDebtNoncurrent', 'us-gaap:ConvertibleLongTermNotesPayable', 'us-gaap:LongTermNotesPayable', 'us-gaap:SeniorLongTermNotes', 'us-gaap:UnsecuredLongTermDebt'],
  debtCurrent: ['us-gaap:DebtCurrent', 'us-gaap:LongTermDebtCurrent', 'us-gaap:LongTermDebtAndCapitalLeaseObligationsCurrent', 'us-gaap:ConvertibleNotesPayableCurrent', 'us-gaap:ConvertibleDebtCurrent', 'us-gaap:SeniorNotesCurrent'],
  debtShort: ['us-gaap:ShortTermBorrowings', 'us-gaap:CommercialPaper'],
  debtTotal: ['us-gaap:LongTermDebt', 'us-gaap:DebtLongtermAndShorttermCombinedAmount', 'us-gaap:DebtAndCapitalLeaseObligations'],
  rpo: ['us-gaap:RevenueRemainingPerformanceObligation'],
  deferred: ['us-gaap:ContractWithCustomerLiability', 'us-gaap:ContractWithCustomerLiabilityCurrent', 'us-gaap:DeferredRevenue', 'us-gaap:DeferredRevenueCurrent'],
  impairment: ['us-gaap:GoodwillImpairmentLoss'],
  restructuring: ['us-gaap:RestructuringCharges', 'us-gaap:RestructuringCostsAndAssetImpairmentCharges'],
};
// Balances at the fiscal year end, not amounts over the year.
const FIN_INSTANT = ['cash', 'sti', 'debtLong', 'debtCurrent', 'debtShort', 'debtTotal', 'rpo', 'deferred'];
// Read from 10-Qs too, for the latest quarter (tools/build.js quarters).
const QUARTERLY = ['revenue', 'opinc', 'netinc', 'ocf', 'capex'];
// The pay-versus-performance table of the proxy statement (DEF 14A), tagged
// since 2023 (the SEC's `ecd` taxonomy). Read from the proxy's own XBRL
// instance (tools/proxy.js); only facts with no dimension are kept.
const PAY = {
  peoTotal: 'ecd:PeoTotalCompAmt', peoPaid: 'ecd:PeoActuallyPaidCompAmt',
  neoTotal: 'ecd:NonPeoNeoAvgTotalCompAmt', neoPaid: 'ecd:NonPeoNeoAvgCompActuallyPaidAmt',
  tsr: 'ecd:TotalShareholderRtnAmt', peerTsr: 'ecd:PeerGroupTotalShareholderRtnAmt',
};
const ALL = Object.assign({}, TAGS, FIN);

const SLIM = 3;                        // the cut's version: fetch.js reads a company again when its cached copy is older
const FORMS = new Set(['10-K', '20-F', '10-Q', 'DEF 14A']);
/** Company facts (data.sec.gov) cut down to the tags above, same shape.
 *  The build and the verifier read nothing else from it, so the cache keeps
 *  a few hundred kilobytes a company instead of several megabytes. Rows keep
 *  the six fields that are read, from annual and quarterly reports and the
 *  proxy statement. */
function slimFacts(facts) {
  const keep = new Set([].concat(...Object.values(ALL)));
  const out = { cik: facts.cik, entityName: facts.entityName, slim: SLIM, facts: {} };
  for (const [tax, tags] of Object.entries(facts.facts || {})) {
    for (const [tag, body] of Object.entries(tags)) {
      if (!keep.has(`${tax}:${tag}`)) continue;
      const units = {};
      for (const [u, rows] of Object.entries(body.units || {})) {
        units[u] = rows.filter((r) => FORMS.has(r.form)).map((r) => (r.start ? { start: r.start, end: r.end, val: r.val, accn: r.accn, form: r.form, filed: r.filed } : { end: r.end, val: r.val, accn: r.accn, form: r.form, filed: r.filed }));
      }
      (out.facts[tax] = out.facts[tax] || {})[tag] = { units };
    }
  }
  return out;
}

module.exports = { readInstance, readLabels, parseInstance, parseLabels, unescape, TAGS, FIN, FIN_INSTANT, QUARTERLY, PAY, ALL, SLIM, slimFacts };
