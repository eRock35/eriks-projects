// Booth - trade-show leads that don't go cold.
//
// A small team pays for a booth at a trade show, a conference, a farmers'
// market or a pop-up, comes home with a fishbowl of business cards, and sends
// the follow-ups a week late or never - and nobody can say whether the show
// paid off. Booth is the team's shared lead list for one event: capture a
// lead in ten seconds (type it, or snap the card or badge), qualify it hot /
// warm / cold, and every lead gets a follow-up clock - hot goes cold in 48
// hours. A leaderboard makes it a game on the day; the show scorecard says
// what the booth was worth afterwards. See CLAUDE.md.
//
// A model is used for two things only: reading a card or badge photo, and
// drafting a follow-up in the rep's voice. Everything else - the clocks, the
// leaderboard, the scorecard, the templates, the CSV - is public/rules.js and
// lib/events.js, and free.

const fs = require('fs');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { store, MEMORY, memoryIdentityStore } = require('./lib/store');
const B = require('./public/rules');
const E = require('./lib/events');
const ai = require('./lib/ai');
const photo = require('./lib/photo');
const { demo } = require('./lib/demo');
const identityLib = require('./lib/identity');

const PORT = process.env.PORT || 8080;
const FAKE_AI = process.env.BOOTH_FAKE_AI === '1';
if (FAKE_AI && process.env.K_SERVICE) throw new Error('BOOTH_FAKE_AI=1 is for local use only and is refused on Cloud Run.');

// Free tier on Haiku, members on Sonnet - the split every sibling uses,
// decided in one place by identity.planFor. Both read photos.
const MODELS = { free: 'claude-haiku-4-5', paid: 'claude-sonnet-5' };

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('Content-Security-Policy', "frame-ancestors 'self' https://strongtechnicalconsulting.com https://www.strongtechnicalconsulting.com");
  res.set('X-Content-Type-Options', 'nosniff');
  // A share link is the credential for that scorecard. It must not ride out
  // in a Referer header, and it must not be indexed under Booth's name.
  if (req.path.startsWith('/s/') || req.path.startsWith('/api/shared/')) {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex, nofollow');
  } else {
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
  next();
});

// One card photo rides in the snap request as base64. Only that route gets
// the big limit, and it mounts its own parser AFTER the sign-in, budget and
// membership checks, so a stranger's 6 MB is never read. Everything else
// stays small.
const SNAP_ROUTE = /^\/api\/events\/[^/]+\/read$/;
const bigJson = express.json({ limit: '6mb' });
const smallJson = express.json({ limit: '128kb' });
app.use((req, res, next) => (SNAP_ROUTE.test(req.path) ? next() : smallJson(req, res, next)));

/* ------------------------------------------------------------------ *
 * The shared account
 * ------------------------------------------------------------------ */

const identityStore = MEMORY ? memoryIdentityStore() : require('./lib/identity-store').store;
const identity = identityLib.create({
  store: identityStore,
  secret: () => process.env.IDENTITY_SESSION_SECRET || (MEMORY ? 'local-dev-secret' : ''),
  app: 'booth',
  baseDomain: process.env.PASSKEY_RP_ID || '',
  rpName: 'Booth',
  mountPath: '/api/auth',
});
identity.mount(app);

const sharedClient = FAKE_AI
  ? identity.meter(require('./lib/fakeai').create())
  : identity.meter(new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }));

function clientFor(req) {
  if (FAKE_AI) return Promise.resolve(sharedClient);
  return identity.clientFor(req.user, sharedClient, (apiKey) => new Anthropic({ apiKey }));
}
const modelFor = (req) => identityLib.planFor(req.user, MODELS).model;

// Never put a model call behind a sign-in alone: every one of these goes
// through the budget and the free tier's daily ceiling as well.
const spend = [identity.requireUser, identity.requireBudget, identity.requireDailyCap];
const user = identity.requireUser;

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

