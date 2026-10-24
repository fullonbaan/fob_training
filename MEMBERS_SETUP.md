# Members Library & server-side checkout — training.fullonbaan.com

Same design as interview.fullonbaan.com, adapted to the training catalogue:
**eBooks are unlocked online automatically; videos keep the existing flow** (order confirmation +
admin alert, you deliver access within 24 hours). Combos unlock **only the eBook part** online.

---

## 1. How it works

```
 Customer picks a product on /pricing ──► /api/checkout?action=order
                          (server creates the Razorpay ORDER at the price in src/_data/products.js
                           + 18% GST for INR, sale price while src/_data/sale.js is live)
          │
          ▼
 Razorpay checkout ──paid──► /api/checkout?action=verify      (browser, instantly)
                    └──────► /api/razorpay-webhook             (Razorpay server, safety net)
                               │  both: verify HMAC signature → re-read order from Razorpay
                               │        → check amount & status → settle (exactly once per order)
                               ▼
     eBook / combo / Full eBook Library             Video course / Full Video Library
     ─────────────────────────────────              ─────────────────────────────────
     • kits unlocked in the Members Library         • nothing to unlock online
     • access code (stored only as a hash)          • (as before) you deliver video access
     • "your access code" email
     ─────────── both ─────────────────────────────────────────────────────────────
     • register line in fob_pay_store_ln_int → "confirmed" + GST invoice number (FOB#######)
     • tax-invoice / confirmation email to the customer, order alert to you
       (the alert says "VIDEO ACCESS TO BE SENT MANUALLY" when the order contains videos)
          │
          ▼
 /members  ── email + access code ──► HttpOnly session cookie (7 days)
          ── shows ONLY the kits they bought ── Read online / Download
          ── /api/member?action=file → checks entitlement + per-file cap → personal
             watermarked PDF → 5-minute signed link
```

Returning customers keep one code for life — a new purchase just adds kits to the same library.

### What each product unlocks

| Product | Online (Members Library) | Delivered by you |
|---|---|---|
| Any single eBook (`dev_ebook` … `ai_genai`) | that eBook kit | — |
| Combo (`dev_combo` … `ext_combo`) | the eBook kit of that module | video lectures |
| Full eBook Library | all 17 eBook kits | — |
| Video course (`*_video`) | — | video course |
| Full Video Library | — | all video courses |

---

## 2. Where the eBooks go — private R2 bucket `fob-training-ebooks`

**Create the folders in one click:** open `/members-admin` → *eBook library* → **Create folder structure in bucket**.
It makes these folders (safe to click again):

| Folder | eBook kit | Sold as |
|---|---|---|
| `ebooks/dev/` | Infor LN Development | `dev_ebook`, `dev_combo`, Full eBook Library |
| `ebooks/adm/` | Infor LN Administration | `adm_ebook`, `adm_combo`, Full eBook Library |
| `ebooks/ext/` | Infor Extensibility | `ext_ebook`, `ext_combo`, Full eBook Library |
| `ebooks/bod/` | Infor BOD | `bod_ebook`, Full eBook Library |
| `ebooks/ion/` | Infor ION | `ion_ebook`, Full eBook Library |
| `ebooks/os/` | Infor OS | `infor_os`, Full eBook Library |
| `ebooks/idm/` | Infor IDM | `idm_ebook`, Full eBook Library |
| `ebooks/lnapi/` | Infor LN API | `ln_api_ebook`, Full eBook Library |
| `ebooks/dom/` | Infor DOM | `dom_ebook`, Full eBook Library |
| `ebooks/fin/` | Infor LN Finance | `fin_ebook`, `fin_combo`, Full eBook Library |
| `ebooks/mfg/` | Infor LN Manufacturing | `mfg_ebook`, `mfg_combo`, Full eBook Library |
| `ebooks/log/` | Infor LN Logistics | `log_ebook`, `log_combo`, Full eBook Library |
| `ebooks/whs/` | Infor LN Warehousing | `whs_ebook`, `whs_combo`, Full eBook Library |
| `ebooks/pln/` | Infor LN Planning | `pln_ebook`, `pln_combo`, Full eBook Library |
| `ebooks/mst/` | Infor LN Multisite | `mst_ebook`, Full eBook Library |
| `ebooks/cloud/` | Cloud Migration & Upgrade Strategy (+ Excel tool) | `cloud_migration`, Full eBook Library |
| `ebooks/ai/` | AI Agents & GenAI in Infor LN (+ Excel tool) | `ai_genai`, Full eBook Library |

