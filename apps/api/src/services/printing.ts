import type { KitchenTicket } from '@qp2/shared';
import { HttpError, audit, withTx, type AppContext, type Tx } from '../context.js';
import type { Queryable } from '../db.js';

/**
 * Kitchen print jobs. The job is created in the SAME transaction as vendor acceptance, so a paid + accepted order
 * always has a durable slip request even if the printer, Bluetooth or the tablet is down. The tablet claims jobs with a
 * short lease, prints, and reports the result. Failures retry automatically with back-off up to max_attempts, then wait
 * for a manual retry. A reprint is a NEW job with copy_number > 1 and is printed with a duplicate label.
 */

export async function buildTicketPayload(q: Queryable, orderId: string): Promise<Omit<KitchenTicket, 'copyNumber' | 'attempt'>> {
  const [o] = await q.query(
    `SELECT o.*, s.name AS shop_name, ps.starts_at AS slot_starts_at FROM orders o JOIN shops s ON s.id=o.shop_id LEFT JOIN pickup_slots ps ON ps.id=o.slot_id WHERE o.id=$1`,
    [orderId],
  );
  if (!o) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
  const items = await q.query(`SELECT * FROM order_items WHERE order_id=$1 ORDER BY name_snapshot`, [orderId]);
  const preorder = o.order_source === 'PREORDER';
  const target = preorder ? o.slot_starts_at : o.estimated_ready_at;
  return {
    orderId: o.id,
    orderNumber: o.order_number,
    orderSource: o.order_source,
    shopName: o.shop_name,
    orderedAt: new Date(o.created_at).toISOString(),
    targetAt: target ? new Date(target).toISOString() : null,
    targetLabel: preorder ? 'Pickup at' : 'Ready by',
    prepMinutes: o.prep_minutes,
    items: items.map((i: any) => ({
      name: i.name_snapshot,
      quantity: i.quantity,
      modifiers: (i.modifiers ?? []).map((m: any) => m.name),
      notes: i.notes ?? '',
    })),
  };
}

export async function createPrintJob(ctx: AppContext, tx: Tx, orderId: string, reason: 'AUTO_ON_ACCEPT' | 'MANUAL_REPRINT', requestedBy?: string) {
  const payload = await buildTicketPayload(tx.q, orderId);
  const [{ shop_id }] = await tx.q.query(`SELECT shop_id FROM orders WHERE id=$1`, [orderId]);
  const [printer] = await tx.q.query(`SELECT id FROM printer_devices WHERE shop_id=$1 AND active=true ORDER BY created_at LIMIT 1`, [shop_id]);
  const [{ next }] = await tx.q.query<{ next: number }>(`SELECT COALESCE(MAX(copy_number),0)+1 AS next FROM print_jobs WHERE order_id=$1`, [orderId]);
  const [job] = await tx.q.query(
    `INSERT INTO print_jobs (order_id, shop_id, printer_id, copy_number, reason, max_attempts, payload, requested_by, next_attempt_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
    [orderId, shop_id, printer?.id ?? null, Number(next), reason, ctx.config.printMaxAttempts, JSON.stringify(payload), requestedBy ?? null, ctx.now()],
  );
  tx.post.push(() => ctx.bus.emitPrint(shop_id));
  return job;
}

export async function cancelOpenPrintJobs(q: Queryable, orderId: string) {
  await q.query(`UPDATE print_jobs SET status='CANCELLED', updated_at=now() WHERE order_id=$1 AND status IN ('PENDING','CLAIMED')`, [orderId]);
}

export const jobView = (j: any) => ({
  id: j.id,
  orderId: j.order_id,
  printerId: j.printer_id,
  copyNumber: j.copy_number,
  attempt: j.attempts,
  maxAttempts: j.max_attempts,
  reason: j.reason,
  status: j.status,
  lastError: j.last_error,
  nextAttemptAt: j.next_attempt_at ? new Date(j.next_attempt_at).toISOString() : null,
  createdAt: new Date(j.created_at).toISOString(),
  printedAt: j.printed_at ? new Date(j.printed_at).toISOString() : null,
  ticket: { ...j.payload, copyNumber: j.copy_number, attempt: Math.max(1, j.attempts) } as KitchenTicket,
});

/**
 * Claim printable jobs for this tablet: PENDING jobs whose back-off has passed, plus CLAIMED jobs whose lease expired
 * (the tablet died or restarted mid-print). Expired leases that already used every attempt become FAILED instead.
 */
export async function claimPrintJobs(ctx: AppContext, shopId: string, deviceId: string, limit = 5) {
  const now = ctx.now();
  return withTx(ctx, async (tx) => {
    await tx.q.query(
      `UPDATE print_jobs SET status='FAILED', last_error=COALESCE(last_error,'No result from tablet (lease expired)'), updated_at=$2
        WHERE shop_id=$1 AND status='CLAIMED' AND claim_expires_at < $2 AND attempts >= max_attempts`,
      [shopId, now],
    );
    const rows = await tx.q.query(
      `UPDATE print_jobs SET status='CLAIMED', claimed_by_device_id=$2, claim_expires_at=$3, attempts=attempts+1, updated_at=$4
        WHERE id IN (
          SELECT id FROM print_jobs
           WHERE shop_id=$1
             AND ((status='PENDING' AND next_attempt_at <= $4) OR (status='CLAIMED' AND claim_expires_at < $4))
           ORDER BY created_at
           LIMIT $5
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [shopId, deviceId, new Date(now.getTime() + ctx.config.printClaimSeconds * 1000), now, limit],
    );
    return rows.sort((a: any, b: any) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()).map(jobView);
  });
}