const now = () => new Date().toISOString();
const httpError = E.httpError;
// Errors are logged only when they are ours (no status). Never a request
// body: a lead is somebody's name, email and phone.
const fail = (res, err, fallback = 'Something went wrong.') => {
  if (!err.status) console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error');
  const body = { error: err.status ? err.message : fallback };
  for (const k of ['field', 'duplicate', 'retryAfterMin']) if (err[k] !== undefined) body[k] = err[k];
  res.status(err.status || 500).json(body);
};

const membersOf = (eid) => `events/${eid}/members`;
const leadsOf = (eid) => `events/${eid}/leads`;

/**
 * The event, if the signed-in person is on its team. 404 - never 403 - for
 * anyone who is not, so an event id is not confirmed to exist. `owner: true`
 * then turns away staff with a 403: they are on the team, so there is
 * nothing to hide from them about its existence.
 */
async function loadEvent(req, { owner = false } = {}) {
  const id = String(req.params.id || '');
  const ev = E.ID_RE.test(id) ? await store.get('events', id) : null;
  if (!ev || !(ev.memberIds || []).includes(req.user.id)) throw httpError(404, 'No such event.');
  const me = await store.get(membersOf(ev.id), req.user.id);
  if (!me) throw httpError(404, 'No such event.');
  ev.me = me;
  ev.viewer = req.user.id;
  ev.role = ev.ownerId === req.user.id ? 'owner' : 'staff';
  if (owner && ev.role !== 'owner') throw httpError(403, 'Only the event’s owner can do that.');
  return ev;
}

/** loadEvent as middleware, for the snap route: the membership 404 comes
 *  before its big body parser, so a stranger's upload is never read. */
function memberOnly(req, res, next) {
  loadEvent(req).then((ev) => { req.event = ev; next(); }, (err) => fail(res, err));
}

async function loadMembers(eid) {
  const rows = await store.list(membersOf(eid), { limit: E.LIMITS.members + 5 });
  return rows.map((m) => ({ uid: m.id, name: m.name, role: m.role, signoff: m.signoff || '', tone: m.tone || 'friendly', joinedAt: m.joinedAt }));
}
const loadLeads = (eid) => store.list(leadsOf(eid), { limit: E.LIMITS.leads + 5 });

async function loadLead(ev, req) {
  const id = String(req.params.lid || '');
  const l = E.ID_RE.test(id) ? await store.get(leadsOf(ev.id), id) : null;
  if (!l) throw httpError(404, 'No such lead.');
  return l;
}

/**
 * One read-modify-write at a time per key on this instance, queued rather
 * than refused. Leads are one document each, so two people capturing at once
 * write two documents; this only keeps one instance's dedupe check honest and
 * a double-tapped status from stamping twice.
 */
const locks = new Map();
async function exclusive(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const chain = prev.then(() => mine);
  locks.set(key, chain);
  await prev;
  try { return await fn(); } finally {
    release();
    if (locks.get(key) === chain) locks.delete(key);
  }
}

function eventView(ev, extra = {}) {
  const owner = ev.role === 'owner';
  return {
    id: ev.id,
    name: ev.name,
    place: ev.place || '',
    startDate: ev.startDate,
    endDate: ev.endDate,
    boothCost: ev.boothCost || 0,
    chips: ev.chips || [],
    role: ev.role,
    owner,
    code: owner ? B.formatCode(ev.code) : undefined,
    share: owner && ev.shareToken ? { token: ev.shareToken, url: `s/${ev.shareToken}`, sharedAt: ev.sharedAt } : undefined,
    members: (ev.memberIds || []).length,
    me: { name: ev.me.name, signoff: ev.me.signoff || '', tone: ev.me.tone || 'friendly' },
    ...extra,
  };
}

/* ------------------------------------------------------------------ *
 * Public: health, meta, the sample show
 * ------------------------------------------------------------------ */

app.get(['/api/health', '/healthz'], (_req, res) => res.json({ ok: true, store: store.kind }));

