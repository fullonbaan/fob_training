// api/admin-session.js — admin sign-in / sign-out.
//
//   POST   {password}  → checks against ADMIN_PASSWORD; on success sets the HttpOnly session cookie
//   GET                → { admin: true|false }  (is the current session valid?)
//   DELETE             → clears the session cookie (sign out)

const { isAdmin, adminConfigured, checkPassword, issueSession, clearSession, sameOrigin } = require('./_auth');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (req.method === 'GET') return res.status(200).json({ admin: isAdmin(req) });

  if (req.method === 'DELETE') {
    clearSession(res);
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'POST') {
    if (!sameOrigin(req)) return res.status(403).json({ error: 'Cross-site sign-in is not allowed.' });
    if (!adminConfigured()) return res.status(503).json({ error: 'Admin access is not configured (set ADMIN_PASSWORD in Vercel).' });
    const password = req.body && req.body.password;
    if (!checkPassword(password)) {
      await new Promise(r => setTimeout(r, 800)); // slow down password guessing
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    issueSession(res);
    return res.status(200).json({ ok: true });
  }

  res.setHeader('Allow', 'GET, POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed.' });
};
