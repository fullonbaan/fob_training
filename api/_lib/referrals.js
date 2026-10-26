// api/_lib/referrals.js — sales-partner (referral / affiliate) programme.
//
// How a sale is attributed (industry-standard "last referrer wins", 30-day window):
//   1. A partner shares   https://training.fullonbaan.com/?ref=CODE   (any page works, e.g. /pricing?ref=CODE)
//      The page stores CODE in a first-party cookie `fob_ref` for 30 days and logs one click.
//   2. At checkout the "Referral code" box is pre-filled from that cookie; a buyer can also type a
//      code a partner gave them (WhatsApp / call / LinkedIn). What is in the box when they pay wins.
//   3. /api/checkout validates the code SERVER-SIDE (active partner, not the buyer's own email) and
//      stamps it on the Razorpay order notes (`ref`) — the browser can't attach a code to a paid order later.
//   4. When the order is paid (verify OR webhook), settle.js calls recordSale() → one commission line
//      per order, created exactly once (conditional write), with the partner's % SNAPSHOTTED at that moment.
//
// Commission = partner % × the price EXCLUDING GST (taxes are never commissionable).
// Lifecycle:  review (partner-reported offline sale, waiting for you)
//          →  pending  (paid online; inside the 7-day money-back window — REF_HOLD_DAYS)
//          →  approved (payable — automatic once the hold ends, or when you approve a claim)
//          →  paid     (you settled it; payout reference / UTR recorded)
//             void     (refunded, self-referral, duplicate, rejected claim …)
//
// Storage (private R2 bucket, next to members/):
//   referrals/partners/<CODE>.json           partner record (hashed panel access code, % , payout details)
//   referrals/byemail/<sha256(email)>.json   { code }  — one partner per email
//   referrals/sales/<CODE>/<id>.json         one commission line per order / claim
//   referrals/clicks/<CODE>.json             { total, months: { '2026-10': n }, lastAt }
const crypto = require('crypto');
const r2 = require('./r2');
const C = require('./crypto');
const catalog = require('./catalog');
const mail = require('./email');
const RL = require('./ratelimit');

const P = 'referrals/';
const partnerKey = (code) => P + 'partners/' + code + '.json';
const emailKey = (email) => P + 'byemail/' + C.emailHash(email) + '.json';
const saleKey = (code, id) => P + 'sales/' + code + '/' + id + '.json';
const clicksKey = (code) => P + 'clicks/' + code + '.json';
const HOLD_DAYS = () => Number(process.env.REF_HOLD_DAYS == null || process.env.REF_HOLD_DAYS === '' ? 7 : process.env.REF_HOLD_DAYS);
const MAX_PCT = () => Number(process.env.REF_MAX_PCT || 60);
const STATUSES = ['review', 'pending', 'approved', 'paid', 'void'];
const r2d = (x) => Math.round(Number(x) * 100) / 100;
const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, n || 200);

// "raj 10" → "RAJ10".  3–20 chars, letters / digits / dash, starts with a letter or digit.
function normCode(c) {
  const s = String(c || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
  return /^[A-Z0-9][A-Z0-9-]{2,19}$/.test(s) ? s : '';
}
function normPct(p) {
  const n = Number(p);
  if (!isFinite(n) || n < 0 || n > MAX_PCT()) return null;
  return r2d(n);
}
function maskEmail(e) {
  const [u, d] = String(e || '').split('@');
  if (!d) return '';
  return (u.slice(0, Math.min(2, Math.max(1, u.length - 1))) + '***@' + d).toLowerCase();
}
function ym(t) { return new Date(t).toISOString().slice(0, 7); }

// Optimistic-concurrency read-modify-write (same pattern as members.updateMember).
async function updateJson(key, mutator, create) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const cur = await r2.getJson(key);
    if (!cur && !create) return null;
    const rec = cur ? cur.data : null;
    const next = await mutator(rec ? JSON.parse(JSON.stringify(rec)) : null);
    if (!next) return rec;
    next.updatedAt = new Date().toISOString();
    let ok = await r2.putJson(key, next, cur ? { ifMatch: r2.quoteEtag(cur.etag) } : { ifNoneMatch: '*' });
    if (!ok && cur) {
      const now = await r2.headObject(key);
      if (now && r2.sameEtag(now.etag, cur.etag)) ok = await r2.putJson(key, next);   // R2 spurious 412
    }
    if (ok) return next;
    await new Promise(r => setTimeout(r, 100 + Math.random() * 250));
  }
  throw new Error('Could not save ' + key + ' (too much contention) — please retry.');
}

