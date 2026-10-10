// Pure rules first, then the page's own files, then end to end over HTTP:
//   SPROUT_MEMORY=1 SPROUT_FAKE_AI=1 node test/run.js   (or `npm test`)
//
// The HTTP half drives the real Express app mounted under /sprout, the way
// the lab mounts it, so the auth cookie, the budget gate and the metered
// route's parser order are exercised as deployed. Model calls are counted
// from the identity's usage rows - the same rows that bill a real account -
// and what reached "the model" is read from the fake client's own log.

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const express = require('express');

if (process.env.SPROUT_MEMORY !== '1' || process.env.SPROUT_FAKE_AI !== '1') {
  console.error('run with SPROUT_MEMORY=1 SPROUT_FAKE_AI=1');
  process.exit(1);
}

const { app, identityStore, fakeCalls } = require('../server');
const C = require('../public/sprout-core');
const D = require('../public/demo');

const ROOT = path.join(__dirname, '..');
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* ---------------- helpers ---------------- */

const T = '2026-07-15'; // midsummer in the north: season factor 1
const N = { today: T, hemi: 'north' };
function plant(cat, lastAgo, extra) {
  const raw = { cat, nick: 'Testy', room: 'living', light: C.catalogue(cat) ? C.catalogue(cat).light.ideal : 1, pot: 'm', drain: true, added: C.addDays(T, -200), events: [] };
  if (lastAgo !== null && lastAgo !== undefined) raw.events.push({ k: 'water', d: C.addDays(T, -lastAgo) });
  return C.cleanPlant(Object.assign(raw, extra || {}), { today: T });
}
const bandAt = (p, today, hemi) => C.bandOf(p, today || T, hemi || 'north');

/* ---------------- the catalogue ---------------- */

test('the catalogue: ~85 plants, every field present and valid, ids unique, guidance not gospel', () => {
  assert.ok(C.CATALOGUE.length >= 80, `${C.CATALOGUE.length} plants`);
  const ids = new Set();
  for (const c of C.CATALOGUE) {
    assert.ok(/^[a-z]{2,20}$/.test(c.id) && !ids.has(c.id), c.id); ids.add(c.id);
    assert.ok(c.name && c.name.length <= 30, c.id);
    assert.strictEqual(C.cleanEmoji(c.emoji), c.emoji, `${c.id}: one emoji`);
    assert.ok(C.GROUPS[c.group], `${c.id}: group ${c.group}`);
    const { min, ideal, max } = c.light;
    assert.ok([min, ideal, max].every((x) => Number.isInteger(x) && x >= 0 && x <= 3) && min <= ideal && ideal <= max, `${c.id}: light`);
    assert.ok(Number.isInteger(c.water) && c.water >= 2 && c.water <= 30, `${c.id}: water ${c.water}`);
    assert.ok(C.SOIL_IDS.includes(c.soil), `${c.id}: soil`);
    assert.ok(C.HUMIDITY[c.humidity], `${c.id}: humidity`);
    assert.ok(['safe', 'toxic', 'check'].includes(c.pets), `${c.id}: pets`);
    assert.ok(c.tip.length >= 15 && c.tip.length <= 140 && /[.!]$/.test(c.tip), `${c.id}: tip`);
    assert.ok(c.mistake.length >= 15 && c.mistake.length <= 140 && /[.!]$/.test(c.mistake), `${c.id}: mistake`);
    assert.ok(!/[<>]/.test(c.tip + c.mistake + c.name), c.id);
  }
  for (const id of ['pothos', 'monstera', 'snake', 'zz', 'peacelily', 'fiddle', 'spider', 'calathea', 'echeveria', 'cactus', 'phalaenopsis', 'aloe', 'rubber', 'bostonfern', 'pearls', 'hoya', 'philodendron', 'alocasia', 'birdofparadise', 'basil', 'mint']) assert.ok(C.catalogue(id), id);
  assert.ok(C.CATALOGUE.filter((c) => c.popular).length >= 16, 'a popular grid');
  for (const k of Object.keys(C.SOIL)) assert.ok(C.SOIL[k].short && C.SOIL[k].check, k);
});

test('pet safety follows the well-known ASPCA listings; unclear ones say "check"', () => {
  const want = { pothos: 'toxic', monstera: 'toxic', snake: 'toxic', zz: 'toxic', peacelily: 'toxic', fiddle: 'toxic', aloe: 'toxic', jade: 'toxic', rubber: 'toxic', philodendron: 'toxic', alocasia: 'toxic', pearls: 'toxic', englishivy: 'toxic',
    spider: 'safe', calathea: 'safe', maranta: 'safe', bostonfern: 'safe', phalaenopsis: 'safe', hoya: 'safe', areca: 'safe', parlour: 'safe', peperomia: 'safe', christmascactus: 'safe', africanviolet: 'safe', castiron: 'safe', moneytree: 'safe', basil: 'safe' };
  for (const [id, v] of Object.entries(want)) assert.strictEqual(C.catalogue(id).pets, v, id);
  assert.ok(C.CATALOGUE.filter((c) => c.pets === 'check').length >= 5, 'uncertain ones are marked, not guessed');
  for (const k of ['safe', 'toxic', 'check']) assert.ok(C.PETS[k].line.length > 20);
});

test('search: names and the names people know them by; hostile input is just text', () => {
  assert.strictEqual(C.search('sansevieria')[0].id, 'snake');
  assert.strictEqual(C.search('swiss cheese plant')[0].id, 'monstera');
  assert.strictEqual(C.search('swiss cheese')[0].id, 'adansonii', 'the vine is the one actually named that');
  assert.strictEqual(C.search('Monstera')[0].id, 'monstera');
  assert.ok(C.search('fern').every((c) => /fern/i.test(c.name + c.aka + c.group)));
  assert.strictEqual(C.search('').length, C.CATALOGUE.filter((c) => c.popular).length > 24 ? 24 : C.CATALOGUE.filter((c) => c.popular).length);
  assert.deepStrictEqual(C.search('<script>alert(1)</script>'), []);
  assert.strictEqual(C.catalogue('__proto__'), null); assert.strictEqual(C.catalogue('constructor'), null);
  const taken = ['Bert', 'Monty'];
  assert.strictEqual(C.suggestNick('monstera', taken, 0), 'Cookie Monstera');
  assert.notStrictEqual(C.suggestNick('monstera', [], 0), C.suggestNick('monstera', [], 1), 'the dice gives another');
});

/* ---------------- days, bands, time zones ---------------- */

test('bands: thirsty on the day and after, check soil the day before (or after a Not yet), coming up, happy', () => {
  const m = (ago) => C.status(plant('monstera', ago), T, 'north');
  assert.deepStrictEqual([m(7).band, m(7).chip], ['thirsty', 'Today']);
  assert.deepStrictEqual([m(9).band, m(9).chip], ['thirsty', '2 days late']);
  assert.deepStrictEqual([m(6).band, m(6).chip], ['check', 'Tomorrow']);
  assert.deepStrictEqual([m(5).band, m(4).band, m(3).band], ['soon', 'soon', 'happy']);
  assert.deepStrictEqual([m(0).band, m(0).chip], ['happy', 'Watered today']);
  const unknown = C.status(plant('monstera', null), T, 'north');
  assert.deepStrictEqual([unknown.band, unknown.chip], ['check', 'Feel the soil'], 'no history: feel the soil today');
  for (const b of C.BANDS) assert.ok(b.label && b.icon, 'every band has words and an icon, never colour alone');
});

