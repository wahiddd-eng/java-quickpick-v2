# UI route structure

## Student PWA (`apps/student-web`, :5273)

Path-based routes (the dev server and any production host must serve `index.html` for unknown paths).

| Route | Screen |
|---|---|
| `/` | Home: brand, **Pre-order** and **Walk-in** cards, active orders, participating outlets, recent orders |
| `/preorder` | Shop list for pre-ordering (logo/monogram, tags, hours, availability, prep estimate) |
| `/shop/:shopId` | Pre-order menu for one shop |
| `/s/:qrToken` | **Walk-in entry from a shop QR.** Resolves the shop and opens its menu in walk-in mode; shows a clear message for invalid/suspended/closed |
| `/scan` | In-app QR scanner (camera via `BarcodeDetector` where supported) + "enter shop code" fallback |
| `/cart` | Cart and checkout: lines with options and notes, price breakdown; pre-order picks a slot, walk-in shows the estimate |
| `/orders/:orderId` | Live tracker: number, shop, items, payment status, accepted/preparing/ready, **collection OTP when READY**, refund status |
| `/orders` | Order history |
| `/inbox` | In-app notifications (push fallback) |

Sign-in (email code) is a sheet shown only when needed (at checkout or when opening orders). Browsing a menu from a QR needs no sign-in or install.

## Vendor tablet app (`apps/vendor-app`, :5274; Android via Capacitor)

Single screen with tabs, landscape-first, large touch targets.

| Tab | Content |
|---|---|
| **Orders** | Columns New / Accepted / Preparing / Ready. Each card: order number, PRE-ORDER or WALK-IN badge, items with options and notes, slot time or estimate, verified-payment badge, slip status. Actions: Accept (prep minutes), Reject (reason), Preparing, Ready, Hand over (6-digit OTP keypad; manual handover with reason), Reprint |
| **Done** | Completed and rejected/cancelled today |
| **Menu** | Item and option availability switches |
| **Printer** | Connection (Bluetooth / network / simulated), test print, status, failed slips with Retry |
| **Today** | Collected count and food value by mode, settlement statement |

Header: shop name, Live/Offline, printer status, sound toggle, Taking-orders switch.

## Admin dashboard (`apps/admin-web`, :5275)

Sidebar sections: Overview (KPIs, by mode, peak hours, by shop) · Orders (filter by mode; detail timeline) · Shops (edit, QR code) · Vendors · Menus (items, options) · Devices (tablets) · Printers (health) · Payments · Refunds · Reconciliation · Settlements · Pricing (per mode) · Support · Audit.
