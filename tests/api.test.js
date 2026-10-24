// Offline test suite — run with:  npm test   (no network, no real payments; Razorpay/R2/GitHub/EmailJS are mocked)
// End-to-end API tests against the real handlers (mocked Razorpay / R2 / GitHub / EmailJS).
const { T } = require('./env');
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const seed = require('./seed');
const mock = require('./mockrzp');
const ROOT = process.env.TRAINING_DIR;
const catalog = require(ROOT + '/api/_lib/catalog');
const sale = require(ROOT + '/src/_data/sale.js');
const products = require(ROOT + '/src/_data/products.js');
const { PDFDocument } = require('pdf-lib');

let BASE, server, passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✔', name); }
  catch (e) { failed++; fails.push(name); console.log('  ✘', name, '\n     ', e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e); }
}
const mails = () => fs.existsSync(process.env.FOB_EMAIL_LOG) ? fs.readFileSync(process.env.FOB_EMAIL_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const clearMails = () => { try { fs.appendFileSync(process.env.FOB_EMAIL_LOG + '.all', fs.readFileSync(process.env.FOB_EMAIL_LOG)); fs.unlinkSync(process.env.FOB_EMAIL_LOG); } catch (e) {} };
const allText = () => { let t = ''; try { t += fs.readFileSync(process.env.FOB_EMAIL_LOG + '.all', 'utf8'); } catch (e) {} try { t += fs.readFileSync(process.env.FOB_EMAIL_LOG, 'utf8'); } catch (e) {} return t; };
const records = () => { const p = path.join(process.env.FOB_GH_LOCAL, 'payments/ln_payments.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : []; };
const counter = () => { const p = path.join(process.env.FOB_GH_LOCAL, 'payments/invoice_counter.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')).counter : 0; };
const member = (email) => { const h = crypto.createHash('sha256').update(email.trim().toLowerCase()).digest('hex'); const p = path.join(process.env.FOB_LOCAL_STORE, 'members', h + '.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };

async function req(method, p, body, headers) {
  const r = await fetch(BASE + p, { method, redirect: 'manual', headers: Object.assign(body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  let data = null; const txt = await r.text(); try { data = JSON.parse(txt); } catch (e) { data = txt; }
  return { status: r.status, data, headers: r.headers, cookie: r.headers.get('set-cookie') };
}
const ADMIN = { Authorization: 'Bearer ' + process.env.ADMIN_API_TOKEN };
const billingKA = { billCountry: 'IN', billStateCode: '29', billStateName: 'Karnataka', billLine1: '12 MG Road', billCity: 'Bangalore', billPincode: '560001' };
const billingMH = { billCountry: 'IN', billStateCode: '27', billStateName: 'Maharashtra', billLine1: '1 Marine Dr', billCity: 'Mumbai', billPincode: '400001' };

async function buy(product, email, opts) {
  opts = opts || {};
  const o = await req('POST', '/api/checkout?action=order', { product, currency: opts.currency || 'INR', customer: { name: opts.name || 'Test Buyer', email, mobile: '9876543210', mobileCode: '+91' }, billing: opts.billing || billingMH, notes: { bill_city: 'Mumbai', bill_country: 'IN' } });
  assert.strictEqual(o.status, 200, 'order failed: ' + JSON.stringify(o.data));
  const pay = mock.pay(o.data.orderId, opts.mode || 'captured');
  const v = await req('POST', '/api/checkout?action=verify', pay);
  return { order: o.data, pay, verify: v };
}
function webhook(event, orderId, paymentId, secret) {
  const body = JSON.stringify({ event, payload: { order: { entity: { id: orderId } }, payment: { entity: mock.state.payments[paymentId] } } });
  const sig = crypto.createHmac('sha256', secret || process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  return req('POST', '/api/razorpay-webhook', body, { 'x-razorpay-signature': sig, 'Content-Type': 'application/json' });
}

// Client-side price computation, taken from the BUILT page (the code the browser runs)
function clientPricer(atMs) {
  const html = fs.readFileSync(ROOT + '/_site/pricing/index.html', 'utf8');
  const grab = (re) => { const m = html.match(re); if (!m) throw new Error('not found ' + re); return m[1]; };
  const src = [
    'var FOB_SALE = ' + grab(/var FOB_SALE = (\{.*?\});\n/) + ';',
    'var Date = { now: function(){ return ' + atMs + '; } };',
    grab(/(function fobSaleActive\(\)\{.*?\})\n/),
    grab(/(function fobSaleFor\(key, currency\)\{[\s\S]*?\n    \})\n/),
    'var CURRENCY_RATES = ' + grab(/var CURRENCY_RATES = (\{.*?\});/) + ';',
    'var FIXED_PRICES = ' + grab(/var FIXED_PRICES = (\{.*?\});/) + ';',
    grab(/(function convertPrice\(inrAmount, currency\) \{[\s\S]*?\n    \})\n/),
    'var GST_RATE = 0.18;',
    grab(/(function calcGSTFromBase\(basePrice\) \{[\s\S]*?\n  \})\n/),
    'var GUIDES = ' + grab(/  var GUIDES = (\{.*?\});/) + ';',
    'return function(k, cur){ var s=fobSaleFor(k,cur); var price = s ? s.now : convertPrice(GUIDES[k].price, cur); return cur==="INR" ? calcGSTFromBase(price).total : price; };'
  ].join('\n');
  return Function(src)();
}

(async () => {
  await seed(process.env.FOB_LOCAL_STORE);
  server = require('./harness');
  await new Promise(r => server.listen(0, r));
  BASE = 'http://127.0.0.1:' + server.address().port;
  console.log('Test store:', T);

  console.log('\n[1] Pricing — server charge == what the page shows (every product × currency × sale state)');
  await test('server price equals the browser price for all 35 products, 3 currencies, before / during / after the sale', async () => {
    const times = { before: sale.startsMs - 3600e3, during: sale.startsMs + 3600e3, after: sale.endsMs + 3600e3 };
    let n = 0;
    for (const [label, t] of Object.entries(times)) {
      const client = clientPricer(t);
      for (const k of Object.keys(products.products)) for (const cur of ['INR', 'USD', 'EUR']) {
        const sv = catalog.quote(k, cur, { at: t });
        const cl = client(k, cur);
        assert.strictEqual(sv.amountMinor, Math.round(cl * 100), `${label} ${k} ${cur}: server ${sv.amountMinor} vs page ${Math.round(cl * 100)}`);
        n++;
      }
    }
    assert.strictEqual(n, 3 * 35 * 3);
  });
  await test('spot values: dev eBook ₹1,999 + GST = ₹2,358.82; Full eBook Library on sale ₹7,999 + GST; USD $199', () => {
    const during = sale.startsMs + 1000;
    assert.strictEqual(catalog.quote('dev_ebook', 'INR', { at: during }).amountMinor, 235882);
    assert.strictEqual(catalog.quote('full_ebook_library', 'INR', { at: during }).base, 7999);
    assert.strictEqual(catalog.quote('full_ebook_library', 'INR', { at: sale.endsMs + 1 }).base, 15999);
    assert.strictEqual(catalog.quote('full_ebook_library', 'USD', { at: during }).total, 199);
    assert.strictEqual(catalog.quote('dev_combo', 'EUR', { at: during }).total, 100);
    const ka = catalog.quote('dev_ebook', 'INR', { stateCode: '29' }), mh = catalog.quote('dev_ebook', 'INR', { stateCode: '27' });
    assert.strictEqual(ka.taxType, 'CGST_SGST'); assert.strictEqual(mh.taxType, 'IGST');
    assert.strictEqual(ka.cgst + ka.sgst, mh.igst); assert.strictEqual(ka.total, mh.total);
  });
  await test('every product maps to the right eBook folders (videos unlock nothing, combos only the eBook)', () => {
    const P = products.products;
    Object.keys(P).forEach(k => {
      if (P[k].kind === 'video') assert.deepStrictEqual(P[k].ebooks, [], k);
      if (P[k].kind === 'combo') { assert.strictEqual(P[k].ebooks.length, 1, k); assert.ok(P[k].video, k); assert.strictEqual(P[k].ebooks[0], products.EBOOK_FOLDERS[P[k].ebooks[0]] && P[k].ebooks[0]); }
      if (P[k].kind === 'ebook') assert.strictEqual(products.EBOOK_FOLDERS[P[k].ebooks[0]].product, k, k);
    });
    assert.strictEqual(P.full_ebook_library.ebooks.length, 17);
    assert.deepStrictEqual(P.full_video_library.ebooks, []);
    assert.strictEqual(Object.keys(P).length, 35);
  });

  console.log('\n[2] eBook purchase — new customer');
  let alice = 'Alice@Example.com', aliceCode, aliceCookie;
  await test('dev eBook: order → pay → verify unlocks the library, issues a code, numbers the invoice', async () => {
    clearMails();
    const b = await buy('dev_ebook', alice, { billing: billingKA, name: 'Alice Rao' });
    assert.strictEqual(b.verify.status, 200, JSON.stringify(b.verify.data));
    const d = b.verify.data;
    assert.ok(d.ok && d.access && !d.video && d.code && /^FOB-[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(d.code), JSON.stringify(d));
    assert.strictEqual(d.email, 'alice@example.com');
    assert.deepStrictEqual(d.unlocked, ['Infor LN Development']);
    assert.ok(d.invoice && /^FOB\d{7}$/.test(d.invoice.invNo)); assert.strictEqual(d.invoice.taxType, 'CGST_SGST');
    assert.strictEqual(d.invoice.totalAmt, 2358.82); assert.strictEqual(d.invoice.module, 'Infor LN Development — eBook');
    aliceCode = d.code;
    const m = member(alice); assert.ok(m.entitlements.dev); assert.ok(m.codeHash.startsWith('scrypt$')); assert.ok(!JSON.stringify(m).includes(aliceCode), 'code stored in plain text!');
    const rec = records().find(r => r.orderId === b.order.orderRef);
    assert.strictEqual(rec.status, 'confirmed'); assert.strictEqual(rec.invoiceNo, d.invoice.invNo); assert.strictEqual(rec.paymentId, b.pay.razorpay_payment_id);
    assert.strictEqual(rec.billStateCode, '29'); assert.strictEqual(rec.cgstAmt, 179.91); assert.strictEqual(rec.sgstAmt, 179.91);
    assert.ok(rec.confirmedAt && rec.initiatedAt && rec.module);
    const ms = mails();
    const welcome = ms.find(x => x.kind === 'html' && x.to === 'alice@example.com');
    assert.ok(welcome && welcome.subject.includes('access code') && welcome.text.includes(aliceCode), 'welcome email with code');
    assert.ok(!welcome.html.includes('video lectures'), 'no video note for eBook-only');
    const inv = ms.find(x => x.kind === 'template' && x.to === 'alice@example.com');
    assert.ok(inv && inv.template === 'FOB_Razorpay_Success' && inv.subject.includes(d.invoice.invNo) && inv.params.message.includes('Members Library'));
    const adm = ms.find(x => x.kind === 'template' && x.to === 'fullonbaan@gmail.com');
    assert.ok(adm && adm.params.message.includes('unlocked automatically') && adm.subject.startsWith('New Training Order'));
    assert.strictEqual(ms.length, 3, 'exactly 3 emails: ' + ms.map(x => x.subject).join(' | '));
  });
  await test('Razorpay order is created with the server price, ≤15 notes, site tag and server order ref', async () => {
    const o = Object.values(mock.state.orders).find(x => x.notes.cust_email === 'alice@example.com');
    assert.strictEqual(o.amount, 235882); assert.strictEqual(o.notes.site, 'training'); assert.ok(/^FOBT\d+$/.test(o.notes.order_ref));
    assert.ok(Object.keys(o.notes).length <= 15); assert.strictEqual(o.receipt, o.notes.order_ref);
  });

  console.log('\n[3] Idempotency — verify + webhook + retries never double-unlock, double-invoice or double-email');
  await test('verify again, then webhook order.paid and payment.captured → same invoice, no new emails, counter +0', async () => {
    const o = Object.values(mock.state.orders).find(x => x.notes.cust_email === 'alice@example.com');
    const pay = Object.values(mock.state.payments).find(p => p.order_id === o.id);
    const c0 = counter(); clearMails();
    const sig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(o.id + '|' + pay.id).digest('hex');
    const v2 = await req('POST', '/api/checkout?action=verify', { razorpay_order_id: o.id, razorpay_payment_id: pay.id, razorpay_signature: sig });
    assert.strictEqual(v2.status, 200); assert.strictEqual(v2.data.code, null, 'code must not be re-shown');
    const w1 = await webhook('order.paid', o.id, pay.id), w2 = await webhook('payment.captured', o.id, pay.id);
    assert.strictEqual(w1.status, 200); assert.ok(w1.data.duplicate); assert.strictEqual(w2.status, 200);
    assert.strictEqual(counter(), c0); assert.strictEqual(mails().length, 0, 'no repeat emails');
    assert.strictEqual(member(alice).orders.length, 1);
  });
  await test('verify and webhook arriving at the same moment → one invoice number, one set of emails', async () => {
    clearMails(); const c0 = counter();
    const o = await req('POST', '/api/checkout?action=order', { product: 'fin_ebook', currency: 'INR', customer: { name: 'Race Test', email: 'race@example.com', mobile: '9999999999' }, billing: billingMH });
    const p = mock.pay(o.data.orderId);
    const [v, w] = await Promise.all([req('POST', '/api/checkout?action=verify', p), webhook('order.paid', p.razorpay_order_id, p.razorpay_payment_id)]);
    assert.strictEqual(v.status, 200); assert.strictEqual(w.status, 200);
    assert.strictEqual(counter(), c0 + 1, 'counter incremented exactly once');
    const recs = records().filter(r => r.orderId === o.data.orderRef); assert.strictEqual(recs.length, 1); assert.ok(recs[0].invoiceNo);
    const ms = mails(); assert.strictEqual(ms.filter(x => x.kind === 'html').length, 1, 'one welcome'); assert.strictEqual(ms.filter(x => x.kind === 'template').length, 2, 'one invoice + one admin alert');
  });
  await test('customer closes the tab → webhook alone delivers access, invoice and emails', async () => {
    clearMails();
    const o = await req('POST', '/api/checkout?action=order', { product: 'cloud_migration', currency: 'INR', customer: { name: 'Tab Closer', email: 'closer@example.com', mobile: '9999999999' }, billing: billingMH });
    const p = mock.pay(o.data.orderId);
    const w = await webhook('order.paid', p.razorpay_order_id, p.razorpay_payment_id);
    assert.strictEqual(w.status, 200, JSON.stringify(w.data)); assert.ok(w.data.invoice);
    assert.ok(member('closer@example.com').entitlements.cloud);
    assert.strictEqual(records().find(r => r.orderId === o.data.orderRef).status, 'confirmed');
    assert.ok(mails().some(x => x.kind === 'html' && x.to === 'closer@example.com' && /FOB-[A-Z2-9]{5}-[A-Z2-9]{5}/.test(x.text)));
  });
  await test('payment only authorized (not auto-captured) → verify captures it, then fulfils', async () => {
    const b = await buy('ion_ebook', 'auth@example.com', { mode: 'authorized' });
    assert.strictEqual(b.verify.status, 200, JSON.stringify(b.verify.data));
    assert.strictEqual(mock.state.payments[b.pay.razorpay_payment_id].status, 'captured');
    assert.ok(member('auth@example.com').entitlements.ion);
  });

  console.log('\n[4] Returning customer, combo, bundle, video');
  await test('Alice buys a combo → eBook added to the SAME library, no new code, video note in emails', async () => {
    clearMails();
    const b = await buy('fin_combo', 'alice@example.com');
    const d = b.verify.data;
    assert.ok(d.access && d.video && d.returning && d.code === null, JSON.stringify(d));
    const m = member(alice); assert.ok(m.entitlements.dev && m.entitlements.fin); assert.strictEqual(m.orders.length, 2);
    const ms = mails();
    const upd = ms.find(x => x.kind === 'html'); assert.ok(upd.subject.includes('added') && upd.html.includes('video lectures') && !/FOB-[A-Z2-9]{5}-/.test(upd.text));
    const inv = ms.find(x => x.kind === 'template' && x.to === 'alice@example.com'); assert.ok(inv.params.message.includes('video lectures will be delivered within 24 hours'));
    const adm = ms.find(x => x.to === 'fullonbaan@gmail.com'); assert.ok(adm.params.message.includes('VIDEO ACCESS TO BE SENT MANUALLY'));
  });
  await test('video course → NO library access, NO code, existing confirmation + admin alert (deliver manually)', async () => {
    clearMails();
    const b = await buy('dev_video', 'videoonly@example.com', { name: 'Video Buyer' });
    const d = b.verify.data;
    assert.strictEqual(b.verify.status, 200, JSON.stringify(d));
    assert.ok(d.ok && !d.access && d.video && d.code === null && d.invoice && d.invoice.invNo, JSON.stringify(d));
    assert.strictEqual(member('videoonly@example.com'), null, 'no member record for video-only');
    const ms = mails();
    assert.strictEqual(ms.filter(x => x.kind === 'html').length, 0, 'no library email');
    const inv = ms.find(x => x.to === 'videoonly@example.com'); assert.ok(inv && inv.params.message.includes('delivered within 24 hours') && !inv.params.message.includes('Members Library'));
    assert.ok(ms.find(x => x.to === 'fullonbaan@gmail.com').params.message.includes('VIDEO ACCESS TO BE SENT MANUALLY'));
    assert.strictEqual(records().find(r => r.orderId === b.order.orderRef).status, 'confirmed');
  });
  await test('Full Video Library → confirmation only, no access', async () => {
    const b = await buy('full_video_library', 'videolib@example.com');
    assert.ok(b.verify.data.ok && !b.verify.data.access && b.verify.data.video);
    assert.strictEqual(member('videolib@example.com'), null);
  });
  await test('Full eBook Library (on sale) in USD → all 17 kits unlocked, charged $199, no GST', async () => {
    const b = await buy('full_ebook_library', 'bundle@example.com', { currency: 'USD', billing: { billCountry: 'US', billStateName: 'CA', billLine1: 'x', billCity: 'SF', billPincode: '94000' } });
    assert.strictEqual(b.order.amount, catalog.priceMinor('full_ebook_library', 'USD'));
    assert.strictEqual(b.verify.status, 200, JSON.stringify(b.verify.data));
    assert.strictEqual(Object.keys(member('bundle@example.com').entitlements).length, 17);
    const inv = b.verify.data.invoice; assert.strictEqual(inv.taxType, 'NONE'); assert.strictEqual(inv.gstAmt, 0); assert.strictEqual(inv.currency, 'USD');
    if (catalog.saleLive()) assert.ok(inv.module.includes('% off'), 'sale recorded on invoice');
  });

  console.log('\n[5] Security');
  await test('forged signature → 400, nothing unlocked', async () => {
    const o = await req('POST', '/api/checkout?action=order', { product: 'bod_ebook', currency: 'INR', customer: { name: 'Mallory', email: 'mallory@example.com' }, billing: billingMH });
    const p = mock.pay(o.data.orderId); p.razorpay_signature = 'f'.repeat(64);
    const v = await req('POST', '/api/checkout?action=verify', p);
    assert.strictEqual(v.status, 400); assert.strictEqual(member('mallory@example.com'), null);
  });
  await test('payment from a cheap order replayed against an expensive order → 400', async () => {
    const cheap = await req('POST', '/api/checkout?action=order', { product: 'bod_ebook', currency: 'INR', customer: { name: 'M', email: 'mallory@example.com' }, billing: billingMH });
    const dear = await req('POST', '/api/checkout?action=order', { product: 'full_ebook_library', currency: 'INR', customer: { name: 'M', email: 'mallory@example.com' }, billing: billingMH });
    const p = mock.pay(cheap.data.orderId);
    const sig = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(dear.data.orderId + '|' + p.razorpay_payment_id).digest('hex');
    const v = await req('POST', '/api/checkout?action=verify', { razorpay_order_id: dear.data.orderId, razorpay_payment_id: p.razorpay_payment_id, razorpay_signature: sig });
    assert.strictEqual(v.status, 400); assert.ok(!member('mallory@example.com'));
  });
  await test('order with a tampered amount (not our price) is refused at fulfilment', async () => {
    const id = 'order_tampered1';
    mock.state.orders[id] = { id, amount: 100, currency: 'INR', receipt: 'FOBTX', status: 'created', created_at: Math.floor(Date.now() / 1000), notes: { site: 'training', product_key: 'full_ebook_library', cust_email: 'cheat@example.com', order_ref: 'FOBTX1' } };
    const p = mock.pay(id);
    const v = await req('POST', '/api/checkout?action=verify', p);
    assert.strictEqual(v.status, 500); assert.strictEqual(member('cheat@example.com'), null);
  });
  await test('client cannot override product/email/order_ref through notes; unknown product / bad email / no name rejected', async () => {
    const o = await req('POST', '/api/checkout?action=order', { product: 'bod_ebook', currency: 'INR', customer: { name: 'N', email: 'n@example.com' }, notes: { product_key: 'full_ebook_library', cust_email: 'evil@x.com', order_ref: 'X', site: 'other', price_at: '1', a: '' }, billing: billingMH });
    const n = mock.state.orders[o.data.orderId].notes;
    assert.strictEqual(n.product_key, 'bod_ebook'); assert.strictEqual(n.cust_email, 'n@example.com'); assert.notStrictEqual(n.order_ref, 'X'); assert.strictEqual(n.site, 'training'); assert.notStrictEqual(n.price_at, '1');
    assert.strictEqual((await req('POST', '/api/checkout?action=order', { product: 'nope', customer: { name: 'a', email: 'a@b.co' } })).status, 400);
    assert.strictEqual((await req('POST', '/api/checkout?action=order', { product: 'dev_ebook', currency: 'GBP', customer: { name: 'a', email: 'a@b.co' } })).status, 400);
    assert.strictEqual((await req('POST', '/api/checkout?action=order', { product: 'dev_ebook', customer: { name: 'a', email: 'bad' } })).status, 400);
    assert.strictEqual((await req('POST', '/api/checkout?action=order', { product: 'dev_ebook', customer: { name: '', email: 'a@b.co' } })).status, 400);
    assert.strictEqual((await req('POST', '/api/checkout?action=order', { product: '__proto__', customer: { name: 'a', email: 'a@b.co' } })).status, 400);
  });
  await test('cross-site POST blocked; GET not allowed', async () => {
    assert.strictEqual((await req('POST', '/api/checkout?action=order', { product: 'dev_ebook' }, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.strictEqual((await req('GET', '/api/checkout?action=order')).status, 405);
  });
  await test('webhook: bad signature 400; another site\'s order ignored with 200 (no retry storm)', async () => {
    const id = 'order_othersite';
    mock.state.orders[id] = { id, amount: 69900, currency: 'INR', status: 'paid', created_at: 1, notes: { product_key: 'dev', cust_email: 'x@y.z' } };
    const p = mock.pay(id);
    assert.strictEqual((await webhook('order.paid', id, p.razorpay_payment_id, 'wrong')).status, 400);
    const w = await webhook('order.paid', id, p.razorpay_payment_id);
    assert.strictEqual(w.status, 200); assert.ok(String(w.data.ignored).includes('not a training order'));
    assert.strictEqual((await webhook('refund.created', id, p.razorpay_payment_id)).data.ignored, 'refund.created');
  });
  await test('sale ended between order and payment → still fulfils at the price that was charged', async () => {
    const at = sale.startsMs + 1000;     // order made during the sale
    const id = 'order_saleend';
    mock.state.orders[id] = { id, amount: catalog.priceMinor('full_ebook_library', 'INR', at), currency: 'INR', receipt: 'FOBTSALE', status: 'created', created_at: Math.floor(at / 1000), notes: { site: 'training', product_key: 'full_ebook_library', cust_email: 'late@example.com', cust_name: 'Late', order_ref: 'FOBTSALE1', price_at: String(at) } };
    const p = mock.pay(id);
    const v = await req('POST', '/api/checkout?action=verify', p);
    assert.strictEqual(v.status, 200, JSON.stringify(v.data)); assert.strictEqual(Object.keys(member('late@example.com').entitlements).length, 17);
  });
  await test('Razorpay down → order endpoint returns a friendly 500, no register line', async () => {
    const before = records().length; process.env.MOCK_RZP_DOWN = '1';
    const o = await req('POST', '/api/checkout?action=order', { product: 'dev_ebook', currency: 'INR', customer: { name: 'a', email: 'down@example.com' } });
    delete process.env.MOCK_RZP_DOWN;
    assert.strictEqual(o.status, 500); assert.ok(o.data.error.includes('try again')); assert.strictEqual(records().length, before);
  });

  console.log('\n[6] Members area');
  await test('wrong code → 401 generic; 5 wrong → locked even with the right code', async () => {
    const r1 = await req('POST', '/api/member?action=login', { email: 'race@example.com', code: 'FOB-AAAAA-AAAAA' });
    assert.strictEqual(r1.status, 401); assert.ok(!r1.cookie);
    for (let i = 0; i < 4; i++) await req('POST', '/api/member?action=login', { email: 'race@example.com', code: 'FOB-AAAAA-AAAAA' });
    const ghost = await req('POST', '/api/member?action=login', { email: 'nobody@example.com', code: 'FOB-AAAAA-AAAAA' });
    assert.strictEqual(ghost.status, 401); assert.strictEqual(ghost.data.error, r1.data.error, 'no user-exists leak');
    assert.ok(member('race@example.com').failed.lockedUntil > Date.now());
  });
  await test('Alice signs in (code in any format) → HttpOnly Secure SameSite cookie; library shows dev + fin only', async () => {
    const r = await req('POST', '/api/member?action=login', { email: ' ALICE@example.com ', code: aliceCode.toLowerCase().replace(/-/g, ' ') });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(/HttpOnly/.test(r.cookie) && /Secure/.test(r.cookie) && /SameSite=Lax/.test(r.cookie));
    aliceCookie = r.cookie.split(';')[0];
    const me = await req('GET', '/api/member?action=me', undefined, { Cookie: aliceCookie });
    assert.strictEqual(me.status, 200);
    assert.deepStrictEqual(me.data.library.owned.sort(), ['dev', 'fin']);
    assert.deepStrictEqual(Object.keys(me.data.files).sort(), ['dev', 'fin'], 'files only for owned kits');
    assert.deepStrictEqual(me.data.files.dev.map(f => f.title), ['Sessions & 4GL', 'DAL Scripts'], 'ordered, prefix hidden, draft hidden');
    assert.strictEqual(Object.keys(me.data.catalog).length, 17); assert.strictEqual(me.data.catalog.os.count, 1);
  });
  let stampedPath;
  await test('Read online → 302 to a short-lived link of a personal watermarked copy', async () => {
    const r = await req('GET', '/api/member?action=file&mode=view&g=dev&f=' + encodeURIComponent('dev/01 - Sessions & 4GL.pdf'), undefined, { Cookie: aliceCookie });
    assert.strictEqual(r.status, 302); const loc = r.headers.get('location');
    assert.ok(loc.startsWith('/__local/stamped/') && loc.includes('ttl=300') && loc.includes('disp=inline'), loc);
    stampedPath = decodeURIComponent(loc.split('?')[0].slice('/__local/'.length));
    const pdf = await PDFDocument.load(fs.readFileSync(path.join(process.env.FOB_LOCAL_STORE, stampedPath)));
    assert.ok(pdf.getSubject().includes('alice@example.com'), 'buyer in PDF metadata'); assert.strictEqual(pdf.getPageCount(), 3);
    const raw = fs.readFileSync(path.join(process.env.FOB_LOCAL_STORE, stampedPath));
    assert.ok(raw.length > 1000);
    const m = member(alice); assert.strictEqual(m.downloads['dev/01 - Sessions & 4GL.pdf'], 1); assert.strictEqual(m.log.slice(-1)[0].mode, 'view');
  });
  await test('Download → attachment; second open reuses the same stamped copy', async () => {
    const r = await req('GET', '/api/member?action=file&mode=download&g=dev&f=' + encodeURIComponent('dev/01 - Sessions & 4GL.pdf'), undefined, { Cookie: aliceCookie });
    assert.strictEqual(r.status, 302); assert.ok(r.headers.get('location').includes('disp=attachment'));
    assert.strictEqual(decodeURIComponent(r.headers.get('location').split('?')[0].slice('/__local/'.length)), stampedPath);
  });
  await test('kit not owned → forbidden; path traversal / drafts / unknown → refused; no session → login', async () => {
    const f = async (q, c) => (await req('GET', '/api/member?action=file&' + q, undefined, c === undefined ? { Cookie: aliceCookie } : c)).headers.get('location');
    assert.strictEqual(await f('g=cloud&f=' + encodeURIComponent('cloud/01 - Cloud Strategy.pdf')), '/members/?e=forbidden');
    assert.strictEqual(await f('g=dev&f=' + encodeURIComponent('dev/../cloud/01 - Cloud Strategy.pdf')), '/members/?e=unknown');
    assert.strictEqual(await f('g=dev&f=' + encodeURIComponent('dev/_draft next.pdf')), '/members/?e=unknown');
    assert.strictEqual(await f('g=dev&f=' + encodeURIComponent('fin/General Ledger.pdf')), '/members/?e=unknown');
    assert.strictEqual(await f('g=zzz&f=x'), '/members/?e=unknown');
    assert.strictEqual(await f('g=dev&f=x', {}), '/members/?e=login');
    assert.strictEqual(await f('g=dev&f=x', { Cookie: 'fob_mem=forged.sig' }), '/members/?e=login');
  });
  await test('Excel tool → always a download, served unmodified with the right type', async () => {
    // closer's code came by email earlier — recover it from the log
    const all = allText();
    const code = all.match(/closer@example\.com[\s\S]*?Access code: (FOB-[A-Z2-9]{5}-[A-Z2-9]{5})/)[1];
    const r = await req('POST', '/api/member?action=login', { email: 'closer@example.com', code });
    assert.strictEqual(r.status, 200);
    const ck = r.cookie.split(';')[0];
    const me = await req('GET', '/api/member?action=me', undefined, { Cookie: ck });
    const x = me.data.files.cloud.find(f => f.ext === 'xlsx'); assert.ok(x && x.title === 'Migration Planner');
    const d = await req('GET', '/api/member?action=file&mode=view&g=cloud&f=' + encodeURIComponent(x.id), undefined, { Cookie: ck });
    const loc = d.headers.get('location'); assert.ok(loc.includes('ebooks/cloud/') && loc.includes('disp=attachment'), loc);
  });
  await test('download cap per eBook is enforced', async () => {
    process.env.DOWNLOAD_LIMIT_PER_GUIDE = '3';
    let last;
    for (let i = 0; i < 3; i++) last = await req('GET', '/api/member?action=file&mode=view&g=dev&f=' + encodeURIComponent('dev/02 - DAL Scripts.pdf'), undefined, { Cookie: aliceCookie });
    assert.ok(last.headers.get('location').startsWith('/__local/'));
    const over = await req('GET', '/api/member?action=file&mode=view&g=dev&f=' + encodeURIComponent('dev/02 - DAL Scripts.pdf'), undefined, { Cookie: aliceCookie });
    assert.strictEqual(over.headers.get('location'), '/members/?e=limit');
    delete process.env.DOWNLOAD_LIMIT_PER_GUIDE;
  });
  await test('single-file layout (ebooks/os.pdf) works for owners', async () => {
    const me = await req('GET', '/api/member?action=me', undefined, { Cookie: aliceCookie });
    assert.ok(!me.data.files.os);   // Alice doesn't own os
    const all = allText();
    const code = all.match(/bundle@example\.com[\s\S]*?Access code: (FOB-[A-Z2-9]{5}-[A-Z2-9]{5})/)[1];
    const ck = (await req('POST', '/api/member?action=login', { email: 'bundle@example.com', code })).cookie.split(';')[0];
    const me2 = await req('GET', '/api/member?action=me', undefined, { Cookie: ck });
    assert.strictEqual(me2.data.files.os.length, 1); assert.strictEqual(me2.data.files.os[0].title, 'Infor OS');
    assert.strictEqual(me2.data.files.ai.length, 0);
    const r = await req('GET', '/api/member?action=file&mode=view&g=os&f=os.pdf', undefined, { Cookie: ck });
    assert.ok(r.headers.get('location').startsWith('/__local/stamped/'));
  });
  await test('resend: new code emailed, old code stops working, other sessions signed out; unknown email same answer', async () => {
    clearMails();
    const r = await req('POST', '/api/member?action=resend', { email: 'alice@example.com' });
    const r2 = await req('POST', '/api/member?action=resend', { email: 'stranger@example.com' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r2.data.message, r.data.message);
    const ms = mails(); assert.strictEqual(ms.length, 1, 'only the real member gets mail');
    const newCode = ms[0].text.match(/FOB-[A-Z2-9]{5}-[A-Z2-9]{5}/)[0];
    assert.strictEqual((await req('GET', '/api/member?action=me', undefined, { Cookie: aliceCookie })).status, 401, 'old session revoked');
    assert.strictEqual((await req('POST', '/api/member?action=login', { email: alice, code: aliceCode })).status, 401, 'old code dead');
    const ok = await req('POST', '/api/member?action=login', { email: alice, code: newCode });
    assert.strictEqual(ok.status, 200); aliceCode = newCode; aliceCookie = ok.cookie.split(';')[0];
    const again = await req('POST', '/api/member?action=resend', { email: 'alice@example.com' });
    assert.strictEqual(again.status, 200); assert.strictEqual(mails().length, 1, '2-minute gap between resends');
  });
  await test('login needs JSON + same-site; logout clears the cookie', async () => {
    assert.strictEqual((await req('POST', '/api/member?action=login', 'email=a', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.strictEqual((await req('POST', '/api/member?action=login', { email: alice, code: aliceCode }, { Origin: 'https://evil.example' })).status, 403);
    const lo = await req('POST', '/api/member?action=logout', {}, { Cookie: aliceCookie });
    assert.ok(/Max-Age=0/.test(lo.cookie));
  });

  console.log('\n[7] Admin');
  await test('member-admin: no / wrong token → 401', async () => {
    assert.strictEqual((await req('GET', '/api/member-admin?action=list')).status, 401);
    assert.strictEqual((await req('GET', '/api/member-admin?action=list', undefined, { Authorization: 'Bearer nope' })).status, 401);
  });
  await test('files: 17 kits with folders; init-folders creates ebooks/<code>/ markers (idempotent, hidden from buyers)', async () => {
    const f = await req('GET', '/api/member-admin?action=files', undefined, ADMIN);
    assert.strictEqual(f.status, 200); assert.strictEqual(f.data.guides.length, 17);
    assert.strictEqual(f.data.guides.find(g => g.key === 'dev').ebooks.length, 2);
    assert.strictEqual(f.data.products.length, 35);
    const i1 = await req('POST', '/api/member-admin?action=init-folders', {}, ADMIN);
    assert.strictEqual(i1.data.created.length, 17);
    assert.ok(fs.existsSync(path.join(process.env.FOB_LOCAL_STORE, 'ebooks/lnapi/.keep')));
    const i2 = await req('POST', '/api/member-admin?action=init-folders', {}, ADMIN); assert.strictEqual(i2.data.created.length, 0);
    const f2 = await req('GET', '/api/member-admin?action=files', undefined, ADMIN);
    assert.strictEqual(f2.data.guides.find(g => g.key === 'lnapi').ebooks.length, 0, '.keep not shown');
  });
  await test('upload-url for PDF and xlsx; upload then appears for buyers; rename; delete', async () => {
    const u = await req('POST', '/api/member-admin?action=upload-url', { guide: 'ai', filename: '01 - GenAI Playbook.pdf' }, ADMIN);
    assert.strictEqual(u.status, 200); assert.strictEqual(u.data.key, 'ebooks/ai/01 - GenAI Playbook.pdf'); assert.strictEqual(u.data.replaces, false);
    await fetch(BASE + u.data.url, { method: 'PUT', body: fs.readFileSync(path.join(process.env.FOB_LOCAL_STORE, 'ebooks/fin/General Ledger.pdf')) });
    const x = await req('POST', '/api/member-admin?action=upload-url', { guide: 'ai', filename: 'C:\\fakepath\\AI ROI calc.xlsx' }, ADMIN);
    assert.strictEqual(x.data.key, 'ebooks/ai/AI ROI calc.xlsx');
    assert.strictEqual((await req('POST', '/api/member-admin?action=upload-url', { guide: 'nope', filename: 'a.pdf' }, ADMIN)).status, 400);
    const mv = await req('POST', '/api/member-admin?action=move-file', { guide: 'ai', id: 'ai/01 - GenAI Playbook.pdf', name: '01 - GenAI Field Guide.pdf' }, ADMIN);
    assert.strictEqual(mv.status, 200); assert.strictEqual(mv.data.title, 'GenAI Field Guide');
    const files = (await req('GET', '/api/member-admin?action=files', undefined, ADMIN)).data.guides.find(g => g.key === 'ai').ebooks;
    assert.deepStrictEqual(files.map(e => e.title), ['GenAI Field Guide']);
    const del = await req('POST', '/api/member-admin?action=delete-file', { guide: 'ai', id: 'ai/01 - GenAI Field Guide.pdf' }, ADMIN);
    assert.strictEqual(del.status, 200);
    assert.strictEqual((await req('POST', '/api/member-admin?action=thumb-src', { guide: 'cloud', id: 'cloud/02 - Migration Planner.xlsx' }, ADMIN)).status, 400, 'no thumbnails for xlsx');
  });
  await test('grant (UPI buyer): product with eBooks → code + email; video-only product refused', async () => {
    clearMails();
    const g = await req('POST', '/api/member-admin?action=grant', { email: 'upi@example.com', name: 'UPI Buyer', product: 'adm_combo', note: 'UTR 1234' }, ADMIN);
    assert.strictEqual(g.status, 200); assert.ok(g.data.code); assert.deepStrictEqual(g.data.added, ['adm']);
    const ms = mails(); assert.ok(ms[0].text.includes(g.data.code) && ms[0].html.includes('video lectures'));
    assert.strictEqual((await req('POST', '/api/member-admin?action=grant', { email: 'upi@example.com', product: 'dev_video' }, ADMIN)).status, 400);
    const g2 = await req('POST', '/api/member-admin?action=grant', { email: 'upi@example.com', guides: ['dev', 'fin', 'bogus'], notify: false }, ADMIN);
    assert.deepStrictEqual(g2.data.added.sort(), ['dev', 'fin']); assert.strictEqual(g2.data.code, null);
  });
  await test('list / get (no code hash leaked) / revoke / reset-downloads / reset-code / disable', async () => {
    const l = await req('GET', '/api/member-admin?action=list', undefined, ADMIN);
    assert.ok(l.data.members.length >= 6);
    const g = await req('GET', '/api/member-admin?action=get&email=alice@example.com', undefined, ADMIN);
    assert.ok(g.data.member && !('codeHash' in g.data.member));
    const rv = await req('POST', '/api/member-admin?action=revoke', { email: 'upi@example.com', guide: 'fin' }, ADMIN);
    assert.ok(!rv.data.member.owned.includes('fin'));
    await req('POST', '/api/member-admin?action=reset-downloads', { email: 'alice@example.com', guide: 'dev' }, ADMIN);
    assert.deepStrictEqual(member(alice).downloads, {});
    const rc = await req('POST', '/api/member-admin?action=reset-code', { email: 'alice@example.com', notify: false }, ADMIN);
    assert.ok(rc.data.code); aliceCode = rc.data.code;
    await req('POST', '/api/member-admin?action=set-status', { email: 'alice@example.com', status: 'disabled' }, ADMIN);
    assert.strictEqual((await req('POST', '/api/member?action=login', { email: alice, code: aliceCode })).status, 401, 'disabled cannot sign in');
    await req('POST', '/api/member-admin?action=set-status', { email: 'alice@example.com', status: 'active' }, ADMIN);
    assert.strictEqual((await req('POST', '/api/member?action=login', { email: alice, code: aliceCode })).status, 200);
  });
  await test('/admin password session cookie also works for member-admin and payments', async () => {
    const s = await req('POST', '/api/admin-session', { password: 'pw-test' });
    assert.strictEqual(s.status, 200); const ck = s.cookie.split(';')[0];
    assert.strictEqual((await req('GET', '/api/member-admin?action=list', undefined, { Cookie: ck })).status, 200);
    assert.strictEqual((await req('POST', '/api/member-admin?action=init-folders', {}, { Cookie: ck, Origin: 'https://evil.example' })).status, 401, 'cross-site with cookie refused');
    const p = await req('GET', '/api/payments', undefined, { Cookie: ck });
    assert.strictEqual(p.status, 200); assert.ok(p.data.records.length >= 8);
  });
  await test('LOCKED DOWN: /api/payments POST and /api/invoice-counter GET no longer public', async () => {
    const c0 = counter();
    assert.strictEqual((await req('POST', '/api/payments', { record: { orderId: 'FOBTFAKE', status: 'confirmed', totalAmt: 1 } })).status, 401);
    assert.strictEqual((await req('GET', '/api/payments')).status, 401);
    assert.strictEqual((await req('GET', '/api/invoice-counter')).status, 401);
    assert.strictEqual(counter(), c0); assert.ok(!records().some(r => r.orderId === 'FOBTFAKE'));
    const ok = await req('GET', '/api/invoice-counter', undefined, ADMIN); assert.strictEqual(ok.status, 200); assert.strictEqual(counter(), c0 + 1);
  });

  console.log('\n[8] Failure / abandon alerts');
  await test('abandon → one admin alert; repeat → none; failed → status failed + failure template; fake refs ignored', async () => {
    clearMails();
    const o = await req('POST', '/api/checkout?action=order', { product: 'pln_ebook', currency: 'INR', customer: { name: 'Quitter', email: 'quit@example.com', mobile: '9000000000' }, billing: billingMH });
    await req('POST', '/api/checkout?action=event', { type: 'abandon', orderRef: o.data.orderRef });
    await req('POST', '/api/checkout?action=event', { type: 'abandon', orderRef: o.data.orderRef });
    await req('POST', '/api/checkout?action=event', { type: 'failed', orderRef: o.data.orderRef, reason: 'Card declined <script>' });
    await req('POST', '/api/checkout?action=event', { type: 'failed', orderRef: 'FOBT-does-not-exist' });
    await req('POST', '/api/checkout?action=event', { type: 'spam', orderRef: o.data.orderRef });
    const ms = mails();
    assert.strictEqual(ms.length, 2, ms.map(x => x.subject).join(' | '));
    assert.ok(ms.every(x => x.to === 'fullonbaan@gmail.com'));
    assert.ok(ms[0].params.status === 'CHECKOUT ABANDONED'); assert.ok(ms[1].template === 'FOB_Razorpay_Failure' && ms[1].params.message.includes('Card declined') && !ms[1].params.message.includes('<script>'));
    assert.strictEqual(records().find(r => r.orderId === o.data.orderRef).status, 'failed');
  });
  await test('payment succeeds after an earlier failure on the same order → confirmed', async () => {
    const rec = records().find(r => r.status === 'failed');
    const order = Object.values(mock.state.orders).find(o => o.notes.order_ref === rec.orderId);
    const p = mock.pay(order.id);
    const v = await req('POST', '/api/checkout?action=verify', p);
    assert.strictEqual(v.status, 200); assert.strictEqual(records().find(r => r.orderId === rec.orderId).status, 'confirmed');
  });
  await test('EmailJS template missing in this account → falls back to our HTML email (customer still notified)', async () => {
    clearMails(); process.env.FOB_EMAIL_TEMPLATE_FAIL = '1';
    const b = await buy('mfg_video', 'fallback@example.com');
    delete process.env.FOB_EMAIL_TEMPLATE_FAIL;
    assert.strictEqual(b.verify.status, 200);
    const ms = mails(); const c = ms.find(x => x.to === 'fallback@example.com');
    assert.ok(c && c.kind === 'html' && c.html.includes(b.verify.data.invoice.invNo) && c.html.includes('24 hours'), JSON.stringify(ms.map(x => [x.kind, x.to])));
    assert.ok(ms.find(x => x.to === 'fullonbaan@gmail.com' && x.kind === 'html'));
  });

  console.log('\n[9] Register stays compatible with /admin');
  await test('every confirmed record has the fields the /admin dashboard and invoice PDF use', async () => {
    const need = ['orderId', 'status', 'name', 'email', 'mobile', 'mobileCode', 'module', 'currency', 'baseAmt', 'gstAmt', 'totalAmt', 'cgstAmt', 'sgstAmt', 'igstAmt', 'taxType', 'billCountry', 'invoiceNo', 'invDate', 'dueDate', 'paymentId', 'confirmedAt'];
    const conf = records().filter(r => r.status === 'confirmed');
    assert.ok(conf.length >= 10);
    conf.forEach(r => need.forEach(k => assert.ok(r[k] !== undefined && r[k] !== null, r.orderId + ' missing ' + k)));
    const nums = conf.map(r => r.invoiceNo); assert.strictEqual(new Set(nums).size, nums.length, 'invoice numbers unique');
    conf.forEach(r => assert.ok(Math.abs(r.baseAmt + r.gstAmt - r.totalAmt) < 0.011, r.orderId + ' amounts add up'));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) console.log('FAILED:', fails.join(' | '));
  server.close(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
