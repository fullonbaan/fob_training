// api/invoice-counter.js — sequential GST invoice numbers (FOB#######) — ADMIN ONLY.
//   GET            → increments the counter and returns the next number (manual /admin entries)
//   POST {counter} → sets the counter (the /admin "Renumber" migration)
// Paid Razorpay orders get their number on the SERVER (api/_lib/payrecords.js), so the public never
// needs this endpoint (it used to be open, letting anyone burn invoice numbers).
// Storage: fob_pay_store_ln_int / payments/invoice_counter.json
const auth = require('./_lib/auth');
const pay = require('./_lib/payrecords');

const fmt = (n) => pay.INV_PREFIX + String(n).padStart(pay.INV_PAD, '0');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!auth.isAdmin(req)) return res.status(401).json({ error: 'Admin sign-in required.' });

  if (req.method === 'GET') {
    try {
      const invoiceNo = await pay.nextInvoiceNo();
      return res.status(200).json({ invoiceNo, counter: Number(invoiceNo.slice(pay.INV_PREFIX.length)) });
    } catch (e) {
      console.error('invoice-counter GET error:', e);
      return res.status(502).json({ error: e.message });
    }
  }

  if (req.method === 'POST') {
    const n = parseInt(req.body && req.body.counter, 10);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: 'Invalid counter value' });
    try {
      for (let i = 0; i < 6; i++) {
        const g = await pay.ghGet(pay.FILE_COUNTER);
        if (await pay.ghPut(pay.FILE_COUNTER, { counter: n }, g.sha, 'invoice-counter: set ' + n)) return res.status(200).json({ counter: n, invoiceNo: fmt(n) });
      }
      return res.status(409).json({ error: 'Counter busy — retry' });
    } catch (e) {
      console.error('invoice-counter POST error:', e);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
};
