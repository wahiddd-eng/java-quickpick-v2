# Operations runbook (pilot)

## Setting up a shop

1. Admin → **Vendors**: add the business that will be paid (payout set-up stays "Not started" until the payment provider onboards it).
2. Admin → **Shops & QR codes** → *Onboard a shop*: code (e.g. JG03), name, food categories, hours, pickup capacity per slot, average minutes per order and how many orders the kitchen makes at once (these drive the walk-in estimate), link the vendor. The shop starts as a draft.
3. Admin → **Menus**: categories, items with veg/egg/non-veg marks, options (add-ons and choices).
4. Admin → **Vendors** → *Shop logins*: create the tablet login.
5. Admin → Shops → **QR code** → **Print poster**. Laminate it and fix it at the counter at eye level. The code printed under the QR can be typed in if a phone can't scan.
6. **Activate** the shop.

## Tablet and printer

- Install the QuickPick Shop Android app (see `apps/vendor-app/README.md`), sign in with the shop login. The tablet registers itself; give it its asset tag in admin → Tablets.
- Pair the printer in Android Bluetooth settings (or put it on the shop Wi-Fi with a fixed IP), then in the app **Printer** tab choose it and tap **Test print**.
- Keep the tablet on charge, screen timeout off, sound on. Paper rolls: 80 mm thermal; keep two spares.

## Daily checks (QuickPick staff)

- Admin → **Printers**: every shop ONLINE, nothing failed or stale.
- Admin → **Tablets**: every tablet online during opening hours.
- Admin → **Reconciliation**: no OPEN records (an open REFUND record means a student is waiting for money — retry it from Payments & refunds).
- Admin → **Audit log** → *Handovers without a collection code*: review overrides.

## When things go wrong

| Problem | What the shop sees | What to do |
|---|---|---|
| Printer off / paper out | Red "slips didn’t print" banner; order stays on the board | Fix the printer, Printer tab → **Retry**. Slips that were retried print "RETRY — CHECK FOR DUPLICATE" |
| Slip lost or messy | — | On the order card tap **Reprint slip** (prints "REPRINT — DO NOT COOK AGAIN") |
| Tablet restarted mid-print | Slip prints again after ~45 s marked as a retry | Check it isn’t cooked twice |
| Internet down | "No internet" banner | Switch to a phone hotspot; nothing is lost — orders and slips are on the server |
| Student’s phone dead / code locked or expired | Handover sheet offers **manual handover** | Check college ID and the order number, record the reason |
| Can’t make an accepted order | **Can’t make this order** on the card | Student is refunded in full automatically |
| Shop too busy | **Taking orders** switch in the header | New orders stop; existing ones still need finishing |

## Data and privacy

Shops see a student's first name only — never email, phone or the collection code. Kitchen slips contain no OTP, contact details or prices.
