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
<script>(function(){var t='dark';try{var s=localStorage.getItem('fob_theme');if(s==='light'||s==='dark')t=s;}catch(e){}document.documentElement.classList.add(t);})();</script>
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
  html.light body{background:#f6f2ea;color:#1b2333}
  html.light .card{background:#fff;border-color:rgba(143,98,22,0.25);box-shadow:0 10px 30px rgba(27,35,51,.08)}
  html.light h1{color:#8f6216} html.light p,html.light a{color:rgba(45,40,32,.65)}
  html.light input{background:#fff;border-color:rgba(143,98,22,.3);color:#1b2333} html.light #err{color:#b91c1c}
  .tt{position:fixed;top:14px;right:14px}
  .theme-btn{width:36px;height:36px;flex:0 0 36px;border-radius:999px;border:1px solid rgba(246,188,104,.3);background:transparent;color:#f6bc68;cursor:pointer;display:inline-grid;place-items:center;padding:0;vertical-align:middle}.theme-btn:hover{background:rgba(246,188,104,.1)}.theme-btn svg{width:17px;height:17px}.theme-btn .i-moon{display:none}html.light .theme-btn .i-sun{display:none}html.light .theme-btn .i-moon{display:block}
  html.light .theme-btn{color:#8f6216;border-color:rgba(143,98,22,.3)}
  a{color:rgba(212,196,178,0.5);font-size:12px;display:inline-block;margin-top:14px;text-decoration:none}
</style></head>
<body>
<div class="tt"><button type="button" class="theme-btn" data-theme-toggle title="Switch theme" aria-label="Switch theme"><svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8"/></svg><svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7Z"/></svg></button></div>
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
<script>
/* Light / dark switch — same preference key as the main site ("fob_theme"), so the choice follows you across pages. */
(function(){
  function sync(){var l=document.documentElement.classList.contains('light'),t=l?'Switch to dark mode':'Switch to light mode';
    Array.prototype.forEach.call(document.querySelectorAll('[data-theme-toggle]'),function(b){b.title=t;b.setAttribute('aria-label',t);});}
  document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('[data-theme-toggle]');if(!b)return;
    var h=document.documentElement,l=!h.classList.contains('light');h.classList.toggle('light',l);h.classList.toggle('dark',!l);
    try{localStorage.setItem('fob_theme',l?'light':'dark');}catch(_){}sync();});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',sync);else sync();
})();
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