app.get('/api/meta', (_req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json({ temps: B.TEMPS, next: B.NEXT_STEPS, statuses: B.STATUSES, tones: B.TONES, badges: B.BADGES, points: B.POINTS, chips: B.DEFAULT_CHIPS, limits: E.LIMITS });
});

// An invented show run through the real rules. No model call for a
// signed-out visitor, ever.
app.get('/api/demo', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(demo(Date.now()));
});

/* ------------------------------------------------------------------ *
 * Me and my events
 * ------------------------------------------------------------------ */

async function myEvents(uid) {
  const rows = await store.list('events', { where: [['memberIds', 'array-contains', uid]], limit: E.LIMITS.memberships + 5 });
  const out = [];
  for (const ev of rows) {
    const me = await store.get(membersOf(ev.id), uid);
    if (!me) continue;
    out.push({ id: ev.id, name: ev.name, place: ev.place || '', startDate: ev.startDate, endDate: ev.endDate, role: ev.ownerId === uid ? 'owner' : 'staff', members: (ev.memberIds || []).length, leads: Math.max(0, ev.leadCount || 0), createdAt: ev.createdAt });
  }
  return out.sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

app.get('/api/me', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return res.json({ signedIn: false });
    res.json({
      signedIn: true,
      email: req.user.email,
      name: E.nameFromEmail(req.user.email),
      budget: identityLib.budgetFor(req.user),
      tier: identityLib.planFor(req.user, MODELS).tier,
      events: await myEvents(req.user.id),
    });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Events: create, join, manage
 * ------------------------------------------------------------------ */

async function freshCode() {
  let code = E.newCode();
  for (let i = 0; i < 5 && (await store.get('codes', code)); i++) code = E.newCode();
  return code;
}

app.post('/api/events', user, async (req, res) => {
  try {
    const b = req.body || {};
    const facts = E.cleanEvent(b);
    const mine = await myEvents(req.user.id);
    if (mine.filter((e) => e.role === 'owner').length >= E.LIMITS.ownedEvents) throw httpError(409, `You can run up to ${E.LIMITS.ownedEvents} events - delete an old one first.`);
    if (mine.length >= E.LIMITS.memberships) throw httpError(409, `You are on ${E.LIMITS.memberships} events already - leave one first.`);
    const code = await freshCode();
    const at = now();
    const id = E.newId();
    const name = B.clean(b.yourName, E.LIMITS.personName) || E.nameFromEmail(req.user.email);
    await store.set('events', id, { ...facts, code, ownerId: req.user.id, memberIds: [req.user.id], leadCount: 0, createdAt: at, updatedAt: at });
    await store.set(membersOf(id), req.user.id, { name, role: 'owner', signoff: '', tone: 'friendly', joinedAt: at });
    await store.set('codes', code, { eventId: id, createdAt: at });
    const ev = await loadEvent({ params: { id }, user: req.user });
    res.json(eventView(ev));
  } catch (err) { fail(res, err); }
});

/**
 * Wrong codes are counted per person (in the store, so it holds across
 * instances) and per address (in memory, for someone with many accounts).
 * Every wrong code gets the same answer - there is no way to tell "no such
 * code" from "a code that used to work", and nothing about any event. Once
 * blocked, even the right code is refused, so the limit is not an oracle.
 */
const ipTries = new Map();
function ipBlocked(ip) {
  const e = ipTries.get(ip);
  if (!e) return false;
  if (Date.now() - e.since > E.LIMITS.joinWindowMs) { ipTries.delete(ip); return false; }
  return e.count >= E.LIMITS.joinTriesPerIp;
}
function ipMiss(ip) {
  const e = ipTries.get(ip);
  if (!e || Date.now() - e.since > E.LIMITS.joinWindowMs) ipTries.set(ip, { count: 1, since: Date.now() });
  else e.count++;
  if (ipTries.size > 5000) ipTries.delete(ipTries.keys().next().value);
}
async function userTries(uid) {
  const r = await store.get('joinfails', uid);
  if (!r || Date.now() - Date.parse(r.since) > E.LIMITS.joinWindowMs) return { count: 0, since: null };
  return r;
}
function tooMany(since) {
  const left = since ? Math.max(1, Math.ceil((Date.parse(since) + E.LIMITS.joinWindowMs - Date.now()) / 60000)) : 15;
  return httpError(429, `Too many wrong codes. Try again in ${left} minute${left === 1 ? '' : 's'}, and check the code with whoever runs the booth.`, { retryAfterMin: left });
}

app.post('/api/join', user, async (req, res) => {
  try {
    const b = req.body || {};
    const tries = await userTries(req.user.id);
    if (tries.count >= E.LIMITS.joinTries || ipBlocked(req.ip)) throw tooMany(tries.since);
    const code = B.normalizeCode(b.code);
    const link = B.isCode(code) ? await store.get('codes', code) : null;
    const ev = link && await store.get('events', link.eventId);
    if (!ev || ev.code !== code) {
      await store.set('joinfails', req.user.id, { count: tries.count + 1, since: tries.since || now() });
      ipMiss(req.ip);
      throw httpError(404, 'That code didn’t match an event. Check it with whoever runs the booth - codes change when they reset them.');
    }
    if ((ev.memberIds || []).includes(req.user.id)) return res.json({ id: ev.id, name: ev.name, already: true });
    if ((ev.memberIds || []).length >= E.LIMITS.members) throw httpError(409, `This booth’s team is full (${E.LIMITS.members} people).`);
    const mine = await myEvents(req.user.id);
    if (mine.length >= E.LIMITS.memberships) throw httpError(409, `You are on ${E.LIMITS.memberships} events already - leave one first.`);
    const name = B.clean(b.name, E.LIMITS.personName) || E.nameFromEmail(req.user.email);
    await store.set(membersOf(ev.id), req.user.id, { name, role: 'staff', signoff: '', tone: 'friendly', joinedAt: now() });
    await store.arrayAdd('events', ev.id, 'memberIds', req.user.id);
    res.json({ id: ev.id, name: ev.name, already: false });
  } catch (err) { fail(res, err); }
});

app.get('/api/events/:id', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    res.set('Cache-Control', 'no-store');
    const people = (await loadMembers(ev.id)).map(({ uid, name, role }) => ({ uid, name, role, you: uid === req.user.id }));
    res.json(eventView(ev, { people }));
  } catch (err) { fail(res, err); }
});

