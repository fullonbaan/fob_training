// api/_auth.js — shared admin check for the API routes (underscore = not a route on Vercel).
// The admin password lives ONLY in the Vercel env var ADMIN_PASSWORD; browsers send what
// the admin typed in the `x-admin-key` header and the server compares it here.

const crypto = require('crypto');

function adminConfigured() {
  return !!(process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim());
}

function isAdmin(req) {
  if (!adminConfigured()) return false;
  const given = req.headers['x-admin-key'];
  if (typeof given !== 'string' || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD.trim()).digest();
  return crypto.timingSafeEqual(a, b);
}

// Sends a 401/503 and returns false when the caller isn't the admin.
function requireAdmin(req, res) {
  if (!adminConfigured()) {
    res.status(503).json({ error: 'Admin access is not configured (set ADMIN_PASSWORD in Vercel).' });
    return false;
  }
  if (!isAdmin(req)) {
    res.status(401).json({ error: 'Admin password required.' });
    return false;
  }
  return true;
}

module.exports = { isAdmin, requireAdmin, adminConfigured };
