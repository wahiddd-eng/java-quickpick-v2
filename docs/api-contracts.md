# API contracts

Base `/api/v1`. JSON. Auth `Authorization: Bearer <jwt>`. Money in integer **paise**. Errors: `{ "error": { "code": "SLOT_FULL", "message": "…", "details"?: {…} } }` with 400 validation, 401, 403, 404 (incl. other tenants), 409 conflicts, 410 expired, 422, 423 locked, 429, 503.

## Public (no sign-in)

| Method & path | Notes |
|---|---|
| GET `/config` | sandbox flag, provider, push provider |
| GET `/shops`, `/shops/:id`, `/shops/:id/menu` | ACTIVE shops; each shop carries `preorder` and `walkin` availability `{orderable, reason, message}` |
| GET `/shops/:id/pickup-slots` | today's future slots with `remaining`, `full` |
| GET `/shops/:id/walkin-estimate` | `{minutes, queueLength}` |
| GET `/qr/:token` | **Walk-in entry.** `{shop, walkin, estimate}`; unknown/draft → 404 `QR_NOT_FOUND`; suspended/closed/paused → 200 with `walkin.orderable=false` and a reason |
| GET `/pricing-policy/current?source=PREORDER\|WALKIN_QR` | active fee policy for that mode |

## Auth

| | |
|---|---|
| POST `/auth/otp/request` `{email}` → `{ok, devCode?}` | `devCode` only in sandbox |
| POST `/auth/otp/verify` `{email, code, name?}` → `{token, user}` | students |
| POST `/auth/login` `{email, password}` → `{token, user}` | staff |
| GET `/me` | |

## Student

| Method & path | Notes |
|---|---|
| POST `/orders/quote` `{source, shopId, slotId?, items:[{menuItemId, quantity, modifierIds[], notes}]}` | server prices only; PREORDER requires `slotId`, WALKIN_QR forbids it and returns `estimate` |
| POST `/orders` + header `Idempotency-Key` | same body; reserves the slot (PREORDER) atomically → `PENDING_PAYMENT` |
| POST `/payments/checkout` `{orderId, returnUrl}` | → `{checkoutUrl, attemptNo}`; opens a hosted checkout session; `returnUrl` must be a QuickPick origin |
| GET `/orders/:id` | own only; includes `pickupOtp` + `otpExpiresAt` **only when READY**; events and refunds |
| GET `/me/orders` | history (never includes the OTP) |
| POST `/orders/:id/cancel` | before acceptance; refunded if paid |
| POST `/orders/:id/support` `{category, description}` | complaint |
| GET `/me/notifications`, POST `/me/notifications/read` `{ids?}` | in-app inbox (push fallback) |
| POST `/me/push-tokens` `{token, platform}`, POST `/me/push-tokens/remove` | FCM tokens |
| POST `/sandbox/payments/simulate` `{orderId, outcome}` | sandbox/tests only; makes the mock provider send a signed webhook |

## Vendor (own shop only; optional `x-shop-id` must be one of the user's shops)

