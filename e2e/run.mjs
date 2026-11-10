/**
 * Browser end-to-end run (Playwright) against the dev servers started with `npm run dev`.
 *   node e2e/run.mjs [--shots <dir>]
 * Drives the WALK-IN flow (Shop 01) and the PRE-ORDER flow (Shop 02) through the real student and vendor screens,
 * including the hosted sandbox payment page and the simulated kitchen printer. Fails on any console error.
 */
import { createRequire } from 'node:module';

// Uses a globally installed Playwright (require resolves via NODE_PATH) or a local `npm i -D playwright`.
const { chromium } = createRequire(import.meta.url)('playwright');

const STUDENT = process.env.STUDENT_URL ?? 'http://localhost:5273';
const VENDOR = process.env.VENDOR_URL ?? 'http://localhost:5274';
const shotsIdx = process.argv.indexOf('--shots');
const SHOTS = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
const errors = [];
const step = (m) => console.log('•', m);

const browser = await chromium.launch();
const shot = async (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });

/** Responses we cause on purpose (a deliberately wrong pickup code returns 422). */
const EXPECTED = [/status of 422 \(Unprocessable Entity\)/];
function watch(page, label) {
  page.on('console', (m) => m.type() === 'error' && !EXPECTED.some((r) => r.test(m.text())) && errors.push(`[${label}] ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`[${label}] ${e.message}`));
}

async function signInStudent(page, email) {
  await page.getByLabel('Your name').fill(email.split('@')[0]);
  await page.getByLabel('College email').fill(email);
  await page.getByRole('button', { name: 'Send sign-in code' }).click();
  const code = (await page.locator('.alert.warn b.num').textContent()).trim();
  await page.getByLabel('Enter the 6-digit code').fill(code);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function vendorLogin(page, email) {
  await page.goto(VENDOR);
  await page.getByLabel('Shop email').fill(email);
  await page.getByLabel('Password').fill('demo1234');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('tab', { name: /Orders/ }).waitFor();
}

async function payOnHostedPage(page) {
  await page.waitForURL(/\/sandbox\/checkout\//);
  await page.getByText('SANDBOX PAYMENT PAGE').waitFor();
  await shot(page, '04-hosted-payment');
  await page.getByRole('button', { name: /^Pay ₹/ }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]+\?from=checkout/, { timeout: 15000 });
}

async function handOver(vendor, orderNumber, otp) {
  const card = vendor.locator('article.ocard', { hasText: orderNumber });
  await card.getByRole('button', { name: 'Hand over' }).click();
  for (const d of otp) await vendor.locator('.keypad').getByRole('button', { name: d, exact: true }).click();
  await vendor.getByRole('button', { name: 'Confirm handover' }).click();
  await card.waitFor({ state: 'detached', timeout: 10000 });
}

// ---------------- WALK-IN ----------------
{
  step('WALK-IN: student scans Shop 01 QR');
  const sctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const student = await sctx.newPage();
  watch(student, 'student');
  await student.goto(`${STUDENT}/s/demo-jg01-qr7k`);
  await student.getByRole('heading', { name: 'Demo Shop 01' }).waitFor();
  await student.getByText('Walk-in order · you’re at the counter').waitFor();
  await shot(student, '01-walkin-menu');

  step('adds a dosa with options + note, and idli');
  await student.getByRole('button', { name: 'Choose options for Demo Masala Dosa' }).click();
  await student.getByLabel('Cheese').check();
  await student.getByLabel('Spicy').check();
  await student.getByLabel('Cooking note (optional)').fill('Less oil');
  await shot(student, '02-options-sheet');
  await student.getByRole('button', { name: /^Add · ₹85\.00/ }).click();
  await student.getByRole('button', { name: 'Add Demo Idli Plate (3)' }).click();
  await student.locator('.cartbar').click();
  await student.getByRole('heading', { name: 'Review your order' }).waitFor();

  step('signs in at checkout, sees fee and estimate, pays on the hosted page');
  await student.getByRole('button', { name: 'Sign in to pay' }).click();
  await signInStudent(student, 'e2e.walkin@srmist.edu.in');
  await student.getByText(/Ready in about \d+ min/).waitFor();
  await student.getByText('QuickPick convenience fee (7%)').waitFor();
  await shot(student, '03-walkin-checkout');
  await student.getByRole('button', { name: /^Pay ₹/ }).click();
  await payOnHostedPage(student);
  await student.getByRole('heading', { name: 'Waiting for the shop to accept' }).waitFor({ timeout: 15000 });
  const orderNumber = (await student.locator('.code-later b').textContent()).trim();
  step(`order ${orderNumber} paid and sent to the shop`);

  step('vendor tablet: order appears, accept → slip prints on the simulated printer');
  const vctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const vendor = await vctx.newPage();
  watch(vendor, 'vendor');
  await vendorLogin(vendor, 'vendor-01@quickpick.demo');
  const card = vendor.locator('article.ocard', { hasText: orderNumber });
  await card.waitFor();
  await card.getByText('WALK-IN').waitFor();
  await card.getByText('Note: Less oil').waitFor();
  await card.getByText('Cheese · Spicy').waitFor();
  await shot(vendor, '05-vendor-new-order');
  await card.getByRole('radio', { name: '10 minutes' }).click();
  await card.getByRole('button', { name: 'Accept' }).click();
  await vendor.locator('.tray').getByText(orderNumber).first().waitFor({ timeout: 20000 });
  await card.getByText('Slip printed').waitFor({ timeout: 15000 });
  await shot(vendor, '06-vendor-slip-printed');
  await vendor.locator('.tray-head').click(); // fold the simulated printer output away

  step('vendor: preparing → ready');
  await card.getByRole('button', { name: 'Start preparing' }).click();
  await card.getByRole('button', { name: 'Mark ready' }).click();
  await card.getByRole('button', { name: 'Hand over' }).waitFor();

  step('student: ready notification + OTP appear');
  await student.getByRole('heading', { name: 'Ready — show your code' }).waitFor({ timeout: 15000 });
  const label = await student.locator('.ticket-code').getAttribute('aria-label');
  const otp = label.replace(/\D/g, '');
  if (otp.length !== 6) throw new Error('OTP not shown');
  await student.locator('.inapp, .navlink.bell .dotcount').first().waitFor({ timeout: 20000 });
  await shot(student, '07-student-otp');

  step('vendor: wrong code is refused, right code hands over');
  const c2 = vendor.locator('article.ocard', { hasText: orderNumber });
  await c2.getByRole('button', { name: 'Hand over' }).click();
  for (const d of (otp === '000000' ? '111111' : '000000')) await vendor.locator('.keypad').getByRole('button', { name: d, exact: true }).click();
  await vendor.getByRole('button', { name: 'Confirm handover' }).click();
  await vendor.getByText('That code does not match this order').waitFor();
  await vendor.getByRole('button', { name: 'Close' }).click();
  await handOver(vendor, orderNumber, otp);
  await student.getByRole('heading', { name: 'Collected. Enjoy your meal' }).waitFor({ timeout: 15000 });
  await shot(student, '08-student-collected');
  step('WALK-IN complete');
  await sctx.close();
  await vctx.close();
}

// ---------------- PRE-ORDER ----------------
{
  step('PRE-ORDER: student chooses Pre-order → Shop 02');
  const sctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const student = await sctx.newPage();
  watch(student, 'student-pre');
  await student.goto(STUDENT);
  await shot(student, '09-home-two-modes');
  await student.getByRole('link', { name: /Pre-order/ }).first().click();
  await student.getByRole('heading', { name: 'Choose a shop' }).waitFor();
  await student.getByRole('link', { name: /Demo Shop 02/ }).click();
  await student.getByRole('button', { name: 'Add Demo Veg Meal' }).click();
  await student.locator('.cartbar').click();
  await student.getByRole('button', { name: 'Sign in to pay' }).click();
  await signInStudent(student, 'e2e.pre@srmist.edu.in');
  await student.locator('.slot:not([disabled])').nth(2).click();
  await student.getByRole('button', { name: /^Pay ₹107\.00/ }).waitFor();
  await shot(student, '10-preorder-checkout');
  await student.getByRole('button', { name: /^Pay ₹107\.00/ }).click();
  await payOnHostedPage(student);
  await student.getByRole('heading', { name: 'Waiting for the shop to accept' }).waitFor({ timeout: 15000 });
  const orderNumber = (await student.locator('.code-later b').textContent()).trim();

  step(`vendor 02 accepts ${orderNumber}, slip prints, ready`);
  const vctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const vendor = await vctx.newPage();
  watch(vendor, 'vendor-pre');
  await vendorLogin(vendor, 'vendor-02@quickpick.demo');
  const card = vendor.locator('article.ocard', { hasText: orderNumber });
  await card.getByText('PRE-ORDER').waitFor();
  await card.getByRole('button', { name: 'Accept' }).click();
  await card.getByText('Slip printed').waitFor({ timeout: 20000 });
  if (await vendor.locator('.tray.open').count()) await vendor.locator('.tray-head').click();
  await card.getByRole('button', { name: 'Ready now' }).click();
  await student.getByRole('heading', { name: 'Ready — show your code' }).waitFor({ timeout: 15000 });
  const otp = (await student.locator('.ticket-code').getAttribute('aria-label')).replace(/\D/g, '');
  await handOver(vendor, orderNumber, otp);
  await student.getByRole('heading', { name: 'Collected. Enjoy your meal' }).waitFor({ timeout: 15000 });
  step('PRE-ORDER complete');
  await sctx.close();
  await vctx.close();
}

// ---------------- invalid QR ----------------
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  const quiet = [];
  p.on('console', (m) => m.type() === 'error' && quiet.push(m.text()));
  await p.goto(`${STUDENT}/s/not-a-real-shop`);
  await p.getByRole('heading', { name: 'We don’t recognise this QR code' }).waitFor();
  // The 404 from the API is expected here; anything else is not.
  errors.push(...quiet.filter((t) => !/404|Not Found/i.test(t)).map((t) => `[invalid-qr] ${t}`));
  step('invalid QR shows a clear message');
  await ctx.close();
}

// ---------------- printer failure on the tablet ----------------
{
  step('PRINTER FAILURE: printer off → retries → failed banner → fix → retry prints a labelled slip');
  const API = process.env.API_URL ?? 'http://localhost:4100';
  const j = async (path, body, token, headers = {}) => {
    const r = await fetch(API + '/api/v1' + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return r.json();
  };
  const email = 'e2e.printer@srmist.edu.in';
  const { devCode } = await j('/auth/otp/request', { email });
  const { token } = await j('/auth/otp/verify', { email, code: devCode });
  const shop = (await j('/qr/demo-jg01-qr7k')).shop;
  const menu = await j(`/shops/${shop.id}/menu`);
  const idli = menu.items.find((i) => i.name === 'Demo Idli Plate (3)');
  const { order } = await j('/orders', { source: 'WALKIN_QR', shopId: shop.id, items: [{ menuItemId: idli.id, quantity: 1 }] }, token, { 'Idempotency-Key': 'e2e-printer-' + Date.now() });
  await j('/payments/checkout', { orderId: order.id, returnUrl: `${STUDENT}/orders/${order.id}` }, token);
  await j('/sandbox/payments/simulate', { orderId: order.id, outcome: 'success' }, token);

  const vctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const vendor = await vctx.newPage();
  watch(vendor, 'vendor-printer');
  await vendorLogin(vendor, 'vendor-01@quickpick.demo');
  await vendor.getByRole('tab', { name: /Printer/ }).click();
  await vendor.getByRole('button', { name: 'Switched off' }).click();
  await vendor.getByRole('tab', { name: /Orders/ }).click();
  const card = vendor.locator('article.ocard', { hasText: order.orderNumber });
  await card.getByRole('button', { name: 'Accept' }).click();
  await vendor.getByText(/kitchen slip.* didn’t print/).waitFor({ timeout: 100000 });
  await card.getByText('Slip failed').waitFor();
  await shot(vendor, '15-vendor-printer-failed');
  await vendor.getByRole('tab', { name: /Printer/ }).click();
  await vendor.getByRole('button', { name: 'Working' }).click();
  await vendor.getByRole('button', { name: 'Retry', exact: true }).click();
  await vendor.locator('.tray').getByText('CHECK FOR DUPLICATE').first().waitFor({ timeout: 30000 });
  await shot(vendor, '16-vendor-retry-labelled');
  step('failed slip retried and printed with a duplicate warning; the order stayed on the board throughout');
  await vctx.close();
}

// ---------------- admin dashboard ----------------
{
  step('ADMIN: every section loads; QR code; order detail');
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const admin = await ctx.newPage();
  watch(admin, 'admin');
  await admin.goto(process.env.ADMIN_URL ?? 'http://localhost:5275');
  await admin.getByLabel('Email').fill('super@quickpick.demo');
  await admin.getByLabel('Password').fill('demo1234');
  await admin.getByRole('button', { name: 'Sign in' }).click();
  await admin.getByRole('heading', { name: 'By ordering mode' }).waitFor();
  await shot(admin, '11-admin-overview');
  for (const tab of ['Orders', 'Shops & QR codes', 'Menus', 'Vendors', 'Tablets', 'Printers', 'Payments & refunds', 'Reconciliation', 'Settlements', 'Pricing', 'Support', 'Audit log']) {
    await admin.getByRole('button', { name: tab, exact: true }).click();
    await admin.waitForTimeout(400);
    if (await admin.locator('.error').count()) throw new Error(`Admin ${tab}: ${await admin.locator('.error').first().textContent()}`);
  }
  await admin.getByRole('button', { name: 'Shops & QR codes', exact: true }).click();
  await admin.getByRole('row', { name: /JG01/ }).getByRole('button', { name: 'QR code' }).click();
  await admin.locator('.qr-img svg').waitFor();
  await admin.getByText('/s/demo-jg01-qr7k').waitFor();
  await shot(admin, '12-admin-qr');
  await admin.getByRole('button', { name: 'Printers', exact: true }).click();
  await admin.getByRole('cell', { name: /JG01/ }).first().waitFor();
  await shot(admin, '13-admin-printers');
  await admin.getByRole('button', { name: 'Orders', exact: true }).click();
  await admin.getByRole('button', { name: 'Details' }).first().click();
  await admin.getByRole('heading', { name: 'Kitchen slips' }).waitFor();
  await shot(admin, '14-admin-order-detail');
  await ctx.close();
}

await browser.close();
if (errors.length) {
  console.error('\nConsole errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('\nBrowser E2E passed: walk-in, pre-order, invalid QR, printer failure, admin. No console errors.');
