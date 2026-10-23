// src/_data/sale.js — the ONE place that controls a sale.
//
// Only the products listed in `products` are discounted. For each one, `was` is the original
// price (INR) shown struck through, and the sale price is `was` minus `percent`, rounded down.
// Applies everywhere: catalog, pricing, homepage, checkout dropdown, the amount charged through
// Razorpay, and the GST invoice. A sticky banner shows on every page while the sale is live.
//
// The end time is enforced in the visitor's browser as well as at build time, so the sale switches
// itself off at `endsAt` even if the site isn't rebuilt. To stop it early: enabled: false + redeploy.

const sale = {
  enabled:   true,
  name:      'Diwali Sale',
  percent:   50,
  startsAt:  '2026-10-23T00:00:00+05:30',     // IST
  endsAt:    '2026-11-10T23:59:59+05:30',     // IST — last moment the sale price applies
  endsLabel: '10 Nov 2026',
  bannerText: 'on the Full eBook Library & Full Video Library',
  products: {
    // `was` = original INR price. `fixed` = an exact sale price for a currency, used instead of
    // the computed 50% (other currencies are computed from their own original price).
    full_ebook_library: { was: 15999, fixed: { USD: 199, EUR: 199 } },   // ₹15,999 → ₹7,999 · $400 → $199 · €400 → €199
    full_video_library: { was: 34999, fixed: { USD: 399, EUR: 399 } }    // ₹34,999 → ₹17,499 · $800 → $399 · €800 → €399
  }
};

const now = Date.now();
sale.startsMs = Date.parse(sale.startsAt);
sale.endsMs = Date.parse(sale.endsAt);
sale.live = sale.enabled && now >= sale.startsMs && now <= sale.endsMs;
for (const k of Object.keys(sale.products)) {
  sale.products[k].now = Math.floor(sale.products[k].was * (100 - sale.percent) / 100);
}

module.exports = sale;
