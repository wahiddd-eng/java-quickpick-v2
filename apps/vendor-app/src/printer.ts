import { Capacitor, registerPlugin } from '@capacitor/core';
import { bytesToBase64, renderKitchenTicket, ticketLines, type KitchenTicket } from '@qp2/shared';

export type Connection = 'BLUETOOTH' | 'NETWORK' | 'SIMULATED';
export type PrinterState = 'ONLINE' | 'OFFLINE' | 'PAPER_OUT' | 'ERROR';

export interface PrinterConfig {
  id: string;
  name: string;
  model: string;
  connection: Connection;
  address: string;
  paperWidthMm: 58 | 80;
  status: PrinterState | 'UNKNOWN';
  lastError: string | null;
}

/** Thrown by drivers so the queue can report a precise printer state to the server. */
export class PrintError extends Error {
  constructor(
    message: string,
    public state: PrinterState,
  ) {
    super(message);
  }
}

/**
 * Native Android plugin (android/app/src/main/java/in/javaquickpick/vendor/QuickPickPrinterPlugin.java).
 * Moves raw ESC/POS bytes over Bluetooth SPP or TCP:9100.
 * NOTE: written but not yet compiled or run on a device — see docs/printing.md.
 */
interface QuickPickPrinterPlugin {
  print(opts: { connection: 'BLUETOOTH' | 'NETWORK'; address: string; data: string; timeoutMs?: number }): Promise<{ ok: boolean }>;
  status(opts: { connection: 'BLUETOOTH' | 'NETWORK'; address: string; timeoutMs?: number }): Promise<{ state: PrinterState; detail?: string }>;
  listPaired(): Promise<{ devices: Array<{ name: string; address: string }> }>;
}
const Native = registerPlugin<QuickPickPrinterPlugin>('QuickPickPrinter');
export const isNativeApp = () => Capacitor.isNativePlatform();

// ---------- simulated printer (browser): shows the exact slip on screen ----------

export interface SimulatedSlip {
  id: string;
  at: number;
  lines: string[];
  ticket: KitchenTicket;
}
type SimFault = 'none' | 'offline' | 'paper_out';
const sim = { fault: 'none' as SimFault, slips: [] as SimulatedSlip[], listeners: new Set<() => void>() };
export const simulator = {
  get fault() {
    return sim.fault;
  },
  setFault(f: SimFault) {
    sim.fault = f;
    sim.listeners.forEach((l) => l());
  },
  get slips() {
    return sim.slips;
  },
  clear() {
    sim.slips = [];
    sim.listeners.forEach((l) => l());
  },
  subscribe(fn: () => void) {
    sim.listeners.add(fn);
    return () => void sim.listeners.delete(fn);
  },
};

function nativeError(e: any): PrintError {
  const code = String(e?.code ?? '');
  const msg = String(e?.message ?? e ?? 'Printer error');
  if (code === 'PAPER_OUT' || /paper/i.test(msg)) return new PrintError('Printer is out of paper', 'PAPER_OUT');
  if (code === 'OFFLINE' || /timed out|refused|unreachable|socket|connect|not paired|bluetooth is off/i.test(msg)) return new PrintError(msg, 'OFFLINE');
  return new PrintError(msg, 'ERROR');
}

/** Print one kitchen slip. Resolves when the bytes were handed to the printer. */
export async function printTicket(printer: PrinterConfig, ticket: KitchenTicket, jobId: string): Promise<void> {
  if (printer.connection === 'SIMULATED') {
    await new Promise((r) => setTimeout(r, 250));
    if (sim.fault === 'offline') throw new PrintError('Simulated printer is switched off', 'OFFLINE');
    if (sim.fault === 'paper_out') throw new PrintError('Simulated printer is out of paper', 'PAPER_OUT');
    sim.slips = [{ id: jobId, at: Date.now(), lines: ticketLines(ticket, printer.paperWidthMm === 58 ? 32 : 48), ticket }, ...sim.slips].slice(0, 20);
    sim.listeners.forEach((l) => l());
    return;
  }
  if (!isNativeApp()) throw new PrintError('Bluetooth and network printers work only in the Android app. Use the simulated printer in a browser.', 'ERROR');
  const data = bytesToBase64(renderKitchenTicket(ticket, printer.paperWidthMm));
  try {
    await Native.print({ connection: printer.connection, address: printer.address, data, timeoutMs: 8000 });
  } catch (e) {
    throw nativeError(e);
  }
}

/** Connection check (and paper sensor where the printer reports it). */
export async function checkPrinter(printer: PrinterConfig): Promise<{ state: PrinterState; detail?: string }> {
  if (printer.connection === 'SIMULATED') {
    return sim.fault === 'offline' ? { state: 'OFFLINE', detail: 'Simulated printer is switched off' } : sim.fault === 'paper_out' ? { state: 'PAPER_OUT', detail: 'Out of paper' } : { state: 'ONLINE' };
  }
  if (!isNativeApp()) return { state: 'ERROR', detail: 'Needs the Android app' };
  try {
    return await Native.status({ connection: printer.connection, address: printer.address, timeoutMs: 5000 });
  } catch (e) {
    const err = nativeError(e);
    return { state: err.state, detail: err.message };
  }
}

export async function pairedPrinters(): Promise<Array<{ name: string; address: string }>> {
  if (!isNativeApp()) return [];
  try {
    return (await Native.listPaired()).devices;
  } catch {
    return [];
  }
}

/** Sample ticket for the "Test print" button. */
export function testTicket(shopName: string): KitchenTicket {
  const now = new Date().toISOString();
  return {
    orderId: '00000000-test-print-0000-000000000000',
    orderNumber: 'TEST',
    orderSource: 'WALKIN_QR',
    shopName,
    orderedAt: now,
    targetAt: now,
    targetLabel: 'Ready by',
    prepMinutes: 1,
    items: [{ name: 'Printer test - not an order', quantity: 1, modifiers: ['Ignore this slip'], notes: '' }],
    copyNumber: 1,
    attempt: 1,
  };
}

/** Stable per-install id for this tablet (used to hold print-job leases). */
export function installId(): string {
  const key = 'qp2_install_id';
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = 'tab-' + crypto.getRandomValues(new Uint32Array(3)).reduce((s, n) => s + n.toString(36), '');
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return 'tab-ephemeral-' + Math.random().toString(36).slice(2, 10);
  }
}
