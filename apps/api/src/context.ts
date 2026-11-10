import { EventEmitter } from 'node:events';
import type { Config } from './config.js';
import type { Db, Queryable } from './db.js';
import type { Logger } from './logger.js';
import type { PushProvider } from './notify/push.js';
import type { MarketplacePaymentProvider } from './payments/provider.js';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Signal emitted AFTER a database transaction commits. The socket layer fans these out (IDs + status only). */
export interface OrderNotification {
  orderId: string;
  shopId: string;
  userId: string;
  status: string;
  paymentStatus: string;
  /** true only when the vendor tablet should be told (paid orders). */
  notifyVendor: boolean;
  kind: 'NEW_ORDER' | 'UPDATE';
}

export class Bus extends EventEmitter {
  emitOrder(n: OrderNotification) {
    this.emit('order', n);
  }
  onOrder(fn: (n: OrderNotification) => void) {
    this.on('order', fn);
  }
  /** A print job for this shop became available (new, retry or reprint). */
  emitPrint(shopId: string) {
    this.emit('print', shopId);
  }
  onPrint(fn: (shopId: string) => void) {
    this.on('print', fn);
  }
  /** An in-app notification row was created for this user. */
  emitUserNotification(userId: string) {
    this.emit('user-notification', userId);
  }
  onUserNotification(fn: (userId: string) => void) {
    this.on('user-notification', fn);
  }
}

export interface AppContext {
  config: Config;
  db: Db;
  bus: Bus;
  log: Logger;
  provider: MarketplacePaymentProvider;
  push: PushProvider;
  /** Injectable clock so tests can control time. */
  now: () => Date;
  /** Optional error reporter (Sentry when SENTRY_DSN is set). */
  reportError?: (err: unknown, extra?: Record<string, unknown>) => void;
  /**
   * SANDBOX ONLY: delivers a correctly signed provider webhook to our own webhook processor, standing in for the
   * payment provider. Undefined for any real provider.
   */
  sandboxDeliver?: (event: {
    type: 'payment.succeeded' | 'payment.failed' | 'refund.processed' | 'refund.failed';
    providerRef: string;
    amountPaise?: number;
    eventId?: string;
    reason?: string;
  }) => Promise<void>;
  /** Kick the notification dispatcher (called after commits that queued notifications). */
  kickNotifications?: () => void;
}

/** A transaction plus hooks that run only after it commits (signals, sandbox webhook delivery, dispatch). */
export interface Tx {
  q: Queryable;
  post: Array<() => void | Promise<void>>;
}

export async function withTx<T>(ctx: AppContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const post: Tx['post'] = [];
  const result = await ctx.db.tx((q) => fn({ q, post }));
  for (const hook of post) {
    try {
      await hook();
    } catch (e: any) {
      // A post-commit hook must never turn a committed change into an error response.
      ctx.log.error('post_commit_hook_failed', { err: e?.message ?? String(e) });
      ctx.reportError?.(e);
    }
  }
  return result;
}

export async function audit(
  q: Queryable,
  actor: { id?: string; role?: string },
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await q.query(
    `INSERT INTO audit_logs(actor_id, actor_role, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
    [actor.id ?? null, actor.role ?? null, action, entityType, entityId, JSON.stringify(metadata)],
  );
}

/** Asia/Kolkata has a fixed +05:30 offset (no DST). */
export const IST_OFFSET_MS = 5.5 * 3600 * 1000;
export function istDate(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
export function istDayRange(date: string): { start: Date; end: Date } {
  const start = new Date(`${date}T00:00:00+05:30`);
  return { start, end: new Date(start.getTime() + 24 * 3600 * 1000) };
}
