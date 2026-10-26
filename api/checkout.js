// api/checkout.js — server-side Razorpay checkout for training.fullonbaan.com
//   POST /api/checkout?action=order   → creates a Razorpay Order at the CATALOGUE price (+GST for INR)
//   POST /api/checkout?action=verify  → verifies the payment signature, unlocks eBooks (if any),
//                                       registers the order + GST invoice number, sends emails
//   POST /api/checkout?action=event   → {type:'failed'|'abandon', orderRef}: alert to the admin only
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET (+ storage / email / session env, see MEMBERS_SETUP.md)
const H = require('./_lib/http');
const C = require('./_lib/crypto');
const catalog = require('./_lib/catalog');
const rzp = require('./_lib/razorpay');
const settle = require('./_lib/settle');
const pay = require('./_lib/payrecords');
const RL = require('./_lib/ratelimit');
const referrals = require('./_lib/referrals');

const clip = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n || 250);

async function createOrder(req, res) {
  const b = await H.readJson(req);
  const productKey = String(b.product || '');
  const currency = String(b.currency || 'INR').toUpperCase();
  const cust = (b.customer && typeof b.customer === 'object') ? b.customer : {};
  const billing = (b.billing && typeof b.billing === 'object') ? b.billing : {};
  const product = catalog.getProduct(productKey);
  const at = Date.now();
  const stateCode = String(billing.billCountry || 'IN') === 'IN' ? String(billing.billStateCode || '') : '';
  const q = catalog.quote(productKey, currency, { at, stateCode });
  const email = C.normEmail(cust.email);
  if (!product || !q) return H.send(res, 400, { error: 'Unknown product or currency.' });
  if (!C.isEmail(email)) return H.send(res, 400, { error: 'A valid email is required.' });
  if (!clip(cust.name, 120).trim()) return H.send(res, 400, { error: 'Your name is required.' });
  // Abuse guard: each checkout creates a Razorpay order and a register line.
  if (!(await RL.allow('order', H.clientIp(req), Number(process.env.RL_ORDERS_PER_HOUR || 20), 3600))) {
    return H.send(res, 429, { error: 'Too many checkout attempts from your network. Please wait a few minutes, or write to support@fullonbaan.com.' });
  }

  // Server-controlled notes first (these drive fulfilment), then billing notes from the form.
  const notes = {
    site: 'training',
    product_key: productKey,
    cust_email: email,
    cust_name: clip(cust.name, 120).trim(),
    cust_mobile: clip(String(cust.mobile || '').replace(/\D/g, ''), 20),
    order_ref: 'FOBT' + at + String(require('crypto').randomInt(100, 1000)),   // server-made, unique
    price_at: String(at),
    module: clip(q.desc, 250)
  };
  // Referral: the code in the checkout box (pre-filled from the ?ref= link cookie), else the cookie itself.
  // Validated here, on the server — only an ACTIVE partner who is not the buyer gets the order.
  let referral = null;
  try { referral = await referrals.resolveForCheckout(b.ref || H.parseCookies(req).fob_ref, email); }
  catch (e) { console.warn('referral lookup failed (order continues without it)', e.message); }
  if (referral && !referral.self) notes.ref = referral.code;
  const extra = b.notes && typeof b.notes === 'object' ? b.notes : {};
  Object.keys(extra).forEach(k => {
    const key = clip(k, 40);
    if (Object.keys(notes).length >= 15 || notes[key] !== undefined || /^(site|product_key|cust_|order_ref|price_at|module|ref)$|^cust_|^ref_/.test(key)) return;
    if (notes.ref && key === 'bill_country' && extra[k] === 'IN') return;    // implied default — keeps room for `ref` within Razorpay's 15 notes
    const v = extra[k]; if (v === '' || v == null || typeof v === 'object') return;
    notes[key] = clip(v, 250);
  });

  Object.keys(notes).forEach(k => { if (notes[k] === '') delete notes[k]; });   // Razorpay rejects empty values

  const order = await rzp.createOrder({ amount: q.amountMinor, currency, receipt: notes.order_ref, notes, payment_capture: 1 });
  // Register line ("initiated") written by the server — the browser never touches the register.
  try {
    await pay.recordInitiated({ orderRef: notes.order_ref, rzpOrderId: order.id, productKey, currency, at,
      billing: Object.assign({}, billing, { name: notes.cust_name, email, mobile: notes.cust_mobile, mobileCode: cust.mobileCode }),
      refCode: notes.ref || '', refSrc: notes.ref ? (b.refSrc === 'link' ? 'link' : 'code') : '' });
  } catch (e) { console.error('register (initiated) failed', e.message); }
  return H.send(res, 200, {
    orderId: order.id, orderRef: notes.order_ref, amount: order.amount, currency: order.currency,
    keyId: process.env.RAZORPAY_KEY_ID, productName: q.desc,
    quote: { base: q.base, gst: q.gst, total: q.total, cgst: q.cgst, sgst: q.sgst, igst: q.igst, taxType: q.taxType, list: q.list, onSale: q.onSale },
    delivers: { ebooks: product.ebooks.length > 0, video: !!product.video },
    referral: notes.ref ? { code: notes.ref, by: referral.firstName } : null
  });
}

