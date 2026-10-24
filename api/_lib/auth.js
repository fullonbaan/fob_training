// api/_lib/auth.js — who may use the admin endpoints (/api/member-admin, /api/payments, …).
// Either:
//   • Authorization: Bearer <ADMIN_API_TOKEN>   (Vercel env, 32+ random characters) — /members-admin
//   • the existing /admin sign-in cookie (ADMIN_PASSWORD session, see api/_auth.js)
const C = require('./crypto');
const adminSession = require('../_auth');

function hasToken(req) {
  const t = process.env.ADMIN_API_TOKEN;
  if (!t || t.length < 32) return false;
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') && C.safeEqual(h.slice(7).trim(), t);
}
function isAdmin(req) {
  if (hasToken(req)) return true;
  try { return adminSession.isAdmin(req); } catch (e) { return false; }
}

// Use at the top of a handler:  if (!(await requireAdmin(req, res))) return;
async function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  await new Promise(r => setTimeout(r, 400));            // slow down guessing
  res.statusCode = 401;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify({ error: 'Unauthorized' }));
  return false;
}

module.exports = { isAdmin, hasToken, requireAdmin };