// ── Partners ──────────────────────────────────────────────────────────
async function getPartner(code) {
  code = normCode(code); if (!code) return null;
  const o = await r2.getJson(partnerKey(code));
  return o ? o.data : null;
}
async function getPartnerByEmail(email) {
  if (!C.isEmail(C.normEmail(email))) return null;
  const ix = await r2.getJson(emailKey(email));
  if (!ix || !ix.data || !ix.data.code) return null;
  const p = await getPartner(ix.data.code);
  return p && p.email === C.normEmail(email) ? p : null;
}
async function activePartner(code) {
  const p = await getPartner(code);
  return p && p.status === 'active' ? p : null;
}
function updatePartner(code, mutator) { return updateJson(partnerKey(normCode(code)), mutator); }

function suggestCode(name) {
  const base = String(name || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8) || 'FOB';
  return base + String(crypto.randomInt(10, 100));
}

// Admin onboarding. Returns { partner, accessCode } — the plaintext access code exists only here.
async function createPartner(o) {
  const email = C.normEmail(o.email);
  const name = clip(o.name, 120);
  const code = normCode(o.code || suggestCode(name));
  const pct = normPct(o.commissionPct);
  if (!name) throw httpErr(400, 'Name is required.');
  if (!C.isEmail(email)) throw httpErr(400, 'A valid email is required.');
  if (!code) throw httpErr(400, 'Referral code must be 3–20 letters / digits (dash allowed), e.g. RAJ10.');
  if (pct === null) throw httpErr(400, 'Commission % must be between 0 and ' + MAX_PCT() + '.');
  const accessCode = C.newAccessCode();
  const now = new Date().toISOString();
  const rec = {
    v: 1, code, name, email, mobile: clip(String(o.mobile || '').replace(/[^\d+ ]/g, ''), 20),
    commissionPct: pct, rateHistory: [{ pct, from: now }],
    payout: clip(o.payout, 300), notes: clip(o.notes, 500),
    status: 'active', createdAt: now, createdBy: 'admin',
    codeHash: await C.hashCode(accessCode), codeIssuedAt: now, sessionVersion: 1,
    failed: { count: 0, lockedUntil: 0 }, lastResendAt: 0, lastLoginAt: null
  };
  if (!(await r2.putJson(partnerKey(code), rec, { ifNoneMatch: '*' }))) throw httpErr(409, 'Referral code ' + code + ' is already taken — choose another.');
  if (!(await r2.putJson(emailKey(email), { code }, { ifNoneMatch: '*' }))) {
    const other = await getPartnerByEmail(email);
    if (other) { await r2.deleteObject(partnerKey(code)); throw httpErr(409, email + ' is already a partner (code ' + other.code + ').'); }
    await r2.putJson(emailKey(email), { code });            // stale index (partner deleted) → take it over
  }
  return { partner: rec, accessCode };
}

function httpErr(status, msg) { const e = new Error(msg); e.status = status; return e; }

function publicPartner(p) {
  if (!p) return null;
  const o = Object.assign({}, p);
  delete o.codeHash; delete o.failed; delete o.lastResendAt;
  return o;
}

