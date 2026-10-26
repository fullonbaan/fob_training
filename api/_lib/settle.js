// api/_lib/settle.js — everything that must happen exactly once when an order is paid:
//   1. unlock the eBooks in the Members Library (eBook, combo and eBook-library products) — idempotent
//   2. register line → "confirmed" + GST invoice number — guarded by a lock so that verify and
//      the webhook arriving together can never assign two invoice numbers
//   3. order confirmation / tax-invoice email to the customer + order alert to you
//      (sent only by whoever assigned the invoice number → never twice)
// Video products: no online access — the customer gets the order confirmation and you get the
// order alert, exactly as before, and you deliver the video access yourself.
const r2 = require('./r2');
const members = require('./members');
const pay = require('./payrecords');
const mail = require('./email');
const catalog = require('./catalog');
const RL = require('./ratelimit');
const referrals = require('./referrals');

const ADMIN_EMAIL = () => process.env.ADMIN_ALERT_EMAIL || 'fullonbaan@gmail.com';
const TPL_OK = () => process.env.EMAILJS_TEMPLATE_PAYMENT || 'FOB_Razorpay_Success';
const TPL_FAIL = () => process.env.EMAILJS_TEMPLATE_FAILURE || 'FOB_Razorpay_Failure';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findRecord(orderRef) {
  return (await pay.readRecords()).records.find(r => r.orderId === orderRef) || null;
}

async function ensureInvoice(order, payment, siteUrl) {
  const notes = order.notes || {};
  const orderRef = notes.order_ref || order.receipt || order.id;
  let rec = await findRecord(orderRef);
  if (rec && rec.status === 'confirmed' && rec.invoiceNo) return rec;

  const lockKey = 'locks/invoice-' + order.id + '.txt';
  let mine = await r2.putObject(lockKey, String(Date.now()), 'text/plain', { ifNoneMatch: '*' });
  if (!mine) {
    // Someone else is on it — wait for their result; take over only if their lock is stale.
    for (let i = 0; i < 10; i++) {
      await sleep(Number(process.env.FOB_LOCK_POLL_MS || 1000));
      rec = await findRecord(orderRef);
      if (rec && rec.status === 'confirmed' && rec.invoiceNo) return rec;
    }
    const l = await r2.getObject(lockKey);
    const age = l ? Date.now() - Number(l.body.toString()) : Infinity;
    if (age < 90000) return null;
    await r2.putObject(lockKey, String(Date.now()), 'text/plain');
    mine = true;
  }
  const res = await pay.recordPaid(order, payment);
  if (res.fresh) await paymentEmails(res.record, notes.product_key, siteUrl);
  return res.record;
}

function deliveryText(product, siteUrl) {
  const lib = siteUrl + '/members';
  if (!product) return 'Your training material will be delivered within 24 hours.';
  if (product.kind === 'combo') return 'Your eBook is ready now in the FullOnBaan Members Library (' + lib + ') — your access code has been emailed separately. Your video lectures will be delivered within 24 hours.';
  if (product.ebooks.length) return 'Your eBooks are ready now in the FullOnBaan Members Library (' + lib + ') — your access code has been emailed separately.';
  return 'Your training material will be delivered within 24 hours.';
}
function adminDelivery(product) {
  if (!product) return '';
  if (product.kind === 'combo') return ' Delivery: eBook unlocked automatically in the Members Library; VIDEO ACCESS TO BE SENT MANUALLY.';
  if (product.ebooks.length) return ' Delivery: eBooks unlocked automatically in the Members Library.';
  return ' Delivery: VIDEO ACCESS TO BE SENT MANUALLY.';
}

