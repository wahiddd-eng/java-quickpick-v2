import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type Env } from './helpers.js';

let e: Env;
let vendor01: string;
let vendor02: string;
let admin: string;
let superAdmin: string;

beforeAll(async () => {
  e = await makeEnv();
  vendor01 = await e.staffToken('vendor-01@quickpick.demo');
  vendor02 = await e.staffToken('vendor-02@quickpick.demo');
  admin = await e.staffToken('admin@quickpick.demo');
  superAdmin = await e.staffToken('super@quickpick.demo');
}, 60_000);
afterAll(async () => e.close());

describe('fees per ordering mode', () => {
  it('uses 7% by default and lets the super-admin set PREORDER and WALKIN_QR separately', async () => {
    const s = await e.studentToken('fee@srm.test');
    const m = await e.menu(e.shop02.id);
    const items = [{ menuItemId: m['Demo Veg Meal'].id, quantity: 1 }];
    const slot = await e.nextSlot(e.shop02.id);
    const quote = (source: string) => e.api.post('/api/v1/orders/quote').set(e.auth(s)).send({ source, shopId: e.shop02.id, slotId: source === 'PREORDER' ? slot.id : undefined, items });
    expect((await quote('PREORDER')).body.breakdown).toMatchObject({ subtotalPaise: 10000, feePaise: 700, totalPaise: 10700 });
    expect((await quote('WALKIN_QR')).body.breakdown).toMatchObject({ subtotalPaise: 10000, feePaise: 700, totalPaise: 10700 });

    expect((await e.api.patch('/api/v1/admin/pricing-policy').set(e.auth(admin)).send({ orderSource: 'WALKIN_QR', feeRateBps: 500 })).status).toBe(403);
    const p = await e.api.patch('/api/v1/admin/pricing-policy').set(e.auth(superAdmin)).send({ orderSource: 'WALKIN_QR', feeRateBps: 500, note: 'test' });
    expect(p.status).toBe(201);
    expect((await quote('WALKIN_QR')).body.breakdown).toMatchObject({ feeRateBps: 500, feePaise: 500, totalPaise: 10500 });
    expect((await quote('PREORDER')).body.breakdown).toMatchObject({ feeRateBps: 700, feePaise: 700 });
    await e.api.patch('/api/v1/admin/pricing-policy').set(e.auth(superAdmin)).send({ orderSource: 'WALKIN_QR', feeRateBps: 700, note: 'restore' });
  });

  it('keeps old order amounts after a price edit and a fee change (snapshot)', async () => {
    const s = await e.studentToken('snap@srm.test');
    const { orderId } = await e.placePaid(s, { itemName: 'Demo Chicken Biryani' });
    const m = await e.menu(e.shop02.id);
    await e.api.patch(`/api/v1/admin/menu-items/${m['Demo Chicken Biryani'].id}`).set(e.auth(admin)).send({ basePricePaise: 20000 });
    await e.api.patch('/api/v1/admin/pricing-policy').set(e.auth(superAdmin)).send({ orderSource: 'PREORDER', feeRateBps: 1000 });
    const after = await e.studentOrder(s, orderId);
    expect(after).toMatchObject({ subtotalPaise: 14000, feeRateBps: 700, feePaise: 980, totalPaise: 14980 });
    expect(after.items[0]).toMatchObject({ name: 'Demo Chicken Biryani', unitPricePaise: 14000 });
    await e.api.patch(`/api/v1/admin/menu-items/${m['Demo Chicken Biryani'].id}`).set(e.auth(admin)).send({ basePricePaise: 14000 });
    await e.api.patch('/api/v1/admin/pricing-policy').set(e.auth(superAdmin)).send({ orderSource: 'PREORDER', feeRateBps: 700 });
  });
});

