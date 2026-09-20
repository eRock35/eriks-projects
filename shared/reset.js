// Forgotten passwords, the ordinary way: a signed link by email.
//
// This is the SHARED copy, hosted once on the landing page because that is the
// only service holding the Resend key. Every app links to the same /reset URL
// rather than each running its own flow: you reset the account, not the app
// login, and there is one page to get right.
//
// Two properties worth keeping:
//
// 1. The request endpoint answers IDENTICALLY whether or not the account
//    exists. Anything else turns a password form into a way of asking which
//    email addresses have accounts here.
//
// 2. The token is a signed HMAC that carries the account's CURRENT password
//    hash. That makes it single-use without storing anything: the moment the
//    password changes, every outstanding link for that account stops
//    verifying, including the one that was just used. A second click on the
//    same link does nothing.

const crypto = require('crypto');

const TTL_SECONDS = 60 * 60; // an hour is long enough to find the email

function secret() { return process.env.IDENTITY_SESSION_SECRET || ""; }

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

/** The user's stored hash is mixed in, so the token dies when it is used. */
function makeToken(uid, passwordHash) {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const body = `${uid}.${exp}`;
  return `${Buffer.from(body).toString('base64url')}.${sign(`${body}.${passwordHash}`)}`;
}

function readToken(token, lookupHash) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const i = token.lastIndexOf('.');
  const body = Buffer.from(token.slice(0, i), 'base64url').toString();
  const mac = token.slice(i + 1);
  const [uid, expStr] = body.split('.');
  if (!uid || !expStr) return null;
  if (Number(expStr) < Math.floor(Date.now() / 1000)) return null;
  const expected = sign(`${body}.${lookupHash}`);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  return uid;
}

function emailBody({ link, origin }) {
  return {
    subject: 'Reset your DataViz password',
    text: `Someone asked to reset the password for this DataViz account.\n\n${link}\n\n`
      + `The link works once and expires in an hour. If it was not you, ignore this and nothing changes.`,
    html: `<!DOCTYPE html><html><body style="margin:0;background:#f2f2f7;">
<div style="max-width:560px;margin:0 auto;padding:28px 20px 40px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1d1d1f;line-height:1.55;font-size:17px;">
<h1 style="font-size:23px;font-weight:700;margin:0 0 14px;">Reset your password</h1>
<p style="margin:0 0 18px;">Someone asked to reset the password for this DataViz account.</p>
<p style="margin:0 0 22px;"><a href="${link}" style="display:inline-block;background:#5B8DEF;color:#fff;text-decoration:none;font-weight:600;padding:13px 22px;border-radius:12px;">Choose a new password</a></p>
<p style="margin:0 0 8px;font-size:14px;color:#6e6e73;">The link works once and expires in an hour.</p>
<p style="margin:0;font-size:14px;color:#6e6e73;">If it was not you, ignore this and nothing changes.</p>
<p style="margin:22px 0 0;font-size:13px;color:#8e8e93;">Or paste this into your browser:<br>${link}</p>
</div></body></html>`,
  };
}

module.exports = { makeToken, readToken, emailBody, TTL_SECONDS };
