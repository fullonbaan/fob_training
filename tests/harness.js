// Local stand-in for Vercel: serves _site and runs api/*.js with Vercel-like req/res helpers.
const http = require('http'), fs = require('fs'), path = require('path'), url = require('url');
const ROOT = process.env.TRAINING_DIR;
const SITE = path.join(ROOT, '_site');
const mock = require('./mockrzp');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));

function addHelpers(req, res) {
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); return res; };
  res.send = (b) => { if (typeof b === 'object' && !Buffer.isBuffer(b)) return res.json(b); res.end(b); return res; };
}
function applyHeaders(pathname, res) {
  (vercel.headers || []).forEach(h => {
    const re = new RegExp('^' + h.source.replace(/\(\.\*\)/g, '.*') + '$');
    if (re.test(pathname)) h.headers.forEach(x => res.setHeader(x.key, x.value));
  });
}
const server = http.createServer(async (req, res) => {
  const u = url.parse(req.url, true);
  let p = decodeURIComponent(u.pathname);
  addHelpers(req, res);
  try {
    // test-only: pay an order like the customer would in the Razorpay window
    if (p === '/__mockpay') { const r = mock.pay(u.query.order_id, u.query.mode, u.query.email); res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(r)); }
    // signed R2 links in local mode → serve / accept files from the local store
    if (p.startsWith('/__local/')) {
      const fp = path.join(process.env.FOB_LOCAL_STORE, p.slice('/__local/'.length));
      if (req.method === 'PUT') { const ch = []; for await (const c of req) ch.push(c); fs.mkdirSync(path.dirname(fp), { recursive: true }); fs.writeFileSync(fp, Buffer.concat(ch)); res.statusCode = 200; return res.end(); }
      if (!fs.existsSync(fp)) { res.statusCode = 404; return res.end('nf'); }
      res.setHeader('Content-Type', TYPES[path.extname(fp).toLowerCase()] || 'application/octet-stream');
      res.setHeader('X-Disposition', String(u.query.disp || '')); res.setHeader('Content-Disposition', (u.query.disp || 'inline'));
      return res.end(fs.readFileSync(fp));
    }
    for (const rw of (vercel.rewrites || [])) if (rw.source === p) p = rw.destination;
    applyHeaders(p, res);
    if (p.startsWith('/api/')) {
      const name = p.slice(5).replace(/\/$/, '');
      const file = path.join(ROOT, 'api', name + '.js');
      if (name.startsWith('_') || !fs.existsSync(file)) { res.statusCode = 404; return res.end('no fn'); }
      req.query = u.query;
      if (name !== 'razorpay-webhook' && req.method !== 'GET') {     // Vercel parses JSON bodies
        const ch = []; for await (const c of req) ch.push(c);
        const raw = Buffer.concat(ch).toString('utf8');
        try { req.body = raw ? JSON.parse(raw) : {}; } catch (e) { req.body = raw; }
      }
      return await require(file)(req, res);
    }
    let fp = path.join(SITE, p);
    if (fs.existsSync(fp) && fs.statSync(fp).isDirectory()) fp = path.join(fp, 'index.html');
    else if (!fs.existsSync(fp) && fs.existsSync(fp + '/index.html')) fp = fp + '/index.html';
    if (!fs.existsSync(fp)) { res.statusCode = 404; return res.end('404'); }
    res.setHeader('Content-Type', TYPES[path.extname(fp)] || 'application/octet-stream');
    res.end(fs.readFileSync(fp));
  } catch (e) { console.error('HARNESS', e); if (!res.headersSent) { res.statusCode = 500; res.end('harness error ' + e.message); } }
});
module.exports = server;
if (require.main === module) server.listen(Number(process.env.PORT || 4321), () => console.log('harness on', process.env.PORT || 4321));