test('"today" is the phone\'s: one instant is Today in Los Angeles and already past in Auckland; bands turn at local midnight', () => {
  const p = plant('monstera', 7); // due T
  const instant = Date.parse('2026-07-15T20:00:00Z'); // 1pm in LA on the 15th, 8am on the 16th in Auckland
  assert.strictEqual(C.localDate(instant, 'America/Los_Angeles'), '2026-07-15');
  assert.strictEqual(C.localDate(instant, 'Pacific/Auckland'), '2026-07-16');
  assert.strictEqual(C.status(p, C.localDate(instant, 'America/Los_Angeles'), 'north').chip, 'Today');
  assert.strictEqual(C.status(p, C.localDate(instant, 'Pacific/Auckland'), 'north').chip, '1 day late');
  // One minute either side of midnight in New York.
  const before = Date.parse('2026-07-15T03:59:00Z'), after = Date.parse('2026-07-15T04:01:00Z');
  assert.strictEqual(bandAt(p, C.localDate(before, 'America/New_York')), 'check');
  assert.strictEqual(bandAt(p, C.localDate(after, 'America/New_York')), 'thirsty');
  assert.strictEqual(C.cleanTz('Not/AZone'), 'UTC'); assert.strictEqual(C.cleanTz('<script>'), 'UTC');
});

test('DST: dates stay calendar dates - a week is seven days across the spring and autumn changes', () => {
  // US clocks go forward 2026-03-08 and back 2026-11-01; Europe 2026-03-29 and 2026-10-25.
  for (const [last, tz, eve, morning] of [['2026-03-02', 'America/New_York', '2026-03-09T03:59:00Z', '2026-03-09T04:01:00Z'], ['2026-10-26', 'America/New_York', '2026-11-02T04:59:00Z', '2026-11-02T05:01:00Z'], ['2026-10-19', 'Europe/London', '2026-10-25T23:59:00Z', '2026-10-26T00:01:00Z']]) {
    assert.strictEqual(C.addDays(last, 7), C.addDays(C.addDays(last, 3), 4));
    const p = C.cleanPlant({ cat: 'monstera', nick: 'Dst', events: [{ k: 'water', d: last }], added: '2026-01-01' }, {});
    const hemi = 'off';
    const due = C.dueOf(p, last, hemi).due;
    assert.strictEqual(due, C.addDays(last, 7), tz);
    assert.notStrictEqual(C.bandOf(p, C.localDate(Date.parse(eve), tz), hemi), 'thirsty', `${tz} the evening before`);
    assert.strictEqual(C.bandOf(p, C.localDate(Date.parse(morning), tz), hemi), 'thirsty', `${tz} just after midnight`);
  }
  assert.strictEqual(C.daysBetween('2026-03-07', '2026-03-09'), 2);
  assert.strictEqual(C.daysBetween('2026-10-31', '2026-11-02'), 2);
});

/* ---------------- seasons ---------------- */

test('seasons: longer between drinks in winter, by hemisphere (guessed from the time zone), more for succulents, off in the tropics', () => {
  assert.strictEqual(C.hemisphereOf('Europe/London'), 'north');
  assert.strictEqual(C.hemisphereOf('America/New_York'), 'north');
  for (const z of ['Australia/Sydney', 'Pacific/Auckland', 'America/Sao_Paulo', 'America/Argentina/Buenos_Aires', 'Africa/Johannesburg', 'America/Santiago']) assert.strictEqual(C.hemisphereOf(z), 'south', z);
  assert.strictEqual(C.hemisphereOf('garbage'), 'north');
  assert.strictEqual(C.seasonFactor('foliage', '2026-07-15', 'north'), 1);
  assert.strictEqual(C.seasonFactor('foliage', '2026-01-15', 'north'), 1.4);
  assert.strictEqual(C.seasonFactor('foliage', '2026-01-15', 'south'), 1);
  assert.strictEqual(C.seasonFactor('foliage', '2026-07-15', 'south'), 1.4);
  assert.strictEqual(C.seasonFactor('cactus', '2026-01-15', 'north'), 2);
  assert.strictEqual(C.seasonFactor('foliage', '2026-01-15', 'off'), 1);
  assert.ok(C.seasonFactor('foliage', '2026-11-15', 'north') > C.seasonFactor('foliage', '2026-10-15', 'north'), 'it stretches gradually through autumn');
  assert.deepStrictEqual([C.seasonName('2026-01-15', 'north'), C.seasonName('2026-01-15', 'south'), C.seasonName('2026-04-10', 'north'), C.seasonName('2026-10-10', 'north'), C.seasonName('2026-01-15', 'off')], ['winter', 'summer', 'spring', 'autumn', null]);
  const p = plant('monstera', 0);
  assert.strictEqual(C.effective(p, '2026-01-10', 'north'), 10);
  assert.strictEqual(C.effective(p, '2026-01-10', 'south'), 7);
  assert.strictEqual(C.effective(p, '2026-07-10', 'south'), 10);
  const cactus = plant('cactus', 0);
  assert.strictEqual(C.effective(cactus, '2026-01-10', 'north'), 42);
  // A drink in January in the north is next due ten days later, not seven.
  const jan = C.cleanPlant({ cat: 'monstera', nick: 'J', added: '2025-06-01', events: [{ k: 'water', d: '2026-01-10' }] }, {});
  assert.strictEqual(C.dueOf(jan, '2026-01-12', 'north').due, '2026-01-20');
  assert.strictEqual(C.dueOf(jan, '2026-01-12', 'south').due, '2026-01-17');
});

/* ---------------- learning ---------------- */

test('learning: each "Not yet" stretches that plant\'s interval a step and looks again soon - never past the bound', () => {
  let p = plant('monstera', 7);
  assert.strictEqual(C.learned(p), 7);
  const r = C.act(p, 'notyet', N);
  assert.strictEqual(r.plant.interval, 7.84);
  assert.deepStrictEqual(r.plant.hold, { d: C.addDays(T, 2), why: 'check' });
  assert.strictEqual(C.bandOf(r.plant, T, 'north'), 'soon', 'not asked again today');
  assert.strictEqual(C.bandOf(r.plant, C.addDays(T, 2), 'north'), 'check', 'asked to feel the soil again, not told to water');
  assert.strictEqual(p.interval, undefined, 'the action never changes its argument');
  for (let i = 0; i < 40; i++) p = C.act(p, 'notyet', N).plant;
  assert.strictEqual(C.learned(p), 7 * C.LEARN.max, 'bounded above: at most 1.8x the catalogue');
  assert.match(C.act(p, 'notyet', N).msg, /as long as Sprout will stretch it/);
  const low = C.cleanPlant({ cat: 'monstera', nick: 'L', interval: 0.1 }, { today: T });
  assert.strictEqual(C.learned(low), 7 * C.LEARN.min, 'bounded below: an import cannot say "every day"');
  const huge = C.cleanPlant({ cat: 'cactus', nick: 'L', interval: 1e9 }, { today: T });
  assert.ok(C.learned(huge) <= C.LEARN.ceil);
  assert.match(C.learnedLine(C.act(plant('monstera', 7), 'notyet', N).plant, T, 'north'), /Testy is right on the usual 7 days here|drinks every 8 days here, not 7/);
});

