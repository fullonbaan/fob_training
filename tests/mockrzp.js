// In-process mock of the Razorpay REST API (enforces the real limits we care about).
const crypto = require('crypto');
const S = global.__RZP = global.__RZP || { orders: {}, payments: {}, calls: [] };
function err(status, msg) { const e = new Error('Razorpay mock → ' + status + ': ' + msg); e.status = status; throw e; }
module.exports = async function (method, path, body) {
  S.calls.push({ method, path });
  if (process.env.MOCK_RZP_DOWN) err(503, 'down');
  let m;
  if (method === 'POST' && path === '/orders') {
    if (!Number.isInteger(body.amount) || body.amount < 100) err(400, 'amount must be integer ≥ 100: ' + body.amount);
    if (['INR', 'USD', 'EUR'].indexOf(body.currency) < 0) err(400, 'currency');
    const n = body.notes || {};
    if (Object.keys(n).length > 15) err(400, 'notes > 15 keys: ' + Object.keys(n).length);
    Object.keys(n).forEach(k => { const v = String(n[k]); if (v === '') err(400, 'empty note ' + k); if (v.length > 256) err(400, 'note too long ' + k); });
    if (body.receipt && body.receipt.length > 40) err(400, 'receipt > 40 chars');
    const id = 'order_' + crypto.randomBytes(7).toString('hex');
    S.orders[id] = { id, entity: 'order', amount: body.amount, amount_paid: 0, currency: body.currency, receipt: body.receipt, notes: n, status: 'created', created_at: Math.floor(Date.now() / 1000) };
    return JSON.parse(JSON.stringify(S.orders[id]));
  }
  if (method === 'GET' && (m = path.match(/^\/orders\/([^/]+)$/))) { const o = S.orders[decodeURIComponent(m[1])]; if (!o) err(404, 'no order'); return JSON.parse(JSON.stringify(o)); }
  if (method === 'GET' && (m = path.match(/^\/orders\/([^/]+)\/payments$/))) { const id = decodeURIComponent(m[1]); return { items: Object.values(S.payments).filter(p => p.order_id === id) }; }
  if (method === 'GET' && (m = path.match(/^\/payments\/([^/]+)$/))) { const p = S.payments[decodeURIComponent(m[1])]; if (!p) err(404, 'no payment'); return JSON.parse(JSON.stringify(p)); }
  if (method === 'POST' && (m = path.match(/^\/payments\/([^/]+)\/capture$/))) {
    const p = S.payments[decodeURIComponent(m[1])]; if (!p) err(404, 'no payment');
    if (body.amount !== p.amount) err(400, 'capture amount mismatch');
    p.status = 'captured'; const o = S.orders[p.order_id]; o.status = 'paid'; o.amount_paid = o.amount; return JSON.parse(JSON.stringify(p));
  }
  err(404, 'mock: unknown ' + method + ' ' + path);
};
// Test helper: customer pays an order. mode 'captured' (auto-capture) or 'authorized'.
module.exports.pay = function (orderId, mode, email) {
  const o = S.orders[orderId]; if (!o) throw new Error('no order ' + orderId);
  const id = 'pay_' + crypto.randomBytes(7).toString('hex');
  S.payments[id] = { id, entity: 'payment', order_id: orderId, amount: o.amount, currency: o.currency, status: mode || 'captured', email: email || o.notes.cust_email, method: 'upi' };
  if ((mode || 'captured') === 'captured') { o.status = 'paid'; o.amount_paid = o.amount; }
  const sig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(orderId + '|' + id).digest('hex');
  return { razorpay_order_id: orderId, razorpay_payment_id: id, razorpay_signature: sig };
};
module.exports.state = S;
