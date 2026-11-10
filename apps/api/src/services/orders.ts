import crypto from 'node:crypto';
import {
  RELEASING_STATUSES,
  canTransition,
  computeBreakdown,
  type OrderSource,
  type OrderStatus,
  type OrderView,
  type OtpState,
  type PrintStatus,
} from '@qp2/shared';
import { HttpError, withTx, type AppContext, type Tx } from '../context.js';
import type { Queryable } from '../db.js';
import { initiateRefund, type Actor } from './ledger.js';
import { resolveModifiers, type ModifierRow } from './menu.js';
import { queueOrderNotification } from './notifications.js';
import { activateOtpWindow, issuePickupOtp } from './otp.js';
import { getActivePolicy } from './pricing.js';
import { cancelOpenPrintJobs, createPrintJob } from './printing.js';
import { estimateWalkinMinutes, shopAvailability } from './shops.js';
import { releaseSlot, reserveSlot, slotMatchesShop } from './slots.js';

export interface CartLineInput {
  menuItemId: string;
  quantity: number;
  modifierIds?: string[];
  notes?: string;
}

export interface QuoteInput {
  source: OrderSource;
  shopId: string;
  /** Required for PREORDER, forbidden for WALKIN_QR. */
  slotId?: string | null;
  items: CartLineInput[];
}

