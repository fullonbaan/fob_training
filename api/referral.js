// api/referral.js — Sales-partner (referral) programme API. One function, several actions.
//
// Public (website):
//   POST ?action=click     {code, page}          → logs one unique click for an active partner (always 200)
//   GET  ?action=validate&code=RAJ10            → { valid, by }  (checkout box feedback; rate-limited)
// Partner dashboard (/partners) — HttpOnly session cookie `fob_ref_s`:
//   POST ?action=login     {email, code}         POST ?action=logout       POST ?action=resend {email}
//   GET  ?action=me                              → partner, link, clicks, totals, sales (customers masked)
//   POST ?action=claim     {customerName, customerEmail, productKey, amount, currency, paymentRef, note}
// Admin (/referrals-admin) — Bearer ADMIN_API_TOKEN or the /admin sign-in cookie:
//   GET  ?action=a-list                          → every partner + clicks + totals
//   GET  ?action=a-sales[&code=RAJ10]            → commission ledger
//   POST ?action=a-create  {name, email, mobile, code?, commissionPct, payout, notes, notify}
//   POST ?action=a-update  {code, name?, mobile?, commissionPct?, payout?, notes?, status?}
//   POST ?action=a-reset-code {code, notify}
//   POST ?action=a-sale    {code, id, op: approve|void|reopen|edit, base?, pct?, reason?}
//   POST ?action=a-payout  {code, ids[], payoutRef}       → approved lines → paid
//   POST ?action=a-manual  {code, …same fields as claim}  → adds an approved line (offline deal)
const H = require('./_lib/http');
const C = require('./_lib/crypto');
const auth = require('./_lib/auth');
const catalog = require('./_lib/catalog');
const R = require('./_lib/referrals');
const RL = require('./_lib/ratelimit');

const COOKIE = 'fob_ref_s';
const SESSION_DAYS = 7, MAX_FAILS = 5, LOCK_MIN = 15, RESEND_GAP_MS = 2 * 60 * 1000;

function setCookie(res, value, maxAgeSec) {
  res.setHeader('Set-Cookie', COOKIE + '=' + value + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + maxAgeSec);
}
async function currentPartner(req) {
  const p = C.verifySession(H.parseCookies(req)[COOKIE]);
  if (!p || !p.rp) return null;                         // member sessions (p.h) are not partner sessions
  const rec = await R.getPartner(p.rp);
  if (!rec || rec.status !== 'active' || rec.sessionVersion !== p.v) return null;
  return rec;
}
const productList = () => Object.keys(catalog.PRODUCTS).map(k => ({ key: k, name: catalog.PRODUCTS[k].name }));

// What a partner sees about their own sales: no customer emails, no internal ids beyond the order ref.
function partnerSale(s) {
  return { id: s.id, kind: s.kind, at: s.at, product: s.product, orderRef: s.orderRef, customer: s.customer, currency: s.currency,
    paid: s.paid, base: s.base, pct: s.pct, commission: s.commission, status: s.status, holdUntil: s.holdUntil,
    paidAt: s.paidAt, payoutRef: s.payoutRef, voidReason: s.voidReason, note: s.note || '' };
}

async function dashboard(p, siteUrl) {
  const [sales, clicks] = await Promise.all([R.listSales(p.code), R.getClicks(p.code)]);
  return {
    partner: { code: p.code, name: p.name, email: p.email, commissionPct: p.commissionPct, payout: p.payout, since: p.createdAt },
    link: R.refLink(siteUrl, p.code), holdDays: R.HOLD_DAYS(),
    clicks: { total: clicks.total || 0, thisMonth: (clicks.months || {})[new Date().toISOString().slice(0, 7)] || 0, months: clicks.months || {} },
    totals: R.totals(sales), sales: sales.map(partnerSale), products: productList()
  };
}

