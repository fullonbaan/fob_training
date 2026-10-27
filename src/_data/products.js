// src/_data/products.js — THE price list. Used by:
//   • the website (base.njk / pricing.njk render their GUIDES, FIXED_PRICES and CURRENCY_RATES from it)
//   • the server (api/_lib/catalog.js) — the amount Razorpay charges is computed from THIS file
// So a price changed here changes on the page AND in the charge, with no chance of a mismatch.
//
// price    = BASE price in INR, EXCLUDING 18% GST (GST is added at checkout for INR buyers)
// kind     = ebook | video | combo | bundle
// ebooks   = eBook folders this product unlocks in the Members Library (see EBOOK_FOLDERS)
// video    = true if the product includes video lectures (delivered manually, as before)
//
// Sales are configured in src/_data/sale.js (applies to the page and the server alike).

const library = require('./library.js');

const n = (k) => library.byKey[k].count;
const eb = (k) => n(k) + ' eBook' + (n(k) === 1 ? '' : 's');

// Members Library folders: ebooks/<code>/ in the private R2 bucket. Every PDF (or Excel / ZIP)
// you upload into a folder appears for everyone who bought a product that unlocks that code.
const EBOOK_FOLDERS = {
  dev:   { name: 'Infor LN Development',               track: 'Technical',  product: 'dev_ebook' },
  adm:   { name: 'Infor LN Administration',            track: 'Technical',  product: 'adm_ebook' },
  ext:   { name: 'Infor Extensibility',                track: 'Technical',  product: 'ext_ebook' },
  bod:   { name: 'Infor BOD',                          track: 'Technical',  product: 'bod_ebook' },
  ion:   { name: 'Infor ION',                          track: 'Technical',  product: 'ion_ebook' },
  os:    { name: 'Infor OS',                           track: 'Technical',  product: 'infor_os' },
  idm:   { name: 'Infor IDM',                          track: 'Technical',  product: 'idm_ebook' },
  lnapi: { name: 'Infor LN API',                       track: 'Technical',  product: 'ln_api_ebook' },
  dom:   { name: 'Infor DOM',                          track: 'Technical',  product: 'dom_ebook' },
  fin:   { name: 'Infor LN Finance',                   track: 'Functional', product: 'fin_ebook' },
  mfg:   { name: 'Infor LN Manufacturing',             track: 'Functional', product: 'mfg_ebook' },
  log:   { name: 'Infor LN Logistics',                 track: 'Functional', product: 'log_ebook' },
  whs:   { name: 'Infor LN Warehousing',               track: 'Functional', product: 'whs_ebook' },
  pln:   { name: 'Infor LN Planning',                  track: 'Functional', product: 'pln_ebook' },
  mst:   { name: 'Infor LN Multisite',                 track: 'Functional', product: 'mst_ebook' },
  cloud: { name: 'Cloud Migration & Upgrade Strategy', track: 'Strategy',   product: 'cloud_migration' },
  ai:    { name: 'AI Agents & GenAI in Infor LN',      track: 'Strategy',   product: 'ai_genai' },
  ln2026:{ name: 'Infor LN 2026 Consultant Bundle',    track: 'Strategy',   product: 'ln2026_bundle' }
};
const ALL_EBOOKS = Object.keys(EBOOK_FOLDERS);

