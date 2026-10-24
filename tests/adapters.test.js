// Real-mode adapters (no FOB_* test switches) with a stubbed global fetch.
const assert = require('assert');
const ROOT = require('path').resolve(__dirname, '..');
Object.assign(process.env, { R2_ACCOUNT_ID: 'acc123', R2_ACCESS_KEY_ID: 'AKIDEXAMPLE', R2_SECRET_ACCESS_KEY: 'secretEXAMPLE', R2_BUCKET: 'fob-training-ebooks',
  EMAILJS_SERVICE_ID: 'service_929have', EMAILJS_PUBLIC_KEY: 'pubKEY', EMAILJS_PRIVATE_KEY: 'privKEY', EMAILJS_MEMBER_TEMPLATE: 'FOB_Member_Access',
  GITHUB_PAT: 'ghp_test', RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 'sec' });
const calls = [];
global.fetch = async (u, opt) => {
  const url = typeof u === 'string' ? u : u.url; const o = opt || (typeof u === 'object' ? u : {});
  calls.push({ url, method: (o.method || 'GET'), headers: o.headers, body: o.body });
  if (url.includes('api.github.com') && (o.method || 'GET') === 'GET') return new Response(JSON.stringify({ sha: 'abc', content: Buffer.from(JSON.stringify([{ orderId: 'A' }])).toString('base64') }), { status: 200 });
  if (url.includes('api.github.com')) return new Response('{}', { status: 200 });
  if (url.includes('emailjs')) return new Response('OK', { status: 200 });
  if (url.includes('razorpay')) return new Response(JSON.stringify({ id: 'order_1', amount: 100 }), { status: 200 });
  if (url.includes('r2.cloudflarestorage.com') && url.includes('list-type=2')) return new Response('<ListBucketResult><Contents><Key>ebooks/dev/01 - A &amp; B.pdf</Key><Size>10</Size><LastModified>2026-10-01T00:00:00Z</LastModified></Contents><IsTruncated>false</IsTruncated></ListBucketResult>', { status: 200 });
  const hget = (k) => o.headers && (typeof o.headers.get === 'function' ? o.headers.get(k) : o.headers[k]);
  if (url.includes('r2.cloudflarestorage.com')) { assert.ok(hget('authorization') || url.includes('X-Amz-Signature'), 'R2 call must be signed'); return new Response('', { status: (o.method === 'PUT' && hget('If-None-Match')) ? 412 : 200, headers: { etag: '"e1"' } }); }
  return new Response('?', { status: 404 });
};
(async () => {
  const r2 = require(ROOT + '/api/_lib/r2');
  const u = new URL(await r2.signedUrl('ebooks/dev/01 - A & B.pdf', { ttl: 300, disposition: 'attachment', filename: 'FullOnBaan - A & B.pdf' }));
  assert.strictEqual(u.host, 'acc123.r2.cloudflarestorage.com');
  assert.strictEqual(decodeURIComponent(u.pathname), '/fob-training-ebooks/ebooks/dev/01 - A & B.pdf');
  ['X-Amz-Signature', 'X-Amz-Credential', 'X-Amz-Expires', 'response-content-disposition', 'response-content-type'].forEach(k => assert.ok(u.searchParams.get(k), 'missing ' + k));
  assert.strictEqual(u.searchParams.get('X-Amz-Expires'), '300');
  assert.ok(u.searchParams.get('response-content-disposition').startsWith('attachment; filename="FullOnBaan - A _ B.pdf"'));
  assert.ok(u.searchParams.get('X-Amz-Credential').includes('/auto/s3/aws4_request'));
  const put = new URL(await r2.signedPutUrl('ebooks/ai/x.xlsx', 900)); assert.strictEqual(put.searchParams.get('X-Amz-Expires'), '900');
  const list = await r2.listObjects('ebooks/'); assert.strictEqual(list[0].key, 'ebooks/dev/01 - A & B.pdf');
  assert.strictEqual(await r2.putObject('locks/x', 'a', 'text/plain', { ifNoneMatch: '*' }), false, '412 → false');
  console.log('  ✔ R2: SigV4 presigned GET/PUT links, XML listing decode, conditional PUT');

  const mail = require(ROOT + '/api/_lib/email');
  calls.length = 0;
  assert.ok(await mail.purchaseEmail({ email: 'a@b.co', name: 'A', code: 'FOB-AAAAA-BBBBB', orderRef: 'FOBT1', guideNames: ['Infor LN Development'], siteUrl: 'https://training.fullonbaan.com', videoNote: true }));
  const b = JSON.parse(calls[0].body);
  assert.strictEqual(calls[0].url, 'https://api.emailjs.com/api/v1.0/email/send');
  assert.deepStrictEqual([b.service_id, b.template_id, b.user_id, b.accessToken], ['service_929have', 'FOB_Member_Access', 'pubKEY', 'privKEY']);
  assert.ok(b.template_params.html_body.includes('FOB-AAAAA-BBBBB') && b.template_params.to_email === 'a@b.co' && b.template_params.reply_to);
  assert.ok(b.template_params.html_body.includes('https://training.fullonbaan.com/members'));
  calls.length = 0;
  await mail.sendTemplate('FOB_Razorpay_Success', { to_email: 'x@y.z', subject: 's' });
  let t = JSON.parse(calls[0].body);
  assert.deepStrictEqual([t.service_id, t.template_id, t.user_id], ['service_2qtgzr5', 'FOB_Razorpay_Success', '3U-YZo2UCV_RG5Gjo'], 'notifications use the ORIGINAL account');
  assert.ok(!('accessToken' in t), 'member-account private key never sent to the original account');
  process.env.EMAILJS_NOTIFY_PRIVATE_KEY = 'origPRIV'; calls.length = 0;
  await mail.sendTemplate('FOB_Razorpay_Failure', { to_email: 'x@y.z' });
  t = JSON.parse(calls[0].body); assert.strictEqual(t.accessToken, 'origPRIV'); assert.strictEqual(t.service_id, 'service_2qtgzr5');
  delete process.env.EMAILJS_NOTIFY_PRIVATE_KEY;
  calls.length = 0;
  await mail.newCodeEmail({ email: 'a@b.co', code: 'FOB-CCCCC-DDDDD', siteUrl: 'https://training.fullonbaan.com' });
  t = JSON.parse(calls[0].body); assert.deepStrictEqual([t.service_id, t.template_id], ['service_929have', 'FOB_Member_Access'], 'new-code email uses the member account');
  console.log('  ✔ EmailJS: access-code emails → service_929have / FOB_Member_Access; all other notifications → original service_2qtgzr5 templates');

  const pay = require(ROOT + '/api/_lib/payrecords');
  calls.length = 0;
  const r = await pay.readRecords();
  assert.strictEqual(r.records[0].orderId, 'A'); assert.strictEqual(r.sha, 'abc');
  assert.strictEqual(calls[0].url, 'https://api.github.com/repos/fullonbaan/fob_pay_store_ln_int/contents/payments/ln_payments.json');
  assert.strictEqual(calls[0].headers.Authorization, 'token ghp_test');
  await pay.ghPut(pay.FILE_COUNTER, { counter: 5 }, 'sha1', 'm');
  const pb = JSON.parse(calls[1].body); assert.strictEqual(calls[1].method, 'PUT'); assert.strictEqual(pb.sha, 'sha1'); assert.strictEqual(JSON.parse(Buffer.from(pb.content, 'base64')).counter, 5);
  assert.ok(calls[1].url.endsWith('/payments/invoice_counter.json'));
  console.log('  ✔ GitHub register: same repo/files as before (fob_pay_store_ln_int / ln_payments.json, invoice_counter.json)');

  const rzp = require(ROOT + '/api/_lib/razorpay');
  calls.length = 0; await rzp.createOrder({ amount: 100, currency: 'INR' });
  assert.strictEqual(calls[0].url, 'https://api.razorpay.com/v1/orders'); assert.strictEqual(calls[0].headers.Authorization, 'Basic ' + Buffer.from('rzp_live_x:sec').toString('base64'));
  console.log('  ✔ Razorpay: Basic auth with key id + secret from env, orders endpoint');
  console.log('adapters: all passed');
})().catch(e => { console.error('  ✘', e); process.exit(1); });