async function verify(req, res) {
  const b = await H.readJson(req);
  const orderId = String(b.razorpay_order_id || ''), paymentId = String(b.razorpay_payment_id || ''), sig = String(b.razorpay_signature || '');
  if (!orderId || !paymentId || !sig) return H.send(res, 400, { error: 'Missing payment fields.' });
  if (!rzp.verifyCheckoutSignature(orderId, paymentId, sig)) {
    console.warn('checkout verify: BAD SIGNATURE', orderId, paymentId, H.clientIp(req));
    return H.send(res, 400, { error: 'Payment signature could not be verified.' });
  }
  // Never trust the browser beyond the signature — load the truth from Razorpay.
  let order = await rzp.fetchOrder(orderId);
  let payment = await rzp.fetchPayment(paymentId);
  if (payment.order_id !== orderId) return H.send(res, 400, { error: 'Payment does not belong to this order.' });
  if (!order.notes || order.notes.site !== 'training' || !catalog.getProduct(order.notes.product_key)) return H.send(res, 400, { error: 'Not a training order.' });
  if (payment.status === 'authorized') {
    payment = await rzp.capturePayment(paymentId, order.amount, order.currency);
    order = await rzp.fetchOrder(orderId);
  }
  if (payment.status !== 'captured') return H.send(res, 409, { error: 'Payment is ' + payment.status + ', not captured yet. Your confirmation will be emailed as soon as it completes.' });

  const s = await settle.settle(order, payment, H.siteUrl(req), 'verify');
  const r = s.fulfil;
  const product = catalog.getProduct(order.notes.product_key);
  return H.send(res, 200, {
    ok: true,
    email: r.email || C.normEmail(order.notes.cust_email),
    access: !r.noAccess,                 // eBooks unlocked in the Members Library
    video: !!product.video,              // video lectures are delivered separately (as before)
    code: r.code || null,                // shown once on the thank-you screen for brand-new members
    returning: !r.noAccess && !r.code,
    unlocked: product.ebooks.map(k => catalog.EBOOKS[k].name),
    invoice: s.invoice,                  // server-assigned GST invoice (number, amounts, billing) for the PDF
    membersUrl: '/members'
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return H.send(res, 405, { error: 'Method not allowed.' });
  if (H.isCrossSite(req)) return H.send(res, 403, { error: 'Cross-site request blocked.' });
  const action = H.getQuery(req).action;
  try {
    if (action === 'order') return await createOrder(req, res);
    if (action === 'verify') return await verify(req, res);
    if (action === 'event') {
      const b = await H.readJson(req);
      const type = b.type === 'failed' ? 'failed' : b.type === 'abandon' ? 'abandon' : null;
      if (type) { try { await settle.alertAdmin(String(b.orderRef || ''), type, b.reason); } catch (e) { console.error('alert failed', e.message); } }
      return H.send(res, 200, { ok: true });
    }
    return H.send(res, 404, { error: 'Unknown action.' });
  } catch (e) {
    console.error('checkout error', action, e);
    return H.send(res, 500, { error: action === 'order'
      ? 'We could not start the payment just now. Please try again in a minute, or WhatsApp +91 63605 93122.'
      : 'Server error — if you were charged, your confirmation will still be emailed. Contact support@fullonbaan.com.' });
  }
};
