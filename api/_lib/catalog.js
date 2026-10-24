// api/_lib/catalog.js — SERVER-SIDE pricing. The browser never decides what a customer is charged.
// Prices, products and eBook folders come from src/_data/products.js and the sale from
// src/_data/sale.js — the same files the website is built from — so page and charge always agree.
//
// Pricing rules (identical to the page):
//   INR      : base price (sale price while a sale is live) + 18% GST  → CGST+SGST or IGST by state
//   USD/EUR  : fixed international price (no GST); sale uses its `fixed` price or the computed %
const data = require('../../src/_data/products.js');
const sale = require('../../src/_data/sale.js');

const PRODUCTS = data.products;
const EBOOKS = data.EBOOK_FOLDERS;
const CURRENCIES = ['INR', 'USD', 'EUR'];
const GST_RATE = 0.18;
const SELLER_STATE_CODE = '29';            // Karnataka

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const r2d = (x) => Math.round(x * 100) / 100;

function getProduct(key) { return has(PRODUCTS, key) ? PRODUCTS[key] : null; }
function isEbook(code) { return has(EBOOKS, code); }

function convertPrice(inr, currency) {
  if (currency === 'INR') return inr;
  const f = data.FIXED_PRICES[inr];
  if (f && f[currency]) return f[currency];
  const converted = (inr / data.CURRENCY_RATES[currency].rate) * 1.25;
  return Math.ceil(converted / 5) * 5;
}

function saleLive(atMs) {
  const t = atMs == null ? Date.now() : atMs;
  return !!(sale.enabled && t >= sale.startsMs && t <= sale.endsMs);
}

// → { list, price, onSale } in the currency's major unit, BEFORE GST.
function basePrice(key, currency, atMs) {
  const p = getProduct(key);
  if (!p || CURRENCIES.indexOf(currency) < 0) return null;
  const list = convertPrice(p.price, currency);
  const cfg = sale.products && sale.products[key];
  if (cfg && saleLive(atMs)) {
    const was = convertPrice(cfg.was, currency);
    const now = (cfg.fixed && cfg.fixed[currency]) || Math.floor(was * (100 - sale.percent) / 100);
    return { list: was, price: now, onSale: now !== was };
  }
  return { list, price: list, onSale: false };
}

// GST on top of a base price (mirrors calcGSTSplit on the page).
function gstSplit(base, currency, buyerStateCode) {
  base = r2d(base);
  if (currency !== 'INR') return { base, cgst: 0, sgst: 0, igst: 0, gst: 0, total: base, taxType: 'NONE' };
  const gst = r2d(base * GST_RATE), total = r2d(base + gst);
  if (buyerStateCode && String(buyerStateCode) === SELLER_STATE_CODE) {
    const cgst = r2d(base * 0.09);
    return { base, cgst, sgst: r2d(gst - cgst), igst: 0, gst, total, taxType: 'CGST_SGST' };
  }
  return { base, cgst: 0, sgst: 0, igst: gst, gst, total, taxType: 'IGST' };
}

// Full quote for a product → amounts + the description recorded on the order / invoice.
function quote(key, currency, opts) {
  opts = opts || {};
  const p = getProduct(key);
  const b = basePrice(key, currency, opts.at);
  if (!p || !b) return null;
  const split = gstSplit(b.price, currency, opts.stateCode);
  return Object.assign({}, split, {
    key, currency, list: b.list, onSale: b.onSale,
    amountMinor: Math.round(split.total * 100),
    desc: b.onSale ? p.name + ' — ' + sale.name + ' ' + sale.percent + '% off' : p.name
  });
}
function priceMinor(key, currency, atMs) { const q = quote(key, currency, { at: atMs }); return q ? q.amountMinor : null; }

module.exports = { PRODUCTS, EBOOKS, CURRENCIES, ALL: data.ALL_EBOOKS, getProduct, isEbook, convertPrice, saleLive, basePrice, gstSplit, quote, priceMinor, SELLER_STATE_CODE };
