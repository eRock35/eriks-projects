/* Boxed - the example client. Invented from top to bottom and labelled as
 * such: no real partnership, EIN, partner or figure. It is built to show
 * every feature on first open:
 *
 *   - 8 K-1s for tax year 2025, 6 of them checked (3 exported);
 *   - Harborline Credit Fund: Item L does not reconcile - off by $1,250;
 *   - Summit Ridge Growth Fund II: box 20 code Z and box 13 code H, and an
 *     Item L that differs from the boxes by $575 (a "look", not an error);
 *   - Bluefield Energy Partners: a publicly traded partnership;
 *   - Cedar Mill Ventures: box 16 checked (expect a K-3) and one value read
 *     with low confidence;
 *   - Old Quarry Partners: a final K-1;
 *   - Tidewater Logistics: last year's K-1 is in the file, and box 1 went
 *     from $12,400 to $41,900;
 *   - Lakeshore Medical Properties: the profit share went from 2.5% to 3.0%;
 *   - two K-1s still missing from last year's list.
 *
 * No model call: this is data, drawn by the same code as a real reading.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BoxedSample = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var YEAR = 2025;
  var hi = 'high';

  // [box, code, cents|null, page, conf, stmt]
  function L(box, code, dollars, page, conf, stmt) {
    return { box: box, code: code || null, cents: dollars === null ? null : Math.round(dollars * 100), stmt: Boolean(stmt), page: page || 1, conf: conf || hi };
  }
  function money(o) { var out = {}; Object.keys(o).forEach(function (k) { out[k] = o[k] === null ? null : Math.round(o[k] * 100); }); return out; }
  function pct(o) { var out = {}; Object.keys(o).forEach(function (k) { out[k] = Math.round(o[k] * 1000000); }); return out; }
  function at(keys, page) { var out = {}; keys.forEach(function (k) { out[k] = { p: page || 1, c: hi }; }); return out; }
  var ALL = ['j.profitBeg', 'j.profitEnd', 'j.lossBeg', 'j.lossEnd', 'j.capitalBeg', 'j.capitalEnd', 'k.nonrecourseBeg', 'k.nonrecourseEnd', 'k.qualifiedBeg', 'k.qualifiedEnd', 'k.recourseBeg', 'k.recourseEnd', 'l.beginning', 'l.contributed', 'l.currentYear', 'l.other', 'l.withdrawals', 'l.ending'];

  function k1(o) {
    var share = o.share || [1, 1];
    return {
      id: o.id, taxYear: o.year || YEAR,
      p: { name: o.name, ein4: o.ein4, center: o.center || 'Ogden, UT', ptp: Boolean(o.ptp) },
      final: Boolean(o.final), amended: false, k3: Boolean(o.k3), atRisk: false, passive: Boolean(o.passive),
      j: pct({ profitBeg: share[0], profitEnd: share[1], lossBeg: share[0], lossEnd: share[1], capitalBeg: share[0], capitalEnd: share[1] }),
      k: money(o.k || { nonrecourseBeg: 0, nonrecourseEnd: 0, qualifiedBeg: 0, qualifiedEnd: 0, recourseBeg: 0, recourseEnd: 0 }),
      l: Object.assign(money(o.l), { basis: 'tax' }),
      lines: o.lines,
      at: at(ALL, 1),
      src: 'pdf', stage: o.stage, reviewSecs: o.secs || 0, result: null,
    };
  }

  function k1s() {
    return [
      k1({
        id: 'ksnorthgate01', name: 'Northgate Real Estate Fund III LP', ein4: '4821', stage: 'exported', secs: 95, share: [0.85, 0.85], passive: true,
        k: { nonrecourseBeg: 21000, nonrecourseEnd: 20450, qualifiedBeg: 112000, qualifiedEnd: 109840, recourseBeg: 0, recourseEnd: 0 },
        l: { beginning: 142500, contributed: 0, currentYear: -18328, other: 0, withdrawals: 6000, ending: 118172 },
        lines: [L('2', null, -18640), L('5', null, 312), L('19', 'A', 6000), L('20', 'A', 312), L('20', 'Z', null, 4, hi, true)],
      }),
      k1({
        id: 'ksbluefield01', name: 'Bluefield Energy Partners LP', ein4: '3307', ptp: true, stage: 'checked', secs: 120, share: [0.000412, 0.000412], center: 'Kansas City, MO',
        k: { nonrecourseBeg: 2210, nonrecourseEnd: 2380, qualifiedBeg: 0, qualifiedEnd: 0, recourseBeg: 0, recourseEnd: 0 },
        l: { beginning: 26410, contributed: 0, currentYear: 2243, other: 0, withdrawals: 3960, ending: 24693 },
        lines: [L('1', null, 2184), L('5', null, 41), L('6a', null, 18), L('6b', null, 18), L('17', 'A', -412, 2), L('19', 'A', 3960), L('20', 'AG', null, 5, hi, true), L('20', 'Z', null, 5, hi, true)],
      }),
      k1({
        id: 'ksharborline1', name: 'Harborline Credit Fund LP', ein4: '6650', stage: 'read', secs: 0, share: [0.42, 0.42],
        l: { beginning: 250000, contributed: 25000, currentYear: 20930, other: 0, withdrawals: 9000, ending: 288180 },
        lines: [L('5', null, 22870), L('13', 'ZZ', 1940, 3), L('19', 'A', 9000), L('20', 'A', 22870), L('20', 'B', 1940)],
      }),
      k1({
        id: 'kssummitridge', name: 'Summit Ridge Growth Fund II LP', ein4: '1938', stage: 'checked', secs: 160, share: [0.31, 0.31],
        l: { beginning: 96200, contributed: 10000, currentYear: 12566, other: 0, withdrawals: 5000, ending: 113766 },
        lines: [L('1', null, -3410), L('5', null, 1288), L('6a', null, 2950), L('6b', null, 2410), L('8', null, -612), L('9a', null, 14780), L('11', 'C', 340, 3),
          L('13', 'H', 1105, 3), L('13', 'ZZ', 2240, 3), L('19', 'A', 5000), L('20', 'A', 4238, 4), L('20', 'B', 2240, 4), L('20', 'Z', null, 6, hi, true)],
      }),
      k1({
        id: 'kscedarmill01', name: 'Cedar Mill Ventures LP', ein4: '5274', k3: true, stage: 'checked', secs: 140, share: [0.6, 0.6],
        l: { beginning: 61000, contributed: 15000, currentYear: -5768, other: 0, withdrawals: 0, ending: 70232 },
        lines: [L('1', null, -7820), L('5', null, 96), L('9a', null, 2140), L('11', 'ZZ', 410, 3, 'low'), L('13', 'ZZ', 380, 3), L('20', 'A', 96), L('21', null, 214, 2)],
      }),
      k1({
        id: 'ksoldquarry01', name: 'Old Quarry Partners LLC', ein4: '8402', final: true, stage: 'exported', secs: 110, share: [1.2, 0],
        l: { beginning: 72180, contributed: 0, currentYear: 49660, other: 0, withdrawals: 121840, ending: 0 },
        lines: [L('1', null, 4560), L('9a', null, 38200), L('10', null, 6900), L('19', 'A', 121840)],
      }),
      k1({
        id: 'kstidewater25', name: 'Tidewater Logistics Holdings LLC', ein4: '7719', stage: 'read', secs: 0, share: [4, 4], center: 'Ogden, UT',
        l: { beginning: 88000, contributed: 0, currentYear: 41400, other: 0, withdrawals: 18000, ending: 111400 },
        lines: [L('1', null, 41900), L('13', 'A', 500, 2), L('14', 'A', 41900), L('19', 'A', 18000), L('20', 'Z', null, 3, hi, true)],
      }),
      k1({
        id: 'kslakeshore01', name: 'Lakeshore Medical Properties LP', ein4: '2265', stage: 'exported', secs: 85, share: [2.5, 3], passive: true,
        k: { nonrecourseBeg: 0, nonrecourseEnd: 0, qualifiedBeg: 48800, qualifiedEnd: 57300, recourseBeg: 0, recourseEnd: 0 },
        l: { beginning: 54300, contributed: 0, currentYear: 6478, other: 0, withdrawals: 7200, ending: 53578 },
        lines: [L('2', null, 6420), L('5', null, 58), L('19', 'A', 7200), L('20', 'A', 58)],
      }),
      // Last year's, from the same partnership: box 1 was $12,400.
      k1({
        id: 'kstidewater24', year: YEAR - 1, name: 'Tidewater Logistics Holdings LLC', ein4: '7719', stage: 'exported', secs: 130, share: [4, 4],
        l: { beginning: 84600, contributed: 0, currentYear: 11900, other: 0, withdrawals: 8500, ending: 88000 },
        lines: [L('1', null, 12400), L('13', 'A', 500, 2), L('14', 'A', 12400), L('19', 'A', 8500), L('20', 'Z', null, 3, hi, true)],
      }),
    ];
  }

  function expected() {
    var names = [
      ['Northgate Real Estate Fund III LP', '4821'], ['Bluefield Energy Partners LP', '3307'], ['Harborline Credit Fund LP', '6650'],
      ['Summit Ridge Growth Fund II LP', '1938'], ['Cedar Mill Ventures LP', '5274'], ['Old Quarry Partners LLC', '8402'],
      ['Tidewater Logistics Holdings LLC', '7719'], ['Lakeshore Medical Properties LP', '2265'],
      ['Granite Peak Infrastructure Fund LP', '3046'], ['Riverstone Farmland Partners LP', '9152'],
    ];
    return names.map(function (n) { return { name: n[0], ein4: n[1], due: n[0].indexOf('Riverstone') === 0 ? (YEAR + 1) + '-09-15' : (YEAR + 1) + '-03-15' }; });
  }

  /** The partner, as a reading would show it beside each K-1 - never stored,
   *  and here plainly made up. */
  var PARTNER = { name: 'Example Client (made up)', tin: '•••-••-0000', type: 'individual', general: false, foreign: false };

  /** A fresh copy of the example client every time. */
  function client() {
    return { id: 'sample', sample: true, label: 'Example client - tax year ' + YEAR, taxYear: YEAR, k1s: k1s(), expected: expected() };
  }

  return { client: client, PARTNER: PARTNER, YEAR: YEAR };
}));
