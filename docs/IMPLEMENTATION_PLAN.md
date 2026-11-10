# Implementation roadmap

| # | Milestone | Status |
|---|---|---|
| 0 | Separate V2 repository, V1 untouched; docs | **Done** |
| 1 | **Walk-in vertical slice**: QR → menu → cart → sandbox payment → vendor tablet → accept → kitchen slip → READY → push → OTP → COLLECTED | **Done in sandbox** (API tests + browser run; slip on the simulated printer; push via the sandbox log provider + in-app) |
| 2 | **Pre-order**: shop list, slot choice and capacity, same tablet queue | **Done in sandbox** (API tests + browser run) |
| 3 | Failure handling: invalid QR, suspended/closed/paused shop, unavailable items/options, full slots, failed/pending/duplicate/lost payments, rejections, refund failure, printer failures and duplicates, push failure, OTP invalid/expired/replay/lockout, tablet restart, concurrency | **Done** (automated API tests; printer failure also in the browser run) |
| 4 | Admin: QR generation, printer health, analytics by mode and shop, peak hours, settlements, reconciliation | **Done (first version)** |
| 5 | **Android build of the vendor app** on a real tablet; test the native printer plugin with a sample 80 mm printer; finalise printer model | Next — needs Android Studio + hardware |
| 6 | **Firebase project**: web push for the student PWA (VAPID key, service worker), FCM service account on the API; device tests | Next — needs a Firebase project |
| 7 | Pilot setup: real shop data, measured prep times and slot capacity, QR posters printed, tablets enrolled, managed Postgres, HTTPS domain, Sentry | After 5–6 |
| 8 | Payment provider adapter (Cashfree Easy Split) against the provider sandbox; settlement import | Only after written provider/CA approval |
| 9 | Real OTP delivery for student sign-in (email/SMS), privacy notice and terms; SMS fallback for READY (with consent) | Before pilot |

## Order of work inside each milestone

Working functionality first (API + tests), then the screens, then a browser run of the whole flow, then docs. Each milestone ends with a report: files created/modified, features, tests run, verified results, remaining defects, next milestone (see [PROGRESS.md](PROGRESS.md)).
