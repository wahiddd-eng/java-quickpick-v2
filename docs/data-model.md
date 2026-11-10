# Data model (PostgreSQL)

Schema: [`apps/api/migrations/001_init.sql`](../apps/api/migrations/001_init.sql). Money is `BIGINT` paise. Timestamps are `timestamptz`; shop hours are IST `HH:MM`.

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | Students, vendor staff, admins | `email` unique; role check; `sms_consent` for the SMS fallback |
| `auth_otps` | Student sign-in codes (not the pickup OTP) | hashed; attempt counter |
| `vendors` | The business paid for food (payout beneficiary, provider vendor ref) | `provider_vendor_ref` unique |
| `shops` | Outlet: code, **QR token**, hours, slot capacity, prep model, mode switches | `code` unique, `qr_token` unique |
| `shop_members` | Which staff log in to which shop | PK (user, shop) |
| `menu_categories`, `menu_items` | Menu; items have diet (VEG/NON_VEG/EGG or unknown), image, availability | FK to shop |
| `menu_item_modifiers` | Add-ons and choices; rows with the same `group_name` form a group with `selection` ONE/MANY and `required` | FK to item |
| `pickup_slots` | Pre-order capacity per slot | unique (shop, start); `reserved_count ≤ capacity` enforced by conditional UPDATE |
| `pricing_policies` | Fee rate and tax mode, **versioned per `order_source`** | unique (source, version); `approved` false until CA sign-off |
| `orders` | One shop, one student, `order_source`, status and payment status (separate), price snapshot, slot or estimate, accept/ready/collected times, `collected_via` | `order_number` unique; unique (user, idempotency key); CHECK: PREORDER ⇔ slot present |
| `order_items` | Snapshot of name, base price, chosen modifiers (jsonb), unit price, quantity, cooking notes | FK to order |
| `order_events` | Append-only status history with actor and reason | |
| `payments` | One provider order per QuickPick order | `order_id` unique, `provider_ref` unique |
| `payment_attempts` | Each hosted-checkout session (retries after failure) | unique `session_ref`, unique (payment, attempt_no) |
| `payment_splits` | Planned vendor / platform / tax allocation | unique (order, beneficiary) |
| `refunds` | Full/partial refunds with failure reason | unique idempotency key and provider ref |
| `settlements` | Per-shop statements of vendor entitlement | unique (shop, period) |
| `reconciliation_records` | Differences vs provider (lost webhook fixed, refund failed…) | |
| `webhook_events` | Raw verified events | unique (provider, external event id) |
| `vendor_devices` | Loaned tablets: asset tag, install id, platform, last seen | `asset_tag` unique, `install_id` unique |
| `printer_devices` | Kitchen printer per shop: connection (BLUETOOTH/NETWORK/SIMULATED), address, paper width, live status | |
| `print_jobs` | Durable kitchen slips: copy number, status, attempts, lease, last error, ticket payload | unique (order, copy_number) |
| `pickup_otps` | Collection OTP: HMAC hash + AES-GCM ciphertext, status, attempts, expiry | `order_id` unique |
| `pickup_otp_attempts` | Every verification outcome and manual override | |
| `push_tokens` | FCM device tokens per student | `token` unique |
| `notifications` | Outbox + delivery log per channel (PUSH / IN_APP / SMS) | `dedupe_key` unique |
| `complaints` | Student support requests | |
| `audit_logs` | Admin/vendor actions (pricing, menu, QR regeneration, overrides, reprints, refunds) | |

## Status columns

- `orders.status`: `PENDING_PAYMENT → AWAITING_VENDOR → ACCEPTED → (PREPARING) → READY → COLLECTED`, plus `REJECTED`, `CANCELLED`, `EXPIRED`, `NOT_COLLECTED`. Transitions are enforced in one function (`transitionOrder`) and shared with the frontends (`ORDER_TRANSITIONS`).
- `orders.payment_status`: `NOT_STARTED, INITIATED, PENDING, SUCCEEDED, FAILED, REFUND_PENDING, PARTIALLY_REFUNDED, REFUNDED, REFUND_FAILED, DISPUTED`.
- A failed payment leaves the order in `PENDING_PAYMENT` so the student can retry until the checkout expires (10 min); the vendor never sees unpaid orders.

## Snapshots and history

Price, fee rate, tax mode, policy version and every chosen modifier are copied onto the order at checkout. Menu or fee changes never alter past orders. Order history (`order_events`), OTP verification (`pickup_otp_attempts`), print history (`print_jobs`), notification delivery (`notifications`) and admin actions (`audit_logs`) give a full trail per order (visible in admin → Orders → Details).