const ORDER_NUMBER_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const randomCode = (n: number) => Array.from({ length: n }, () => ORDER_NUMBER_ALPHABET[crypto.randomInt(ORDER_NUMBER_ALPHABET.length)]).join('');
/** Cooking instructions: collapse whitespace (incl. control characters) and cap the length; printed on the slip. */
const cleanNotes = (s: string | undefined) =>
  Array.from(s ?? '', (ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);

const UNAVAILABLE_STATUS: Record<string, [number, string]> = {
  SUSPENDED: [409, 'SHOP_UNAVAILABLE'],
  NOT_LIVE: [404, 'SHOP_NOT_FOUND'],
  CLOSED: [409, 'SHOP_CLOSED'],
  PAUSED: [409, 'SHOP_PAUSED'],
  MODE_DISABLED: [409, 'MODE_DISABLED'],
};

/** Server-side quote. Client-supplied prices are never accepted — only item ids, quantities, modifier ids and notes. */
export async function buildQuote(ctx: AppContext, q: Queryable, input: QuoteInput) {
  const [shop] = await q.query(`SELECT * FROM shops WHERE id=$1`, [input.shopId]);
  if (!shop) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
  const availability = shopAvailability(shop, input.source, ctx.now());
  if (!availability.orderable) {
    const [status, code] = UNAVAILABLE_STATUS[availability.reason!];
    throw new HttpError(status, code, availability.message!);
  }

  const totalQty = input.items.reduce((n, l) => n + l.quantity, 0);
  if (totalQty > 50) throw new HttpError(400, 'QUANTITY_TOO_HIGH', 'Maximum 50 items per order');
  const ids = [...new Set(input.items.map((l) => l.menuItemId))];
  const menu = await q.query(`SELECT * FROM menu_items WHERE id = ANY($1::uuid[])`, [ids]);
  if (menu.some((m: any) => m.shop_id !== input.shopId)) {
    throw new HttpError(400, 'MULTI_SHOP_CART', 'An order can contain items from one shop only');
  }
  if (menu.length !== ids.length) throw new HttpError(404, 'ITEM_NOT_FOUND', 'One or more items no longer exist');
  const byId = new Map(menu.map((m: any) => [m.id, m]));
  const mods = await q.query<ModifierRow>(`SELECT * FROM menu_item_modifiers WHERE menu_item_id = ANY($1::uuid[])`, [ids]);

  const lines = input.items.map((l) => {
    const m: any = byId.get(l.menuItemId);
    if (l.quantity > 20) throw new HttpError(400, 'QUANTITY_TOO_HIGH', 'Maximum 20 of one item per order');
    if (!m.available) throw new HttpError(409, 'ITEM_UNAVAILABLE', `${m.name} is currently unavailable`);
    const chosen = resolveModifiers(
      m.name,
      mods.filter((x) => x.menu_item_id === m.id),
      l.modifierIds ?? [],
    );
    const base = Number(m.base_price_paise);
    const unit = base + chosen.totalPaise;
    return {
      menuItemId: m.id as string,
      name: m.name as string,
      basePricePaise: base,
      modifiers: chosen.snapshot,
      modifiersPaise: chosen.totalPaise,
      unitPricePaise: unit,
      quantity: l.quantity,
      lineTotalPaise: unit * l.quantity,
      notes: cleanNotes(l.notes),
    };
  });
  const subtotal = lines.reduce((s, l) => s + l.lineTotalPaise, 0);
  const policy = await getActivePolicy(ctx, q, input.source);
  const breakdown = computeBreakdown(subtotal, policy);

  let slot: any = null;
  let estimate: { minutes: number; queueLength: number } | null = null;
  if (input.source === 'PREORDER') {
    if (!input.slotId) throw new HttpError(400, 'SLOT_REQUIRED', 'Choose a pickup time');
    [slot] = await q.query(`SELECT * FROM pickup_slots WHERE id=$1 AND shop_id=$2`, [input.slotId, input.shopId]);
    if (!slot) throw new HttpError(404, 'SLOT_NOT_FOUND', 'Pickup slot not found for this shop');
    if (!slotMatchesShop(shop, slot)) throw new HttpError(409, 'SLOT_UNAVAILABLE', 'That pickup time is no longer offered. Please choose another time.');
    if (new Date(slot.starts_at).getTime() < ctx.now().getTime() + ctx.config.minLeadMinutes * 60_000) {
      throw new HttpError(409, 'SLOT_UNAVAILABLE', 'That pickup time has passed or is too soon');
    }
    if (slot.reserved_count >= slot.capacity) throw new HttpError(409, 'SLOT_FULL', 'That pickup slot is full. Please choose another time.');
  } else {
    if (input.slotId) throw new HttpError(400, 'SLOT_NOT_ALLOWED', 'Walk-in orders do not use pickup slots');
    estimate = await estimateWalkinMinutes(ctx, q, shop);
  }
  return { shop, lines, breakdown, policy, slot, estimate };
}

export async function createOrder(ctx: AppContext, user: { id: string }, input: QuoteInput, idempotencyKey: string) {
  const existing = await ctx.db.query(`SELECT id FROM orders WHERE user_id=$1 AND idempotency_key=$2`, [user.id, idempotencyKey]);
  if (existing[0]) return { orderId: existing[0].id as string, created: false };

  try {
    return await withTx(ctx, async (tx) => {
      const quote = await buildQuote(ctx, tx.q, input);
      if (input.source === 'PREORDER') await reserveSlot(ctx, tx.q, input.slotId!, input.shopId);
      const now = ctx.now();
      const { breakdown, policy, shop } = quote;
      let orderNumber = '';
      for (let attempt = 0; attempt < 8 && !orderNumber; attempt++) {
        const candidate = 'JQ-' + randomCode(4);
        const taken = await tx.q.query(`SELECT 1 FROM orders WHERE order_number=$1`, [candidate]);
        if (taken.length === 0) orderNumber = candidate;
      }
      if (!orderNumber) throw new HttpError(500, 'ORDER_NUMBER_FAILED', 'Could not allocate an order number');
      const estimatedReadyAt = quote.estimate ? new Date(now.getTime() + quote.estimate.minutes * 60_000) : null;
      const rows = await tx.q.query(
        `INSERT INTO orders (order_number, order_source, user_id, shop_id, slot_id, subtotal_paise, fee_rate_bps, fee_paise, tax_mode, tax_rate_bps,
           tax_paise, total_paise, pricing_policy_id, pricing_policy_version, idempotency_key, expires_at, estimated_ready_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [
          orderNumber,
          input.source,
          user.id,
          shop.id,
          input.source === 'PREORDER' ? input.slotId : null,
          breakdown.subtotalPaise,
          breakdown.feeRateBps,
          breakdown.feePaise,
          breakdown.taxMode,
          breakdown.taxRateBps,
          breakdown.taxPaise,
          breakdown.totalPaise,
          policy.id,
          policy.version,
          idempotencyKey,
          new Date(now.getTime() + ctx.config.checkoutTtlSeconds * 1000),
          estimatedReadyAt,
        ],
      );
      const orderId: string = rows[0].id;
      for (const l of quote.lines) {
        await tx.q.query(
          `INSERT INTO order_items (order_id, menu_item_id, name_snapshot, base_price_paise, modifiers, modifiers_paise, unit_price_paise, quantity, line_total_paise, notes)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
          [orderId, l.menuItemId, l.name, l.basePricePaise, JSON.stringify(l.modifiers), l.modifiersPaise, l.unitPricePaise, l.quantity, l.lineTotalPaise, l.notes],
        );
      }
      await tx.q.query(
        `INSERT INTO order_events (order_id, from_status, to_status, actor_type, actor_id, reason) VALUES ($1,NULL,'PENDING_PAYMENT','STUDENT',$2,$3)`,
        [orderId, user.id, input.source === 'WALKIN_QR' ? 'Walk-in QR checkout started' : 'Pre-order checkout started'],
      );
      return { orderId, created: true };
    });
  } catch (e: any) {
    if (e?.code === '23505' && String(e?.constraint ?? e?.detail ?? e?.message).includes('idempotency')) {
      const again = await ctx.db.query(`SELECT id FROM orders WHERE user_id=$1 AND idempotency_key=$2`, [user.id, idempotencyKey]);
      if (again[0]) return { orderId: again[0].id as string, created: false };
    }
    throw e;
  }
}

