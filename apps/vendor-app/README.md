# QuickPick Shop — vendor tablet app

React + Vite web app, wrapped as an Android app with Capacitor 6. The same code runs in a desktop browser for testing (with the **simulated printer**) and on an Android tablet (with a real Bluetooth or network ESC/POS printer through the native plugin).

## Browser (development)

```bash
npm run dev:vendor        # http://localhost:5274, API on :4100
```
Sign in with `vendor-01@quickpick.demo` / `demo1234`. The seeded shop has a simulated 80 mm printer: accepted orders print to an on-screen slip tray. The Printer tab can simulate "switched off" and "out of paper" to exercise retries.

## Android build (needs Android Studio, JDK 17 and an Android SDK — not available in the cloud build environment)

```bash
# 1. Build the web app with the API address the tablet will use (HTTPS in the pilot)
VITE_API_URL=https://api.example.in npm run build -w @qp2/vendor-app
# 2. Copy it into the Android project
cd apps/vendor-app && npx cap sync android
# 3. Open in Android Studio and run on the tablet
npx cap open android
```

- The API must allow the app's origin: add `https://localhost` to `CORS_ORIGINS` (already in the default list).
- For testing against an API on your laptop over Wi-Fi, use HTTPS (e.g. a tunnel) or add your laptop's IP to `android/app/src/main/res/xml/network_security_config.xml` for a debug build only.
- Pair the printer in Android Bluetooth settings first, then pick it in the app's **Printer** tab. Network printers use `IP:9100`.

## Native printer plugin

`android/app/src/main/java/in/javaquickpick/vendor/QuickPickPrinterPlugin.java`, registered in `MainActivity`. Methods (called from `src/printer.ts`):

| Method | Does |
|---|---|
| `print({connection, address, data, timeoutMs})` | writes base64 ESC/POS bytes over Bluetooth SPP or TCP |
| `status({connection, address})` | connects and sends `DLE EOT 4`; reports `PAPER_OUT` when the printer answers with paper-end bits, `ONLINE` otherwise, `OFFLINE` if it cannot connect |
| `listPaired()` | paired Bluetooth devices (for the printer picker) |

**Verification status:** the plugin has been type-checked with `javac` against stubs that mirror the Capacitor 6 plugin API signatures (taken from `@capacitor/android` sources). It has **not** been built with the Android SDK or run on a device or printer. Test it on the chosen tablet and printer before the pilot — see `docs/printing.md` for the acceptance checklist.
