import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { expireStaleOrders } from '../src/services/orders.js';
import { reconcilePayments } from '../src/services/payments.js';
import { makeEnv, type Env } from './helpers.js';

let e: Env;
let vendor01: string;
let vendor02: string;
let admin: string;

beforeAll(async () => {
  e = await makeEnv();
  vendor01 = await e.staffToken('vendor-01@quickpick.demo');
  vendor02 = await e.staffToken('vendor-02@quickpick.demo');
  admin = await e.staffToken('admin@quickpick.demo');
}, 60_000);
afterAll(async () => e.close());

const vendorOrderIds = async (t: string) => (await e.api.get('/api/v1/vendor/orders').set(e.auth(t))).body.orders.map((o: any) => o.id);

describe('QR and shop availability', () => {
  it('rejects an invalid QR token', async () => {
    for (const token of ['not-a-real-token', 'x', '../../etc', 'demo-jg01-qr7k-x']) {
      const r = await e.api.get(`/api/v1/qr/${encodeURIComponent(token)}`);
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('QR_NOT_FOUND');
    }
  });

  it('explains a suspended vendor and refuses orders', async () => {
    await e.api.patch(`/api/v1/admin/shops/${e.shop02.id}`).set(e.auth(admin)).send({ status: 'SUSPENDED' });
    const qr = await e.api.get(`/api/v1/qr/${e.DEMO_QR.JG02}`);
    expect(qr.status).toBe(200);
    expect(qr.body.walkin).toMatchObject({ orderable: false, reason: 'SUSPENDED' });
    expect(qr.body.estimate).toBeNull();
    expect((await e.api.get(`/api/v1/shops/${e.shop02.id}/menu`)).status).toBe(404);
    const s = await e.studentToken('susp@srm.test');
    const m = await e.db.query(`SELECT id FROM menu_items WHERE shop_id=$1 LIMIT 1`, [e.shop02.id]);
    const r = await e.createOrder(s, { source: 'WALKIN_QR', shopId: e.shop02.id, items: [{ menuItemId: m[0].id, quantity: 1 }] });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('SHOP_UNAVAILABLE');
    await e.api.patch(`/api/v1/admin/shops/${e.shop02.id}`).set(e.auth(admin)).send({ status: 'ACTIVE' });
  });

  it('refuses walk-in orders when the shop is closed or has paused/disabled QR orders', async () => {
    const s = await e.studentToken('closed@srm.test');
    const m = await e.menu(e.shop01.id);
    const order = () => e.createOrder(s, { source: 'WALKIN_QR', shopId: e.shop01.id, items: [{ menuItemId: m['Demo Idli Plate (3)'].id, quantity: 1 }] });

    const saved = e.clock.t;
    e.clock.t = new Date('2026-11-09T17:00:00Z'); // 22:30 IST, after 22:00 close
    expect((await e.api.get(`/api/v1/qr/${e.DEMO_QR.JG01}`)).body.walkin.reason).toBe('CLOSED');
    expect((await order()).body.error.code).toBe('SHOP_CLOSED');
    e.clock.t = saved;

    await e.api.patch('/api/v1/vendor/shop/status').set(e.auth(vendor01)).send({ acceptingOrders: false });
    expect((await order()).body.error.code).toBe('SHOP_PAUSED');
    await e.api.patch('/api/v1/vendor/shop/status').set(e.auth(vendor01)).send({ acceptingOrders: true, walkinEnabled: false });
    expect((await order()).body.error.code).toBe('MODE_DISABLED');
    await e.api.patch('/api/v1/vendor/shop/status').set(e.auth(vendor01)).send({ walkinEnabled: true });
    expect((await order()).status).toBe(201);
  });

  it('refuses an unavailable item and an unavailable or invalid option', async () => {
    const s = await e.studentToken('unavail@srm.test');
    const m = await e.menu(e.shop01.id);
    const dosa = m['Demo Masala Dosa'];
    const coffee = m['Demo Filter Coffee'];
    await e.api.patch(`/api/v1/vendor/menu-items/${dosa.id}`).set(e.auth(vendor01)).send({ available: false });
    const r1 = await e.createOrder(s, { source: 'WALKIN_QR', shopId: e.shop01.id, items: [{ menuItemId: dosa.id, quantity: 1 }] });
    expect(r1.body.error.code).toBe('ITEM_UNAVAILABLE');
    await e.api.patch(`/api/v1/vendor/menu-items/${dosa.id}`).set(e.auth(vendor01)).send({ available: true });

    const q = (items: any[]) => e.api.post('/api/v1/orders/quote').set(e.auth(s)).send({ source: 'WALKIN_QR', shopId: e.shop01.id, items });
    expect((await q([{ menuItemId: coffee.id, quantity: 1 }])).body.error.code).toBe('MODIFIER_REQUIRED'); // size is required
    expect((await q([{ menuItemId: coffee.id, quantity: 1, modifierIds: [e.mod(coffee, 'Regular'), e.mod(coffee, 'Large')] }])).body.error.code).toBe('INVALID_MODIFIER');
    expect((await q([{ menuItemId: coffee.id, quantity: 1, modifierIds: [e.mod(dosa, 'Cheese')] }])).body.error.code).toBe('INVALID_MODIFIER');
    await e.api.patch(`/api/v1/vendor/modifiers/${e.mod(dosa, 'Cheese')}`).set(e.auth(vendor01)).send({ available: false });
    expect((await q([{ menuItemId: dosa.id, quantity: 1, modifierIds: [e.mod(dosa, 'Cheese')] }])).body.error.code).toBe('MODIFIER_UNAVAILABLE');
    await e.api.patch(`/api/v1/vendor/modifiers/${e.mod(dosa, 'Cheese')}`).set(e.auth(vendor01)).send({ available: true });
  });

  it('rejects a cart mixing two shops', async () => {
    const s = await e.studentToken('multi@srm.test');
    const a = await e.menu(e.shop01.id);
    const b = await e.menu(e.shop02.id);
    const r = await e.createOrder(s, { source: 'WALKIN_QR', shopId: e.shop01.id, items: [{ menuItemId: a['Demo Idli Plate (3)'].id, quantity: 1 }, { menuItemId: b['Demo Veg Meal'].id, quantity: 1 }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('MULTI_SHOP_CART');
  });
});

describe('payments', () => {
  it('failed payment: nothing reaches the vendor, the student can retry, and a retry can succeed', async () => {
    const s = await e.studentToken('fail@srm.test');
    const o = await e.placeWalkin(s);
    const c1 = await e.startCheckout(s, o.id);
    await e.hostedPay(c1.body.checkoutUrl, 'failure');
    expect(await e.studentOrder(s, o.id)).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'FAILED' });
    expect(await vendorOrderIds(vendor01)).not.toContain(o.id);
    const c2 = await e.startCheckout(s, o.id);
    expect(c2.body.attemptNo).toBe(2);
    // The old session is closed.
    expect((await e.api.get(new URL(c1.body.checkoutUrl).pathname)).text).toContain('This checkout is closed');
    await e.hostedPay(c2.body.checkoutUrl, 'success');
    expect(await e.studentOrder(s, o.id)).toMatchObject({ status: 'AWAITING_VENDOR', paymentStatus: 'SUCCEEDED' });
    const attempts = await e.db.query(`SELECT attempt_no, status FROM payment_attempts WHERE order_id=$1 ORDER BY attempt_no`, [o.id]);
    expect(attempts).toEqual([{ attempt_no: 1, status: 'FAILED' }, { attempt_no: 2, status: 'SUCCEEDED' }]);
  });

  it('pending payment: stays unpaid and invisible to the vendor, then expires and frees the slot', async () => {
    const s = await e.studentToken('pending@srm.test');
    const m = await e.menu(e.shop02.id);
    const slot = await e.nextSlot(e.shop02.id);
    const o = (await e.createOrder(s, { source: 'PREORDER', shopId: e.shop02.id, slotId: slot.id, items: [{ menuItemId: m['Demo Veg Meal'].id, quantity: 1 }] })).body.order;
    const c = await e.startCheckout(s, o.id);
    await e.hostedPay(c.body.checkoutUrl, 'pending');
    expect(await e.studentOrder(s, o.id)).toMatchObject({ status: 'PENDING_PAYMENT', paymentStatus: 'INITIATED' });
    expect(await vendorOrderIds(vendor02)).not.toContain(o.id);
    expect(await e.reserved(slot.id)).toBe(1);
    e.advance(11 * 60_000);
    await expireStaleOrders(e.ctx);
    expect((await e.studentOrder(s, o.id)).status).toBe('EXPIRED');
    expect(await e.reserved(slot.id)).toBe(0);
    e.advance(-11 * 60_000);
  });

  it('duplicate webhook: processed once, the duplicate is a no-op', async () => {
    const s = await e.studentToken('dup@srm.test');
    const o = await e.placeWalkin(s);
    await e.startCheckout(s, o.id);
    const [p] = await e.db.query(`SELECT provider_ref, amount_paise FROM payments WHERE order_id=$1`, [o.id]);
    const signed = e.mock.buildSignedEvent({ id: 'evt_dup_1', type: 'payment.succeeded', providerRef: p.provider_ref, amountPaise: Number(p.amount_paise) });
    const first = await e.api.post('/api/v1/webhooks/payments/mock').set(signed.headers).set('Content-Type', 'application/json').send(signed.body.toString());
    const second = await e.api.post('/api/v1/webhooks/payments/mock').set(signed.headers).set('Content-Type', 'application/json').send(signed.body.toString());
    expect(first.body).toMatchObject({ status: 'processed', result: 'payment_succeeded' });
    expect(second.body).toMatchObject({ status: 'duplicate' });
    const splits = await e.db.query(`SELECT * FROM payment_splits WHERE order_id=$1`, [o.id]);
    expect(splits).toHaveLength(2);
  });

  it('ignores events whose amount, currency or order id do not match', async () => {
    const s = await e.studentToken('mismatch@srm.test');
    const o = await e.placeWalkin(s);
    await e.startCheckout(s, o.id);
    const [p] = await e.db.query(`SELECT provider_ref, amount_paise FROM payments WHERE order_id=$1`, [o.id]);
    const send = async (id: string, extra: Record<string, unknown>) => {
      const signed = e.mock.buildSignedEvent({ id, type: 'payment.succeeded', providerRef: p.provider_ref, amountPaise: Number(p.amount_paise), ...extra });
      return (await e.api.post('/api/v1/webhooks/payments/mock').set(signed.headers).set('Content-Type', 'application/json').send(signed.body.toString())).body.result;
    };
    expect(await send('evt_mm_1', { amountPaise: 1 })).toBe('amount_mismatch_ignored');
    expect(await send('evt_mm_2', { currency: 'USD' })).toBe('currency_mismatch_ignored');
    expect(await send('evt_mm_3', { orderId: '00000000-0000-4000-8000-000000000000' })).toBe('order_mismatch_ignored');
    expect((await e.studentOrder(s, o.id)).status).toBe('PENDING_PAYMENT');
  });

  it('rejects bad, missing and tampered webhook signatures', async () => {
    const signed = e.mock.buildSignedEvent({ id: 'evt_sig', type: 'payment.succeeded', providerRef: 'x', amountPaise: 1 });
    const post = (headers: Record<string, string>, body: string) => e.api.post('/api/v1/webhooks/payments/mock').set(headers).set('Content-Type', 'application/json').send(body);
    expect((await post({}, signed.body.toString())).status).toBe(401);
    expect((await post({ 'x-mock-signature': 'f'.repeat(64) }, signed.body.toString())).status).toBe(401);
    expect((await post(signed.headers, signed.body.toString().replace('"amountPaise":1', '"amountPaise":2'))).status).toBe(401);
  });

  it('never trusts the browser: returning to the app without a webhook does not mark an order paid', async () => {
    const s = await e.studentToken('notrust@srm.test');
    const o = await e.placeWalkin(s);
    const c = await e.startCheckout(s, o.id);
    // The student just opens the return URL / refreshes the order: still unpaid.
    expect((await e.studentOrder(s, o.id)).paymentStatus).toBe('INITIATED');
    // A client cannot claim payment through any order field.
    const r = await e.api.post('/api/v1/orders').set(e.auth(s)).set('Idempotency-Key', 'trust-key-123').send({ source: 'WALKIN_QR', shopId: e.shop01.id, items: o.items.map((i: any) => ({ menuItemId: i.menuItemId, quantity: 1 })), paymentStatus: 'SUCCEEDED', status: 'AWAITING_VENDOR' });
    expect(r.body.order.status).toBe('PENDING_PAYMENT');
    void c;
  });

  it('payment success without the browser returning still confirms the order', async () => {
    const s = await e.studentToken('noreturn@srm.test');
    const o = await e.placeWalkin(s);
    const c = await e.startCheckout(s, o.id);
    const { done } = await e.hostedPay(c.body.checkoutUrl, 'success_no_return');
    expect(done.text).toContain('You can close this tab');
    expect(done.text).not.toContain('http-equiv="refresh"');
    expect(await e.studentOrder(s, o.id)).toMatchObject({ status: 'AWAITING_VENDOR', paymentStatus: 'SUCCEEDED' });
    expect(await vendorOrderIds(vendor01)).toContain(o.id);
  });

  it('a lost webhook is recovered by reconciliation with the provider', async () => {
    const s = await e.studentToken('lost@srm.test');
    const o = await e.placeWalkin(s);
    const c = await e.startCheckout(s, o.id);
    await e.hostedPay(c.body.checkoutUrl, 'webhook_lost');
    expect((await e.studentOrder(s, o.id)).paymentStatus).toBe('INITIATED');
    e.advance(2 * 60_000);
    expect(await reconcilePayments(e.ctx)).toBeGreaterThanOrEqual(1);
    expect(await e.studentOrder(s, o.id)).toMatchObject({ status: 'AWAITING_VENDOR', paymentStatus: 'SUCCEEDED' });
    const [rec] = await e.db.query(`SELECT * FROM reconciliation_records WHERE order_id=$1`, [o.id]);
    expect(rec).toMatchObject({ kind: 'PAYMENT', provider_status: 'SUCCEEDED', status: 'AUTO_RESOLVED' });
    // Running it again changes nothing.
    expect(await reconcilePayments(e.ctx)).toBe(0);
    e.advance(-2 * 60_000);
  });

  it('a late success after expiry is refunded automatically', async () => {
    const s = await e.studentToken('late@srm.test');
    const o = await e.placeWalkin(s);
    await e.startCheckout(s, o.id);
    e.advance(11 * 60_000);
    await expireStaleOrders(e.ctx);
    await e.simulate(s, o.id, 'success');
    const after = await e.studentOrder(s, o.id);
    expect(after.status).toBe('EXPIRED');
    expect(after.paymentStatus).toBe('REFUNDED');
    e.advance(-11 * 60_000);
  });
});

describe('vendor rejection and refunds', () => {
  it('rejection refunds in full and tells the student', async () => {
    const s = await e.studentToken('reject@srm.test');
    const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
    const r = await e.api.post(`/api/v1/vendor/orders/${orderId}/reject`).set(e.auth(vendor01)).send({ reason: 'Out of batter' });
    expect(r.body.order.status).toBe('REJECTED');
    const st = await e.studentOrder(s, orderId);
    expect(st.paymentStatus).toBe('REFUNDED');
    const types = (await e.db.query(`SELECT type FROM notifications WHERE order_id=$1 AND channel='IN_APP' ORDER BY created_at`, [orderId])).map((n: any) => n.type);
    expect(types).toEqual(expect.arrayContaining(['ORDER_REJECTED', 'REFUND_INITIATED', 'REFUND_COMPLETED']));
    // No slip is ever printed for a rejected order.
    expect(await e.db.query(`SELECT 1 FROM print_jobs WHERE order_id=$1`, [orderId])).toHaveLength(0);
  });

  it('refund failure is flagged, reconciled and can be retried by an admin', async () => {
    const s = await e.studentToken('refundfail@srm.test');
    const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
    e.mock.setRefundOutcome('refund.failed');
    await e.api.post(`/api/v1/vendor/orders/${orderId}/reject`).set(e.auth(vendor01)).send({ reason: 'Closing early' });
    e.mock.setRefundOutcome('refund.processed');
    expect((await e.studentOrder(s, orderId)).paymentStatus).toBe('REFUND_FAILED');
    const [rec] = await e.db.query(`SELECT * FROM reconciliation_records WHERE order_id=$1 AND kind='REFUND'`, [orderId]);
    expect(rec).toMatchObject({ status: 'OPEN', action: 'MANUAL_REFUND_REQUIRED' });
    const [failed] = await e.db.query(`SELECT id FROM refunds WHERE order_id=$1 AND status='FAILED'`, [orderId]);
    const retry = await e.api.post(`/api/v1/admin/refunds/${failed.id}/retry`).set(e.auth(admin)).send({});
    expect(retry.status).toBe(201);
    expect((await e.studentOrder(s, orderId)).paymentStatus).toBe('REFUNDED');
    const [rec2] = await e.db.query(`SELECT status FROM reconciliation_records WHERE id=$1`, [rec.id]);
    expect(rec2.status).toBe('RESOLVED');
  });

  it('partial refunds cannot exceed the payment', async () => {
    const s = await e.studentToken('partial@srm.test');
    const { orderId, order } = await e.placePaid(s);
    const ok = await e.api.post('/api/v1/admin/refunds').set(e.auth(admin)).send({ orderId, amountPaise: 500, reason: 'Missing item' });
    expect(ok.status).toBe(201);
    const over = await e.api.post('/api/v1/admin/refunds').set(e.auth(admin)).send({ orderId, amountPaise: order.totalPaise, reason: 'Too much' });
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('REFUND_EXCEEDS_PAYMENT');
  });

  it('an unanswered paid order expires and is refunded', async () => {
    const s = await e.studentToken('unanswered@srm.test');
    const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
    e.advance(3 * 60_000); // demo accept timeout is 120 s
    await expireStaleOrders(e.ctx);
    expect(await e.studentOrder(s, orderId)).toMatchObject({ status: 'EXPIRED', paymentStatus: 'REFUNDED' });
    e.advance(-3 * 60_000);
  });
});
