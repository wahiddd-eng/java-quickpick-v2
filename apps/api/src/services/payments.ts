import crypto from 'node:crypto';
import { HttpError, withTx, type AppContext, type Tx } from '../context.js';
import { WebhookSignatureError, type VerifiedWebhookEvent } from '../payments/provider.js';
import { applyRefundFailed, applyRefundProcessed, initiateRefund, planSplits } from './ledger.js';
import { queueOrderNotification } from './notifications.js';
import { estimateWalkinMinutes } from './shops.js';
import { releaseSlot } from './slots.js';

const MAX_ATTEMPTS = 5;

function assertReturnUrl(ctx: AppContext, returnUrl: string) {
  let origin: string;
  try {
    origin = new URL(returnUrl).origin;
  } catch {
    throw new HttpError(400, 'INVALID_RETURN_URL', 'Invalid return URL');
  }
  const allowed = new Set([new URL(ctx.config.studentAppUrl).origin, ...ctx.config.corsOrigins]);
  if (!allowed.has(origin)) throw new HttpError(400, 'INVALID_RETURN_URL', 'Return URL is not an allowed QuickPick address');
}

/**
 * Open a hosted checkout session. The provider order is created once per QuickPick order (idempotency key
 * `checkout:<orderId>`); each call after a failure opens a new attempt. The browser's return from the hosted page is
 * NEVER treated as payment — only a verified webhook (or reconciliation against the provider) marks an order paid.
 */
