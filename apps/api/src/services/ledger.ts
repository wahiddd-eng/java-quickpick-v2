import { HttpError, audit, type AppContext, type Tx } from '../context.js';
import type { Queryable } from '../db.js';
import { queueOrderNotification } from './notifications.js';

export interface Actor {
  type: 'STUDENT' | 'VENDOR' | 'ADMIN' | 'SYSTEM' | 'WEBHOOK';
  id?: string;
  role?: string;
}

/** Planned vendor/platform/tax split for a paid order. Settlement is tracked separately from payment success. */
export async function planSplits(q: Queryable, order: any, paymentId: string) {
  const [shop] = await q.query(`SELECT vendor_id FROM shops WHERE id=$1`, [order.shop_id]);
  const parts: Array<[string, number]> = [
    ['VENDOR', Number(order.subtotal_paise)],
    ['PLATFORM', Number(order.fee_paise)],
  ];
  if (order.tax_mode === 'EXCLUSIVE' && Number(order.tax_paise) > 0) parts.push(['TAX', Number(order.tax_paise)]);
  for (const [type, amount] of parts) {
    await q.query(
      `INSERT INTO payment_splits (order_id, payment_id, beneficiary_type, shop_id, vendor_id, amount_paise)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (order_id, beneficiary_type) DO NOTHING`,
      [order.id, paymentId, type, type === 'VENDOR' ? order.shop_id : null, type === 'VENDOR' ? (shop?.vendor_id ?? null) : null, amount],
    );
  }
}

/**
 * Create a refund exactly once per idempotency key. The provider call is made inside the DB transaction for the mock
 * provider; a real provider adapter should use an outbox so a failed network call never leaves a ledger gap.
 */
export async function initiateRefund(
  ctx: AppContext,
  tx: Tx,
  input: { orderId: string; amountPaise?: number; reason: string; idempotencyKey: string; actor: Actor },
) {
  const existing = await tx.q.query(`SELECT * FROM refunds WHERE idempotency_key=$1`, [input.idempotencyKey]);
  if (existing[0]) return existing[0];

  const payments = await tx.q.query(`SELECT * FROM payments WHERE order_id=$1 FOR UPDATE`, [input.orderId]);
  const payment = payments[0];
  if (!payment || !['SUCCEEDED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUND_FAILED'].includes(payment.status)) {
    throw new HttpError(409, 'NOTHING_TO_REFUND', 'This order has no successful payment to refund');
  }
  const [{ used }] = await tx.q.query<{ used: number }>(
    `SELECT COALESCE(SUM(amount_paise),0)::bigint AS used FROM refunds WHERE payment_id=$1 AND status <> 'FAILED'`,
    [payment.id],
  );
  const remaining = Number(payment.amount_paise) - Number(used);
  const amount = input.amountPaise ?? remaining;
  if (!Number.isInteger(amount) || amount <= 0) throw new HttpError(422, 'INVALID_REFUND', 'Refund amount must be a positive whole number of paise');
  if (amount > remaining) throw new HttpError(422, 'REFUND_EXCEEDS_PAYMENT', 'Refund exceeds the remaining refundable amount');

  const provider = await ctx.provider.createRefund({
    providerPaymentRef: payment.provider_ref,
    amountPaise: amount,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
  });
  const inserted = await tx.q.query(
    `INSERT INTO refunds (payment_id, order_id, amount_paise, reason, status, provider_ref, idempotency_key, created_at)
     VALUES ($1,$2,$3,$4,'PENDING',$5,$6,$7) RETURNING *`,
    [payment.id, input.orderId, amount, input.reason, provider.providerRef, input.idempotencyKey, ctx.now()],
  );
  await tx.q.query(`UPDATE payments SET status='REFUND_PENDING', updated_at=now() WHERE id=$1`, [payment.id]);
  await tx.q.query(`UPDATE orders SET payment_status='REFUND_PENDING', updated_at=now() WHERE id=$1`, [input.orderId]);
  await audit(tx.q, { id: input.actor.id, role: input.actor.role ?? input.actor.type }, 'REFUND_INITIATED', 'order', input.orderId, {
    amountPaise: amount,
    reason: input.reason,
  });
  await queueOrderNotification(ctx, tx, await orderRef(tx.q, input.orderId), 'REFUND_INITIATED', { amountPaise: amount, dedupe: inserted[0].id });
  if (ctx.sandboxDeliver) {
    const deliver = ctx.sandboxDeliver;
    const type = ctx.provider.sandboxRefundOutcome?.(provider.providerRef) ?? 'refund.processed';
    tx.post.push(() => deliver({ type, providerRef: provider.providerRef, amountPaise: amount, reason: type === 'refund.failed' ? 'Sandbox: bank rejected the refund' : undefined }));
  }
  return inserted[0];
}