app.put('/api/events/:id', user, async (req, res) => {
  try {
    const ev = await loadEvent(req, { owner: true });
    const patch = E.cleanEvent(req.body || {}, ev);
    await store.merge('events', ev.id, { ...patch, updatedAt: now() });
    res.json(eventView({ ...ev, ...patch }));
  } catch (err) { fail(res, err); }
});

/** Your own name, sign-off and tone on this event's team - what a drafted
 *  follow-up signs with. */
app.put('/api/events/:id/me', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const patch = E.cleanMember(req.body || {}, ev.me);
    await store.merge(membersOf(ev.id), req.user.id, patch);
    res.json({ ...{ name: ev.me.name, signoff: ev.me.signoff || '', tone: ev.me.tone || 'friendly' }, ...patch });
  } catch (err) { fail(res, err); }
});

/** A fresh code. The old one stops working at once - for when it leaked, or
 *  someone left who should not rejoin. */
app.post('/api/events/:id/code', user, async (req, res) => {
  try {
    const ev = await loadEvent(req, { owner: true });
    const code = await freshCode();
    await store.set('codes', code, { eventId: ev.id, createdAt: now() });
    await store.merge('events', ev.id, { code, updatedAt: now() });
    if (ev.code) await store.remove('codes', ev.code);
    res.json({ code: B.formatCode(code) });
  } catch (err) { fail(res, err); }
});

/**
 * Remove someone, or leave (`me`). The owner removes staff; staff can leave;
 * the owner deletes the event instead of leaving. Their leads stay - they
 * are the team's pipeline, not the rep's.
 */
