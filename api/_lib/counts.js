// api/_lib/counts.js — number of PDF eBooks in each kit's folder of the bucket, by PRODUCT key
// ({ dev_ebook: 81, fin_ebook: 41, … }). Used by the build (scripts/r2-counts.js) and by
// /api/catalog-counts (live numbers on the catalog page).
const r2 = require('./r2');
const library = require('./library');
const catalog = require('./catalog');

async function countPdfs() {
  const objs = await r2.listObjects(library.ROOT);
  const byCode = {}; Object.keys(catalog.EBOOKS).forEach(c => { byCode[c] = 0; });
  objs.forEach(o => { const p = library.parseKey(o.key); if (p && p.ext === 'pdf') byCode[p.guide]++; });
  const out = {};
  Object.keys(byCode).forEach(c => { out[catalog.EBOOKS[c].product] = byCode[c]; });
  return out;
}

module.exports = { countPdfs };
