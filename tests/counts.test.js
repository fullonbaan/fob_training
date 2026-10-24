const { T } = require('./env');
const seed = require('./seed');
const fs = require('fs'), path = require('path'), assert = require('assert'), { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
(async () => {
  await seed(process.env.FOB_LOCAL_STORE);
  const S = process.env.FOB_LOCAL_STORE, put = (k, b) => { const p = path.join(S, k); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
  const pdf = fs.readFileSync(path.join(S, 'ebooks/dev/02 - DAL Scripts.pdf'));
  for (let i = 1; i <= 80; i++) put(`ebooks/dev/Training EBooks/Part${i}.pdf`, pdf);
  for (let i = 1; i <= 9; i++) put(`ebooks/dev/DAL Examples/ex${i}.txt`, Buffer.from('x'));
  put('ebooks/dev/_thumbs/x.pdf', pdf);
  // 1. build step: dev = 2 (root) + 80 = 82 PDFs; fin = 1; lnapi = 3 (+1 in a hidden _Drafts folder); cloud = 1 (xlsx not counted); os = 1
  try { fs.unlinkSync(ROOT + '/src/_data/r2-counts.json'); } catch (e) {}
  const out = execSync('node scripts/r2-counts.js', { cwd: ROOT, env: process.env }).toString(); console.log(out.trim().slice(0, 300));
  const j = JSON.parse(fs.readFileSync(ROOT + '/src/_data/r2-counts.json', 'utf8'));
  assert.strictEqual(j.counts.dev_ebook, 82); assert.strictEqual(j.counts.ln_api_ebook, 3); assert.strictEqual(j.counts.cloud_migration, 1); assert.strictEqual(j.counts.adm_ebook, 0);
  execSync('npm run build:css >/dev/null 2>&1; node node_modules/@11ty/eleventy/cmd.cjs >/dev/null', { cwd: ROOT, env: process.env, shell: '/bin/bash' });
  const html = fs.readFileSync(ROOT + '/_site/catalog/index.html', 'utf8');
  const lib = require(ROOT + '/src/_data/library.js');
  assert.ok(html.includes('<span data-count="dev_ebook">82 eBooks</span>'), 'dev from bucket');
  assert.ok(html.includes('<span data-count="adm_ebook">37 eBooks</span>'), 'adm (nothing uploaded) keeps typed number');
  assert.ok(html.includes('<span data-count="cloud_migration">1 eBook</span>'), 'singular');
  const tot = lib.ebookTotal; assert.ok(html.includes('<span data-count-total>' + tot + '</span> eBooks Across'), 'header total ' + tot);
  const pricing = fs.readFileSync(ROOT + '/_site/pricing/index.html', 'utf8');
  assert.ok(pricing.includes('Infor LN API — 3 eBooks'), 'product names use the bucket count too');
  console.log('  ✔ build: bucket counts on catalog, pricing & names; empty kits keep typed counts; total', tot);
  // 2. live endpoint after a new upload (no rebuild)
  put('ebooks/adm/Admin Guide.pdf', pdf); put('ebooks/adm/Sub/Admin 2.pdf', pdf);
  const server = require('./harness'); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const B = 'http://127.0.0.1:' + server.address().port;
  const r = await fetch(B + '/api/catalog-counts'); const d = await r.json();
  assert.strictEqual(r.status, 200); assert.strictEqual(d.counts.adm_ebook, 2); assert.strictEqual(d.counts.dev_ebook, 82); assert.strictEqual(d.counts.mfg_ebook, 10, 'fallback');
  assert.ok(/max-age=300/.test(r.headers.get('vercel-cdn-cache-control'))); assert.ok(!JSON.stringify(d).includes('.pdf'), 'no file names leak');
  assert.strictEqual((await fetch(B + '/api/catalog-counts', { method: 'POST' })).status, 405);
  console.log('  ✔ live endpoint: new upload counted without rebuild, cached at the edge, numbers only');
  // 3. browser: catalog updates its numbers from the endpoint
  let chromium = null; try { chromium = require('playwright').chromium; } catch (e) { console.log('  – browser check skipped (playwright not installed)'); }
  if (chromium) {
  const br = await chromium.launch(); const pg = await br.newPage(); const errs = [];
  pg.on('pageerror', e => errs.push(e.message));
  await pg.route('**/*', rt => rt.request().url().startsWith(B) ? rt.continue() : rt.fulfill({ body: '', contentType: 'text/css' }));
  await pg.goto(B + '/catalog/'); await pg.waitForFunction(() => document.querySelector('[data-count="adm_ebook"]').textContent === '2 eBooks', null, { timeout: 5000 });
  const t = await pg.textContent('[data-count-total]'); assert.strictEqual(Number(t), d.total);
  console.log('  ✔ catalog page shows live counts (adm → 2 eBooks, header total', t + ')', errs.length ? errs : '');
  await br.close();
  }
  // 4. no R2 configured → keeps existing file, build continues
  const out2 = execSync('node scripts/r2-counts.js', { cwd: ROOT, env: Object.assign({}, process.env, { FOB_LOCAL_STORE: '', R2_BUCKET: '' }) }).toString();
  assert.ok(out2.includes('not configured')); console.log('  ✔ build without R2 settings: skipped safely');
  server.close(); fs.unlinkSync(ROOT + '/src/_data/r2-counts.json');
  console.log('counts: all passed');
})().catch(e => { console.error('  ✘', e.message); process.exit(1); });