app.delete('/api/events/:id/members/:uid', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const uid = req.params.uid === 'me' ? req.user.id : String(req.params.uid);
    if (uid === ev.ownerId) throw httpError(400, uid === req.user.id ? 'You run this event - delete it instead of leaving.' : 'The owner cannot be removed.');
    if (uid !== req.user.id) {
      if (ev.role !== 'owner') throw httpError(403, 'Only the event’s owner can do that.');
      const them = (ev.memberIds || []).includes(uid) ? await store.get(membersOf(ev.id), uid) : null;
      if (!them) throw httpError(404, 'They are not on this team.');
    }
    await store.arrayRemove('events', ev.id, 'memberIds', uid);
    await store.remove(membersOf(ev.id), uid);
    res.json({ ok: true, left: uid === req.user.id });
  } catch (err) { fail(res, err); }
});

app.delete('/api/events/:id', user, async (req, res) => {
  try {
    const ev = await loadEvent(req, { owner: true });
    for (const l of await store.list(leadsOf(ev.id))) await store.remove(leadsOf(ev.id), l.id);
    for (const m of await store.list(membersOf(ev.id))) await store.remove(membersOf(ev.id), m.id);
    if (ev.code) await store.remove('codes', ev.code);
    if (ev.shareToken) await store.remove('shares', ev.shareToken);
    await store.remove('events', ev.id);
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Leads: one document each
 * ------------------------------------------------------------------ */

/** A lead for the page, plus whether this viewer may delete it. */
const viewOf = (ev, l, t = Date.now()) => ({ ...E.leadView(l, t), canDelete: ev.role === 'owner' || l.capturedBy === ev.viewer });

function dupError(d) {
  const l = d.lead;
  return httpError(409, `Looks like ${l.name || l.company || 'this person'} is already on the list${l.capturedByName ? ` - ${l.capturedByName} captured them` : ''}.`, {
    duplicate: { id: l.id, name: l.name || '', company: l.company || '', temp: l.temp, capturedByName: l.capturedByName || '', capturedAt: l.capturedAt, by: d.by },
  });
}
function leadError(r) { return httpError(400, r.error, { field: r.field }); }

app.get('/api/events/:id/leads', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const t = Date.now();
    const leads = (await loadLeads(ev.id)).map((l) => viewOf(ev, l, t)).sort((a, b) => String(b.capturedAt).localeCompare(String(a.capturedAt)));
    res.set('Cache-Control', 'no-store');
    res.json({ event: eventView(ev), now: new Date(t).toISOString(), leads });
  } catch (err) { fail(res, err); }
});

/**
 * Capture. Validated with the page's own rules, checked against the event's
 * list for the same email or phone (409 with the match, so the page can
 * offer a merge; `force: true` saves it anyway), and written as its own
 * document - two reps capturing at once never touch each other's.
 */
app.post('/api/events/:id/leads', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const b = req.body || {};
    const r = B.validateLead({ ...b, value: undefined }, { chips: ev.chips || [] });
    if (r.error) throw leadError(r);
    const out = await exclusive(`cap/${ev.id}`, async () => {
      const all = await loadLeads(ev.id);
      if (all.length >= E.LIMITS.leads) throw httpError(409, `An event holds up to ${E.LIMITS.leads} leads.`);
      const d = B.findDuplicate(all, r.lead);
      if (d && b.force !== true) throw dupError(d);
      const at = now();
      const id = E.newId();
      const lead = {
        ...r.lead,
        source: ['typed', 'card', 'badge'].includes(b.source) ? b.source : 'typed',
        status: 'new',
        value: null,
        capturedBy: req.user.id,
        capturedByName: ev.me.name,
        capturedAt: at,
        updatedAt: at,
        updatedBy: req.user.id,
      };
      await store.set(leadsOf(ev.id), id, lead);
      await store.bump('events', ev.id, { leadCount: 1 });
      return { id, ...lead };
    });
    res.json({ lead: viewOf(ev, out) });
  } catch (err) { fail(res, err); }
});

