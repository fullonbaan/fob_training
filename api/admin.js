// api/admin.js — serves /admin (see vercel.json rewrite).
//
// Not signed in → a small sign-in page (no dashboard code at all).
// Signed in     → the dashboard from admin/dashboard.html, which is NOT part of the public
//                 build (_site), so it can't be fetched any other way.

const fs = require('fs');
const path = require('path');
const { isAdmin, adminConfigured } = require('./_auth');
const materials = require('../src/_data/materials.js');

let dashboardHtml = null;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function dashboard() {
  if (!dashboardHtml) {
    const opts = list => (list || []).map(v => `<option>${esc(v)}</option>`).join('');
    dashboardHtml = fs.readFileSync(path.join(__dirname, '..', 'admin', 'dashboard.html'), 'utf8')
      .replace('<!--MATERIALS_OPTIONS-->', opts(materials.list))
      .replace('<!--FORMATS_OPTIONS-->', opts(materials.formats));
  }
  return dashboardHtml;
}

function signInPage(note) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Admin sign-in | FullOnBaan Training</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{background:#060f1e;color:#f0e8d8;font-family:"Work Sans",system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;padding:16px}
  .card{background:#0a1630;border:1px solid rgba(246,188,104,0.25);border-radius:20px;padding:36px 28px;max-width:380px;width:100%;text-align:center}
  h1{color:#f6bc68;font-family:"Noto Serif",Georgia,serif;font-size:20px;margin:0 0 6px}
  p{color:rgba(212,196,178,0.6);font-size:13px;margin:0 0 22px}
  input{width:100%;padding:12px 14px;background:rgba(255,255,255,0.04);border:1px solid rgba(246,188,104,0.2);border-radius:10px;color:#f0e8d8;font-size:14px;margin-bottom:10px}
  button{width:100%;padding:12px;background:linear-gradient(135deg,#f6bc68,#ba8738);color:#06132a;font-weight:700;border:none;border-radius:10px;cursor:pointer;font-size:15px}
  button[disabled]{opacity:.6;cursor:wait}
  #err{color:#f87171;font-size:12px;min-height:16px;margin:0 0 10px}
  a{color:rgba(212,196,178,0.5);font-size:12px;display:inline-block;margin-top:14px;text-decoration:none}
</style></head>
<body>
<form class="card" id="f" autocomplete="on">
  <h1>LN Training Admin</h1>
  <p>FullOnBaan &middot; Payments &amp; feedback</p>
  <input type="text" name="username" value="admin" autocomplete="username" hidden>
  <input type="password" id="pw" name="password" placeholder="Admin password" autocomplete="current-password" required autofocus>
  <div id="err">${esc(note || '')}</div>
  <button id="b" type="submit">Sign in &rarr;</button>
  <a href="/">&larr; Back to site</a>
</form>
<script>
document.getElementById('f').addEventListener('submit', async function (e) {
  e.preventDefault();
  var b = document.getElementById('b'), err = document.getElementById('err');
  b.disabled = true; err.textContent = '';
  try {
    var r = await fetch('/api/admin-session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ password: document.getElementById('pw').value }) });
    if (r.ok) { location.reload(); return; }
    var d = {}; try { d = await r.json(); } catch (x) {}
    err.textContent = d.error || ('Sign-in failed (' + r.status + ')');
  } catch (x) { err.textContent = 'Network error: ' + x.message; }
  b.disabled = false;
  document.getElementById('pw').select();
});
</script>
</body></html>`;
}

module.exports = function handler(req, res) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'same-origin');

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    return res.status(405).send('Method not allowed');
  }
  if (!adminConfigured()) return res.status(503).send(signInPage('Admin access is not configured (set ADMIN_PASSWORD in Vercel).'));
  if (!isAdmin(req)) return res.status(200).send(signInPage());
  return res.status(200).send(dashboard());
};