**Upload each eBook once** — combos and the Full eBook Library read the same folders.

Rules (no code change ever needed):
- Every file in a folder shows up straight away for everyone who owns that kit (including past buyers).
- Allowed: **PDF** (read online + download, watermarked per buyer) and **Excel / Word / PowerPoint / ZIP**
  (download only, served as-is — use this for the "+ Excel tool" kits).
- **Title shown = file name** without the extension. A leading number such as `01 - `, `2_` or `03) ` sets the order and is hidden.
- Names starting with `_` are hidden (drafts). The `.keep` marker files are hidden too.
- **Replace** a file by uploading one with the same name — buyers get the new edition on their next open.
- **Delete** a file to remove it from libraries.
- Until a kit has files, its buyers see "Your eBooks for this kit are being prepared…".

Two ways to upload: **/members-admin → "+ Upload file(s)"** next to the kit (needs the CORS rule below),
or **Cloudflare dashboard → R2 → fob-training-ebooks → Objects → ebooks/<folder>/ → Upload**.
Thumbnails are made automatically from page 1 of each PDF whenever you open /members-admin.

### One-time: R2 CORS rule (for uploads and thumbnails from /members-admin)
Cloudflare → R2 → `fob-training-ebooks` → **Settings → CORS Policy**:
```json
[
  {
    "AllowedOrigins": ["https://training.fullonbaan.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```
Keep **Public access = Disabled** on the bucket (no r2.dev URL, no custom domain).

---

## 3. Remaining one-time setup (your Vercel env variables are already in place)

