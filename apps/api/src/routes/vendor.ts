import { VENDOR_ACTIVE_STATUSES, type OrderStatus } from '@qp2/shared';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { asyncHandler, requireRole, vendorShopId } from '../auth.js';
import { HttpError, IST_OFFSET_MS, audit, istDate, istDayRange, withTx, type AppContext } from '../context.js';
import { loadMenu } from '../services/menu.js';
import { selectOrders, transitionOrder } from '../services/orders.js';
import { overrideCollection, verifyPickupOtp } from '../services/otp.js';
import { claimPrintJobs, jobView, reportPrintResult, reprintOrder, retryPrintJob } from '../services/printing.js';

const uuid = z.string().uuid();
const installId = z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/);

const printerView = (p: any) => ({
  id: p.id,
  name: p.name,
  model: p.model,
  connection: p.connection,
  address: p.address,
  paperWidthMm: p.paper_width_mm,
  autoPrint: p.auto_print,
  status: p.status,
  lastError: p.last_error,
  lastStatusAt: p.last_status_at,
  active: p.active,
});

export function vendorRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use('/vendor', requireRole(ctx, 'VENDOR'));
  const actor = (req: Request) => ({ type: 'VENDOR' as const, id: req.auth!.id, role: 'VENDOR' });

  // Every query below is scoped by vendorShopId(req) — the shop comes from the vendor's own memberships, never from input.

  /** Resolve this tablet's device row (must be registered to the vendor's shop). */
  const deviceFor = async (shopId: string, id: string) => {
    const [d] = await ctx.db.query(`SELECT * FROM vendor_devices WHERE install_id=$1`, [id]);
    if (!d || d.shop_id !== shopId) throw new HttpError(403, 'DEVICE_NOT_REGISTERED', 'This tablet is not registered to your shop');
    return d;
  };

  r.get(
    '/vendor/shop',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const [s] = await ctx.db.query(`SELECT * FROM shops WHERE id=$1`, [shopId]);
      const printers = await ctx.db.query(`SELECT * FROM printer_devices WHERE shop_id=$1 AND active=true ORDER BY created_at`, [shopId]);
      res.json({
        shop: {
          id: s.id,
          code: s.code,
          name: s.name,
          status: s.status,
          acceptingOrders: s.accepting_orders,
          walkinEnabled: s.walkin_enabled,
          preorderEnabled: s.preorder_enabled,
          acceptTimeoutSeconds: s.accept_timeout_seconds,
          avgPrepMinutes: s.avg_prep_minutes,
          openTime: s.open_time,
          closeTime: s.close_time,
        },
        ...(await loadMenu(ctx.db, shopId, { includeInactiveCategories: true })),
        printers: printers.map(printerView),
        shops: req.auth!.shopIds,
        serverTime: ctx.now().toISOString(),
      });
    }),
  );

  // Source of truth for the tablet: called on load, reconnect and on a polling fallback. Unpaid orders never appear.
  r.get(
    '/vendor/orders',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const view = z.enum(['active', 'completed', 'rejected']).default('active').parse(req.query.view);
      const { start } = istDayRange(istDate(ctx.now()));
      const list = (xs: readonly string[]) => xs.map((s) => `'${s}'`).join(',');
      const where =
        view === 'active'
          ? `o.shop_id=$1 AND o.status IN (${list(VENDOR_ACTIVE_STATUSES)})`
          : view === 'completed'
            ? `o.shop_id=$1 AND o.status IN ('COLLECTED','NOT_COLLECTED') AND o.updated_at >= $2`
            : `o.shop_id=$1 AND o.status IN ('REJECTED','CANCELLED','EXPIRED') AND o.payment_status NOT IN ('NOT_STARTED','INITIATED','FAILED') AND o.updated_at >= $2`;
      const orders = await selectOrders(ctx.db, where, view === 'active' ? [shopId] : [shopId, start], {
        vendorView: true,
        orderBy: view === 'active' ? 'COALESCE(s.starts_at, o.estimated_ready_at, o.created_at) ASC' : 'o.updated_at DESC',
        limit: 300,
      });
      res.json({ orders, serverTime: ctx.now().toISOString() });
    }),
  );

  const orderParam = (req: any, _res: any, next: any) => {
    if (!uuid.safeParse(req.params.orderId).success) return next(new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found'));
    next();
  };
  const respondOrder = async (req: Request, res: any) => {
    const [order] = await selectOrders(ctx.db, 'o.id=$1 AND o.shop_id=$2', [req.params.orderId, vendorShopId(req)], { vendorView: true });
    res.json({ order });
  };

  r.post(
    '/vendor/orders/:orderId/accept',
    orderParam,
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const { prepMinutes } = z.object({ prepMinutes: z.number().int().min(1).max(120) }).parse(req.body ?? {});
      await withTx(ctx, (tx) => transitionOrder(ctx, tx, req.params.orderId, 'ACCEPTED', actor(req), { prepMinutes, scope: { shopId }, allowFrom: ['AWAITING_VENDOR'] }));
      await respondOrder(req, res);
    }),
  );

  r.post(
    '/vendor/orders/:orderId/reject',
    orderParam,
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const { reason } = z.object({ reason: z.string().min(1).max(200) }).parse(req.body ?? {});
      await withTx(ctx, (tx) => transitionOrder(ctx, tx, req.params.orderId, 'REJECTED', actor(req), { reason, scope: { shopId }, allowFrom: ['AWAITING_VENDOR'] }));
      await respondOrder(req, res);
    }),
  );

  // Preparing / Ready / No-show / Cancel (after acceptance, refunded). COLLECTED only via OTP or audited override.
  r.patch(
    '/vendor/orders/:orderId/status',
    orderParam,
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const b = z.object({ status: z.enum(['PREPARING', 'READY', 'NOT_COLLECTED', 'CANCELLED']), reason: z.string().min(1).max(200).optional() }).parse(req.body);
      const allowFrom: Record<string, OrderStatus[]> = { PREPARING: ['ACCEPTED'], READY: ['ACCEPTED', 'PREPARING'], NOT_COLLECTED: ['READY'], CANCELLED: ['ACCEPTED', 'PREPARING'] };
      if (b.status === 'CANCELLED' && !b.reason) throw new HttpError(400, 'REASON_REQUIRED', 'A reason is required');
      await withTx(ctx, (tx) => transitionOrder(ctx, tx, req.params.orderId, b.status, actor(req), { reason: b.reason, scope: { shopId }, allowFrom: allowFrom[b.status] }));
      await respondOrder(req, res);
    }),
  );

  r.post(
    '/vendor/orders/:orderId/verify-otp',
    orderParam,
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const { otp } = z.object({ otp: z.string().regex(/^\d{6}$/, 'Enter the 6-digit code') }).parse(req.body ?? {});
      await verifyPickupOtp(ctx, { orderId: req.params.orderId, shopId, otp, actor: actor(req) });
      await respondOrder(req, res);
    }),
  );

  r.post(
    '/vendor/orders/:orderId/collect-override',
    orderParam,
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const { reason } = z.object({ reason: z.string().trim().min(10, 'Explain why (at least 10 characters)').max(300) }).parse(req.body ?? {});
      await overrideCollection(ctx, { orderId: req.params.orderId, shopId, reason, actor: actor(req) });
      await respondOrder(req, res);
    }),
  );

  // ----- kitchen printing -----
  r.post(
    '/vendor/orders/:orderId/reprint',
    orderParam,
    asyncHandler(async (req, res) => {
      const job = await reprintOrder(ctx, { orderId: req.params.orderId, shopId: vendorShopId(req), actor: { id: req.auth!.id, role: 'VENDOR' } });
      res.status(201).json({ job });
    }),
  );

  r.get(
    '/vendor/print-jobs',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const status = z.enum(['open', 'failed', 'all']).default('open').parse(req.query.status);
      const where = status === 'open' ? `AND status IN ('PENDING','CLAIMED','FAILED')` : status === 'failed' ? `AND status='FAILED'` : '';
      const { start } = istDayRange(istDate(ctx.now()));
      const rows = await ctx.db.query(`SELECT * FROM print_jobs WHERE shop_id=$1 AND created_at >= $2 ${where} ORDER BY created_at DESC LIMIT 100`, [shopId, start]);
      res.json({ jobs: rows.map(jobView) });
    }),
  );

  r.post(
    '/vendor/print-jobs/claim',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const b = z.object({ installId, limit: z.number().int().min(1).max(10).default(5) }).parse(req.body ?? {});
      const device = await deviceFor(shopId, b.installId);
      res.json({ jobs: await claimPrintJobs(ctx, shopId, device.id, b.limit) });
    }),
  );

  r.post(
    '/vendor/print-jobs/:jobId/result',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      if (!uuid.safeParse(req.params.jobId).success) throw new HttpError(404, 'PRINT_JOB_NOT_FOUND', 'Print job not found');
      const b = z
        .object({
          installId,
          ok: z.boolean(),
          error: z.string().max(300).optional(),
          printerId: uuid.optional(),
          printerStatus: z.enum(['ONLINE', 'OFFLINE', 'PAPER_OUT', 'ERROR']).optional(),
        })
        .parse(req.body ?? {});
      const device = await deviceFor(shopId, b.installId);
      res.json(await reportPrintResult(ctx, { jobId: req.params.jobId, shopId, deviceId: device.id, ok: b.ok, error: b.error, printerId: b.printerId, printerStatus: b.printerStatus }));
    }),
  );

  r.post(
    '/vendor/print-jobs/:jobId/retry',
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.jobId).success) throw new HttpError(404, 'PRINT_JOB_NOT_FOUND', 'Print job not found');
      res.json({ job: await retryPrintJob(ctx, { jobId: req.params.jobId, shopId: vendorShopId(req), actor: { id: req.auth!.id, role: 'VENDOR' } }) });
    }),
  );

  // ----- printers -----
  const printerBody = z.object({
    name: z.string().min(1).max(60),
    model: z.string().max(80).default(''),
    connection: z.enum(['BLUETOOTH', 'NETWORK', 'SIMULATED']),
    address: z.string().max(120).default(''),
    paperWidthMm: z.union([z.literal(58), z.literal(80)]).default(80),
    autoPrint: z.boolean().default(true),
  });
  const checkAddress = (connection: string, address: string) => {
    if (connection === 'NETWORK' && !/^[A-Za-z0-9.-]+:\d{2,5}$/.test(address)) throw new HttpError(400, 'INVALID_ADDRESS', 'Use host:port, e.g. 192.168.1.50:9100');
    if (connection === 'BLUETOOTH' && !/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(address)) throw new HttpError(400, 'INVALID_ADDRESS', 'Use the Bluetooth MAC, e.g. 00:11:22:33:44:55');
  };

  r.get(
    '/vendor/printers',
    asyncHandler(async (req, res) => {
      const rows = await ctx.db.query(`SELECT * FROM printer_devices WHERE shop_id=$1 AND active=true ORDER BY created_at`, [vendorShopId(req)]);
      res.json({ printers: rows.map(printerView) });
    }),
  );

  r.post(
    '/vendor/printers',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const b = printerBody.parse(req.body);
      checkAddress(b.connection, b.address);
      const printer = await withTx(ctx, async (tx) => {
        // One active kitchen printer per shop in this MVP: adding a new one retires the old one.
        await tx.q.query(`UPDATE printer_devices SET active=false WHERE shop_id=$1 AND active=true`, [shopId]);
        const [p] = await tx.q.query(
          `INSERT INTO printer_devices (shop_id, name, model, connection, address, paper_width_mm, auto_print) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [shopId, b.name, b.model, b.connection, b.address, b.paperWidthMm, b.autoPrint],
        );
        await tx.q.query(`UPDATE print_jobs SET printer_id=$2 WHERE shop_id=$1 AND status IN ('PENDING','FAILED')`, [shopId, p.id]);
        await audit(tx.q, { id: req.auth!.id, role: 'VENDOR' }, 'PRINTER_ADDED', 'printer', p.id, { connection: b.connection });
        return p;
      });
      res.status(201).json({ printer: printerView(printer) });
    }),
  );

  r.patch(
    '/vendor/printers/:printerId',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      if (!uuid.safeParse(req.params.printerId).success) throw new HttpError(404, 'PRINTER_NOT_FOUND', 'Printer not found');
      const b = printerBody.partial().strict().parse(req.body);
      const [cur] = await ctx.db.query(`SELECT * FROM printer_devices WHERE id=$1 AND shop_id=$2`, [req.params.printerId, shopId]);
      if (!cur) throw new HttpError(404, 'PRINTER_NOT_FOUND', 'Printer not found');
      checkAddress(b.connection ?? cur.connection, b.address ?? cur.address);
      const [p] = await ctx.db.query(
        `UPDATE printer_devices SET name=$3, model=$4, connection=$5, address=$6, paper_width_mm=$7, auto_print=$8 WHERE id=$1 AND shop_id=$2 RETURNING *`,
        [cur.id, shopId, b.name ?? cur.name, b.model ?? cur.model, b.connection ?? cur.connection, b.address ?? cur.address, b.paperWidthMm ?? cur.paper_width_mm, b.autoPrint ?? cur.auto_print],
      );
      res.json({ printer: printerView(p) });
    }),
  );

  // Connection monitoring: the tablet reports what it sees (connect test, paper sensor where supported).
  r.post(
    '/vendor/printers/:printerId/status',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      if (!uuid.safeParse(req.params.printerId).success) throw new HttpError(404, 'PRINTER_NOT_FOUND', 'Printer not found');
      const b = z.object({ status: z.enum(['ONLINE', 'OFFLINE', 'PAPER_OUT', 'ERROR']), error: z.string().max(300).optional() }).parse(req.body);
      const rows = await ctx.db.query(`UPDATE printer_devices SET status=$3, last_error=$4, last_status_at=$5 WHERE id=$1 AND shop_id=$2 RETURNING *`, [
        req.params.printerId,
        shopId,
        b.status,
        b.status === 'ONLINE' ? null : (b.error ?? null),
        ctx.now(),
      ]);
      if (!rows[0]) throw new HttpError(404, 'PRINTER_NOT_FOUND', 'Printer not found');
      res.json({ printer: printerView(rows[0]) });
    }),
  );

  // ----- tablets -----
  r.post(
    '/vendor/devices/register',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const b = z.object({ installId, platform: z.string().max(30).default('web'), model: z.string().max(80).default(''), appVersion: z.string().max(30).optional() }).parse(req.body);
      const device = await withTx(ctx, async (tx) => {
        const [d] = await tx.q.query(`SELECT * FROM vendor_devices WHERE install_id=$1 FOR UPDATE`, [b.installId]);
        if (d && d.shop_id && d.shop_id !== shopId) throw new HttpError(409, 'DEVICE_ASSIGNED_ELSEWHERE', 'This tablet is assigned to another shop. Ask QuickPick to reassign it.');
        if (d) {
          const [u] = await tx.q.query(
            `UPDATE vendor_devices SET shop_id=$2, platform=$3, model=COALESCE(NULLIF($4,''), model), app_version=$5, last_seen_at=$6, status='LOANED', assigned_at=COALESCE(assigned_at,$6) WHERE id=$1 RETURNING *`,
            [d.id, shopId, b.platform, b.model, b.appVersion ?? null, ctx.now()],
          );
          return u;
        }
        const [n] = await tx.q.query(
          `INSERT INTO vendor_devices (install_id, shop_id, platform, model, app_version, status, last_seen_at, assigned_at) VALUES ($1,$2,$3,$4,$5,'LOANED',$6,$6) RETURNING *`,
          [b.installId, shopId, b.platform, b.model, b.appVersion ?? null, ctx.now()],
        );
        await audit(tx.q, { id: req.auth!.id, role: 'VENDOR' }, 'DEVICE_SELF_REGISTERED', 'device', n.id, { platform: b.platform });
        return n;
      });
      res.json({ device: { id: device.id, assetTag: device.asset_tag, platform: device.platform } });
    }),
  );

  r.post(
    '/vendor/heartbeat',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const b = z.object({ installId: installId.optional() }).parse(req.body ?? {});
      if (b.installId) await ctx.db.query(`UPDATE vendor_devices SET last_seen_at=$3 WHERE install_id=$1 AND shop_id=$2`, [b.installId, shopId, ctx.now()]);
      const [{ open }] = await ctx.db.query<{ open: number }>(
        `SELECT COUNT(*)::int AS open FROM print_jobs WHERE shop_id=$1 AND status IN ('PENDING','FAILED')`,
        [shopId],
      );
      res.json({ ok: true, serverTime: ctx.now().toISOString(), openPrintJobs: Number(open) });
    }),
  );

  // ----- menu & availability (own shop only) -----
  r.patch(
    '/vendor/menu-items/:itemId',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      if (!uuid.safeParse(req.params.itemId).success) throw new HttpError(404, 'ITEM_NOT_FOUND', 'Item not found');
      const b = z
        .object({
          available: z.boolean(),
          name: z.string().min(1).max(100),
          description: z.string().max(300),
          basePricePaise: z.number().int().min(0).max(10_000_000),
          diet: z.enum(['VEG', 'NON_VEG', 'EGG']).nullable(),
        })
        .partial()
        .strict()
        .parse(req.body);
      const cols: Record<string, string> = { available: 'available', name: 'name', description: 'description', basePricePaise: 'base_price_paise', diet: 'diet' };
      const sets: string[] = [];
      const params: unknown[] = [req.params.itemId, shopId];
      for (const [k, v] of Object.entries(b)) {
        params.push(v);
        sets.push(`${cols[k]}=$${params.length}`);
      }
      if (!sets.length) throw new HttpError(400, 'NO_CHANGES', 'Nothing to update');
      const rows = await withTx(ctx, async (tx) => {
        const u = await tx.q.query(`UPDATE menu_items SET ${sets.join(', ')} WHERE id=$1 AND shop_id=$2 RETURNING id, available, base_price_paise`, params);
        if (!u[0]) throw new HttpError(404, 'ITEM_NOT_FOUND', 'Item not found');
        if (b.basePricePaise !== undefined || b.name !== undefined) await audit(tx.q, { id: req.auth!.id, role: 'VENDOR' }, 'MENU_ITEM_UPDATED', 'menu_item', u[0].id, b);
        return u;
      });
      res.json({ item: { id: rows[0].id, available: rows[0].available, basePricePaise: Number(rows[0].base_price_paise) } });
    }),
  );

  r.post(
    '/vendor/menu-items',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const b = z
        .object({
          name: z.string().min(1).max(100),
          description: z.string().max(300).default(''),
          basePricePaise: z.number().int().min(0).max(10_000_000),
          categoryId: uuid.nullable().default(null),
          diet: z.enum(['VEG', 'NON_VEG', 'EGG']).nullable().default(null),
        })
        .parse(req.body);
      if (b.categoryId) {
        const c = await ctx.db.query(`SELECT 1 FROM menu_categories WHERE id=$1 AND shop_id=$2`, [b.categoryId, shopId]);
        if (!c[0]) throw new HttpError(404, 'CATEGORY_NOT_FOUND', 'Category not found');
      }
      const item = await withTx(ctx, async (tx) => {
        const [i] = await tx.q.query(
          `INSERT INTO menu_items (shop_id, category_id, name, description, base_price_paise, diet) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name`,
          [shopId, b.categoryId, b.name, b.description, b.basePricePaise, b.diet],
        );
        await audit(tx.q, { id: req.auth!.id, role: 'VENDOR' }, 'MENU_ITEM_CREATED', 'menu_item', i.id, { basePricePaise: b.basePricePaise });
        return i;
      });
      res.status(201).json({ item });
    }),
  );

  r.patch(
    '/vendor/modifiers/:modifierId',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      if (!uuid.safeParse(req.params.modifierId).success) throw new HttpError(404, 'MODIFIER_NOT_FOUND', 'Option not found');
      const { available } = z.object({ available: z.boolean() }).parse(req.body);
      const rows = await ctx.db.query(
        `UPDATE menu_item_modifiers m SET available=$3 FROM menu_items i WHERE m.id=$1 AND i.id=m.menu_item_id AND i.shop_id=$2 RETURNING m.id, m.available`,
        [req.params.modifierId, shopId, available],
      );
      if (!rows[0]) throw new HttpError(404, 'MODIFIER_NOT_FOUND', 'Option not found');
      res.json({ modifier: rows[0] });
    }),
  );

  r.patch(
    '/vendor/shop/status',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const b = z.object({ acceptingOrders: z.boolean().optional(), walkinEnabled: z.boolean().optional(), preorderEnabled: z.boolean().optional() }).parse(req.body);
      const [s] = await ctx.db.query(
        `UPDATE shops SET accepting_orders=COALESCE($2, accepting_orders), walkin_enabled=COALESCE($3, walkin_enabled), preorder_enabled=COALESCE($4, preorder_enabled), updated_at=now()
          WHERE id=$1 RETURNING accepting_orders, walkin_enabled, preorder_enabled`,
        [shopId, b.acceptingOrders ?? null, b.walkinEnabled ?? null, b.preorderEnabled ?? null],
      );
      res.json({ shopId, acceptingOrders: s.accepting_orders, walkinEnabled: s.walkin_enabled, preorderEnabled: s.preorder_enabled });
    }),
  );

  // ----- reports (own shop only) -----
  r.get(
    '/vendor/summary',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const { start, end } = istDayRange(istDate(ctx.now()));
      const rows = await ctx.db.query(
        `SELECT order_source,
                COUNT(*) FILTER (WHERE status='COLLECTED')::int AS collected,
                COUNT(*) FILTER (WHERE status IN ('REJECTED','CANCELLED','EXPIRED') AND payment_status NOT IN ('NOT_STARTED','INITIATED','FAILED'))::int AS not_fulfilled,
                COALESCE(SUM(subtotal_paise) FILTER (WHERE status='COLLECTED'),0)::bigint AS food_paise
           FROM orders WHERE shop_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY order_source`,
        [shopId, start, end],
      );
      const by = (s: string) => rows.find((r2: any) => r2.order_source === s) ?? { collected: 0, not_fulfilled: 0, food_paise: 0 };
      const total = (k: string) => rows.reduce((n: number, r2: any) => n + Number(r2[k]), 0);
      res.json({
        date: istDate(ctx.now()),
        collectedOrders: total('collected'),
        notFulfilled: total('not_fulfilled'),
        foodValuePaise: total('food_paise'),
        bySource: { PREORDER: { collected: Number(by('PREORDER').collected), foodValuePaise: Number(by('PREORDER').food_paise) }, WALKIN_QR: { collected: Number(by('WALKIN_QR').collected), foodValuePaise: Number(by('WALKIN_QR').food_paise) } },
        tzOffsetMs: IST_OFFSET_MS,
      });
    }),
  );

  // Vendor settlement statement: planned vendor entitlement per day (original menu price). Illustrative until settlement is live.
  r.get(
    '/vendor/settlements',
    asyncHandler(async (req, res) => {
      const shopId = vendorShopId(req);
      const rows = await ctx.db.query(
        `SELECT to_char(o.created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS day,
                COUNT(*)::bigint AS orders,
                COALESCE(SUM(ps.amount_paise) FILTER (WHERE ps.status <> 'REVERSED'),0)::bigint AS entitlement_paise
           FROM payment_splits ps JOIN orders o ON o.id=ps.order_id
          WHERE ps.beneficiary_type='VENDOR' AND ps.shop_id=$1
          GROUP BY 1 ORDER BY 1 DESC LIMIT 31`,
        [shopId],
      );
      const statements = await ctx.db.query(`SELECT * FROM settlements WHERE shop_id=$1 ORDER BY period_start DESC LIMIT 31`, [shopId]);
      res.json({
        note: 'Planned entitlement from sandbox orders. No real settlement has occurred.',
        days: rows.map((d: any) => ({ day: d.day, orders: Number(d.orders), entitlementPaise: Number(d.entitlement_paise) })),
        statements: statements.map((s: any) => ({ id: s.id, periodStart: s.period_start, periodEnd: s.period_end, orders: s.order_count, netPaise: Number(s.net_paise), status: s.status })),
      });
    }),
  );

  return r;
}
