import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FcmPushProvider } from '../src/notify/fcm.js';
import type { PushMessage, PushProvider, TokenResult } from '../src/notify/push.js';
import { dispatchNotifications } from '../src/services/notifications.js';
import { makeEnv, type Env } from './helpers.js';

/** A provider that fails like a flaky network until told otherwise. */
class FlakyPush implements PushProvider {
  readonly name = 'flaky';
  readonly delivers = true;
  mode: 'fail' | 'ok' | 'dead' = 'fail';
  sent: Array<{ tokens: string[]; msg: PushMessage }> = [];
  async send(tokens: string[], msg: PushMessage): Promise<TokenResult[]> {
    this.sent.push({ tokens, msg });
    if (this.mode === 'ok') return tokens.map((token) => ({ token, ok: true as const, messageId: `m-${this.sent.length}` }));
    if (this.mode === 'dead') return tokens.map((token) => ({ token, ok: false as const, error: 'UNREGISTERED', invalidToken: true, retryable: false }));
    return tokens.map((token) => ({ token, ok: false as const, error: 'UNAVAILABLE', invalidToken: false, retryable: true }));
  }
}

let e: Env;
let vendor01: string;
const push = new FlakyPush();

beforeAll(async () => {
  e = await makeEnv({ push });
  vendor01 = await e.staffToken('vendor-01@quickpick.demo');
}, 60_000);
afterAll(async () => e.close());

const TOKEN = 'fcm-test-token-'.padEnd(40, 'x');

describe('push notifications', () => {
  it('retries a failing push with back-off, records the failure, and keeps the in-app fallback', async () => {
    const s = await e.studentToken('push@srm.test');
    await e.api.post('/api/v1/me/push-tokens').set(e.auth(s)).send({ token: TOKEN, platform: 'WEB' });
    const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
    await e.accept(vendor01, orderId);
    await e.setStatus(vendor01, orderId, 'READY');

    push.mode = 'fail';
    await dispatchNotifications(e.ctx);
    let [ready] = await e.db.query(`SELECT * FROM notifications WHERE order_id=$1 AND type='ORDER_READY' AND channel='PUSH'`, [orderId]);
    expect(ready).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'UNAVAILABLE' });
    for (let i = 0; i < 5; i++) {
      e.advance(10 * 60_000);
      await dispatchNotifications(e.ctx);
    }
    [ready] = await e.db.query(`SELECT * FROM notifications WHERE id=$1`, [ready.id]);
    expect(ready).toMatchObject({ status: 'FAILED', attempts: 4 });
    // The order is unaffected and the student still sees READY + the code in the app.
    const st = await e.studentOrder(s, orderId);
    expect(st).toMatchObject({ status: 'READY' });
    expect(st.pickupOtp).toMatch(/^\d{6}$/);
    const inbox = (await e.api.get('/api/v1/me/notifications').set(e.auth(s))).body.notifications;
    expect(inbox.map((n: any) => n.type)).toContain('ORDER_READY');
    // Payload never contains the OTP; it deep-links to the order.
    for (const call of push.sent) {
      expect(JSON.stringify(call.msg)).not.toContain(st.pickupOtp);
      expect(call.msg.link).toMatch(/\/orders\//);
    }
  });

  it('delivers when the provider recovers and disables dead tokens', async () => {
    const s = await e.studentToken('push2@srm.test');
    await e.api.post('/api/v1/me/push-tokens').set(e.auth(s)).send({ token: TOKEN.replace('x', 'y'), platform: 'ANDROID' });
    push.mode = 'ok';
    const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
    await dispatchNotifications(e.ctx);
    const [paid] = await e.db.query(`SELECT status, provider_message_id FROM notifications WHERE order_id=$1 AND type='PAYMENT_SUCCEEDED' AND channel='PUSH'`, [orderId]);
    expect(paid.status).toBe('SENT');
    expect(paid.provider_message_id).toMatch(/^m-/);

    push.mode = 'dead';
    await e.accept(vendor01, orderId);
    await dispatchNotifications(e.ctx);
    const [tok] = await e.db.query(`SELECT disabled_at FROM push_tokens WHERE token=$1`, [TOKEN.replace('x', 'y')]);
    expect(tok.disabled_at).toBeTruthy();
    const [acc] = await e.db.query(`SELECT status FROM notifications WHERE order_id=$1 AND type='ORDER_ACCEPTED' AND channel='PUSH'`, [orderId]);
    expect(acc.status).toBe('SKIPPED');
  });

  it('skips push when the student has no device registered (in-app only)', async () => {
    push.mode = 'ok';
    const s = await e.studentToken('nodevice@srm.test');
    const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
    await dispatchNotifications(e.ctx);
    const [n] = await e.db.query(`SELECT status, last_error FROM notifications WHERE order_id=$1 AND channel='PUSH'`, [orderId]);
    expect(n).toMatchObject({ status: 'SKIPPED', last_error: 'NO_DEVICE_REGISTERED' });
  });

  it('never double-sends when two dispatchers run at once', async () => {
    push.mode = 'ok';
    push.sent = [];
    const s = await e.studentToken('race@srm.test');
    await e.api.post('/api/v1/me/push-tokens').set(e.auth(s)).send({ token: TOKEN.replace('x', 'z') });
    await e.placePaid(s, { source: 'WALKIN_QR' });
    await Promise.all([dispatchNotifications(e.ctx), dispatchNotifications(e.ctx), dispatchNotifications(e.ctx)]);
    expect(push.sent.filter((c) => c.tokens.includes(TOKEN.replace('x', 'z')))).toHaveLength(1);
  });
});

