# Test strategy

| Layer | Tool | What it proves |
|---|---|---|
| Unit (shared) | vitest | fee maths and rounding, state machine, ESC/POS bytes, slip content (no OTP/phone/price), duplicate labels, 58/80 mm fit |
| API integration | vitest + supertest on an in-memory PostgreSQL (PGlite) with a fixed, controllable clock | every business rule through real HTTP, real SQL and real transactions |
| Browser end to end | Playwright against the dev servers | the screens drive the same flow a person would (walk-in and pre-order), with no console errors |
| Device/hardware | manual checklist | Android build, Bluetooth/LAN printing, FCM on phones — **not automated here** |

## Scenario coverage (brief §14)

| Scenario | Test |
|---|---|
| Walk-in QR end to end (Shop 01) | `walkin.e2e.test.ts` + Playwright walk-in run |
| Pre-order end to end (Shop 02) | `preorder.e2e.test.ts` + Playwright pre-order run |
| Invalid QR · suspended vendor · closed shop · paused / QR disabled | `failures.test.ts › QR and shop availability` |
| Unavailable item · unavailable/invalid/required option · multi-shop cart | `failures.test.ts` |
| Full pickup capacity · simultaneous orders | `preorder.e2e.test.ts › pickup capacity` |
| Failed payment (+ retry) · pending payment (+ expiry) · duplicate webhook · amount/currency/order mismatch · bad signature | `failures.test.ts › payments` |
| Payment success without browser return · lost webhook recovered by reconciliation · late success refunded | `failures.test.ts › payments` |
| Vendor rejection · refund failure + admin retry · partial refunds · unanswered order | `failures.test.ts › vendor rejection and refunds` |
| Printer disconnection · retries/back-off · paper out · duplicate print · reprint labels · tablet restart · shop isolation | `printing.test.ts` |
| Push failure + retries · dead tokens · no device · concurrent dispatchers · FCM adapter | `notifications.test.ts` |
| Invalid OTP · expired OTP · OTP replay · lockout + audited override · not before READY · other shop | `otp.test.ts` |
| Student device disconnection | `otp.test.ts` (REST refetch shows the same state) and the Playwright run reloads the page |
| Fee per mode · snapshots · isolation · RBAC · state machine · open redirect · QR regeneration · settlements · CSV | `security.test.ts` |

## Honesty rules

- Tests never call real payment providers, Firebase or printers. The FCM adapter is tested against a fake HTTP endpoint and says so.
- Hardware and device behaviour (Bluetooth pairing, paper sensors, push on locked phones) is listed as **unverified** until tested on real devices.
- `npm test` must pass before every commit; results in [PROGRESS.md](PROGRESS.md) are copied from actual runs.
