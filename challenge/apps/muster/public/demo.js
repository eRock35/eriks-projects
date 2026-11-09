/* Muster - the example. A MADE-UP lender, Larkmoor Community Credit Union,
 * with a made-up loan book: 60 loans, 70 borrowers (10 co-borrowers),
 * mortgages, auto loans, cards, personal and student loans, every name
 * invented and every SSN in the 900-999 area, which is never issued - the
 * one place Muster's checks let that area through, and the file is called
 * EXAMPLE-... so nobody uploads it anywhere.
 *
 * The results file is made up too, in a layout invented for this demo
 * ("Example results (made-up layout for this demo)"): Muster does not know
 * the layout of DMDC's real results file and does not pretend to.
 *
 * Every date counts from the day the page hands in, so the example works on
 * any day. What is planted, and nothing else (the test holds each one):
 *
 *   LCU-40112 B1  auto 8.99%, on active duty, no end date        Eligible
 *   LCU-40127 B1  card 24.99% + $3.95 a month in fees            Eligible
 *   LCU-40135 B1  mortgage 6.875%, service ends in 65 days       Eligible (one-year tail)
 *   LCU-40141 B2  personal 11.5%, the CO-BORROWER serves         Eligible
 *   LCU-40150 B1  auto 5.25%, on active duty                     No change - at or under 6%
 *   LCU-40163 B1  auto 7.49%, taken out during service           Check policy
 *   LCU-40172 B1  mortgage 7.125%, left active duty 4 months ago Eligible (tail running, back interest)
 *   LCU-40188 B1  personal 9.99%, a future call-up in 45 days    Watch
 *   LCU-40194 B1  student 6.8%, DMDC found no match              Check by hand
 *   LCU-40203 B1  no date of birth                               left out of the file
 *   LCU-40216 B1  a 30-letter last name with an accent           folded and cut to fit, included
 *   LCU-40229 B1  SSN with group 00 (never issued)               left out of the file
 *
 * No clock, no dice (a seeded generator), no network, no storage.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MusterDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LENDER = 'Larkmoor Community Credit Union';
  var FILE = 'EXAMPLE-larkmoor-portfolio.csv';
  var RESULTS_FILE = 'EXAMPLE-larkmoor-results.csv';
  var CONTACT = 'Member Services, 1-800-555-0142, weekdays 8 to 6';
  var BATCH = 'DEMO';
  var blurb = 'A made-up credit union’s loan book: 60 loans and 70 borrowers, with servicemembers planted for every kind of decision.';

  function dn(iso) { return Math.round(Date.parse(iso + 'T00:00:00Z') / 86400000); }
  function iso(n) { return new Date(n * 86400000).toISOString().slice(0, 10); }
  function add(isoDay, n) { return iso(dn(isoDay) + n); }
  function us(isoDay) { return isoDay.slice(5, 7) + '/' + isoDay.slice(8, 10) + '/' + isoDay.slice(0, 4); }
  function compact(isoDay) { return isoDay ? isoDay.replace(/-/g, '') : ''; }
  function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function money(c) { var s = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); return s + '.' + ('0' + (c % 100)).slice(-2); }
  function q(v) { var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

  var FIRST = ['Avery', 'Brielle', 'Caspian', 'Delphine', 'Emrys', 'Fenna', 'Gideon', 'Hollis', 'Imogen', 'Jory', 'Keturah', 'Lowen', 'Marisol', 'Nolan', 'Oriel', 'Pellam', 'Quincy', 'Rosalind', 'Soren', 'Tamsin', 'Ulric', 'Verity', 'Wren', 'Xanthe', 'Yorick', 'Zelda', 'Anouk', 'Bram', 'Calla', 'Dashiell', 'Elowen', 'Florian', 'Greer', 'Henrik', 'Isolde', 'Jasper', 'Kestrel', 'Linnea', 'Magnus', 'Niamh'];
  var LAST = ['Ashcombe', 'Bellwether', 'Crane-Hollow', 'Dunmore', 'Everleigh', 'Farrowby', 'Gilchrist', 'Halloway', 'Ingleby', 'Jessamine', 'Kittridge', 'Larkspur', 'Merriweather', 'Northcote', 'Oakhurst', 'Pemberton', 'Quarrie', 'Redfern', 'Sallow', 'Thornbury', 'Underhill', 'Vantreese', 'Westerly', 'Yarborough', 'Zellweg', 'Arkwright', 'Brackley', 'Coldwater', 'Dravenport', 'Elsworth', 'Foxley', 'Greywell', 'Hartigan', 'Ivesdale', 'Juniperson', 'Kilbride', 'Loxley', 'Marchbank', 'Nettleford', 'Ormsby'];
  var MIDDLE = ['A', 'B', 'C', 'D', 'E', 'J', 'L', 'M', 'R', 'S', 'T', ''];
  var PRODUCTS = { mortgage: ['1st Mortgage', '1st Mortgage', 'Home Equity Line'], auto: ['Auto - New', 'Auto - Used'], card: ['Visa Classic', 'Visa Platinum'], personal: ['Personal Signature'], student: ['Student Refi'] };

  // The planted cases, by loan. `who` is which borrower serves; dates count
  // from today (T).
  var PLANTED = [
    { loan: 'LCU-40112', type: 'auto', rate: '8.99', bal: 1842000, pay: 41237, origAgo: 1115, who: 1, status: { active: true, startAgo: 160 }, expect: 'eligible' },
    { loan: 'LCU-40127', type: 'card', rate: '24.99', bal: 486015, pay: 14500, fees: 395, origAgo: 1840, who: 1, status: { active: true, startAgo: 75, endIn: 200 }, expect: 'eligible' },
    { loan: 'LCU-40135', type: 'mortgage', rate: '6.875', bal: 23156042, pay: 161288, origAgo: 2930, who: 1, status: { active: true, startAgo: 300, endIn: 65 }, expect: 'eligible' },
    { loan: 'LCU-40141', type: 'personal', rate: '11.5', bal: 724000, pay: 23850, origAgo: 465, who: 2, co: true, status: { active: true, startAgo: 40 }, expect: 'eligible' },
    { loan: 'LCU-40150', type: 'auto', rate: '5.25', bal: 1290000, pay: 30144, origAgo: 900, who: 1, status: { active: true, startAgo: 500 }, expect: 'under' },
    { loan: 'LCU-40163', type: 'auto', rate: '7.49', bal: 2675000, pay: 53210, origAgo: 100, who: 1, status: { active: true, startAgo: 400 }, expect: 'policy' },
    { loan: 'LCU-40172', type: 'mortgage', rate: '7.125', bal: 18840077, pay: 134412, origAgo: 2200, who: 1, status: { left: true, releasedAgo: 122, served: 410 }, expect: 'eligible' },
    { loan: 'LCU-40188', type: 'personal', rate: '9.99', bal: 512000, pay: 18820, origAgo: 700, who: 1, status: { future: true, startIn: 45 }, expect: 'watch' },
    { loan: 'LCU-40194', type: 'student', rate: '6.80', bal: 3120000, pay: 35990, origAgo: 1500, who: 1, status: { nomatch: true }, expect: 'hand' },
  ];
  var ROW_PROBLEMS = { 'dob-missing': ['LCU-40203'], 'ssn-never': ['LCU-40229'], cut: ['LCU-40216'], folded: ['LCU-40216'] };
  var LEFT_OUT = ['LCU-40203|1', 'LCU-40229|1'];
  var SERVICE = ['Army', 'Navy', 'Air Force', 'Marine Corps', 'Army National Guard', 'Navy Reserve'];

  /** The loan book as rows (made up), for the day `today`. */
  function book(today) {
    var rnd = mulberry32(19711);
    var pick = function (a) { return a[Math.floor(rnd() * a.length)]; };
    var loans = [], person = 0;
    var mk = function (young) {
      var i = person++;
      var age = young ? 22 + Math.floor(rnd() * 20) : 26 + Math.floor(rnd() * 45);
      return {
        first: FIRST[(i * 7 + 3) % FIRST.length], last: LAST[(i * 11 + 5) % LAST.length], middle: MIDDLE[(i * 5) % MIDDLE.length],
        ssn: (901 + i) + '-' + ('0' + (11 + (i * 13) % 88)).slice(-2) + '-' + (1001 + (i * 797) % 8998),
        dob: add(today, -(age * 365 + Math.floor(rnd() * 330))),
      };
    };
    var plantedBy = {};
    PLANTED.forEach(function (p) { plantedBy[p.loan] = p; });
    var coBorrowerLoans = { 'LCU-40141': 1, 'LCU-40108': 1, 'LCU-40121': 1, 'LCU-40135': 1, 'LCU-40144': 1, 'LCU-40159': 1, 'LCU-40177': 1, 'LCU-40190': 1, 'LCU-40211': 1, 'LCU-40236': 1 };
    var others = ['mortgage', 'auto', 'auto', 'card', 'card', 'personal', 'student', 'mortgage', 'auto', 'card'];
    var ids = {};
    PLANTED.forEach(function (x) { ids[x.loan] = 1; });
    ['LCU-40203', 'LCU-40216', 'LCU-40229'].concat(Object.keys(coBorrowerLoans)).forEach(function (x) { ids[x] = 1; });
    for (var f = 40101; Object.keys(ids).length < 60; f += 3) ids['LCU-' + f] = 1;
    var list = Object.keys(ids).sort();
    for (var k = 0; k < list.length; k++) {
      var id = list[k];
      // Spread the planted ones through the book at their own ids.
      var p = plantedBy[id] || null;
      var type = p ? p.type : others[k % others.length];
      var L = {
        loan: id, type: type, product: p ? PRODUCTS[type][0] : pick(PRODUCTS[type]),
        orig: add(today, -(p ? p.origAgo : 200 + Math.floor(rnd() * 3200))),
        rate: p ? p.rate : (type === 'mortgage' ? (3.25 + Math.floor(rnd() * 13) * 0.25).toFixed(3) : type === 'card' ? (12.99 + Math.floor(rnd() * 9)).toFixed(2) : (4.49 + Math.floor(rnd() * 10) * 0.75).toFixed(2)),
        bal: p ? p.bal : (type === 'mortgage' ? 9000000 + Math.floor(rnd() * 25000000) : type === 'card' ? 30000 + Math.floor(rnd() * 900000) : 200000 + Math.floor(rnd() * 3500000)),
        fees: p && p.fees ? p.fees : 0, scra: 'N',
        people: [],
      };
      L.pay = p ? p.pay : Math.max(2500, Math.round(L.bal / (type === 'mortgage' ? 150 : 40)));
      L.people.push(mk(p && p.who === 1));
      if (coBorrowerLoans[id]) L.people.push(mk(p && p.who === 2));
      loans.push(L);
    }
    var by = {};
    loans.forEach(function (L) { by[L.loan] = L; });
    // The three rows with problems.
    by['LCU-40203'].people[0].dob = '';
    by['LCU-40216'].people[0].last = 'Ibáñez-Montgomery-Featherstone';
    by['LCU-40229'].people[0].ssn = '912-00-4471';
    return loans;
  }

  var HEAD = ['Loan Number', 'Product', 'Open Date', 'Note Rate', 'Current Balance', 'Monthly Payment', 'Monthly Fees', 'SCRA Flag', 'Borrower Last Name', 'Borrower First Name', 'Borrower Middle', 'Borrower SSN', 'Borrower DOB', 'Co-Borrower Last Name', 'Co-Borrower First Name', 'Co-Borrower Middle', 'Co-Borrower SSN', 'Co-Borrower DOB'];
  /** The made-up portfolio export as a CSV, the shape a core system writes. */
  function portfolio(today) {
    var rows = [HEAD.join(',')];
    book(today).forEach(function (L) {
      var a = L.people[0], b = L.people[1] || { last: '', first: '', middle: '', ssn: '', dob: '' };
      rows.push([L.loan, L.product, us(L.orig), L.rate, '$' + money(L.bal), '$' + money(L.pay), L.fees ? '$' + money(L.fees) : '', L.scra, a.last, a.first, a.middle, a.ssn, a.dob ? us(a.dob) : '', b.last, b.first, b.middle, b.ssn, b.dob ? us(b.dob) : ''].map(q).join(','));
    });
    return rows.join('\r\n') + '\r\n';
  }

  var RHEAD = ['Customer Record ID', 'Active Duty Status', 'Active Duty Start Date', 'Active Duty End Date', 'Left Active Duty Within 367 Days', 'Left Active Duty Start Date', 'Left Active Duty End Date', 'Notified Of Future Call-Up', 'Future Call-Up Start Date', 'Service Component', 'Match Result'];
  /** "Pretend DMDC answered": a made-up results CSV for a built batch. */
  function results(batch, today) {
    var plantedBy = {};
    PLANTED.forEach(function (p) { plantedBy[p.loan + '|' + p.who] = p; });
    var rows = [RHEAD.join(',')], n = 0;
    Object.keys(batch.map).forEach(function (crid) {
      var a = batch.map[crid], p = plantedBy[a[0] + '|' + a[1]];
      var s = p ? p.status : {};
      var svc = SERVICE[n++ % SERVICE.length];
      if (s.nomatch) { rows.push([crid, '', '', '', '', '', '', '', '', '', 'No match found'].map(q).join(',')); return; }
      rows.push([crid,
        s.active ? 'Yes' : 'No', s.active ? compact(add(today, -s.startAgo)) : '', s.active && s.endIn ? compact(add(today, s.endIn)) : '',
        s.left ? 'Yes' : 'No', s.left ? compact(add(today, -(s.releasedAgo + s.served))) : '', s.left ? compact(add(today, -s.releasedAgo)) : '',
        s.future ? 'Yes' : 'No', s.future ? compact(add(today, s.startIn)) : '',
        s.active || s.left || s.future ? svc : '', 'Record found'].map(q).join(','));
    });
    return rows.join('\r\n') + '\r\n';
  }
  /** What each planted record decides, by "loan|borrower". */
  function expected() {
    var out = {};
    PLANTED.forEach(function (p) { out[p.loan + '|' + p.who] = p.expect; });
    return out;
  }
  // The column the guess should find for each field in the portfolio.
  var MAP = { loan: 0, type: 1, orig: 2, rate: 3, bal: 4, pay: 5, fees: 6, applied: 7, b1Last: 8, b1First: 9, b1Middle: 10, b1Ssn: 11, b1Dob: 12, b2Last: 13, b2First: 14, b2Middle: 15, b2Ssn: 16, b2Dob: 17 };

  return { LENDER: LENDER, FILE: FILE, RESULTS_FILE: RESULTS_FILE, CONTACT: CONTACT, BATCH: BATCH, blurb: blurb, PLANTED: PLANTED, ROW_PROBLEMS: ROW_PROBLEMS, LEFT_OUT: LEFT_OUT, HEAD: HEAD, RHEAD: RHEAD, MAP: MAP, book: book, portfolio: portfolio, results: results, expected: expected };
}));
