# Java QuickPick V2 — sandbox

Multi-vendor food ordering and scheduled pickup for the **Java Green food court, SRM KTR**. Every order starts from a student, in one of two modes:

- **PRE-ORDER** — order before arriving: choose a shop, pick a pickup slot, pay.
- **WALK-IN** — at the counter: scan the shop's own QR, order and pay from the phone (no install).

The shop's tablet receives the paid order, the vendor accepts, a **kitchen slip prints**, the vendor marks it **READY**, the student gets a **push notification** and shows a **6-digit collection code**, the vendor verifies it and the order is **COLLECTED**. There is no cashier POS in V2.

> ⚠️ **SANDBOX MODE.** Real payments are disabled; only the built-in mock provider (with a hosted sandbox payment page) exists. The API refuses any other `PAYMENT_PROVIDER`. Do not take real money until the payment provider, a CA and the relevant authorities/SRM have approved the transaction structure in writing.

V2 is a separate project from V1 (`java-quickpick`): own repository, git history, database (`.data/pglite-v2` / `java_quickpick_v2`), env file and ports. V1 was not modified.

## What's in the box

| Path | What it is | Dev URL |
|---|---|---|
| `apps/api` | Express + PostgreSQL modular monolith: orders (both modes), QR resolve, walk-in estimate, slots, hosted sandbox checkout, signed webhooks, reconciliation, refunds/splits/settlements, print jobs, pickup OTP, notification outbox + FCM adapter, RBAC | http://localhost:4100 |
| `apps/student-web` | Student PWA: home with Pre-order and Walk-in, QR entry `/s/<token>`, scanner, menu with options/diet marks, cart with notes, checkout, live tracker with OTP, inbox | http://localhost:5273 |
| `apps/vendor-app` | Shop tablet (React + Capacitor Android): order board by source, accept/reject, slips (native printer plugin or simulated), OTP handover, menu availability, printer setup | http://localhost:5274 |
| `apps/admin-web` | Admin: analytics by shop/mode/hour, orders, shops + **QR posters**, menus + options, vendors, tablets, **printer health**, payments/refunds, reconciliation, settlements, pricing per mode | http://localhost:5275 |
| `packages/shared` | Money/fee maths, state machine, order sources, **ESC/POS kitchen-slip renderer**, API client | — |
| `e2e/run.mjs` | Playwright browser run of walk-in, pre-order, invalid QR and admin | — |

## Run it

Needs Node 20+. No database install needed.

```bash
npm install
cp .env.example .env        # optional; dev defaults exist
npm run dev                 # API :4100 + student :5273 + vendor :5274 + admin :5275
```

On macOS you can double-click **`Run QuickPick V2.command`** (installs on first run, opens VS Code and the three apps).

### Demo accounts (seeded, clearly marked demo data)

| Who | Sign in |
|---|---|
| Student | any email — the 6-digit sign-in code is shown on screen in sandbox |
| Shop tablet, Demo Shop 01 (JG01) | `vendor-01@quickpick.demo` / `demo1234` |
| Shop tablet, Demo Shop 02 (JG02) | `vendor-02@quickpick.demo` / `demo1234` |
| Admin | `admin@quickpick.demo` / `demo1234` |
| Super-admin (pricing) | `super@quickpick.demo` / `demo1234` |

Demo QR links: Shop 01 → http://localhost:5273/s/demo-jg01-qr7k · Shop 02 → http://localhost:5273/s/demo-jg02-qr4m (print real posters from admin → Shops & QR codes).

### Try the walk-in flow

1. Open the Shop 01 QR link on a phone-sized window → add a Masala Dosa with options and a note → **Review** → **Sign in to pay** → **Pay** → on the sandbox page tap **Pay ₹…**.
2. Tablet (vendor-01): turn sound on → the order appears under **New** with a **WALK-IN** badge → **Accept** → the slip appears in the simulated printer tray.
3. **Start preparing** → **Mark ready** → the student sees *Ready — show your code* with the 6-digit code.
4. Tablet: **Hand over** → enter the code → order collected.

The sandbox payment page also lets you decline, pay-then-close (no return to the app) and pay-with-lost-webhook (recovered by reconciliation). The tablet's Printer tab can simulate a switched-off or out-of-paper printer.

## Checks

```bash
npm run typecheck
npm run lint
npm test                   # shared unit tests + API integration tests (in-memory Postgres, fixed clock)
npm run build              # typecheck + production builds of the three apps
node e2e/run.mjs           # browser run against `npm run dev` (needs Playwright)
```

## Docs

[Architecture & requirements](docs/architecture.md) · [Data model](docs/data-model.md) · [API](docs/api-contracts.md) · [UI routes](docs/ui-routes.md) · [Kitchen printing](docs/printing.md) · [Payments](docs/payments.md) · [Roadmap](docs/IMPLEMENTATION_PLAN.md) · [Test strategy](docs/test-strategy.md) · [Operations runbook](docs/operational-runbook.md) · [Progress & known gaps](docs/PROGRESS.md) · [V2 brief](docs/V2_BRIEF.md) · [Vendor app / Android](apps/vendor-app/README.md)
