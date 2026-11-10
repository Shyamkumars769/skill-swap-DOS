// auth.js - login sessions, cookies and password rules.
// How login works:
//   1. After a correct password, the server creates a random token.
//   2. The token goes to the browser in an HttpOnly cookie (JavaScript cannot read it).
//   3. The database stores only a HASH of the token, in the "sessions" table.
//   4. Every API call sends the cookie back, and requireAuth finds the user from it.
const crypto = require('crypto');
const db = require('./db');

const COOKIE = 'sid';
const SESSION_DAYS = 7;
const SECURE = process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === 'on';

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function setCookie(res, value, maxAgeSeconds) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}` +
    (SECURE ? '; Secure' : ''));
}

// Start a new login session for a user
async function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.run(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES (?, ?, datetime('now', '+${SESSION_DAYS} days'))`,
    [hashToken(token), userId]);
  setCookie(res, token, SESSION_DAYS * 24 * 60 * 60);
}

// End the current session (logout)
async function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE];
  if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', [hashToken(token)]);
  setCookie(res, '', 0);
}

// Middleware: only let logged-in users through. Puts the user in req.user.
async function requireAuth(req, res, next) {
  try {
    const token = parseCookies(req)[COOKIE];
    const user = token && await db.get(
      `SELECT u.id, u.name, u.email
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > datetime('now')`,
      [hashToken(token)]);
    if (!user) return res.status(401).json({ error: 'Please log in' });
    req.user = user;
    req.sessionHash = hashToken(token);
    next();
  } catch (err) {
    next(err);
  }
}

// Returns an error message, or null if the password is acceptable
function passwordError(pw) {
  if (typeof pw !== 'string' || !pw) return 'Password is required';
  if (pw.length < 8) return 'Password must be at least 8 characters';
  if (Buffer.byteLength(pw) > 72) return 'Password is too long (72 bytes at most)';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password needs at least one letter and one number';
  return null;
}

// Lets async route handlers send their errors to Express instead of crashing
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

module.exports = { requireAuth, createSession, destroySession, passwordError, hashToken, wrap };
