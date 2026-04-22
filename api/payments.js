// api/payments.js — Secure GitHub proxy for LN Payment records
// The GITHUB_PAT environment variable is set in Vercel dashboard (never in code).

const https = require('https');

const GH_OWNER = 'fullonbaan';
const GH_REPO  = 'fob_pay_store_ln_int';
const GH_FILE  = 'payments/ln_payments.json';
const GH_API   = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`;

// ── helpers ──────────────────────────────────────────────────────────────────

function ghRequest(method, bodyObj) {
  return new Promise((resolve, reject) => {
    const pat = process.env.GITHUB_PAT;
    if (!pat) return reject(new Error('GITHUB_PAT environment variable is not set.'));

    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`,
      method,
      headers: {
        'Authorization': `token ${pat}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'fob-payments-proxy/1.0',
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end',  ()    => resolve({ status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── handler ───────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // CORS — only allow your own domain in production; '*' is fine for same-origin Vercel
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    // ── GET: read payment records ──────────────────────────────────────────
    if (req.method === 'GET') {
      const result = await ghRequest('GET');

      if (result.status === 404) {
        return res.status(200).json({ records: [], sha: null });
      }
      if (result.status !== 200) {
        return res.status(502).json({ error: `GitHub returned ${result.status}` });
      }

      const data    = JSON.parse(result.body);
      const records = JSON.parse(
        Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8')
      );
      return res.status(200).json({ records, sha: data.sha });
    }

    // ── PUT: write / upsert a record ───────────────────────────────────────
    if (req.method === 'PUT') {
      const { records, sha, message } = req.body || {};

      if (!Array.isArray(records)) {
        return res.status(400).json({ error: '`records` array is required.' });
      }

      const content = Buffer.from(JSON.stringify(records, null, 2)).toString('base64');
      const body    = { message: message || 'lnpay: update', content };
      if (sha) body.sha = sha;

      const result = await ghRequest('PUT', body);

      if (result.status !== 200 && result.status !== 201) {
        return res.status(502).json({ error: `GitHub write returned ${result.status}` });
      }

      const data = JSON.parse(result.body);
      return res.status(200).json({ sha: data.content.sha });
    }

    return res.status(405).json({ error: 'Method not allowed.' });

  } catch (e) {
    console.error('payments proxy error:', e);
    return res.status(500).json({ error: e.message });
  }
};