test('learning: "It was fine" after a late drink nudges it half a step; early or on time it is refused', () => {
  const late = C.act(plant('monstera', 10), 'water', N);
  assert.strictEqual(late.event.late, 3);
  const fine = C.act(late.plant, 'fine', N);
  assert.strictEqual(fine.plant.interval, 7.42);
  assert.match(fine.event.note, /3 extra days/);
  const ontime = C.act(plant('monstera', 7), 'water', N).plant;
  assert.throws(() => C.act(ontime, 'fine', N), /late drink/);
  // Watering on time teaches nothing; neither does a snooze.
  assert.strictEqual(ontime.interval, undefined);
  const sn = C.act(plant('monstera', 7), 'snooze', N).plant;
  assert.strictEqual(sn.interval, undefined);
  assert.strictEqual(C.bandOf(sn, T, 'north'), 'check');
  assert.strictEqual(C.bandOf(sn, C.addDays(T, 1), 'north'), 'thirsty', 'a snooze comes back as thirsty, not as a soil check');
});

test('undo: the latest change goes and what it changed comes back - interval, hold, room, light, pot; only the latest', () => {
  const p0 = C.act(plant('monstera', 7), 'notyet', N).plant;
  for (const [kind, opts] of [['water'], ['notyet'], ['snooze'], ['mist'], ['fert'], ['repot', { pot: 'l', note: 'up a size' }], ['move', { room: 'bathroom', light: 3 }], ['note', { note: 'New leaf!' }]]) {
    const r = C.act(p0, kind, N, opts);
    assert.deepStrictEqual(C.undo(r.plant, r.event.id), p0, `${kind} undone exactly`);
  }
  const a = C.act(p0, 'water', N); const b = C.act(a.plant, 'mist', N);
  assert.throws(() => C.undo(b.plant, a.event.id), /latest/);
  const fine = C.act(C.act(plant('monstera', 10), 'water', N).plant, 'fine', N);
  assert.strictEqual(C.undo(fine.plant, fine.event.id).interval, undefined);
  assert.throws(() => C.act(p0, 'note', N, { note: '   ' }), /Write something/);
  assert.throws(() => C.act(p0, 'eval', N), /Unknown/);
});

test('streaks: on-time drinks in a row (a day\'s grace), "Not yet" never breaks one, at risk when late now', () => {
  let p = plant('monstera', null, { events: [{ k: 'water', d: C.addDays(T, -60) }] });
  let day = C.addDays(T, -60);
  const lates = [0, 1, 0, 4, 0, 0, 0];
  for (const l of lates) {
    day = C.addDays(day, 7 + l);
    p = C.act(p, 'water', { today: day, hemi: 'off' }).plant;
  }
  const st = C.streakOf(p, day, 'off');
  assert.deepStrictEqual([st.current, st.best], [3, 4], 'the first drink, then on time, one a day late (still on time), then four late breaks it');
  const withCheck = C.act(p, 'notyet', { today: C.addDays(day, 7), hemi: 'off' }).plant;
  assert.strictEqual(C.streakOf(withCheck, C.addDays(day, 7), 'off').current, 3);
  assert.strictEqual(C.streakOf(p, C.addDays(day, 9), 'off').atRisk, true);
  assert.strictEqual(C.streakOf(p, C.addDays(day, 8), 'off').atRisk, false, 'a day late is still on time');
  const est = C.newPlant({ cat: 'monstera', nick: 'E', lastWatered: 'few' }, { today: T });
  assert.strictEqual(C.streakOf(est, T, 'north').current, 0, 'a rough "a few days ago" is not a drink you get credit for');
});

test('flags: watered twice in a few days, just repotted, feed due in the growing season only', () => {
  const zz = C.cleanPlant({ cat: 'zz', nick: 'Zed', added: '2025-01-01', events: [{ k: 'water', d: C.addDays(T, -4) }, { k: 'water', d: C.addDays(T, -1) }, { k: 'fert', d: C.addDays(T, -5) }] }, { today: T });
  const f = C.status(zz, T, 'north').flags.map((x) => x.k);
  assert.deepStrictEqual(f, ['overwatered']);
  const rp = C.act(plant('pothos', 2, { events: [{ k: 'water', d: C.addDays(T, -2) }, { k: 'fert', d: C.addDays(T, -40) }] }), 'repot', N).plant;
  assert.deepStrictEqual(C.status(rp, T, 'north').flags.map((x) => x.k), ['repotted'], 'no feed nag in the month after a repot');
  const hungry = plant('monstera', 2, { events: [{ k: 'water', d: C.addDays(T, -2) }, { k: 'fert', d: C.addDays(T, -40) }] });
  assert.ok(C.feedDue(hungry, T, 'north'));
  assert.ok(!C.feedDue(hungry, '2026-01-15', 'north'), 'no feed in winter');
  assert.ok(!C.feedDue(plant('flytrap', 1), T, 'north'), 'a flytrap is never fed');
});

test('light warnings: the spot against what the plant wants', () => {
  assert.strictEqual(C.lightWarning(C.catalogue('calathea'), 3).text, 'A calathea in direct sun will crisp - try a few metres back from the window, or behind a sheer curtain.');
  assert.match(C.lightWarning(C.catalogue('monstera'), 3).text, /A monstera in direct sun will scorch/);
  assert.match(C.lightWarning(C.catalogue('cactus'), 0).text, /stretch and go pale - it wants your sunniest window/);
  assert.match(C.lightWarning(C.catalogue('echeveria'), 1).text, /An echeveria in that light/);
  assert.match(C.lightWarning(C.catalogue('fiddle'), 0).text, /barely grow/);
  assert.match(C.lightWarning(C.catalogue('castiron'), 2).text, /prefers it shadier/);
  assert.match(C.lightWarning(C.catalogue('zz'), 3).text, /A ZZ plant/);
  assert.strictEqual(C.lightWarning(C.catalogue('snake'), 0), null);
  assert.strictEqual(C.lightWarning(C.catalogue('snake'), 3), null);
  assert.strictEqual(C.lightWarning(null, 3), null);
  assert.strictEqual(C.lightWarning(C.catalogue('calathea'), 7), null);
});

test('headline: who first, in words', () => {
  const a = plant('monstera', 10, { nick: 'Bert' }), b = plant('pothos', 7, { nick: 'Polly' }), c = plant('cactus', 2, { nick: 'Spike' });
  assert.strictEqual(C.headline([a, b, c], T, 'north'), '2 plants want water today - Bert the monstera first.');
  assert.strictEqual(C.headline([a, c], T, 'north'), 'Bert the monstera wants water today.');
  assert.match(C.headline([c], T, 'north'), /^Everyone’s happy\. Next drink: Spike/);
  assert.match(C.headline([plant('monstera', 6, { nick: 'Bert' })], T, 'north'), /Nothing is thirsty\. Feel Bert’s soil/);
  assert.match(C.headline([], T, 'north'), /No plants yet/);
  assert.strictEqual(C.called(plant('zz', 1, { nick: 'Zed' })), 'Zed the ZZ plant');
  assert.strictEqual(C.called(plant('zz', 1, { nick: 'ZZ plant' })), 'ZZ plant');
});

/* ---------------- the example jungle ---------------- */