app.get('/api/events/:id/leads/:lid', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const l = await loadLead(ev, req);
    res.set('Cache-Control', 'no-store');
    res.json({ lead: viewOf(ev, l) });
  } catch (err) { fail(res, err); }
});

/** Edit or re-qualify: the fields sent replace the lead's, everything is
 *  validated again, and a changed email or phone is checked for a twin. */
app.put('/api/events/:id/leads/:lid', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const out = await exclusive(`lead/${ev.id}/${req.params.lid}`, async () => {
      const l = await loadLead(ev, req);
      const b = req.body || {};
      const merged = {};
      for (const k of ['name', 'company', 'title', 'email', 'phone', 'temp', 'chips', 'next', 'note', 'value']) merged[k] = b[k] !== undefined ? b[k] : l[k];
      const r = B.validateLead(merged, { chips: ev.chips || [] });
      if (r.error) throw leadError(r);
      if ((r.lead.email !== (l.email || '') || B.phoneKey(r.lead.phone) !== B.phoneKey(l.phone)) && b.force !== true) {
        const d = B.findDuplicate(await loadLeads(ev.id), r.lead, l.id);
        if (d) throw dupError(d);
      }
      const patch = { ...r.lead, updatedAt: now(), updatedBy: req.user.id };
      await store.merge(leadsOf(ev.id), l.id, patch);
      return { ...l, ...patch };
    });
    res.json({ lead: viewOf(ev, out) });
  } catch (err) { fail(res, err); }
});

/** Sent / replied / booked / won / lost - and back. Won takes a deal value. */
app.post('/api/events/:id/leads/:lid/status', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const out = await exclusive(`lead/${ev.id}/${req.params.lid}`, async () => {
      const l = await loadLead(ev, req);
      const b = req.body || {};
      let value;
      if (b.value !== undefined) {
        const v = B.toNumber(b.value);
        if (v !== null && (Number.isNaN(v) || v < 0 || v > E.LIMITS.value)) throw httpError(400, 'Deal value is a number of dollars.', { field: 'value' });
        value = v === null ? null : Math.round(v);
      }
      const patch = B.applyStatus(l, b.status, now(), req.user.id, value);
      if (!patch) throw httpError(400, 'Pick a status.');
      patch.updatedAt = now();
      patch.updatedBy = req.user.id;
      await store.merge(leadsOf(ev.id), l.id, patch);
      return { ...l, ...patch };
    });
    res.json({ lead: viewOf(ev, out) });
  } catch (err) { fail(res, err); }
});

/**
 * Fold a second capture of the same person into the first. Gaps are filled,
 * interests added, the hotter temperature kept and both notes kept; nothing
 * already recorded is overwritten, and the lead stays the first capturer's.
 */
app.post('/api/events/:id/leads/:lid/merge', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const r = B.validateLead({ ...(req.body || {}), value: undefined }, { chips: ev.chips || [] });
    if (r.error) throw leadError(r);
    const out = await exclusive(`lead/${ev.id}/${req.params.lid}`, async () => {
      const l = await loadLead(ev, req);
      const patch = B.mergePatch(l, r.lead, ev.me.name);
      patch.mergedCount = (l.mergedCount || 0) + 1;
      patch.updatedAt = now();
      patch.updatedBy = req.user.id;
      await store.merge(leadsOf(ev.id), l.id, patch);
      return { ...l, ...patch };
    });
    res.json({ lead: viewOf(ev, out), merged: true });
  } catch (err) { fail(res, err); }
});

