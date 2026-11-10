/**
 * Minimal ESC/POS command builder for 58/80 mm thermal kitchen printers. Pure TypeScript (no DOM, no Node APIs), so the
 * exact bytes sent to the printer are unit-tested and identical on the tablet and in tests.
 *
 * Only widely supported commands are used (ESC @, ESC a, ESC E, GS !, GS V, LF). Text is reduced to printable ASCII so
 * printers on any default code page print it predictably; the ₹ sign is written as "Rs".
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

export type Align = 'left' | 'center' | 'right';

export interface EscPosOptions {
  /** Characters per line in Font A: 48 for 80 mm paper, 32 for 58 mm. */
  columns: number;
}

export const COLUMNS_FOR_WIDTH: Record<58 | 80, number> = { 58: 32, 80: 48 };

/** Replace characters thermal printers commonly cannot print. */
export function toPrintable(text: string): string {
  return text
    .replace(/₹/g, 'Rs')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E\n]/g, '');
}

/** Greedy word wrap to a fixed width; words longer than the width are split. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of toPrintable(text).split('\n')) {
    let line = '';
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) {
          out.push(line);
          line = '';
        }
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

export class EscPosBuilder {
  private bytes: number[] = [];
  readonly columns: number;

  constructor(opts: EscPosOptions) {
    this.columns = opts.columns;
    this.raw(ESC, 0x40); // ESC @ — initialise
  }

  raw(...b: number[]): this {
    this.bytes.push(...b);
    return this;
  }

  align(a: Align): this {
    return this.raw(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
  }

  bold(on: boolean): this {
    return this.raw(ESC, 0x45, on ? 1 : 0);
  }

  /** GS ! n — character size multiplier (1–8 each way). */
  size(width: number, height: number): this {
    const w = Math.min(Math.max(width, 1), 8) - 1;
    const h = Math.min(Math.max(height, 1), 8) - 1;
    return this.raw(GS, 0x21, (w << 4) | h);
  }

  text(s: string): this {
    for (const ch of toPrintable(s)) this.bytes.push(ch.charCodeAt(0));
    return this;
  }

  line(s = ''): this {
    return this.text(s).raw(LF);
  }

  /** Wrapped paragraph at the current size (pass the size multiplier so wrapping uses the real width). */
  para(s: string, widthMultiplier = 1): this {
    for (const l of wrap(s, Math.floor(this.columns / widthMultiplier))) this.line(l);
    return this;
  }

  /** Left text and right text on one line, padded to the full width. */
  pair(left: string, right: string): this {
    const l = toPrintable(left);
    const r = toPrintable(right);
    const space = this.columns - l.length - r.length;
    if (space >= 1) return this.line(l + ' '.repeat(space) + r);
    return this.para(l).line(' '.repeat(Math.max(0, this.columns - r.length)) + r);
  }

  rule(ch = '-'): this {
    return this.line(ch.repeat(this.columns));
  }

  feed(n = 1): this {
    for (let i = 0; i < n; i++) this.raw(LF);
    return this;
  }

  /** Feed and partial cut (GS V 66 n). Printers without a cutter ignore it. */
  cut(): this {
    return this.feed(3).raw(GS, 0x56, 66, 0);
  }

  build(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

/** Base64 without Node's Buffer (works in the browser, Capacitor bridge and Node). */
export function bytesToBase64(bytes: Uint8Array): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += chars[a >> 2] + chars[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? chars[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? chars[c & 63] : '=';
  }
  return out;
}