// ── Clicks ────────────────────────────────────────────────────────────
// Counts unique visits: one per (code, visitor network) per day.
async function recordClick(code, ip) {
  const p = await activePartner(code);
  if (!p) return false;
  if (!(await RL.allow('refclick', code + '|' + ip, 1, 86400))) return false;
  await updateJson(clicksKey(p.code), (c) => {
    c = c || { total: 0, months: {} };
    const m = ym(Date.now());
    c.total = (c.total || 0) + 1; c.months[m] = (c.months[m] || 0) + 1; c.lastAt = new Date().toISOString();
    return c;
  }, true);
  return true;
}
async function getClicks(code) { const o = await r2.getJson(clicksKey(code)); return o ? o.data : { total: 0, months: {} }; }

// ── Checkout: which partner (if any) does this order belong to? ───────
async function resolveForCheckout(rawCode, buyerEmail) {
  const code = normCode(rawCode);
  if (!code) return null;
  const p = await activePartner(code);
  if (!p) return null;
  if (p.email === C.normEmail(buyerEmail)) return { code: p.code, self: true };  // no commission on own purchases
  return { code: p.code, firstName: String(p.name || '').split(/\s+/)[0] };
}

// ── Sales / commission lines ──────────────────────────────────────────
function baseOf(productKey, currency, paidMinor, at) {
  const q = productKey ? catalog.quote(productKey, currency, { at }) : null;
  if (q && q.amountMinor === Number(paidMinor)) return q.base;
  const paid = Number(paidMinor) / 100;
  return r2d(currency === 'INR' ? paid / (1 + 0.18) : paid);
}
function effectiveStatus(s, now) {
  if (s.status === 'pending' && (now || Date.now()) >= Date.parse(s.holdUntil || 0)) return 'approved';
  return s.status;
}
function view(s) { return Object.assign({}, s, { status: effectiveStatus(s), storedStatus: s.status }); }

// Called from settle.js after an order is paid. Idempotent (one line per Razorpay order, created once).
async function recordSale(order, payment, rec, siteUrl) {
  const n = order.notes || {};
  const code = normCode(n.ref);
  if (!code) return null;
  const p = await getPartner(code);
  if (!p) { console.warn('referral: order', order.id, 'has unknown ref', code); return null; }
  const buyer = C.normEmail(n.cust_email || (payment && payment.email));
  const at = Number(n.price_at) || (Number(order.created_at) * 1000) || Date.now();
  const now = new Date();
  const base = rec && rec.baseAmt != null && rec.currency === order.currency ? r2d(rec.baseAmt) : baseOf(n.product_key, order.currency, order.amount, at);
  const self = p.email === buyer;
  const sale = {
    id: order.id, kind: 'order', code: p.code, orderRef: n.order_ref || order.receipt || '', invoiceNo: (rec && rec.invoiceNo) || '',
    paymentId: payment ? payment.id : '', productKey: n.product_key, product: (rec && rec.module) || n.module || n.product_key,
    currency: order.currency, paid: Number(order.amount) / 100, base, pct: p.commissionPct,
    commission: self ? 0 : r2d(base * p.commissionPct / 100),
    customer: maskEmail(buyer), customerName: clip(n.cust_name, 60).split(/\s+/)[0] || '', customerHash: C.emailHash(buyer).slice(0, 16),
    at: now.toISOString(), holdUntil: new Date(now.getTime() + HOLD_DAYS() * 864e5).toISOString(),
    status: self ? 'void' : 'pending', voidReason: self ? 'Self-referral (partner bought with their own email)' : '',
    paidAt: null, payoutRef: '', history: [{ at: now.toISOString(), by: 'system', what: self ? 'self-referral → void' : 'order paid' }]
  };
  const fresh = await r2.putJson(saleKey(p.code, order.id), sale, { ifNoneMatch: '*' });
  if (!fresh) return { duplicate: true, code: p.code };
  if (!self) {
    try { await saleEmail(p, sale, siteUrl); } catch (e) { console.error('partner sale email failed', e.message); }
  }
  return { duplicate: false, code: p.code, sale };
}

