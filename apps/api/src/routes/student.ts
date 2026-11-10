import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, requireRole } from '../auth.js';
import { HttpError, withTx, type AppContext } from '../context.js';
import { notificationView } from '../services/notifications.js';
import { createCheckout } from '../services/payments.js';
import { buildQuote, createOrder, selectOrders, transitionOrder } from '../services/orders.js';
import { revealOtpForStudent } from '../services/otp.js';

const uuid = z.string().uuid();
export const quoteSchema = z
  .object({
    source: z.enum(['PREORDER', 'WALKIN_QR']),
    shopId: uuid,
    slotId: uuid.nullish(),
    items: z
      .array(
        z.object({
          menuItemId: uuid,
          quantity: z.number().int().min(1).max(20),
          modifierIds: z.array(uuid).max(20).default([]),
          notes: z.string().max(140).default(''),
        }),
      )
      .min(1)
      .max(30),
  })
  .strip();

export function studentRoutes(ctx: AppContext): Router {
  const r = Router();
  const student = requireRole(ctx, 'STUDENT');

  r.post(
    '/orders/quote',
    student,
    asyncHandler(async (req, res) => {
      const input = quoteSchema.parse(req.body);
      const q = await buildQuote(ctx, ctx.db, input);
      res.json({
        orderSource: input.source,
        shopId: q.shop.id,
        shopName: q.shop.name,
        slot: q.slot ? { id: q.slot.id, startsAt: q.slot.starts_at, endsAt: q.slot.ends_at } : null,
        estimate: q.estimate,
        items: q.lines,
        breakdown: q.breakdown,
        policyApproved: q.policy.approved,
        sandbox: true,
      });
    }),
  );

  r.post(
    '/orders',
    student,
    asyncHandler(async (req, res) => {
      const key = z.string().min(8).max(100).parse(req.headers['idempotency-key']);
      const input = quoteSchema.parse(req.body);
      const { orderId, created } = await createOrder(ctx, req.auth!, input, key);
      const [order] = await selectOrders(ctx.db, 'o.id=$1', [orderId]);
      res.status(created ? 201 : 200).json({ order });
    }),
  );

  r.post(
    '/payments/checkout',
    student,
    asyncHandler(async (req, res) => {
      const { orderId, returnUrl } = z.object({ orderId: uuid, returnUrl: z.string().url().max(500) }).parse(req.body);
      res.json(await createCheckout(ctx, req.auth!.id, orderId, returnUrl));
    }),
  );

  r.get(
    '/me/orders',
    student,
    asyncHandler(async (req, res) => {
      res.json({ orders: await selectOrders(ctx.db, 'o.user_id=$1', [req.auth!.id], { limit: 50 }) });
    }),
  );

  // Another student's order id is indistinguishable from a missing one (404, not 403).
  r.get(
    '/orders/:orderId',
    student,
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.orderId).success) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
      const [order] = await selectOrders(ctx.db, 'o.id=$1 AND o.user_id=$2', [req.params.orderId, req.auth!.id]);
      if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
      const otp = await revealOtpForStudent(ctx, ctx.db, order);
      const events = await ctx.db.query(`SELECT to_status, reason, created_at FROM order_events WHERE order_id=$1 ORDER BY id`, [order.id]);
      const refunds = await ctx.db.query(`SELECT amount_paise, status, created_at, processed_at FROM refunds WHERE order_id=$1 ORDER BY created_at`, [order.id]);
      res.json({
        order: { ...order, otpState: otp.otpState, ...(otp.pickupOtp ? { pickupOtp: otp.pickupOtp, otpExpiresAt: otp.otpExpiresAt } : {}) },
        events: events.map((e: any) => ({ status: e.to_status, reason: e.reason, at: e.created_at })),
        refunds: refunds.map((f: any) => ({ amountPaise: Number(f.amount_paise), status: f.status, at: f.created_at, processedAt: f.processed_at })),
      });
    }),
  );

  // Cancellation is allowed only before the shop accepts. A paid cancellation is refunded in full automatically.
  r.post(
    '/orders/:orderId/cancel',
    student,
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.orderId).success) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
      await withTx(ctx, (tx) =>
        transitionOrder(ctx, tx, req.params.orderId, 'CANCELLED', { type: 'STUDENT', id: req.auth!.id }, {
          reason: 'Cancelled by student',
          scope: { userId: req.auth!.id },
          allowFrom: ['PENDING_PAYMENT', 'AWAITING_VENDOR'],
        }),
      );
      const [order] = await selectOrders(ctx.db, 'o.id=$1', [req.params.orderId]);
      res.json({ order });
    }),
  );

  r.post(
    '/orders/:orderId/support',
    student,
    asyncHandler(async (req, res) => {
      const body = z.object({ category: z.string().min(1).max(60), description: z.string().min(1).max(1000) }).parse(req.body);
      if (!uuid.safeParse(req.params.orderId).success) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
      const own = await ctx.db.query(`SELECT id FROM orders WHERE id=$1 AND user_id=$2`, [req.params.orderId, req.auth!.id]);
      if (!own[0]) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
      const rows = await ctx.db.query(`INSERT INTO complaints (order_id, user_id, category, description) VALUES ($1,$2,$3,$4) RETURNING id`, [
        req.params.orderId,
        req.auth!.id,
        body.category,
        body.description,
      ]);
      res.status(201).json({ complaintId: rows[0].id });
    }),
  );

  // ----- in-app notifications (always-available fallback for push) -----
  r.get(
    '/me/notifications',
    student,
    asyncHandler(async (req, res) => {
      const rows = await ctx.db.query(`SELECT * FROM notifications WHERE user_id=$1 AND channel='IN_APP' ORDER BY created_at DESC LIMIT 50`, [req.auth!.id]);
      res.json({ notifications: rows.map(notificationView), unread: rows.filter((n: any) => !n.read_at).length });
    }),
  );

  r.post(
    '/me/notifications/read',
    student,
    asyncHandler(async (req, res) => {
      const { ids } = z.object({ ids: z.array(uuid).max(100).optional() }).parse(req.body ?? {});
      if (ids?.length) await ctx.db.query(`UPDATE notifications SET read_at=$3 WHERE user_id=$1 AND id = ANY($2::uuid[]) AND read_at IS NULL`, [req.auth!.id, ids, ctx.now()]);
      else await ctx.db.query(`UPDATE notifications SET read_at=$2 WHERE user_id=$1 AND channel='IN_APP' AND read_at IS NULL`, [req.auth!.id, ctx.now()]);
      res.json({ ok: true });
    }),
  );

  r.post(
    '/me/push-tokens',
    student,
    asyncHandler(async (req, res) => {
      const b = z.object({ token: z.string().min(20).max(4096), platform: z.enum(['WEB', 'ANDROID', 'IOS']).default('WEB') }).parse(req.body);
      await ctx.db.query(
        `INSERT INTO push_tokens (user_id, token, platform) VALUES ($1,$2,$3)
         ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id, platform=EXCLUDED.platform, last_seen_at=now(), disabled_at=NULL`,
        [req.auth!.id, b.token, b.platform],
      );
      res.status(201).json({ ok: true });
    }),
  );

  r.post(
    '/me/push-tokens/remove',
    student,
    asyncHandler(async (req, res) => {
      const { token } = z.object({ token: z.string().min(20).max(4096) }).parse(req.body);
      await ctx.db.query(`UPDATE push_tokens SET disabled_at=now() WHERE token=$1 AND user_id=$2`, [token, req.auth!.id]);
      res.json({ ok: true });
    }),
  );

  // ----- SANDBOX: simulate the provider calling our webhook (signed). Own orders only. Used by automated tests. -----
  r.post(
    '/sandbox/payments/simulate',
    student,
    asyncHandler(async (req, res) => {
      if (!ctx.sandboxDeliver) throw new HttpError(404, 'NOT_FOUND', 'Not available');
      const body = z.object({ orderId: uuid, outcome: z.enum(['success', 'failure']) }).parse(req.body);
      const rows = await ctx.db.query(
        `SELECT p.provider_ref, p.amount_paise FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.id=$1 AND o.user_id=$2`,
        [body.orderId, req.auth!.id],
      );
      if (!rows[0]) throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'Start checkout first');
      await ctx.sandboxDeliver({
        type: body.outcome === 'success' ? 'payment.succeeded' : 'payment.failed',
        providerRef: rows[0].provider_ref,
        amountPaise: Number(rows[0].amount_paise),
      });
      const [order] = await selectOrders(ctx.db, 'o.id=$1', [body.orderId]);
      res.json({ order });
    }),
  );

  return r;
}
