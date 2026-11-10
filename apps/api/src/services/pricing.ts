import type { OrderSource, PricingPolicy } from '@qp2/shared';
import { HttpError, type AppContext } from '../context.js';
import type { Queryable } from '../db.js';

const map = (r: any): PricingPolicy => ({
  id: r.id,
  orderSource: r.order_source,
  version: r.version,
  feeRateBps: r.fee_rate_bps,
  taxMode: r.tax_mode,
  taxRateBps: r.tax_rate_bps,
  approved: r.approved,
});

/**
 * Active policy for an ordering mode = highest version already in effect for that mode. Sandbox build: an unapproved
 * policy is allowed (and flagged in the UI) because no live payments exist; a live deployment must only ever use
 * `approved = true` (CA sign-off).
 */
export async function getActivePolicy(ctx: AppContext, q: Queryable, source: OrderSource): Promise<PricingPolicy> {
  const rows = await q.query(
    `SELECT * FROM pricing_policies WHERE order_source=$1 AND effective_from <= $2 ORDER BY version DESC LIMIT 1`,
    [source, ctx.now()],
  );
  if (!rows[0]) throw new HttpError(503, 'NO_PRICING_POLICY', `No pricing policy is configured for ${source}`);
  return map(rows[0]);
}

export const policyRowToView = (r: any) => ({
  ...map(r),
  effectiveFrom: r.effective_from,
  note: r.note,
  createdAt: r.created_at,
});
