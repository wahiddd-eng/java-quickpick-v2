import { duplicateLabel, renderKitchenTicket } from '@qp2/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeEnv, type Env } from './helpers.js';

let e: Env;
let vendor01: string;
let vendor02: string;
let admin: string;

beforeAll(async () => {
  e = await makeEnv();
  vendor01 = await e.staffToken('vendor-01@quickpick.demo');
  vendor02 = await e.staffToken('vendor-02@quickpick.demo');
  admin = await e.staffToken('admin@quickpick.demo');
}, 60_000);
afterAll(async () => e.close());

const ascii = (b: Uint8Array) => Array.from(b, (c) => (c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : ' ')).join('');

async function acceptedOrder(email: string) {
  const s = await e.studentToken(email);
  const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
  await e.accept(vendor01, orderId, 10);
  return { s, orderId };
}

describe('kitchen printing', () => {
  it('prints only after acceptance', async () => {
    const s = await e.studentToken('printafter@srm.test');
    const { orderId } = await e.placePaid(s, { source: 'WALKIN_QR' });
    const tab = await e.tablet(vendor01);
    expect((await tab.claim()).filter((j) => j.orderId === orderId)).toHaveLength(0);
    await e.accept(vendor01, orderId);
    expect((await tab.claim()).filter((j) => j.orderId === orderId)).toHaveLength(1);
  });

  it('printer disconnection: retries with back-off, then fails, then a manual retry is labelled as a possible duplicate', async () => {
    const { orderId } = await acceptedOrder('disconnect@srm.test');
    const tab = await e.tablet(vendor01);
    const [printer] = (await e.api.get('/api/v1/vendor/printers').set(e.auth(vendor01))).body.printers;

    let [job] = (await tab.claim()).filter((j) => j.orderId === orderId);
    const r1 = await tab.report(job.id, { ok: false, error: 'Bluetooth socket closed', printerId: printer.id, printerStatus: 'OFFLINE' });
    expect(r1.body.job).toMatchObject({ status: 'PENDING', attempt: 1 });
    // Back-off: not claimable straight away.
    expect((await tab.claim()).filter((j) => j.orderId === orderId)).toHaveLength(0);
    // The failure is visible on the tablet board and in admin printer health.
    const board = (await e.api.get('/api/v1/vendor/orders').set(e.auth(vendor01))).body.orders.find((o: any) => o.id === orderId);
    expect(board.printStatus).toBe('PENDING');
    const health = (await e.api.get('/api/v1/admin/printers').set(e.auth(admin))).body.printers.find((p: any) => p.id === printer.id);
    expect(health).toMatchObject({ status: 'OFFLINE', lastError: 'Bluetooth socket closed' });

    for (let attempt = 2; attempt <= 3; attempt++) {
      e.advance(60_000);
      [job] = (await tab.claim()).filter((j) => j.orderId === orderId);
      expect(job.attempt).toBe(attempt);
      expect(duplicateLabel(job.ticket)).toMatch(new RegExp(`RETRY ${attempt}`));
      await tab.report(job.id, { ok: false, error: 'Bluetooth socket closed', printerId: printer.id, printerStatus: 'OFFLINE' });
    }
    const failed = (await e.api.get('/api/v1/vendor/print-jobs?status=failed').set(e.auth(vendor01))).body.jobs.find((j: any) => j.orderId === orderId);
    expect(failed).toMatchObject({ status: 'FAILED', attempt: 3, lastError: 'Bluetooth socket closed' });
    e.advance(5 * 60_000);
    expect((await tab.claim()).filter((j) => j.orderId === orderId)).toHaveLength(0); // waits for a person

    // A printer failure never loses the paid order: it is still on the board and can move on.
    expect((await e.setStatus(vendor01, orderId, 'PREPARING')).status).toBe(200);

    const retry = await e.api.post(`/api/v1/vendor/print-jobs/${failed.id}/retry`).set(e.auth(vendor01)).send({});
    expect(retry.body.job.status).toBe('PENDING');
    [job] = (await tab.claim()).filter((j) => j.orderId === orderId);
    expect(job.attempt).toBe(4);
    expect(ascii(renderKitchenTicket(job.ticket))).toContain('RETRY 4 - CHECK FOR DUPLICATE');
    expect((await tab.report(job.id, { ok: true, printerId: printer.id })).body.job.status).toBe('PRINTED');
    const healthy = (await e.api.get('/api/v1/vendor/printers').set(e.auth(vendor01))).body.printers[0];
    expect(healthy.status).toBe('ONLINE');
  });

  it('paper-out is recorded as printer status', async () => {
    const { orderId } = await acceptedOrder('paper@srm.test');
    const tab = await e.tablet(vendor01);
    const [printer] = (await e.api.get('/api/v1/vendor/printers').set(e.auth(vendor01))).body.printers;
    const [job] = (await tab.claim()).filter((j) => j.orderId === orderId);
    await tab.report(job.id, { ok: false, error: 'Paper out', printerId: printer.id, printerStatus: 'PAPER_OUT' });
    const health = (await e.api.get('/api/v1/admin/printers').set(e.auth(admin))).body.printers.find((p: any) => p.id === printer.id);
    expect(health.status).toBe('PAPER_OUT');
    e.advance(60_000);
    const [again] = (await tab.claim()).filter((j) => j.orderId === orderId);
    await tab.report(again.id, { ok: true, printerId: printer.id });
  });

  it('duplicate print: a second tablet cannot take a held job, a repeated result is idempotent, a reprint is a labelled copy', async () => {
    const { orderId } = await acceptedOrder('dupprint@srm.test');
    const a = await e.tablet(vendor01);
    const b = await e.tablet(vendor01);
    const [job] = (await a.claim()).filter((j) => j.orderId === orderId);
    expect((await b.claim()).filter((j) => j.orderId === orderId)).toHaveLength(0);
    expect((await b.report(job.id, { ok: true })).status).toBe(409); // not b's job
    expect((await a.report(job.id, { ok: true })).body).toMatchObject({ duplicate: false });
    expect((await a.report(job.id, { ok: true })).body).toMatchObject({ duplicate: true });

    const reprint = await e.api.post(`/api/v1/vendor/orders/${orderId}/reprint`).set(e.auth(vendor01)).send({});
    expect(reprint.status).toBe(201);
    expect(reprint.body.job).toMatchObject({ copyNumber: 2, reason: 'MANUAL_REPRINT' });
    const [copy] = (await a.claim()).filter((j) => j.orderId === orderId);
    expect(ascii(renderKitchenTicket(copy.ticket))).toContain('REPRINT - COPY 2 - DO NOT COOK AGAIN');
    await a.report(copy.id, { ok: true });
    const audit = await e.db.query(`SELECT action FROM audit_logs WHERE action='PRINT_REPRINT' AND metadata->>'orderId'=$1`, [orderId]);
    expect(audit).toHaveLength(1);
  });

  it('tablet restart: a job claimed by a tablet that died is picked up again after the lease and marked as a retry', async () => {
    const { orderId } = await acceptedOrder('restart@srm.test');
    const before = await e.tablet(vendor01, 'tab-restart-01');
    const [job] = (await before.claim()).filter((j) => j.orderId === orderId);
    // Tablet restarts mid-print and never reports. Same install id comes back.
    const after = await e.tablet(vendor01, 'tab-restart-01');
    expect((await after.claim()).filter((j) => j.orderId === orderId)).toHaveLength(0); // lease still held
    e.advance(60_000);
    const [again] = (await after.claim()).filter((j) => j.orderId === orderId);
    expect(again).toMatchObject({ id: job.id, attempt: 2 });
    expect(duplicateLabel(again.ticket)).toMatch(/RETRY 2/);
    expect((await after.report(again.id, { ok: true })).body.job.status).toBe('PRINTED');
  });

  it('isolates print jobs, printers and devices by shop', async () => {
    const { orderId } = await acceptedOrder('isolate@srm.test');
    const other = await e.tablet(vendor02);
    expect((await other.claim()).filter((j) => j.orderId === orderId)).toHaveLength(0);
    const [job] = (await e.api.get('/api/v1/vendor/print-jobs').set(e.auth(vendor01))).body.jobs.filter((j: any) => j.orderId === orderId);
    expect((await other.report(job.id, { ok: true })).status).toBe(404);
    expect((await e.api.post(`/api/v1/vendor/orders/${orderId}/reprint`).set(e.auth(vendor02)).send({})).status).toBe(404);
    // A tablet registered to shop 01 cannot be used by shop 02's login.
    const t1 = await e.tablet(vendor01, 'tab-shop01-only');
    void t1;
    const steal = await e.api.post('/api/v1/vendor/devices/register').set(e.auth(vendor02)).send({ installId: 'tab-shop01-only' });
    expect(steal.status).toBe(409);
    expect((await e.api.post('/api/v1/vendor/print-jobs/claim').set(e.auth(vendor02)).send({ installId: 'tab-shop01-only' })).status).toBe(403);
  });

  it('validates printer addresses and keeps one active printer per shop', async () => {
    const bad = await e.api.post('/api/v1/vendor/printers').set(e.auth(vendor02)).send({ name: 'Kitchen', connection: 'NETWORK', address: 'not-an-address' });
    expect(bad.status).toBe(400);
    const ok = await e.api.post('/api/v1/vendor/printers').set(e.auth(vendor02)).send({ name: 'Kitchen LAN', connection: 'NETWORK', address: '192.168.1.50:9100' });
    expect(ok.status).toBe(201);
    const list = (await e.api.get('/api/v1/vendor/printers').set(e.auth(vendor02))).body.printers;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ connection: 'NETWORK', address: '192.168.1.50:9100' });
  });
});
