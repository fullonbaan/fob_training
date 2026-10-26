// Referral / sales-partner programme — end-to-end against the real handlers (mocked Razorpay / R2 / GitHub / EmailJS).
const { T } = require('./env');
const fs = require('fs'), path = require('path'), crypto = require('crypto'), assert = require('assert');
const mock = require('./mockrzp');
const ROOT = process.env.TRAINING_DIR;
const catalog = require(ROOT + '/api/_lib/catalog');

let BASE, server, passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✔', name); }
  catch (e) { failed++; console.log('  ✘', name, '\n     ', e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : e); }
}
const mails = () => fs.existsSync(process.env.FOB_EMAIL_LOG) ? fs.readFileSync(process.env.FOB_EMAIL_LOG, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const clearMails = () => { try { fs.unlinkSync(process.env.FOB_EMAIL_LOG); } catch (e) {} };
const store = (k) => { const p = path.join(process.env.FOB_LOCAL_STORE, k); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null; };
const records = () => { const p = path.join(process.env.FOB_GH_LOCAL, 'payments/ln_payments.json'); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : []; };
async function req(method, p, body, headers) {
  const r = await fetch(BASE + p, { method, redirect: 'manual', headers: Object.assign(body !== undefined ? { 'Content-Type': 'application/json' } : {}, headers || {}), body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined });
  let data = null; const txt = await r.text(); try { data = JSON.parse(txt); } catch (e) { data = txt; }
  return { status: r.status, data, cookie: r.headers.get('set-cookie') };
}
const ADMIN = { Authorization: 'Bearer ' + process.env.ADMIN_API_TOKEN };
const billing = { billCountry: 'IN', billStateCode: '27', billStateName: 'Maharashtra', billLine1: '1 Marine Dr', billCity: 'Mumbai', billPincode: '400001', gstin: '27AAAAA0000A1Z5', gstLegalName: 'Acme', billCompany: 'Acme' };
const fullNotes = { bill_company: 'Acme', bill_addr: '1 Marine Dr', bill_city: 'Mumbai', bill_state: 'Maharashtra (27)', bill_pin: '400001', bill_country: 'IN', gstin: '27AAAAA0000A1Z5 / Acme' };
const EBOOK = Object.keys(catalog.PRODUCTS).find(k => catalog.PRODUCTS[k].ebooks.length && !catalog.PRODUCTS[k].video);
async function order(email, extra, headers) {
  return req('POST', '/api/checkout?action=order', Object.assign({ product: EBOOK, currency: 'INR', customer: { name: 'Priya Buyer', email, mobile: '9876543210', mobileCode: '+91' }, billing, notes: fullNotes }, extra || {}), headers);
}
async function buy(email, extra, headers) {
  const o = await order(email, extra, headers);
  assert.strictEqual(o.status, 200, JSON.stringify(o.data));
  const pay = mock.pay(o.data.orderId, 'captured');
  const v = await req('POST', '/api/checkout?action=verify', pay);
  assert.strictEqual(v.status, 200, JSON.stringify(v.data));
  return { o: o.data, pay, v: v.data };
}
function webhook(orderId, paymentId) {
  const body = JSON.stringify({ event: 'order.paid', payload: { order: { entity: { id: orderId } }, payment: { entity: mock.state.payments[paymentId] } } });
  const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex');
  return req('POST', '/api/razorpay-webhook', body, { 'x-razorpay-signature': sig, 'Content-Type': 'application/json' });
}
const salesOf = (code) => { const d = path.join(process.env.FOB_LOCAL_STORE, 'referrals/sales', code); return fs.existsSync(d) ? fs.readdirSync(d).map(f => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))) : []; };

