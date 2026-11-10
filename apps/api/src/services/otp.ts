import crypto from 'node:crypto';
import type { OtpState } from '@qp2/shared';
import { HttpError, audit, withTx, type AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import type { Actor } from './ledger.js';
import { transitionOrder } from './orders.js';

/**
 * Pickup (collection) OTP.
 *  - 6 random digits from a CSPRNG, one per order, created when the shop ACCEPTS.
 *  - Stored as an HMAC-SHA256 hash bound to the order id (verification) plus an AES-256-GCM ciphertext bound to the
 *    order id (so the server can show it to the owning student). Neither is ever sent to the vendor or printed.
 *  - Shown to the student only once the order is READY; valid for COLLECTION_WINDOW_MINUTES from then.
 *  - Verified on the server with a per-order attempt limit; locked after too many misses; single use.
 *  - Every verification (success or failure) and every manual override is logged.
 */

const subkey = (secret: string, purpose: string) => crypto.createHash('sha256').update(`${purpose}:${secret}`).digest();

export function hashPickupOtp(secret: string, orderId: string, otp: string): string {
  return crypto.createHmac('sha256', subkey(secret, 'pickup-otp-hash')).update(`${orderId}:${otp}`).digest('hex');
}

export function encryptPickupOtp(secret: string, orderId: string, otp: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', subkey(secret, 'pickup-otp-enc'), iv);
  cipher.setAAD(Buffer.from(orderId));
  const ct = Buffer.concat([cipher.update(otp, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ct].map((b) => b.toString('base64')).join('.');
}

export function decryptPickupOtp(secret: string, orderId: string, blob: string): string {
  const [iv, tag, ct] = blob.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', subkey(secret, 'pickup-otp-enc'), iv);
  decipher.setAAD(Buffer.from(orderId));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export const generatePickupOtp = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

export async function issuePickupOtp(ctx: AppContext, q: Queryable, orderId: string): Promise<void> {
  const otp = generatePickupOtp();
  await q.query(
    `INSERT INTO pickup_otps (order_id, otp_hash, otp_ciphertext, max_attempts) VALUES ($1,$2,$3,$4) ON CONFLICT (order_id) DO NOTHING`,
    [orderId, hashPickupOtp(ctx.config.pickupOtpSecret, orderId, otp), encryptPickupOtp(ctx.config.pickupOtpSecret, orderId, otp), ctx.config.pickupOtpMaxAttempts],
  );
}

/** Start the collection window when the order becomes READY. */
export async function activateOtpWindow(ctx: AppContext, q: Queryable, orderId: string): Promise<void> {
  const expires = new Date(ctx.now().getTime() + ctx.config.collectionWindowMinutes * 60_000);
  await q.query(`UPDATE pickup_otps SET expires_at=$2 WHERE order_id=$1 AND status='ACTIVE'`, [orderId, expires]);
}

/** For the owning student only (caller must have checked ownership). Returns the code only while READY and valid. */
export async function revealOtpForStudent(ctx: AppContext, q: Queryable, order: { id: string; status: string }): Promise<{ otpState: OtpState; pickupOtp?: string; otpExpiresAt?: string | null }> {
  const [p] = await q.query(`SELECT * FROM pickup_otps WHERE order_id=$1`, [order.id]);
  if (!p) return { otpState: 'NONE' };
  let state = p.status as OtpState;
  if (state === 'ACTIVE' && p.expires_at && new Date(p.expires_at) < ctx.now()) state = 'EXPIRED';
  if (order.status !== 'READY' || state !== 'ACTIVE') return { otpState: state };
  if (!p.revealed_at) await q.query(`UPDATE pickup_otps SET revealed_at=$2 WHERE id=$1 AND revealed_at IS NULL`, [p.id, ctx.now()]);
  return {
    otpState: state,
    pickupOtp: decryptPickupOtp(ctx.config.pickupOtpSecret, order.id, p.otp_ciphertext),
    otpExpiresAt: p.expires_at ? new Date(p.expires_at).toISOString() : null,
  };
}

type VerifyResult = { ok: true } | { ok: false; status: number; code: string; message: string; attemptsLeft?: number };

/**
 * Vendor-side verification. Failure bookkeeping (attempt count, lock, log) is COMMITTED before the error is returned,
 * so a wrong code always counts even though the request fails.
 */
export async function verifyPickupOtp(ctx: AppContext, input: { orderId: string; shopId: string; otp: string; actor: Actor }): Promise<void> {
  const result = await withTx<VerifyResult>(ctx, async (tx) => {
    const [o] = await tx.q.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [input.orderId]);
    if (!o || o.shop_id !== input.shopId) return { ok: false, status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' };
    const log = (outcome: string, note?: string) =>
      tx.q.query(`INSERT INTO pickup_otp_attempts (order_id, actor_id, outcome, note) VALUES ($1,$2,$3,$4)`, [o.id, input.actor.id ?? null, outcome, note ?? null]);
    const [p] = await tx.q.query(`SELECT * FROM pickup_otps WHERE order_id=$1 FOR UPDATE`, [o.id]);

    if (o.status === 'COLLECTED' || p?.status === 'USED') {
      await log('ALREADY_USED');
      return { ok: false, status: 409, code: 'OTP_ALREADY_USED', message: 'This order has already been collected' };
    }
    if (o.status !== 'READY' || !p) {
      await log('NOT_READY');
      return { ok: false, status: 409, code: 'ORDER_NOT_READY', message: 'Mark the order ready before handing it over' };
    }
    if (p.status === 'LOCKED' || p.failed_attempts >= p.max_attempts) {
      await log('LOCKED');
      return { ok: false, status: 423, code: 'OTP_LOCKED', message: 'Too many wrong codes. Use manual handover with a reason, or contact QuickPick support.' };
    }
    if (p.status !== 'ACTIVE' || (p.expires_at && new Date(p.expires_at) < ctx.now())) {
      if (p.status === 'ACTIVE') await tx.q.query(`UPDATE pickup_otps SET status='EXPIRED' WHERE id=$1`, [p.id]);
      await log('EXPIRED');
      return { ok: false, status: 410, code: 'OTP_EXPIRED', message: 'This collection code has expired. Use manual handover with a reason if the student is here.' };
    }
    const given = Buffer.from(hashPickupOtp(ctx.config.pickupOtpSecret, o.id, input.otp), 'hex');
    const stored = Buffer.from(p.otp_hash, 'hex');
    if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
      const failed = p.failed_attempts + 1;
      const locked = failed >= p.max_attempts;
      await tx.q.query(`UPDATE pickup_otps SET failed_attempts=$2, status=$3 WHERE id=$1`, [p.id, failed, locked ? 'LOCKED' : 'ACTIVE']);
      await log('MISMATCH', `attempt ${failed}/${p.max_attempts}`);
      return locked
        ? { ok: false, status: 423, code: 'OTP_LOCKED', message: 'Too many wrong codes. Use manual handover with a reason, or contact QuickPick support.', attemptsLeft: 0 }
        : { ok: false, status: 422, code: 'INVALID_OTP', message: 'That code does not match this order', attemptsLeft: p.max_attempts - failed };
    }
    await tx.q.query(`UPDATE pickup_otps SET status='USED', used_at=$2 WHERE id=$1`, [p.id, ctx.now()]);
    await log('SUCCESS');
    await transitionOrder(ctx, tx, o.id, 'COLLECTED', input.actor, { scope: { shopId: input.shopId }, collectedVia: 'OTP', reason: 'Collection code verified' });
    return { ok: true };
  });
  if (!result.ok) throw new HttpError(result.status, result.code, result.message, result.attemptsLeft !== undefined ? { attemptsLeft: result.attemptsLeft } : undefined);
}

/** Audited exception path (student's phone died, code locked/expired but identity checked in person). */
export async function overrideCollection(ctx: AppContext, input: { orderId: string; shopId?: string; reason: string; actor: Actor }): Promise<void> {
  await withTx(ctx, async (tx) => {
    const [o] = await tx.q.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [input.orderId]);
    if (!o || (input.shopId && o.shop_id !== input.shopId)) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (o.status !== 'READY') throw new HttpError(409, 'ORDER_NOT_READY', 'Only a READY order can be handed over');
    await tx.q.query(`UPDATE pickup_otps SET status='REVOKED' WHERE order_id=$1 AND status <> 'USED'`, [o.id]);
    await tx.q.query(`INSERT INTO pickup_otp_attempts (order_id, actor_id, outcome, note) VALUES ($1,$2,'OVERRIDE',$3)`, [o.id, input.actor.id ?? null, input.reason]);
    await audit(tx.q, { id: input.actor.id, role: input.actor.role ?? input.actor.type }, 'PICKUP_MANUAL_OVERRIDE', 'order', o.id, { reason: input.reason });
    await transitionOrder(ctx, tx, o.id, 'COLLECTED', input.actor, { collectedVia: 'MANUAL_OVERRIDE', reason: `Manual handover: ${input.reason}` });
  });
}
