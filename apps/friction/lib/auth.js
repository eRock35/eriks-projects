// One account, one password, a signed session cookie. This app holds Erik's
// own opportunity pipeline, so the gate only has to keep strangers out - there
// is no second user to model, no registration, no reset flow.

const crypto = require('crypto');

const COOKIE = 'friction_session';
const MAX_AGE_DAYS = 30;

function secret() {
  return process.env.SESSION_SECRET || '';
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function issue(res) {
  const exp = Date.now() + MAX_AGE_DAYS * 86400000;
  const body = String(exp);
  const token = `${body}.${sign(body)}`;
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: MAX_AGE_DAYS * 86400000,
    path: '/',
  });
}

function clear(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

function hasSession(req) {
  if (!secret()) return false;
  const raw = (req.cookies || {})[COOKIE];
  if (!raw) return false;
  const [body, mac] = String(raw).split('.');
  if (!body || !mac) return false;
  const expected = sign(body);
  // Length-check first: timingSafeEqual throws on a length mismatch.
  if (mac.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return false;
  return Number(body) > Date.now();
}

function passwordOk(candidate) {
  const real = process.env.APP_PASSWORD || '';
  if (!real || typeof candidate !== 'string' || candidate.length !== real.length) return false;
  return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(real));
}

function cronOk(req) {
  const key = process.env.CRON_SECRET || '';
  const sent = req.get('X-Cron-Key') || '';
  if (!key || sent.length !== key.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(key));
}

/** Every route that costs Anthropic tokens sits behind this OR the cron key.
 *  Nothing that spends money is reachable with neither. */
function requireLoginOrCron(req, res, next) {
  if (hasSession(req) || cronOk(req)) return next();
  return res.status(401).json({ error: 'not signed in' });
}

function requireLogin(req, res, next) {
  if (hasSession(req)) return next();
  if ((req.get('Accept') || '').indexOf('text/html') !== -1) return res.redirect('/login');
  return res.status(401).json({ error: 'not signed in' });
}

module.exports = { COOKIE, issue, clear, hasSession, passwordOk, cronOk, requireLogin, requireLoginOrCron };
