/* Parity - the example migration. Generated, never saved, the same every time.
 *
 * A "customers" table of 2,000 rows exported from a legacy database (CSV,
 * CRLF line ends, NULL written as NULL) and the same table after a move to a
 * warehouse (JSON Lines). The migration changed the shape on purpose:
 *
 *   cust_id       -> customer_id            renamed
 *   full_name     -> first_name + last_name split (and trimmed)
 *   email         -> email                  lower-cased
 *   signup_dt     -> signup_date            MM/DD/YYYY -> YYYY-MM-DD
 *   balance_cents -> balance                cents -> dollars (2 places)
 *   status_cd     -> status                 A/I/S/P -> active/inactive/suspended/pending
 *   last_login    -> last_login_at          naive time -> ISO with Z
 *   company       -> company_name, phone, country
 *
 * and planted these defects, which the example must find - and nothing else:
 *   3 rows dropped, 1 row loaded twice, company_name cut to 30 characters,
 *   a batch of last_login_at moved by +4 hours, one phone null turned "".
 *
 * Every name, company and number is made up. Email addresses are built at run
 * time on example.* domains.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ParityDemo = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FIRST = ['Ada', 'Ben', 'Chloe', 'Dev', 'Elena', 'Farid', 'Grace', 'Hiro', 'Isla', 'Jonas', 'Kemi', 'Liam', 'Maya', 'Noor', 'Omar', 'Priya', 'Quinn', 'Rosa', 'Sam', 'Tariq', 'Uma', 'Victor', 'Wren', 'Xavier', 'Yara', 'Zoë', 'Mary Ann', 'José', 'Aoife', 'Lucía', 'Mei', 'Nikhil', 'Olu', 'Petra', 'Ravi', 'Sofia', 'Theo', 'Ingrid', 'Kofi', 'Lena'];
  var LAST = ['Okafor', 'Smith', 'Nguyen', "O'Brien", 'Müller', 'Patel', 'Garcia', 'Kowalski', 'Haddad', 'Svensson', 'Tanaka', 'Rossi', 'Dubois', 'Mensah', 'Fernández', 'Kim', 'Novak', 'Smith-Jones', 'Ibrahim', 'Larsen', 'Moreau', 'Silva', 'Chen', 'Adeyemi', 'Walsh', 'Kaur', 'Petrov', 'Hughes', 'Yilmaz', 'Brennan', 'Costa', 'Lindqvist', 'Abara', 'Reyes', 'Fischer', 'Morgan', 'Ito', 'Varga', 'Quigley', 'Dahl'];
  var CO_A = ['Northwind', 'Blue Harbor', 'Copperleaf', 'Summit', 'Riverbend', 'Granite', 'Bright Path', 'Oakline', 'Silverline', 'Harbor & Pine', 'Tall Grass', 'Redwood', 'Lakeside', 'Meridian', 'Juniper', 'Foxglove'];
  var CO_B = ['Logistics', 'Dental', 'Bakery', 'Analytics', 'Freight', 'Architecture', 'Consulting', 'Veterinary Clinic', 'Print Works', 'Outfitters', 'Coffee Roasters', 'Health Partners', 'Software', 'Builders'];
  var CO_C = ['', '', ' Co.', ' LLC', ' Inc.', ' & Sons', ' Group', ' International Holdings', ' Partners LLP'];
  var SPECIAL_CO = ['Dewey, Cheatem & Howe LLP', 'The "Good" Bakery', 'Ünal & Ørsted Engineering GmbH'];
  var COUNTRIES = [['US', 60], ['CA', 15], ['GB', 12], ['DE', 8], ['AU', 5]];
  var STATUS = [['A', 'active', 70], ['I', 'inactive', 15], ['S', 'suspended', 5], ['P', 'pending', 10]];

  var N = 2000, FIRST_ID = 10001;
  var DROPPED = [10457, 11023, 11888];
  var TWICE = 10777;
  var SHIFT_FROM = 11201, SHIFT_TO = 11340, SHIFT_HOURS = 4;
  var EMPTY_AFTER = 11500;   // the first customer from here with no phone: null becomes ""
  var WIDTH = 30;            // company_name is VARCHAR(30) in the warehouse

  function rng(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function p2(n) { return n < 10 ? '0' + n : String(n); }
  function weighted(r, list, w) { var total = list.reduce(function (s, x) { return s + x[w]; }, 0), x = r() * total; for (var i = 0; i < list.length; i++) { x -= list[i][w]; if (x < 0) return list[i]; } return list[list.length - 1]; }
  function ascii(s) { return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z]/g, ''); }
  function csvCell(v) {
    if (v === null) return 'NULL';
    return /[",\r\n]|^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function money(cents) {
    var neg = cents < 0, c = Math.abs(cents);
    return (neg ? '-' : '') + Math.floor(c / 100) + '.' + p2(c % 100);
  }

  /** The two files as text, and what was planted. */
  function build() {
    var r = rng(20261009);
    var people = [];
    var day0 = Date.UTC(2018, 0, 1), days = 8 * 365;
    var t0 = Date.UTC(2025, 5, 1), span = Date.UTC(2026, 9, 7) - t0;
    for (var i = 0; i < N; i++) {
      var id = FIRST_ID + i;
      var first = FIRST[Math.floor(r() * FIRST.length)], last = LAST[Math.floor(r() * LAST.length)];
      var full = first + ' ' + last;
      var pad = r();
      var fullRaw = pad < 0.025 ? ' ' + full : pad < 0.05 ? full + '  ' : full;
      var dom = ['Example.com', 'example.org', 'Example.net', 'mail.example.com'][Math.floor(r() * 4)];
      var emailRaw = ascii(first) + '.' + ascii(last) + (id % 7 === 0 ? String(id % 100) : '') + '@' + dom;
      var signup = new Date(day0 + Math.floor(r() * days) * 86400000);
      var cents = r() < 0.15 ? 0 : r() < 0.06 ? -Math.floor(r() * 50000 + 100) : Math.floor(r() * 900000 + 100);
      var st = weighted(r, STATUS, 2);
      var login = r() < 0.06 ? null : t0 + Math.floor(r() * span / 1000) * 1000;
      var co = null;
      var cr = r();
      if (cr < 0.012) co = SPECIAL_CO[Math.floor(r() * SPECIAL_CO.length)];
      else if (cr > 0.35) co = CO_A[Math.floor(r() * CO_A.length)] + ' ' + CO_B[Math.floor(r() * CO_B.length)] + CO_C[Math.floor(r() * CO_C.length)];
      var phone = r() < 0.12 ? null : '(555) 01' + Math.floor(r() * 10) + '-' + String(1000 + Math.floor(r() * 9000));
      var country = weighted(r, COUNTRIES, 1)[0];
      people.push({ id: id, first: first, last: last, fullRaw: fullRaw, emailRaw: emailRaw, signup: signup, cents: cents, st: st, login: login, co: co, phone: phone, country: country });
    }

    // Before: the legacy export.
    var B = ['cust_id,full_name,email,signup_dt,balance_cents,status_cd,last_login,company,phone,country'];
    people.forEach(function (p) {
      var d = p.signup, l = p.login === null ? null : new Date(p.login);
      B.push([
        String(p.id), p.fullRaw, p.emailRaw,
        p2(d.getUTCMonth() + 1) + '/' + p2(d.getUTCDate()) + '/' + d.getUTCFullYear(),
        String(p.cents), p.st[0],
        l === null ? null : l.getUTCFullYear() + '-' + p2(l.getUTCMonth() + 1) + '-' + p2(l.getUTCDate()) + ' ' + p2(l.getUTCHours()) + ':' + p2(l.getUTCMinutes()) + ':' + p2(l.getUTCSeconds()),
        p.co, p.phone, p.country,
      ].map(csvCell).join(','));
    });

    // After: the warehouse export, with the defects.
    var A = [], shifted = 0, truncated = 0, emptied = null;
    people.forEach(function (p) {
      if (DROPPED.indexOf(p.id) >= 0) return;
      var d = p.signup;
      var login = p.login;
      if (login !== null && p.id >= SHIFT_FROM && p.id <= SHIFT_TO) { login += SHIFT_HOURS * 3600000; shifted++; }
      var l = login === null ? null : new Date(login);
      var co = p.co;
      if (co !== null && co.length > WIDTH) { co = co.slice(0, WIDTH); truncated++; }
      var phone = p.phone;
      if (phone === null && p.id >= EMPTY_AFTER && emptied === null) { phone = ''; emptied = p.id; }
      var line = '{"customer_id":' + p.id +
        ',"first_name":' + JSON.stringify(p.first) +
        ',"last_name":' + JSON.stringify(p.last) +
        ',"email":' + JSON.stringify(p.emailRaw.toLowerCase()) +
        ',"signup_date":"' + d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate()) + '"' +
        ',"balance":' + money(p.cents) +
        ',"status":"' + p.st[1] + '"' +
        ',"last_login_at":' + (l === null ? 'null' : '"' + l.toISOString().replace('.000Z', 'Z') + '"') +
        ',"company_name":' + (co === null ? 'null' : JSON.stringify(co)) +
        ',"phone":' + (phone === null ? 'null' : JSON.stringify(phone)) +
        ',"country":"' + p.country + '"}';
      A.push(line);
      if (p.id === TWICE) A.push(line);
    });

    return {
      before: { name: 'customers_before.csv', text: B.join('\r\n') + '\r\n' },
      after: { name: 'customers_after.jsonl', text: A.join('\n') + '\n' },
      planted: { rows: N, dropped: DROPPED.slice(), twice: TWICE, shifted: shifted, shiftHours: SHIFT_HOURS, truncated: truncated, width: WIDTH, emptied: emptied },
    };
  }

  return { build: build };
}));