export type PrinterState = 'ONLINE' | 'OFFLINE' | 'PAPER_OUT' | 'ERROR';

export async function reportPrintResult(
  ctx: AppContext,
  input: { jobId: string; shopId: string; deviceId: string; ok: boolean; error?: string; printerId?: string; printerStatus?: PrinterState },
) {
  const now = ctx.now();
  const out = await withTx(ctx, async (tx) => {
    const [job] = await tx.q.query(`SELECT * FROM print_jobs WHERE id=$1 AND shop_id=$2 FOR UPDATE`, [input.jobId, input.shopId]);
    if (!job) throw new HttpError(404, 'PRINT_JOB_NOT_FOUND', 'Print job not found');
    if (input.printerId) {
      await tx.q.query(`UPDATE printer_devices SET status=$3, last_error=$4, last_status_at=$5 WHERE id=$1 AND shop_id=$2`, [
        input.printerId,
        input.shopId,
        input.printerStatus ?? (input.ok ? 'ONLINE' : 'ERROR'),
        input.ok ? null : (input.error ?? null),
        now,
      ]);
    }
    if (job.status === 'PRINTED') return { job, duplicate: true };
    if (job.status !== 'CLAIMED' || job.claimed_by_device_id !== input.deviceId) {
      throw new HttpError(409, 'STALE_CLAIM', 'This print job is no longer held by this tablet');
    }
    if (input.ok) {
      const [j] = await tx.q.query(
        `UPDATE print_jobs SET status='PRINTED', printed_at=$2, last_error=NULL, claim_expires_at=NULL, printer_id=COALESCE($3, printer_id), updated_at=$2 WHERE id=$1 RETURNING *`,
        [job.id, now, input.printerId ?? null],
      );
      return { job: j, duplicate: false };
    }
    const exhausted = job.attempts >= job.max_attempts;
    const backoffMs = 10_000 * 2 ** Math.max(0, job.attempts - 1);
    const [j] = await tx.q.query(
      `UPDATE print_jobs SET status=$2, last_error=$3, next_attempt_at=$4, claim_expires_at=NULL, updated_at=$5 WHERE id=$1 RETURNING *`,
      [job.id, exhausted ? 'FAILED' : 'PENDING', (input.error ?? 'Print failed').slice(0, 300), new Date(now.getTime() + backoffMs), now],
    );
    if (exhausted) ctx.log.warn('print_job_failed', { jobId: job.id, orderId: job.order_id, shopId: input.shopId, error: input.error });
    tx.post.push(() => ctx.bus.emitPrint(input.shopId));
    return { job: j, duplicate: false };
  });
  return { job: jobView(out.job), duplicate: out.duplicate };
}

/** Manual retry of a FAILED job. Attempts keep counting, so the slip is labelled as a possible duplicate. */
export async function retryPrintJob(ctx: AppContext, input: { jobId: string; shopId: string; actor: { id: string; role: string } }) {
  return withTx(ctx, async (tx) => {
    const [j] = await tx.q.query(
      `UPDATE print_jobs SET status='PENDING', max_attempts=attempts+$3, next_attempt_at=$4, updated_at=$4
        WHERE id=$1 AND shop_id=$2 AND status='FAILED' RETURNING *`,
      [input.jobId, input.shopId, ctx.config.printMaxAttempts, ctx.now()],
    );
    if (!j) throw new HttpError(409, 'NOT_RETRYABLE', 'Only a failed print job can be retried');
    await audit(tx.q, input.actor, 'PRINT_RETRY', 'print_job', j.id, { orderId: j.order_id });
    tx.post.push(() => ctx.bus.emitPrint(input.shopId));
    return jobView(j);
  });
}

export async function reprintOrder(ctx: AppContext, input: { orderId: string; shopId: string; actor: { id: string; role: string } }) {
  return withTx(ctx, async (tx) => {
    const [o] = await tx.q.query(`SELECT id, shop_id, status FROM orders WHERE id=$1 FOR UPDATE`, [input.orderId]);
    if (!o || o.shop_id !== input.shopId) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
    if (!['ACCEPTED', 'PREPARING', 'READY'].includes(o.status)) throw new HttpError(409, 'NOT_PRINTABLE', 'Only accepted orders that are not finished can be reprinted');
    const job = await createPrintJob(ctx, tx, o.id, 'MANUAL_REPRINT', input.actor.id);
    await audit(tx.q, input.actor, 'PRINT_REPRINT', 'print_job', job.id, { orderId: o.id, copyNumber: job.copy_number });
    return jobView(job);
  });
}
