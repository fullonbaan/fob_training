// api/_lib/payrecords.js — the order/payment register shown in /admin and used for GST invoices.
// Written ONLY by the server (never by a customer's browser).
// Storage (unchanged): private repo fullonbaan/fob_pay_store_ln_int
//   payments/ln_payments.json        [ {orderId, status, name, email, module, …, invoiceNo, paymentId}, … ]
//   payments/invoice_counter.json    { "counter": N }   → invoice numbers FOB0000001…
// Statuses: initiated → confirmed (paid) | failed.  Same fields as before, so /admin works unchanged.
// Env: GITHUB_PAT  (FOB_GH_LOCAL=/dir switches to local files — offline testing only)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const catalog = require('./catalog');

const GH_OWNER = 'fullonbaan', GH_REPO = 'fob_pay_store_ln_int';
const FILE_RECORDS = 'payments/ln_payments.json';
const FILE_COUNTER = 'payments/invoice_counter.json';
const INV_PREFIX = 'FOB', INV_PAD = 7;

// ── GitHub contents API (with optimistic concurrency via sha) ─────────
async function ghGet(file) {
  if (process.env.FOB_GH_LOCAL) {
    const p = path.join(process.env.FOB_GH_LOCAL, file);
    if (!fs.existsSync(p)) return { data: null, sha: null };
    const raw = fs.readFileSync(p, 'utf8');
    return { data: raw.trim() ? JSON.parse(raw) : null, sha: crypto.createHash('md5').update(raw).digest('hex') };
  }
  const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${file}`, { headers: ghHeaders() });
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new Error('GitHub GET ' + file + ' → ' + r.status);
  const j = await r.json();
  const raw = j.content ? Buffer.from(j.content.replace(/\n/g, ''), 'base64').toString('utf8') : '';
  return { data: raw.trim() ? JSON.parse(raw) : null, sha: j.sha || null };
}
// Returns true on success, false on a write conflict (someone else saved first).
async function ghPut(file, data, sha, message) {
  const body = JSON.stringify(data, null, 2);
  if (process.env.FOB_GH_LOCAL) {
    const p = path.join(process.env.FOB_GH_LOCAL, file);
    const cur = fs.existsSync(p) ? crypto.createHash('md5').update(fs.readFileSync(p, 'utf8')).digest('hex') : null;
    if (cur !== sha) return false;
    fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); return true;
  }
  const payload = { message, content: Buffer.from(body).toString('base64') };
  if (sha) payload.sha = sha;
  const r = await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${file}`,
    { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, ghHeaders()), body: JSON.stringify(payload) });
  if (r.status === 409 || r.status === 422) return false;
  if (!r.ok) throw new Error('GitHub PUT ' + file + ' → ' + r.status + ' ' + (await r.text()).slice(0, 160));
  return true;
}
function ghHeaders() {
  const pat = process.env.GITHUB_PAT;
  if (!pat) throw new Error('GITHUB_PAT not set');
  return { 'Authorization': 'token ' + pat.trim(), 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'fob-training-server/3.0' };
}
async function retrying(fn) {
  for (let i = 0; i < 6; i++) {
    const out = await fn();
    if (out !== false) return out;
    await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
  }
  throw new Error('GitHub store busy — please retry');
}

// ── Records ───────────────────────────────────────────────────────────
async function readRecords() { const g = await ghGet(FILE_RECORDS); return { records: Array.isArray(g.data) ? g.data : [], sha: g.sha }; }

// mutate(record|null) → new record object, or null for "no change". Returns the saved (or existing) record.
function upsertRecord(orderId, mutate, message) {
  return retrying(async () => {
    const { records, sha } = await readRecords();
    const i = records.findIndex(r => r.orderId === orderId);
    const cur = i >= 0 ? records[i] : null;
    const next = mutate(cur ? Object.assign({}, cur) : null);
    if (!next) return cur || null;
    if (i >= 0) records[i] = next; else records.push(next);
    const ok = await ghPut(FILE_RECORDS, records, sha, message || ('lnpay: ' + next.status + ' ' + orderId));
    return ok ? next : false;
  });
}

function nextInvoiceNo() {
  return retrying(async () => {
    const g = await ghGet(FILE_COUNTER);
    const n = (Number(g.data && g.data.counter) || 0) + 1;
    const ok = await ghPut(FILE_COUNTER, { counter: n }, g.sha, 'invoice-counter: ' + n);
    return ok ? INV_PREFIX + String(n).padStart(INV_PAD, '0') : false;
  });
}

// ── Money ─────────────────────────────────────────────────────────────
function fmtMoney(amt, cur) {
  const sym = { INR: '₹', USD: '$', EUR: '€' }[cur] || '';
  return sym + Number(amt).toLocaleString(cur === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function ddmmyyyy(d) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' }).formatToParts(d);
  const g = (t) => p.find(x => x.type === t).value;
  return g('day') + '/' + g('month') + '/' + g('year');
}

const BILL_FIELDS = ['name', 'email', 'mobile', 'mobileCode', 'billCompany', 'billLine1', 'billLine2', 'billCity', 'billPincode',
                     'billCountry', 'billStateCode', 'billStateName', 'gstin', 'gstLegalName'];
function cleanBilling(b) {
  const out = {};
  BILL_FIELDS.forEach(k => { out[k] = String((b && b[k]) == null ? '' : b[k]).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 200); });
  out.email = out.email.toLowerCase();
  out.billCountry = out.billCountry || 'IN';
  out.mobileCode = out.mobileCode || '+91';
  out.gstin = out.gstin.toUpperCase();
  if (out.billCountry !== 'IN') out.billStateCode = '';
  return out;
}
const stateFor = (b) => (b && b.billCountry === 'IN') ? b.billStateCode : '';
function amounts(q) {
  return { baseAmt: q.base, gstAmt: q.gst, totalAmt: q.total, cgstAmt: q.cgst, sgstAmt: q.sgst, igstAmt: q.igst, taxType: q.taxType };
}