test('the example: 14 plants in four rooms, every band as the story says - on every day of the year, both hemispheres', () => {
  for (const hemi of ['north', 'south']) {
    for (let i = 0; i < 366; i += 2) {
      const t = C.addDays('2026-01-01', i);
      const h = D.build(t, hemi);
      assert.strictEqual(h.plants.length, 14);
      const b = C.board(h.plants, t, hemi);
      const names = (k) => b[k].map((x) => x.plant.nick).sort().join(',');
      assert.strictEqual(names('thirsty'), 'Basil Fawlty,Bert,Figgy,Lily', `${t} ${hemi}`);
      assert.strictEqual(names('check'), 'Calvin,Fernando,Spidey', `${t} ${hemi}`);
      assert.strictEqual(names('soon'), 'Minty,Orla', `${t} ${hemi}`);
      assert.strictEqual(names('happy'), 'Pearl,Polly,Sir Hiss,Spike,Zed', `${t} ${hemi}`);
      assert.strictEqual(b.thirsty[0].plant.nick, 'Bert'); assert.strictEqual(b.thirsty[0].s.chip, '3 days late');
    }
  }
  const t = '2026-10-10';
  const h = D.build(t, 'north');
  assert.strictEqual(C.headline(h.plants, t, 'north'), '4 plants want water today - Bert the monstera first.');
  assert.deepStrictEqual([...new Set(h.plants.map((p) => p.room))].sort(), ['bathroom', 'bedroom', 'kitchen', 'living']);
  const flags = (nick) => C.status(h.plants.find((p) => p.nick === nick), t, 'north').flags.map((f) => f.k);
  assert.ok(flags('Zed').includes('overwatered'), 'one recently over-watered');
  assert.ok(flags('Polly').includes('repotted'), 'one just repotted');
  assert.ok(flags('Pearl').includes('light'), 'one in the wrong light');
  assert.ok(flags('Bert').includes('feed'), 'Bert is due a feed in autumn');
  assert.match(C.learnedLine(h.plants.find((p) => p.nick === 'Sir Hiss'), t, 'north'), /^Sir Hiss drinks every 17 days here, not 14\./);
  assert.strictEqual(C.board(h.plants, t, 'north').check[0].plant.nick, 'Calvin', 'waiting on a Not yet: feel the soil today');
  for (const p of h.plants) assert.deepStrictEqual(C.cleanPlant(p, { today: t }), p, `${p.nick} survives the cleaner unchanged`);
  // Dated relative to the viewer's today, in their own zone.
  const inst = Date.parse('2026-10-10T23:30:00Z');
  for (const z of ['America/Los_Angeles', 'Pacific/Auckland']) {
    const day = C.localDate(inst, z);
    assert.strictEqual(C.board(D.build(day, C.hemisphereOf(z)).plants, day, C.hemisphereOf(z)).thirsty.length, 4, z);
  }
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(read('public/demo.js')), 'no email address in the example');
});

/* ---------------- the one door ---------------- */

test('cleanPlant: hostile and broken plants come out safe, bounded and dated sanely', () => {
  const p = C.cleanPlant({
    id: '<x>', cat: '__proto__', custom: { name: '<img src=x onerror=alert(1)>Fern\u202eGully', emoji: '<b>', water: 999 },
    nick: '<script>alert(1)</script>' + 'N'.repeat(500), room: 'roof', light: 9, pot: 'xl', drain: 'nope', added: '2099-01-01', interval: 'x', hold: { d: 'soon' },
    events: [{ k: 'water', d: '2026-07-10' }, { k: 'water', d: '2099-01-01' }, { k: 'eval', d: '2026-07-11' }, { k: 'note', d: '2026-07-12', note: '<i>hi</i>' }, { k: 'note', d: '2026-07-12', note: '' }, null, 'x', { k: 'water', d: '2026-02-30' }],
  }, { today: T });
  assert.ok(C.isPlantId(p.id)); assert.strictEqual(p.cat, null);
  assert.ok(!/[<>\u202e]/.test(JSON.stringify(p)), JSON.stringify(p));
  assert.strictEqual(p.custom.emoji, '🪴'); assert.strictEqual(p.custom.water, 7);
  assert.ok(Array.from(p.nick).length <= C.LIMITS.nick);
  assert.deepStrictEqual([p.room, p.light, p.pot, p.drain, p.added], ['other', 1, 'm', true, T]);
  assert.ok(!('interval' in p) && !('hold' in p));
  assert.deepStrictEqual(p.events.map((e) => e.k), ['water', 'note'], 'future, unknown, empty and impossible dates dropped');
  assert.strictEqual(C.cleanPlant({ custom: { name: '   ' } }, { today: T }), null, 'a plant needs a name');
  assert.strictEqual(C.cleanPlant(null), null); assert.strictEqual(C.cleanPlant('x'), null);
  const many = C.cleanPlant({ cat: 'basil', nick: 'B', events: Array.from({ length: 5000 }, (_, i) => ({ k: 'mist', d: C.addDays(T, -i % 300) })) }, { today: T });
  assert.strictEqual(many.events.length, C.LIMITS.events, 'history is capped');
});

/* ---------------- the plant-sitter link ---------------- */

function jungle(n) {
  const cats = C.CATALOGUE.map((c) => c.id);
  return Array.from({ length: n }, (_, i) => plant(cats[i % cats.length], i % 9, { id: 'pz' + String(i).padStart(6, '0'), nick: `Plant number ${i} with a long name`, room: C.ROOM_IDS[i % 8] }));
}
test('the sitter plan: your drinks before you go, the sitter\'s day by day, and who to leave alone', () => {
  const h = D.build('2026-10-10', 'north');
  const pl = C.sitPlan(h.plants, { today: '2026-10-10', hemi: 'north', start: '2026-10-12', end: '2026-10-18', from: 'Sam <b>', note: 'Key under the mat <script>' });
  assert.deepStrictEqual([pl.start, pl.end, pl.span, pl.cut, pl.left], ['2026-10-12', '2026-10-18', 6, false, 0]);
  assert.ok(pl.before.some((b) => b.plant.nick === 'Bert' && b.dates[0] === '2026-10-10'), 'overdue plants are yours to water today');
  const sit = C.cleanSit(pl.sit);
  assert.strictEqual(sit.from, 'Sam'); assert.strictEqual(sit.note, 'Key under the mat');
  const dd = C.sitDays(sit);
  assert.strictEqual(dd.days.length, 7);
  const leave = dd.leave.map((x) => x.p.nick);
  assert.ok(leave.includes('Spike') && leave.includes('Zed'), 'the cactus and the ZZ are left alone for a week');
  assert.ok(dd.days.some((d) => d.plants.some((x) => x.p.nick === 'Basil Fawlty')), 'basil drinks while you are away');
  // Every drink is on its schedule: no plant twice in fewer days than it waits.
  for (const p of sit.plants) for (let i = 1; i < p.days.length; i++) assert.ok(p.days[i] - p.days[i - 1] >= 2, p.nick);
  const long = C.sitPlan(h.plants, { today: '2026-10-10', hemi: 'north', start: '2026-10-11', end: '2027-03-01' });
  assert.strictEqual(long.cut, true); assert.strictEqual(long.span, C.LIMITS.sitDays - 1);
  const big = C.sitPlan(jungle(140), { today: T, hemi: 'north' });
  assert.strictEqual(big.sit.p.length, C.LIMITS.sitPlants); assert.strictEqual(big.left, 80);
  const sum = C.sitSummary(sit, { '0:0': true }, '2026-10-12');
  assert.match(sum, /^🌿 Plant update/); assert.ok(!/[<>]/.test(sum));
});

