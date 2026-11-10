# Progress — Milestones 0–4

_Last updated: 2026-11-10_

## Repository safety

| | |
|---|---|
| V1 | `java-quickpick` — not modified. HEAD `ac385dd`, branch `main` only, `git status` clean, SHA-256 of all 79 tracked files identical before and after this work. Nothing pushed. |
| V2 | `java-quickpick-v2` — separate sibling directory, fresh `git init`, no remote, no V1 history. Created from V1's committed files with `git archive` (no `.env`, secrets, `node_modules`, builds or local DB). Own package names (`@qp2/*`), ports (4100, 5273–5275), database (`.data/pglite-v2` / `java_quickpick_v2`) and env template. |

## Verified results (from actual runs)

| Check | Result |
|---|---|
| `npm run lint` | clean |
| `npm run build` (typecheck all workspaces + 3 production builds) | passes |
| `npm test` — shared | **17 passed** (fees, state machine, ESC/POS bytes, slip content/privacy, duplicate labels, 58/80 mm) |
| `npm test` — API (in-memory Postgres, fixed clock) | **57 passed** across 7 files: walk-in E2E, pre-order E2E, failures, printing, OTP, notifications (+ FCM adapter vs fake endpoint), security/admin |
| `node e2e/run.mjs` (Playwright, real screens) | **passed**: walk-in (QR → options/note → sign-in at checkout → hosted sandbox payment → tablet accept → slip on simulated printer → ready → student OTP → wrong code refused → handover), pre-order (slot → pay → accept → slip → ready → OTP → collected), invalid QR, printer failure (offline → automatic retries → failed banner → fix → retry prints "RETRY — CHECK FOR DUPLICATE"), every admin section incl. QR poster and order detail. No console errors. |
| Android native printer plugin | type-checked with `javac` against stubs mirroring the Capacitor 6 API; **not built with the Android SDK, not run on a device or printer** |

## Features implemented