// Called when the server creates the Razorpay order: the "initiated" register line.
function recordInitiated(o) {
  const b = cleanBilling(o.billing);
  const q = catalog.quote(o.productKey, o.currency, { at: o.at, stateCode: stateFor(b) });
  const now = new Date();
  return upsertRecord(o.orderRef, (cur) => {
    if (cur && cur.status === 'confirmed') return null;                         // never downgrade a paid order
    if (cur && cur.rzpOrderId && cur.rzpOrderId !== o.rzpOrderId) return null;   // never overwrite another order
    return Object.assign(cur || {}, b, amounts(q), {
      orderId: o.orderRef, status: 'initiated', rzpOrderId: o.rzpOrderId,
      productKey: o.productKey, module: q.desc, currency: o.currency, amount: q.total,
      placeOfSupply: b.billStateName ? (b.billStateName + (b.billStateCode ? ' (' + b.billStateCode + ')' : '')) : '',
      invoiceNo: '', invDate: ddmmyyyy(now), dueDate: ddmmyyyy(new Date(now.getTime() + 15 * 864e5)),
      initiatedAt: (cur && cur.initiatedAt) || now.toISOString(), confirmedAt: null, paymentId: null, utr: null
    });
  });
}

// Called once per paid order (by whichever of verify/webhook settles it first).
// Assigns the invoice number and marks the line confirmed.
async function recordPaid(order, payment) {
  const notes = order.notes || {};
  const orderRef = notes.order_ref || order.receipt || order.id;
  const existing = (await readRecords()).records.find(r => r.orderId === orderRef);
  if (existing && existing.status === 'confirmed' && existing.invoiceNo) return { record: existing, fresh: false };

  const invNo = await nextInvoiceNo();
  const productKey = notes.product_key;
  const at = Number(notes.price_at) || (Number(order.created_at) * 1000) || Date.now();
  const now = new Date();
  const saved = await upsertRecord(orderRef, (cur) => {
    if (cur && cur.status === 'confirmed' && cur.invoiceNo) return null;
    const base = cur || Object.assign(cleanBilling({ name: notes.cust_name, email: notes.cust_email, mobile: notes.cust_mobile }), { initiatedAt: now.toISOString() });
    const q = catalog.quote(productKey, order.currency, { at, stateCode: stateFor(base) });
    // The amount actually paid is authoritative for the invoice (it equals q.total — checked in fulfilOrder).
    const paid = Number(order.amount) / 100;
    const a = q && Math.round(q.total * 100) === Number(order.amount) ? amounts(q) : amounts(catalog.gstSplit(order.currency === 'INR' ? paid / 1.18 : paid, order.currency, stateFor(base)));
    return Object.assign(base, a, {
      orderId: orderRef, status: 'confirmed', rzpOrderId: order.id, paymentId: payment ? payment.id : '',
      utr: payment ? payment.id : '', productKey, module: (q && q.desc) || base.module || productKey,
      currency: order.currency, amount: paid,
      placeOfSupply: base.billStateName ? (base.billStateName + (base.billStateCode ? ' (' + base.billStateCode + ')' : '')) : '',
      invoiceNo: invNo, invDate: ddmmyyyy(now), dueDate: ddmmyyyy(new Date(now.getTime() + 15 * 864e5)),
      submittedAt: now.toISOString(), confirmedAt: now.toISOString()
    });
  }, 'lnpay: confirmed ' + orderRef + ' ' + invNo);
  const rec = saved || (await readRecords()).records.find(r => r.orderId === orderRef);
  return { record: rec, fresh: !!rec && rec.invoiceNo === invNo };
}

// Shape the page's GST-invoice PDF generator expects (window.downloadInvoice).
function invoiceView(rec) {
  if (!rec) return null;
  const keys = ['invDate', 'dueDate', 'name', 'email', 'mobile', 'mobileCode', 'module', 'currency', 'baseAmt', 'gstAmt', 'totalAmt',
    'cgstAmt', 'sgstAmt', 'igstAmt', 'taxType', 'billCompany', 'billLine1', 'billLine2', 'billCity', 'billPincode',
    'billStateCode', 'billStateName', 'billCountry', 'gstin', 'gstLegalName', 'placeOfSupply', 'paymentId'];
  const o = {}; keys.forEach(k => { o[k] = rec[k] == null ? '' : rec[k]; });
  o.invNo = rec.invoiceNo; o.orderRef = rec.orderId;
  return o;
}

module.exports = { readRecords, upsertRecord, nextInvoiceNo, recordInitiated, recordPaid, invoiceView, fmtMoney, cleanBilling,
  ghGet, ghPut, FILE_RECORDS, FILE_COUNTER, INV_PREFIX, INV_PAD };
