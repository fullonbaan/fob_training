// api/payments.js — the LN training order register (private repo fob_pay_store_ln_int,
// payments/ln_payments.json), for the /admin dashboard.
//
//   GET                          → { records, sha }
//   PUT  {records, sha, message} → replace the whole list (delete, renumber) → { sha }  (409 on conflict)
//   POST {record}                → merge ONE order (billing edits from /admin)
//   POST {action:'setInvoiceNo', orderId, invoiceNo}
//                                → change ONE order's invoice number (409 if another order already uses it).
//                                  The previous number is kept as legacyInvoiceNo on first change.
//
// ADMIN ONLY (the /admin sign-in cookie, or Bearer ADMIN_API_TOKEN). Customer checkouts never
// call this any more: the server records orders itself in /api/checkout (api/_lib/payrecords.js).
// GITHUB_PAT and ADMIN_PASSWORD must be set as Vercel environment variables.
const auth = require('./_lib/auth');
const pay = require('./_lib/payrecords');

const STATUSES = ['initiated', 'submitted', 'confirmed', 'failed'];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!auth.isAdmin(req)) return res.status(401).json({ error: 'Admin sign-in required.' });

  try {
    if (req.method === 'GET') {
      const { records, sha } = await pay.readRecords();
      return res.status(200).json({ records, sha });
    }

    if (req.method === 'PUT') {
      const { records, sha, message } = req.body || {};
      if (!Array.isArray(records)) return res.status(400).json({ error: '`records` array is required.' });
      const ok = await pay.ghPut(pay.FILE_RECORDS, records, sha || null, String(message || 'admin: update').slice(0, 120));
      if (!ok) return res.status(409).json({ error: 'The register changed since you loaded it — refresh and try again.' });
      return res.status(200).json({ sha: (await pay.readRecords()).sha });
    }

    if (req.method === 'POST' && req.body && req.body.action === 'setInvoiceNo') {
      const orderId = String(req.body.orderId || '').trim();
      const invoiceNo = String(req.body.invoiceNo || '').trim().toUpperCase();
      if (!orderId) return res.status(400).json({ error: 'orderId is required.' });
      if (!/^[A-Z0-9][A-Z0-9\-\/]{0,29}$/.test(invoiceNo)) return res.status(400).json({ error: 'Invoice number may only contain letters, digits, - and / (max 30).' });
      for (let i = 0; i < 6; i++) {
        const { records, sha } = await pay.readRecords();
        const idx = records.findIndex(r => r.orderId === orderId);
        if (idx < 0) return res.status(404).json({ error: 'Order not found.' });
        const clash = records.find(r => r.orderId !== orderId && String(r.invoiceNo || '').toUpperCase() === invoiceNo);
        if (clash) return res.status(409).json({ error: invoiceNo + ' is already used by ' + (clash.name || clash.orderId) + '.' });
        const cur = records[idx];
        if (cur.invoiceNo === invoiceNo) return res.status(200).json({ ok: true, invoiceNo, unchanged: true });
        const next = Object.assign({}, cur, { invoiceNo, invoiceEditedAt: new Date().toISOString() });
        if (cur.invoiceNo && !cur.legacyInvoiceNo) next.legacyInvoiceNo = cur.invoiceNo;
        records[idx] = next;
        if (await pay.ghPut(pay.FILE_RECORDS, records, sha, 'admin: invoice no ' + (cur.invoiceNo || '-') + ' -> ' + invoiceNo + ' ' + orderId))
          return res.status(200).json({ ok: true, invoiceNo, previous: cur.invoiceNo || '' });
        await new Promise(r => setTimeout(r, 200 + Math.random() * 400));
      }
      return res.status(409).json({ error: 'Register busy — please retry.' });
    }

    if (req.method === 'POST') {
      const rec = (req.body && req.body.record) || {};
      const orderId = typeof rec.orderId === 'string' ? rec.orderId.trim() : '';
      if (!orderId || orderId.length > 80 || !/^[\w.\-:]+$/.test(orderId)) return res.status(400).json({ error: 'Valid orderId is required.' });
      if (rec.status !== undefined && !STATUSES.includes(rec.status)) return res.status(400).json({ error: 'Invalid status.' });
      await pay.upsertRecord(orderId, (cur) => Object.assign(cur || {}, rec, { orderId }), 'admin: ' + (rec.status || 'update') + ' ' + orderId);
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (e) {
    console.error('payments api error:', e);
    return res.status(502).json({ error: e.message });
  }
};
