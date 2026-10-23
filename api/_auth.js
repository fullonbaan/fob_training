// api/_auth.js — shared admin session check for the API routes (underscore = not a route on Vercel).
//
// How admin auth works now:
//   1. /admin (api/admin.js) shows a sign-in form. It POSTs the password to /api/admin-session.
//   2. The server compares it with the Vercel env var ADMIN_PASSWORD and, if it matches, sets an
//      HttpOnly + Secure + SameSite=Strict cookie `fob_admin` holding a signed, expiring token.
//      Page JavaScript can't read that cookie, and the password is never kept in the browser.
//   3. Every admin-only API call (and the /admin page itself) re-verifies the cookie signature here.
//
// To sign every admin out at once: change ADMIN_PASSWORD, or set/rotate ADMIN_SESSION_SECRET.

const crypto = require('crypto');

const COOKIE  = 'fob_admin';
const MAX_AGE = 8 * 60 * 60; // seconds — session lasts 8 hours

function adminConfigured() {
  return !!(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim());
}

function signingKey() {
  return crypto.createHash('sha256')
    .update('fob-admin-session|' + (process.env.ADMIN_SESSION_SECRET || '') + '|' + process.env.ADMIN_PASSWORD.trim())
    .digest();
}

function sign(payload) {
  return crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
}

function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

function checkPassword(given) {
  if (!adminConfigured() || typeof given !== 'string' || !given) return false;
  return safeEqual(given, process.env.ADMIN_PASSWORD.trim());
}

function cookieAttrs(maxAge) {
  return `Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

function issueSession(res) {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE;
  const payload = exp + '.' + crypto.randomBytes(12).toString('base64url');
  res.setHeader('Set-Cookie', `${COOKIE}=${payload}.${sign(payload)}; ${cookieAttrs(MAX_AGE)}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// Requests that change data must come from our own pages (defence in depth on top of SameSite=Strict).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin GETs and non-browser clients send no Origin
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  try { return new URL(origin).host === host; } catch (e) { return false; }
}

function isAdmin(req) {
  if (!adminConfigured()) return false;
  const method = (req.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !sameOrigin(req)) return false;
  const parts = readCookie(req, COOKIE).split('.');
  if (parts.length !== 3) return false;
  const [exp, nonce, sig] = parts;
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, sign(exp + '.' + nonce));
}

// Sends a 401/503 and returns false when the caller isn't the admin.
function requireAdmin(req, res) {
  if (!adminConfigured()) {
    res.status(503).json({ error: 'Admin access is not configured (set ADMIN_PASSWORD in Vercel).' });
    return false;
  }
  if (!isAdmin(req)) {
    res.status(401).json({ error: 'Admin sign-in required.' });
    return false;
  }
  return true;
}

module.exports = { isAdmin, requireAdmin, adminConfigured, checkPassword, issueSession, clearSession, sameOrigin };
