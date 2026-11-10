# Payment integration approach

## Status

**Sandbox only.** The only provider in this build is the built-in mock. The API refuses to start with any other `PAYMENT_PROVIDER`. Do not take real money until the payment provider, a CA (GST treatment of the convenience fee) and the relevant authorities/SRM have approved the structure in writing.

## Flow (same for both modes)

1. Student confirms the cart → `POST /orders` (server prices, idempotency key) → `PENDING_PAYMENT`.
2. `POST /payments/checkout` creates (once) the provider order and a new **payment attempt** session server-side and returns a **hosted checkout URL**.
3. Student pays on the hosted page. The page may redirect back, but the return is **never** treated as payment.
4. The provider's **signed webhook** is verified over the raw body, deduplicated by event id, checked for amount, currency and order id, and applied in one transaction (order → `AWAITING_VENDOR`, planned splits, notifications).
5. A **reconciliation job** (every 30 s) asks the provider about payments still open on our side and applies what it reports through the same idempotent path, recording each correction. This covers lost webhooks and closed browsers.
6. Failures leave the order payable until the checkout expires (10 min); expiry releases the slot. A success that arrives after the order closed is refunded automatically.
7. Rejection, cancellation and expiry of paid orders start a full refund. Admins can issue partial refunds (never above what was paid) and retry failed refunds.

## Commercial model (configurable, not hard-coded)

- Vendor receives the **original menu price** (food subtotal).
- Student pays a separate **QuickPick convenience fee**, default **7%** of the food subtotal, rounded half-up to the paisa: ₹100 food → ₹7 fee → ₹107.
- The fee rate and tax mode are **versioned per ordering mode** (`PREORDER`, `WALKIN_QR`) and changed only by the super-admin. Each order stores its own snapshot.
- Tax treatment of the fee (`NONE` / `EXCLUSIVE` / `INCLUSIVE` + rate) is configuration pending the CA's opinion; the seeded policies are marked **not approved**.
- Every paid order gets planned splits: VENDOR = subtotal, PLATFORM = fee, TAX when exclusive. Payment-gateway charges are not deducted in the sandbox; how they are borne is a commercial decision to confirm with the provider and CA.

Rules kept: hosted checkout only; no card data ever touches our servers; no stored-value wallet; vendor money never goes through personal accounts.

## Cashfree Easy Split — evaluation notes

From Cashfree's public documentation (to be confirmed with Cashfree in writing):

- Easy Split is Cashfree's split-payment product for marketplaces: collect from the customer, deduct the platform commission, settle vendors automatically, and adjust vendor settlements for refunds (refund split ratios between merchant and vendor are configurable, including after settlement).
- Splits are defined at the order level; vendor settlement can be instant or on a custom schedule per vendor.
- Vendors are onboarded through the API/dashboard; webhooks exist for payments, refunds and settlements; reports cover transactions, settlements, refunds and vendor payouts.
- In production Easy Split must be **enabled by the Cashfree account manager**; in sandbox it can be enabled by API.

**Questions Cashfree must answer in writing before go-live:**

1. Is this exact model approved: student-paid convenience fee + vendor food price, independent food vendors at a campus food court, pickup only?
2. Are **walk-in QR-originated online payments** (student physically at the counter, paying online through our hosted checkout) covered by the same approval, or treated as proximity/offline payments with different rules?
3. Vendor onboarding/KYC requirements for small food vendors (FSSAI, PAN, bank account, GST optional?).
4. Settlement timing, who bears gateway charges on the fee and on the food amount, and refund split behaviour after settlement.
5. Webhook signature scheme, retry policy and the order-status API we use for reconciliation.

## Adapter plan

`apps/api/src/payments/provider.ts` is the provider-neutral interface (create checkout, verify webhook, payment status, refund, vendor account, split, settlement report). A Cashfree adapter will implement it against Cashfree's documentation at that time, in a new file, with its own webhook signature verification and tests against the Cashfree sandbox. No order logic changes are needed. Not built yet, on purpose.
