import { renderKitchenTicket } from '@qp2/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchNotifications } from '../src/services/notifications.js';
import { makeEnv, STUDENT_APP, type Env } from './helpers.js';

let e: Env;
let vendor01: string;
let vendor02: string;

beforeAll(async () => {
  e = await makeEnv();
  vendor01 = await e.staffToken('vendor-01@quickpick.demo');
  vendor02 = await e.staffToken('vendor-02@quickpick.demo');
}, 60_000);
afterAll(async () => e.close());

const ascii = (b: Uint8Array) => Array.from(b, (c) => (c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : ' ')).join('');

describe('Milestone 1: WALK-IN QR → menu → cart → sandbox payment → tablet → accept → slip → READY → push → OTP → COLLECTED', () => {
  it('runs the whole walk-in flow for Shop 01', async () => {
    // 1–3. Student scans Shop 01's QR; the token identifies the shop with no searching.
    const qr = await e.api.get(`/api/v1/qr/${e.DEMO_QR.JG01}`);
    expect(qr.status).toBe(200);
    expect(qr.body.shop).toMatchObject({ id: e.shop01.id, code: 'JG01', name: 'Demo Shop 01' });
    expect(qr.body.walkin).toMatchObject({ orderable: true });
    expect(qr.body.estimate.minutes).toBeGreaterThan(0);

    // 4. Menu is loaded from the backend (no sign-in needed to browse).
    const m = await e.menu(e.shop01.id);
    const dosa = m['Demo Masala Dosa'];
    const coffee = m['Demo Filter Coffee'];
    expect(dosa.modifiers.length).toBeGreaterThan(0);

    // 5–7. Student signs in at checkout, builds a cart with add-ons and an instruction, sees subtotal + fee + total.
    const s = await e.studentToken('walkin1@srm.test');
    const items = [
      { menuItemId: dosa.id, quantity: 2, modifierIds: [e.mod(dosa, 'Cheese'), e.mod(dosa, 'Spicy')], notes: 'Less oil please' },
      { menuItemId: coffee.id, quantity: 1, modifierIds: [e.mod(coffee, 'Large')] },
    ];
    const quote = await e.api.post('/api/v1/orders/quote').set(e.auth(s)).send({ source: 'WALKIN_QR', shopId: e.shop01.id, items });
    expect(quote.status).toBe(200);
    // (6500 + 2000) * 2 + (2000 + 1000) = 20000 paise; 7% fee = 1400; total 21400.
    expect(quote.body.breakdown).toMatchObject({ subtotalPaise: 20000, feeRateBps: 700, feePaise: 1400, totalPaise: 21400 });
    expect(quote.body.slot).toBeNull();
    expect(quote.body.estimate.minutes).toBeGreaterThan(0);

    const created = await e.createOrder(s, { source: 'WALKIN_QR', shopId: e.shop01.id, items });
    expect(created.status).toBe(201);
    const order = created.body.order;
    expect(order).toMatchObject({ orderSource: 'WALKIN_QR', status: 'PENDING_PAYMENT', slotStartsAt: null, totalPaise: 21400 });
    expect(order.estimatedReadyAt).toBeTruthy();

    // Unpaid orders never reach the tablet.
    expect((await e.api.get('/api/v1/vendor/orders').set(e.auth(vendor01))).body.orders.map((o: any) => o.id)).not.toContain(order.id);

    // 8–9. Hosted sandbox checkout; the backend verifies the signed webhook.
    const checkout = await e.startCheckout(s, order.id);
    expect(checkout.status).toBe(200);
    expect(checkout.body.checkoutUrl).toMatch(/^http:\/\/api\.test\/sandbox\/checkout\/mock_ses_/);
    const { page, done } = await e.hostedPay(checkout.body.checkoutUrl, 'success');
    expect(page.text).toContain('Demo Shop 01');
    expect(page.text).toContain('₹214.00');
    expect(done.text).toContain(`${STUDENT_APP}/orders/${order.id}`);
    expect((await e.studentOrder(s, order.id))).toMatchObject({ status: 'AWAITING_VENDOR', paymentStatus: 'SUCCEEDED', otpState: 'NONE' });

    // 10. Order reaches Shop 01's tablet (and only Shop 01's).
    const board = (await e.api.get('/api/v1/vendor/orders').set(e.auth(vendor01))).body.orders;
    const onBoard = board.find((o: any) => o.id === order.id);
    expect(onBoard).toMatchObject({ orderSource: 'WALKIN_QR', paymentStatus: 'SUCCEEDED', customerName: 'walkin1', printStatus: 'NONE' });
    expect(onBoard.items.find((i: any) => i.name === 'Demo Masala Dosa')).toMatchObject({ quantity: 2, notes: 'Less oil please' });
    expect(onBoard.pickupOtp).toBeUndefined();
    expect((await e.api.get('/api/v1/vendor/orders').set(e.auth(vendor02))).body.orders.map((o: any) => o.id)).not.toContain(order.id);

    // 11. Vendor accepts → the slip job is created in the same transaction.
    const acc = await e.accept(vendor01, order.id, 12);
    expect(acc.status).toBe(200);
    expect(acc.body.order).toMatchObject({ status: 'ACCEPTED', prepMinutes: 12, printStatus: 'PENDING', otpState: 'ACTIVE' });
    expect(acc.body.order.pickupOtp).toBeUndefined();

    // 12. The tablet claims the job, renders ESC/POS and reports success.
    const tab = await e.tablet(vendor01);
    const jobs = await tab.claim();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ orderId: order.id, copyNumber: 1, attempt: 1, status: 'CLAIMED' });
    const slip = ascii(renderKitchenTicket(jobs[0].ticket, 80));
    expect(slip).toContain(order.orderNumber);
    expect(slip).toContain('WALK-IN (QR)');
    expect(slip).toContain('2 x Demo Masala Dosa');
    expect(slip).toContain('+ Cheese');
    expect(slip).toContain('NOTE: Less oil please');
    const printed = await tab.report(jobs[0].id, { ok: true });
    expect(printed.status).toBe(200);
    expect(printed.body.job.status).toBe('PRINTED');

    // 13. Preparing → READY.
    expect((await e.setStatus(vendor01, order.id, 'PREPARING')).status).toBe(200);
    // Before READY the student cannot see the code.
    expect((await e.studentOrder(s, order.id)).pickupOtp).toBeUndefined();
    const ready = await e.setStatus(vendor01, order.id, 'READY');
    expect(ready.body.order).toMatchObject({ status: 'READY', printStatus: 'PRINTED' });

    // 14. Ready push notification is queued (outbox) and delivered by the dispatcher (sandbox log provider).
    await dispatchNotifications(e.ctx);
    const pushes = await e.db.query(`SELECT type, status FROM notifications WHERE order_id=$1 AND channel='PUSH' ORDER BY created_at`, [order.id]);
    expect(pushes.map((p: any) => p.type)).toEqual(['PAYMENT_SUCCEEDED', 'ORDER_ACCEPTED', 'ORDER_READY']);
    expect(pushes.every((p: any) => p.status === 'SIMULATED')).toBe(true);
    const inbox = (await e.api.get('/api/v1/me/notifications').set(e.auth(s))).body;
    expect(inbox.notifications[0]).toMatchObject({ type: 'ORDER_READY', title: 'Your order is ready' });
    expect(JSON.stringify(inbox)).not.toMatch(/\b\d{6}\b/); // the OTP never travels in a notification

    // 15. Student opens the order and sees the 6-digit OTP.
    const st = await e.studentOrder(s, order.id);
    expect(st.status).toBe('READY');
    expect(st.pickupOtp).toMatch(/^\d{6}$/);
    expect(st.otpExpiresAt).toBeTruthy();

    // The vendor still never sees it.
    const vview = (await e.api.get('/api/v1/vendor/orders').set(e.auth(vendor01))).body.orders.find((o: any) => o.id === order.id);
    expect(JSON.stringify(vview)).not.toContain(st.pickupOtp);

    // 16–17. Vendor verifies the OTP → COLLECTED with a timestamp.
    const ok = await e.verifyOtp(vendor01, order.id, st.pickupOtp);
    expect(ok.status).toBe(200);
    expect(ok.body.order).toMatchObject({ status: 'COLLECTED', collectedVia: 'OTP', otpState: 'USED' });
    expect(ok.body.order.collectedAt).toBeTruthy();

    // Stored as a hash + ciphertext, never in plain text.
    const [row] = await e.db.query(`SELECT * FROM pickup_otps WHERE order_id=$1`, [order.id]);
    expect(JSON.stringify(row)).not.toContain(st.pickupOtp);
    const log = await e.db.query(`SELECT outcome FROM pickup_otp_attempts WHERE order_id=$1`, [order.id]);
    expect(log.map((l: any) => l.outcome)).toEqual(['SUCCESS']);

    // Audit trail of the whole journey.
    const events = (await e.db.query(`SELECT to_status FROM order_events WHERE order_id=$1 ORDER BY id`, [order.id])).map((x: any) => x.to_status);
    expect(events).toEqual(['PENDING_PAYMENT', 'AWAITING_VENDOR', 'ACCEPTED', 'PREPARING', 'READY', 'COLLECTED']);
  });
});