/** Whoever captured a lead can delete it, and so can the owner. */
app.delete('/api/events/:id/leads/:lid', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const l = await loadLead(ev, req);
    if (ev.role !== 'owner' && l.capturedBy !== req.user.id) throw httpError(403, 'Only whoever captured it, or the event’s owner, can delete a lead.');
    await store.remove(leadsOf(ev.id), l.id);
    await store.bump('events', ev.id, { leadCount: -1 });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

/** A free follow-up for this lead's temperature, from what was captured. */
app.get('/api/events/:id/leads/:lid/template', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const l = await loadLead(ev, req);
    const t = B.template(l, ev, ev.me);
    res.set('Cache-Control', 'no-store');
    res.json({ ...t, mailto: B.mailto(l.email, t.subject, t.body) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * Metered: draft a follow-up, read a card
 * ------------------------------------------------------------------ */

/**
 * A follow-up in the rep's voice. The model sees the show, the rep's name,
 * sign-off and tone, and the lead's first name, company, role, temperature,
 * interests, next step and note - never their email or phone. The draft is
 * checked for invented facts and returned; nothing is saved and nothing is
 * sent. Booth has no mail service: the page copies it or opens a mailto:.
 */
app.post('/api/events/:id/leads/:lid/draft', ...spend, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const l = await loadLead(ev, req);
    const src = ai.draftSource(ev, ev.me, l);
    const fallback = B.template(l, ev, ev.me).subject;
    const client = await clientFor(req);
    const raw = await ai.draft(client, modelFor(req), src);
    const d = ai.validateDraft(raw, src, fallback);
    if (!d) throw httpError(422, 'The draft came back empty. Try again - or use the free template.');
    res.json({ ...d, mailto: B.mailto(l.email, d.subject, d.body) });
  } catch (err) { fail(res, err, 'Could not draft that. Try again, or use the free template.'); }
});

/**
 * Snap a card or badge: one photo in, a proposed contact out. Validated by
 * its bytes before anything is spent, read once by the model, dropped with
 * the request. Nothing is saved - the capture form's Save does that.
 */
app.post('/api/events/:id/read', ...spend, memberOnly, bigJson, async (req, res) => {
  try {
    const image = photo.validate((req.body || {}).image);
    const client = await clientFor(req);
    const raw = await ai.readContact(client, modelFor(req), image);
    const c = ai.validateContact(raw);
    if (!c) throw httpError(422, 'We couldn’t read a name, company, email or phone on that. Try a closer, flatter shot - or type it in.');
    res.json(c);
  } catch (err) { fail(res, err, 'Could not read that photo. Try again, or type it in.'); }
});

/* ------------------------------------------------------------------ *
 * Leaderboard, scorecard, export. No model call anywhere below this line.
 * ------------------------------------------------------------------ */

app.get('/api/events/:id/leaderboard', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const t = Date.now();
    const members = await loadMembers(ev.id);
    const rows = B.leaderboard(members, await loadLeads(ev.id), t, { boothCost: ev.boothCost })
      .map((r) => ({ ...r, you: r.uid === req.user.id }));
    res.set('Cache-Control', 'no-store');
    res.json({ event: eventView(ev), now: new Date(t).toISOString(), rows });
  } catch (err) { fail(res, err); }
});

app.get('/api/events/:id/scorecard', user, async (req, res) => {
  try {
    const ev = await loadEvent(req);
    const t = Date.now();
    const leads = await loadLeads(ev.id);
    res.set('Cache-Control', 'no-store');
    res.json({
      event: eventView(ev),
      now: new Date(t).toISOString(),
      scorecard: B.scorecard(ev, leads, t),
      goingCold: B.goingCold(leads, t, 50).map((r) => ({ id: r.lead.id, name: r.lead.name || '', company: r.lead.company || '', temp: r.lead.temp, capturedByName: r.lead.capturedByName || '', clock: r.clock })),
    });
  } catch (err) { fail(res, err); }
});

/** Every lead as a spreadsheet, for the CRM. The owner's: it is the whole
 *  team's contact list in one file. */
app.get('/api/events/:id/export.csv', user, async (req, res) => {
  try {
    const ev = await loadEvent(req, { owner: true });
    const t = Date.now();
    const leads = (await loadLeads(ev.id)).map((l) => E.leadView(l, t)).sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)));
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${E.csvFilename(ev.name, E.utcToday(t))}"`);
    res.send(E.toCsv(leads));
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The shared scorecard: a frozen, public, read-only card
 * ------------------------------------------------------------------ */

