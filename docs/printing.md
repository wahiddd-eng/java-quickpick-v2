# Kitchen printer integration

## Approach

Browser printing (`window.print()`) shows a dialog and cannot reliably print silently to a thermal printer, so the vendor app is an **Android app built with Capacitor** and talks to the printer through a small **native plugin** (`QuickPickPrinter`, in `apps/vendor-app/android/app/src/main/java/in/javaquickpick/vendor/QuickPickPrinterPlugin.java`). The plugin only moves bytes; the slip itself is built in TypeScript:

1. Vendor taps **Accept** → the API commits acceptance **and** a `print_jobs` row in one transaction.
2. The tablet (signalled by Socket.IO, plus a 10 s poll) claims due jobs with a lease.
3. `renderKitchenTicket()` (`packages/shared/src/ticket.ts`) turns the stored ticket payload into ESC/POS bytes (ESC @, ESC a, ESC E, GS !, GS V). These bytes are unit-tested.
4. The native plugin writes the bytes to the printer:
   - **Bluetooth Classic SPP** (UUID `00001101-0000-1000-8000-00805F9B34FB`) to a paired printer's MAC address, or
   - **TCP** to `host:9100` for LAN/Wi-Fi printers.
5. The tablet reports `PRINTED` or the error (and printer status, e.g. `PAPER_OUT` where the printer reports it) to the API.

In a desktop browser the app uses the **simulated printer**: it shows the exact slip on screen and reports it printed, so the full flow can be tested without hardware.

## Slip contents

Java QuickPick, shop name, **PREPARE** heading, order number (large), PRE-ORDER or WALK-IN, order time, pickup time or ready-by estimate, prep minutes, items × quantity, options, cooking notes, short order ID. **Never**: OTP, student phone/email, prices, payment details. Reprints print **REPRINT — COPY n — DO NOT COOK AGAIN**; a retry after an uncertain attempt prints **RETRY n — CHECK FOR DUPLICATE**.

## Reliability

| Requirement | How |
|---|---|
| Persistent job storage | `print_jobs` table; created with acceptance |
| Connection monitoring | tablet reports printer status on every attempt and from **Test print**; admin → Printers shows status, last error, staleness, printed/waiting/failed |
| Automatic retry with limits | back-off 10 s, 20 s, 40 s…; `PRINT_MAX_ATTEMPTS` (3) then FAILED |
| Manual reprint / retry | Reprint button on the card; Retry on failed slips (audited) |
| Duplicate-print labels | copy number and attempt number printed on the slip |
| Error notifications | red slip badge on the order card, banner on the board, printer chip in the header |
| Recovery after restart | jobs live on the server; leases expire after 45 s and are reclaimed |
| Paid order never lost | acceptance and the order are independent of printing; the board shows the order regardless |

## Printer selection — verify before buying

Do not commit to a model until one unit has passed the checks below on the actual tablet. Candidates seen on the Indian market (not yet verified by us):

| Candidate | Interfaces (per listings) | Notes to verify |
|---|---|---|
| Epson TM-T82X / TM-m30 series | USB + LAN; Bluetooth on some SKUs | Epson publishes an Android ePOS SDK; ESC/POS compatible; widely serviced in India |
| TVS Electronics RP 3230 | USB, Bluetooth, Wi-Fi (listed ~₹9,600) | ESC/POS emulation and auto-cutter not stated in the listing — confirm with TVS |
| Generic 80 mm Bluetooth printers (e.g. Everycom, Shreyans, Milestone) | Bluetooth/USB | cheapest; quality and paper sensors vary — test reliability over a lunch rush |

**Acceptance checklist for a sample unit:** prints the bytes from `renderKitchenTicket()` correctly (alignment, bold, double size, cut) · pairs with the tablet over Bluetooth SPP or is reachable on TCP 9100 · reconnects after power cycle · behaviour when paper runs out (does it report status?) · 300+ slips in a lunch hour without jams · auto-cutter · local service/warranty and paper roll availability · manufacturer SDK not required (we use raw ESC/POS) but available as a fallback.

## Native plugin status

The plugin (Java, Bluetooth SPP + TCP, registered in `MainActivity`, permissions in `AndroidManifest.xml`) has been **type-checked with `javac` against stubs that mirror the Capacitor 6 API signatures**, but it has **not been built with the Android SDK or run on a device or printer** — the build environment has no Android SDK. Build steps are in `apps/vendor-app/README.md`. Until it is tested on the chosen printer, use the simulated printer.
