// Run with: node test/views.js
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const vm = require('vm');

// The in-memory Firestore, installed before lib/views.js is required so the
// route tests below write to it rather than to a real database.
const h = require('./harness.js');
h.install();

const express = require('express');
const { APPS, trendScore, beaconVerdict, createViews } = require('../lib/views');

let ran = 0;
async function test(name, fn) { await fn(); ran += 1; process.stdout.write('  ok  ' + name + '\n'); }

const LANDING = 'www.strongtechnicalconsulting.com';

/**
 * Run the shared beacon as a browser would, with only the pieces it touches.
 * Returns the bodies it posted (parsed), so a test can say "sent nothing" or
 * "sent exactly this".
 */
function runBeacon(opts) {
  const o = opts || {};
  const sent = [];
  const win = {};
  win.self = win;
  if (o.topThrows) {
    Object.defineProperty(win, 'top', { get() { throw new Error('SecurityError: Blocked a frame'); } });
  } else {
    win.top = o.framed ? { parent: 'someone else' } : win;
  }
  const attrs = { 'data-app': o.app === undefined ? 'football' : o.app, 'data-to': 'https://counter.test' };
  const sandbox = {
    window: win,
    document: {
      currentScript: { getAttribute: (k) => (k in attrs ? attrs[k] : null) },
      referrer: o.referrer || '',
    },
    location: { search: o.search || '', pathname: o.pathname || '/' },
    URL,
    JSON,
    fetch: o.fetchThrows
      ? () => { throw new Error('fetch is not available'); }
      : (url, init) => { sent.push({ url, body: JSON.parse(init.body), init }); return Promise.resolve({}); },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'shared', 'beacon.js'), 'utf8'), sandbox);
  return sent;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function request(port, method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {}),
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

