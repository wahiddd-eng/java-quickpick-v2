import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptPickupOtp, encryptPickupOtp, hashPickupOtp } from '../src/services/otp.js';
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

async function readyOrder(email: string) {
  const s = await e.studentToken(email);
  const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
  await e.accept(vendor01, orderId);
  await e.setStatus(vendor01, orderId, 'READY');
  const otp = (await e.studentOrder(s, orderId)).pickupOtp as string;
  return { s, orderId, otp };
}
const wrong = (otp: string) => String((Number(otp) + 1) % 1_000_000).padStart(6, '0');

describe('pickup OTP', () => {
  it('is bound to its order (hash and ciphertext) and never stored in clear', () => {
    const orderA = '11111111-1111-4111-8111-111111111111';
    const orderB = '22222222-2222-4222-8222-222222222222';
    expect(hashPickupOtp('k', orderA, '123456')).not.toBe(hashPickupOtp('k', orderB, '123456'));
    const blob = encryptPickupOtp('k', orderA, '123456');
    expect(blob).not.toContain('123456');
    expect(decryptPickupOtp('k', orderA, blob)).toBe('123456');
    expect(() => decryptPickupOtp('k', orderB, blob)).toThrow(); // AAD mismatch
  });

  it('is hidden until READY, then shown only to the owning student', async () => {
    const s = await e.studentToken('reveal@srm.test');
    const other = await e.studentToken('reveal-other@srm.test');
    const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
    await e.accept(vendor01, orderId);
    const accepted = await e.studentOrder(s, orderId);
    expect(accepted.otpState).toBe('ACTIVE');
    expect(accepted.pickupOtp).toBeUndefined();
    await e.setStatus(vendor01, orderId, 'READY');
    expect((await e.studentOrder(s, orderId)).pickupOtp).toMatch(/^\d{6}$/);
    expect((await e.api.get(`/api/v1/orders/${orderId}`).set(e.auth(other))).status).toBe(404);
    const list = (await e.api.get('/api/v1/me/orders').set(e.auth(s))).body.orders;
    expect(list.find((o: any) => o.id === orderId).pickupOtp).toBeUndefined();
  });

  it('invalid OTP: counted, logged and reports attempts left', async () => {
    const { orderId, otp } = await readyOrder('invalid@srm.test');
    const r = await e.verifyOtp(vendor01, orderId, wrong(otp));
    expect(r.status).toBe(422);
    expect(r.body.error).toMatchObject({ code: 'INVALID_OTP', details: { attemptsLeft: 4 } });
    expect((await e.verifyOtp(vendor01, orderId, 'abc')).status).toBe(400);
    const log = await e.db.query(`SELECT outcome FROM pickup_otp_attempts WHERE order_id=$1`, [orderId]);
    expect(log.map((l: any) => l.outcome)).toEqual(['MISMATCH']);
    expect((await e.verifyOtp(vendor01, orderId, otp)).body.order.status).toBe('COLLECTED');
  });

  it('locks after 5 wrong codes; the right code no longer works; an audited override hands over', async () => {
    const { orderId, otp } = await readyOrder('lock@srm.test');
    for (let i = 0; i < 5; i++) await e.verifyOtp(vendor01, orderId, wrong(otp));
    const locked = await e.verifyOtp(vendor01, orderId, otp);
    expect(locked.status).toBe(423);
    expect(locked.body.error.code).toBe('OTP_LOCKED');
    const short = await e.api.post(`/api/v1/vendor/orders/${orderId}/collect-override`).set(e.auth(vendor01)).send({ reason: 'ok' });
    expect(short.status).toBe(400);
    const ov = await e.api.post(`/api/v1/vendor/orders/${orderId}/collect-override`).set(e.auth(vendor01)).send({ reason: 'Phone died; checked college ID and order number' });
    expect(ov.body.order).toMatchObject({ status: 'COLLECTED', collectedVia: 'MANUAL_OVERRIDE' });
    const overrides = (await e.api.get('/api/v1/admin/pickup-overrides').set(e.auth(admin))).body.overrides;
    expect(overrides[0]).toMatchObject({ reason: 'Phone died; checked college ID and order number', shopName: 'Demo Shop 01' });
    const audit = await e.db.query(`SELECT 1 FROM audit_logs WHERE action='PICKUP_MANUAL_OVERRIDE' AND entity_id=$1`, [orderId]);
    expect(audit).toHaveLength(1);
  });

  it('expires after the collection window', async () => {
    const { s, orderId, otp } = await readyOrder('expire@srm.test');
    e.advance(121 * 60_000);
    expect((await e.studentOrder(s, orderId))).toMatchObject({ otpState: 'EXPIRED' });
    expect((await e.studentOrder(s, orderId)).pickupOtp).toBeUndefined();
    const r = await e.verifyOtp(vendor01, orderId, otp);
    expect(r.status).toBe(410);
    expect(r.body.error.code).toBe('OTP_EXPIRED');
    e.advance(-121 * 60_000);
    expect((await e.setStatus(vendor01, orderId, 'NOT_COLLECTED')).body.order.status).toBe('NOT_COLLECTED');
  });

  it('cannot be replayed', async () => {
    const { orderId, otp } = await readyOrder('replay@srm.test');
    expect((await e.verifyOtp(vendor01, orderId, otp)).status).toBe(200);
    const again = await e.verifyOtp(vendor01, orderId, otp);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('OTP_ALREADY_USED');
    const log = (await e.db.query(`SELECT outcome FROM pickup_otp_attempts WHERE order_id=$1 ORDER BY id`, [orderId])).map((l: any) => l.outcome);
    expect(log).toEqual(['SUCCESS', 'ALREADY_USED']);
  });

  it('cannot be verified before READY, by another shop, or used to skip OTP via the status endpoint', async () => {
    const s = await e.studentToken('early@srm.test');
    const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
    await e.accept(vendor01, orderId);
    expect((await e.verifyOtp(vendor01, orderId, '123456')).body.error.code).toBe('ORDER_NOT_READY');
    await e.setStatus(vendor01, orderId, 'READY');
    const otp = (await e.studentOrder(s, orderId)).pickupOtp;
    expect((await e.verifyOtp(vendor02, orderId, otp)).status).toBe(404);
    expect((await e.setStatus(vendor01, orderId, 'COLLECTED')).status).toBe(400);
  });

  it('a student device that was offline sees the same state on reconnect (REST is the source of truth)', async () => {
    const { s, orderId, otp } = await readyOrder('offline@srm.test');
    // No sockets in this test at all: the student simply refetches.
    const again = await e.studentOrder(s, orderId);
    expect(again).toMatchObject({ status: 'READY', pickupOtp: otp });
  });
});