// ── Partner actions ───────────────────────────────────────────────────
async function login(req, res) {
  const b = await H.readJson(req);
  const email = C.normEmail(b.email), code = String(b.code || '');
  const generic = { error: 'That email and access code don’t match. Use the code from your welcome email, or request a new one.' };
  if (!C.isEmail(email) || C.normCode(code).length < 8) return H.send(res, 400, generic);
  if (!(await RL.allow('reflogin', H.clientIp(req), 30, 900))) return H.send(res, 429, { error: 'Too many sign-in attempts. Please wait 15 minutes.' });
  const rec = await R.getPartnerByEmail(email);
  if (rec && rec.failed && rec.failed.lockedUntil > Date.now()) { await C.verifyCode(code, null); return H.send(res, 429, { error: 'Too many attempts. Please wait ' + LOCK_MIN + ' minutes or request a new code.' }); }
  const ok = await C.verifyCode(code, rec && rec.codeHash);
  if (!rec || !ok || rec.status !== 'active') {
    if (rec) await R.updatePartner(rec.code, (m) => {
      m.failed = m.failed || { count: 0, lockedUntil: 0 }; m.failed.count = (m.failed.count || 0) + 1;
      if (m.failed.count >= MAX_FAILS) { m.failed.lockedUntil = Date.now() + LOCK_MIN * 60000; m.failed.count = 0; }
      return m;
    });
    return H.send(res, 401, generic);
  }
  const saved = await R.updatePartner(rec.code, (m) => { m.failed = { count: 0, lockedUntil: 0 }; m.lastLoginAt = new Date().toISOString(); return m; });
  setCookie(res, C.signSession({ rp: saved.code, v: saved.sessionVersion, exp: Date.now() + SESSION_DAYS * 864e5 }), SESSION_DAYS * 86400);
  return H.send(res, 200, { ok: true });
}

async function resend(req, res) {
  const b = await H.readJson(req);
  const email = C.normEmail(b.email);
  const generic = { ok: true, message: 'If that email belongs to a FullOnBaan partner, a new access code is on its way.' };
  if (!C.isEmail(email)) return H.send(res, 400, { error: 'Please enter a valid email.' });
  if (!(await RL.allow('refresend', H.clientIp(req), 6, 3600))) return H.send(res, 200, generic);
  const rec = await R.getPartnerByEmail(email);
  if (!rec || rec.status !== 'active' || (Date.now() - (rec.lastResendAt || 0)) < RESEND_GAP_MS) return H.send(res, 200, generic);
  const code = C.newAccessCode(), hash = await C.hashCode(code);
  const saved = await R.updatePartner(rec.code, (m) => {
    m.codeHash = hash; m.codeIssuedAt = new Date().toISOString(); m.sessionVersion = (m.sessionVersion || 1) + 1;
    m.lastResendAt = Date.now(); m.failed = { count: 0, lockedUntil: 0 }; return m;
  });
  await R.welcomeEmail(saved, code, H.siteUrl(req), true);
  return H.send(res, 200, generic);
}

// ── Admin actions ─────────────────────────────────────────────────────
async function adminList(res) {
  const keys = (await require('./_lib/r2').listKeys('referrals/partners/')).filter(k => k.endsWith('.json'));
  const all = await R.listSales();
  const out = [];
  for (const k of keys) {
    const p = await R.getPartner(k.slice('referrals/partners/'.length, -5));
    if (!p) continue;
    const c = await R.getClicks(p.code);
    const mine = all.filter(s => s.code === p.code);
    out.push(Object.assign(R.publicPartner(p), { clicks: c.total || 0, clicksThisMonth: (c.months || {})[new Date().toISOString().slice(0, 7)] || 0, totals: R.totals(mine) }));
  }
  out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return H.send(res, 200, { partners: out, products: productList(), holdDays: R.HOLD_DAYS(), auth: 'ok' });
}