const P = {
  dev_ebook:          { name: 'Infor LN Development — eBook',     price: 1999, kind: 'ebook', ebooks: ['dev'] },
  adm_ebook:          { name: 'Infor LN Administration — eBook',  price: 1999, kind: 'ebook', ebooks: ['adm'] },
  fin_ebook:          { name: 'Infor LN Finance — eBook',         price: 1999, kind: 'ebook', ebooks: ['fin'] },
  mfg_ebook:          { name: 'Infor LN Manufacturing — eBook',   price: 1999, kind: 'ebook', ebooks: ['mfg'] },
  log_ebook:          { name: 'Infor LN Logistics — eBook',       price: 1999, kind: 'ebook', ebooks: ['log'] },
  pln_ebook:          { name: 'Infor LN Planning — eBook',        price: 1999, kind: 'ebook', ebooks: ['pln'] },
  whs_ebook:          { name: 'Infor LN Warehousing — eBook',     price: 1999, kind: 'ebook', ebooks: ['whs'] },
  ext_ebook:          { name: 'Infor Extensibility — eBook',      price: 1999, kind: 'ebook', ebooks: ['ext'] },
  bod_ebook:          { name: 'Infor BOD — eBook',                price: 1999, kind: 'ebook', ebooks: ['bod'] },
  ion_ebook:          { name: 'Infor ION — eBook',                price: 1999, kind: 'ebook', ebooks: ['ion'] },
  mst_ebook:          { name: 'Infor LN Multisite — eBook',       price: 1999, kind: 'ebook', ebooks: ['mst'] },
  infor_os:           { name: 'Infor OS — ' + eb('infor_os'),         price: 1999, kind: 'ebook', ebooks: ['os'] },
  idm_ebook:          { name: 'Infor IDM — ' + eb('idm_ebook'),       price: 1999, kind: 'ebook', ebooks: ['idm'] },
  ln_api_ebook:       { name: 'Infor LN API — ' + eb('ln_api_ebook'), price: 2499, kind: 'ebook', ebooks: ['lnapi'] },
  dom_ebook:          { name: 'Infor DOM — ' + eb('dom_ebook'),       price: 1999, kind: 'ebook', ebooks: ['dom'] },
  cloud_migration:    { name: 'Cloud Migration & Upgrade Strategy — ' + eb('cloud_migration') + ' + Excel', price: 2499, kind: 'ebook', ebooks: ['cloud'] },
  ai_genai:           { name: 'AI Agents & GenAI in Infor LN — ' + eb('ai_genai') + ' + Excel',             price: 2499, kind: 'ebook', ebooks: ['ai'] },

  // Bundled eBooks — several new titles sold together, delivered from ONE Members Library folder (ebooks/ln2026/).
  ln2026_bundle:      { name: 'Infor LN 2026 Consultant Bundle — ' + eb('ln2026_bundle'), price: 2999, kind: 'bundle', ebooks: ['ln2026'] },

  dev_video:          { name: 'Infor LN Development — Video Course',    price: 4999, kind: 'video', ebooks: [], video: true },
  adm_video:          { name: 'Infor LN Administration — Video Course', price: 4999, kind: 'video', ebooks: [], video: true },
  fin_video:          { name: 'Infor LN Finance — Video Course',        price: 4999, kind: 'video', ebooks: [], video: true },
  mfg_video:          { name: 'Infor LN Manufacturing — Video Course',  price: 4999, kind: 'video', ebooks: [], video: true },
  log_video:          { name: 'Infor LN Logistics — Video Course',      price: 4999, kind: 'video', ebooks: [], video: true },
  pln_video:          { name: 'Infor LN Planning — Video Course',       price: 4999, kind: 'video', ebooks: [], video: true },
  whs_video:          { name: 'Infor LN Warehousing — Video Course',    price: 4999, kind: 'video', ebooks: [], video: true },
  ext_video:          { name: 'Infor Extensibility — Video Course',     price: 4999, kind: 'video', ebooks: [], video: true },

  // Combo = eBook + video. Only the eBook part is unlocked online; videos are delivered as before.
  dev_combo:          { name: 'Infor LN Development — Combo (eBook + Video)',    price: 5999, kind: 'combo', ebooks: ['dev'], video: true },
  adm_combo:          { name: 'Infor LN Administration — Combo (eBook + Video)', price: 5999, kind: 'combo', ebooks: ['adm'], video: true },
  fin_combo:          { name: 'Infor LN Finance — Combo (eBook + Video)',        price: 5999, kind: 'combo', ebooks: ['fin'], video: true },
  mfg_combo:          { name: 'Infor LN Manufacturing — Combo (eBook + Video)',  price: 5999, kind: 'combo', ebooks: ['mfg'], video: true },
  log_combo:          { name: 'Infor LN Logistics — Combo (eBook + Video)',      price: 5999, kind: 'combo', ebooks: ['log'], video: true },
  pln_combo:          { name: 'Infor LN Planning — Combo (eBook + Video)',       price: 5999, kind: 'combo', ebooks: ['pln'], video: true },
  whs_combo:          { name: 'Infor LN Warehousing — Combo (eBook + Video)',    price: 5999, kind: 'combo', ebooks: ['whs'], video: true },
  ext_combo:          { name: 'Infor Extensibility — Combo (eBook + Video)',     price: 5999, kind: 'combo', ebooks: ['ext'], video: true },

  full_ebook_library: { name: library.ebookLibraryName, price: 15999, kind: 'bundle', ebooks: ALL_EBOOKS },
  full_video_library: { name: library.videoLibraryName, price: 34999, kind: 'bundle', ebooks: [], video: true }
};

// International prices (no GST). Exact USD/EUR price for an INR base price, otherwise
// INR / rate × 1.25, rounded up to the nearest 5.
const CURRENCY_RATES = { INR: { symbol: '₹', rate: 1 }, USD: { symbol: '$', rate: 85 }, EUR: { symbol: '€', rate: 92 } };
const FIXED_PRICES = {
  4999: { USD: 80, EUR: 80 }, 5999: { USD: 100, EUR: 100 }, 15999: { USD: 400, EUR: 400 }, 34999: { USD: 800, EUR: 800 },
  499: { USD: 10, EUR: 9 }, 999: { USD: 20, EUR: 20 }, 1999: { USD: 40, EUR: 40 }, 2499: { USD: 40, EUR: 40 }, 2999: { USD: 50, EUR: 50 },
  3488: { USD: 45, EUR: 40 }, 3999: { USD: 59, EUR: 55 }, 4000: { USD: 60, EUR: 55 }, 4499: { USD: 65, EUR: 60 },
  4488: { USD: 39, EUR: 36 }, 6999: { USD: 99, EUR: 95 }, 7999: { USD: 109, EUR: 99 }, 8999: { USD: 119, EUR: 109 },
  11487: { USD: 159, EUR: 149 }, 12999: { USD: 179, EUR: 169 }, 12793: { USD: 165, EUR: 149 }, 12994: { USD: 160, EUR: 149 },
  14999: { USD: 199, EUR: 189 }, 18999: { USD: 245, EUR: 225 }, 19199: { USD: 249, EUR: 229 }, 27993: { USD: 359, EUR: 339 },
  31992: { USD: 419, EUR: 389 }
};

// What the browser needs ({key:{name, price}}) — rendered into the pages' GUIDES object.
const clientGuides = {};
Object.keys(P).forEach(k => { clientGuides[k] = { name: P[k].name, price: P[k].price }; });

module.exports = { products: P, EBOOK_FOLDERS, ALL_EBOOKS, CURRENCY_RATES, FIXED_PRICES, clientGuides };
