// src/_data/library.js — SINGLE SOURCE OF TRUTH for product counts and library contents.
// Every page reads its "N eBooks / N products" numbers and the "what's included" lists from here.
// Adding or removing an eBook kit? Change it here only — totals update everywhere on the next build.

const ebooks = [
  { key: 'dev_ebook',        name: 'Infor LN Development',              count: 73 },
  { key: 'adm_ebook',        name: 'Infor LN Administration',           count: 37 },
  { key: 'fin_ebook',        name: 'Infor LN Finance',                  count: 41 },
  { key: 'mfg_ebook',        name: 'Infor LN Manufacturing',            count: 10 },
  { key: 'log_ebook',        name: 'Infor LN Logistics',                count: 14 },
  { key: 'whs_ebook',        name: 'Infor LN Warehousing',              count: 14 },
  { key: 'pln_ebook',        name: 'Infor LN Planning',                 count: 14 },
  { key: 'bod_ebook',        name: 'Infor BOD',                         count: 11 },
  { key: 'ion_ebook',        name: 'Infor ION',                         count: 15 },
  { key: 'ext_ebook',        name: 'Infor Extensibility',               count: 6 },
  { key: 'mst_ebook',        name: 'Infor LN Multisite',                count: 5 },
  { key: 'infor_os',         name: 'Infor OS',                          count: 11 },
  { key: 'idm_ebook',        name: 'Infor IDM',                         count: 6 },
  { key: 'ln_api_ebook',     name: 'Infor LN API',                      count: 27 },
  { key: 'dom_ebook',        name: 'Infor DOM',                         count: 51 },
  { key: 'cloud_migration',  name: 'Cloud Migration & Upgrade Strategy', count: 7, extra: '+ Excel tool' },
  { key: 'ai_genai',         name: 'AI Agents & GenAI in Infor LN',     count: 7, extra: '+ Excel tool' }
];

// What the Full Video Library (₹34,999) contains
const videos = [
  { key: 'dev_video', name: 'Infor LN Development' },
  { key: 'adm_video', name: 'Infor LN Administration' },
  { key: 'fin_video', name: 'Infor LN Finance' },
  { key: 'mfg_video', name: 'Infor LN Manufacturing' },
  { key: 'log_video', name: 'Infor LN Logistics' },
  { key: 'pln_video', name: 'Infor LN Planning' },
  { key: 'whs_video', name: 'Infor LN Warehousing' },
  { key: 'ext_video', name: 'Infor Extensibility' }
];

// Real counts from the R2 bucket (number of PDF eBooks per kit), written by scripts/r2-counts.js at
// every build. A kit with no PDFs uploaded yet keeps the number typed above, so the site never says
// "0 eBooks" while you are still uploading.
const fallbackCounts = Object.fromEntries(ebooks.map(e => [e.key, e.count]));
let r2 = null;
try { r2 = require('./r2-counts.json'); } catch (e) { /* not generated (local build without R2) */ }
const countSource = {};
ebooks.forEach(e => {
  const n = r2 && r2.counts && Number(r2.counts[e.key]);
  if (n > 0) { e.count = n; countSource[e.key] = 'r2'; } else countSource[e.key] = 'manual';
});

const ebookTotal = ebooks.reduce((s, e) => s + e.count, 0);

module.exports = {
  byKey: Object.fromEntries(ebooks.map(e => [e.key, e])), // e.g. library.byKey.dev_ebook.count
  ebooks,                          // every eBook product; ALL are included in the Full eBook Library
  videos,                          // every video course; ALL are included in the Full Video Library
  ebookTotal,                      // total eBooks (bucket counts where available)
  fallbackCounts,                  // the numbers typed above (used when a kit has no PDFs in the bucket yet)
  countSource,                     // { dev_ebook: 'r2' | 'manual', … }
  countsGeneratedAt: r2 ? r2.generatedAt : null,
  ebookProducts: ebooks.length,    // 19
  videoCourses: videos.length,     // 8
  // ready-made phrases so the wording is identical everywhere
  ebookSummary: `${ebookTotal} eBooks across ${ebooks.length} eBook products`,
  ebookLibraryName: `Full eBook Library — All ${ebooks.length} eBook Products (${ebookTotal} eBooks)`,
  videoLibraryName: `Full Video Library — All ${videos.length} Video Courses`
};
