/* Inside Joke - the example group. "The Riveras" are made up; so are their
 * photos, which are simple drawings made here (no stock photos, no real
 * people). Everything runs in the browser with no account and no model call:
 * today's five can be played, the board has streaks, and last Friday's game
 * night has a podium. Nothing is saved.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./ij-core'));
  else root.InsideJokeSample = factory(root.InsideJokeCore);
}(typeof self !== 'undefined' ? self : this, function (C) {
  'use strict';

  var MEMBERS = [
    { id: 'mmom', name: 'Mom', emoji: '🌻', color: 'berry', host: true },
    { id: 'mdad', name: 'Dad', emoji: '⛵', color: 'ocean' },
    { id: 'mlucia', name: 'Lucía', emoji: '🦄', color: 'grape' },
    { id: 'mmateo', name: 'Mateo', emoji: '⚽', color: 'basil' },
    { id: 'mabuela', name: 'Abuela', emoji: '☕', color: 'amber' },
    { id: 'mrafa', name: 'Tío Rafa', emoji: '🎸', color: 'rust' },
  ];
  var ME = 'mlucia';

  /* ---------------- the drawings ---------------- */

  function svg(body, bg) {
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 240">' + (bg || '') + body + '</svg>');
  }
  var PHOTOS = {
    samplelake000000: svg(
      '<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd59e"/><stop offset="1" stop-color="#ffb3a7"/></linearGradient></defs>' +
      '<rect width="320" height="240" fill="url(#s)"/><circle cx="246" cy="70" r="30" fill="#fff3c4"/>' +
      '<path d="M0 120 Q60 96 120 116 T240 108 T320 112 V240 H0Z" fill="#3f7d6e"/>' +
      '<rect y="132" width="320" height="108" fill="#2f6f9f"/><path d="M0 150h320M20 170h120M180 182h120M40 204h90" stroke="#9cc7e8" stroke-width="3" stroke-linecap="round" opacity=".7"/>' +
      '<rect x="40" y="150" width="130" height="12" rx="3" fill="#8a5a33"/><rect x="52" y="160" width="8" height="40" fill="#6b4426"/><rect x="150" y="160" width="8" height="40" fill="#6b4426"/>' +
      '<path d="M210 168h70l-12 18h-46z" fill="#f4f1ea"/><path d="M243 120v48" stroke="#5b4636" stroke-width="3"/><path d="M245 124l26 38h-26z" fill="#e8574a"/>' +
      '<rect x="92" y="134" width="30" height="16" rx="3" fill="#fff"/><rect x="92" y="130" width="30" height="6" rx="2" fill="#f28fb0"/><path d="M100 124v6M107 122v8M114 124v6" stroke="#f6c343" stroke-width="2.5" stroke-linecap="round"/>'),
    samplecabin00000: svg(
      '<rect width="320" height="240" fill="#dce9f5"/><path d="M0 150 L70 70 L130 150Z" fill="#a9c1d9"/><path d="M110 150 L200 50 L290 150Z" fill="#bcd0e4"/>' +
      '<path d="M200 50l-24 27 12-4 12 8 12-8 12 4z" fill="#fff"/><rect y="150" width="320" height="90" fill="#fdfdff"/>' +
      '<rect x="110" y="120" width="100" height="70" fill="#8b4a2b"/><path d="M98 124 L160 82 L222 124Z" fill="#5a2f1c"/><path d="M98 124 L160 82 L222 124" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round"/>' +
      '<rect x="146" y="150" width="28" height="40" fill="#3b2216"/><rect x="122" y="134" width="18" height="16" fill="#ffd77a"/><rect x="180" y="134" width="18" height="16" fill="#ffd77a"/>' +
      '<circle cx="250" cy="190" r="14" fill="#fff" stroke="#c9d6e4"/><circle cx="250" cy="168" r="10" fill="#fff" stroke="#c9d6e4"/><path d="M246 166h2M252 166h2" stroke="#333" stroke-width="2"/><path d="M250 170l8 2-8 1z" fill="#f08a24"/>' +
      '<path d="M40 60l2 2M70 40l2 2M260 30l2 2M300 80l2 2M30 110l2 2" stroke="#fff" stroke-width="4" stroke-linecap="round"/>'),
    samplecake000000: svg(
      '<rect width="320" height="240" fill="#fde7ef"/><path d="M0 0h320v40H0z" fill="#f7c6d6"/><path d="M20 40l20 22 20-22 20 22 20-22 20 22 20-22 20 22 20-22 20 22 20-22 20 22 20-22 20 22 20-22" fill="none" stroke="#e86a92" stroke-width="3"/>' +
      '<rect x="70" y="190" width="180" height="12" rx="6" fill="#d9a6b8"/><rect x="90" y="140" width="140" height="52" rx="8" fill="#fff"/><rect x="90" y="140" width="140" height="16" rx="8" fill="#f59ab9"/>' +
      '<rect x="110" y="100" width="100" height="42" rx="8" fill="#fff8e6"/><path d="M110 112h100" stroke="#f59ab9" stroke-width="6"/>' +
      '<text x="160" y="182" text-anchor="middle" font-family="Georgia,serif" font-size="26" font-weight="700" fill="#c2185b">80</text>' +
      '<path d="M130 100v-16M150 100v-20M170 100v-20M190 100v-16" stroke="#8ec5ff" stroke-width="5" stroke-linecap="round"/><path d="M130 78q-4-8 0-12 4 4 0 12zM150 74q-4-8 0-12 4 4 0 12zM170 74q-4-8 0-12 4 4 0 12zM190 78q-4-8 0-12 4 4 0 12z" fill="#ffb300"/>' +
      '<circle cx="40" cy="120" r="14" fill="#ffd54f"/><path d="M40 134v40" stroke="#bbb"/><circle cx="282" cy="110" r="14" fill="#80deea"/><path d="M282 124v40" stroke="#bbb"/>'),
    samplebeach00000: svg(
      '<rect width="320" height="240" fill="#bfe6ff"/><circle cx="60" cy="56" r="26" fill="#ffe082"/><rect y="110" width="320" height="50" fill="#3aa0d8"/><path d="M0 128q40-8 80 0t80 0 80 0 80 0" fill="none" stroke="#e0f4ff" stroke-width="4"/>' +
      '<rect y="156" width="320" height="84" fill="#f2d49b"/><path d="M190 200h70l-8-30h-14v-14h-10v14h-14z" fill="#d9a85f"/><path d="M211 156l6-10 6 10" fill="#e8574a"/>' +
      '<path d="M60 230 Q90 170 120 230" fill="#e8574a"/><path d="M90 170v60" stroke="#7b5536" stroke-width="3"/><rect x="40" y="196" width="40" height="22" rx="4" fill="#4f9d69"/>' +
      '<path d="M140 180 l18 -8 l6 14 l-18 8z" fill="#ffca28"/><circle cx="286" cy="186" r="9" fill="#ff7043"/><path d="M280 184h12" stroke="#fff" stroke-width="2"/>'),
  };

  /* ---------------- the bank ---------------- */

  var Q = {
    lake_where: { id: 'qlakewhere0000001', kind: 'choice', style: 'where', prompt: 'Where was this taken?', options: ['Lake Tahoe', 'Lake Lanier', 'Lake Placid', 'Lake Geneva'], answer: 1, photoId: 'samplelake000000', createdBy: 'mmom' },
    lake_when: { id: 'qlakewhen00000001', kind: 'number', style: 'when', prompt: 'What year was the dock-cake disaster?', answer: 2019, tolerance: 1, photoId: 'samplelake000000', createdBy: 'mmom' },
    dad_said: { id: 'qdadsaid000000001', kind: 'choice', style: 'who_said', prompt: 'Who said it?', quote: 'If the GPS says turn left, I’m turning right. Trust me.', options: ['Tío Rafa', 'Dad', 'Mateo', 'Abuela'], answer: 1, createdBy: 'mmateo', aboutName: 'Dad' },
    owl: { id: 'qnightowl00000001', kind: 'choice', style: 'chat_stat', prompt: 'Who’s the night owl - most messages between 11pm and 4am?', options: ['Mateo', 'Mom', 'Lucía', 'Tío Rafa'], answer: 0, createdBy: 'mrafa', aboutName: 'Mateo' },
    cousins: { id: 'qcousins000000001', kind: 'number', style: 'own_number', prompt: 'How many cousins came to the 2022 reunion in San Juan?', answer: 23, tolerance: 2, unit: 'cousins', createdBy: 'mabuela' },
    cake_what: { id: 'qcakewhat00000001', kind: 'choice', style: 'whats_happening', prompt: 'Whose birthday was this cake for?', options: ['Abuela’s 80th', 'Mom’s 50th', 'Tío Rafa’s 40th'], answer: 0, photoId: 'samplecake000000', createdBy: 'mdad' },
    cabin_cap: { id: 'qcabincap00000001', kind: 'caption', style: 'caption_this', prompt: 'Caption this!', options: ['The snowman is the only one who packed right', 'Day 3: we have run out of hot chocolate', 'Dad said it would be “mild”'], answer: null, photoId: 'samplecabin00000', createdBy: 'mmom' },
    emoji: { id: 'qemojifav0000001', kind: 'choice', style: 'chat_stat', prompt: 'Whose favourite emoji is 🙏?', options: ['Mom', 'Abuela', 'Dad', 'Lucía'], answer: 1, createdBy: 'mrafa', aboutName: 'Abuela' },
    tf_late: { id: 'qtflate0000000001', kind: 'choice', style: 'own_tf', prompt: 'True or false: Dad has never once been early to a family dinner.', options: ['True', 'False'], answer: 1, createdBy: 'mmateo' },
    beach_odd: { id: 'qbeachodd0000001', kind: 'choice', style: 'odd_one_out', prompt: 'Odd one out: which of these was NOT on the beach that day?', options: ['A red umbrella', 'A sandcastle', 'A surfboard', 'A beach ball'], answer: 2, photoId: 'samplebeach00000', createdBy: 'mdad' },
  };
  var TODAY = ['lake_where', 'dad_said', 'owl', 'cousins', 'cake_what'];

  /* ---------------- other people's day ---------------- */

  // Results the rest of the family already posted today.
  var RESULTS = [
    { id: 'mabuela', score: 5, of: 5, from: 'San Juan', marks: [true, true, true, true, true] },
    { id: 'mmom', score: 4, of: 5, from: 'Atlanta', marks: [true, true, true, false, true] },
    { id: 'mmateo', score: 3, of: 5, from: 'Boulder', marks: [true, false, true, false, true] },
  ];

  // Streak days, counted back from today: Abuela every day for 23 days,
  // Mom 6 including today, Lucía 4 up to yesterday (alive - play today to
  // make it 5), Mateo 2, Dad's best was 9 but he lapsed, Tío Rafa plays in
  // bursts.
  function boardFor(today) {
    var days = {};
    function put(mid, back, score) { var d = C.addDays(today, -back); (days[d] = days[d] || {})[mid] = [score, 5]; }
    var i;
    for (i = 0; i < 23; i++) put('mabuela', i, i ? [4, 5, 3, 4, 5][i % 5] : 5);
    for (i = 0; i < 6; i++) put('mmom', i, i ? [3, 4, 4, 2, 5][i % 5] : 4);
    for (i = 1; i <= 4; i++) put('mlucia', i, [4, 3, 5, 4][i - 1]);
    for (i = 9; i <= 14; i++) put('mlucia', i, 3);
    put('mmateo', 0, 3); put('mmateo', 1, 4);
    for (i = 12; i < 21; i++) put('mdad', i, [2, 3, 4][i % 3]);
    [2, 3, 5, 8, 9, 10, 16].forEach(function (b) { put('mrafa', b, [5, 4, 3][b % 3]); });
    var total = {};
    Object.keys(days).forEach(function (d) { Object.keys(days[d]).forEach(function (mid) { var t = total[mid] = total[mid] || { pts: 0, played: 0 }; t.pts += days[d][mid][0]; t.played++; }); });
    // A longer history than the 30 days drawn here.
    total.mabuela.pts += 212; total.mabuela.played += 61;
    total.mdad.pts += 140; total.mdad.played += 48;
    total.mmom.pts += 171; total.mmom.played += 52;
    total.mrafa.pts += 96; total.mrafa.played += 27;
    return { days: days, total: total, best: { mdad: 9, mabuela: 23, mrafa: 5 } };
  }

  var PODIUM = {
    when: 'Last Friday, on a video call',
    players: [
      { id: 'mrafa', score: 6240 }, { id: 'mlucia', score: 5910 }, { id: 'mmom', score: 5020 },
      { id: 'mmateo', score: 4400 }, { id: 'mdad', score: 3150 }, { id: 'mabuela', score: 2980 },
    ],
  };

  var CHAT = {
    total: 18432, from: '2019-03-02', to: '2026-10-01',
    people: [
      { name: 'Mom', count: 5210, night: 31, early: 402, lol: 210, topEmoji: '❤️' },
      { name: 'Tío Rafa', count: 4120, night: 288, early: 12, lol: 640, topEmoji: '😂' },
      { name: 'Abuela', count: 3302, night: 4, early: 911, lol: 18, topEmoji: '🙏' },
      { name: 'Mateo', count: 2650, night: 702, early: 3, lol: 377, topEmoji: '💀' },
      { name: 'Lucía', count: 1990, night: 240, early: 40, lol: 301, topEmoji: '✈️' },
      { name: 'Dad', count: 1160, night: 15, early: 280, lol: 22, topEmoji: '👍' },
    ],
    busiest: { date: '2022-07-16', count: 412, why: 'the San Juan reunion' },
  };

  /** A fresh copy of everything the page needs, for one viewer's session. */
  function state(today) {
    var qs = {};
    Object.keys(Q).forEach(function (k) { qs[k] = JSON.parse(JSON.stringify(Q[k])); });
    return { members: MEMBERS.slice(), me: ME, qs: qs, today: TODAY.slice(), results: RESULTS.slice(), board: boardFor(today), podium: PODIUM, chat: CHAT, picks: {}, from: null };
  }

  return { MEMBERS: MEMBERS, ME: ME, PHOTOS: PHOTOS, Q: Q, TODAY: TODAY, RESULTS: RESULTS, PODIUM: PODIUM, CHAT: CHAT, boardFor: boardFor, state: state, NAME: 'The Riveras' };
}));
