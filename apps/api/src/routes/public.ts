import express, { Router } from 'express';
import { z } from 'zod';
import { formatPaise } from '@qp2/shared';
import { asyncHandler } from '../auth.js';
import { HttpError, type AppContext } from '../context.js';
import { MockPaymentProvider } from '../payments/mock.js';
import { loadMenu } from '../services/menu.js';
import { getActivePolicy } from '../services/pricing.js';
import { estimateWalkinMinutes, publicShopView } from '../services/shops.js';
import { listAvailableSlots } from '../services/slots.js';

const uuid = z.string().uuid();

/** Unauthenticated browsing. Only ACTIVE shops are listed; a QR for a suspended shop resolves to a clear message. */
export function publicRoutes(ctx: AppContext): Router {
  const r = Router();

  r.get('/config', (_req, res) => {
    res.json({
      sandbox: true,
      paymentProvider: ctx.provider.name,
      currency: 'INR',
      pushProvider: ctx.push.name,
      note: 'Sandbox mode: no real money is taken.',
    });
  });

  r.get(
    '/shops',
    asyncHandler(async (_req, res) => {
      const rows = await ctx.db.query(`SELECT * FROM shops WHERE status='ACTIVE' ORDER BY code, name`);
      res.json({ shops: rows.map((s) => publicShopView(ctx, s)) });
    }),
  );

  const activeShop = async (id: string) => {
    if (!uuid.safeParse(id).success) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
    const rows = await ctx.db.query(`SELECT * FROM shops WHERE id=$1 AND status='ACTIVE'`, [id]);
    if (!rows[0]) throw new HttpError(404, 'SHOP_NOT_FOUND', 'Shop not found');
    return rows[0];
  };

  r.get(
    '/shops/:shopId',
    asyncHandler(async (req, res) => {
      res.json({ shop: publicShopView(ctx, await activeShop(req.params.shopId)) });
    }),
  );

  r.get(
    '/shops/:shopId/menu',
    asyncHandler(async (req, res) => {
      const shop = await activeShop(req.params.shopId);
      res.json({ shop: publicShopView(ctx, shop), ...(await loadMenu(ctx.db, shop.id)) });
    }),
  );

  r.get(
    '/shops/:shopId/pickup-slots',
    asyncHandler(async (req, res) => {
      const shop = await activeShop(req.params.shopId);
      const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().parse(req.query.date);
      res.json({ slots: await listAvailableSlots(ctx, ctx.db, shop, date) });
    }),
  );

  r.get(
    '/shops/:shopId/walkin-estimate',
    asyncHandler(async (req, res) => {
      const shop = await activeShop(req.params.shopId);
      res.json(await estimateWalkinMinutes(ctx, ctx.db, shop));
    }),
  );

  // QR entry point: the token comes from the printed QR at the counter. Unknown tokens are a 404 with a friendly code.
  r.get(
    '/qr/:token',
    asyncHandler(async (req, res) => {
      const token = z.string().min(4).max(64).regex(/^[A-Za-z0-9_-]+$/).safeParse(req.params.token);
      if (!token.success) throw new HttpError(404, 'QR_NOT_FOUND', 'This QR code is not a Java QuickPick shop code');
      const [shop] = await ctx.db.query(`SELECT * FROM shops WHERE qr_token=$1`, [token.data]);
      if (!shop || shop.status === 'DRAFT') throw new HttpError(404, 'QR_NOT_FOUND', 'This QR code is not a Java QuickPick shop code');
      const view = publicShopView(ctx, shop);
      const estimate = view.walkin.orderable ? await estimateWalkinMinutes(ctx, ctx.db, shop) : null;
      res.json({ shop: view, walkin: view.walkin, estimate });
    }),
  );

  r.get(
    '/pricing-policy/current',
    asyncHandler(async (req, res) => {
      const source = z.enum(['PREORDER', 'WALKIN_QR']).default('PREORDER').parse(req.query.source);
      const p = await getActivePolicy(ctx, ctx.db, source);
      res.json({ orderSource: p.orderSource, feeRateBps: p.feeRateBps, taxMode: p.taxMode, taxRateBps: p.taxRateBps, version: p.version, approved: p.approved });
    }),
  );

  return r;
}