export interface TransitionOpts {
  reason?: string;
  scope?: { shopId?: string; userId?: string };
  prepMinutes?: number;
  allowFrom?: OrderStatus[];
  collectedVia?: 'OTP' | 'MANUAL_OVERRIDE';
}

/**
 * The single place order status changes. Enforces the state machine, appends an order event and runs the side effects
 * for each state in the SAME transaction: pickup OTP + kitchen print job on acceptance, OTP collection window on READY,
 * slot release + automatic refund on REJECTED / CANCELLED / EXPIRED, and the student notifications (outbox).
 */
export async function transitionOrder(ctx: AppContext, tx: Tx, orderId: string, to: OrderStatus, actor: Actor, opts: TransitionOpts = {}) {
  const rows = await tx.q.query(`SELECT o.*, s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.id=$1 FOR UPDATE OF o`, [orderId]);
  const order = rows[0];
  // Out-of-scope rows look identical to missing rows so other tenants' order ids cannot be probed.
  if (!order || (opts.scope?.shopId && order.shop_id !== opts.scope.shopId) || (opts.scope?.userId && order.user_id !== opts.scope.userId)) {
    throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
  }
  const from = order.status as OrderStatus;
  if (opts.allowFrom && !opts.allowFrom.includes(from)) throw new HttpError(409, 'INVALID_TRANSITION', `Cannot move an order from ${from} to ${to}`);
  if (!canTransition(from, to)) throw new HttpError(409, 'INVALID_TRANSITION', `Cannot move an order from ${from} to ${to}`);

  const now = ctx.now();
  const sets = ['status=$2', 'updated_at=$3'];
  const params: unknown[] = [orderId, to, now];
  const add = (col: string, v: unknown) => {
    params.push(v);
    sets.push(`${col}=$${params.length}`);
  };
  if (to === 'ACCEPTED') {
    add('accepted_at', now);
    if (opts.prepMinutes) {
      add('prep_minutes', opts.prepMinutes);
      add('estimated_ready_at', new Date(now.getTime() + opts.prepMinutes * 60_000));
    }
  }
  if (to === 'READY') add('ready_at', now);
  if (to === 'COLLECTED') {
    add('collected_at', now);
    add('collected_via', opts.collectedVia ?? 'OTP');
  }
  await tx.q.query(`UPDATE orders SET ${sets.join(', ')} WHERE id=$1`, params);
  await tx.q.query(`INSERT INTO order_events (order_id, from_status, to_status, actor_type, actor_id, reason) VALUES ($1,$2,$3,$4,$5,$6)`, [
    orderId,
    from,
    to,
    actor.type,
    actor.id ?? null,
    opts.reason ?? null,
  ]);

  const paid = order.payment_status === 'SUCCEEDED';
  const view = { id: orderId, user_id: order.user_id, order_number: order.order_number, shop_name: order.shop_name, order_source: order.order_source };
  if (to === 'ACCEPTED') {
    await issuePickupOtp(ctx, tx.q, orderId);
    await createPrintJob(ctx, tx, orderId, 'AUTO_ON_ACCEPT', actor.id);
    const target = order.order_source === 'PREORDER' ? null : opts.prepMinutes;
    await queueOrderNotification(ctx, tx, view, 'ORDER_ACCEPTED', { prepMinutes: target ?? undefined, slotId: order.slot_id ?? undefined });
  }
  if (to === 'PREPARING') await queueOrderNotification(ctx, tx, view, 'ORDER_PREPARING');
  if (to === 'READY') {
    await activateOtpWindow(ctx, tx.q, orderId);
    await queueOrderNotification(ctx, tx, view, 'ORDER_READY');
  }
  if (to === 'NOT_COLLECTED') await tx.q.query(`UPDATE pickup_otps SET status='EXPIRED' WHERE order_id=$1 AND status IN ('ACTIVE','LOCKED')`, [orderId]);

  if (RELEASING_STATUSES.includes(to)) {
    await releaseSlot(tx.q, orderId);
    await cancelOpenPrintJobs(tx.q, orderId);
    await tx.q.query(`UPDATE pickup_otps SET status='REVOKED' WHERE order_id=$1 AND status IN ('ACTIVE','LOCKED')`, [orderId]);
    if (paid) {
      await initiateRefund(ctx, tx, { orderId, reason: opts.reason ?? `Order ${to.toLowerCase()}`, idempotencyKey: `auto:${orderId}`, actor });
      await queueOrderNotification(ctx, tx, view, to === 'REJECTED' ? 'ORDER_REJECTED' : to === 'EXPIRED' ? 'ORDER_EXPIRED' : 'ORDER_CANCELLED', { reason: opts.reason });
    }
  }

  tx.post.push(() =>
    ctx.bus.emitOrder({
      orderId,
      shopId: order.shop_id,
      userId: order.user_id,
      status: to,
      paymentStatus: paid && RELEASING_STATUSES.includes(to) ? 'REFUND_PENDING' : order.payment_status,
      notifyVendor: paid || order.payment_status === 'REFUND_PENDING',
      kind: 'UPDATE',
    }),
  );
  return { orderId, from, to };
}