/**
 * Publish or refresh. It freezes the aggregates as they are now - later
 * captures change nothing until the owner taps Update, which re-freezes the
 * same link. Counts and money only: no lead and no teammate is on it.
 */
app.post('/api/events/:id/share', user, async (req, res) => {
  try {
    const out = await exclusive(`share/${req.params.id}`, async () => {
      const ev = await loadEvent(req, { owner: true });
      const at = now();
      const card = E.shareCard(ev, B.scorecard(ev, await loadLeads(ev.id), Date.now()), (ev.memberIds || []).length, at);
      let token = ev.shareToken;
      if (!token) {
        token = E.newToken();
        while (await store.get('shares', token)) token = E.newToken();
      }
      await store.set('shares', token, { eventId: ev.id, uid: req.user.id, createdAt: at, card });
      await store.merge('events', ev.id, { shareToken: token, sharedAt: at });
      return { token, url: `s/${token}`, sharedAt: at, card };
    });
    res.json(out);
  } catch (err) { fail(res, err); }
});

app.delete('/api/events/:id/share', user, async (req, res) => {
  try {
    const ev = await loadEvent(req, { owner: true });
    if (ev.shareToken) await store.remove('shares', ev.shareToken);
    await store.merge('events', ev.id, { shareToken: null, sharedAt: null });
    res.json({ ok: true });
  } catch (err) { fail(res, err); }
});

// The public card. No account, no model call, read-only.
app.get('/api/shared/:token', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const token = String(req.params.token || '');
    if (!E.TOKEN_RE.test(token)) throw httpError(404, 'This link is not valid.');
    const s = await store.get('shares', token);
    if (!s || !s.card) throw httpError(404, 'This link is not valid any more.');
    res.json({ ...s.card, preview: Boolean(req.user && req.user.id === s.uid) });
  } catch (err) { fail(res, err); }
});

/* ------------------------------------------------------------------ *
 * The page
 * ------------------------------------------------------------------ */

// The card is the same single-page app served one level down at s/<token>.
// <base href="../"> makes every relative asset and API path in it resolve
// against the app root, mounted or not.
const INDEX = path.join(__dirname, 'public', 'index.html');
let indexHtml = null;
function publicIndex() {
  if (!indexHtml || MEMORY) indexHtml = fs.readFileSync(INDEX, 'utf8');
  return indexHtml.replace('<head>', '<head>\n  <base href="../">');
}
app.get('/s/:token', (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(publicIndex());
});
// GET is the only verb the public paths answer.
app.all(['/s/:token', '/api/shared/:token'], (_req, res) => res.status(405).set('Allow', 'GET').json({ error: 'Read-only.' }));

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], maxAge: '5m' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(INDEX);
});
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That is too much to send at once - try a smaller photo or less text.' });
  if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'That request could not be read.' });
  console.error(err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n') : 'error');
  res.status(500).json({ error: 'Something went wrong.' });
});

if (require.main === module) {
  // BOOTH_DEV_MOUNT=/booth runs it the way the lab host does: mounted under a
  // prefix, with the bare prefix redirected to its slash form.
  const mount = String(process.env.BOOTH_DEV_MOUNT || '').replace(/\/+$/, '');
  let server = app;
  if (mount) {
    server = express();
    // Exact match only: Express's non-strict routing would also match the
    // slash form here and redirect it to itself forever.
    server.use((req, res, next) => (req.path === mount ? res.redirect(301, `${mount}/`) : next()));
    server.use(mount, app);
    server.get('/', (_req, res) => res.redirect(302, `${mount}/`));
  }
  server.listen(PORT, () => console.log(`booth listening on ${PORT}${mount ? ` at ${mount}/` : ''}${MEMORY ? ' (memory store)' : ''}${FAKE_AI ? ' (fake AI)' : ''}`));
}

module.exports = { app, identity, identityStore, store };
