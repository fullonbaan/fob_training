// api/invoice-counter.js — Sequential GST invoice number generator
// Reads/increments a counter stored in fob_pay_store_ln_int repo.
// GET → returns next invoice number (e.g. FOBT0001024) and saves it atomically.

const https = require('https');

const GH_OWNER = 'fullonbaan';
const GH_REPO  = 'fob_pay_store_ln_int';
const GH_FILE  = 'payments/invoice_counter.json';

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
        'Authorization': `token ${pat.trim()}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'fob-invoice-counter/1.0',
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  try {
    // ── Read current counter ──────────────────────────────────────────────
    const getResult = await ghRequest('GET');
    let current = 1023; // default — will produce FOBT0001024 on first run
    let sha = null;

    if (getResult.status === 200) {
      let ghData;
      try { ghData = JSON.parse(getResult.body); } catch(e) {
        return res.status(502).json({ error: 'Invalid JSON from GitHub: ' + e.message });
      }
      if (ghData.content) {
        try {
          const decoded = Buffer.from(ghData.content.replace(/\n/g, ''), 'base64').toString('utf8');
          const data = JSON.parse(decoded);
          current = data.counter || 1023;
          sha = ghData.sha;
        } catch(e) {
          console.error('Counter decode error:', e.message);
        }
      } else {
        sha = ghData.sha || null;
      }
    } else if (getResult.status !== 404) {
      console.error('GitHub GET counter error', getResult.status, getResult.body.slice(0, 200));
      // Fall through — use timestamp fallback
      const fallback = 'FOBT' + Date.now();
      return res.status(200).json({ invoiceNo: fallback, fallback: true });
    }

    // ── Increment and save ────────────────────────────────────────────────
    const next = current + 1;
    const content = Buffer.from(JSON.stringify({ counter: next }, null, 2)).toString('base64');
    const putBody = { message: `invoice-counter: ${next}`, content };
    if (sha) putBody.sha = sha;

    const putResult = await ghRequest('PUT', putBody);

    if (putResult.status !== 200 && putResult.status !== 201) {
      console.error('GitHub PUT counter error', putResult.status, putResult.body.slice(0, 200));
      // Return timestamp fallback rather than failing the payment
      const fallback = 'FOBT' + Date.now();
      return res.status(200).json({ invoiceNo: fallback, fallback: true });
    }

    const invoiceNo = 'FOBT' + String(next).padStart(7, '0');
    return res.status(200).json({ invoiceNo });

  } catch (e) {
    console.error('invoice-counter error:', e);
    // Never fail a payment — return timestamp fallback
    const fallback = 'FOBT' + Date.now();
    return res.status(200).json({ invoiceNo: fallback, fallback: true });
  }
};
