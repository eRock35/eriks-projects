// Still backfill for projects saved before stills existed (2026-09-27).
// Pure: public/backfill.js is loaded as CommonJS; no server, no browser.
const path = require('path');
const B = require(path.join(__dirname, '..', 'public', 'backfill.js'));

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (x ? '  <- ' + x : '')); } };
const proj = (id, hasStill = false) => ({ id, hasStill, title: 'T ' + id });

(async () => {
  console.log('pick');
  const list = [proj('a', true), proj('b'), proj('c'), proj('d', true), proj('e')];
  ok('only projects without a still', JSON.stringify(B.pick(list, {})) === '["b","c","e"]', JSON.stringify(B.pick(list, {})));
  ok('keeps the list order (newest first)', B.pick([proj('z'), proj('y')], {})[0] === 'z');
  const many = Array.from({ length: 20 }, (_, i) => proj('p' + i));
  ok('capped at 6 by default', B.pick(many, {}).length === 6 && B.MAX_PER_VISIT === 6);
  ok('a cap can be passed', B.pick(many, {}, 2).length === 2);
  ok('the cap counts picks, not rows skipped', B.pick([proj('a', true), proj('b', true), proj('c'), proj('d')], {}, 2).join() === 'c,d');
  ok("already tried this session is skipped", B.pick(list, { b: true }).join() === 'c,e');
  ok('a duplicate id is picked once', B.pick([proj('x'), proj('x')], {}).length === 1);
  ok('rows with no id, a non-string id or null are ignored',
     B.pick([null, {}, { id: 7 }, { id: '' }, proj('ok')], {}).join() === 'ok');
  ok('"constructor" is not read as tried off the prototype', B.pick([proj('constructor'), proj('__proto__')], {}).length === 2);
  ok('a truthy non-true hasStill still counts as missing', B.pick([{ id: 'q', hasStill: 'yes' }], {}).join() === 'q');
  ok('no list is nothing to do', B.pick(undefined, {}).length === 0 && B.pick(null).length === 0);

  console.log('allowed');
  const base = { hidden: false, saveData: false, reducedData: false, framed: false, tour: false };
  ok('a visible, ordinary tab may', B.allowed(base) === true);
  ok('not while hidden', B.allowed({ ...base, hidden: true }) === false);
  ok('not on Save-Data', B.allowed({ ...base, saveData: true }) === false);
  ok('not with prefers-reduced-data', B.allowed({ ...base, reducedData: true }) === false);
  ok('not in a framed preview', B.allowed({ ...base, framed: true }) === false);
  ok('not in the ?tour=1 demo', B.allowed({ ...base, tour: true }) === false);
  ok('not with no environment', B.allowed(null) === false);

  console.log('run');
  function deps(projects, opts = {}) {
    const d = {
      calls: [], inFlight: 0, maxInFlight: 0, idles: 0, isHidden: false,
      tried: opts.tried || {},
      list: async () => { if (opts.listFails) throw new Error('offline'); return projects; },
      load: async (id) => { if (opts.loadFails === id) throw new Error('gone'); return { id, viz: opts.noViz === id ? null : { type: 'bars' }, title: id }; },
      upload: async (p) => {
        d.inFlight++; d.maxInFlight = Math.max(d.maxInFlight, d.inFlight);
        d.calls.push(p.id);
        await new Promise((r) => setTimeout(r, 5));
        d.inFlight--;
        if (opts.hideAfter && d.calls.length >= opts.hideAfter) d.isHidden = true;
        return opts.uploadFails !== p.id;
      },
      idle: async () => { d.idles++; },
      hidden: () => d.isHidden,
    };
    if (opts.cap != null) d.cap = opts.cap;
    return d;
  }

  let d = deps(many);
  let r = await B.run(d);
  ok('uploads at most 6 in one visit', d.calls.length === 6 && r.done === 6, JSON.stringify(r));
  ok('one at a time, never two at once', d.maxInFlight === 1);
  ok('waits for idle before each one', d.idles >= 6, String(d.idles));
  ok('marks each as tried', Object.keys(d.tried).length === 6);

  d = deps([proj('a', true), proj('b'), proj('c')]);
  r = await B.run(d);
  ok('skips projects that already have a still', d.calls.join() === 'b,c' && r.done === 2);

  d = deps(many, { hideAfter: 2 });
  r = await B.run(d);
  ok('stops when the tab goes to the background', d.calls.length === 2 && r.stopped === true, JSON.stringify(r));

  d = deps(many); d.isHidden = true;
  r = await B.run(d);
  ok('does nothing if hidden before it starts', d.calls.length === 0 && r.stopped === true);

  d = deps([proj('a'), proj('b'), proj('c')], { loadFails: 'a', uploadFails: 'b', noViz: 'c' });
  r = await B.run(d);
  ok('a failure does not stop the rest', r.failed === 3 && r.done === 0 && d.tried.a && d.tried.b && d.tried.c, JSON.stringify(r));
  ok('a project with no viz is not uploaded', !d.calls.includes('c'));

  d = deps([proj('a')], { listFails: true });
  r = await B.run(d);
  ok('a list that fails is a quiet no-op', r.done === 0 && r.failed === 0 && d.calls.length === 0);

  d = deps([proj('a'), proj('b')], { tried: { a: true } });
  r = await B.run(d);
  ok('what this session already tried is not retried', d.calls.join() === 'b');

  d = deps(many, { cap: 3 });
  r = await B.run(d);
  ok('honours a smaller cap', d.calls.length === 3);

  console.log('\n' + pass + '/' + (pass + fail) + ' assertions passed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