async function paymentEmails(rec, productKey, siteUrl) {
  const product = catalog.getProduct(productKey);
  const amt = pay.fmtMoney(rec.totalAmt, rec.currency);
  const mobile = rec.mobile ? (rec.mobileCode || '+91') + ' ' + rec.mobile : '(not provided)';
  const common = { order_ref: rec.orderId, utr_number: rec.paymentId, guide: rec.module, amount: amt, cust_name: rec.name, cust_email: rec.email, cust_mobile: mobile };
  const tableRows = [['Invoice No', rec.invoiceNo], ['Order Ref', rec.orderId], ['Payment ID', rec.paymentId], ['Product', rec.module],
    ['Amount paid', amt + (rec.currency === 'INR' ? ' (Base ' + pay.fmtMoney(rec.baseAmt, 'INR') + ' + GST ' + pay.fmtMoney(rec.gstAmt, 'INR') + ')' : '')]];
  const refRow = rec.refCode ? [['Referred by', 'Partner ' + rec.refCode]] : [];
  try {
    await mail.sendTemplateOrHtml(TPL_OK(), Object.assign({}, common, {
      to_email: ADMIN_EMAIL(), subject: 'New Training Order — ' + rec.module, status: 'PAYMENT CONFIRMED — RAZORPAY',
      message: 'Invoice No: ' + rec.invoiceNo + '. Razorpay Payment ID: ' + rec.paymentId + '. Currency: ' + rec.currency + '.' + adminDelivery(product) +
        (rec.refCode ? ' Referred by partner ' + rec.refCode + '.' : '')
    }), 'New training order', tableRows.concat([['Customer', rec.name + ' · ' + rec.email + ' · ' + mobile]], refRow));
  } catch (e) { console.error('admin order email failed', e); }
  try {
    await mail.sendTemplateOrHtml(TPL_OK(), Object.assign({}, common, {
      to_email: rec.email, subject: 'Your FullonBaan Tax Invoice — ' + rec.invoiceNo, status: 'PAYMENT CONFIRMED',
      message: 'Thank you! Your Razorpay payment (ID: ' + rec.paymentId + ') was successful. Invoice No: ' + rec.invoiceNo + '. ' +
        deliveryText(product, siteUrl) + ' Your GST invoice is downloadable from the confirmation page. For support: support@fullonbaan.com'
    }), 'Payment confirmed — thank you!', tableRows);
  } catch (e) { console.error('customer confirmation email failed', e); }
}

// Unlock + register + emails. Safe to call any number of times for the same order.
async function settle(order, payment, siteUrl, via) {
  const f = await members.fulfilOrder(order, payment, siteUrl, via);
  let rec = null;
  try { rec = await ensureInvoice(order, payment, siteUrl); }
  catch (e) { console.error('ORDER PAID BUT REGISTER/INVOICE FAILED', order.id, e); }
  // Partner commission line (once per order). Never allowed to break fulfilment.
  let referral = null;
  try { referral = await referrals.recordSale(order, payment, rec, siteUrl); }
  catch (e) { console.error('REFERRAL COMMISSION NOT RECORDED', order.id, (order.notes || {}).ref, e); }
  return { fulfil: f, record: rec, invoice: pay.invoiceView(rec), referral };
}

// Alerts you about a failed / abandoned checkout. Only for real orders our server created,
// only to YOUR address, at most once per order and type — so it can't be used to send spam.
async function alertAdmin(orderRef, type, reason) {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(String(orderRef || ''))) return false;
  // Hard daily cap on alert emails so nobody can drain the EmailJS quota that customers' emails need.
  if (!(await RL.allow('alerts', 'global', Number(process.env.RL_ALERTS_PER_DAY || 25), 86400))) return false;
  let send = null;
  await pay.upsertRecord(orderRef, (cur) => {
    if (!cur || cur.status !== 'initiated') return null;
    cur.alerts = cur.alerts || {};
    if (cur.alerts[type]) return null;
    cur.alerts[type] = new Date().toISOString();
    if (type === 'failed') { cur.status = 'failed'; cur.failedAt = new Date().toISOString(); }
    send = cur; return cur;
  }, 'lnpay: ' + type + ' ' + orderRef);
  if (!send) return false;
  const why = String(reason || '').replace(/[\u0000-\u001f<>]/g, ' ').slice(0, 160);
  const base = {
    to_email: ADMIN_EMAIL(), order_ref: orderRef, guide: send.module, amount: pay.fmtMoney(send.totalAmt, send.currency),
    cust_name: send.name, cust_email: send.email, cust_mobile: send.mobile ? (send.mobileCode || '+91') + ' ' + send.mobile : '(not provided)', utr_number: '(none)'
  };
  const rowsFor = [['Order Ref', orderRef], ['Product', send.module], ['Amount', base.amount], ['Customer', send.name + ' · ' + send.email + ' · ' + base.cust_mobile]];
  if (type === 'failed') {
    await mail.sendTemplateOrHtml(TPL_FAIL(), Object.assign(base, { subject: 'Payment Failed — ' + send.module, status: 'PAYMENT FAILED',
      message: 'Razorpay payment failed.' + (why ? ' Reason: ' + why + '.' : '') + ' Order Ref: ' + orderRef + '. Currency: ' + send.currency }), 'Payment failed', rowsFor);
  } else {
    await mail.sendTemplateOrHtml(TPL_OK(), Object.assign(base, { subject: '⚠️ Checkout closed without payment — ' + send.name, status: 'CHECKOUT ABANDONED',
      message: 'Customer opened Razorpay checkout but closed it without completing payment. Order Ref: ' + orderRef }), 'Checkout closed without payment', rowsFor);
  }
  return true;
}

module.exports = { settle, ensureInvoice, alertAdmin, deliveryText };