test('the sitter link: packed into the fragment, compressed, and back again exactly', async () => {
  const h = D.build('2026-10-10', 'north');
  const pl = C.sitPlan(h.plants, { today: '2026-10-10', hemi: 'north', start: '2026-10-12', end: '2026-10-25', from: 'Sam', note: 'Thank you!' });
  const z = await C.encodeSit(pl.sit);
  assert.match(z, /^v1\.z\.[A-Za-z0-9_-]+$/);
  assert.deepStrictEqual(await C.decodeSit('#' + z), C.cleanSit(pl.sit));
  const plain = await C.encodeSit(pl.sit, { plain: true });
  assert.match(plain, /^v1\.p\.[A-Za-z0-9_-]+$/);
  assert.deepStrictEqual(await C.decodeSit(plain), C.cleanSit(pl.sit));
  assert.ok(z.length < plain.length * 0.6, `compression pays: ${z.length} vs ${plain.length}`);
  // A browser without CompressionStream falls back to plain base64url.
  const saved = global.CompressionStream; delete global.CompressionStream;
  try { assert.match(await C.encodeSit(pl.sit), /^v1\.p\./); assert.deepStrictEqual(await C.decodeSit(plain), C.cleanSit(pl.sit)); assert.strictEqual(await C.decodeSit(z), null, 'and says no to a link it cannot inflate, rather than guessing'); } finally { global.CompressionStream = saved; }
  // The biggest link a plan can make - 60 plants with long names, 42 days - fits.
  const most = C.sitPlan(jungle(200), { today: T, hemi: 'north', start: C.addDays(T, 1), end: C.addDays(T, 60), note: 'x'.repeat(500) });
  const frag = await C.encodeSit(most.sit);
  assert.ok(frag.length <= C.LIMITS.fragment, `${frag.length} characters`);
  assert.strictEqual((await C.decodeSit(frag)).plants.length, 60);
});

test('the sitter link: hostile or garbled fragments are refused safely - never thrown, never markup', async () => {
  const bad = ['', '#', '#v2.z.abc', '#v1.x.abc', '#v1.z.', '#v1.z.!!!!', '#v1.p.%3Cscript%3E', '#v1.z.AAAA', 'v1.p.' + 'A'.repeat(C.LIMITS.fragment), null, undefined, 42, {}, '#v1.p.' + Buffer.from('{"v":1').toString('base64url'), '#v1.p.' + Buffer.from('[1,2,3]').toString('base64url'), '#v1.p.' + Buffer.from('\xff\xfe').toString('base64url')];
  for (const b of bad) assert.strictEqual(await C.decodeSit(b), null, String(b).slice(0, 40));
  // A deflate bomb: 5 MB of zeros in a few KB is refused after LIMITS.inflated bytes.
  const bomb = zlib.deflateSync(Buffer.alloc(5 * 1024 * 1024, 0x20));
  assert.ok(bomb.length < C.LIMITS.fragment);
  assert.strictEqual(await C.decodeSit('v1.z.' + bomb.toString('base64url')), null);
  // Truncated in transit (a chat app cutting a long link).
  const h = D.build('2026-10-10', 'north');
  const good = await C.encodeSit(C.sitPlan(h.plants, { today: '2026-10-10', hemi: 'north' }).sit);
  assert.strictEqual(await C.decodeSit(good.slice(0, Math.floor(good.length / 2))), null);
  // Well-formed but hostile: every field goes through the cleaner.
  const evil = { v: 1, s: '2026-10-12', e: '2026-10-14', f: '<img src=x onerror=alert(1)>Mallory', t: '<script>alert(1)</script>Water <b>everything</b>\u202e daily',
    p: [['<svg onload=alert(1)>Bert', 'triffid', 'roof', 'xxl', 'yes', [0, 1, 2, 99, -1, 1.5, '2', 1], 7, '<a href="javascript:x">note</a>'], ['', 'monstera'], 'not a row', null, ['Ok', '__proto__', 'living', 's', 0, 'nope', 1, 'x'.repeat(500)]], __proto__: { polluted: true } };
  const z = await C.encodeSit(evil);
  const s = await C.decodeSit(z);
  assert.ok(s && !/[<>\u202e]/.test(JSON.stringify(s)), JSON.stringify(s));
  assert.strictEqual(s.plants.length, 2);
  assert.deepStrictEqual(s.plants[0], { nick: 'Bert', cat: null, room: 'other', pot: 'm', drain: true, days: [0, 1, 2], mist: false, note: 'note' });
  assert.strictEqual(s.plants[1].cat, null); assert.ok(Array.from(s.plants[1].note).length <= C.LIMITS.sitNote);
  assert.strictEqual(({}).polluted, undefined, 'no prototype pollution');
  for (const raw of [{ v: 1, s: '2026-10-14', e: '2026-10-12', p: [['A']] }, { v: 1, s: '2026-10-01', e: '2026-12-30', p: [['A']] }, { v: 1, s: '2026-10-01', e: '2026-10-02', p: [] }, { v: 1, s: '2026-02-30', e: '2026-03-02', p: [['A']] }]) assert.strictEqual(C.cleanSit(raw), null, JSON.stringify(raw));
  const huge = { v: 1, s: '2026-10-01', e: '2026-10-02', p: Array.from({ length: 1000 }, (_, i) => [`P${i}`, 'pothos', 'living', 'm', 1, [0], 0, '']) };
  assert.strictEqual(C.cleanSit(huge).plants.length, C.LIMITS.sitPlants);
});

/* ---------------- the calendar ---------------- */

test('.ics: valid iCalendar - CRLF, folded at 75 octets on whole characters, escaped, one all-day event per watering day', () => {
  const h = D.build('2026-10-10', 'north');
  h.plants[0].nick = 'Bert, the; boss\\ <3';
  const { text, days } = C.icsFor(h.plants, { today: '2026-10-10', hemi: 'north', now: Date.parse('2026-10-10T08:00:00Z') });
  assert.ok(days > 10);
  assert.ok(text.endsWith('\r\n') && !/[^\r]\n/.test(text), 'every line ends CRLF');
  const lines = text.split('\r\n').slice(0, -1);
  assert.strictEqual(lines[0], 'BEGIN:VCALENDAR'); assert.strictEqual(lines[lines.length - 1], 'END:VCALENDAR');
  assert.ok(lines.includes('VERSION:2.0') && lines.some((l) => l.startsWith('PRODID:')));
  for (const l of lines) assert.ok(Buffer.byteLength(l, 'utf8') <= 75, `${Buffer.byteLength(l)}: ${l}`);
  for (const l of lines) assert.ok(!Buffer.from(l, 'utf8').toString('utf8').includes('\ufffd'), 'no character split by folding');
  const unfolded = text.replace(/\r\n /g, '');
  const events = unfolded.split('BEGIN:VEVENT').slice(1);
  assert.strictEqual(events.length, days);
  assert.strictEqual((unfolded.match(/END:VEVENT/g) || []).length, days);
  const starts = [...unfolded.matchAll(/DTSTART;VALUE=DATE:(\d{8})/g)].map((m) => m[1]);
  assert.strictEqual(new Set(starts).size, days, 'one event a day');
  assert.ok(starts.every((d) => d >= '20261010' && d <= '20261106'), 'within four weeks');
  assert.ok(unfolded.includes('DTSTAMP:20261010T080000Z'));
  assert.ok(/Bert\\, the\\; boss\\\\ <3/.test(unfolded), 'commas, semicolons and backslashes escaped');
  const uids = [...unfolded.matchAll(/UID:([^\r\n]+)/g)].map((m) => m[1]);
  assert.strictEqual(new Set(uids).size, uids.length, 'unique UIDs');
  assert.ok(/DTSTART;VALUE=DATE:20261010[\s\S]*?SUMMARY:💧 Water [^\r\n]*Bert/.test(unfolded), 'overdue plants are on today');
  assert.strictEqual(C.icsFor([], { today: T, hemi: 'north' }).days, 0);
});

/* ---------------- export / import ---------------- */

