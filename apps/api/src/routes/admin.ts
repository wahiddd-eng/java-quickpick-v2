import crypto from 'node:crypto';
import { Router } from 'express';
import QRCode from 'qrcode';
import { z } from 'zod';
import { asyncHandler, hashPassword, requireRole } from '../auth.js';
import { HttpError, audit, istDate, istDayRange, withTx, type AppContext } from '../context.js';
import { initiateRefund } from '../services/ledger.js';
import { loadMenu } from '../services/menu.js';
import { selectOrders } from '../services/orders.js';
import { overrideCollection } from '../services/otp.js';
import { reconcilePayments } from '../services/payments.js';
import { policyRowToView } from '../services/pricing.js';
import { resetUnbookedSlots } from '../services/slots.js';

const uuid = z.string().uuid();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const toMins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
function checkHours(open: string, close: string, slotMinutes: number) {
  if (toMins(close) <= toMins(open)) throw new HttpError(400, 'INVALID_HOURS', 'Closing time must be after opening time.');
  if (toMins(close) - toMins(open) < slotMinutes) throw new HttpError(400, 'INVALID_HOURS', 'Opening hours must be at least one pickup slot long.');
}

const QR_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const newQrToken = () => Array.from({ length: 12 }, () => QR_ALPHABET[crypto.randomInt(QR_ALPHABET.length)]).join('');

const shopFields = {
  code: z.string().regex(/^[A-Z0-9-]{2,12}$/, 'Use 2–12 capital letters, digits or dashes'),
  name: z.string().min(1).max(100),
  description: z.string().max(500),
  logoUrl: z.string().url().max(500).nullable(),
  cuisineTags: z.string().max(200),
  vendorId: uuid.nullable(),
  openTime: hhmm,
  closeTime: hhmm,
  slotMinutes: z.number().int().min(5).max(60),
  slotCapacity: z.number().int().min(0).max(100),
  avgPrepMinutes: z.number().int().min(1).max(120),
  kitchenParallel: z.number().int().min(1).max(20),
  acceptTimeoutSeconds: z.number().int().min(10).max(900),
  fssaiNumber: z.string().max(40).nullable(),
  ownerContact: z.string().max(200).nullable(),
  status: z.enum(['DRAFT', 'ACTIVE', 'SUSPENDED']),
  acceptingOrders: z.boolean(),
  preorderEnabled: z.boolean(),
  walkinEnabled: z.boolean(),
  isDemo: z.boolean(),
};
const SHOP_COLS: Record<string, string> = {
  code: 'code', name: 'name', description: 'description', logoUrl: 'logo_url', cuisineTags: 'cuisine_tags', vendorId: 'vendor_id', openTime: 'open_time', closeTime: 'close_time',
  slotMinutes: 'slot_minutes', slotCapacity: 'slot_capacity', avgPrepMinutes: 'avg_prep_minutes', kitchenParallel: 'kitchen_parallel', acceptTimeoutSeconds: 'accept_timeout_seconds',
  fssaiNumber: 'fssai_number', ownerContact: 'owner_contact', status: 'status', acceptingOrders: 'accepting_orders', preorderEnabled: 'preorder_enabled', walkinEnabled: 'walkin_enabled', isDemo: 'is_demo',
};

const shopRow = (s: any) => ({
  id: s.id,
  code: s.code,
  name: s.name,
  description: s.description,
  logoUrl: s.logo_url,
  cuisineTags: s.cuisine_tags,
  vendorId: s.vendor_id,
  vendorName: s.vendor_name ?? null,
  status: s.status,
  acceptingOrders: s.accepting_orders,
  preorderEnabled: s.preorder_enabled,
  walkinEnabled: s.walkin_enabled,
  openTime: s.open_time,
  closeTime: s.close_time,
  slotMinutes: s.slot_minutes,
  slotCapacity: s.slot_capacity,
  avgPrepMinutes: s.avg_prep_minutes,
  kitchenParallel: s.kitchen_parallel,
  acceptTimeoutSeconds: s.accept_timeout_seconds,
  fssaiNumber: s.fssai_number,
  ownerContact: s.owner_contact,
  qrVersion: s.qr_version,
  isDemo: s.is_demo,
});

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const PAID = `('AWAITING_VENDOR','ACCEPTED','PREPARING','READY','COLLECTED','NOT_COLLECTED')`;