async function adminPost(action, b, req, res) {
  const siteUrl = H.siteUrl(req);
  if (action === 'a-create') {
    const r = await R.createPartner(b);
    let emailed = false;
    if (b.notify !== false) { try { emailed = await R.welcomeEmail(r.partner, r.accessCode, siteUrl, false); } catch (e) { console.error('welcome email failed', e.message); } }
    return H.send(res, 200, { ok: true, partner: R.publicPartner(r.partner), accessCode: r.accessCode, link: R.refLink(siteUrl, r.partner.code), emailed });
  }
  const code = R.normCode(b.code);
  if (!code) return H.send(res, 400, { error: 'Partner code required' });

  if (action === 'a-update') {
    const pct = b.commissionPct !== undefined ? R.normPct(b.commissionPct) : undefined;
    if (pct === null) return H.send(res, 400, { error: 'Commission % out of range' });
    const p = await R.updatePartner(code, (m) => {
      if (b.name !== undefined && String(b.name).trim()) m.name = String(b.name).trim().slice(0, 120);
      if (b.mobile !== undefined) m.mobile = String(b.mobile).replace(/[^\d+ ]/g, '').slice(0, 20);
      if (b.payout !== undefined) m.payout = String(b.payout).replace(/[<>]/g, ' ').slice(0, 300);
      if (b.notes !== undefined) m.notes = String(b.notes).replace(/[<>]/g, ' ').slice(0, 500);
      if (pct !== undefined && pct !== m.commissionPct) { m.commissionPct = pct; m.rateHistory = (m.rateHistory || []).concat([{ pct, from: new Date().toISOString() }]); }
      if (b.status === 'active' || b.status === 'disabled') { if (m.status !== b.status && b.status === 'disabled') m.sessionVersion = (m.sessionVersion || 1) + 1; m.status = b.status; }
      return m;
    });
    if (!p) return H.send(res, 404, { error: 'No such partner' });
    return H.send(res, 200, { ok: true, partner: R.publicPartner(p) });
  }
  if (action === 'a-reset-code') {
    const ac = C.newAccessCode(), hash = await C.hashCode(ac);
    const p = await R.updatePartner(code, (m) => { m.codeHash = hash; m.codeIssuedAt = new Date().toISOString(); m.sessionVersion = (m.sessionVersion || 1) + 1; m.failed = { count: 0, lockedUntil: 0 }; return m; });
    if (!p) return H.send(res, 404, { error: 'No such partner' });
    if (b.notify !== false) { try { await R.welcomeEmail(p, ac, siteUrl, true); } catch (e) { console.error(e.message); } }
    return H.send(res, 200, { ok: true, accessCode: ac });
  }
  if (action === 'a-manual') {
    const p = await R.getPartner(code);
    if (!p) return H.send(res, 404, { error: 'No such partner' });
    return H.send(res, 200, { ok: true, sale: await R.createClaim(p, b, 'admin') });
  }
  if (action === 'a-sale') {
    const op = String(b.op || '');
    const now = new Date().toISOString();
    let err = null;
    const s = await R.updateSale(code, b.id, (cur) => {
      const eff = R.effectiveStatus(cur);
      const log = (what) => { cur.history = (cur.history || []).concat([{ at: now, by: 'admin', what }]).slice(-30); };
      if (op === 'approve') { if (eff !== 'review' && eff !== 'pending') { err = 'Only claims under review or lines in the hold period can be approved'; return null; } cur.status = 'approved'; cur.holdUntil = now; log('approved'); }
      else if (op === 'void') { if (eff === 'paid') { err = 'Already paid — reopen it first if you reversed the payout'; return null; } cur.status = 'void'; cur.voidReason = String(b.reason || 'Voided by admin').slice(0, 200); log('void: ' + cur.voidReason); }
      else if (op === 'reopen') { cur.status = 'approved'; cur.paidAt = null; cur.payoutRef = ''; cur.voidReason = ''; log('reopened'); }
      else if (op === 'edit') {
        if (eff === 'paid') { err = 'Paid lines cannot be edited'; return null; }
        if (b.base !== undefined && b.base !== '') { const v = Math.round(Number(b.base) * 100) / 100; if (!(v >= 0)) { err = 'Bad amount'; return null; } cur.base = v; }
        if (b.pct !== undefined && b.pct !== '') { const v = R.normPct(b.pct); if (v === null) { err = 'Bad %'; return null; } cur.pct = v; }
        cur.commission = Math.round(cur.base * cur.pct) / 100; log('edited: base ' + cur.base + ' @ ' + cur.pct + '%');
      } else { err = 'Unknown op'; return null; }
      return cur;
    });
    if (err) return H.send(res, 400, { error: err });
    if (!s) return H.send(res, 404, { error: 'No such sale' });
    return H.send(res, 200, { ok: true, sale: R.view(s) });
  }
  if (action === 'a-payout') {
    const ids = Array.isArray(b.ids) ? b.ids.slice(0, 500) : [];
    const ref = String(b.payoutRef || '').replace(/[<>]/g, ' ').trim().slice(0, 80);
    if (!ids.length) return H.send(res, 400, { error: 'Pick at least one approved line' });
    if (!ref) return H.send(res, 400, { error: 'Enter the payout reference (UTR / transaction id)' });
    const now = new Date().toISOString(); let paid = 0; const skipped = [];
    for (const id of ids) {
      let ok = false;
      await R.updateSale(code, id, (cur) => {
        if (R.effectiveStatus(cur) !== 'approved') return null;
        cur.status = 'paid'; cur.paidAt = now; cur.payoutRef = ref;
        cur.history = (cur.history || []).concat([{ at: now, by: 'admin', what: 'paid · ' + ref }]).slice(-30); ok = true; return cur;
      });
      if (ok) paid++; else skipped.push(id);
    }
    return H.send(res, 200, { ok: true, paid, skipped });
  }
  return H.send(res, 404, { error: 'Unknown action' });
}