// ---------- SANDBOX hosted checkout (stands in for the provider's payment page) ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function page(title: string, body: string, refreshTo?: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${refreshTo ? `<meta http-equiv="refresh" content="2;url=${esc(refreshTo)}">` : ''}
<title>${esc(title)}</title><style>
body{margin:0;font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#eef1f6;color:#141a24}
.wrap{max-width:420px;margin:0 auto;padding:20px 16px}
.bar{background:#fff3cd;color:#6b4e00;border-radius:10px;padding:10px 12px;font-size:14px;font-weight:600;margin-bottom:14px}
.card{background:#fff;border-radius:16px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 4px}.muted{color:#5b6472;font-size:14px}
.amt{font-size:34px;font-weight:700;margin:14px 0 4px}
button,a.btn{display:block;width:100%;box-sizing:border-box;margin-top:10px;padding:14px;border-radius:12px;border:1px solid #c9d0db;background:#fff;font:600 16px system-ui;color:#141a24;text-align:center;text-decoration:none;cursor:pointer}
button.pay{background:#1f4fd8;border-color:#1f4fd8;color:#fff}
.small{font-size:13px;color:#5b6472;margin-top:14px}
</style></head><body><div class="wrap"><div class="bar">SANDBOX PAYMENT PAGE — no real money moves</div>${body}</div></body></html>`;
}

export function sandboxCheckoutRoutes(ctx: AppContext): Router {
  const r = Router();
  const csp = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
  const load = async (session: string) => {
    if (!/^mock_ses_[0-9a-f]{24}$/.test(session)) return null;
    const [row] = await ctx.db.query(
      `SELECT a.*, p.provider_ref, p.amount_paise, o.order_number, o.status AS order_status, o.id AS order_id, s.name AS shop_name
         FROM payment_attempts a JOIN payments p ON p.id=a.payment_id JOIN orders o ON o.id=a.order_id JOIN shops s ON s.id=o.shop_id
        WHERE a.session_ref=$1`,
      [session],
    );
    return row ?? null;
  };

  r.get(
    '/sandbox/checkout/:session',
    asyncHandler(async (req, res) => {
      res.setHeader('Content-Security-Policy', csp);
      const a = await load(req.params.session);
      if (!a) return void res.status(404).send(page('Checkout not found', `<div class="card"><h1>Checkout not found</h1><p class="muted">This payment link is invalid.</p></div>`));
      if (a.status !== 'CREATED' || a.order_status !== 'PENDING_PAYMENT') {
        return void res.send(
          page('Checkout closed', `<div class="card"><h1>This checkout is closed</h1><p class="muted">Order ${esc(a.order_number)}.</p><a class="btn" href="${esc(a.return_url)}">Back to Java QuickPick</a></div>`),
        );
      }
      res.send(
        page(
          'Pay — Java QuickPick',
          `<div class="card"><h1>Java QuickPick</h1><div class="muted">${esc(a.shop_name)} · Order ${esc(a.order_number)}</div>
           <div class="amt">${esc(formatPaise(Number(a.amount_paise)))}</div><div class="muted">Attempt ${a.attempt_no}</div>
           <form method="post">
             <button class="pay" name="outcome" value="success">Pay ${esc(formatPaise(Number(a.amount_paise)))}</button>
             <button name="outcome" value="failure">Decline payment</button>
             <button name="outcome" value="success_no_return">Pay, then close without returning</button>
             <button name="outcome" value="webhook_lost">Pay, but webhook is lost</button>
             <button name="outcome" value="pending">Leave payment pending</button>
           </form>
           <p class="small">These buttons simulate a payment provider. Only a signed server-to-server webhook (or reconciliation with the provider) marks the order paid — never this page returning to the app.</p></div>`,
        ),
      );
    }),
  );

  r.post(
    '/sandbox/checkout/:session',
    express.urlencoded({ extended: false, limit: '2kb' }),
    asyncHandler(async (req, res) => {
      res.setHeader('Content-Security-Policy', csp);
      const outcome = z.enum(['success', 'failure', 'success_no_return', 'webhook_lost', 'pending']).parse(req.body?.outcome);
      const a = await load(req.params.session);
      if (!a || !ctx.sandboxDeliver) return void res.status(404).send(page('Checkout not found', `<div class="card"><h1>Checkout not found</h1></div>`));
      const back = a.return_url as string;
      if (a.status !== 'CREATED' || a.order_status !== 'PENDING_PAYMENT') {
        return void res.send(page('Checkout closed', `<div class="card"><h1>This checkout is closed</h1><a class="btn" href="${esc(back)}">Back to Java QuickPick</a></div>`));
      }
      const amount = Number(a.amount_paise);
      if (outcome === 'success' || outcome === 'success_no_return') {
        await ctx.sandboxDeliver({ type: 'payment.succeeded', providerRef: a.provider_ref, amountPaise: amount, currency: 'INR', orderId: a.order_id } as any);
      } else if (outcome === 'failure') {
        await ctx.sandboxDeliver({ type: 'payment.failed', providerRef: a.provider_ref, amountPaise: amount, currency: 'INR', orderId: a.order_id, reason: 'Sandbox: payment declined' } as any);
      } else if (outcome === 'webhook_lost' && ctx.provider instanceof MockPaymentProvider) {
        ctx.provider.markPaidWithoutWebhook(a.provider_ref);
      }
      const messages: Record<typeof outcome, [string, string]> = {
        success: ['Payment successful', 'Taking you back to Java QuickPick…'],
        failure: ['Payment declined', 'No money was taken. You can try again from the app.'],
        success_no_return: ['Payment successful', 'You can close this tab. The app will show the order as paid because the server confirmed it directly.'],
        webhook_lost: ['Payment captured', 'The provider took the payment but its webhook was "lost". The server’s reconciliation job will confirm it within about a minute.'],
        pending: ['Payment pending', 'Nothing has been charged yet.'],
      };
      const [title, text] = messages[outcome];
      const showLink = outcome !== 'success_no_return';
      res.send(
        page(
          title,
          `<div class="card"><h1>${esc(title)}</h1><p class="muted">${esc(text)}</p>${showLink ? `<a class="btn" href="${esc(back)}">Back to Java QuickPick</a>` : ''}</div>`,
          outcome === 'success' ? back : undefined,
        ),
      );
    }),
  );

  return r;
}