export function adminRoutes(ctx: AppContext): Router {
  const r = Router();
  r.use('/admin', requireRole(ctx, 'ADMIN'));
  const actor = (req: any) => ({ id: req.auth.id, role: req.auth.role });
  const qrUrl = (token: string) => `${ctx.config.studentAppUrl}/s/${token}`;
  const updateCols = (b: Record<string, unknown>, cols: Record<string, string>, first: unknown[]) => {
    const sets: string[] = [];
    const params = [...first];
    for (const [k, v] of Object.entries(b)) {
      params.push(v);
      sets.push(`${cols[k]}=$${params.length}`);
    }
    return { sets, params };
  };

  // ----- shops -----
  r.get(
    '/admin/shops',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.query(`SELECT s.*, v.legal_name AS vendor_name FROM shops s LEFT JOIN vendors v ON v.id=s.vendor_id ORDER BY s.code`);
      res.json({ shops: rows.map(shopRow) });
    }),
  );

  r.post(
    '/admin/shops',
    asyncHandler(async (req, res) => {
      const b = z
        .object({
          code: shopFields.code,
          name: shopFields.name,
          description: shopFields.description.default(''),
          logoUrl: shopFields.logoUrl.default(null),
          cuisineTags: shopFields.cuisineTags.default(''),
          vendorId: shopFields.vendorId.default(null),
          openTime: shopFields.openTime.default('11:30'),
          closeTime: shopFields.closeTime.default('15:00'),
          slotMinutes: shopFields.slotMinutes.default(10),
          slotCapacity: shopFields.slotCapacity.default(5),
          avgPrepMinutes: shopFields.avgPrepMinutes.default(10),
          kitchenParallel: shopFields.kitchenParallel.default(2),
          acceptTimeoutSeconds: shopFields.acceptTimeoutSeconds.default(90),
          fssaiNumber: shopFields.fssaiNumber.default(null),
          ownerContact: shopFields.ownerContact.default(null),
          preorderEnabled: shopFields.preorderEnabled.default(true),
          walkinEnabled: shopFields.walkinEnabled.default(true),
          isDemo: shopFields.isDemo.default(false),
        })
        .parse(req.body);
      checkHours(b.openTime, b.closeTime, b.slotMinutes);
      const dup = await ctx.db.query(`SELECT 1 FROM shops WHERE code=$1`, [b.code]);
      if (dup[0]) throw new HttpError(409, 'SHOP_CODE_IN_USE', 'Another shop already uses this code');
      const shop = await withTx(ctx, async (tx) => {
        const [s] = await tx.q.query(
          `INSERT INTO shops (code, qr_token, name, description, logo_url, cuisine_tags, vendor_id, open_time, close_time, slot_minutes, slot_capacity, avg_prep_minutes,
             kitchen_parallel, accept_timeout_seconds, fssai_number, owner_contact, preorder_enabled, walkin_enabled, is_demo)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
          [
            b.code, newQrToken(), b.name, b.description, b.logoUrl, b.cuisineTags, b.vendorId, b.openTime, b.closeTime, b.slotMinutes, b.slotCapacity, b.avgPrepMinutes,
            b.kitchenParallel, b.acceptTimeoutSeconds, b.fssaiNumber, b.ownerContact, b.preorderEnabled, b.walkinEnabled, b.isDemo,
          ],
        );
        await audit(tx.q, actor(req), 'SHOP_CREATED', 'shop', s.id, { name: b.name, code: b.code });
        return s;
      });
      res.status(201).json({ shop: shopRow(shop) });
    }),
  );

  r.patch(
    '/admin/shops/:shopId',
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.shopId).success) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
      const b = z.object(shopFields).partial().strict().parse(req.body);
      const { sets, params } = updateCols(b, SHOP_COLS, [req.params.shopId]);
      if (sets.length === 0) throw new HttpError(400, 'NO_CHANGES', 'Nothing to update');
      const hoursChanged = b.openTime !== undefined || b.closeTime !== undefined || b.slotMinutes !== undefined;
      const shop = await withTx(ctx, async (tx) => {
        const rows = await tx.q.query(`UPDATE shops SET ${sets.join(', ')}, updated_at=now() WHERE id=$1 RETURNING *`, params);
        if (!rows[0]) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
        if (hoursChanged) {
          checkHours(rows[0].open_time, rows[0].close_time, rows[0].slot_minutes);
          await resetUnbookedSlots(ctx, tx.q, req.params.shopId);
        }
        if (b.slotCapacity !== undefined) {
          await tx.q.query(`UPDATE pickup_slots SET capacity=$2 WHERE shop_id=$1 AND starts_at > $3 AND reserved_count <= $2`, [req.params.shopId, b.slotCapacity, ctx.now()]);
        }
        await audit(tx.q, actor(req), 'SHOP_UPDATED', 'shop', req.params.shopId, b);
        return rows[0];
      });
      res.json({ shop: shopRow(shop) });
    }),
  );

  // ----- shop QR codes -----
  r.get(
    '/admin/shops/:shopId/qr',
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.shopId).success) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
      const [s] = await ctx.db.query(`SELECT * FROM shops WHERE id=$1`, [req.params.shopId]);
      if (!s) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
      const url = qrUrl(s.qr_token);
      const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
      res.json({ shopId: s.id, code: s.code, name: s.name, url, version: s.qr_version, svg });
    }),
  );

  r.post(
    '/admin/shops/:shopId/qr/regenerate',
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.shopId).success) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
      const s = await withTx(ctx, async (tx) => {
        const [row] = await tx.q.query(`UPDATE shops SET qr_token=$2, qr_version=qr_version+1, updated_at=now() WHERE id=$1 RETURNING *`, [req.params.shopId, newQrToken()]);
        if (!row) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
        await audit(tx.q, actor(req), 'SHOP_QR_REGENERATED', 'shop', row.id, { version: row.qr_version });
        return row;
      });
      res.json({ url: qrUrl(s.qr_token), version: s.qr_version, note: 'Previously printed QR codes for this shop no longer work. Print and display the new one.' });
    }),
  );

  // ----- vendor businesses (payees) -----
  const vendorRow = (v: any) => ({ id: v.id, legalName: v.legal_name, contactName: v.contact_name, contactPhone: v.contact_phone, contactEmail: v.contact_email, payoutStatus: v.payout_status, providerVendorRef: v.provider_vendor_ref, shops: v.shops ?? [] });
  r.get(
    '/admin/vendors',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.query(
        `SELECT v.*, COALESCE((SELECT json_agg(json_build_object('id', s.id, 'name', s.name, 'code', s.code)) FROM shops s WHERE s.vendor_id=v.id), '[]'::json) AS shops FROM vendors v ORDER BY v.legal_name`,
      );
      res.json({ vendors: rows.map(vendorRow) });
    }),
  );
  const vendorBody = z.object({
    legalName: z.string().min(1).max(150),
    contactName: z.string().max(100).default(''),
    contactPhone: z.string().max(20).nullable().default(null),
    contactEmail: z.string().email().nullable().default(null),
    payoutStatus: z.enum(['NOT_STARTED', 'PENDING_KYC', 'ACTIVE', 'SUSPENDED']).default('NOT_STARTED'),
  });
  r.post(
    '/admin/vendors',
    asyncHandler(async (req, res) => {
      const b = vendorBody.parse(req.body);
      const v = await withTx(ctx, async (tx) => {
        const [row] = await tx.q.query(
          `INSERT INTO vendors (legal_name, contact_name, contact_phone, contact_email, payout_status) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
          [b.legalName, b.contactName, b.contactPhone, b.contactEmail, b.payoutStatus],
        );
        await audit(tx.q, actor(req), 'VENDOR_CREATED', 'vendor', row.id, { legalName: b.legalName });
        return row;
      });
      res.status(201).json({ vendor: vendorRow(v) });
    }),
  );
  r.patch(
    '/admin/vendors/:vendorId',
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.vendorId).success) throw new HttpError(404, 'VENDOR_NOT_FOUND', 'Vendor not found');
      const b = vendorBody.partial().strict().parse(req.body);
      const cols = { legalName: 'legal_name', contactName: 'contact_name', contactPhone: 'contact_phone', contactEmail: 'contact_email', payoutStatus: 'payout_status' };
      const { sets, params } = updateCols(b, cols, [req.params.vendorId]);
      if (!sets.length) throw new HttpError(400, 'NO_CHANGES', 'Nothing to update');
      const v = await withTx(ctx, async (tx) => {
        const [row] = await tx.q.query(`UPDATE vendors SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, params);
        if (!row) throw new HttpError(404, 'VENDOR_NOT_FOUND', 'Vendor not found');
        await audit(tx.q, actor(req), 'VENDOR_UPDATED', 'vendor', row.id, b);
        return row;
      });
      res.json({ vendor: vendorRow(v) });
    }),
  );

  // ----- vendor staff logins -----
  r.post(
    '/admin/vendor-users',
    asyncHandler(async (req, res) => {
      const b = z
        .object({ name: z.string().min(1).max(80), email: z.string().email(), password: z.string().min(8).max(100), shopId: uuid, memberRole: z.enum(['OWNER', 'MANAGER', 'STAFF']).default('OWNER') })
        .parse(req.body);
      const out = await withTx(ctx, async (tx) => {
        const shops = await tx.q.query(`SELECT id FROM shops WHERE id=$1`, [b.shopId]);
        if (!shops[0]) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
        const dup = await tx.q.query(`SELECT id FROM users WHERE email=$1`, [b.email.toLowerCase()]);
        if (dup[0]) throw new HttpError(409, 'EMAIL_IN_USE', 'A user with this email already exists');
        const [u] = await tx.q.query(`INSERT INTO users (name, email, role, password_hash) VALUES ($1,$2,'VENDOR',$3) RETURNING id, name, email`, [
          b.name,
          b.email.toLowerCase(),
          await hashPassword(b.password),
        ]);
        await tx.q.query(`INSERT INTO shop_members (user_id, shop_id, role) VALUES ($1,$2,$3)`, [u.id, b.shopId, b.memberRole]);
        await audit(tx.q, actor(req), 'VENDOR_USER_CREATED', 'user', u.id, { shopId: b.shopId });
        return u;
      });
      res.status(201).json({ user: out });
    }),
  );

  r.get(
    '/admin/vendor-users',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.query(
        `SELECT u.id, u.name, u.email, u.status, sm.shop_id, sm.role AS member_role, s.name AS shop_name
           FROM users u JOIN shop_members sm ON sm.user_id=u.id JOIN shops s ON s.id=sm.shop_id WHERE u.role='VENDOR' ORDER BY s.name, u.name`,
      );
      res.json({ users: rows.map((v: any) => ({ id: v.id, name: v.name, email: v.email, status: v.status, shopId: v.shop_id, shopName: v.shop_name, memberRole: v.member_role })) });
    }),
  );

  // ----- menu -----
  r.get(
    '/admin/shops/:shopId/menu',
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.shopId).success) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
      res.json(await loadMenu(ctx.db, req.params.shopId, { includeInactiveCategories: true }));
    }),
  );

  r.post(
    '/admin/shops/:shopId/categories',
    asyncHandler(async (req, res) => {
      const b = z.object({ name: z.string().min(1).max(60), sortOrder: z.number().int().default(0) }).parse(req.body);
      if (!uuid.safeParse(req.params.shopId).success) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
      const rows = await withTx(ctx, async (tx) => {
        const r2 = await tx.q.query(`INSERT INTO menu_categories (shop_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id, name`, [req.params.shopId, b.name, b.sortOrder]);
        await audit(tx.q, actor(req), 'CATEGORY_CREATED', 'category', r2[0].id, { shopId: req.params.shopId });
        return r2;
      });
      res.status(201).json({ category: rows[0] });
    }),
  );

  const itemFields = {
    name: z.string().min(1).max(100),
    description: z.string().max(300),
    basePricePaise: z.number().int().min(0).max(10_000_000),
    categoryId: uuid.nullable(),
    diet: z.enum(['VEG', 'NON_VEG', 'EGG']).nullable(),
    imageUrl: z.string().url().max(500).nullable(),
    available: z.boolean(),
    sortOrder: z.number().int(),
  };
  r.post(
    '/admin/shops/:shopId/menu-items',
    asyncHandler(async (req, res) => {
      const b = z
        .object({
          name: itemFields.name,
          description: itemFields.description.default(''),
          basePricePaise: itemFields.basePricePaise,
          categoryId: itemFields.categoryId.default(null),
          diet: itemFields.diet.default(null),
          imageUrl: itemFields.imageUrl.default(null),
        })
        .parse(req.body);
      if (!uuid.safeParse(req.params.shopId).success) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
      const item = await withTx(ctx, async (tx) => {
        const rows = await tx.q.query(
          `INSERT INTO menu_items (shop_id, category_id, name, description, base_price_paise, diet, image_url) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, base_price_paise`,
          [req.params.shopId, b.categoryId, b.name, b.description, b.basePricePaise, b.diet, b.imageUrl],
        );
        await audit(tx.q, actor(req), 'MENU_ITEM_CREATED', 'menu_item', rows[0].id, { shopId: req.params.shopId, basePricePaise: b.basePricePaise });
        return rows[0];
      });
      res.status(201).json({ item: { id: item.id, name: item.name, basePricePaise: Number(item.base_price_paise) } });
    }),
  );

  // Price edits never touch existing orders: orders carry their own item/price/modifier snapshot.
  r.patch(
    '/admin/menu-items/:itemId',
    asyncHandler(async (req, res) => {
      const b = z.object(itemFields).partial().strict().parse(req.body);
      if (!uuid.safeParse(req.params.itemId).success) throw new HttpError(404, 'ITEM_NOT_FOUND', 'Item not found');
      const cols = { name: 'name', description: 'description', basePricePaise: 'base_price_paise', categoryId: 'category_id', diet: 'diet', imageUrl: 'image_url', available: 'available', sortOrder: 'sort_order' };
      const { sets, params } = updateCols(b, cols, [req.params.itemId]);
      if (!sets.length) throw new HttpError(400, 'NO_CHANGES', 'Nothing to update');
      const item = await withTx(ctx, async (tx) => {
        const rows = await tx.q.query(`UPDATE menu_items SET ${sets.join(', ')} WHERE id=$1 RETURNING id, name, base_price_paise, available`, params);
        if (!rows[0]) throw new HttpError(404, 'ITEM_NOT_FOUND', 'Item not found');
        await audit(tx.q, actor(req), 'MENU_ITEM_UPDATED', 'menu_item', req.params.itemId, b);
        return rows[0];
      });
      res.json({ item: { id: item.id, name: item.name, basePricePaise: Number(item.base_price_paise), available: item.available } });
    }),
  );

  const modifierFields = {
    groupName: z.string().min(1).max(60),
    name: z.string().min(1).max(80),
    pricePaise: z.number().int().min(0).max(1_000_000),
    selection: z.enum(['ONE', 'MANY']),
    required: z.boolean(),
    available: z.boolean(),
    sortOrder: z.number().int(),
  };
  r.post(
    '/admin/menu-items/:itemId/modifiers',
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.itemId).success) throw new HttpError(404, 'ITEM_NOT_FOUND', 'Item not found');
      const b = z
        .object({ ...modifierFields, pricePaise: modifierFields.pricePaise.default(0), selection: modifierFields.selection.default('MANY'), required: modifierFields.required.default(false), available: modifierFields.available.default(true), sortOrder: modifierFields.sortOrder.default(0) })
        .parse(req.body);
      const m = await withTx(ctx, async (tx) => {
        const [item] = await tx.q.query(`SELECT id FROM menu_items WHERE id=$1`, [req.params.itemId]);
        if (!item) throw new HttpError(404, 'ITEM_NOT_FOUND', 'Item not found');
        // Keep a group consistent: every option in a group shares its selection rule and required flag.
        await tx.q.query(`UPDATE menu_item_modifiers SET selection=$3, required=$4 WHERE menu_item_id=$1 AND group_name=$2`, [item.id, b.groupName, b.selection, b.required]);
        const [row] = await tx.q.query(
          `INSERT INTO menu_item_modifiers (menu_item_id, group_name, name, price_paise, selection, required, available, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
          [item.id, b.groupName, b.name, b.pricePaise, b.selection, b.required, b.available, b.sortOrder],
        );
        await audit(tx.q, actor(req), 'MODIFIER_CREATED', 'modifier', row.id, { itemId: item.id, pricePaise: b.pricePaise });
        return row;
      });
      res.status(201).json({ modifier: { id: m.id, group: m.group_name, name: m.name, pricePaise: Number(m.price_paise) } });
    }),
  );

  r.patch(
    '/admin/modifiers/:modifierId',
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.modifierId).success) throw new HttpError(404, 'MODIFIER_NOT_FOUND', 'Option not found');
      const b = z.object({ name: modifierFields.name, pricePaise: modifierFields.pricePaise, available: modifierFields.available, sortOrder: modifierFields.sortOrder }).partial().strict().parse(req.body);
      const { sets, params } = updateCols(b, { name: 'name', pricePaise: 'price_paise', available: 'available', sortOrder: 'sort_order' }, [req.params.modifierId]);
      if (!sets.length) throw new HttpError(400, 'NO_CHANGES', 'Nothing to update');
      const [m] = await ctx.db.query(`UPDATE menu_item_modifiers SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, params);
      if (!m) throw new HttpError(404, 'MODIFIER_NOT_FOUND', 'Option not found');
      res.json({ modifier: { id: m.id, name: m.name, pricePaise: Number(m.price_paise), available: m.available } });
    }),
  );

  // ----- tablets (QuickPick property) and printers -----
  r.get(
    '/admin/devices',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.query(`SELECT d.*, s.name AS shop_name FROM vendor_devices d LEFT JOIN shops s ON s.id=d.shop_id ORDER BY d.asset_tag NULLS LAST, d.created_at`);
      const now = ctx.now().getTime();
      res.json({
        devices: rows.map((d: any) => ({
          id: d.id, assetTag: d.asset_tag, installId: d.install_id, model: d.model, platform: d.platform, appVersion: d.app_version, status: d.status, shopId: d.shop_id, shopName: d.shop_name,
          conditionNotes: d.condition_notes, lastSeenAt: d.last_seen_at, assignedAt: d.assigned_at, returnedAt: d.returned_at,
          online: d.last_seen_at ? now - new Date(d.last_seen_at).getTime() < 90_000 : false,
        })),
      });
    }),
  );

  r.post(
    '/admin/devices',
    asyncHandler(async (req, res) => {
      const b = z.object({ assetTag: z.string().min(1).max(40), model: z.string().max(100).default(''), conditionNotes: z.string().max(300).default('') }).parse(req.body);
      const dup = await ctx.db.query(`SELECT 1 FROM vendor_devices WHERE asset_tag=$1`, [b.assetTag]);
      if (dup[0]) throw new HttpError(409, 'ASSET_TAG_IN_USE', 'Asset tag already registered');
      const device = await withTx(ctx, async (tx) => {
        const rows = await tx.q.query(`INSERT INTO vendor_devices (asset_tag, model, condition_notes) VALUES ($1,$2,$3) RETURNING *`, [b.assetTag, b.model, b.conditionNotes]);
        await audit(tx.q, actor(req), 'DEVICE_REGISTERED', 'device', rows[0].id, { assetTag: b.assetTag });
        return rows[0];
      });
      res.status(201).json({ device: { id: device.id, assetTag: device.asset_tag } });
    }),
  );

  // A device belongs to at most one shop at a time. shopId=null records a return.
  r.post(
    '/admin/devices/assign',
    asyncHandler(async (req, res) => {
      const b = z.object({ deviceId: uuid, shopId: uuid.nullable(), conditionNotes: z.string().max(300).optional(), assetTag: z.string().min(1).max(40).optional() }).parse(req.body);
      const device = await withTx(ctx, async (tx) => {
        const rows = await tx.q.query(`SELECT * FROM vendor_devices WHERE id=$1 FOR UPDATE`, [b.deviceId]);
        if (!rows[0]) throw new HttpError(404, 'DEVICE_NOT_FOUND', 'Device not found');
        if (b.shopId) {
          const shop = await tx.q.query(`SELECT 1 FROM shops WHERE id=$1`, [b.shopId]);
          if (!shop[0]) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
        }
        const updated = b.shopId
          ? await tx.q.query(
              `UPDATE vendor_devices SET shop_id=$2, status='LOANED', assigned_at=$3, returned_at=NULL, condition_notes=COALESCE($4, condition_notes), asset_tag=COALESCE($5, asset_tag) WHERE id=$1 RETURNING *`,
              [b.deviceId, b.shopId, ctx.now(), b.conditionNotes ?? null, b.assetTag ?? null],
            )
          : await tx.q.query(`UPDATE vendor_devices SET shop_id=NULL, status='RETURNED', returned_at=$2, condition_notes=COALESCE($3, condition_notes) WHERE id=$1 RETURNING *`, [
              b.deviceId,
              ctx.now(),
              b.conditionNotes ?? null,
            ]);
        await audit(tx.q, actor(req), b.shopId ? 'DEVICE_ASSIGNED' : 'DEVICE_RETURNED', 'device', b.deviceId, { shopId: b.shopId });
        return updated[0];
      });
      res.json({ device: { id: device.id, assetTag: device.asset_tag, shopId: device.shop_id, status: device.status } });
    }),
  );

  // Printer health across shops, with today's slip counts.
  r.get(
    '/admin/printers',
    asyncHandler(async (_req, res) => {
      const { start } = istDayRange(istDate(ctx.now()));
      const rows = await ctx.db.query(
        `SELECT p.*, s.name AS shop_name, s.code AS shop_code,
                (SELECT COUNT(*)::int FROM print_jobs j WHERE j.shop_id=p.shop_id AND j.status='PRINTED' AND j.created_at >= $1) AS printed_today,
                (SELECT COUNT(*)::int FROM print_jobs j WHERE j.shop_id=p.shop_id AND j.status IN ('PENDING','CLAIMED')) AS waiting,
                (SELECT COUNT(*)::int FROM print_jobs j WHERE j.shop_id=p.shop_id AND j.status='FAILED') AS failed
           FROM printer_devices p JOIN shops s ON s.id=p.shop_id WHERE p.active=true ORDER BY s.code`,
        [start],
      );
      const now = ctx.now().getTime();
      res.json({
        printers: rows.map((p: any) => ({
          id: p.id, shopId: p.shop_id, shopName: p.shop_name, shopCode: p.shop_code, name: p.name, model: p.model, connection: p.connection, address: p.address, paperWidthMm: p.paper_width_mm,
          status: p.status, lastError: p.last_error, lastStatusAt: p.last_status_at, stale: !p.last_status_at || now - new Date(p.last_status_at).getTime() > 10 * 60_000,
          printedToday: p.printed_today, waiting: p.waiting, failed: p.failed,
        })),
      });
    }),
  );

  // ----- orders, payments, refunds -----
  r.get(
    '/admin/orders',
    asyncHandler(async (req, res) => {
      const q = z.object({ status: z.string().optional(), shopId: uuid.optional(), source: z.enum(['PREORDER', 'WALKIN_QR']).optional(), date: date.optional() }).parse(req.query);
      const where: string[] = ['TRUE'];
      const params: unknown[] = [];
      if (q.status) { params.push(q.status); where.push(`o.status=$${params.length}`); }
      if (q.shopId) { params.push(q.shopId); where.push(`o.shop_id=$${params.length}`); }
      if (q.source) { params.push(q.source); where.push(`o.order_source=$${params.length}`); }
      if (q.date) { const d = istDayRange(q.date); params.push(d.start, d.end); where.push(`o.created_at >= $${params.length - 1} AND o.created_at < $${params.length}`); }
      res.json({ orders: await selectOrders(ctx.db, where.join(' AND '), params, { limit: 200 }) });
    }),
  );

  r.get(
    '/admin/orders/:orderId',
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.orderId).success) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
      const [order] = await selectOrders(ctx.db, 'o.id=$1', [req.params.orderId], { vendorView: true });
      if (!order) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
      const id = order.id;
      const [events, payments, attempts, refunds, splits, prints, otpLog, notes] = await Promise.all([
        ctx.db.query(`SELECT from_status, to_status, actor_type, reason, created_at FROM order_events WHERE order_id=$1 ORDER BY id`, [id]),
        ctx.db.query(`SELECT id, provider, provider_ref, amount_paise, status, created_at FROM payments WHERE order_id=$1`, [id]),
        ctx.db.query(`SELECT attempt_no, status, error, created_at FROM payment_attempts WHERE order_id=$1 ORDER BY attempt_no`, [id]),
        ctx.db.query(`SELECT id, amount_paise, reason, status, failure_reason, provider_ref, created_at, processed_at FROM refunds WHERE order_id=$1 ORDER BY created_at`, [id]),
        ctx.db.query(`SELECT beneficiary_type, amount_paise, status FROM payment_splits WHERE order_id=$1`, [id]),
        ctx.db.query(`SELECT copy_number, reason, status, attempts, last_error, created_at, printed_at FROM print_jobs WHERE order_id=$1 ORDER BY copy_number`, [id]),
        ctx.db.query(`SELECT outcome, note, created_at FROM pickup_otp_attempts WHERE order_id=$1 ORDER BY id`, [id]),
        ctx.db.query(`SELECT type, channel, status, attempts, last_error, created_at, sent_at FROM notifications WHERE order_id=$1 ORDER BY created_at, channel`, [id]),
      ]);
      res.json({
        order,
        events: events.map((e: any) => ({ from: e.from_status, to: e.to_status, actor: e.actor_type, reason: e.reason, at: e.created_at })),
        payments: payments.map((p: any) => ({ id: p.id, provider: p.provider, providerRef: p.provider_ref, amountPaise: Number(p.amount_paise), status: p.status })),
        paymentAttempts: attempts.map((a: any) => ({ attemptNo: a.attempt_no, status: a.status, error: a.error, at: a.created_at })),
        refunds: refunds.map((f: any) => ({ id: f.id, amountPaise: Number(f.amount_paise), reason: f.reason, status: f.status, failureReason: f.failure_reason, providerRef: f.provider_ref, at: f.created_at })),
        splits: splits.map((s: any) => ({ beneficiary: s.beneficiary_type, amountPaise: Number(s.amount_paise), status: s.status })),
        printJobs: prints.map((j: any) => ({ copyNumber: j.copy_number, reason: j.reason, status: j.status, attempts: j.attempts, lastError: j.last_error, at: j.created_at, printedAt: j.printed_at })),
        otpLog: otpLog.map((o: any) => ({ outcome: o.outcome, note: o.note, at: o.created_at })),
        notifications: notes.map((n: any) => ({ type: n.type, channel: n.channel, status: n.status, attempts: n.attempts, lastError: n.last_error, at: n.created_at, sentAt: n.sent_at })),
      });
    }),
  );

  r.post(
    '/admin/orders/:orderId/collect-override',
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.orderId).success) throw new HttpError(404, 'ORDER_NOT_FOUND', 'Order not found');
      const { reason } = z.object({ reason: z.string().trim().min(10).max(300) }).parse(req.body);
      await overrideCollection(ctx, { orderId: req.params.orderId, reason, actor: { type: 'ADMIN', id: req.auth!.id, role: req.auth!.role } });
      res.json({ ok: true });
    }),
  );

  r.get(
    '/admin/pickup-overrides',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.query(
        `SELECT a.created_at, a.note, o.order_number, s.name AS shop_name, u.name AS actor_name, u.role AS actor_role
           FROM pickup_otp_attempts a JOIN orders o ON o.id=a.order_id JOIN shops s ON s.id=o.shop_id LEFT JOIN users u ON u.id=a.actor_id
          WHERE a.outcome='OVERRIDE' ORDER BY a.id DESC LIMIT 200`,
      );
      res.json({ overrides: rows.map((o: any) => ({ at: o.created_at, reason: o.note, orderNumber: o.order_number, shopName: o.shop_name, by: o.actor_name, role: o.actor_role })) });
    }),
  );

  r.get(
    '/admin/payments',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.query(
        `SELECT p.id, p.provider, p.provider_ref, p.amount_paise, p.status, p.created_at, o.order_number, o.order_source, o.id AS order_id, s.name AS shop_name,
                COALESCE((SELECT SUM(amount_paise) FROM refunds f WHERE f.payment_id=p.id AND f.status='PROCESSED'),0)::bigint AS refunded_paise,
                (SELECT COUNT(*)::int FROM payment_attempts a WHERE a.payment_id=p.id) AS attempts
           FROM payments p JOIN orders o ON o.id=p.order_id JOIN shops s ON s.id=o.shop_id ORDER BY p.created_at DESC LIMIT 200`,
      );
      res.json({
        payments: rows.map((p: any) => ({
          id: p.id, orderId: p.order_id, orderNumber: p.order_number, orderSource: p.order_source, shopName: p.shop_name, provider: p.provider, providerRef: p.provider_ref,
          amountPaise: Number(p.amount_paise), refundedPaise: Number(p.refunded_paise), attempts: p.attempts, status: p.status, createdAt: p.created_at,
        })),
      });
    }),
  );

  r.get(
    '/admin/refunds',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.query(
        `SELECT f.*, o.order_number, s.name AS shop_name FROM refunds f JOIN orders o ON o.id=f.order_id JOIN shops s ON s.id=o.shop_id ORDER BY f.created_at DESC LIMIT 200`,
      );
      res.json({
        refunds: rows.map((f: any) => ({ id: f.id, orderId: f.order_id, orderNumber: f.order_number, shopName: f.shop_name, amountPaise: Number(f.amount_paise), reason: f.reason, status: f.status, failureReason: f.failure_reason, createdAt: f.created_at, processedAt: f.processed_at })),
      });
    }),
  );

  r.post(
    '/admin/refunds',
    asyncHandler(async (req, res) => {
      const b = z.object({ orderId: uuid, amountPaise: z.number().int().positive().optional(), reason: z.string().min(1).max(200) }).parse(req.body);
      const key = (req.headers['idempotency-key'] as string | undefined) ?? `admin:${b.orderId}:${b.amountPaise ?? 'full'}:${Date.now()}`;
      const refund = await withTx(ctx, (tx) => initiateRefund(ctx, tx, { orderId: b.orderId, amountPaise: b.amountPaise, reason: b.reason, idempotencyKey: key, actor: { type: 'ADMIN', id: req.auth!.id, role: req.auth!.role } }));
      res.status(201).json({ refund: { id: refund.id, amountPaise: Number(refund.amount_paise), status: refund.status } });
    }),
  );

  // Re-issue a FAILED refund for the same amount (new provider refund, new idempotency key).
  r.post(
    '/admin/refunds/:refundId/retry',
    asyncHandler(async (req, res) => {
      if (!uuid.safeParse(req.params.refundId).success) throw new HttpError(404, 'REFUND_NOT_FOUND', 'Refund not found');
      const [f] = await ctx.db.query(`SELECT * FROM refunds WHERE id=$1`, [req.params.refundId]);
      if (!f) throw new HttpError(404, 'REFUND_NOT_FOUND', 'Refund not found');
      if (f.status !== 'FAILED') throw new HttpError(409, 'NOT_RETRYABLE', 'Only a failed refund can be retried');
      const [{ n }] = await ctx.db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM refunds WHERE idempotency_key LIKE $1`, [`retry:${f.id}:%`]);
      const refund = await withTx(ctx, async (tx) => {
        const out = await initiateRefund(ctx, tx, { orderId: f.order_id, amountPaise: Number(f.amount_paise), reason: `Retry: ${f.reason}`, idempotencyKey: `retry:${f.id}:${Number(n) + 1}`, actor: { type: 'ADMIN', id: req.auth!.id, role: req.auth!.role } });
        await tx.q.query(`UPDATE reconciliation_records SET status='RESOLVED', notes=notes || ' | retried by admin' WHERE kind='REFUND' AND reference=$1 AND status='OPEN'`, [f.provider_ref]);
        return out;
      });
      res.status(201).json({ refund: { id: refund.id, amountPaise: Number(refund.amount_paise), status: refund.status } });
    }),
  );

  // Ledger check (paid = planned splits) + provider reconciliation records.
  r.get(
    '/admin/reconciliation',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.query(
        `SELECT o.order_number, p.amount_paise AS paid_paise,
                COALESCE((SELECT SUM(amount_paise) FROM payment_splits s WHERE s.order_id=o.id),0)::bigint AS split_paise,
                COALESCE((SELECT SUM(amount_paise) FROM refunds f WHERE f.order_id=o.id AND f.status='PROCESSED'),0)::bigint AS refunded_paise,
                o.payment_status
           FROM payments p JOIN orders o ON o.id=p.order_id WHERE p.status IN ('SUCCEEDED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED','REFUND_FAILED') ORDER BY o.created_at DESC LIMIT 200`,
      );
      const records = await ctx.db.query(`SELECT r.*, o.order_number FROM reconciliation_records r LEFT JOIN orders o ON o.id=r.order_id ORDER BY r.created_at DESC LIMIT 200`);
      res.json({
        rows: rows.map((r2: any) => {
          const paid = Number(r2.paid_paise), split = Number(r2.split_paise), refunded = Number(r2.refunded_paise);
          const ok = split === paid || (split === 0 && refunded === paid);
          return { orderNumber: r2.order_number, paidPaise: paid, plannedSplitPaise: split, refundedPaise: refunded, paymentStatus: r2.payment_status, matches: ok, differencePaise: paid - split };
        }),
        records: records.map((x: any) => ({ id: x.id, kind: x.kind, reference: x.reference, orderNumber: x.order_number, expectedStatus: x.expected_status, providerStatus: x.provider_status, amountPaise: x.expected_paise === null ? null : Number(x.expected_paise), action: x.action, status: x.status, notes: x.notes, at: x.created_at })),
      });
    }),
  );

  r.post(
    '/admin/reconciliation/run',
    asyncHandler(async (_req, res) => {
      res.json({ fixed: await reconcilePayments(ctx, { olderThanSeconds: 0 }) });
    }),
  );

  // ----- settlements (statements only; no money moves in the sandbox) -----
  r.post(
    '/admin/settlements/generate',
    asyncHandler(async (req, res) => {
      const { date: day } = z.object({ date }).parse(req.body);
      const { start, end } = istDayRange(day);
      const created = await withTx(ctx, async (tx) => {
        const groups = await tx.q.query(
          `SELECT ps.shop_id, s.vendor_id, COUNT(*)::int AS orders, COALESCE(SUM(ps.amount_paise),0)::bigint AS gross
             FROM payment_splits ps JOIN orders o ON o.id=ps.order_id JOIN shops s ON s.id=ps.shop_id
            WHERE ps.beneficiary_type='VENDOR' AND ps.status='PLANNED' AND ps.settlement_id IS NULL AND o.status IN ('COLLECTED','NOT_COLLECTED')
              AND o.created_at >= $1 AND o.created_at < $2
            GROUP BY ps.shop_id, s.vendor_id`,
          [start, end],
        );
        const out: any[] = [];
        for (const g of groups) {
          const [st] = await tx.q.query(
            `INSERT INTO settlements (shop_id, vendor_id, period_start, period_end, order_count, gross_paise, net_paise) VALUES ($1,$2,$3,$3,$4,$5,$5)
             ON CONFLICT (shop_id, period_start, period_end) DO UPDATE SET order_count=settlements.order_count+EXCLUDED.order_count, gross_paise=settlements.gross_paise+EXCLUDED.gross_paise, net_paise=settlements.net_paise+EXCLUDED.net_paise
             RETURNING *`,
            [g.shop_id, g.vendor_id, day, g.orders, Number(g.gross)],
          );
          await tx.q.query(
            `UPDATE payment_splits ps SET settlement_id=$1 FROM orders o WHERE o.id=ps.order_id AND ps.shop_id=$2 AND ps.beneficiary_type='VENDOR' AND ps.status='PLANNED' AND ps.settlement_id IS NULL
               AND o.status IN ('COLLECTED','NOT_COLLECTED') AND o.created_at >= $3 AND o.created_at < $4`,
            [st.id, g.shop_id, start, end],
          );
          out.push(st);
        }
        await audit(tx.q, actor(req), 'SETTLEMENTS_GENERATED', 'settlement', null, { date: day, count: out.length });
        return out;
      });
      res.status(201).json({ settlements: created.map((s: any) => ({ id: s.id, shopId: s.shop_id, orders: s.order_count, netPaise: Number(s.net_paise), status: s.status })) });
    }),
  );

  r.get(
    '/admin/settlements',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.query(`SELECT st.*, s.name AS shop_name FROM settlements st JOIN shops s ON s.id=st.shop_id ORDER BY st.period_start DESC, s.name LIMIT 200`);
      res.json({
        settlements: rows.map((s: any) => ({ id: s.id, shopName: s.shop_name, periodStart: s.period_start, periodEnd: s.period_end, orders: s.order_count, grossPaise: Number(s.gross_paise), netPaise: Number(s.net_paise), status: s.status })),
        note: 'Statements of planned vendor entitlement. No money moves in the sandbox.',
      });
    }),
  );

  // ----- pricing policy per ordering mode (SUPER_ADMIN only for changes) -----
  r.get(
    '/admin/pricing-policies',
    asyncHandler(async (_req, res) => {
      res.json({ policies: (await ctx.db.query(`SELECT * FROM pricing_policies ORDER BY order_source, version DESC`)).map(policyRowToView) });
    }),
  );

  r.patch(
    '/admin/pricing-policy',
    asyncHandler(async (req, res, next) => {
      if (req.auth!.role !== 'SUPER_ADMIN') return next(new HttpError(403, 'FORBIDDEN', 'Only the platform owner can change pricing'));
      const b = z
        .object({
          orderSource: z.enum(['PREORDER', 'WALKIN_QR']),
          feeRateBps: z.number().int().min(0).max(5000),
          taxMode: z.enum(['NONE', 'INCLUSIVE', 'EXCLUSIVE']).default('NONE'),
          taxRateBps: z.number().int().min(0).max(10000).default(0),
          approved: z.boolean().default(false),
          note: z.string().max(300).default(''),
        })
        .parse(req.body);
      if (b.taxMode !== 'NONE' && b.taxRateBps === 0) throw new HttpError(400, 'TAX_RATE_REQUIRED', 'Set a tax rate for this tax mode');
      const policy = await withTx(ctx, async (tx) => {
        const [{ v }] = await tx.q.query<{ v: number }>(`SELECT COALESCE(MAX(version),0)+1 AS v FROM pricing_policies WHERE order_source=$1`, [b.orderSource]);
        const rows = await tx.q.query(
          `INSERT INTO pricing_policies (order_source, version, fee_rate_bps, tax_mode, tax_rate_bps, approved, note, created_by, effective_from) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [b.orderSource, v, b.feeRateBps, b.taxMode, b.taxRateBps, b.approved, b.note, req.auth!.id, ctx.now()],
        );
        await audit(tx.q, actor(req), 'PRICING_POLICY_CREATED', 'pricing_policy', rows[0].id, b);
        return rows[0];
      });
      res.status(201).json({ policy: policyRowToView(policy) });
    }),
  );

  // ----- analytics + export + support -----
  r.get(
    '/admin/analytics',
    asyncHandler(async (req, res) => {
      const q = z.object({ date: date.default(istDate(ctx.now())), days: z.coerce.number().int().min(1).max(31).default(1) }).parse(req.query);
      const start = istDayRange(q.date).start;
      const end = new Date(start.getTime() + q.days * 24 * 3600_000);
      const [row] = await ctx.db.query(
        `SELECT COUNT(*)::int AS orders,
                COUNT(*) FILTER (WHERE status IN ${PAID})::int AS paid_orders,
                COALESCE(SUM(subtotal_paise) FILTER (WHERE status IN ${PAID}),0)::bigint AS gmv_paise,
                COALESCE(SUM(fee_paise) FILTER (WHERE status IN ${PAID}),0)::bigint AS fee_paise,
                COALESCE(SUM(total_paise) FILTER (WHERE payment_status <> 'NOT_STARTED' AND payment_status NOT IN ('INITIATED','PENDING','FAILED')),0)::bigint AS collected_paise,
                COUNT(*) FILTER (WHERE status IN ('CANCELLED','REJECTED','EXPIRED'))::int AS cancelled,
                COUNT(*) FILTER (WHERE payment_status IN ('REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED','REFUND_FAILED'))::int AS refunded
           FROM orders WHERE created_at >= $1 AND created_at < $2`,
        [start, end],
      );
      const [{ refunds }] = await ctx.db.query<{ refunds: number }>(`SELECT COALESCE(SUM(amount_paise),0)::bigint AS refunds FROM refunds WHERE status='PROCESSED' AND created_at >= $1 AND created_at < $2`, [start, end]);
      const bySource = await ctx.db.query(
        `SELECT order_source, COUNT(*) FILTER (WHERE status IN ${PAID})::int AS orders, COALESCE(SUM(subtotal_paise) FILTER (WHERE status IN ${PAID}),0)::bigint AS gmv, COALESCE(SUM(fee_paise) FILTER (WHERE status IN ${PAID}),0)::bigint AS fee
           FROM orders WHERE created_at >= $1 AND created_at < $2 GROUP BY order_source`,
        [start, end],
      );
      const byShop = await ctx.db.query(
        `SELECT s.id, s.name, s.code,
                COUNT(o.id) FILTER (WHERE o.status IN ${PAID})::int AS orders,
                COUNT(o.id) FILTER (WHERE o.status IN ${PAID} AND o.order_source='WALKIN_QR')::int AS walkin,
                COUNT(o.id) FILTER (WHERE o.status IN ${PAID} AND o.order_source='PREORDER')::int AS preorder,
                COALESCE(SUM(o.subtotal_paise) FILTER (WHERE o.status IN ${PAID}),0)::bigint AS gmv,
                COALESCE(SUM(o.fee_paise) FILTER (WHERE o.status IN ${PAID}),0)::bigint AS fee,
                COUNT(o.id) FILTER (WHERE o.status='REJECTED')::int AS rejected
           FROM shops s LEFT JOIN orders o ON o.shop_id=s.id AND o.created_at >= $1 AND o.created_at < $2
          GROUP BY s.id ORDER BY s.code`,
        [start, end],
      );
      const peak = await ctx.db.query(
        `SELECT EXTRACT(HOUR FROM (created_at AT TIME ZONE 'Asia/Kolkata'))::int AS hour, order_source, COUNT(*)::int AS n
           FROM orders WHERE created_at >= $1 AND created_at < $2 AND status IN ${PAID} GROUP BY 1,2 ORDER BY 1`,
        [start, end],
      );
      const [{ active, total }] = await ctx.db.query(`SELECT COUNT(*) FILTER (WHERE status='ACTIVE')::int AS active, COUNT(*)::int AS total FROM shops`);
      const src = (s: string) => bySource.find((x: any) => x.order_source === s) ?? { orders: 0, gmv: 0, fee: 0 };
      res.json({
        date: q.date,
        days: q.days,
        totalShops: Number(total),
        activeShops: Number(active),
        orders: Number(row.orders),
        paidOrders: Number(row.paid_orders),
        foodGmvPaise: Number(row.gmv_paise),
        grossFeePaise: Number(row.fee_paise),
        paymentsCollectedPaise: Number(row.collected_paise),
        refundsProcessedPaise: Number(refunds),
        cancelledOrders: Number(row.cancelled),
        refundedOrders: Number(row.refunded),
        bySource: Object.fromEntries(['PREORDER', 'WALKIN_QR'].map((s) => [s, { orders: Number(src(s).orders), foodGmvPaise: Number(src(s).gmv), feePaise: Number(src(s).fee) }])),
        byShop: byShop.map((s: any) => ({ shopId: s.id, name: s.name, code: s.code, orders: s.orders, walkin: s.walkin, preorder: s.preorder, foodGmvPaise: Number(s.gmv), feePaise: Number(s.fee), rejected: s.rejected })),
        peakHours: Array.from({ length: 24 }, (_, h) => ({
          hour: h,
          preorder: Number(peak.find((p: any) => p.hour === h && p.order_source === 'PREORDER')?.n ?? 0),
          walkin: Number(peak.find((p: any) => p.hour === h && p.order_source === 'WALKIN_QR')?.n ?? 0),
        })),
        note: 'Gross fee is not profit (payment charges and taxes not deducted). Sandbox data only.',
      });
    }),
  );

  r.get(
    '/admin/export/orders.csv',
    asyncHandler(async (req, res) => {
      const day = date.default(istDate(ctx.now())).parse(req.query.date);
      const { start, end } = istDayRange(day);
      const orders = await selectOrders(ctx.db, 'o.created_at >= $1 AND o.created_at < $2', [start, end], { limit: 500, orderBy: 'o.created_at ASC' });
      const header = ['order_number', 'source', 'shop', 'status', 'payment_status', 'subtotal_paise', 'fee_rate_bps', 'fee_paise', 'tax_paise', 'total_paise', 'pickup_start', 'estimated_ready', 'collected_via', 'created_at'];
      const lines = [header.join(',')].concat(
        orders.map((o) =>
          [o.orderNumber, o.orderSource, o.shopName, o.status, o.paymentStatus, o.subtotalPaise, o.feeRateBps, o.feePaise, o.taxPaise, o.totalPaise, o.slotStartsAt, o.estimatedReadyAt, o.collectedVia, o.createdAt]
            .map(csvCell)
            .join(','),
        ),
      );
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="quickpick-v2-orders-${day}.csv"`);
      res.send(lines.join('\n') + '\n');
    }),
  );

  r.get(
    '/admin/complaints',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.query(`SELECT c.*, o.order_number, s.name AS shop_name FROM complaints c JOIN orders o ON o.id=c.order_id JOIN shops s ON s.id=o.shop_id ORDER BY c.created_at DESC LIMIT 200`);
      res.json({ complaints: rows.map((c: any) => ({ id: c.id, orderNumber: c.order_number, shopName: c.shop_name, category: c.category, description: c.description, status: c.status, resolution: c.resolution, createdAt: c.created_at })) });
    }),
  );

  r.patch(
    '/admin/complaints/:id',
    asyncHandler(async (req, res) => {
      const b = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']), resolution: z.string().max(500).optional() }).parse(req.body);
      if (!uuid.safeParse(req.params.id).success) throw new HttpError(404, 'NOT_FOUND', 'Complaint not found');
      const rows = await withTx(ctx, async (tx) => {
        const u = await tx.q.query(`UPDATE complaints SET status=$2, resolution=COALESCE($3, resolution), updated_at=now() WHERE id=$1 RETURNING id, status`, [req.params.id, b.status, b.resolution ?? null]);
        if (!u[0]) throw new HttpError(404, 'NOT_FOUND', 'Complaint not found');
        await audit(tx.q, actor(req), 'COMPLAINT_UPDATED', 'complaint', req.params.id, b);
        return u;
      });
      res.json({ complaint: rows[0] });
    }),
  );

  r.get(
    '/admin/audit-logs',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.query(`SELECT id, actor_role, action, entity_type, entity_id, metadata, created_at FROM audit_logs ORDER BY id DESC LIMIT 200`);
      res.json({ logs: rows });
    }),
  );

  return r;
}