| Method & path | Notes |
|---|---|
| GET `/vendor/shop` | shop, menu with modifiers, printers |
| GET `/vendor/orders?view=active\|completed\|rejected` | queue sorted by slot start / estimate; first name only; `printStatus`, `otpState` (never the code) |
| POST `/vendor/orders/:id/accept` `{prepMinutes}` | creates OTP + print job |
| POST `/vendor/orders/:id/reject` `{reason}` | auto refund |
| PATCH `/vendor/orders/:id/status` `{status: PREPARING\|READY\|NOT_COLLECTED\|CANCELLED, reason?}` | COLLECTED is not allowed here |
| POST `/vendor/orders/:id/verify-otp` `{otp}` | → COLLECTED; 422 `INVALID_OTP` (+`attemptsLeft`), 410 `OTP_EXPIRED`, 423 `OTP_LOCKED`, 409 `OTP_ALREADY_USED` / `ORDER_NOT_READY` |
| POST `/vendor/orders/:id/collect-override` `{reason ≥10 chars}` | audited manual handover |
| POST `/vendor/orders/:id/reprint` | new job, `copyNumber+1` |
| POST `/vendor/devices/register` `{installId, platform, model?, appVersion?}` | tablet self-registration (409 if assigned to another shop) |
| POST `/vendor/heartbeat` `{installId}` | last seen + open print-job count |
| POST `/vendor/print-jobs/claim` `{installId}` | leases due jobs → `[{id, orderId, copyNumber, attempt, ticket}]` |
| POST `/vendor/print-jobs/:id/result` `{installId, ok, error?, printerId?, printerStatus?}` | idempotent for PRINTED; 409 `STALE_CLAIM` if another tablet holds it |
| GET `/vendor/print-jobs?status=open\|failed\|all`, POST `/vendor/print-jobs/:id/retry` | |
| GET/POST `/vendor/printers`, PATCH `/vendor/printers/:id`, POST `/vendor/printers/:id/status` | one active printer per shop; status ONLINE/OFFLINE/PAPER_OUT/ERROR |
| PATCH `/vendor/menu-items/:id`, POST `/vendor/menu-items`, PATCH `/vendor/modifiers/:id` | own menu and availability |
| PATCH `/vendor/shop/status` `{acceptingOrders?, walkinEnabled?, preorderEnabled?}` | |
| GET `/vendor/summary`, `/vendor/settlements` | own numbers only |

## Admin (ADMIN or SUPER_ADMIN)

| Method & path | Notes |
|---|---|
| GET/POST `/admin/shops`, PATCH `/admin/shops/:id` | incl. code, tags, prep model, mode switches; hours validated, unbooked slots rebuilt |
| GET `/admin/shops/:id/qr`, POST `/admin/shops/:id/qr/regenerate` | QR URL + SVG; regenerating invalidates printed codes |
| GET/POST/PATCH `/admin/vendors` | payee businesses |
| GET/POST `/admin/vendor-users` | staff logins |
| GET `/admin/shops/:id/menu`, POST `…/categories`, POST `…/menu-items`, PATCH `/admin/menu-items/:id`, POST `/admin/menu-items/:id/modifiers`, PATCH `/admin/modifiers/:id` | |
| GET/POST `/admin/devices`, POST `/admin/devices/assign` | tablets |
| GET `/admin/printers` | printer health with printed/waiting/failed counts |
| GET `/admin/orders?status&shopId&source&date`, GET `/admin/orders/:id` | detail incl. payment attempts, splits, refunds, print jobs, OTP log, notification delivery |
| POST `/admin/orders/:id/collect-override`, GET `/admin/pickup-overrides` | |
| GET `/admin/payments`, GET/POST `/admin/refunds`, POST `/admin/refunds/:id/retry` | |
| GET `/admin/reconciliation`, POST `/admin/reconciliation/run` | ledger check + provider reconciliation records |
| POST `/admin/settlements/generate` `{date}`, GET `/admin/settlements` | statements only |
| GET `/admin/pricing-policies`; PATCH `/admin/pricing-policy` `{orderSource, feeRateBps, …}` | **SUPER_ADMIN only**; new version per source |
| GET `/admin/analytics?date&days` | totals, by source, by shop, peak hours, payments, commission, refunds |
| GET `/admin/export/orders.csv?date` | |
| GET/PATCH `/admin/complaints`, GET `/admin/audit-logs` | |

## Webhook and sandbox checkout

- `POST /api/v1/webhooks/payments/mock` — raw body, header `x-mock-signature: hex(HMAC-SHA256(body, MOCK_WEBHOOK_SECRET))`. Body `{id, type: payment.succeeded|payment.failed|refund.processed|refund.failed, data:{providerRef, amountPaise, currency?, orderId?, reason?}}`. 200 processed / 200 `{duplicate:true}` / 401.
- `GET /sandbox/checkout/:session` and `POST` (form) — the hosted sandbox payment page (pay, decline, pay-and-close, pay-with-lost-webhook, leave pending).

## Socket.IO (signals only)

`auth: {token}`. Rooms `shop:<id>`, `user:<id>`, `admin`. Events: `order {orderId, status, kind}`, `print {}` (shop), `notification {}` (student). Always refetch over REST.