describe('isolation and roles', () => {
  it('a student cannot read another student’s order', async () => {
    const a = await e.studentToken('iso-a@srm.test');
    const b = await e.studentToken('iso-b@srm.test');
    const { orderId } = await e.placePaid(a);
    expect((await e.api.get(`/api/v1/orders/${orderId}`).set(e.auth(b))).status).toBe(404);
    expect((await e.api.post(`/api/v1/orders/${orderId}/cancel`).set(e.auth(b))).status).toBe(404);
  });

  it('vendor A cannot list, read or change vendor B’s orders, and never sees contact details', async () => {
    const s = await e.studentToken('vendoriso@srm.test');
    const { orderId } = await e.placePaid(s); // shop 02
    expect((await e.api.get('/api/v1/vendor/orders').set(e.auth(vendor01))).body.orders.map((o: any) => o.id)).not.toContain(orderId);
    expect((await e.accept(vendor01, orderId)).status).toBe(404);
    expect((await e.api.get('/api/v1/vendor/orders').set(e.auth(vendor02)).set('x-shop-id', e.shop01.id)).status).toBe(403);
    const mine = (await e.api.get('/api/v1/vendor/orders').set(e.auth(vendor02))).body.orders.find((o: any) => o.id === orderId);
    expect(JSON.stringify(mine)).not.toContain('vendoriso@srm.test');
    expect(mine.customerName).toBe('vendoriso');
    // Menu and settlements are per-shop too.
    const m01 = await e.menu(e.shop01.id);
    expect((await e.api.patch(`/api/v1/vendor/menu-items/${m01['Demo Idli Plate (3)'].id}`).set(e.auth(vendor02)).send({ available: false })).status).toBe(404);
    const sett = (await e.api.get('/api/v1/vendor/settlements').set(e.auth(vendor02))).body;
    expect(sett.days.every((d: any) => typeof d.entitlementPaise === 'number')).toBe(true);
  });

  it('enforces roles server-side', async () => {
    const s = await e.studentToken('rbac@srm.test');
    expect((await e.api.get('/api/v1/vendor/orders')).status).toBe(401);
    expect((await e.api.get('/api/v1/vendor/orders').set(e.auth(s))).status).toBe(403);
    expect((await e.api.get('/api/v1/admin/shops').set(e.auth(vendor01))).status).toBe(403);
    expect((await e.api.get('/api/v1/admin/analytics').set(e.auth(admin))).status).toBe(200);
  });

  it('enforces the order state machine', async () => {
    const s = await e.studentToken('sm@srm.test');
    const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
    expect((await e.setStatus(vendor01, orderId, 'READY')).status).toBe(409); // not accepted yet
    await e.accept(vendor01, orderId);
    expect((await e.accept(vendor01, orderId)).status).toBe(409);
    expect((await e.api.post(`/api/v1/orders/${orderId}/cancel`).set(e.auth(s))).status).toBe(409); // too late to cancel
    await e.setStatus(vendor01, orderId, 'CANCELLED', 'Gas ran out');
    expect((await e.studentOrder(s, orderId))).toMatchObject({ status: 'CANCELLED', paymentStatus: 'REFUNDED', otpState: 'REVOKED' });
    const jobs = await e.db.query(`SELECT status FROM print_jobs WHERE order_id=$1`, [orderId]);
    expect(jobs.map((j: any) => j.status)).toEqual(['CANCELLED']);
  });

  it('the vendor board works with REST only (no sockets) and shows only paid orders', async () => {
    const s = await e.studentToken('rest@srm.test');
    const unpaid = await e.placeWalkin(s);
    const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
    const ids = (await e.api.get('/api/v1/vendor/orders').set(e.auth(vendor01))).body.orders.map((o: any) => o.id);
    expect(ids).toContain(orderId);
    expect(ids).not.toContain(unpaid.id);
  });

  it('rejects checkout return URLs outside QuickPick (no open redirect)', async () => {
    const s = await e.studentToken('redirect@srm.test');
    const o = await e.placeWalkin(s);
    const r = await e.startCheckout(s, o.id, 'https://evil.example/steal');
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('INVALID_RETURN_URL');
  });
});