test('export and import: a round trip keeps every plant; a hostile file is cleaned or refused', () => {
  const h = D.build('2026-10-10', 'north');
  const text = C.exportHome(h, Date.parse('2026-10-10T08:00:00Z'));
  const back = C.importHome(text, { today: '2026-10-10', tz: 'Europe/London' });
  assert.deepStrictEqual(back.plants, h.plants);
  assert.strictEqual(back.dropped, 0);
  assert.strictEqual(back.settings.name, 'Sam');
  for (const [t, re] of [['not json', /isn’t JSON/], ['{"app":"other","v":1,"plants":[]}', /isn’t a Sprout export/], ['[]', /isn’t a Sprout export/], ['null', /isn’t a Sprout export/], ['x'.repeat(C.LIMITS.importBytes + 1), /too big/], [null, /too big/]]) {
    assert.throws(() => C.importHome(t, { today: T, tz: 'UTC' }), re);
  }
  const hostile = JSON.stringify({ app: 'sprout', v: 1, settings: { hemi: 'mars', hemiAuto: false, name: '<b>Eve</b>' }, plants: [
    ...h.plants.slice(0, 2), h.plants[0], { custom: { name: '' } }, { cat: 'monstera', nick: '<script>x</script>', events: [{ k: 'water', d: '2026-10-01', note: '<img>' }] },
    ...Array.from({ length: 400 }, () => ({ cat: 'basil' })),
  ], __proto__: { polluted: 1 } });
  const got = C.importHome(hostile, { today: '2026-10-10', tz: 'Australia/Sydney' });
  assert.strictEqual(got.plants.length, C.LIMITS.plants);
  assert.strictEqual(new Set(got.plants.map((p) => p.id)).size, got.plants.length, 'duplicate ids made unique');
  assert.ok(!/[<>]/.test(JSON.stringify(got)));
  assert.deepStrictEqual(got.settings, { hemi: 'south', hemiAuto: false, name: 'Eve' }, 'an unknown hemisphere falls back to the time zone\'s guess');
  assert.strictEqual(({}).polluted, undefined);
});

/* ---------------- the AI answer ---------------- */

test('cleanLook: catalogue ids only if real, bounded strings, no markup, and every pet claim dropped', () => {
  const r = C.cleanLook({ relevant: true, identification: { catalogueId: 'triffid', name: '<b>Monstera</b>. Safe for cats.', confidence: 'certain' }, health: { issues: Array.from({ length: 9 }, () => ({ issue: 'Yellow leaves. Toxic to dogs.', likely_cause: 'Too wet. Cats chew it.', fix: '<a>Wait</a>.' })), urgency: 'yesterday' }, note: 'Lovely plant. Non-toxic to pets! Turn it weekly.' });
  assert.deepStrictEqual(r.identification, { catalogueId: null, name: 'Monstera .', confidence: 'low' });
  assert.strictEqual(r.health.urgency, 'fine');
  assert.strictEqual(r.health.issues.length, 5);
  assert.deepStrictEqual(r.health.issues[0], { issue: 'Yellow leaves.', likely_cause: 'Too wet.', fix: 'Wait .' });
  assert.strictEqual(r.note, 'Lovely plant. Turn it weekly.');
  assert.ok(!/\b(cats?|dogs?|pets?|toxic)\b|[<>]/i.test(JSON.stringify(r)));
  const ok = C.cleanLook({ identification: { catalogueId: 'peacelily', name: '', confidence: 'medium' }, health: { issues: [], urgency: 'soon' } });
  assert.deepStrictEqual(ok.identification, { catalogueId: 'peacelily', name: 'Peace lily', confidence: 'medium' });
  assert.strictEqual(C.cleanLook(null).relevant, true);
  assert.strictEqual(C.cleanLook({ relevant: false }).relevant, false);
});

/* ---------------- the page ---------------- */

