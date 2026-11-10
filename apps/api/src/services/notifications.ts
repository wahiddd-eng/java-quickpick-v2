import { formatPaise, istClock } from '@qp2/shared';
import type { AppContext, Tx } from '../context.js';

/**
 * Student notifications use an OUTBOX: rows are inserted in the same transaction as the order change, then a dispatcher
 * delivers PUSH rows (FCM) with retries and records the outcome. An IN_APP row is written alongside every event so the
 * app always has a fallback (shown in the tracker/inbox, and signalled over Socket.IO). SMS fallback is designed in
 * (users.sms_consent) but no SMS provider is connected (SMS_PROVIDER=none).
 */

export type NotificationType =
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_FAILED'
  | 'ORDER_ACCEPTED'
  | 'ORDER_REJECTED'
  | 'ORDER_PREPARING'
  | 'ORDER_READY'
  | 'ORDER_CANCELLED'
  | 'ORDER_EXPIRED'
  | 'REFUND_INITIATED'
  | 'REFUND_COMPLETED'
  | 'REFUND_FAILED';

/** Types that only go to the in-app inbox (useful, but not worth a phone buzz). */
const IN_APP_ONLY: NotificationType[] = ['ORDER_PREPARING', 'PAYMENT_FAILED'];

interface OrderRef {
  id: string;
  user_id: string;
  order_number: string;
  shop_name: string;
  order_source?: string;
}

async function message(tx: Tx, o: OrderRef, type: NotificationType, extra: Record<string, any>): Promise<{ title: string; body: string }> {
  switch (type) {
    case 'PAYMENT_SUCCEEDED':
      return { title: 'Payment received — order placed', body: `${o.order_number} has been sent to ${o.shop_name}. We'll let you know when they accept it.` };
    case 'PAYMENT_FAILED':
      return { title: 'Payment did not go through', body: `No money was taken for ${o.order_number}. You can try paying again before the checkout expires.` };
    case 'ORDER_ACCEPTED': {
      let when = '';
      if (extra.prepMinutes) when = ` It should be ready in about ${extra.prepMinutes} min.`;
      else if (extra.slotId) {
        const [s] = await tx.q.query(`SELECT starts_at FROM pickup_slots WHERE id=$1`, [extra.slotId]);
        if (s) when = ` Pickup from ${istClock(new Date(s.starts_at).toISOString())}.`;
      }
      return { title: `${o.shop_name} accepted your order`, body: `${o.order_number} is in the kitchen queue.${when}` };
    }
    case 'ORDER_REJECTED':
      return { title: `${o.shop_name} couldn't take your order`, body: `${extra.reason ? extra.reason + '. ' : ''}A full refund for ${o.order_number} has been started.` };
    case 'ORDER_PREPARING':
      return { title: 'Your food is being prepared', body: `${o.shop_name} has started on ${o.order_number}.` };
    case 'ORDER_READY':
      return { title: 'Your order is ready', body: `Go to ${o.shop_name} and show your collection code for ${o.order_number}.` };
    case 'ORDER_CANCELLED':
      return { title: 'Order cancelled', body: `${o.order_number} was cancelled. A full refund has been started.` };
    case 'ORDER_EXPIRED':
      return { title: 'Order not accepted in time', body: `${o.shop_name} didn't respond to ${o.order_number}. A full refund has been started.` };
    case 'REFUND_INITIATED':
      return { title: 'Refund started', body: `${formatPaise(extra.amountPaise ?? 0)} for ${o.order_number} is on its way back to your original payment method.` };
    case 'REFUND_COMPLETED':
      return { title: 'Refund completed', body: `${formatPaise(extra.amountPaise ?? 0)} for ${o.order_number} has been refunded.` };
    case 'REFUND_FAILED':
      return { title: 'Your refund is delayed', body: `The refund for ${o.order_number} needs attention. Our team has been alerted and will sort it out.` };
  }
}

export async function queueOrderNotification(ctx: AppContext, tx: Tx, order: OrderRef, type: NotificationType, extra: Record<string, any> = {}) {
  const { title, body } = await message(tx, order, type, extra);
  const data = { type, orderId: order.id, orderNumber: order.order_number };
  const dedupe = `${order.id}:${type}:${extra.dedupe ?? ''}`;
  const now = ctx.now();
  await tx.q.query(
    `INSERT INTO notifications (user_id, order_id, type, channel, title, body, data, status, sent_at, dedupe_key)
     VALUES ($1,$2,$3,'IN_APP',$4,$5,$6::jsonb,'SENT',$7,$8) ON CONFLICT (dedupe_key) DO NOTHING`,
    [order.user_id, order.id, type, title, body, JSON.stringify(data), now, `${dedupe}:IN_APP`],
  );
  if (!IN_APP_ONLY.includes(type)) {
    await tx.q.query(
      `INSERT INTO notifications (user_id, order_id, type, channel, title, body, data, next_attempt_at, dedupe_key)
       VALUES ($1,$2,$3,'PUSH',$4,$5,$6::jsonb,$7,$8) ON CONFLICT (dedupe_key) DO NOTHING`,
      [order.user_id, order.id, type, title, body, JSON.stringify(data), now, `${dedupe}:PUSH`],
    );
  }
  tx.post.push(() => {
    ctx.bus.emitUserNotification(order.user_id);
    ctx.kickNotifications?.();
  });
}

