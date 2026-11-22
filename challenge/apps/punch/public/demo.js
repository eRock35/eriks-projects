/* Punch - the example. A made-up job, client and house, drawn here as
 * pictures, so the tour can walk it with every tap working. Nothing in it
 * is kept, sent or synced, and no clock or dice: its times are fixed.
 *
 * The story: a kitchen and bath refresh for Odalys Brennecke (invented),
 * twelve fixes across the kitchen, the bathroom and the hallway. Pin #3 (the
 * outlet cover by the range) is fixed and waits to be verified; #1 and #9
 * are verified; #2, the sagging cabinet door, was due yesterday. The tile
 * sub has two still to do (#4 and #6). Nobody has signed yet.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./punch-core'));
  else root.PunchDemo = factory(root.PunchCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var T = 1795359600000;          // 2026-11-22, mid-morning
  var TODAY = '2026-11-22';
  var JOB = 'jdemo00001';
  var NAME = 'Kitchen and bath refresh';
  var CLIENT = 'Odalys Brennecke';
  var AREAS = { akitch0001: 'Kitchen', abath00001: 'Bathroom', ahall00001: 'Hallway' };
  var NOTICE = 'This is the made-up example - every tap works, and nothing is kept.';

  //       id            area          trade          pri       due           note                                                             x    y    state       on
  var ROWS = [
    ['pdemo00001', 'akitch0001', 'Paint', 'normal', '2026-11-24', 'Ceiling patch above the window needs a second coat', 500, 111, 'verified', '2026-11-21'],
    ['pdemo00002', 'akitch0001', 'Carpentry', 'high', '2026-11-21', 'Upper cabinet door left of the window sags - adjust the hinges', 217, 433, 'open', ''],
    ['pdemo00003', 'akitch0001', 'Electrical', 'high', '2026-11-23', 'Outlet cover missing right of the range', 867, 556, 'fixed', '2026-11-22'],
    ['pdemo00004', 'akitch0001', 'Tile', 'normal', '2026-11-25', 'Grout gap in the backsplash left of the sink', 358, 578, 'open', ''],
    ['pdemo00005', 'akitch0001', 'Plumbing', 'normal', '', 'Faucet drips when it is off', 500, 640, 'open', ''],
    ['pdemo00006', 'abath00001', 'Tile', 'high', '2026-11-24', 'Cracked floor tile in front of the tub', 417, 922, 'open', ''],
    ['pdemo00007', 'abath00001', 'Plumbing', 'normal', '2026-11-24', 'Re-caulk the tub edge - gap along the back', 433, 622, 'fixed', '2026-11-21'],
    ['pdemo00008', 'abath00001', 'Electrical', 'low', '', 'Fan cover hangs crooked and rattles', 467, 78, 'open', ''],
    ['pdemo00009', 'abath00001', 'Carpentry', 'normal', '2026-11-21', 'Door doesn’t latch - move the strike plate', 167, 522, 'verified', '2026-11-21'],
    ['pdemo00010', 'ahall00001', 'Drywall', 'normal', '2026-11-26', 'Two nail pops by the light switch', 308, 500, 'open', ''],
    ['pdemo00011', 'ahall00001', 'Paint', 'low', '2026-11-26', 'Scuffed baseboard by the closet', 583, 833, 'open', ''],
    ['pdemo00012', 'ahall00001', 'Flooring', 'normal', '2026-11-24', 'Transition strip at the bath door is loose', 933, 878, 'fixed', '2026-11-22'],
  ];

  function book() {
    var b = C.newBook(0);
    b = C.putJob(b, JOB, NAME, CLIENT, T - 900000);
    var k = 0;
    Object.keys(AREAS).forEach(function (aid) { k += 1000; b = C.putArea(b, aid, JOB, AREAS[aid], 1333, T - 800000 + k); });
    ROWS.forEach(function (r, i) {
      var t = T - 600000 + i * 1000;
      b = C.addItem(b, r[0], { area: r[1], trade: r[2], pri: r[3], due: r[4], note: r[5], x: r[6], y: r[7] }, t);
      if (r[8] !== 'open') b = C.setState(b, r[0], r[8], r[9], t + 200000);
    });
    return b;
  }

  /* ---------------- the pictures ---------------- */

  var W = 1200, H = 900;
  function rect(x, y, w, h, fill, extra) { return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + fill + '"' + (extra || '') + '/>'; }
  function tiles(x0, y0, x1, y1, step, col) {
    var s = '';
    for (var x = x0; x <= x1; x += step) s += '<path d="M' + x + ' ' + y0 + 'V' + y1 + '" stroke="' + col + '" stroke-width="3"/>';
    for (var y = y0; y <= y1; y += step / 2) s += '<path d="M' + x0 + ' ' + y + 'H' + x1 + '" stroke="' + col + '" stroke-width="3"/>';
    return s;
  }
  // Each area's picture, with each fix drawn as it was (the "before") unless
  // that pin is in `fixed`.
  var SCENES = {
    akitch0001: function (f) {
      return rect(0, 0, W, H, '#e9e2d6') + rect(0, 0, W, 90, '#f4f1ea') + rect(0, 760, W, 140, '#b48a5a') +
        (f.pdemo00001 ? '' : '<ellipse cx="600" cy="100" rx="80" ry="24" fill="#cfc6b2"/><ellipse cx="640" cy="96" rx="34" ry="12" fill="#bfb49c"/>') +
        rect(470, 130, 260, 250, '#ffffff') + rect(486, 146, 228, 218, '#bcd7ea') + '<path d="M600 146V364M486 255H714" stroke="#ffffff" stroke-width="10"/>' +
        rect(100, 420, 1000, 180, '#f2efe9') + tiles(100, 420, 1100, 600, 60, '#d6d2cc') +
        (f.pdemo00004 ? '' : '<path d="M400 500l20 14-12 16 22 12-10 18" stroke="#2b2b2b" stroke-width="7" fill="none"/>') +
        (f.pdemo00002 ? rect(124, 140, 150, 256, '#8a6f52', ' stroke="#5f4a35" stroke-width="6"') : '<g transform="rotate(4 124 140)">' + rect(124, 140, 150, 256, '#8a6f52', ' stroke="#5f4a35" stroke-width="6"') + '</g>') +
        rect(284, 140, 150, 256, '#8a6f52', ' stroke="#5f4a35" stroke-width="6"') + rect(766, 140, 150, 256, '#8a6f52', ' stroke="#5f4a35" stroke-width="6"') + rect(926, 140, 150, 256, '#8a6f52', ' stroke="#5f4a35" stroke-width="6"') +
        '<circle cx="254" cy="380" r="7" fill="#d9c7a3"/><circle cx="304" cy="380" r="7" fill="#d9c7a3"/>' +
        rect(1020, 476, 40, 52, f.pdemo00003 ? '#ffffff' : '#3a3a3a', ' stroke="#9a948a" stroke-width="3"') +
        (f.pdemo00003 ? '<path d="M1033 492v8M1047 492v8M1033 510v8M1047 510v8" stroke="#555" stroke-width="4"/>' : '<path d="M1030 490c10 10 0 20 10 30M1050 490c-8 12 4 18-6 30" stroke="#c0392b" stroke-width="4" fill="none"/>') +
        rect(560, 520, 16, 64, '#9aa3ad') + rect(560, 520, 70, 14, '#9aa3ad') +
        (f.pdemo00005 ? '' : '<path d="M622 548q6 12 0 18q-6-6 0-18zM622 578q6 12 0 18q-6-6 0-18z" fill="#3b82c4"/>') +
        rect(80, 600, 1040, 24, '#3d4146') + rect(100, 624, 1000, 136, '#7c6448') + rect(520, 600, 180, 10, '#2a2d31') +
        rect(800, 624, 180, 136, '#30343a') + '<circle cx="840" cy="650" r="9" fill="#999"/><circle cx="890" cy="650" r="9" fill="#999"/><circle cx="940" cy="650" r="9" fill="#999"/>';
    },
    abath00001: function (f) {
      return rect(0, 0, W, H, '#dfe8ea') + rect(0, 760, W, 140, '#e8e4dc') + tiles(0, 760, W, 900, 100, '#c6c0b5') +
        (f.pdemo00006 ? '' : '<path d="M460 790l30 20-14 20 40 30-10 30" stroke="#333" stroke-width="6" fill="none"/>') +
        (f.pdemo00008 ? rect(500, 45, 120, 50, '#f7f7f7', ' stroke="#9aa" stroke-width="4"') : '<g transform="rotate(-9 560 70)">' + rect(500, 45, 120, 50, '#f7f7f7', ' stroke="#9aa" stroke-width="4"') + '</g>') +
        '<path d="M515 60h90M515 72h90M515 84h90" stroke="#bbb" stroke-width="3"/>' +
        rect(40, 150, 180, 610, '#c9b28f', ' stroke="#9c845f" stroke-width="6"') + '<circle cx="196" cy="470" r="10" fill="#8a7a5c"/>' +
        (f.pdemo00009 ? '' : rect(220, 150, 14, 610, '#4a4a4a')) +
        rect(260, 560, 500, 200, '#ffffff', ' stroke="#c9d2d5" stroke-width="6"') +
        (f.pdemo00007 ? rect(262, 552, 496, 12, '#f8f8f8') : '<path d="M300 558h420" stroke="#3a3a3a" stroke-width="8" stroke-dasharray="40 14"/>') +
        rect(840, 190, 260, 260, '#cfe3ec', ' stroke="#9fb4bd" stroke-width="8"') + rect(830, 540, 290, 220, '#7d8b93') + rect(820, 520, 310, 24, '#f1eee8');
    },
    ahall00001: function (f) {
      return rect(0, 0, W, H, '#ece6df') + rect(0, 760, W, 140, '#9c7752') + rect(0, 738, W, 22, '#fbfaf7') +
        rect(760, 160, 220, 580, '#f4efe6', ' stroke="#cfc6b6" stroke-width="8"') + '<circle cx="950" cy="460" r="10" fill="#b49a6a"/>' +
        rect(1060, 160, 140, 600, '#d9d0c2') +
        (f.pdemo00012 ? rect(1040, 756, 160, 12, '#b8a07a') : '<g transform="rotate(-6 1040 762)">' + rect(1040, 750, 160, 12, '#b8a07a') + '</g>') +
        rect(280, 420, 44, 70, '#fbfaf7', ' stroke="#c9c1b4" stroke-width="3"') + rect(296, 440, 12, 28, '#e4ddd0') +
        (f.pdemo00010 ? '' : '<circle cx="370" cy="400" r="9" fill="#d3cabc"/><circle cx="386" cy="520" r="9" fill="#d3cabc"/>') +
        (f.pdemo00011 ? '' : '<path d="M640 748q30-8 60 0M670 752q30-6 70 2" stroke="#8d8578" stroke-width="7" fill="none"/>') +
        '<path d="M120 300h300v8H120z" fill="#b9ad98"/>';
    },
  };
  function svgUrl(svg) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); }
  function wrap(inner, vb) { return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb + '" width="1200" height="900">' + inner + '</svg>'; }
  /** An area's "before" photo. */
  function photo(aid) { var s = SCENES[aid]; return s ? svgUrl(wrap(s({}), '0 0 1200 900')) : null; }
  /** A fixed pin's "after": the same spot, close up, with that fix done. */
  function after(pid) {
    var r = ROWS.filter(function (x) { return x[0] === pid; })[0];
    if (!r || r[8] === 'open') return null;
    var fixed = {}; fixed[pid] = true;
    var w = 480, h = 360;
    var x = Math.max(0, Math.min(W - w, r[6] / 1000 * W - w / 2)), y = Math.max(0, Math.min(H - h, r[7] / 1000 * H - h / 2));
    return svgUrl(wrap(SCENES[r[1]](fixed), x + ' ' + y + ' ' + w + ' ' + h));
  }

  // The client's signature for the tour: strokes, per mille of the pad.
  var SIGN = [
    [[90, 600], [120, 380], [180, 300], [240, 360], [230, 560], [160, 640], [110, 560], [150, 420], [260, 380]],
    [[300, 620], [320, 300], [330, 620], [400, 520], [420, 600], [470, 520], [500, 610], [540, 480], [560, 620]],
    [[600, 600], [640, 340], [700, 330], [690, 450], [630, 470], [720, 520], [700, 620], [620, 620]],
    [[760, 560], [800, 500], [840, 560], [880, 500], [930, 540]],
  ];

  return { T: T, TODAY: TODAY, JOB: JOB, NAME: NAME, CLIENT: CLIENT, AREAS: AREAS, ROWS: ROWS, NOTICE: NOTICE, book: book, photo: photo, after: after, SIGN: SIGN, KITCHEN: 'akitch0001', OUTLET: 'pdemo00003' };
}));