/** Expire unpaid checkouts, unanswered paid orders and stale pickup OTPs. Safe to run repeatedly and concurrently. */
export async function expireStaleOrders(ctx: AppContext): Promise<number> {
  const now = ctx.now();
  await ctx.db.query(`UPDATE pickup_otps SET status='EXPIRED' WHERE status='ACTIVE' AND expires_at IS NOT NULL AND expires_at < $1`, [now]);
  const stale = await ctx.db.query<{ id: string; status: string }>(
    `SELECT id, status FROM orders WHERE (status='PENDING_PAYMENT' AND expires_at < $1) OR (status='AWAITING_VENDOR' AND accept_deadline < $1)`,
    [now],
  );
  let count = 0;
  for (const s of stale) {
    try {
      await withTx(ctx, async (tx) => {
        const [o] = await tx.q.query(`SELECT status, expires_at, accept_deadline FROM orders WHERE id=$1 FOR UPDATE`, [s.id]);
        const stillStale =
          (o?.status === 'PENDING_PAYMENT' && new Date(o.expires_at) < now) || (o?.status === 'AWAITING_VENDOR' && new Date(o.accept_deadline) < now);
        if (!stillStale) return;
        await transitionOrder(ctx, tx, s.id, 'EXPIRED', { type: 'SYSTEM' }, {
          reason: o.status === 'PENDING_PAYMENT' ? 'Checkout expired before payment' : 'Shop did not respond in time',
        });
        count++;
      });
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
    }
  }
  return count;
}