async function listSales(code) {
  const prefix = P + 'sales/' + (code ? normCode(code) + '/' : '');
  const keys = (await r2.listKeys(prefix)).filter(k => k.endsWith('.json'));
  const out = [];
  for (let i = 0; i < keys.length; i += 20) {
    const batch = await Promise.all(keys.slice(i, i + 20).map(k => r2.getJson(k)));
    batch.forEach(o => { if (o) out.push(view(o.data)); });
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out;
}
function updateSale(code, id, mutator) {
  if (!/^[A-Za-z0-9_-]{4,60}$/.test(String(id || ''))) throw httpErr(400, 'Bad sale id');
  return updateJson(saleKey(normCode(code), id), mutator);
}

// Partner-reported offline sale (UPI / bank transfer they closed). Waits for you in "review".
async function createClaim(p, o, by) {
  const currency = ['INR', 'USD', 'EUR'].indexOf(String(o.currency || 'INR').toUpperCase()) >= 0 ? String(o.currency || 'INR').toUpperCase() : 'INR';
  const paid = r2d(o.amount);
  if (!(paid > 0) || paid > 10000000) throw httpErr(400, 'Enter the amount the customer paid.');
  const productKey = catalog.getProduct(o.productKey) ? o.productKey : '';
  const email = C.normEmail(o.customerEmail);
  if (o.customerEmail && !C.isEmail(email)) throw httpErr(400, 'Customer email looks wrong.');
  if (email && email === p.email) throw httpErr(400, 'You can’t claim commission on your own purchase.');
  const base = o.base != null && o.base !== '' ? r2d(o.base) : baseOf(productKey, currency, Math.round(paid * 100), Date.now());
  const now = new Date();
  const id = 'claim_' + now.getTime() + '_' + crypto.randomBytes(3).toString('hex');
  const admin = by === 'admin';
  const sale = {
    id, kind: admin ? 'manual' : 'claim', code: p.code, orderRef: clip(o.paymentRef, 80), invoiceNo: clip(o.invoiceNo, 40), paymentId: '',
    productKey, product: productKey ? catalog.getProduct(productKey).name : clip(o.product, 160) || 'Offline sale',
    currency, paid, base, pct: p.commissionPct, commission: r2d(base * p.commissionPct / 100),
    customer: email ? maskEmail(email) : clip(o.customerName, 60), customerName: clip(o.customerName, 60), customerEmail: email,
    note: clip(o.note, 300), at: now.toISOString(), holdUntil: now.toISOString(),
    status: admin ? 'approved' : 'review', voidReason: '', paidAt: null, payoutRef: '',
    history: [{ at: now.toISOString(), by: admin ? 'admin' : 'partner', what: admin ? 'added by admin' : 'reported by partner' }]
  };
  if (!(await r2.putJson(saleKey(p.code, id), sale, { ifNoneMatch: '*' }))) throw httpErr(409, 'Please retry.');
  return view(sale);
}

// Totals for a partner's sales (per currency, by effective status).
function totals(sales) {
  const t = { orders: 0, review: 0, byCurrency: {} };
  sales.forEach(s => {
    const st = s.status;
    if (st === 'review') { t.review++; return; }
    if (st === 'void') return;
    t.orders++;
    const c = t.byCurrency[s.currency] = t.byCurrency[s.currency] || { sales: 0, base: 0, commission: 0, pending: 0, approved: 0, paid: 0 };
    c.sales = r2d(c.sales + s.paid); c.base = r2d(c.base + s.base); c.commission = r2d(c.commission + s.commission);
    c[st] = r2d((c[st] || 0) + s.commission);
  });
  return t;
}

// ── Emails ────────────────────────────────────────────────────────────
function fmt(a, cur) { return require('./payrecords').fmtMoney(a, cur); }
function panelUrl(siteUrl) { return siteUrl + '/partners'; }
function refLink(siteUrl, code) { return siteUrl + '/?ref=' + encodeURIComponent(code); }

function welcomeEmail(p, accessCode, siteUrl, isReset) {
  const E = mail.esc;
  const subject = isReset ? 'Your new FullOnBaan partner access code' : 'Welcome to the FullOnBaan Partner Programme';
  const html = mail.shell(isReset ? 'Your new partner access code' : 'Welcome aboard, ' + String(p.name).split(/\s+/)[0] + '!',
    (isReset ? '<p>A new access code was issued for your partner dashboard. The previous code no longer works.</p>'
      : '<p>You are now a FullOnBaan sales partner. You earn <b>' + E(p.commissionPct) + '%</b> commission (on the price excluding GST) on every training sale you refer.</p>') +
    '<table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;">' +
    '<tr><td style="padding:6px 8px;color:#6b7686;width:40%">Your referral code</td><td style="padding:6px 8px;font-weight:bold;font-family:Consolas,monospace;font-size:18px">' + E(p.code) + '</td></tr>' +
    '<tr><td style="padding:6px 8px;color:#6b7686">Your referral link</td><td style="padding:6px 8px;font-weight:bold"><a href="' + E(refLink(siteUrl, p.code)) + '">' + E(refLink(siteUrl, p.code)) + '</a></td></tr></table>' +
    '<p>Share the link (it remembers you for 30 days on that browser), or ask buyers to type your code in the <b>Referral code</b> box at checkout.</p>' +
    '<p>Track your clicks, sales and commission in your partner dashboard — sign in with <b>' + E(p.email) + '</b> and this code:</p>' +
    '<div style="margin:18px 0;padding:16px;border:1px dashed #ba8738;border-radius:10px;background:#fffaf0;text-align:center;"><div style="font-size:11px;letter-spacing:2px;color:#6b7686;">DASHBOARD ACCESS CODE</div><div style="font-family:Consolas,Menlo,monospace;font-size:24px;font-weight:bold;letter-spacing:3px;color:#06132a;margin-top:6px;">' + E(accessCode) + '</div></div>' +
    '<p style="margin:22px 0;"><a href="' + E(panelUrl(siteUrl)) + '" style="background:#ba8738;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block;">Open my partner dashboard</a></p>' +
    '<p style="color:#4a5568;font-size:13px;">Commission on online orders becomes payable after the ' + HOLD_DAYS() + '-day money-back period.</p>', true);
  const text = subject + '\n\nReferral code: ' + p.code + '\nReferral link: ' + refLink(siteUrl, p.code) + '\nDashboard: ' + panelUrl(siteUrl) + '\nAccess code: ' + accessCode;
  return mail.sendMail(p.email, subject, html, text);
}

function saleEmail(p, s, siteUrl) {
  const E = mail.esc;
  const subject = 'New referral sale — you earned ' + fmt(s.commission, s.currency);
  const html = mail.shell('You made a sale!',
    '<p>A customer you referred just bought <b>' + E(s.product) + '</b>.</p>' +
    '<table style="width:100%;border-collapse:collapse;margin:14px 0;font-size:14px;">' +
    [['Order', s.orderRef], ['Sale value (excl. GST)', fmt(s.base, s.currency)], ['Your commission (' + s.pct + '%)', fmt(s.commission, s.currency)], ['Payable from', new Date(s.holdUntil).toDateString()]]
      .map(r => '<tr><td style="padding:6px 8px;border-bottom:1px solid #eef1f6;color:#6b7686;width:45%">' + E(r[0]) + '</td><td style="padding:6px 8px;border-bottom:1px solid #eef1f6;font-weight:bold">' + E(r[1]) + '</td></tr>').join('') + '</table>' +
    '<p style="margin:22px 0;"><a href="' + E(panelUrl(siteUrl)) + '" style="background:#ba8738;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:bold;display:inline-block;">View my dashboard</a></p>', true);
  return mail.sendMail(p.email, subject, html, subject + '\nProduct: ' + s.product + '\nCommission: ' + fmt(s.commission, s.currency));
}

module.exports = {
  STATUSES, HOLD_DAYS, normCode, normPct, maskEmail, suggestCode, getPartner, getPartnerByEmail, activePartner, updatePartner,
  createPartner, publicPartner, recordClick, getClicks, resolveForCheckout, recordSale, listSales, updateSale, createClaim,
  totals, effectiveStatus, view, welcomeEmail, refLink, partnerKey, emailKey, saleKey, httpErr, updateJson
};
