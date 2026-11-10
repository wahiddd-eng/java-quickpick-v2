import { COLUMNS_FOR_WIDTH, EscPosBuilder } from './escpos';
import type { OrderSource } from './index';

/**
 * Kitchen slip content. Built on the server when the vendor accepts (stored in print_jobs.payload) and turned into
 * ESC/POS bytes on the tablet. It deliberately has NO pickup OTP, NO student phone/email, NO payment details.
 */
export interface KitchenTicket {
  orderId: string;
  orderNumber: string;
  orderSource: OrderSource;
  shopName: string;
  /** ISO timestamps. */
  orderedAt: string;
  /** Pickup slot start for pre-orders; vendor estimate for walk-ins. */
  targetAt: string | null;
  targetLabel: string;
  prepMinutes: number | null;
  items: Array<{ name: string; quantity: number; modifiers: string[]; notes: string }>;
  /** 1 = original. 2+ = reprint, printed as a labelled duplicate. */
  copyNumber: number;
  /** >1 when a previous attempt may have printed partially (printer error / tablet restart). */
  attempt: number;
}

const IST_OFFSET_MS = 5.5 * 3600 * 1000;
export function istClock(iso: string): string {
  const d = new Date(new Date(iso).getTime() + IST_OFFSET_MS);
  let h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

/** Plain-text rendering (used for the on-screen preview and the simulated printer). */
export function ticketLines(t: KitchenTicket, columns = 48): string[] {
  const b = new TextTicket(columns);
  render(t, b);
  return b.lines;
}

export function renderKitchenTicket(t: KitchenTicket, paperWidthMm: 58 | 80 = 80): Uint8Array {
  const b = new EscPosBuilder({ columns: COLUMNS_FOR_WIDTH[paperWidthMm] });
  render(t, new EscPosSink(b));
  return b.cut().build();
}

/** Labels that must appear when a slip could be a second copy, so the kitchen never cooks an order twice. */
export function duplicateLabel(t: Pick<KitchenTicket, 'copyNumber' | 'attempt'>): string | null {
  if (t.copyNumber > 1) return `REPRINT - COPY ${t.copyNumber} - DO NOT COOK AGAIN`;
  if (t.attempt > 1) return `RETRY ${t.attempt} - CHECK FOR DUPLICATE`;
  return null;
}

interface Sink {
  columns: number;
  center(s: string, big?: boolean, bold?: boolean): void;
  left(s: string, bold?: boolean): void;
  pair(l: string, r: string): void;
  rule(ch?: string): void;
  blank(): void;
}

function render(t: KitchenTicket, s: Sink) {
  const dup = duplicateLabel(t);
  s.center('JAVA QUICKPICK', false, true);
  s.center(t.shopName);
  if (dup) {
    s.rule('*');
    s.center(dup, false, true);
    s.rule('*');
  }
  s.rule('=');
  s.center('PREPARE', true, true);
  s.center(t.orderNumber, true, true);
  s.center(t.orderSource === 'WALKIN_QR' ? 'WALK-IN (QR)' : 'PRE-ORDER', false, true);
  s.rule('=');
  s.pair('Ordered', istClock(t.orderedAt));
  if (t.targetAt) s.pair(t.targetLabel, istClock(t.targetAt));
  if (t.prepMinutes) s.pair('Prep time', `${t.prepMinutes} min`);
  s.rule();
  for (const it of t.items) {
    s.left(`${it.quantity} x ${it.name}`, true);
    for (const m of it.modifiers) s.left(`   + ${m}`);
    if (it.notes) s.left(`   NOTE: ${it.notes}`, true);
  }
  s.rule();
  const count = t.items.reduce((n, i) => n + i.quantity, 0);
  s.pair('Items', String(count));
  s.blank();
  s.center(`Order ID ${t.orderId.slice(0, 8)}`);
  if (dup) s.center(dup, false, true);
}

class EscPosSink implements Sink {
  constructor(private b: EscPosBuilder) {}
  get columns() {
    return this.b.columns;
  }
  center(str: string, big = false, bold = false) {
    this.b.align('center').bold(bold);
    if (big) this.b.size(2, 2).para(str, 2).size(1, 1);
    else this.b.para(str);
    this.b.bold(false).align('left');
  }
  left(str: string, bold = false) {
    this.b.align('left').bold(bold).para(str).bold(false);
  }
  pair(l: string, r: string) {
    this.b.pair(l, r);
  }
  rule(ch = '-') {
    this.b.rule(ch);
  }
  blank() {
    this.b.feed(1);
  }
}

class TextTicket implements Sink {
  lines: string[] = [];
  constructor(public columns: number) {}
  center(str: string) {
    for (const l of wrapPlain(str, this.columns)) {
      const pad = Math.max(0, Math.floor((this.columns - l.length) / 2));
      this.lines.push(' '.repeat(pad) + l);
    }
  }
  left(str: string) {
    this.lines.push(...wrapPlain(str, this.columns));
  }
  pair(l: string, r: string) {
    const space = this.columns - l.length - r.length;
    this.lines.push(space >= 1 ? l + ' '.repeat(space) + r : `${l} ${r}`);
  }
  rule(ch = '-') {
    this.lines.push(ch.repeat(this.columns));
  }
  blank() {
    this.lines.push('');
  }
}

function wrapPlain(s: string, width: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (const w of words) {
    if (!line) line = w;
    else if (line.length + 1 + w.length <= width) line += ' ' + w;
    else {
      out.push(line);
      line = w;
    }
  }
  out.push(line);
  return out;
}