// ---------- read models ----------

const first = (name: string) => name.split(' ')[0];
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export async function selectOrders(
  q: Queryable,
  where: string,
  params: unknown[],
  opts: { vendorView?: boolean; limit?: number; orderBy?: string } = {},
): Promise<OrderView[]> {
  const rows = await q.query(
    `SELECT o.*, s.starts_at AS slot_starts_at, s.ends_at AS slot_ends_at, sh.name AS shop_name, u.name AS customer_name,
            p.status AS otp_status,
            (SELECT pj.status FROM print_jobs pj WHERE pj.order_id = o.id ORDER BY pj.copy_number DESC LIMIT 1) AS print_status
       FROM orders o
       LEFT JOIN pickup_slots s ON s.id = o.slot_id
       JOIN shops sh ON sh.id = o.shop_id
       JOIN users u ON u.id = o.user_id
       LEFT JOIN pickup_otps p ON p.order_id = o.id
      WHERE ${where}
      ORDER BY ${opts.orderBy ?? 'o.created_at DESC'}
      LIMIT ${Math.min(opts.limit ?? 100, 500)}`,
    params,
  );
  if (rows.length === 0) return [];
  const items = await q.query(`SELECT * FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY name_snapshot`, [rows.map((r: any) => r.id)]);
  return rows.map((r: any) => ({
    id: r.id,
    orderNumber: r.order_number,
    orderSource: r.order_source,
    shopId: r.shop_id,
    shopName: r.shop_name,
    status: r.status,
    paymentStatus: r.payment_status,
    subtotalPaise: Number(r.subtotal_paise),
    feeRateBps: r.fee_rate_bps,
    feePaise: Number(r.fee_paise),
    taxPaise: Number(r.tax_paise),
    totalPaise: Number(r.total_paise),
    slotStartsAt: iso(r.slot_starts_at),
    slotEndsAt: iso(r.slot_ends_at),
    estimatedReadyAt: iso(r.estimated_ready_at),
    prepMinutes: r.prep_minutes,
    acceptDeadline: iso(r.accept_deadline),
    expiresAt: iso(r.expires_at),
    acceptedAt: iso(r.accepted_at),
    readyAt: iso(r.ready_at),
    collectedAt: iso(r.collected_at),
    collectedVia: r.collected_via,
    otpState: (r.otp_status ?? 'NONE') as OtpState,
    // Vendors only see a first name — never student email/phone — plus the kitchen-slip state.
    ...(opts.vendorView ? { customerName: first(r.customer_name), printStatus: (r.print_status ?? 'NONE') as PrintStatus } : {}),
    items: items
      .filter((i: any) => i.order_id === r.id)
      .map((i: any) => ({
        menuItemId: i.menu_item_id,
        name: i.name_snapshot,
        basePricePaise: Number(i.base_price_paise),
        modifiers: i.modifiers ?? [],
        unitPricePaise: Number(i.unit_price_paise),
        quantity: i.quantity,
        lineTotalPaise: Number(i.line_total_paise),
        notes: i.notes ?? '',
      })),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}