async function orderRef(q: Queryable, orderId: string) {
  const [o] = await q.query(`SELECT o.id, o.user_id, o.order_number, s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=$1`, [orderId]);
  return o;
}

/** Refund rejected by the provider/bank: flag it for a person, keep the money trail, tell the student. Idempotent. */
export async function applyRefundFailed(ctx: AppContext, tx: Tx, refundRef: string, reason?: string): Promise<{ result: string; orderId?: string }> {
  const [refund] = await tx.q.query(`SELECT * FROM refunds WHERE provider_ref=$1 FOR UPDATE`, [refundRef]);
  if (!refund) return { result: 'unknown_refund' };
  if (refund.status !== 'PENDING') return { result: `noop_refund_${refund.status.toLowerCase()}`, orderId: refund.order_id };
  await tx.q.query(`UPDATE refunds SET status='FAILED', failure_reason=$2, processed_at=$3 WHERE id=$1`, [refund.id, reason ?? 'Refund failed', ctx.now()]);
  await tx.q.query(`UPDATE payments SET status='REFUND_FAILED', updated_at=now() WHERE id=$1`, [refund.payment_id]);
  await tx.q.query(`UPDATE orders SET payment_status='REFUND_FAILED', updated_at=now() WHERE id=$1`, [refund.order_id]);
  await tx.q.query(
    `INSERT INTO reconciliation_records (kind, reference, order_id, expected_status, provider_status, expected_paise, action, status, notes)
     VALUES ('REFUND',$1,$2,'PROCESSED','FAILED',$3,'MANUAL_REFUND_REQUIRED','OPEN',$4)`,
    [refundRef, refund.order_id, Number(refund.amount_paise), reason ?? ''],
  );
  await audit(tx.q, { role: 'WEBHOOK' }, 'REFUND_FAILED', 'order', refund.order_id, { refundId: refund.id, reason });
  await queueOrderNotification(ctx, tx, await orderRef(tx.q, refund.order_id), 'REFUND_FAILED', { dedupe: refund.id });
  ctx.log.warn('refund_failed', { orderId: refund.order_id, refundId: refund.id });
  return { result: 'refund_failed', orderId: refund.order_id };
}

/** Idempotent: a refund already PROCESSED is a no-op. */
export async function applyRefundProcessed(ctx: AppContext, tx: Tx, refundRef: string): Promise<{ result: string; orderId?: string }> {
  const rows = await tx.q.query(`SELECT * FROM refunds WHERE provider_ref=$1 FOR UPDATE`, [refundRef]);
  const refund = rows[0];
  if (!refund) return { result: 'unknown_refund' };
  if (refund.status !== 'PENDING') return { result: `noop_refund_${refund.status.toLowerCase()}`, orderId: refund.order_id };
  await tx.q.query(`UPDATE refunds SET status='PROCESSED', processed_at=now() WHERE id=$1`, [refund.id]);
  const [payment] = await tx.q.query(`SELECT * FROM payments WHERE id=$1 FOR UPDATE`, [refund.payment_id]);
  const [{ done }] = await tx.q.query<{ done: number }>(
    `SELECT COALESCE(SUM(amount_paise),0)::bigint AS done FROM refunds WHERE payment_id=$1 AND status='PROCESSED'`,
    [payment.id],
  );
  const full = Number(done) >= Number(payment.amount_paise);
  const status = full ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  await tx.q.query(`UPDATE payments SET status=$2, updated_at=now() WHERE id=$1`, [payment.id, status]);
  await tx.q.query(`UPDATE orders SET payment_status=$2, updated_at=now() WHERE id=$1`, [refund.order_id, status]);
  if (full) await tx.q.query(`UPDATE payment_splits SET status='REVERSED' WHERE order_id=$1 AND status='PLANNED'`, [refund.order_id]);
  await queueOrderNotification(ctx, tx, await orderRef(tx.q, refund.order_id), 'REFUND_COMPLETED', { amountPaise: Number(refund.amount_paise), dedupe: refund.id });
  return { result: 'refund_processed', orderId: refund.order_id };
}