function luminance(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((s, c, i) => s + c * [0.2126, 0.7152, 0.0722][i], 0);
}
const ratio = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
test('every text colour holds 4.5:1 on its surface in both themes; band bars 3:1', () => {
  const css = read('public/app.css');
  const block = (re) => { const m = re.exec(css); assert.ok(m, String(re)); const out = {}; for (const [, k, v] of m[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)) out[k] = v; return out; };
  const light = block(/^:root \{([\s\S]*?)\n\}/m);
  const dark = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/);
  const forced = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/);
  assert.deepStrictEqual(forced, dark, 'the forced dark theme matches the automatic one');
  for (const [name, t] of [['light', light], ['dark', dark]]) {
    for (const bg of ['bg', 'card', 'card2', 'bar-bg']) for (const fg of ['text', 'muted', 'link', 'err', 'good', 'bad']) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    const pairs = [['text', 'accent-soft'], ['link', 'accent-soft'], ['muted', 'accent-soft'], ['accent-ink', 'accent'], ['good', 'good-bg'], ['bad', 'bad-bg'], ['warn', 'warn-bg'], ['strip-ink', 'strip'], ['strip-btn-ink', 'strip-btn'], ['bg', 'text'], ['card', 'thirsty']];
    for (const b of ['thirsty', 'check', 'soon', 'happy']) pairs.push([b, `${b}-bg`], [b, 'card']);
    for (const [fg, bg] of pairs) assert.ok(ratio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}: ${ratio(t[fg], t[bg]).toFixed(2)}`);
    for (const b of ['thirsty', 'check', 'soon', 'happy']) assert.ok(ratio(t[`${b}-bar`], t.card) >= 3, `${name} ${b} bar: ${ratio(t[`${b}-bar`], t.card).toFixed(2)}`);
    assert.ok(ratio(t.accent, t.card) >= 3, `${name} accent mark`);
  }
  for (const [fg, bg] of [['#ffffff', '#0d4f86'], ['#ffffff', '#2c5a2f']]) assert.ok(ratio(fg, bg) >= 4.5, `${fg} on ${bg}`);
  assert.ok(/min-height: 44px/.test(css) && /\.pa \{[^}]*min-height: 44px; min-width: 44px/.test(css), '44px tap targets');
  assert.ok(/@media print/.test(css), 'a printable sitter sheet');
});

test('the pages: relative links, no inline script or handlers, the banner, storage wrapped, only known requests', () => {
  const html = read('public/index.html'), sitHtml = read('public/sit.html');
  for (const [n, h] of [['index', html], ['sit', sitHtml]]) {
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(h), `${n}: no inline <script>`);
    assert.ok(!/\son[a-z]+\s*=/i.test(h), `${n}: no inline handlers`);
    assert.ok(!/(src|href)="\//.test(h), `${n}: relative asset links only`);
  }
  assert.ok(html.includes('<script src="verify-banner.js" data-mount="api/auth" defer></script>'));
  assert.ok(html.includes('<link rel="stylesheet" href="desktop.css">') && html.includes('<script src="passkey-client.js"></script>') && html.includes('<body class="dk">'));
  const js = read('public/app.js'), sit = read('public/sit.js'), core = read('public/sprout-core.js');
  for (const [n, s] of [['app.js', js], ['sit.js', sit]]) {
    assert.ok(!/\son[a-z]+=\\?["']/.test(s), `${n}: no handler written into markup`);
    assert.ok(!/\.on[a-z]+ =/.test(s), `${n}: handlers by addEventListener`);
    assert.ok(!/fetch\(['"]\//.test(s) && !/href="\//.test(s), `${n}: every URL relative to BASE`);
    assert.ok(!/innerHTML = [^;]*\+ (?!esc\(|plural|C\.|'|")[a-z]+\.(nick|note|name)/i.test(s), `${n}: names go through esc()`);
  }
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(js) && /localStorage\.setItem[^\n]*\} catch/.test(js), 'app.js: every storage access is wrapped');
  assert.strictEqual((js.match(/localStorage\./g) || []).length, 3, 'and there are no others');
  assert.ok(/localStorage\.getItem[^\n]*\} catch/.test(sit) && /localStorage\.setItem[^\n]*\} catch/.test(sit));
  assert.strictEqual((sit.match(/localStorage\./g) || []).length, 2);
  assert.ok(/indexedDB\.open[\s\S]{0,900}catch \(e\)/.test(js), 'IndexedDB opened inside try/catch');
  const calls = [...js.matchAll(/api\('(GET|POST)', '([^']+)'/g)].map((m) => m[2]);
  assert.deepStrictEqual([...new Set(calls)].sort(), ['api/auth/', 'api/auth/billing', 'api/auth/logout', 'api/look', 'api/me'], 'the page asks for nothing else - no route takes a plant');
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|sendBeacon/.test(sit + core + read('public/demo.js')), 'the sitter page, the rules and the example make no request at all');
  assert.ok(js.includes("register('sw.js', { scope: './' })"));
  assert.ok(js.includes("BASE + 'sit#' + frag"), 'the plan goes in the fragment');
  assert.ok(!/[a-z0-9._-]+@[a-z0-9-]+\.[a-z]{2,}/i.test(html + js + sit + core), 'no email address in the pages');
  const server = read('server.js');
  assert.ok(!/setInterval|setTimeout/.test(server), 'nothing runs after a response (billed per request)');
  for (const f of ['server.js', 'lib/ai.js', 'lib/photo.js']) assert.ok(!/console\.(log|error|warn)\([^)]*(req\.body|photo|\.data\b|raw)/.test(read(f)), `${f} logs a body or a photo`);
});

test('the service worker: the app\'s own files under its own scope, never api/, only sprout-* caches', () => {
  const sw = read('public/sw.js');
  assert.ok(/rel\.indexOf\('api\/'\) === 0\) return/.test(sw));
  assert.ok(/url\.origin !== self\.location\.origin\) return/.test(sw));
  assert.ok(/url\.pathname\.indexOf\(scope\) !== 0\) return/.test(sw));
  assert.ok(/k\.indexOf\('sprout-'\) === 0 && k !== CACHE/.test(sw));
  const shell = JSON.parse(/var SHELL = (\[[^\]]*\])/.exec(sw)[1].replace(/'/g, '"'));
  for (const f of shell.filter((x) => x !== './' && x !== 'sit')) assert.ok(fs.existsSync(path.join(ROOT, 'public', f)), `${f} is cached but missing`);
  for (const page of ['public/index.html', 'public/sit.html']) for (const [, f] of read(page).matchAll(/(?:src|href)="([^"#:]+)"/g)) if (f !== './') assert.ok(shell.includes(f), `${f} is loaded but not cached for offline`);
});

test('local-only switches throw on Cloud Run', () => {
  for (const [mod, env] of [['./lib/store', { SPROUT_MEMORY: '1' }], ['./lib/fakeai', { SPROUT_FAKE_AI: '1' }], ['./server', { SPROUT_FAKE_AI: '1', SPROUT_MEMORY: '' }]]) {
    const r = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: ROOT, env: { ...process.env, SPROUT_MEMORY: '', SPROUT_FAKE_AI: '', ...env, K_SERVICE: 'challenge' }, encoding: 'utf8' });
    assert.notStrictEqual(r.status, 0, `${mod} loaded on Cloud Run`);
    assert.ok(/refused on Cloud Run/.test(r.stderr), r.stderr.slice(0, 300));
  }
  assert.ok(/SPROUT_COLLECTION_PREFIX/.test(read('lib/store.js')), 'the prefix is read, ready for anything ever stored');
});

/* ---------------- over HTTP ---------------- */

let base;
const seen = [];
let ip6 = 1;
function client() {
  const cookies = {};
  const addr = `2001:db8:${(ip6++).toString(16)}::1`;
  return async function call(method, p, body, headers = {}) {
    const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': addr, ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      cookies[kv.slice(0, i)] = kv.slice(i + 1);
    }
    const text = await res.text();
    let data = {};
    try { data = JSON.parse(text); } catch (e) { data = { text }; }
    return { status: res.status, data, text, headers: res.headers };
  };
}
async function register(email) {
  const c = client();
  const r = await c('POST', '/api/auth/register', { email, password: 'a long enough password' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.data));
  return c;
}
const uidOf = (email) => Buffer.from(email).toString('base64url');
const modelCalls = async () => (await identityStore.list('usage')).length;
const settle = () => new Promise((r) => setTimeout(r, 15));
const jpeg = (marker) => ({ type: 'image/jpeg', data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.from(`JFIF PHOTO_MARKER_BYTES ${marker || ''}`)]).toString('base64') });
const BIG = { photo: { type: 'image/jpeg', data: 'A'.repeat(7 * 1024 * 1024) } };

test('signed out: every page loads, zero model calls; the AI route answers 401 before reading any body', async () => {
  const anon = client();
  const before = await modelCalls();
  assert.strictEqual((await anon('GET', '/healthz')).data.stores, 'nothing');
  assert.strictEqual((await anon('GET', '/api/meta')).data.catalogue, C.CATALOGUE.length);
  for (const f of ['', 'sit', 'sprout-core.js', 'demo.js', 'app.js', 'sit.js', 'app.css', 'sw.js', 'verify-banner.js', 'passkey-client.js', 'desktop.css', 'icon.svg', 'manifest.webmanifest']) assert.strictEqual((await fetch(`${base}/${f}`)).status, 200, f);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  const sit = await fetch(`${base}/sit`);
  assert.strictEqual(sit.headers.get('referrer-policy'), 'no-referrer');
  assert.match(await sit.text(), /<script src="sit\.js"><\/script>/);
  assert.strictEqual((await fetch(`${base}/sw.js`)).headers.get('cache-control'), 'no-cache');
  assert.strictEqual((await anon('GET', '/api/me')).data.signedIn, false);
  assert.strictEqual((await anon('POST', '/api/look', { photo: jpeg() })).status, 401);
  assert.strictEqual((await anon('POST', '/api/look', BIG)).status, 401, 'the gate answers before the parser, so not 413');
  for (const p of ['/api/plants', '/api/sit', '/api/sync', '/api/photos']) assert.strictEqual((await anon('POST', p, { plants: [] })).status, 404, `${p}: there is no route for plants`);
  assert.strictEqual((await anon('POST', '/api/auth/login', { email: 'x'.repeat(20 * 1024) })).status, 413, 'every other route keeps a small limit');
  await settle();
  assert.strictEqual(await modelCalls(), before, 'no model call for a signed-out visitor');
});

test('the sitter link\'s fragment never reaches the server: it sees "/sit" and nothing after the #', async () => {
  const h = D.build('2026-10-10', 'north');
  const frag = await C.encodeSit(C.sitPlan(h.plants, { today: '2026-10-10', hemi: 'north', from: 'FRAGMENT_MARKER_SAM' }).sit);
  const mark = seen.length;
  const r = await fetch(`${base}/sit#${frag}`);
  assert.strictEqual(r.status, 200);
  const got = seen.slice(mark);
  assert.deepStrictEqual(got.map((x) => x.url), ['/sprout/sit']);
  const all = JSON.stringify(got);
  assert.ok(!all.includes(frag.slice(5, 30)) && !all.includes('v1.z') && !all.includes('#'), 'no part of the plan in the request line, headers or body');
  assert.ok(!JSON.stringify(identityStore._dump()).includes('FRAGMENT_MARKER'));
});

