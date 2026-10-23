// api/feedback.js — Training-material feedback, stored as JSON in GitHub
//
//   GET                         → all feedback (newest first, emails stripped)
//   POST   {name, material, rating, comment, ...}
//                               → learner submission, published immediately
//   POST   + admin session      → admin-added entry (may set createdAt / source)
//   DELETE ?id=…  + admin session → remove an entry (spam / duplicates)
//
// Storage: fullonbaan/fob_pay_store_ln_int → feedback/training_feedback.json
// Needs GITHUB_PAT (already set for payments) and ADMIN_PASSWORD (see api/_auth.js).

const https = require('https');
const crypto = require('crypto');
const { isAdmin } = require('./_auth');

const GH_OWNER = 'fullonbaan';
const GH_REPO  = 'fob_pay_store_ln_int';
const GH_FILE  = 'feedback/training_feedback.json';

const LIMITS = { name: 80, role: 100, material: 120, format: 30, comment: 2000, email: 120 };

function ghRequest(method, bodyObj) {
  return new Promise((resolve, reject) => {
    const pat = process.env.GITHUB_PAT;
    if (!pat) return reject(new Error('GITHUB_PAT environment variable is not set.'));
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: `/repos/${GH_OWNER}/${GH_REPO}/contents/${GH_FILE}`,
      method,
      headers: {
        'Authorization': `token ${pat.trim()}`,
        'Accept':        'application/vnd.github.v3+json',
        'User-Agent':    'fob-feedback/1.0',
        'Content-Type':  'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function readStore() {
  const r = await ghRequest('GET');
  if (r.status === 404) return { items: [], sha: null };
  if (r.status !== 200) throw new Error('GitHub GET ' + r.status);
  const gh = JSON.parse(r.body);
  let items = [];
  if (gh.content) {
    try {
      const data = JSON.parse(Buffer.from(gh.content.replace(/\n/g, ''), 'base64').toString('utf8'));
      items = Array.isArray(data.feedback) ? data.feedback : [];
    } catch (e) { throw new Error('Feedback file is not valid JSON'); }
  }
  return { items, sha: gh.sha || null };
}

async function writeStore(items, sha, message) {
  const content = Buffer.from(JSON.stringify({ feedback: items }, null, 2)).toString('base64');
  const body = { message, content };
  if (sha) body.sha = sha;
  const r = await ghRequest('PUT', body);
  if (r.status === 409 || r.status === 422) { const e = new Error('conflict'); e.conflict = true; throw e; }
  if (r.status !== 200 && r.status !== 201) throw new Error('GitHub PUT ' + r.status);
}

// Read-modify-write with retry, so two people submitting at once don't clobber each other.
async function mutate(fn, message) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const { items, sha } = await readStore();
    const result = fn(items);
    try { await writeStore(items, sha, message); return result; }
    catch (e) { if (!e.conflict || attempt === 3) throw e; await new Promise(r => setTimeout(r, 300 * (attempt + 1))); }
  }
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function publicView(f) {
  const { email, ...rest } = f;
  return rest;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    if (req.method === 'GET') {
      const { items } = await readStore();
      const sorted = items.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      // Admins also get emails (for follow-up); everyone else gets the public view.
      return res.status(200).json({ feedback: isAdmin(req) ? sorted : sorted.map(publicView) });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const admin = isAdmin(req);
      if (b.website) return res.status(200).json({ ok: true }); // honeypot: silently drop bots

      const entry = {
        id: crypto.randomBytes(6).toString('hex'),
        name:     clean(b.name, LIMITS.name),
        role:     clean(b.role, LIMITS.role),
        material: clean(b.material, LIMITS.material),
        format:   clean(b.format, LIMITS.format),
        rating:   parseInt(b.rating, 10),
        comment:  clean(b.comment, LIMITS.comment),
        email:    clean(b.email, LIMITS.email),
        source:   admin ? 'admin' : 'learner',
        createdAt: new Date().toISOString()
      };
      if (admin && b.createdAt && !isNaN(new Date(b.createdAt))) entry.createdAt = new Date(b.createdAt).toISOString();
      if (!entry.email) delete entry.email;

      if (!entry.name)     return res.status(400).json({ error: 'Please enter your name.' });
      if (!entry.material) return res.status(400).json({ error: 'Please choose the training material.' });
      if (!(entry.rating >= 1 && entry.rating <= 5)) return res.status(400).json({ error: 'Please give a rating from 1 to 5.' });
      if (entry.comment.length < 10) return res.status(400).json({ error: 'Please write at least a sentence of feedback.' });

      await mutate(items => { items.push(entry); }, `feedback: ${entry.source} ${entry.id} (${entry.rating}★ ${entry.material})`);
      return res.status(201).json({ feedback: publicView(entry) });
    }

    if (req.method === 'DELETE') {
      if (!isAdmin(req)) return res.status(401).json({ error: 'Admin sign-in required.' });
      const id = clean((req.query && req.query.id) || '', 40);
      if (!id) return res.status(400).json({ error: 'Missing id.' });
      const found = await mutate(items => {
        const i = items.findIndex(x => x.id === id);
        if (i >= 0) items.splice(i, 1);
        return i >= 0;
      }, `feedback: admin delete ${id}`);
      if (!found) return res.status(404).json({ error: 'Feedback not found.' });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ error: 'Method not allowed.' });
  } catch (e) {
    console.error('feedback error:', e);
    return res.status(502).json({ error: 'Could not reach feedback storage. Please try again.' });
  }
};