/**
 * Deliver due PUSH notifications. Each row is claimed atomically (attempts+1 and a short lease on next_attempt_at), so
 * overlapping dispatcher runs never double-send. Outcomes: SENT, SIMULATED (sandbox log provider), SKIPPED (no device /
 * push disabled), FAILED (after max_attempts). Dead tokens are disabled.
 */
export async function dispatchNotifications(ctx: AppContext, limit = 50): Promise<{ processed: number }> {
  const now = ctx.now();
  const due = await ctx.db.query<{ id: string }>(
    `SELECT id FROM notifications WHERE channel='PUSH' AND status='PENDING' AND next_attempt_at <= $1 ORDER BY next_attempt_at LIMIT $2`,
    [now, limit],
  );
  let processed = 0;
  for (const { id } of due) {
    const [n] = await ctx.db.query(
      `UPDATE notifications SET attempts=attempts+1, next_attempt_at=$3 WHERE id=$1 AND status='PENDING' AND next_attempt_at <= $2 RETURNING *`,
      [id, now, new Date(now.getTime() + 60_000)],
    );
    if (!n) continue;
    processed++;
    const tokens = (await ctx.db.query<{ token: string }>(`SELECT token FROM push_tokens WHERE user_id=$1 AND disabled_at IS NULL`, [n.user_id])).map((t) => t.token);
    const finish = (status: string, fields: { error?: string | null; messageId?: string | null; retryAt?: Date } = {}) =>
      ctx.db.query(
        `UPDATE notifications SET status=$2, last_error=$3, provider_message_id=COALESCE($4, provider_message_id), sent_at=CASE WHEN $2 IN ('SENT','SIMULATED') THEN $5::timestamptz ELSE sent_at END,
                next_attempt_at=COALESCE($6, next_attempt_at) WHERE id=$1`,
        [n.id, status, fields.error ?? null, fields.messageId ?? null, now, fields.retryAt ?? null],
      );

    if (ctx.push.name === 'none') {
      await finish('SKIPPED', { error: 'PUSH_DISABLED' });
      continue;
    }
    if (tokens.length === 0) {
      // Sandbox log provider: nothing to deliver to, but the pipeline ran — record it as simulated.
      await finish(ctx.push.delivers ? 'SKIPPED' : 'SIMULATED', { error: ctx.push.delivers ? 'NO_DEVICE_REGISTERED' : null });
      continue;
    }
    const link = `${ctx.config.studentAppUrl}/orders/${n.data?.orderId ?? ''}`;
    const results = await ctx.push.send(tokens, { title: n.title, body: n.body, data: Object.fromEntries(Object.entries(n.data ?? {}).map(([k, v]) => [k, String(v)])), link });
    for (const r of results) {
      if (!r.ok && r.invalidToken) await ctx.db.query(`UPDATE push_tokens SET disabled_at=$2 WHERE token=$1`, [r.token, now]);
    }
    const okResult = results.find((r) => r.ok);
    if (okResult && okResult.ok) {
      await finish(ctx.push.delivers ? 'SENT' : 'SIMULATED', { messageId: okResult.messageId });
      continue;
    }
    const failures = results.filter((r) => !r.ok) as Array<{ error: string; retryable: boolean }>;
    const error = failures.map((f) => f.error).join(',').slice(0, 300) || 'UNKNOWN';
    if (failures.some((f) => f.retryable) && n.attempts < n.max_attempts) {
      await finish('PENDING', { error, retryAt: new Date(now.getTime() + 15_000 * 2 ** (n.attempts - 1)) });
    } else {
      await finish(failures.every((f) => !f.retryable) && results.every((r) => !r.ok && (r as any).invalidToken) ? 'SKIPPED' : 'FAILED', { error });
      ctx.log.warn('push_failed', { notificationId: n.id, type: n.type, error });
    }
  }
  return { processed };
}

export const notificationView = (n: any) => ({
  id: n.id,
  orderId: n.order_id,
  type: n.type,
  title: n.title,
  body: n.body,
  createdAt: new Date(n.created_at).toISOString(),
  readAt: n.read_at ? new Date(n.read_at).toISOString() : null,
});