test('the metered route: requireUser, requireBudget, requireDailyCap, THEN its parser; one model call in the server', () => {
  const layer = app._router.stack.find((l) => l.route && l.route.path === '/api/look' && l.route.methods.post);
  assert.deepStrictEqual(layer.route.stack.map((l) => l.handle.name || '(anon)').slice(0, 4), ['requireUser', 'requireBudget', 'requireDailyCap', 'jsonParser']);
  const src = read('server.js');
  assert.strictEqual((src.match(/await clientFor\(req\)/g) || []).length, 1, 'one metered call, nowhere else');
  assert.match(src, /MODELS = \{ free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' \}/);
  assert.match(src, /identityLib\.planFor\(req\.user, MODELS\)/);
  const sys = require('../lib/ai').SYSTEM;
  assert.match(sys, /Do not claim certainty you do not have/);
  assert.match(sys, /Do not say anything about whether the plant is safe or toxic for pets/);
});

test('look: input checked by its bytes before any spend, one metered call, a forced tool, the answer cleaned', async () => {
  const ana = await register('ana.plants@example.com');
  const calls = await modelCalls();
  assert.strictEqual((await ana('POST', '/api/look', {})).status, 400);
  assert.strictEqual((await ana('POST', '/api/look', { photo: { type: 'image/jpeg', data: Buffer.from('%PDF-1.4 not a photo').toString('base64') } })).status, 400, 'a PDF called a JPEG');
  assert.strictEqual((await ana('POST', '/api/look', { photo: { type: 'image/jpeg', data: 'not base64 !!' } })).status, 400);
  assert.strictEqual((await ana('POST', '/api/look', { photo: { type: 'image/jpeg', data: 'A'.repeat(5 * 1024 * 1024) } })).status, 400, 'over 4 MB decoded');
  assert.strictEqual((await ana('POST', '/api/look', BIG)).status, 413, 'over the 6 MB parser, signed in');
  await settle();
  assert.strictEqual(await modelCalls(), calls, 'no model call for a bad photo');
  const n0 = fakeCalls.length;
  const r = await ana('POST', '/api/look', { photo: jpeg(), hint: 'monstera' });
  assert.strictEqual(r.status, 200, r.text);
  assert.deepStrictEqual(r.data.result.identification, { catalogueId: 'monstera', name: 'Monstera', confidence: 'high' });
  await settle();
  assert.strictEqual(await modelCalls(), calls + 1, 'one call, metered');
  const req = fakeCalls[fakeCalls.length - 1];
  assert.strictEqual(fakeCalls.length, n0 + 1);
  assert.strictEqual(req.model, 'claude-haiku-4-5', 'a free account runs Haiku');
  assert.deepStrictEqual(req.tool_choice, { type: 'tool', name: 'record_plant' });
  assert.match(JSON.stringify(req.messages), /The owner has it down as a Monstera/);
  await ana('POST', '/api/look', { photo: jpeg(), hint: '<script>' });
  assert.ok(!JSON.stringify(fakeCalls[fakeCalls.length - 1].messages).includes('script'), 'an unknown hint is not passed on');
  const sick = await ana('POST', '/api/look', { photo: jpeg('SICK') });
  assert.deepStrictEqual([sick.data.result.identification.catalogueId, sick.data.result.health.urgency, sick.data.result.health.issues.length], ['peacelily', 'soon', 3]);
  const inj = await ana('POST', '/api/look', { photo: jpeg('INJECT') });
  assert.strictEqual(inj.status, 200, inj.text);
  assert.ok(!/<[a-z/!]/i.test(inj.text) && !/\u202e/.test(inj.text), 'no markup or bidi reaches the page');
  assert.ok(!/\b(cats?|dogs?|pupp\w*|pets?|toxic|non-toxic)\b/i.test(inj.text), 'pet claims from the model are dropped - the catalogue answers that');
  assert.deepStrictEqual([inj.data.result.identification.catalogueId, inj.data.result.identification.confidence, inj.data.result.health.urgency], [null, 'low', 'fine'], 'a made-up id, confidence and urgency are refused');
  assert.ok(inj.data.result.health.issues.length <= 5 && inj.data.result.identification.name.length <= 60);
  const blank = await ana('POST', '/api/look', { photo: jpeg('BLANK') });
  assert.deepStrictEqual([blank.status, /doesn’t look like a plant/.test(blank.data.error)], [422, true]);
  assert.match((await ana('POST', '/api/look', { photo: jpeg('MAXTOKENS') })).data.error, /ran long/);
  const up = await ana('POST', '/api/look', { photo: jpeg('UPSTREAM401') });
  assert.ok(up.status === 502 && up.data.error && !/fake_upstream|stand-in|401/.test(up.text), 'a provider error is not passed on');
  const busy = await ana('POST', '/api/look', { photo: jpeg('UPSTREAM529') });
  assert.deepStrictEqual([busy.status, /AI is busy/.test(busy.data.error)], [503, true]);
});

test('an unconfirmed free account gets the verify-email 403 before any model call or big body; out of credit is a 402, not a 413', async () => {
  const eve = await register('eve.unconfirmed@example.com');
  process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '1';
  try {
    const calls = await modelCalls();
    const r = await eve('POST', '/api/look', { photo: jpeg() });
    assert.deepStrictEqual([r.status, r.data.code], [403, 'verify-email']);
    assert.strictEqual(r.data.resend, '/sprout/api/auth/verify/send', 'the resend link is under this app\'s mount');
    assert.strictEqual((await eve('POST', '/api/look', BIG)).status, 403, '403 before the big body is read');
    await settle();
    assert.strictEqual(await modelCalls(), calls);
  } finally { process.env.REQUIRE_VERIFIED_FOR_FREE_AI = '0'; }
  const cal = await register('cal.broke@example.com');
  await identityStore.merge('users', uidOf('cal.broke@example.com'), { spentUsd: 100 });
  const calls = await modelCalls();
  assert.strictEqual((await cal('POST', '/api/look', { photo: jpeg() })).status, 402);
  assert.strictEqual((await cal('POST', '/api/look', BIG)).status, 402, '402, not 413');
  await settle();
  assert.strictEqual(await modelCalls(), calls);
});

test('nothing is stored server-side: no plant, no photo, no answer - only the shared account and its usage rows', async () => {
  const dump = identityStore._dump();
  for (const m of ['PHOTO_MARKER', 'record_plant', 'Monstera', 'Peace lily', 'peacelily', 'FRAGMENT_MARKER', Buffer.from('JFIF PHOTO_MARKER').toString('base64').slice(0, 16)]) assert.ok(!dump.includes(m), `${m} was stored`);
  const cols = JSON.parse(dump).map(([p]) => p).sort();
  assert.ok(cols.every((c) => ['users', 'usage', 'events', 'control'].some((k) => c.toLowerCase().includes(k))), `only account collections: ${cols.join(', ')}`);
  const src = read('server.js');
  assert.ok(!/store\.(set|merge|add|transact)\(/.test(src), 'the server has no app store to write to');
  assert.ok(!/fs\.(write|append)/.test(src + read('lib/photo.js') + read('lib/ai.js')), 'and writes no files');
  assert.ok(fakeCalls.every((c) => c.messages[0].content.every((b) => b.type !== 'image' || /^<\d+ chars>$/.test(b.source.data))), 'even the test double keeps only a photo\'s length');
});

/* ---------------- run ---------------- */

(async () => {
  const hostApp = express();
  hostApp.set('trust proxy', 1);
  // Everything the server is ever told, recorded, to prove what it never sees.
  hostApp.use((req, _res, next) => { seen.push({ url: req.originalUrl, headers: req.headers }); next(); });
  hostApp.use('/sprout', app);
  const server = http.createServer(hostApp).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/sprout`;
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (err) { failed++; console.log(`  FAIL ${t.name}\n       ${err.stack.split('\n').slice(0, 8).join('\n       ')}`); }
  }
  server.close();
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
