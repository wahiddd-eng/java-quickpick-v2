# Java QuickPick V2 — architecture and system requirements

V2 is a separate product from V1 (own repository, git history, database, ports and env). It keeps two student-driven ordering modes and nothing else:

| Mode | Where the student is | How they start | Pickup timing |
|---|---|---|---|
| **PRE-ORDER** (`PREORDER`) | Anywhere | Home → Pre-order → choose shop | A reserved pickup slot (shop capacity per slot) |
| **WALK-IN** (`WALKIN_QR`) | At Java Green | Scans the shop's own QR → that shop's menu opens | Live estimate from the shop's queue |

There is **no cashier POS** in V2: no cashier-entered sales, cash handling or replacing shop billing. The vendor tablet only manages app orders.

## Shape

```
Student PWA (React/Vite)  ─┐                     ┌─ Firebase Cloud Messaging (push)
Vendor app (React+Capacitor, Android) ─┼─ REST + Socket.IO ─ API (Node/Express) ─┼─ Payment provider (sandbox mock now; Cashfree Easy Split after approval)
Admin dashboard (React/Vite) ─┘          signals only       │                    └─ Sentry (optional)
                                                            PostgreSQL (PGlite embedded for dev/tests)
Vendor app ── native plugin ── 80 mm ESC/POS printer (Bluetooth SPP or LAN :9100)
```

**Modular monolith.** One API process, modules by domain (`services/orders`, `payments`, `ledger`, `printing`, `otp`, `notifications`, `menu`, `shops`, `slots`). No microservices or Kubernetes.

**Source of truth is PostgreSQL.** Socket.IO only signals "something changed" (`order`, `print`, `notification` events with IDs). Every client refetches over REST on a signal, on reconnect and on a polling fallback, so a dropped socket never loses an order, a slip or a READY notice.

**Side effects in the same transaction as the state change**, then signals after commit:

| State change | Same transaction |
|---|---|
| Payment verified (webhook) | order → `AWAITING_VENDOR`, accept deadline, walk-in estimate refreshed, planned splits, notification outbox rows |
| Vendor accepts | pickup OTP issued (hash + ciphertext), kitchen **print job** created, notification |
| READY | OTP collection window starts, READY notification |
| Rejected / cancelled / expired | slot released, open print jobs cancelled, OTP revoked, refund started, notification |

## Reliability rules

- **Payments.** Hosted checkout; sessions created server-side; signed webhook over the raw body; event-id dedupe; amount, currency and order-id checks; browser returns are never proof of payment. A reconciliation job asks the provider about open payments and applies anything missed through the same idempotent path (covers lost webhooks and closed browsers).
- **Printing.** Print jobs are rows, not messages. The tablet claims jobs with a 45 s lease, prints, and reports. Failures retry with back-off (3 attempts by default), then wait for a manual retry. Leases that expire (tablet died mid-print) are reclaimed and printed with a "RETRY — CHECK FOR DUPLICATE" label. Reprints are new jobs printed as "REPRINT — COPY n — DO NOT COOK AGAIN". A printer failure never blocks or loses the paid order.
- **Notifications.** Outbox rows, dispatcher with per-row atomic claim, retries with back-off, per-row delivery status, dead FCM tokens disabled. An in-app inbox row is always written as the fallback.
- **Pickup OTP.** 6 random digits per order; HMAC hash for verification plus AES-GCM ciphertext so only the owning student can be shown it; revealed only at READY; expires after the collection window; 5 attempts then locked; single use; every verification and manual override logged.

## Security

- Role-based auth (STUDENT, VENDOR, ADMIN, SUPER_ADMIN) checked on the server for every route.
- Shop isolation: vendor routes resolve the shop from the user's own memberships, never from input; another shop's order looks identical to a missing one (404). Print jobs, printers and tablets are shop-scoped; a tablet registered to one shop cannot be used by another.
- Students see only their own orders (404 otherwise). Vendors see a first name only — never email, phone or the OTP.
- All input validated with zod. Secrets only in env. CSV export neutralises formulas. Checkout return URLs must be QuickPick origins (no open redirect).
- Real payments are impossible in this build: the API refuses any `PAYMENT_PROVIDER` other than `mock`.

## System requirements

| | Development | Pilot |
|---|---|---|
| Runtime | Node 20+ | Node 20 LTS on a small VM or PaaS |
| Database | none (embedded PGlite in `.data/pglite-v2`) | Managed PostgreSQL 15+ with daily backups (database `java_quickpick_v2`) |
| Student devices | any modern mobile browser | same — no install needed for the QR link |
| Vendor tablets | Chrome on desktop for the browser build | Android 8+ tablet (10" recommended), Bluetooth and Wi-Fi |
| Printer | simulated (on-screen slip) | 80 mm ESC/POS thermal printer, Bluetooth SPP or Ethernet/Wi-Fi — see [printing.md](printing.md) |
| Push | sandbox log provider | Firebase project + service account (FCM HTTP v1) |
| Monitoring | JSON logs to stdout | log store + Sentry (`SENTRY_DSN`) |

## What V2 reuses from V1 (copied, V1 untouched)

Integer-paise money maths and half-up fee rounding, the order state machine, the provider-neutral payment interface and HMAC-signed mock provider, webhook dedupe, refunds/ledger and planned splits, atomic slot reservation, RBAC and tenant isolation, PGlite/Postgres dual DB layer, the student/vendor/admin visual design system. New in V2: order sources, QR resolution, walk-in estimate, modifiers, per-source fees, hosted sandbox checkout with payment attempts, reconciliation, print jobs and ESC/POS, pickup OTP, notification outbox and FCM, vendors (payees), settlement statements.
