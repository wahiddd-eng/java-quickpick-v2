import { HttpError } from '../context.js';
import type { Queryable } from '../db.js';

export interface ModifierRow {
  id: string;
  menu_item_id: string;
  group_name: string;
  name: string;
  price_paise: number;
  selection: 'ONE' | 'MANY';
  required: boolean;
  available: boolean;
  sort_order: number;
}

export const modifierView = (m: ModifierRow) => ({
  id: m.id,
  group: m.group_name,
  name: m.name,
  pricePaise: Number(m.price_paise),
  selection: m.selection,
  required: m.required,
  available: m.available,
});

export const itemView = (i: any, mods: ModifierRow[]) => ({
  id: i.id,
  categoryId: i.category_id,
  name: i.name,
  description: i.description,
  imageUrl: i.image_url,
  diet: i.diet,
  basePricePaise: Number(i.base_price_paise),
  available: i.available,
  modifiers: mods.filter((m) => m.menu_item_id === i.id).map(modifierView),
});

export async function loadMenu(q: Queryable, shopId: string, opts: { includeInactiveCategories?: boolean } = {}) {
  const categories = await q.query(
    `SELECT id, name, sort_order, active FROM menu_categories WHERE shop_id=$1 ${opts.includeInactiveCategories ? '' : 'AND active=true'} ORDER BY sort_order, name`,
    [shopId],
  );
  const items = await q.query(`SELECT * FROM menu_items WHERE shop_id=$1 ORDER BY sort_order, name`, [shopId]);
  const mods = items.length
    ? await q.query<ModifierRow>(`SELECT * FROM menu_item_modifiers WHERE menu_item_id = ANY($1::uuid[]) ORDER BY group_name, sort_order, name`, [items.map((i: any) => i.id)])
    : [];
  return {
    categories: categories.map((c: any) => ({ id: c.id, name: c.name, sortOrder: c.sort_order, active: c.active })),
    items: items.map((i: any) => itemView(i, mods)),
  };
}

/**
 * Validate the chosen modifiers for one cart line against the item's groups:
 *  - every chosen id belongs to this item and is available,
 *  - a ONE group has at most one choice, a required group exactly one.
 * Returns the snapshot stored on the order item.
 */
export function resolveModifiers(itemName: string, all: ModifierRow[], chosenIds: string[]) {
  const unique = [...new Set(chosenIds)];
  const byId = new Map(all.map((m) => [m.id, m]));
  const chosen = unique.map((id) => {
    const m = byId.get(id);
    if (!m) throw new HttpError(400, 'INVALID_MODIFIER', `That option is not available for ${itemName}`);
    if (!m.available) throw new HttpError(409, 'MODIFIER_UNAVAILABLE', `${m.name} is currently unavailable`);
    return m;
  });
  const groups = new Map<string, ModifierRow[]>();
  for (const m of all) groups.set(m.group_name, [...(groups.get(m.group_name) ?? []), m]);
  for (const [group, rows] of groups) {
    const picked = chosen.filter((c) => c.group_name === group).length;
    const one = rows.some((r) => r.selection === 'ONE');
    const required = rows.some((r) => r.required);
    if (one && picked > 1) throw new HttpError(400, 'INVALID_MODIFIER', `Choose only one ${group.toLowerCase()} for ${itemName}`);
    if (required && picked === 0) throw new HttpError(400, 'MODIFIER_REQUIRED', `Choose a ${group.toLowerCase()} for ${itemName}`);
  }
  const snapshot = chosen
    .sort((a, b) => a.group_name.localeCompare(b.group_name) || a.sort_order - b.sort_order)
    .map((m) => ({ id: m.id, group: m.group_name, name: m.name, pricePaise: Number(m.price_paise) }));
  return { snapshot, totalPaise: snapshot.reduce((s, m) => s + m.pricePaise, 0) };
}
