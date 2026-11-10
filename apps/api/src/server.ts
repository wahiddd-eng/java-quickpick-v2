import http from 'node:http';
import { createApp, createContext } from './app.js';
import { loadConfig } from './config.js';
import { createDb, migrate } from './db.js';
import { createLogger } from './logger.js';
import { attachRealtime } from './realtime.js';
import { dispatchNotifications } from './services/notifications.js';
import { expireStaleOrders } from './services/orders.js';
import { reconcilePayments } from './services/payments.js';
import { seedDemo } from './seed.js';

/** Optional Sentry: enabled only when SENTRY_DSN is set AND `@sentry/node` is installed (`npm i -w @qp2/api @sentry/node`). */
async function initSentry(dsn: string | undefined, env: string) {
  if (!dsn) return undefined;
  const name = '@sentry/node';
  try {
    const Sentry: any = await import(name);
    Sentry.init({ dsn, environment: env, tracesSampleRate: 0 });
    return (err: unknown, extra?: Record<string, unknown>) => Sentry.captureException(err, { extra });
  } catch {
    console.warn('SENTRY_DSN is set but @sentry/node is not installed; error reporting disabled.');
    return undefined;
  }
}

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const db = await createDb(config);
  const ran = await migrate(db);
  if (ran.length) log.info('migrations_applied', { files: ran });
  if (config.nodeEnv !== 'production') {
    const s = await seedDemo(db);
    if (s.seeded) log.info('demo_data_seeded', { note: 'see README for demo accounts' });
  }

  const ctx = createContext(config, db, { log });
  ctx.reportError = await initSentry(config.sentryDsn, config.nodeEnv);
  const app = createApp(ctx);
  const server = http.createServer(app);
  attachRealtime(ctx, server);

  // Background jobs. Each is idempotent and safe to overlap; failures are logged and retried on the next tick.
  const guard = (name: string, fn: () => Promise<unknown>) => () => fn().catch((e) => { log.error(`${name}_failed`, { err: e?.message ?? String(e) }); ctx.reportError?.(e); });
  let dispatching = false;
  const dispatch = guard('notify_dispatch', async () => {
    if (dispatching) return;
    dispatching = true;
    try {
      await dispatchNotifications(ctx);
    } finally {
      dispatching = false;
    }
  });
  ctx.kickNotifications = () => void setTimeout(dispatch, 0);
  const timers = [
    setInterval(guard('expiry_sweep', () => expireStaleOrders(ctx)), 15_000),
    setInterval(dispatch, 5_000),
    setInterval(guard('payment_reconcile', () => reconcilePayments(ctx)), 30_000),
  ];
  timers.forEach((t) => t.unref());

  server.listen(config.port, () => {
    log.info('api_listening', { url: `http://localhost:${config.port}`, push: ctx.push.name });
    console.log(`Java QuickPick V2 API on http://localhost:${config.port}`);
    console.log('⚠  SANDBOX MODE — real payments are DISABLED (pending payment-provider, CA and authority approvals).');
  });

  const shutdown = async () => {
    timers.forEach(clearInterval);
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