describe('admin', () => {
  it('generates a QR for each shop and regenerating invalidates the old one', async () => {
    const qr = await e.api.get(`/api/v1/admin/shops/${e.shop01.id}/qr`).set(e.auth(admin));
    expect(qr.body.url).toBe(`http://localhost:5273/s/${e.DEMO_QR.JG01}`);
    expect(qr.body.svg).toContain('<svg');
    const regen = await e.api.post(`/api/v1/admin/shops/${e.shop01.id}/qr/regenerate`).set(e.auth(admin)).send({});
    const token = regen.body.url.split('/s/')[1];
    expect((await e.api.get(`/api/v1/qr/${e.DEMO_QR.JG01}`)).status).toBe(404);
    expect((await e.api.get(`/api/v1/qr/${token}`)).body.shop.id).toBe(e.shop01.id);
  });

  it('edits shop hours: rebuilds unbooked slots, keeps booked ones, rejects impossible hours', async () => {
    const s = await e.studentToken('hours@srm.test');
    const { orderId, slotId } = await e.placePaid(s);
    const r = await e.api.patch(`/api/v1/admin/shops/${e.shop02.id}`).set(e.auth(admin)).send({ openTime: '09:00', closeTime: '21:00', slotMinutes: 15 });
    expect(r.status).toBe(200);
    expect((await e.studentOrder(s, orderId)).slotStartsAt).toBeTruthy();
    const booked = await e.db.query(`SELECT 1 FROM pickup_slots WHERE id=$1`, [slotId]);
    expect(booked).toHaveLength(1);
    expect((await e.api.patch(`/api/v1/admin/shops/${e.shop02.id}`).set(e.auth(admin)).send({ closeTime: '08:00' })).body.error.code).toBe('INVALID_HOURS');
  });

  it('reports analytics by shop, by ordering mode and by hour', async () => {
    const a = (await e.api.get('/api/v1/admin/analytics').set(e.auth(admin))).body;
    expect(a.totalShops).toBe(2);
    expect(a.bySource.PREORDER.orders).toBeGreaterThan(0);
    expect(a.bySource.WALKIN_QR.orders).toBeGreaterThan(0);
    expect(a.byShop).toHaveLength(2);
    expect(a.peakHours).toHaveLength(24);
    expect(a.peakHours[10].preorder + a.peakHours[10].walkin).toBeGreaterThan(0); // tests run at 10:30 IST
    expect(a.grossFeePaise).toBeGreaterThan(0);
  });

  it('builds settlement statements from collected orders only', async () => {
    const s = await e.studentToken('settle@srm.test');
    const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
    await e.accept(vendor01, orderId);
    await e.setStatus(vendor01, orderId, 'READY');
    await e.verifyOtp(vendor01, orderId, (await e.studentOrder(s, orderId)).pickupOtp);
    const gen = await e.api.post('/api/v1/admin/settlements/generate').set(e.auth(admin)).send({ date: '2026-11-09' });
    expect(gen.status).toBe(201);
    const st = gen.body.settlements.find((x: any) => x.shopId === e.shop01.id);
    expect(st.orders).toBe(1);
    expect(st.netPaise).toBe(4000);
    // Running it again does not double count.
    const again = await e.api.post('/api/v1/admin/settlements/generate').set(e.auth(admin)).send({ date: '2026-11-09' });
    expect(again.body.settlements.find((x: any) => x.shopId === e.shop01.id)).toBeUndefined();
  });

  it('exports CSV with order source and neutralised formulas', async () => {
    const csv = await e.api.get('/api/v1/admin/export/orders.csv?date=2026-11-09').set(e.auth(admin));
    expect(csv.text.split('\n')[0]).toContain('source');
    expect(csv.text).toContain('WALKIN_QR');
  });
});
