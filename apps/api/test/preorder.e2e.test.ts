import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchNotifications } from '../src/services/notifications.js';
import { makeEnv, type Env } from './helpers.js';

let e: Env;
let vendor02: string;

beforeAll(async () => {
  e = await makeEnv();
  vendor02 = await e.staffToken('vendor-02@quickpick.demo');
}, 60_000);
afterAll(async () => e.close());

describe('PRE-ORDER: Shop 02 with a pickup slot', () => {
  it('runs the whole pre-order flow', async () => {
    const s = await e.studentToken('pre1@srm.test');
    const m = await e.menu(e.shop02.id);
    const biryani = m['Demo Chicken Biryani'];
    const slots = (await e.api.get(`/api/v1/shops/${e.shop02.id}/pickup-slots`)).body.slots;
    expect(slots.length).toBeGreaterThan(5);
    const slot = slots[3];

    const items = [{ menuItemId: biryani.id, quantity: 1, modifierIds: [e.mod(biryani, 'Boiled egg')] }];
    const created = await e.createOrder(s, { source: 'PREORDER', shopId: e.shop02.id, slotId: slot.id, items });
    expect(created.status).toBe(201);
    const order = created.body.order;
    expect(order).toMatchObject({ orderSource: 'PREORDER', subtotalPaise: 15500, feePaise: 1085, totalPaise: 16585, estimatedReadyAt: null });
    expect(order.slotStartsAt).toBe(new Date(slot.startsAt).toISOString());
    expect(await e.reserved(slot.id)).toBe(1);

    const checkout = await e.startCheckout(s, order.id);
    await e.hostedPay(checkout.body.checkoutUrl, 'success');

    const board = (await e.api.get('/api/v1/vendor/orders').set(e.auth(vendor02))).body.orders;
    expect(board.find((o: any) => o.id === order.id)).toMatchObject({ orderSource: 'PREORDER', status: 'AWAITING_VENDOR' });

    expect((await e.accept(vendor02, order.id, 15)).body.order.printStatus).toBe('PENDING');
    const tab = await e.tablet(vendor02);
    const [job] = await tab.claim();
    expect(job.ticket).toMatchObject({ orderSource: 'PREORDER', targetLabel: 'Pickup at', targetAt: order.slotStartsAt });
    expect((await tab.report(job.id, { ok: true })).body.job.status).toBe('PRINTED');

    await e.setStatus(vendor02, order.id, 'PREPARING');
    await e.setStatus(vendor02, order.id, 'READY');
    await dispatchNotifications(e.ctx);
    const [ready] = await e.db.query(`SELECT status FROM notifications WHERE order_id=$1 AND type='ORDER_READY' AND channel='PUSH'`, [order.id]);
    expect(ready.status).toBe('SIMULATED');

    const otp = (await e.studentOrder(s, order.id)).pickupOtp;
    expect(otp).toMatch(/^\d{6}$/);
    const done = await e.verifyOtp(vendor02, order.id, otp);
    expect(done.body.order).toMatchObject({ status: 'COLLECTED', collectedVia: 'OTP' });
    // Collected pre-orders keep their slot reservation (capacity was really used).
    expect(await e.reserved(slot.id)).toBe(1);
  });

  it('walk-in orders join the same kitchen queue and push the estimate out', async () => {
    const before = (await e.api.get(`/api/v1/shops/${e.shop02.id}/walkin-estimate`)).body;
    for (let i = 0; i < 4; i++) await e.placePaid(await e.studentToken(`q${i}@srm.test`), { source: 'WALKIN_QR', shopId: e.shop02.id });
    const after = (await e.api.get(`/api/v1/shops/${e.shop02.id}/walkin-estimate`)).body;
    expect(after.queueLength).toBe(before.queueLength + 4);
    expect(after.minutes).toBeGreaterThan(before.minutes);
    // One queue on the tablet, sorted by target time (slot start or estimate).
    const board = (await e.api.get('/api/v1/vendor/orders').set(e.auth(vendor02))).body.orders;
    expect(new Set(board.map((o: any) => o.orderSource))).toEqual(new Set(['WALKIN_QR']));
  });
});

describe('pickup capacity', () => {
  it('lets exactly `capacity` of 10 simultaneous students reserve one slot', async () => {
    const slot = await e.nextSlot(e.shop02.id);
    const m = await e.menu(e.shop02.id);
    const tokens = await Promise.all(Array.from({ length: 10 }, (_, i) => e.studentToken(`cap${i}@srm.test`)));
    const results = await Promise.all(
      tokens.map((t) => e.createOrder(t, { source: 'PREORDER', shopId: e.shop02.id, slotId: slot.id, items: [{ menuItemId: m['Demo Masala Chai'].id, quantity: 1 }] })),
    );
    const ok = results.filter((r) => r.status === 201);
    const full = results.filter((r) => r.status === 409 && r.body.error.code === 'SLOT_FULL');
    expect(ok).toHaveLength(5); // demo capacity
    expect(full).toHaveLength(5);
    expect(await e.reserved(slot.id)).toBe(5);
  });

  it('requires a slot for pre-orders and forbids one for walk-ins', async () => {
    const s = await e.studentToken('slotrules@srm.test');
    const m = await e.menu(e.shop02.id);
    const items = [{ menuItemId: m['Demo Veg Meal'].id, quantity: 1 }];
    expect((await e.createOrder(s, { source: 'PREORDER', shopId: e.shop02.id, items })).body.error.code).toBe('SLOT_REQUIRED');
    const slot = await e.nextSlot(e.shop02.id);
    expect((await e.createOrder(s, { source: 'WALKIN_QR', shopId: e.shop02.id, slotId: slot.id, items })).body.error.code).toBe('SLOT_NOT_ALLOWED');
  });

  it('gives 10 simultaneous walk-in orders distinct order numbers', async () => {
    const tokens = await Promise.all(Array.from({ length: 10 }, (_, i) => e.studentToken(`sim${i}@srm.test`)));
    const orders = await Promise.all(tokens.map((t) => e.placeWalkin(t, e.shop01.id)));
    expect(new Set(orders.map((o) => o.orderNumber)).size).toBe(10);
  });
});
