// R2 error reporting: each Cloudflare error code → a message naming the setting to fix.
const assert = require('assert');
const ROOT = require('path').resolve(__dirname, '..');
Object.assign(process.env, { R2_ACCOUNT_ID: ' 0123456789abcdef0123456789abcdef\n', R2_ACCESS_KEY_ID: 'a'.repeat(32), R2_SECRET_ACCESS_KEY: 'b'.repeat(64) + ' ', R2_BUCKET: 'fob-training-ebooks' });
let reply = null, lastUrl = '', lastAuth = '';
global.fetch = async (req) => { lastUrl = req.url; lastAuth = req.headers.get('authorization') || ''; return reply(); };
const xml = (code, msg) => () => new Response('<?xml version="1.0"?><Error><Code>' + code + '</Code><Message>' + msg + '</Message></Error>', { status: 403 });
(async () => {
  const r2 = require(ROOT + '/api/_lib/r2');
  const cases = [
    ['AccessDenied', 'Access Denied', /not allowed on bucket "fob-training-ebooks".*Object Read & Write/],
    ['SignatureDoesNotMatch', 'sig', /R2_SECRET_ACCESS_KEY does not match/],
    ['InvalidAccessKeyId', 'bad key', /R2_ACCESS_KEY_ID is not a valid/],
    ['NoSuchBucket', 'nb', /Bucket "fob-training-ebooks" does not exist/]
  ];
  for (const [code, msg, re] of cases) {
    reply = xml(code, msg);
    await assert.rejects(r2.listObjects('ebooks/'), e => { assert.ok(e.message.startsWith('R2 LIST ebooks/ → 403 ' + code), e.message); assert.ok(re.test(e.message), e.message); return true; });
  }
  reply = () => new Response('', { status: 403 });
  await assert.rejects(r2.headObject('x'), e => /403 — This R2 API token is not allowed/.test(e.message));
  assert.ok(lastUrl.startsWith('https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/fob-training-ebooks/'), 'trimmed account id: ' + lastUrl);
  assert.ok(lastAuth.includes('Credential=' + 'a'.repeat(32) + '/'), 'signed with trimmed key');
  const rep = r2.configReport();
  assert.ok(rep.problems.some(p => p.startsWith('R2_ACCOUNT_ID has spaces')) && rep.problems.some(p => p.startsWith('R2_SECRET_ACCESS_KEY has spaces')));
  assert.ok(!rep.problems.some(p => /characters/.test(p)), 'lengths fine after trimming');
  process.env.R2_ACCESS_KEY_ID = 'cfat_' + 'x'.repeat(40);    // API *token* pasted instead of the Access Key ID
  assert.ok(r2.configReport().problems.some(p => /R2_ACCESS_KEY_ID is 45 characters/.test(p)));
  console.log('r2 errors: all passed');
})().catch(e => { console.error('  ✘', e.message); process.exit(1); });
