// scripts/r2-counts.js — runs before every build (npm run build). Counts the PDF eBooks in each kit's
// folder of the private R2 bucket (sub-folders included, hidden "_" items skipped) and writes
// src/_data/r2-counts.json. src/_data/library.js uses those numbers everywhere the site shows
// eBook counts (catalog, pricing, home page, product names, invoices).
//
// Safe by design: if R2 isn't configured (local build) or can't be reached, the file is left as it is
// and the site keeps the counts typed in library.js. The build never fails because of this step.
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'src', '_data', 'r2-counts.json');

(async () => {
  const need = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
  if (!process.env.FOB_LOCAL_STORE && need.some(k => !String(process.env[k] || '').trim())) {
    console.log('[r2-counts] R2 not configured here — keeping the counts in src/_data/library.js');
    return;
  }
  try {
    const counts = await require('../api/_lib/counts').countPdfs();
    fs.writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), counts }, null, 2) + '\n');
    console.log('[r2-counts] PDF eBooks per kit:', JSON.stringify(counts));
  } catch (e) {
    console.warn('[r2-counts] could not read the bucket (' + e.message.slice(0, 200) + ') — keeping the previous counts');
  }
})();