(async () => {
  await test('the vacation app is NOT in the tracked allowlist', () => {
    // This is a standing decision, not an oversight: santa-rosa-beach-trip is
    // private, holds family PII, and both its CLAUDE.md and DEPLOY.md say its
    // hostname stays off public surfaces. /api/stats/public is a public surface
    // and this file is in a public repo. If someone "helpfully" adds it, this
    // test is the thing that says no.
    const names = Object.keys(APPS).join(' ');
    assert.ok(!/santa|rosa|vacation|beach/i.test(names), 'vacation app must not be tracked');
    assert.ok(!/santa|rosa|vacation|beach/i.test(JSON.stringify(APPS)), 'and must not appear in any label or URL');
  });

  await test('every tracked app has a label, an https URL and an icon', () => {
    Object.keys(APPS).forEach((k) => {
      assert.ok(APPS[k].label, k + ' needs a label');
      assert.ok(/^https:\/\//.test(APPS[k].url), k + ' needs an https url');
      assert.ok(APPS[k].icon, k + ' needs an icon');
    });
  });

  await test('trendScore decays with age and rises with weight', () => {
    assert.ok(trendScore(10, 1) > trendScore(10, 100));
    assert.ok(trendScore(20, 5) > trendScore(10, 5));
    assert.ok(Number.isFinite(trendScore(0, 0)));
    // A negative age (a clock skew between instances) must not produce Infinity.
    assert.ok(Number.isFinite(trendScore(5, -10)));
  });

  // --- the beacon, in the browser -------------------------------------------
  // The landing page frames six apps as live previews. Each frame used to post
  // a view, so "Most used this week" ranked how far visitors scrolled.

  await test('beacon: a top-level visit posts exactly one view, host-only referrer', () => {
    const sent = runBeacon({ referrer: 'https://' + LANDING + '/some/path?q=secret', pathname: '/board' });
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].url, 'https://counter.test/api/beacon');
    assert.deepStrictEqual(sent[0].body, { app: 'football', path: '/board', ref: LANDING });
    assert.strictEqual(sent[0].init.keepalive, true);
  });

  await test('beacon: a framed page (a landing-page preview) posts nothing', () => {
    assert.strictEqual(runBeacon({ framed: true, referrer: 'https://' + LANDING + '/' }).length, 0);
  });

  await test('beacon: a frame whose top cannot even be touched posts nothing, and does not throw', () => {
    assert.strictEqual(runBeacon({ topThrows: true }).length, 0);
  });

  await test('beacon: ?tour= posts nothing, whatever its value or position', () => {
    ['?tour=1', '?tour', '?tour=0', '?x=1&tour=1', '?tour&x=1'].forEach((search) => {
      assert.strictEqual(runBeacon({ search }).length, 0, search + ' should not count');
    });
  });

  await test('beacon: other query parameters that merely contain "tour" still count', () => {
    ['?detour=1', '?tours=2', '?x=tour', '?topup=1'].forEach((search) => {
      assert.strictEqual(runBeacon({ search }).length, 1, search + ' should count');
    });
  });

  await test('beacon: no data-app, no post; a broken fetch never breaks the page', () => {
    assert.strictEqual(runBeacon({ app: '' }).length, 0);
    assert.doesNotThrow(() => runBeacon({ fetchThrows: true }));
  });

  // --- the counter's own rules ----------------------------------------------

  await test('verdict: a genuine tap through from the landing page counts', () => {
    // Same referrer host a preview frame carries - which is exactly why the
    // server does not use the referrer to tell them apart.
    assert.deepStrictEqual(beaconVerdict({ app: 'Football', path: '/', ref: LANDING }, 'Mozilla/5.0'),
      { count: true, app: 'football' });
  });

  await test('verdict: an explicit embed flag is not a view', () => {
    [true, 1, '1', 'true'].forEach((embed) => {
      assert.deepStrictEqual(beaconVerdict({ app: 'trip', embed }, 'Mozilla/5.0'), { count: false, why: 'embed' });
    });
    // Only an explicit yes. Anything else is an ordinary view.
    [false, 0, '0', 'false', '', null, undefined, 'yes please'].forEach((embed) => {
      assert.strictEqual(beaconVerdict({ app: 'trip', embed }, 'Mozilla/5.0').count, true, String(embed));
    });
  });

  await test('verdict: a path that carries the tour parameter is not a view', () => {
    assert.strictEqual(beaconVerdict({ app: 'dataviz', path: '/?tour=1' }, 'Mozilla/5.0').why, 'tour');
    assert.strictEqual(beaconVerdict({ app: 'dataviz', path: '/tours/tour=1' }, 'Mozilla/5.0').count, true);
  });

  await test('verdict: unknown apps, bots and junk bodies are refused', () => {
    assert.strictEqual(beaconVerdict({ app: 'not-an-app' }, 'Mozilla/5.0').why, 'unknown-app');
    assert.strictEqual(beaconVerdict({ app: 'trip' }, 'Googlebot/2.1').why, 'bot');
    assert.strictEqual(beaconVerdict(null, '').why, 'unknown-app');
    assert.strictEqual(beaconVerdict('trip', '').why, 'unknown-app');
    assert.strictEqual(beaconVerdict({ app: 'constructor' }, 'Mozilla/5.0').why, 'unknown-app');
    assert.strictEqual(beaconVerdict({ app: '__proto__' }, 'Mozilla/5.0').why, 'unknown-app');
    assert.strictEqual(beaconVerdict({ app: 'toString' }, 'Mozilla/5.0').why, 'unknown-app');
  });

  // --- the route, end to end, against the in-memory Firestore ---------------

  // Its own handle on the fake database, so a test can write an app's totals
  // directly - the only way to give an app all-time views and no weekly ones.
  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore({ databaseId: 'views-route-test' });
  const app = express();
  app.use(express.json());
  createViews({ db, requireAdmin: (req, res) => res.status(404).end() }).mount(app);
  const server = await listen(app);
  const port = server.address().port;
  const ORIGIN = { Origin: 'https://' + LANDING, 'User-Agent': 'Mozilla/5.0 (iPhone)' };
  const stats = async () => {
    const r = await request(port, 'GET', '/api/stats/public');
    assert.strictEqual(r.status, 200, r.body);
    const d = JSON.parse(r.body);
    const row = (name) => d.apps.find((a) => a.app === name);
    return { d, row };
  };

  try {
    await test('route: a genuine view is counted, this week and all time', async () => {
      const r = await request(port, 'POST', '/api/beacon', { app: 'football', path: '/', ref: LANDING }, ORIGIN);
      assert.strictEqual(r.status, 204);
      assert.ok(/sbvid=/.test(String(r.headers['set-cookie'] || '')), 'a first view mints a visitor');
      const { row } = await stats();
      assert.strictEqual(row('football').views7, 1);
      assert.strictEqual(row('football').totalViews, 1);
    });

    await test('route: an embed-flagged post answers 204, counts nothing, mints no visitor', async () => {
      const r = await request(port, 'POST', '/api/beacon', { app: 'football', path: '/', ref: LANDING, embed: true }, ORIGIN);
      assert.strictEqual(r.status, 204);
      assert.ok(!r.headers['set-cookie'], 'no cookie for a request that is not a view');
      const { row } = await stats();
      assert.strictEqual(row('football').views7, 1);
      assert.strictEqual(row('football').totalViews, 1);
    });

    await test('route: a prototype key is not an app: 204, no visitor, nothing written', async () => {
      for (const name of ['constructor', '__proto__']) {
        const r = await request(port, 'POST', '/api/beacon', { app: name, path: '/', ref: LANDING }, ORIGIN);
        assert.strictEqual(r.status, 204);
        assert.ok(!r.headers['set-cookie'], `no cookie for app ${name}`);
      }
      const docs = (await db.collection('views').get()).docs.map((d) => d.id);
      assert.ok(!docs.includes('constructor') && !docs.includes('__proto__'), docs.join(','));
    });

    await test('route: a tour path answers 204 and counts nothing', async () => {
      const r = await request(port, 'POST', '/api/beacon', { app: 'trip', path: '/?tour=1', ref: LANDING }, ORIGIN);
      assert.strictEqual(r.status, 204);
      const { row } = await stats();
      assert.strictEqual(row('trip').views7, 0);
      assert.strictEqual(row('trip').totalViews, 0);
    });

    await test('route: the weekly and all-time numbers are separate fields, and the ranking uses the weekly one', async () => {
      const { d, row } = await stats();
      const f = row('football');
      ['views7', 'views30', 'totalViews', 'trendPct', 'rank', 'spark'].forEach((k) => assert.ok(k in f, k));
      assert.strictEqual(d.days, 30);
      assert.strictEqual(f.spark.length, 30);
      assert.strictEqual(f.rank, 1, 'the only app with a view this week ranks first');
    });

    await test('route: a big all-time total never outranks a view this week, and only breaks ties', async () => {
      // Trip Planner with 500 views of history and none this week: the preview
      // era lives on in totalViews for good, so it must not drive the ranking.
      await db.collection('views').doc('trip').set({ app: 'trip', label: 'Trip Planner', totalViews: 500 });
      // Two apps level on the week (0 and 0): the all-time total orders them.
      await db.collection('views').doc('hopscotch').set({ app: 'hopscotch', label: 'Hopscotch', totalViews: 40 });
      await db.collection('views').doc('dataviz').set({ app: 'dataviz', label: 'DataViz', totalViews: 90 });
      const { row } = await stats();
      assert.strictEqual(row('football').views7, 1);
      assert.strictEqual(row('football').totalViews, 1);
      assert.strictEqual(row('trip').views7, 0);
      assert.strictEqual(row('trip').totalViews, 500);
      assert.strictEqual(row('football').rank, 1, 'one view this week beats 500 all time');
      assert.ok(row('trip').rank > row('football').rank, 'trip ranks below football');
      assert.ok(row('dataviz').rank < row('hopscotch').rank, 'a tie on the week goes to the larger all-time total');
      assert.ok(row('trip').rank < row('dataviz').rank, '...all the way down the tie');
    });
  } finally {
    server.close();
  }

  console.log(`\n${ran} tests passed.`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