- **Two ordering modes** end to end: `PREORDER` (slot, capacity, atomic reservation) and `WALKIN_QR` (shop QR token → that shop's menu, live queue-based estimate, same kitchen queue).
- **Student PWA**: home with both modes, active orders, outlets, history; `/s/<token>` QR entry with clear invalid/suspended/closed/paused states; in-app scanner (BarcodeDetector) + typed code; menu with veg/egg/non-veg marks, images, add-ons and required/single-choice options; cart with quantity and cooking notes; per-mode checkout; hosted payment; live tracker; 6-digit collection code at READY; refund status; in-app inbox and banner; FCM web-push registration (when configured).
- **Vendor tablet (React + Capacitor)**: board New/Accepted/Preparing/Ready sorted by slot or estimate; PRE-ORDER/WALK-IN badges; items with options and notes; verified-paid badge; slip status per order; accept with prep minutes, reject with reason, preparing, ready (or ready straight away), 6-digit handover keypad, audited manual handover; reprint; Done tab; menu and option availability; printer setup (Bluetooth, network, simulated), test print, connection/paper status, failed-slip retry; sound alerts; live/offline indicator; tablet self-registration and heartbeat.
- **Kitchen printing**: durable print jobs created with acceptance; lease-based claiming; back-off retries; FAILED after the limit; manual retry; reprints as labelled copies; recovery after tablet restart; printer status reporting; ESC/POS slip renderer (no OTP, contact details or prices).
- **Pickup OTP**: CSPRNG 6 digits; HMAC hash + AES-GCM ciphertext bound to the order; shown only at READY to the owner; collection window; 5-attempt lock; single use; every attempt and override logged.
- **Payments (sandbox)**: hosted checkout page; payment attempts with retry after failure; signed webhooks with dedupe and amount/currency/order checks; reconciliation job for lost webhooks/closed browsers; late-success refunds; refunds with failure handling and admin retry; planned vendor/platform/tax splits; settlement statements; fee policy versioned **per mode** (default 7%).
- **Notifications**: outbox with per-row status, retries, dead-token disabling, concurrent-dispatch safety; sandbox log provider; FCM HTTP v1 adapter; in-app fallback; OTP never sent in notifications.
- **Admin**: analytics (shops, orders, food value, fees, payments, refunds; by mode, by shop, peak hours), orders with full per-order trail, shops with QR poster/download/regenerate, vendors and shop logins, menus with options, tablets, printer health, payments, refunds, reconciliation, settlements, pricing per mode, support, audit incl. code-less handovers.

## Files

- **Created in V2**: `apps/api/src/{logger.ts, notify/push.ts, notify/fcm.ts, routes/public.ts, services/{menu,shops,otp,printing,notifications}.ts}`, `apps/api/test/{walkin.e2e,preorder.e2e,failures,printing,otp,notifications,security}.test.ts`, `packages/shared/src/{escpos.ts, ticket.ts, ticket.test.ts}`, `apps/student-web/src/{lib.ts, ui.tsx, SignIn.tsx, Menu.tsx, Checkout.tsx, OrderPage.tsx, Scan.tsx, push.ts}`, `apps/vendor-app/{src/printer.ts, capacitor.config.ts, README.md, android/** incl. QuickPickPrinterPlugin.java}`, `e2e/run.mjs`, `Run QuickPick V2.command`, docs (architecture, data model, API, UI routes, printing, payments, roadmap, test strategy, runbook, this file, V2 brief).
- **Rewritten from the V1 copy** (V1 itself untouched): `apps/api/migrations/001_init.sql`, `apps/api/src/{config,context,app,server,realtime,seed}.ts`, `routes/{student,vendor,admin}.ts`, `services/{orders,payments,ledger,pricing}.ts`, `payments/{provider,mock}.ts`, `packages/shared/src/index.ts`, all three app `App.tsx` files and styles, `README.md`, `.env.example`.
- **Removed from the V2 copy**: V1 docs and launcher, `vendor-web` (renamed `vendor-app`).

## Remaining defects and gaps (honest list)

1. **Android build and printer plugin untested on hardware** (no Android SDK in the build environment). Printer model not yet chosen — buy one sample and run the checklist in `docs/printing.md`.
2. **Push notifications not verified on real devices.** Server FCM adapter is tested only against a fake endpoint; the PWA's Firebase registration needs a Firebase project (`VITE_FIREBASE_*`). On iPhones, web push works only for a PWA added to the Home Screen (iOS 16.4+). In-app inbox/tracker work regardless.
3. **SMS fallback** is designed (consent flag) but no SMS provider is connected.
4. **Payments are mock only.** No Cashfree adapter; Easy Split questions for Cashfree are listed in `docs/payments.md` (especially whether walk-in QR-originated online payments are covered).
5. **Student sign-in codes** are shown on screen (no email/SMS delivery yet).
6. **Walk-in presence** relies on the QR token being on the counter; a photo of the QR could be used remotely. Mitigation now: regenerate the QR. Possible later: short-lived rotating QR or location check.
7. **In-app scanner** needs `BarcodeDetector` (Chrome on Android); other browsers fall back to the phone camera app or the typed code.
8. **Manual handover** is available to any shop login (audited, reviewed in admin). Consider restricting to the shop owner/manager.
9. **Dependency advisories** (`npm audit`): remaining items are dev tooling (vitest, esbuild, eslint, Capacitor CLI, vite dev server) plus `zod` 3 (memory exhaustion on oversized collections — mitigated by array caps and the 100 kB body limit; upgrade to zod 4 planned). The Vite dev servers listen on the LAN (`host: true`): use them only on trusted networks.
10. Settlement is statements only; no payouts or provider settlement import. Admin is desktop-first.

## Next milestone (5)

Android build on a real 10" tablet with a sample 80 mm ESC/POS printer (Bluetooth and LAN), fix whatever the device test finds in the plugin, choose the printer model; create the Firebase project and verify push on Android Chrome and an installed iOS PWA.
