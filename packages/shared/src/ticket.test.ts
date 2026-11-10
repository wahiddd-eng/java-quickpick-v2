import { describe, expect, it } from 'vitest';
import { EscPosBuilder, bytesToBase64, toPrintable, wrap } from './escpos';
import { duplicateLabel, renderKitchenTicket, ticketLines, type KitchenTicket } from './ticket';

const ticket: KitchenTicket = {
  orderId: '3f2a9c1e-0000-4000-8000-000000000001',
  orderNumber: 'JQ-7KQ2',
  orderSource: 'WALKIN_QR',
  shopName: 'Demo Shop 01',
  orderedAt: '2026-11-09T07:05:00Z', // 12:35 pm IST
  targetAt: '2026-11-09T07:17:00Z',
  targetLabel: 'Ready by',
  prepMinutes: 12,
  items: [
    { name: 'Demo Masala Dosa', quantity: 2, modifiers: ['Extra chutney'], notes: 'Less oil' },
    { name: 'Demo Filter Coffee', quantity: 1, modifiers: [], notes: '' },
  ],
  copyNumber: 1,
  attempt: 1,
};

const ascii = (b: Uint8Array) => Array.from(b, (c) => (c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : ' ')).join('');

describe('ESC/POS builder', () => {
  it('starts with ESC @ and ends with a partial cut', () => {
    const bytes = new EscPosBuilder({ columns: 48 }).line('hi').cut().build();
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x1b, 0x40]);
    expect(Array.from(bytes.slice(-4))).toEqual([0x1d, 0x56, 66, 0]);
  });

  it('pads a left/right pair to the full width', () => {
    const b = new EscPosBuilder({ columns: 20 }).pair('Items', '3').build();
    expect(ascii(b.slice(2, 22))).toBe('Items              3');
  });

  it('reduces text to printable ASCII', () => {
    expect(toPrintable('₹50 – “hot” café')).toBe('Rs50 - "hot" cafe');
  });

  it('wraps long text within the paper width', () => {
    for (const l of wrap('Extra extra extra long cooking instruction for the cook', 16)) expect(l.length).toBeLessThanOrEqual(16);
  });

  it('encodes base64 the same way as Node', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253]);
    expect(bytesToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});

describe('kitchen ticket', () => {
  it('contains what the cook needs', () => {
    const text = ascii(renderKitchenTicket(ticket, 80));
    for (const s of ['JAVA QUICKPICK', 'Demo Shop 01', 'JQ-7KQ2', 'WALK-IN (QR)', 'PREPARE', '2 x Demo Masala Dosa', '+ Extra chutney', 'NOTE: Less oil', '12:35 pm', '12:47 pm', '3f2a9c1e']) {
      expect(text).toContain(s);
    }
  });

  it('never contains an OTP, phone number or price', () => {
    const text = ascii(renderKitchenTicket(ticket, 80)) + ticketLines(ticket).join('\n');
    expect(text).not.toMatch(/OTP|Rs|\b\d{6}\b|\b\d{10}\b/);
  });

  it('labels reprints and retries as possible duplicates', () => {
    expect(duplicateLabel(ticket)).toBeNull();
    expect(duplicateLabel({ copyNumber: 2, attempt: 1 })).toMatch(/REPRINT - COPY 2/);
    expect(duplicateLabel({ copyNumber: 1, attempt: 2 })).toMatch(/RETRY 2/);
    expect(ascii(renderKitchenTicket({ ...ticket, copyNumber: 3 }))).toContain('DO NOT COOK AGAIN');
  });

  it('fits 58 mm paper (32 columns) in the text preview', () => {
    for (const l of ticketLines(ticket, 32)) expect(l.length).toBeLessThanOrEqual(32);
  });
});