(async () => {
  server = require('./harness');
  await new Promise(r => server.listen(0, r));
  BASE = 'http://127.0.0.1:' + server.address().port;
  console.log('Referral test store:', T, '· product', EBOOK);
  let ACCESS = '', cookie = '';

  console.log('\n[R1] Admin onboarding');
  await test('admin endpoints refuse anonymous callers', async () => {
    assert.strictEqual((await req('GET', '/api/referral?action=a-list')).status, 401);
    assert.strictEqual((await req('POST', '/api/referral?action=a-create', { name: 'x', email: 'x@y.com', commissionPct: 10 })).status, 401);
  });
  await test('onboard partner → record, email index, welcome email with link + access code; secrets never returned', async () => {
    clearMails();
    const r = await req('POST', '/api/referral?action=a-create', { name: 'Asha Rao', email: 'Asha@Partner.com', mobile: '+91 99000 11111', code: 'asha10', commissionPct: 10, payout: 'UPI asha@okicici' }, ADMIN);
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.partner.code, 'ASHA10'); assert.strictEqual(r.data.partner.email, 'asha@partner.com');
    assert.ok(/^FOB-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(r.data.accessCode)); ACCESS = r.data.accessCode;
    assert.ok(!('codeHash' in r.data.partner));
    assert.strictEqual(r.data.link, 'https://training.fullonbaan.com/?ref=ASHA10');
    const rec = store('referrals/partners/ASHA10.json'); assert.ok(rec.codeHash.startsWith('scrypt$')); assert.strictEqual(rec.commissionPct, 10);
    const m = mails().find(x => x.to === 'asha@partner.com'); assert.ok(m && m.html.includes(ACCESS) && m.html.includes('/?ref=ASHA10') && m.html.includes('/partners'));
  });
  await test('duplicate code / duplicate email / bad % / bad code are rejected', async () => {
    assert.strictEqual((await req('POST', '/api/referral?action=a-create', { name: 'B', email: 'b@p.com', code: 'ASHA10', commissionPct: 5 }, ADMIN)).status, 409);
    const e = await req('POST', '/api/referral?action=a-create', { name: 'B', email: 'asha@partner.com', code: 'BBB10', commissionPct: 5 }, ADMIN);
    assert.strictEqual(e.status, 409); assert.ok(/ASHA10/.test(e.data.error));
    assert.ok(!store('referrals/partners/BBB10.json'), 'rolled back');
    assert.strictEqual((await req('POST', '/api/referral?action=a-create', { name: 'B', email: 'b@p.com', code: 'BBB', commissionPct: 95 }, ADMIN)).status, 400);
    assert.strictEqual((await req('POST', '/api/referral?action=a-create', { name: 'B', email: 'b@p.com', code: 'a!', commissionPct: 5 }, ADMIN)).status, 400);
  });
  await test('second partner gets an auto-suggested code when none is given', async () => {
    const r = await req('POST', '/api/referral?action=a-create', { name: 'Vikram Shah', email: 'vikram@partner.com', commissionPct: 15, notify: false }, ADMIN);
    assert.strictEqual(r.status, 200); assert.ok(/^VIKRAMSH\d{2}$/.test(r.data.partner.code), r.data.partner.code);
  });

  console.log('\n[R2] Link clicks & code validation');
  await test('click on ?ref link counts once per visitor per day; unknown codes are ignored', async () => {
    await req('POST', '/api/referral?action=click', { code: 'asha10', page: '/' }, { 'x-real-ip': '1.1.1.1' });
    await req('POST', '/api/referral?action=click', { code: 'ASHA10', page: '/pricing/' }, { 'x-real-ip': '1.1.1.1' });
    await req('POST', '/api/referral?action=click', { code: 'ASHA10' }, { 'x-real-ip': '2.2.2.2' });
    const r = await req('POST', '/api/referral?action=click', { code: 'NOPE99' }, { 'x-real-ip': '3.3.3.3' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(store('referrals/clicks/ASHA10.json').total, 2);
    assert.ok(!store('referrals/clicks/NOPE99.json'));
  });
  await test('validate → partner first name only, never email', async () => {
    const ok = await req('GET', '/api/referral?action=validate&code=asha10');
    assert.deepStrictEqual(ok.data, { valid: true, code: 'ASHA10', by: 'Asha' });
    assert.strictEqual((await req('GET', '/api/referral?action=validate&code=ZZZ999')).data.valid, false);
  });

  console.log('\n[R3] Attribution at checkout + commission on payment');
  let first;
  await test('typed code → Razorpay note `ref`, ≤15 notes (bill_country IN dropped), register line carries refCode', async () => {
    const o = await order('priya@buyer.com', { ref: 'asha10', refSrc: 'code' });
    assert.strictEqual(o.status, 200, JSON.stringify(o.data));
    assert.deepStrictEqual(o.data.referral, { code: 'ASHA10', by: 'Asha' });
    const n = mock.state.orders[o.data.orderId].notes;
    assert.strictEqual(n.ref, 'ASHA10'); assert.ok(Object.keys(n).length <= 15, Object.keys(n).length); assert.ok(n.gstin, 'gstin kept'); assert.ok(!n.bill_country);
    const rec = records().find(r => r.orderId === o.data.orderRef); assert.strictEqual(rec.refCode, 'ASHA10'); assert.strictEqual(rec.refSrc, 'code');
  });
  await test('paid order → one pending commission line = 10% of the price excl. GST; partner + admin emails', async () => {
    clearMails();
    first = await buy('priya@buyer.com', { ref: 'ASHA10' });
    const lines = salesOf('ASHA10').filter(s => s.id === first.o.orderId); assert.strictEqual(lines.length, 1);
    const s = lines[0], q = catalog.quote(EBOOK, 'INR', {});
    assert.strictEqual(s.status, 'pending'); assert.strictEqual(s.base, q.base); assert.strictEqual(s.paid, q.total);
    assert.strictEqual(s.commission, Math.round(q.base * 10) / 100); assert.strictEqual(s.pct, 10);
    assert.ok(Date.parse(s.holdUntil) - Date.now() > 6.9 * 864e5);
    assert.strictEqual(s.customer, 'pr***@buyer.com'); assert.ok(!JSON.stringify(s).includes('priya@buyer.com'));
    const conf = records().find(r => r.orderId === first.o.orderRef); assert.strictEqual(conf.status, 'confirmed'); assert.strictEqual(conf.refCode, 'ASHA10');
    const pm = mails().filter(m => m.to === 'asha@partner.com'); assert.strictEqual(pm.length, 1); assert.ok(/New referral sale/.test(pm[0].subject));
    const adm = mails().find(m => m.to === 'fullonbaan@gmail.com'); assert.ok(adm && JSON.stringify(adm).includes('ASHA10'), 'admin alert mentions partner');
  });
  await test('webhook for the same order → no second line, no second partner email', async () => {
    clearMails();
    const w = await webhook(first.o.orderId, first.pay.razorpay_payment_id); assert.strictEqual(w.status, 200);
    assert.strictEqual(salesOf('ASHA10').filter(s => s.id === first.o.orderId).length, 1);
    assert.strictEqual(mails().filter(m => m.to === 'asha@partner.com').length, 0);
  });
  await test('link cookie (fob_ref) attributes the order when the box was not sent', async () => {
    const b = await buy('ravi@buyer.com', {}, { Cookie: 'fob_ref=VIKRAM' + '' });
    // VIKRAM is not the real code → not attributed
    assert.ok(!mock.state.orders[b.o.orderId].notes.ref);
    const code = store('referrals/byemail/' + crypto.createHash('sha256').update('vikram@partner.com').digest('hex') + '.json').code;
    const b2 = await buy('ravi2@buyer.com', {}, { Cookie: 'fob_theme=dark; fob_ref=' + code });
    assert.strictEqual(mock.state.orders[b2.o.orderId].notes.ref, code);
    assert.strictEqual(salesOf(code).length, 1); assert.strictEqual(salesOf(code)[0].pct, 15);
  });
  await test('typed code wins over the cookie (last referrer / explicit entry wins)', async () => {
    const vik = store('referrals/byemail/' + crypto.createHash('sha256').update('vikram@partner.com').digest('hex') + '.json').code;
    const b = await buy('meera@buyer.com', { ref: 'ASHA10' }, { Cookie: 'fob_ref=' + vik });
    assert.strictEqual(mock.state.orders[b.o.orderId].notes.ref, 'ASHA10');
  });
  await test('self-referral (partner buys with own email) → not attributed', async () => {
    const o = await order('asha@partner.com', { ref: 'ASHA10' });
    assert.strictEqual(o.status, 200); assert.ok(!mock.state.orders[o.data.orderId].notes.ref); assert.strictEqual(o.data.referral, null);
  });
  await test('a browser cannot smuggle `ref` through the free-form notes', async () => {
    const o = await order('sneaky@buyer.com', { notes: { ref: 'ASHA10', ref_x: 'y', bill_city: 'Pune' } });
    const n = mock.state.orders[o.data.orderId].notes; assert.ok(!n.ref && !n.ref_x); assert.strictEqual(n.bill_city, 'Pune');
  });
  await test('unknown code → order still goes through, unattributed', async () => {
    const o = await order('x@buyer.com', { ref: 'NOSUCH1' }); assert.strictEqual(o.status, 200); assert.ok(!mock.state.orders[o.data.orderId].notes.ref);
  });

  console.log('\n[R4] Partner dashboard');
  await test('wrong access code → 401; right code → session cookie; dashboard shows totals, masked customers', async () => {
    assert.strictEqual((await req('POST', '/api/referral?action=login', { email: 'asha@partner.com', code: 'FOB-AAAAA-BBBBB' })).status, 401);
    const l = await req('POST', '/api/referral?action=login', { email: 'ASHA@partner.com', code: ACCESS.toLowerCase() });
    assert.strictEqual(l.status, 200, JSON.stringify(l.data)); cookie = l.cookie.split(';')[0]; assert.ok(/HttpOnly/.test(l.cookie));
    const me = await req('GET', '/api/referral?action=me', undefined, { Cookie: cookie });
    assert.strictEqual(me.status, 200); assert.strictEqual(me.data.partner.code, 'ASHA10');
    assert.strictEqual(me.data.clicks.total, 2); assert.strictEqual(me.data.totals.orders, 2);
    assert.ok(me.data.totals.byCurrency.INR.pending > 0); assert.strictEqual(me.data.totals.byCurrency.INR.approved, 0);
    const txt = JSON.stringify(me.data); assert.ok(!txt.includes('priya@buyer.com') && !txt.includes('codeHash') && !txt.includes('customerHash'));
    assert.ok(me.data.sales.every(s => /\*\*\*@/.test(s.customer)));
  });
  await test('no / forged / member session → 401', async () => {
    assert.strictEqual((await req('GET', '/api/referral?action=me')).status, 401);
    const C = require(ROOT + '/api/_lib/crypto');
    const memberTok = C.signSession({ h: 'a'.repeat(64), v: 1, exp: Date.now() + 1e6 });
    assert.strictEqual((await req('GET', '/api/referral?action=me', undefined, { Cookie: 'fob_ref_s=' + memberTok })).status, 401);
  });
  await test('partner reports an offline sale → "review" with commission preview', async () => {
    const c = await req('POST', '/api/referral?action=claim', { customerName: 'Kiran', customerEmail: 'kiran@corp.com', productKey: EBOOK, amount: 11800, currency: 'INR', paymentRef: 'UTR123' }, { Cookie: cookie });
    assert.strictEqual(c.status, 200, JSON.stringify(c.data)); assert.strictEqual(c.data.sale.status, 'review');
    assert.strictEqual(c.data.sale.base, 10000); assert.strictEqual(c.data.sale.commission, 1000);
    assert.strictEqual((await req('POST', '/api/referral?action=claim', { customerName: 'Me', customerEmail: 'asha@partner.com', amount: 100 }, { Cookie: cookie })).status, 400);
  });

  console.log('\n[R5] Admin: approve, hold period, payout, void, rate change');
  await test('a-list shows partners with clicks + totals; claim waits in review', async () => {
    const l = await req('GET', '/api/referral?action=a-list', undefined, ADMIN);
    const a = l.data.partners.find(p => p.code === 'ASHA10'); assert.strictEqual(a.clicks, 2); assert.strictEqual(a.totals.review, 1); assert.ok(!a.codeHash);
  });
  await test('approve claim → payable; online line becomes payable automatically after the hold', async () => {
    const claim = salesOf('ASHA10').find(s => s.kind === 'claim');
    const r = await req('POST', '/api/referral?action=a-sale', { code: 'ASHA10', id: claim.id, op: 'approve' }, ADMIN);
    assert.strictEqual(r.data.sale.status, 'approved');
    // time travel: the first online order's hold has ended
    const p = path.join(process.env.FOB_LOCAL_STORE, 'referrals/sales/ASHA10', first.o.orderId + '.json');
    const s = JSON.parse(fs.readFileSync(p, 'utf8')); s.holdUntil = new Date(Date.now() - 1000).toISOString(); fs.writeFileSync(p, JSON.stringify(s));
    const me = await req('GET', '/api/referral?action=me', undefined, { Cookie: cookie });
    assert.strictEqual(me.data.sales.find(x => x.id === first.o.orderId).status, 'approved');
    assert.ok(me.data.totals.byCurrency.INR.approved > 1000);
  });
  await test('payout marks only payable lines paid, with the UTR; pending lines are skipped', async () => {
    const all = salesOf('ASHA10'); const ids = all.map(s => s.id);
    const r = await req('POST', '/api/referral?action=a-payout', { code: 'ASHA10', ids, payoutRef: 'UTR-PAY-1' }, ADMIN);
    assert.strictEqual(r.data.paid, 2); assert.strictEqual(r.data.skipped.length, all.length - 2);
    assert.ok(salesOf('ASHA10').filter(s => s.status === 'paid').every(s => s.payoutRef === 'UTR-PAY-1' && s.paidAt));
    assert.strictEqual((await req('POST', '/api/referral?action=a-payout', { code: 'ASHA10', ids, payoutRef: '' }, ADMIN)).status, 400);
  });
  await test('void (refund) a pending line; paid lines cannot be voided or edited', async () => {
    const pend = salesOf('ASHA10').find(s => s.status === 'pending');
    const v = await req('POST', '/api/referral?action=a-sale', { code: 'ASHA10', id: pend.id, op: 'void', reason: 'Refunded' }, ADMIN);
    assert.strictEqual(v.data.sale.status, 'void'); assert.strictEqual(v.data.sale.voidReason, 'Refunded');
    const paid = salesOf('ASHA10').find(s => s.status === 'paid');
    assert.strictEqual((await req('POST', '/api/referral?action=a-sale', { code: 'ASHA10', id: paid.id, op: 'void' }, ADMIN)).status, 400);
    assert.strictEqual((await req('POST', '/api/referral?action=a-sale', { code: 'ASHA10', id: paid.id, op: 'edit', base: 1 }, ADMIN)).status, 400);
  });
  await test('rate change applies to new sales only; edit recalculates a line', async () => {
    const u = await req('POST', '/api/referral?action=a-update', { code: 'ASHA10', commissionPct: 20 }, ADMIN);
    assert.strictEqual(u.data.partner.commissionPct, 20); assert.strictEqual(u.data.partner.rateHistory.length, 2);
    const b = await buy('neha@buyer.com', { ref: 'ASHA10' });
    const s = salesOf('ASHA10').find(x => x.id === b.o.orderId); assert.strictEqual(s.pct, 20);
    assert.ok(salesOf('ASHA10').filter(x => x.kind === 'order' && x.id !== b.o.orderId).every(x => x.pct === 10));
    const e = await req('POST', '/api/referral?action=a-sale', { code: 'ASHA10', id: s.id, op: 'edit', base: 5000, pct: 12.5 }, ADMIN);
    assert.strictEqual(e.data.sale.commission, 625);
  });
  await test('manual (offline) sale by admin is approved immediately', async () => {
    const m = await req('POST', '/api/referral?action=a-manual', { code: 'ASHA10', customerName: 'Corp Ltd', amount: 59000, currency: 'INR', base: 50000, paymentRef: 'NEFT9' }, ADMIN);
    assert.strictEqual(m.data.sale.status, 'approved'); assert.strictEqual(m.data.sale.commission, 10000);
  });
  await test('disable partner → session revoked, code no longer validates or attributes', async () => {
    await req('POST', '/api/referral?action=a-update', { code: 'ASHA10', status: 'disabled' }, ADMIN);
    assert.strictEqual((await req('GET', '/api/referral?action=me', undefined, { Cookie: cookie })).status, 401);
    assert.strictEqual((await req('GET', '/api/referral?action=validate&code=ASHA10')).data.valid, false);
    const o = await order('late@buyer.com', { ref: 'ASHA10' }); assert.ok(!mock.state.orders[o.data.orderId].notes.ref);
    await req('POST', '/api/referral?action=a-update', { code: 'ASHA10', status: 'active' }, ADMIN);
  });
  await test('reset access code → old code fails, new one works', async () => {
    const r = await req('POST', '/api/referral?action=a-reset-code', { code: 'ASHA10', notify: false }, ADMIN);
    assert.strictEqual((await req('POST', '/api/referral?action=login', { email: 'asha@partner.com', code: ACCESS })).status, 401);
    assert.strictEqual((await req('POST', '/api/referral?action=login', { email: 'asha@partner.com', code: r.data.accessCode })).status, 200);
  });
  await test('referral storage failure never blocks a paid order', async () => {
    const R = require(ROOT + '/api/_lib/referrals');
    const orig = R.recordSale; R.recordSale = async () => { throw new Error('R2 down'); };
    try { const b = await buy('resilient@buyer.com', { ref: 'ASHA10' }); assert.strictEqual(b.v.ok, true); assert.ok(b.v.invoice.invNo); }
    finally { R.recordSale = orig; }
  });

  console.log('\n[R6] Built pages');
  await test('/partners and /referrals-admin are built, noindex, with CSP; pricing has the referral box; every page captures ?ref=', async () => {
    const pg = fs.readFileSync(ROOT + '/_site/partners/index.html', 'utf8'); assert.ok(pg.includes('noindex') && pg.includes("API='/api/referral'"));
    assert.ok(fs.existsSync(ROOT + '/_site/referrals-admin/index.html'));
    const pricing = fs.readFileSync(ROOT + '/_site/pricing/index.html', 'utf8'); assert.ok(pricing.includes('id="refCode"') && pricing.includes('window.fobRef'));
    const home = fs.readFileSync(ROOT + '/_site/index.html', 'utf8'); assert.ok(home.includes("fob_ref=") && home.includes('/partners/'));
    const v = JSON.parse(fs.readFileSync(ROOT + '/vercel.json', 'utf8'));
    ['/partners', '/partners/', '/referrals-admin', '/referrals-admin/'].forEach(s => assert.ok(v.headers.find(h => h.source === s && h.headers.some(x => x.key === 'Content-Security-Policy')), s));
    assert.ok(v.functions['api/referral.js']);
    const r = await fetch(BASE + '/partners/'); assert.ok(/frame-ancestors 'none'/.test(r.headers.get('content-security-policy')));
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  server.close(); process.exit(failed ? 1 : 0);
})();
