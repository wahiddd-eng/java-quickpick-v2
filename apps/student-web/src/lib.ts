import { ApiError, createApiClient, type OrderSource } from '@qp2/shared';
import { useEffect, useState } from 'react';

export const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4100';
export const api = createApiClient({ baseUrl: API_URL, tokenKey: 'qp2_student_token', onUnauthorized: () => window.dispatchEvent(new Event('qp-logout')) });

// ---------- types ----------
export interface Availability { orderable: boolean; reason: string | null; message: string | null }
export interface Shop {
  id: string;
  code: string;
  name: string;
  description: string;
  logoUrl: string | null;
  cuisineTags: string[];
  acceptingOrders: boolean;
  openNow: boolean;
  openTime: string;
  closeTime: string;
  avgPrepMinutes: number;
  preorderEnabled: boolean;
  walkinEnabled: boolean;
  isDemo: boolean;
  preorder: Availability;
  walkin: Availability;
}
export interface Modifier { id: string; group: string; name: string; pricePaise: number; selection: 'ONE' | 'MANY'; required: boolean; available: boolean }
export interface MenuItem { id: string; categoryId: string | null; name: string; description: string; imageUrl: string | null; diet: 'VEG' | 'NON_VEG' | 'EGG' | null; basePricePaise: number; available: boolean; modifiers: Modifier[] }
export interface Slot { id: string; startsAt: string; endsAt: string; remaining: number; full: boolean }

export interface CartLine {
  key: string;
  menuItemId: string;
  name: string;
  unitPricePaise: number;
  qty: number;
  modifierIds: string[];
  modifierNames: string[];
  notes: string;
}
export interface Cart { mode: OrderSource; shopId: string; shopName: string; qrToken?: string; lines: CartLine[] }

// ---------- routing (path based, so a shop QR URL like /s/<token> opens directly) ----------
export function navigate(to: string) {
  if (to === location.pathname + location.search) return;
  history.pushState(null, '', to);
  window.dispatchEvent(new Event('qp-nav'));
  window.scrollTo(0, 0);
}
export function useLocation(): { path: string; query: URLSearchParams } {
  const read = () => ({ path: location.pathname, query: new URLSearchParams(location.search) });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener('popstate', on);
    window.addEventListener('qp-nav', on);
    return () => {
      window.removeEventListener('popstate', on);
      window.removeEventListener('qp-nav', on);
    };
  }, []);
  return loc;
}
/** Intercept same-origin <a href="/..."> clicks so links stay inside the SPA. */
export function linkHandler(e: MouseEvent) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = (e.target as HTMLElement).closest('a');
  if (!a || a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin) return;
  e.preventDefault();
  navigate(url.pathname + url.search);
}

// ---------- formatting ----------
const IST = 'Asia/Kolkata';
export const fmtTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: IST }) : '');
export const fmtDay = (iso: string) => {
  const d = new Date(iso);
  const key = (x: Date) => x.toLocaleDateString('en-CA', { timeZone: IST });
  if (key(d) === key(new Date())) return 'Today';
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: IST });
};
export const fmtClock = (hhmm?: string) => {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}\u202f${h >= 12 ? 'pm' : 'am'}`;
};
export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Couldn’t reach Java QuickPick. Check your connection and try again.');
export const initials = (name: string) => {
  const w = name.split(/\s+/).filter((x) => /[a-z0-9]/i.test(x));
  return ((w[0]?.[0] ?? '') + (w.length > 1 ? w[w.length - 1]![0] : '')).toUpperCase();
};
export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------- cart (one shop, one mode) ----------
export function loadCart(): Cart | null {
  try {
    const c = JSON.parse(localStorage.getItem('qp2_cart') ?? 'null');
    return c && Array.isArray(c.lines) ? c : null;
  } catch {
    return null;
  }
}
export function saveCart(c: Cart | null) {
  try {
    if (c && c.lines.length) localStorage.setItem('qp2_cart', JSON.stringify(c));
    else localStorage.removeItem('qp2_cart');
  } catch {
    /* storage unavailable: cart lives in memory only */
  }
}
export const lineKey = (menuItemId: string, modifierIds: string[], notes: string) => [menuItemId, [...modifierIds].sort().join('+'), notes.trim().toLowerCase()].join('|');
export const cartCount = (c: Cart | null) => (c ? c.lines.reduce((s, l) => s + l.qty, 0) : 0);
export const cartTotal = (c: Cart | null) => (c ? c.lines.reduce((s, l) => s + l.unitPricePaise * l.qty, 0) : 0);
export const cartItemsPayload = (c: Cart) => c.lines.map((l) => ({ menuItemId: l.menuItemId, quantity: l.qty, modifierIds: l.modifierIds, notes: l.notes }));