describe('FCM HTTP v1 adapter (against a fake endpoint — not a real Firebase project)', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  it('signs a service-account JWT, caches the access token and sends one message per token', async () => {
    const calls: Array<{ url: string; init: any }> = [];
    const fakeFetch = (async (url: string, init: any) => {
      calls.push({ url, init });
      if (url.includes('/token')) {
        const assertion = new URLSearchParams(init.body).get('assertion')!;
        const [h, c, sig] = assertion.split('.');
        const valid = crypto.createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
        expect(valid).toBe(true);
        expect(JSON.parse(Buffer.from(c, 'base64').toString())).toMatchObject({ iss: 'svc@test.iam', scope: 'https://www.googleapis.com/auth/firebase.messaging' });
        return new Response(JSON.stringify({ access_token: 'ya29.fake', expires_in: 3600 }), { status: 200 });
      }
      const body = JSON.parse(init.body);
      if (body.message.token === 'dead-token') return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
      if (body.message.token === 'busy-token') return new Response('{}', { status: 503 });
      expect(init.headers.Authorization).toBe('Bearer ya29.fake');
      expect(body.message).toMatchObject({ notification: { title: 'Your order is ready' }, data: { type: 'ORDER_READY' }, webpush: { fcm_options: { link: 'http://x/orders/1' } } });
      return new Response(JSON.stringify({ name: 'projects/p/messages/123' }), { status: 200 });
    }) as unknown as typeof fetch;

    const fcm = new FcmPushProvider({ projectId: 'p', clientEmail: 'svc@test.iam', privateKey: pem, fetch: fakeFetch, tokenUrl: 'https://oauth.test/token', apiBase: 'https://fcm.test' });
    const msg = { title: 'Your order is ready', body: 'b', data: { type: 'ORDER_READY' }, link: 'http://x/orders/1' };
    const r = await fcm.send(['good-token', 'dead-token', 'busy-token'], msg);
    expect(r[0]).toMatchObject({ ok: true, messageId: 'projects/p/messages/123' });
    expect(r[1]).toMatchObject({ ok: false, invalidToken: true, retryable: false, error: 'UNREGISTERED' });
    expect(r[2]).toMatchObject({ ok: false, invalidToken: false, retryable: true });
    await fcm.send(['good-token'], msg);
    expect(calls.filter((c) => c.url.includes('/token'))).toHaveLength(1); // cached
    expect(calls.find((c) => c.url.includes('messages:send'))!.url).toBe('https://fcm.test/v1/projects/p/messages:send');
  });
});
