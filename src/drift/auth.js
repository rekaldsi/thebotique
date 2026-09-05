'use strict';

// Passwordless sign-in and sessions.
//
// No passwords are stored, hashed or otherwise, because none are collected.
// The account is an email address and a plan; that is the entire identity
// model. Given what was found in this codebase's history -- admin auth by
// wallet address in a query string, an unauthenticated email relay, an
// endpoint that minted credits for free -- the design rule here is that
// nothing is authenticated by a value the client can simply assert.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SCHEMA = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
const TOKEN_TTL_MS = 15 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'drift_session';

// A stable secret is required to sign sessions. In production we refuse to
// invent one: a per-boot random secret would silently log everyone out on
// every deploy, and a hardcoded default would let anyone forge a session.
let SECRET = process.env.SESSION_SECRET;
if (!SECRET) {
  if (process.env.NODE_ENV === 'production') {
    SECRET = null; // sessions disabled; see sessionsAvailable()
  } else {
    SECRET = crypto.randomBytes(32).toString('hex');
  }
}
const sessionsAvailable = () => !!SECRET;

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normalizeEmail = (e) => String(e || '').trim().toLowerCase();

// Basic shape check only. We deliberately do not try to validate deliverability.
function validEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254;
}

async function init(db) {
  await db.query(SCHEMA);
}

// --- sessions ---------------------------------------------------------------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(raw) {
  if (!raw || !SECRET) return null;
  const [body, mac] = String(raw).split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  // Constant-time compare; lengths must match first or timingSafeEqual throws.
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}

function setSession(res, accountId) {
  const value = sign({ a: accountId, exp: Date.now() + SESSION_TTL_MS });
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`];
  if (process.env.NODE_ENV === 'production') flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE}=${value}; ${flags.join('; ')}`);
}

function clearSession(res) {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (process.env.NODE_ENV === 'production') flags.push('Secure');
  res.setHeader('Set-Cookie', `${COOKIE}=; ${flags.join('; ')}`);
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// Resolves the signed cookie to a real account row. The cookie proves only
// that we issued it; the account is always re-read from the database.
async function currentAccount(db, req) {
  const p = verify(readCookie(req, COOKIE));
  if (!p || !p.a) return null;
  const r = await db.query(
    'SELECT id, email, plan FROM drift_accounts WHERE id = $1', [p.a]
  );
  return r.rows[0] || null;
}

// --- magic links ------------------------------------------------------------
// Returns the token to email. The token is never stored in plaintext.
async function issueLoginToken(db, emailRaw) {
  const email = normalizeEmail(emailRaw);
  if (!validEmail(email)) throw new Error('invalid email');
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + TOKEN_TTL_MS);
  await db.query(
    `INSERT INTO drift_accounts (email, login_hash, login_expires)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO UPDATE SET login_hash = $2, login_expires = $3`,
    [email, sha256(token), expires]
  );
  return { email, token };
}

// Single use: the hash is cleared on redemption, so a link in a forwarded
// email or a browser history cannot be replayed.
async function redeemLoginToken(db, emailRaw, token) {
  const email = normalizeEmail(emailRaw);
  if (!email || !token) return null;
  const r = await db.query(
    `UPDATE drift_accounts
        SET login_hash = NULL, login_expires = NULL, last_login_at = now()
      WHERE email = $1 AND login_hash = $2 AND login_expires > now()
      RETURNING id, email, plan`,
    [email, sha256(token)]
  );
  return r.rows[0] || null;
}

module.exports = {
  init, issueLoginToken, redeemLoginToken, currentAccount,
  setSession, clearSession, validEmail, normalizeEmail, sessionsAvailable, COOKIE
};