1. **EmailJS — two accounts, each for its own emails:**

   | Emails | Account | Settings used |
   |---|---|---|
   | Access code + library link (after purchase, admin grant, "email me a new code") | **new** account | `EMAILJS_SERVICE_ID` (`service_929have`), `EMAILJS_PUBLIC_KEY`, `EMAILJS_PRIVATE_KEY`, template `FOB_Member_Access` |
   | Tax invoice / order confirmation to the customer, new-order alert, payment-failed and checkout-closed alerts to you | **original** account, same as before | `service_2qtgzr5`, public key `3U-YZo2UCV_RG5Gjo`, templates `FOB_Razorpay_Success` / `FOB_Razorpay_Failure` (built in — no env needed) |

   - New account: **"Allow EmailJS API for non-browser applications"** must be ticked (the access-code emails are sent by the server).
   - Original account: these emails now go from the **server** instead of the browser, so it also needs
     **"Allow EmailJS API for non-browser applications"** ticked. If **"Use Private Key"** is on in that account
     (the interview site's setup suggests it), add its private key to the training project as
     **`EMAILJS_NOTIFY_PRIVATE_KEY`** — the same value as `EMAILJS_PRIVATE_KEY` in the interview project.
   - Safety net: if a notification can't go through the original account, the server sends the same
     information as a branded HTML email through `FOB_Member_Access`, so the customer is never left without
     a confirmation (the Vercel log shows a warning when this happens).
   - Optional overrides: `EMAILJS_NOTIFY_SERVICE_ID`, `EMAILJS_NOTIFY_PUBLIC_KEY`, `EMAILJS_TEMPLATE_PAYMENT`, `EMAILJS_TEMPLATE_FAILURE`.
2. **Razorpay webhook** — Dashboard → Settings → Webhooks → Add:
   URL `https://training.fullonbaan.com/api/razorpay-webhook`, secret = `RAZORPAY_WEBHOOK_SECRET`,
   event **order.paid** (optionally payment.captured).
3. Keep the existing env vars **`GITHUB_PAT`** (order register) and **`ADMIN_PASSWORD`** (/admin).
4. Optional env: `ADMIN_ALERT_EMAIL` (default fullonbaan@gmail.com), `DOWNLOAD_LIMIT_PER_GUIDE` (25 opens per
   file per buyer), `LINK_TTL_SECONDS` (300), `WATERMARK` (`off` serves the master file), `RL_ORDERS_PER_HOUR` (20).

## 4. Deploy & go-live check
1. Commit and push (Vercel installs `aws4fetch` + `pdf-lib`).
2. `/members-admin` → paste `ADMIN_API_TOKEN` (or sign in to `/admin` first) → **Create folder structure in bucket** → upload at least one PDF.
3. *Grant access* → your own email + an eBook kit → you get the code email → sign in at `/members` → Read online + Download → check the footer watermark.
4. One real ₹ purchase of an eBook and one of a video (refund both in Razorpay afterwards). eBook thank-you shows the access code;
   video thank-you says "delivered within 24 hours". Both appear as **confirmed** with an invoice number in `/admin`.

## 5. Day-to-day — `/members-admin`
- **UPI / bank-transfer buyers, past customers**: *Grant access* → email + product (or tick kits) + UTR in the note.
- **Lost code**: open the member → *Issue new code & email it* (signs out every device). Customers can also self-serve on `/members`.
- **Refund**: refund in Razorpay, then *Revoke* the kit(s).
- **Suspicious sharing**: access log per member; *Reset count*, *Disable account*.

## 6. Security changes in this release
| Before | Now |
|---|---|
| The browser decided the amount and opened Razorpay without an order | **Server creates the order** at the catalogue price; amount re-checked on payment |
| The browser wrote order lines to the register (`POST /api/payments` was public) | Register written **only by the server**; `/api/payments` is admin-only |
| Anyone could call `GET /api/invoice-counter` and burn invoice numbers | Admin-only; paid orders are numbered by the server, once per order (lock) |
| Invoice/alert emails sent from the browser | Sent by the server (same original EmailJS account and templates) |
| If the buyer closed the tab, no email/record | **Webhook** completes everything |
| Prices duplicated in 2 templates | One list: **`src/_data/products.js`** (page + server) |

Admin endpoints accept either `Authorization: Bearer ADMIN_API_TOKEN` or the `/admin` password session.

## 7. Files
```
src/_data/products.js     THE price list + eBook folders (page and server both read it)
api/_lib/catalog.js       server pricing: sale, USD/EUR, GST (identical to the page)
api/_lib/library.js       reads each kit's folder live from the bucket
api/_lib/members.js       member records, entitlements, fulfilment (video-only → no access)
api/_lib/settle.js        once-per-order: unlock, invoice number, register, emails
api/_lib/payrecords.js    order register (fob_pay_store_ln_int) — server-only writes
api/_lib/email.js         emails via EmailJS REST (server-side): access codes → new account, everything else → original account
api/_lib/{auth,crypto,r2,razorpay,ratelimit,stamp,http}.js   shared helpers
api/checkout.js           order + verify + failure/abandon alerts
api/razorpay-webhook.js   safety net
api/member.js             sign in, library, files, new code
api/member-admin.js       admin API
api/payments.js, api/invoice-counter.js   now admin-only (same data, same /admin dashboard)
src/members.njk           /members        — the Members Library
src/members-admin.njk     /members-admin  — admin console
src/pricing.njk           server-side checkout, thank-you shows access code / video delivery note
src/_includes/base.njk    prices rendered from products.js, "Member Login" links
vercel.json, src/robots.txt, package.json
tests/                    offline test suite:  npm test
```
⚠ Change prices **only in `src/_data/products.js`** (and sales in `src/_data/sale.js`). The cards on
catalog/home pages still show their own display prices — keep those in step when you change a price.

## 8. Troubleshooting — "R2 … 403" on /members-admin
The admin page now shows R2's own reason under the token box. What each one means:

| R2 says | Fix |
|---|---|
| **AccessDenied** | The R2 API token isn't allowed on `fob-training-ebooks`. Most common cause: the interview site's R2 keys were reused — that token is limited to `fob-interview-ebooks`. Cloudflare → R2 → **Manage R2 API Tokens** → create a token with **Object Read & Write**, bucket **fob-training-ebooks** (or edit the existing token and add this bucket) → put its **Access Key ID** / **Secret Access Key** in Vercel. |
| **SignatureDoesNotMatch** | `R2_SECRET_ACCESS_KEY` doesn't belong to `R2_ACCESS_KEY_ID` (a key from another token, or mistyped). |
| **InvalidAccessKeyId** | `R2_ACCESS_KEY_ID` holds the wrong value — use the 32-character **Access Key ID** shown once when the token is created, not the token value itself. |
| **NoSuchBucket** | `R2_BUCKET` misspelt, or `R2_ACCOUNT_ID` is a different Cloudflare account. |

Also check: the bucket `fob-training-ebooks` exists; `R2_ACCOUNT_ID` is the 32-character Account ID from the R2 overview page.
For an EU-jurisdiction bucket set `R2_JURISDICTION=eu`. **After changing env vars, redeploy** — Vercel only picks them up on a new deployment.
