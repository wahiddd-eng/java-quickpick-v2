import type { OrderSource } from '@qp2/shared';
import type { AppContext } from '../context.js';
import type { Queryable } from '../db.js';
import { isOpenNow } from './slots.js';

export type UnavailableReason = 'SUSPENDED' | 'NOT_LIVE' | 'CLOSED' | 'PAUSED' | 'MODE_DISABLED';

export interface Availability {
  orderable: boolean;
  reason: UnavailableReason | null;
  message: string | null;
}

const clock12 = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h >= 12 ? 'pm' : 'am'}`;
};

/** Can a student order from this shop right now in this mode? Messages are written for the student. */
export function shopAvailability(shop: any, source: OrderSource, now: Date): Availability {
  const no = (reason: UnavailableReason, message: string): Availability => ({ orderable: false, reason, message });
  if (shop.status === 'SUSPENDED') return no('SUSPENDED', 'This shop is not available on Java QuickPick right now. Please order at the counter.');
  if (shop.status !== 'ACTIVE') return no('NOT_LIVE', 'This shop is not live on Java QuickPick yet.');
  if (source === 'WALKIN_QR' && !shop.walkin_enabled) return no('MODE_DISABLED', 'This shop is not taking QR orders. Please order at the counter.');
  if (source === 'PREORDER' && !shop.preorder_enabled) return no('MODE_DISABLED', 'This shop is not taking pre-orders right now.');
  if (!shop.accepting_orders) return no('PAUSED', 'This shop has paused app orders for a few minutes. Please try again shortly.');
  if (source === 'WALKIN_QR' && !isOpenNow(shop, now)) {
    return no('CLOSED', `This shop is closed now. It takes orders from ${clock12(shop.open_time)} to ${clock12(shop.close_time)}.`);
  }
  return { orderable: true, reason: null, message: null };
}

/**
 * Realistic walk-in estimate from the shop's live queue: orders already accepted or waiting, worked through
 * `kitchen_parallel` at a time, each taking about `avg_prep_minutes`. Pre-orders due in the next 30 minutes count too,
 * because they occupy the same kitchen. Capped at 90 minutes.
 */
export async function estimateWalkinMinutes(ctx: AppContext, q: Queryable, shop: any): Promise<{ minutes: number; queueLength: number }> {
  const now = ctx.now();
  const soon = new Date(now.getTime() + 30 * 60_000);
  const [row] = await q.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n
       FROM orders o LEFT JOIN pickup_slots s ON s.id = o.slot_id
      WHERE o.shop_id = $1
        AND o.status IN ('AWAITING_VENDOR','ACCEPTED','PREPARING')
        AND (o.order_source = 'WALKIN_QR' OR s.starts_at <= $2)`,
    [shop.id, soon],
  );
  const queueLength = Number(row?.n ?? 0);
  const rounds = Math.floor(queueLength / Math.max(1, shop.kitchen_parallel));
  const minutes = Math.min(90, shop.avg_prep_minutes * (1 + rounds));
  return { minutes, queueLength };
}

export const publicShopView = (ctx: AppContext, s: any) => {
  const now = ctx.now();
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    description: s.description,
    logoUrl: s.logo_url,
    cuisineTags: String(s.cuisine_tags || '')
      .split(',')
      .map((t: string) => t.trim())
      .filter(Boolean),
    acceptingOrders: s.accepting_orders,
    preorderEnabled: s.preorder_enabled,
    walkinEnabled: s.walkin_enabled,
    openNow: isOpenNow(s, now),
    openTime: s.open_time,
    closeTime: s.close_time,
    avgPrepMinutes: s.avg_prep_minutes,
    isDemo: s.is_demo,
    preorder: shopAvailability(s, 'PREORDER', now),
    walkin: shopAvailability(s, 'WALKIN_QR', now),
  };
};