export async function createCheckout(ctx: AppContext, userId: string, orderId: string, returnUrl: string) {
  assertReturnUrl(ctx, returnUrl);
  return withTx(ctx, async (tx) => {
    const [order] = await tx.q.query(`SELECT * FROM orders WHERE id=$1 AND user_id=$2 FOR UPDATE`, [orderId, userId]);
    if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (order.status !== 'PENDING_PAYMENT') throw new HttpError(409, 'ORDER_NOT_PAYABLE', 'This order is no longer awaiting payment');
    if (new Date(order.expires_at) < ctx.now()) throw new HttpError(409, 'CHECKOUT_EXPIRED', 'This checkout has expired. Please start again.');

    let [payment] = await tx.q.query(`SELECT * FROM payments WHERE order_id=$1 FOR UPDATE`, [orderId]);
    if (payment?.status === 'SUCCEEDED') throw new HttpError(409, 'ALREADY_PAID', 'This order is already paid');
    const [{ n }] = await tx.q.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM payment_attempts WHERE order_id=$1`, [orderId]);
    if (Number(n) >= MAX_ATTEMPTS) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'Too many payment attempts for this order. Please start a new order.');

    const session = await ctx.provider.createCheckout({
      orderId,
      orderNumber: order.order_number,
      amountPaise: Number(order.total_paise),
      currency: 'INR',
      idempotencyKey: `checkout:${orderId}`,
      attemptNo: Number(n) + 1,
      returnUrl,
    });
    if (!payment) {
      [payment] = await tx.q.query(
        `INSERT INTO payments (order_id, provider, provider_ref, amount_paise, currency, status, idempotency_key) VALUES ($1,$2,$3,$4,'INR','INITIATED',$5) RETURNING *`,
        [orderId, ctx.provider.name, session.providerRef, Number(order.total_paise), `checkout:${orderId}`],
      );
    } else {
      await tx.q.query(`UPDATE payments SET status='INITIATED', updated_at=now() WHERE id=$1`, [payment.id]);
    }
    await tx.q.query(`UPDATE payment_attempts SET status='ABANDONED', updated_at=now() WHERE payment_id=$1 AND status='CREATED'`, [payment.id]);
    await tx.q.query(
      `INSERT INTO payment_attempts (payment_id, order_id, attempt_no, session_ref, checkout_url, return_url) VALUES ($1,$2,$3,$4,$5,$6)`,
      [payment.id, orderId, Number(n) + 1, session.sessionRef, session.checkoutUrl, returnUrl],
    );
    await tx.q.query(`UPDATE orders SET payment_status='INITIATED', updated_at=now() WHERE id=$1`, [orderId]);
    return { checkoutUrl: session.checkoutUrl, sessionRef: session.sessionRef, attemptNo: Number(n) + 1, amountPaise: Number(order.total_paise), sandbox: true as const };
  });
}

export type WebhookOutcome = { status: 'processed' | 'duplicate'; result?: string };

/**
 * Verified webhook processing:
 *  1. verify the signature over the RAW body (throws -> 401),
 *  2. insert the external event id (UNIQUE) — a duplicate delivery is a safe no-op,
 *  3. apply the change in the SAME transaction, validating provider reference, amount, currency and order id,
 *  4. signal only AFTER commit.
 */
export async function processWebhook(ctx: AppContext, rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<WebhookOutcome> {
  let event: VerifiedWebhookEvent;
  try {
    event = await ctx.provider.verifyWebhook({ rawBody, headers });
  } catch (e) {
    if (e instanceof WebhookSignatureError) throw new HttpError(401, 'INVALID_SIGNATURE', 'Invalid webhook signature');
    throw e;
  }
  return recordAndApply(ctx, event);
}

async function recordAndApply(ctx: AppContext, event: VerifiedWebhookEvent): Promise<WebhookOutcome> {
  return withTx(ctx, async (tx) => {
    const inserted = await tx.q.query(
      `INSERT INTO webhook_events (provider, external_event_id, event_type, payload) VALUES ($1,$2,$3,$4::jsonb)
       ON CONFLICT (provider, external_event_id) DO NOTHING RETURNING id`,
      [ctx.provider.name, event.externalId, event.type, JSON.stringify(event.raw)],
    );
    if (!inserted[0]) return { status: 'duplicate' as const };
    const result = await applyEvent(ctx, tx, event);
    await tx.q.query(`UPDATE webhook_events SET processed_at=now(), result=$2 WHERE id=$1`, [inserted[0].id, result]);
    ctx.log.info('payment_event', { type: event.type, result, providerRef: event.providerRef });
    return { status: 'processed' as const, result };
  });
}

async function applyEvent(ctx: AppContext, tx: Tx, event: VerifiedWebhookEvent): Promise<string> {
  if (event.type === 'refund.processed') {
    const r = await applyRefundProcessed(ctx, tx, event.providerRef);
    if (r.orderId) await signalOrder(ctx, tx, r.orderId, false);
    return r.result;
  }
  if (event.type === 'refund.failed') {
    const r = await applyRefundFailed(ctx, tx, event.providerRef, event.reason);
    if (r.orderId) await signalOrder(ctx, tx, r.orderId, false);
    return r.result;
  }

  const rows = await tx.q.query(
    `SELECT p.id AS payment_id, p.status AS payment_row_status, p.amount_paise AS payment_amount, p.currency AS payment_currency, o.*, s.name AS shop_name
       FROM payments p JOIN orders o ON o.id = p.order_id JOIN shops s ON s.id = o.shop_id
      WHERE p.provider_ref=$1 FOR UPDATE OF p, o`,
    [event.providerRef],
  );
  const row = rows[0];
  if (!row) return 'unknown_payment';
  // Never trust an event until amount, currency and order id match what we asked the provider to collect.
  if (event.amountPaise !== undefined && event.amountPaise !== Number(row.payment_amount)) return 'amount_mismatch_ignored';
  if (event.currency !== undefined && event.currency !== row.payment_currency) return 'currency_mismatch_ignored';
  if (event.orderId !== undefined && event.orderId !== row.id) return 'order_mismatch_ignored';
  const now = ctx.now();

  if (event.type === 'payment.succeeded') {
    if (['SUCCEEDED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_FAILED'].includes(row.payment_row_status)) return 'noop_already_succeeded';
    await tx.q.query(`UPDATE payments SET status='SUCCEEDED', updated_at=now() WHERE id=$1`, [row.payment_id]);
    await tx.q.query(
      `UPDATE payment_attempts SET status='SUCCEEDED', updated_at=now() WHERE id = (SELECT id FROM payment_attempts WHERE payment_id=$1 ORDER BY attempt_no DESC LIMIT 1)`,
      [row.payment_id],
    );

    if (row.status === 'PENDING_PAYMENT') {
      const [shop] = await tx.q.query(`SELECT * FROM shops WHERE id=$1`, [row.shop_id]);
      const deadline = new Date(now.getTime() + shop.accept_timeout_seconds * 1000);
      // Walk-in estimate is refreshed now that the order actually joins the queue.
      const estimate = row.order_source === 'WALKIN_QR' ? await estimateWalkinMinutes(ctx, tx.q, shop) : null;
      await tx.q.query(
        `UPDATE orders SET status='AWAITING_VENDOR', payment_status='SUCCEEDED', accept_deadline=$2, estimated_ready_at=COALESCE($3, estimated_ready_at), updated_at=now() WHERE id=$1`,
        [row.id, deadline, estimate ? new Date(now.getTime() + estimate.minutes * 60_000) : null],
      );
      await tx.q.query(
        `INSERT INTO order_events (order_id, from_status, to_status, actor_type, reason) VALUES ($1,'PENDING_PAYMENT','AWAITING_VENDOR','WEBHOOK','Payment verified')`,
        [row.id],
      );
      await planSplits(tx.q, row, row.payment_id);
      await queueOrderNotification(ctx, tx, row, 'PAYMENT_SUCCEEDED');
      await signalOrder(ctx, tx, row.id, true);
      return 'payment_succeeded';
    }

    // Late success: the order was already cancelled/expired. Money was taken, so refund it.
    await tx.q.query(`UPDATE orders SET payment_status='SUCCEEDED', updated_at=now() WHERE id=$1`, [row.id]);
    await releaseSlot(tx.q, row.id);
    await initiateRefund(ctx, tx, { orderId: row.id, reason: 'Payment received after the order was closed', idempotencyKey: `auto:${row.id}`, actor: { type: 'WEBHOOK' } });
    await signalOrder(ctx, tx, row.id, false);
    return 'late_success_refunded';
  }

  // payment.failed — the order stays open for another attempt until the checkout expires. The vendor never sees it.
  if (['SUCCEEDED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'REFUND_FAILED'].includes(row.payment_row_status)) return 'ignored_failure_after_success';
  if (row.payment_row_status === 'FAILED') return 'noop_already_failed';
  await tx.q.query(`UPDATE payments SET status='FAILED', updated_at=now() WHERE id=$1`, [row.payment_id]);
  await tx.q.query(
    `UPDATE payment_attempts SET status='FAILED', error=$2, updated_at=now() WHERE id = (SELECT id FROM payment_attempts WHERE payment_id=$1 ORDER BY attempt_no DESC LIMIT 1)`,
    [row.payment_id, event.reason ?? 'Payment failed'],
  );
  await tx.q.query(`UPDATE orders SET payment_status='FAILED', updated_at=now() WHERE id=$1`, [row.id]);
  if (row.status === 'PENDING_PAYMENT') await queueOrderNotification(ctx, tx, row, 'PAYMENT_FAILED', { dedupe: event.externalId });
  await signalOrder(ctx, tx, row.id, false);
  return 'payment_failed';
}

async function signalOrder(ctx: AppContext, tx: Tx, orderId: string, isNew: boolean) {
  const [o] = await tx.q.query(`SELECT * FROM orders WHERE id=$1`, [orderId]);
  tx.post.push(() =>
    ctx.bus.emitOrder({
      orderId,
      shopId: o.shop_id,
      userId: o.user_id,
      status: o.status,
      paymentStatus: o.payment_status,
      notifyVendor: ['SUCCEEDED', 'REFUND_PENDING', 'REFUNDED', 'REFUND_FAILED'].includes(o.payment_status) && o.status !== 'PENDING_PAYMENT',
      kind: isNew ? 'NEW_ORDER' : 'UPDATE',
    }),
  );
}

/**
 * Pull-based safety net for lost webhooks and closed browsers: ask the provider about payments still open on our side
 * and apply what it reports through the SAME idempotent path (synthetic event id per payment+status). Every correction
 * is recorded in reconciliation_records.
 */
export async function reconcilePayments(ctx: AppContext, opts: { olderThanSeconds?: number } = {}): Promise<number> {
  const cutoff = new Date(ctx.now().getTime() - (opts.olderThanSeconds ?? 60) * 1000);
  const open = await ctx.db.query(
    `SELECT p.*, o.status AS order_status FROM payments p JOIN orders o ON o.id=p.order_id
      WHERE p.status IN ('INITIATED','PENDING') AND p.updated_at < $1 AND p.created_at > $2`,
    [cutoff, new Date(ctx.now().getTime() - 48 * 3600_000)],
  );
  let fixed = 0;
  for (const p of open) {
    const status = await ctx.provider.getPaymentStatus(p.provider_ref);
    if (status === 'PENDING') continue;
    const type = status === 'SUCCEEDED' ? 'payment.succeeded' : 'payment.failed';
    const out = await recordAndApply(ctx, {
      externalId: `reconcile:${p.provider_ref}:${status}`,
      type,
      providerRef: p.provider_ref,
      amountPaise: Number(p.amount_paise),
      raw: { source: 'reconciliation', status },
    });
    if (out.status === 'processed') {
      fixed++;
      await ctx.db.query(
        `INSERT INTO reconciliation_records (kind, reference, order_id, expected_status, provider_status, expected_paise, actual_paise, action, status, notes)
         VALUES ('PAYMENT',$1,$2,$3,$4,$5,$5,$6,'AUTO_RESOLVED','No webhook received; applied provider status')`,
        [p.provider_ref, p.order_id, p.status, status, Number(p.amount_paise), out.result ?? type],
      );
    }
  }
  return fixed;
}

/** SANDBOX ONLY. Stands in for the provider by sending a correctly signed webhook to our own processor. */
export function makeSandboxDeliver(
  ctx: AppContext,
  buildSigned: (e: { id: string; type: any; providerRef: string; amountPaise?: number; currency?: string; orderId?: string; reason?: string }) => {
    body: Buffer;
    headers: Record<string, string>;
  },
) {
  return async (event: { type: any; providerRef: string; amountPaise?: number; eventId?: string; currency?: string; orderId?: string; reason?: string }) => {
    const signed = buildSigned({ ...event, id: event.eventId ?? `evt_${crypto.randomUUID()}` });
    await processWebhook(ctx, signed.body, signed.headers);
  };
}
