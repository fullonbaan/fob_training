// api/catalog-counts.js — PUBLIC, read-only: how many PDF eBooks each kit has in the bucket right now.
//   GET /api/catalog-counts → { counts: { dev_ebook: 81, … }, total: 412, at: "…" }
// Lets /catalog/ show new uploads without a redeploy. Only numbers leave the server (no file names).
// Cached at Vercel's edge for 5 minutes, so visitors never hit the bucket directly.
const library = require('../src/_data/library.js');
const { countPdfs } = require('./_lib/counts');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const live = await countPdfs();
    const counts = {};
    Object.keys(library.fallbackCounts).forEach(k => { counts[k] = live[k] > 0 ? live[k] : library.fallbackCounts[k]; });
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    res.setHeader('Vercel-CDN-Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.setHeader('CDN-Cache-Control', 'public, max-age=300, stale-while-revalidate=3600');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.statusCode = 200;
    return res.end(JSON.stringify({ counts, total, at: new Date().toISOString() }));
  } catch (e) {
    console.error('catalog-counts failed', e.message);
    res.setHeader('Cache-Control', 'no-store');
    res.statusCode = 503;
    return res.end(JSON.stringify({ error: 'counts unavailable' }));
  }
};
