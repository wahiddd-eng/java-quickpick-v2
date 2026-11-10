import { hashPassword } from './auth.js';
import type { Db } from './db.js';

export const DEMO_PASSWORD = 'demo1234';
/** Fixed QR tokens for the two demo shops so the sandbox links are stable. Real shops get random tokens. */
export const DEMO_QR = { JG01: 'demo-jg01-qr7k', JG02: 'demo-jg02-qr4m' } as const;

type Mod = [group: string, name: string, pricePaise: number, selection: 'ONE' | 'MANY', required: boolean];
type Item = { cat: string; name: string; price: number; diet: 'VEG' | 'NON_VEG' | 'EGG' | null; desc: string; mods?: Mod[] };

/**
 * DEMO DATA ONLY. Every seeded shop is flagged is_demo and named "Demo ...". Accounts use a published demo password, so
 * this must never run against production (the CLI refuses when NODE_ENV=production).
 */
export async function seedDemo(db: Db) {
  const existing = await db.query(`SELECT 1 FROM users WHERE email='admin@quickpick.demo'`);
  if (existing[0]) return { seeded: false };
  const pw = await hashPassword(DEMO_PASSWORD);

  await db.tx(async (q) => {
    // Sandbox pricing: 7% for each ordering mode, no tax, NOT approved (needs the CA's written opinion first).
    for (const source of ['PREORDER', 'WALKIN_QR']) {
      await q.query(
        `INSERT INTO pricing_policies (order_source, version, fee_rate_bps, tax_mode, tax_rate_bps, approved, note, effective_from)
         VALUES ($1, 1, 700, 'NONE', 0, false, 'Sandbox default. Tax treatment of the fee is NOT approved — awaiting CA opinion.', '2020-01-01T00:00:00Z')`,
        [source],
      );
    }
    await q.query(`INSERT INTO users (name, email, role, password_hash) VALUES ('Demo Super Admin','super@quickpick.demo','SUPER_ADMIN',$1), ('Demo Admin','admin@quickpick.demo','ADMIN',$1)`, [pw]);

    const shops: Array<{ code: keyof typeof DEMO_QR; name: string; desc: string; tags: string; email: string; prep: number; items: Item[] }> = [
      {
        code: 'JG01',
        name: 'Demo Shop 01',
        desc: 'Demo data — South Indian tiffin and coffee',
        tags: 'South Indian, Tiffin, Coffee',
        email: 'vendor-01@quickpick.demo',
        prep: 8,
        items: [
          { cat: 'Tiffin', name: 'Demo Masala Dosa', price: 6500, diet: 'VEG', desc: 'Crisp dosa with potato masala, sambar and chutney', mods: [['Add-ons', 'Extra butter', 1500, 'MANY', false], ['Add-ons', 'Cheese', 2000, 'MANY', false], ['Spice level', 'Mild', 0, 'ONE', false], ['Spice level', 'Spicy', 0, 'ONE', false]] },
          { cat: 'Tiffin', name: 'Demo Idli Plate (3)', price: 4000, diet: 'VEG', desc: 'Three idlis with sambar and chutney' },
          { cat: 'Tiffin', name: 'Demo Egg Dosa', price: 7500, diet: 'EGG', desc: 'Dosa topped with egg and pepper' },
          { cat: 'Drinks', name: 'Demo Filter Coffee', price: 2000, diet: 'VEG', desc: 'Strong South Indian filter coffee', mods: [['Size', 'Regular', 0, 'ONE', true], ['Size', 'Large', 1000, 'ONE', true]] },
        ],
      },
      {
        code: 'JG02',
        name: 'Demo Shop 02',
        desc: 'Demo data — meals, biryani and snacks',
        tags: 'Meals, Biryani, Snacks',
        email: 'vendor-02@quickpick.demo',
        prep: 12,
        items: [
          { cat: 'Meals', name: 'Demo Veg Meal', price: 10000, diet: 'VEG', desc: 'Rice, two curries, dal, curd and papad' },
          { cat: 'Meals', name: 'Demo Chicken Biryani', price: 14000, diet: 'NON_VEG', desc: 'Dum biryani with raita', mods: [['Add-ons', 'Extra raita', 1500, 'MANY', false], ['Add-ons', 'Boiled egg', 1500, 'MANY', false]] },
          { cat: 'Snacks', name: 'Demo Samosa (2 pcs)', price: 3000, diet: 'VEG', desc: 'With mint chutney' },
          { cat: 'Drinks', name: 'Demo Masala Chai', price: 1500, diet: 'VEG', desc: 'Ginger and cardamom tea' },
        ],
      },
    ];

    for (const s of shops) {
      const [vendor] = await q.query(`INSERT INTO vendors (legal_name, contact_name, payout_status) VALUES ($1,$2,'NOT_STARTED') RETURNING id`, [`${s.name} (demo vendor)`, `${s.name} Owner`]);
      // Demo hours are wide so the sandbox can be tried at any time; real shops are set per shop in admin.
      const [shop] = await q.query(
        `INSERT INTO shops (vendor_id, code, qr_token, name, description, cuisine_tags, status, open_time, close_time, slot_minutes, slot_capacity, avg_prep_minutes, kitchen_parallel, accept_timeout_seconds, is_demo)
         VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE','08:00','22:00',10,5,$7,2,120,true) RETURNING id`,
        [vendor.id, s.code, DEMO_QR[s.code], s.name, s.desc, s.tags, s.prep],
      );
      const [u] = await q.query(`INSERT INTO users (name, email, role, password_hash) VALUES ($1,$2,'VENDOR',$3) RETURNING id`, [`${s.name} Owner`, s.email, pw]);
      await q.query(`INSERT INTO shop_members (user_id, shop_id, role) VALUES ($1,$2,'OWNER')`, [u.id, shop.id]);
      const cats = new Map<string, string>();
      let order = 0;
      for (const it of s.items) {
        if (!cats.has(it.cat)) cats.set(it.cat, (await q.query(`INSERT INTO menu_categories (shop_id, name, sort_order) VALUES ($1,$2,$3) RETURNING id`, [shop.id, it.cat, order++]))[0].id);
        const [item] = await q.query(
          `INSERT INTO menu_items (shop_id, category_id, name, description, base_price_paise, diet) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [shop.id, cats.get(it.cat), it.name, it.desc, it.price, it.diet],
        );
        let sort = 0;
        for (const [group, name, price, selection, required] of it.mods ?? []) {
          await q.query(
            `INSERT INTO menu_item_modifiers (menu_item_id, group_name, name, price_paise, selection, required, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [item.id, group, name, price, selection, required, sort++],
          );
        }
      }
      // A simulated kitchen printer so the flow works in a browser; real tablets add a Bluetooth/network printer.
      await q.query(`INSERT INTO printer_devices (shop_id, name, model, connection, paper_width_mm) VALUES ($1,'Kitchen printer (simulated)','Simulated 80 mm','SIMULATED',80)`, [shop.id]);
    }
  });
  return { seeded: true };
}
