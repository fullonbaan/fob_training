// api/payments.js — GitHub-backed store for LN payment records (private repo).
//
//   GET                         admin only → { records, sha }
//   PUT  {records, sha, message} admin only → replace the whole list (delete, renumber)
//   POST {record}               checkout   → create / update ONE order; returns nothing
//                                           about other customers
//        + admin session cookie admin     → full merge of any field (billing edits)
//
// Public callers can only touch their own order (by orderId), only with known fields,
// and can't change who paid / how much once the order exists, or edit a confirmed order.
// GITHUB_PAT and ADMIN_PASSWORD must be set as Vercel environment variables.

const https = require('https');
const { isAdmin, requireAdmin } = require('./_auth');

const GH_OWNER = 'fullonbaan';
const GH_REPO  = 'fob_pay_store_ln_int';
const GH_FILE  = 'payments/ln_payments.json';

const STATUSES = ['initiated', 'submitted', 'confirmed', 'failed'];
// Fields checkout may set when it first creates an order
const CREATE_FIELDS = [
  'orderId', 'status', 'name', 'email', 'mobile', 'mobileCode', 'module', 'currency',
  'amount', 'baseAmt', 'gstAmt', 'totalAmt', 'cgstAmt', 'sgstAmt', 'igstAmt', 'taxType',
  'billCompany', 'billLine1', 'billLine2', 'billCity', 'billPincode', 'billStateCode',
  'billStateName', 'billCountry', 'gstin', 'gstLegalName', 'placeOfSupply',
  'invoiceNo', 'invDate', 'dueDate', 'initiatedAt', 'submittedAt', 'confirmedAt',
  'failedAt', 'paymentId', 'utr'
];
// Fields checkout may change on an order that already exists (payment progress only)
const UPDATE_FIELDS = [
  'status', 'utr', 'submittedAt', 'paymentId', 'invoiceNo', 'invDate', 'dueDate',
  'confirmedAt', 'failedAt'
];

function ghRequest(method, bodyObj) {
  return new Promise((resolve, reject) => {
    const pat = process.env.GITHUB_PAT;
    if (!pat) return reject(new Error('GITHUB_PAT environment variable is not set.'));
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`,
      method,
      headers: {
        'Authorization': `token ${pat.trim()}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'fob-payments-proxy/2.0',
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function readRecords() {
  const r = await ghRequest('GET');
  if (r.status === 404) return { records: [], sha: null };
  if (r.status !== 200) throw new Error(`GitHub GET ${r.status}`);
  const gh = JSON.parse(r.body);
  if (!gh.content) return { records: [], sha: gh.sha || null };
  const decoded = Buffer.from(gh.content.replace(/\n/g, ''), 'base64').toString('utf8');
  const records = decoded.trim() ? JSON.parse(decoded) : [];
  return { records: Array.isArray(records) ? records : [], sha: gh.sha };
}

async function writeRecords(records, sha, message) {
  const body = { message: message || 'lnpay: update', content: Buffer.from(JSON.stringify(records, null, 2)).toString('base64') };
  if (sha) body.sha = sha;
  const r = await ghRequest('PUT', body);
  if (r.status === 409 || r.status === 422) { const e = new Error('GitHub write conflict — refresh and retry'); e.conflict = true; throw e; }
  if (r.status !== 200 && r.status !== 201) throw new Error(`GitHub PUT ${r.status}`);
  return JSON.parse(r.body).content.sha;
}

function clean(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  return String(v).replace(/[\u0000-\u001F]/g, ' ').slice(0, 300);
}

function pick(src, fields) {
  const out = {};
  fields.forEach(f => { if (Object.prototype.hasOwnProperty.call(src, f)) out[f] = clean(src[f]); });
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  'https://training.fullonbaan.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── GET: full list — admin only ──────────────────────────────────────
    if (req.method === 'GET') {
      if (!requireAdmin(req, res)) return;
      const { records, sha } = await readRecords();
      return res.status(200).json({ records, sha });
    }

    // ── PUT: replace full list — admin only ─────────────────────────────
    if (req.method === 'PUT') {
      if (!requireAdmin(req, res)) return;
      const { records, sha, message } = req.body || {};
      if (!Array.isArray(records)) return res.status(400).json({ error: '`records` array is required.' });
      const newSha = await writeRecords(records, sha, message);
      return res.status(200).json({ sha: newSha });
    }

    // ── POST: upsert one order ───────────────────────────────────────────
    if (req.method === 'POST') {
      const admin = isAdmin(req);
      const rec = (req.body && req.body.record) || {};
      const orderId = typeof rec.orderId === 'string' ? rec.orderId.trim() : '';
      if (!orderId || orderId.length > 80 || !/^[\w.\-:]+$/.test(orderId)) {
        return res.status(400).json({ error: 'Valid orderId is required.' });
      }
      if (rec.status !== undefined && !STATUSES.includes(rec.status)) {
        return res.status(400).json({ error: 'Invalid status.' });
      }

      for (let attempt = 0; attempt < 4; attempt++) {
        const { records, sha } = await readRecords();
        const i = records.findIndex(x => x.orderId === orderId);
        let next;
        if (admin) {
          next = i >= 0 ? Object.assign({}, records[i], rec) : Object.assign({}, rec);
        } else if (i < 0) {
          next = pick(rec, CREATE_FIELDS);
          next.orderId = orderId;
          if (!next.status) next.status = 'initiated';
        } else {
          const cur = records[i];
          if (cur.status === 'confirmed') return res.status(200).json({ ok: true }); // locked
          next = Object.assign({}, cur, pick(rec, UPDATE_FIELDS));
        }
        if (i >= 0) records[i] = next; else records.push(next);
        try {
          await writeRecords(records, sha, `${admin ? 'admin' : 'lnpay'}: ${next.status || 'update'} ${orderId}`);
          return res.status(200).json({ ok: true });
        } catch (e) {
          if (!e.conflict || attempt === 3) throw e;
          await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
        }
      }
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (e) {
    console.error('payments proxy error:', e);
    return res.status(502).json({ error: e.message });
  }
};