module.exports = async function handler(req, res) {
  const action = String(H.getQuery(req).action || '');
  try {
    // ── Admin ──
    if (action.startsWith('a-')) {
      if (!auth.isAdmin(req)) { await new Promise(r => setTimeout(r, 400)); return H.send(res, 401, { error: 'Unauthorized' }); }
      if (req.method === 'GET' && action === 'a-list') return await adminList(res);
      if (req.method === 'GET' && action === 'a-sales') { const code = H.getQuery(req).code; return H.send(res, 200, { sales: await R.listSales(code ? R.normCode(code) : null) }); }
      if (req.method !== 'POST') return H.send(res, 405, { error: 'Method not allowed' });
      return await adminPost(action, await H.readJson(req), req, res);
    }
    // ── Public / partner ──
    if (req.method === 'GET' && action === 'validate') {
      const code = R.normCode(H.getQuery(req).code);
      if (!code) return H.send(res, 200, { valid: false });
      if (!(await RL.allow('refvalidate', H.clientIp(req), 60, 3600))) return H.send(res, 429, { error: 'Too many checks' });
      const p = await R.activePartner(code);
      return H.send(res, 200, p ? { valid: true, code: p.code, by: String(p.name || '').split(/\s+/)[0] } : { valid: false });
    }
    if (req.method === 'GET' && action === 'me') {
      const p = await currentPartner(req);
      if (!p) return H.send(res, 401, { error: 'Not signed in.' });
      return H.send(res, 200, await dashboard(p, H.siteUrl(req)));
    }
    if (req.method !== 'POST') return H.send(res, 405, { error: 'Method not allowed.' });
    if (H.isCrossSite(req)) return H.send(res, 403, { error: 'Cross-site request blocked.' });
    if (!/application\/json/.test(String(req.headers['content-type'] || ''))) return H.send(res, 415, { error: 'JSON required.' });
    if (action === 'click') {
      const b = await H.readJson(req);
      try { await R.recordClick(R.normCode(b.code), H.clientIp(req)); } catch (e) { console.warn('ref click not logged', e.message); }
      return H.send(res, 200, { ok: true });
    }
    if (action === 'login') return await login(req, res);
    if (action === 'resend') return await resend(req, res);
    if (action === 'logout') { setCookie(res, '', 0); return H.send(res, 200, { ok: true }); }
    if (action === 'claim') {
      const p = await currentPartner(req);
      if (!p) return H.send(res, 401, { error: 'Not signed in.' });
      if (!(await RL.allow('refclaim', p.code, 30, 86400))) return H.send(res, 429, { error: 'Daily limit for reported sales reached — contact support@fullonbaan.com.' });
      return H.send(res, 200, { ok: true, sale: partnerSale(await R.createClaim(p, await H.readJson(req), 'partner')) });
    }
    return H.send(res, 404, { error: 'Unknown action.' });
  } catch (e) {
    if (e.status && e.status < 500) return H.send(res, e.status, { error: e.message });
    console.error('referral api error', action, e);
    return H.send(res, 500, { error: action.startsWith('a-') ? e.message : 'Something went wrong. Please try again in a moment.' });
  }
};
