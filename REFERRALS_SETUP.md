# Sales Partner (Referral) Programme

Partners earn a commission on training sales they bring in. Every partner gets a **referral link** and a **referral code**, and a dashboard showing clicks, sales and commission.

| Page | Who uses it | URL |
|---|---|---|
| Partner admin | You | `/referrals-admin` (sign in to `/admin` first, or paste `ADMIN_API_TOKEN`) |
| Partner dashboard | Sales partners | `/partners` (email + access code) |

## How a sale is tracked (industry-standard affiliate model)

1. **Referral link.** A partner shares `https://training.fullonbaan.com/?ref=CODE`. It works on any page, for example `/pricing/?ref=CODE`. The site stores the code in a first-party cookie (`fob_ref`) for **30 days**. If a buyer opens links from two partners, the **last one wins**. One click is logged per visitor per day, and `?ref=` is removed from the address bar.
2. **Referral code.** At checkout, the *Referral code* box is pre-filled from the link. A buyer can also type a code a partner gave them by phone or WhatsApp. The box shows "✓ Referred by Asha" for a valid code. Whatever is in the box when they pay is the code that counts.
3. **Server-side validation.** `/api/checkout` accepts the code only if it belongs to an *active* partner and the buyer's email isn't the partner's own (no self-referral). The code is then written onto the Razorpay order (`notes.ref`). Nobody can attach a code to an order after it has been paid.
4. **Commission line.** When the order is paid (via the thank-you page or the webhook), exactly one commission line is created per order. The partner's % is **frozen at that moment**, and the partner gets an email.

**Commission = partner % × price excluding GST.** GST is never commissionable.

## Commission lifecycle

| Status | Meaning |
|---|---|
| Review | A partner reported an offline sale (UPI / bank transfer). You verify the payment, then **Approve** or **Reject** it. |
| In hold | An online order is inside the 7-day money-back window (`REF_HOLD_DAYS`, default 7). |
| Payable | The hold period is over (this happens automatically), or you approved the line. |
| Paid | You paid the partner and recorded the UTR / transaction id with **Mark ticked lines paid**. |
| Void | Refunded, rejected, or a self-referral. Use **Void** for refunds. |

## Admin tasks (`/referrals-admin`)

- **Onboard a partner:** enter name, email, code (or click *Suggest*), commission %, and payout details. The partner is emailed their link, code and dashboard access code. The access code is also shown to you **once**.
- **Change the %:** applies to new sales only. The rate history is kept.
- **Disable a partner:** their code stops working at checkout and they are signed out. Existing lines stay.
- **New access code:** use this if a partner loses theirs. Partners can also request one from `/partners`.
- **Pay out:** open the partner. Payable lines are pre-ticked. Pay them, enter the UTR, then mark the lines paid.
- **Offline deal:** use *Add an offline sale* (it's approved immediately), or approve a partner's claim from the *Needs your attention* box.
- **Download CSV:** exports the full ledger for accounts or TDS working.

New orders in the `/admin` payments register now carry `refCode` / `refSrc` (link or typed code). The new-order alert email includes **Referred by partner CODE**.

## Settings (Vercel env, all optional)

| Variable | Default | Purpose |
|---|---|---|
| `REF_HOLD_DAYS` | `7` | Days before an online order's commission becomes payable (matches the refund policy) |
| `REF_MAX_PCT` | `60` | Highest commission % the admin form accepts |

No new secrets are needed. The programme uses the existing R2 bucket, EmailJS member template, `MEMBER_SESSION_SECRET`, and admin auth.

## Storage (private R2 bucket)

```
referrals/partners/<CODE>.json          partner (scrypt-hashed access code, %, payout details, rate history)
referrals/byemail/<sha256(email)>.json  one partner per email
referrals/sales/<CODE>/<orderId>.json   commission line (customer email masked for partner views)
referrals/clicks/<CODE>.json            unique clicks per month
```

## Notes

- Partners never see buyers' full emails (`pr***@corp.com`). They see product, date, amount and commission.
- If referral storage fails, the order still completes. The error is logged as `REFERRAL COMMISSION NOT RECORDED`, and the admin email still shows the partner code so you can add the line manually.
- Consider adding a line to the Privacy Policy saying a first-party cookie (`fob_ref`, 30 days) records which partner referred a visitor.
- Tests: `node tests/referral.test.js` (part of `npm test`).
