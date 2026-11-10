import http from 'node:http';
import request from 'supertest';
import { createApp, createContext } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { OrderNotification } from '../src/context.js';
import { createDb, migrate } from '../src/db.js';
import type { PushProvider } from '../src/notify/push.js';
import { MockPaymentProvider } from '../src/payments/mock.js';
import { DEMO_PASSWORD, DEMO_QR, seedDemo } from '../src/seed.js';

/** Fixed, controllable clock: Monday 2026-11-09 10:30 IST. Demo shops are open 08:00–22:00 IST. */
export const START = new Date('2026-11-09T05:00:00Z');
export const STUDENT_APP = 'http://localhost:5273';

export async function makeEnv(opts: { push?: PushProvider; env?: Record<string, string> } = {}) {
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'test-jwt-secret',
    MOCK_WEBHOOK_SECRET: 'test-webhook-secret',
    PICKUP_OTP_SECRET: 'test-otp-secret',
    PUBLIC_API_URL: 'http://api.test',
    STUDENT_APP_URL: STUDENT_APP,
    ...opts.env,
  } as NodeJS.ProcessEnv);
  const db = await createDb(config, { memory: true });
  await migrate(db);
  await seedDemo(db);
  const clock = { t: new Date(START) };
  const ctx = createContext(config, db, { now: () => clock.t, push: opts.push });
  const mock = ctx.provider as MockPaymentProvider;
  const app = createApp(ctx);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const api = request(server);
  const signals: OrderNotification[] = [];
  ctx.bus.onOrder((n) => signals.push(n));
  const advance = (ms: number) => (clock.t = new Date(clock.t.getTime() + ms));

  const shops = (await api.get('/api/v1/shops')).body.shops as Array<{ id: string; name: string; code: string }>;
  const shop01 = shops.find((s) => s.code === 'JG01')!;
  const shop02 = shops.find((s) => s.code === 'JG02')!;
  const menu = async (shopId: string) => {
    const items = (await api.get(`/api/v1/shops/${shopId}/menu`)).body.items as Array<{
      id: string;
      name: string;
      basePricePaise: number;
      modifiers: Array<{ id: string; group: string; name: string; pricePaise: number }>;
    }>;
    return Object.fromEntries(items.map((i) => [i.name, i]));
  };
  const mod = (item: { modifiers: Array<{ id: string; name: string }> }, name: string) => item.modifiers.find((m) => m.name === name)!.id;

  const studentToken = async (email: string) => {
    const o = await api.post('/api/v1/auth/otp/request').send({ email });
    const v = await api.post('/api/v1/auth/otp/verify').send({ email, code: o.body.devCode, name: email.split('@')[0] });
    return v.body.token as string;
  };
  const staffToken = async (email: string) => (await api.post('/api/v1/auth/login').send({ email, password: DEMO_PASSWORD })).body.token as string;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  let slotCursor = 0;
  /** A distinct future slot each call so tests do not compete for capacity unless they want to. */
  const nextSlot = async (shopId: string) => {
    const slots = (await api.get(`/api/v1/shops/${shopId}/pickup-slots`)).body.slots as Array<{ id: string; full: boolean; startsAt: string }>;
    return slots[(slotCursor++ % (slots.length - 2)) + 1];
  };

  let keySeq = 0;
  type Line = { menuItemId: string; quantity: number; modifierIds?: string[]; notes?: string };
  const createOrder = (token: string, body: { source: 'PREORDER' | 'WALKIN_QR'; shopId: string; slotId?: string; items: Line[] }, key = `key-${++keySeq}-${Date.now()}`) =>
    api.post('/api/v1/orders').set(auth(token)).set('Idempotency-Key', key).send(body);

  const startCheckout = (token: string, orderId: string, returnUrl = `${STUDENT_APP}/orders/${orderId}`) =>
    api.post('/api/v1/payments/checkout').set(auth(token)).send({ orderId, returnUrl });
  const simulate = (token: string, orderId: string, outcome: 'success' | 'failure') => api.post('/api/v1/sandbox/payments/simulate').set(auth(token)).send({ orderId, outcome });
  /** Drive the hosted sandbox checkout page exactly like a browser would (GET the page, POST a button). */
  const hostedPay = async (checkoutUrl: string, outcome: string) => {
    const path = new URL(checkoutUrl).pathname;
    const page = await api.get(path);
    const done = await api.post(path).type('form').send({ outcome });
    return { page, done };
  };

  const placeWalkin = async (token: string, shopId = shop01.id, itemName = 'Demo Idli Plate (3)', quantity = 1) => {
    const m = await menu(shopId);
    const created = await createOrder(token, { source: 'WALKIN_QR', shopId, items: [{ menuItemId: m[itemName].id, quantity }] });
    return created.body.order as any;
  };
  const placePaid = async (token: string, opts: { source?: 'PREORDER' | 'WALKIN_QR'; shopId?: string; itemName?: string; quantity?: number } = {}) => {
    const source = opts.source ?? 'PREORDER';
    const shopId = opts.shopId ?? (source === 'PREORDER' ? shop02.id : shop01.id);
    const m = await menu(shopId);
    const itemName = opts.itemName ?? (shopId === shop02.id ? 'Demo Veg Meal' : 'Demo Idli Plate (3)');
    const slot = source === 'PREORDER' ? await nextSlot(shopId) : undefined;
    const created = await createOrder(token, { source, shopId, slotId: slot?.id, items: [{ menuItemId: m[itemName].id, quantity: opts.quantity ?? 1 }] });
    if (created.status !== 201) throw new Error(`order failed: ${JSON.stringify(created.body)}`);
    const orderId = created.body.order.id as string;
    await startCheckout(token, orderId);
    const paid = await simulate(token, orderId, 'success');
    return { orderId, order: paid.body.order, slotId: slot?.id };
  };

  /** A vendor tablet: registers an install id, then claims and reports print jobs. */
  const tablet = async (vendorToken: string, installId = `tab-${Math.random().toString(36).slice(2, 12)}`) => {
    await api.post('/api/v1/vendor/devices/register').set(auth(vendorToken)).send({ installId, platform: 'test' });
    return {
      installId,
      claim: async () => (await api.post('/api/v1/vendor/print-jobs/claim').set(auth(vendorToken)).send({ installId })).body.jobs as any[],
      report: (jobId: string, body: Record<string, unknown>) => api.post(`/api/v1/vendor/print-jobs/${jobId}/result`).set(auth(vendorToken)).send({ installId, ...body }),
    };
  };

  const accept = (vendorToken: string, orderId: string, prepMinutes = 10) => api.post(`/api/v1/vendor/orders/${orderId}/accept`).set(auth(vendorToken)).send({ prepMinutes });
  const setStatus = (vendorToken: string, orderId: string, status: string, reason?: string) =>
    api.patch(`/api/v1/vendor/orders/${orderId}/status`).set(auth(vendorToken)).send({ status, reason });
  const studentOrder = async (token: string, orderId: string) => (await api.get(`/api/v1/orders/${orderId}`).set(auth(token))).body.order as any;
  const verifyOtp = (vendorToken: string, orderId: string, otp: string) => api.post(`/api/v1/vendor/orders/${orderId}/verify-otp`).set(auth(vendorToken)).send({ otp });
  const reserved = async (slotId: string) => Number((await db.query(`SELECT reserved_count FROM pickup_slots WHERE id=$1`, [slotId]))[0].reserved_count);

  const close = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
  };

  return {
    ctx, db, api, mock, close, clock, advance, signals, shop01, shop02, menu, mod, studentToken, staffToken, auth, nextSlot, createOrder, startCheckout, simulate, hostedPay,
    placeWalkin, placePaid, tablet, accept, setStatus, studentOrder, verifyOtp, reserved, DEMO_QR,
  };
}

export type Env = Awaited<ReturnType<typeof makeEnv>>;
