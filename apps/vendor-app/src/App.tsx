import {
  ApiError,
  ORDER_SOURCE_LABEL,
  ORDER_STATUS_LABEL,
  createApiClient,
  formatPaise,
  queueTime,
  type KitchenTicket,
  type OrderStatus,
  type OrderView,
} from '@qp2/shared';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { io } from 'socket.io-client';
import { PrintError, checkPrinter, installId, isNativeApp, pairedPrinters, printTicket, simulator, testTicket, type PrinterConfig } from './printer';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4100';
const api = createApiClient({ baseUrl: API_URL, tokenKey: 'qp2_vendor_token', onUnauthorized: () => window.dispatchEvent(new Event('qp-logout')) });
const INSTALL_ID = installId();

interface Modifier { id: string; group: string; name: string; pricePaise: number; available: boolean }
interface MenuItem { id: string; categoryId: string | null; name: string; diet: 'VEG' | 'NON_VEG' | 'EGG' | null; basePricePaise: number; available: boolean; modifiers: Modifier[] }
interface ShopInfo {
  shop: { id: string; code: string; name: string; acceptingOrders: boolean; walkinEnabled: boolean; preorderEnabled: boolean; acceptTimeoutSeconds: number; avgPrepMinutes: number };
  categories: { id: string; name: string }[];
  items: MenuItem[];
  printers: PrinterConfig[];
}
interface PrintJob { id: string; orderId: string; copyNumber: number; attempt: number; maxAttempts: number; status: string; lastError: string | null; reason: string; ticket: KitchenTicket; createdAt: string }

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Couldn’t reach QuickPick. Check the Wi-Fi and try again.');
const fmtTime = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }) : '–');
const PREP_CHOICES = [5, 10, 15, 20, 30];
const REJECT_REASONS = ['Out of stock', 'Too busy', 'Closing soon', 'Other'];
const OVERRIDE_REASONS = ['Phone battery dead — checked college ID and order', 'Code locked — checked college ID and order', 'Code expired — student is here with the order number'];

// ---------- sound (browsers need one tap before they allow audio; the Android WebView allows it) ----------
let audioCtx: AudioContext | null = null;
function enableAudio() {
  audioCtx = audioCtx ?? new AudioContext();
  void audioCtx.resume();
  beep(1);
}
function beep(times = 3) {
  if (!audioCtx) return;
  const ctx = audioCtx;
  for (let i = 0; i < times; i++) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = i % 2 ? 880 : 1175;
    g.gain.value = 0.15;
    o.connect(g);
    g.connect(ctx.destination);
    const t = ctx.currentTime + i * 0.25;
    o.start(t);
    o.stop(t + 0.18);
  }
}

const Bell = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>;
const Cup = () => <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M4 9h13v4a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6V9Z" /><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17" /><path d="M8 3v3M12 3v3" /></svg>;
const PrinterIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9V3h12v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M7 14h10v7H7z" /></svg>;

export function App() {
  const [authed, setAuthed] = useState(!!api.getToken());
  useEffect(() => {
    const on = () => {
      api.clearToken();
      setAuthed(false);
    };
    window.addEventListener('qp-logout', on);
    return () => window.removeEventListener('qp-logout', on);
  }, []);
  return (
    <>
      <div className="sandbox-banner">Test mode: these are test orders and no real money is involved</div>
      {authed ? <Dashboard onLogout={() => { api.clearToken(); setAuthed(false); }} /> : <Login onDone={() => setAuthed(true)} />}
    </>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      const r = await api.post<{ token: string; user: { role: string } }>('/auth/login', { email, password });
      if (r.user.role !== 'VENDOR') return setErr('This sign-in is for shop accounts. Use the admin dashboard instead.');
      api.setToken(r.token);
      onDone();
    } catch (er) {
      setErr(errMsg(er));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="login-brand"><span className="mark"><Cup /></span><div><b>Java QuickPick</b><span>Shop tablet</span></div></div>
        <h1>Sign in to your shop</h1>
        <div className="field"><label htmlFor="e">Shop email</label><input id="e" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></div>
        <div className="field"><label htmlFor="p">Password</label><input id="p" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></div>
        {err && <div className="error" role="alert">{err}</div>}
        <button className="big primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted small">Stay signed in on this tablet. Ask the QuickPick team if you’ve lost the password.</p>
      </form>
    </div>
  );
}

type Tab = 'orders' | 'done' | 'menu' | 'printer' | 'today';

function Dashboard({ onLogout }: { onLogout: () => void }) {
  const [info, setInfo] = useState<ShopInfo | null>(null);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [jobs, setJobs] = useState<PrintJob[]>([]);
  const [tab, setTab] = useState<Tab>('orders');
  const [online, setOnline] = useState(true);
  const [socketUp, setSocketUp] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [now, setNow] = useState(Date.now());
  const [handover, setHandover] = useState<OrderView | null>(null);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const soundRef = useRef(false);
  soundRef.current = soundOn;
  const infoRef = useRef<ShopInfo | null>(null);
  infoRef.current = info;
  const printing = useRef(false);

  const printer = info?.printers[0] ?? null;

  // REST is the source of truth: on load, on every socket signal, on reconnect and every 8 s.
  const refresh = useCallback(async () => {
    try {
      const [o, s, j] = await Promise.all([
        api.get<{ orders: OrderView[] }>('/vendor/orders'),
        api.get<ShopInfo>('/vendor/shop'),
        api.get<{ jobs: PrintJob[] }>('/vendor/print-jobs?status=open'),
      ]);
      setOrders(o.orders);
      setInfo(s);
      setJobs(j.jobs);
      setOnline(true);
      const newIds = o.orders.filter((x) => x.status === 'AWAITING_VENDOR').map((x) => x.id);
      if (seen.current === null) seen.current = new Set(newIds);
      else if (newIds.some((id) => !seen.current!.has(id))) {
        if (soundRef.current) beep(4);
        newIds.forEach((id) => seen.current!.add(id));
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 0) setOnline(false);
      else setErr(errMsg(e));
    }
  }, []);

  /**
   * Print queue: claim due slips for this tablet, print them one by one, report each result. Jobs live on the server,
   * so nothing is lost if the tablet restarts; a job this tablet held is picked up again when its lease expires.
   */
  const runPrintQueue = useCallback(async () => {
    if (printing.current) return;
    printing.current = true;
    try {
      const { jobs: claimed } = await api.post<{ jobs: PrintJob[] }>('/vendor/print-jobs/claim', { installId: INSTALL_ID });
      for (const job of claimed) {
        const p = infoRef.current?.printers[0];
        if (!p) {
          await api.post(`/vendor/print-jobs/${job.id}/result`, { installId: INSTALL_ID, ok: false, error: 'No kitchen printer is set up on this tablet' });
          continue;
        }
        try {
          await printTicket(p, job.ticket, job.id);
          await api.post(`/vendor/print-jobs/${job.id}/result`, { installId: INSTALL_ID, ok: true, printerId: p.id, printerStatus: 'ONLINE' });
          setToast(`Slip printed for ${job.ticket.orderNumber}${job.copyNumber > 1 ? ' (reprint)' : ''}`);
        } catch (e) {
          const pe = e instanceof PrintError ? e : new PrintError(String((e as Error)?.message ?? e), 'ERROR');
          await api.post(`/vendor/print-jobs/${job.id}/result`, { installId: INSTALL_ID, ok: false, error: pe.message, printerId: p.id, printerStatus: pe.state });
          if (soundRef.current) beep(2);
        }
      }
      if (claimed.length) await refresh();
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 0)) setErr(errMsg(e));
    } finally {
      printing.current = false;
    }
  }, [refresh]);

  useEffect(() => {
    api.post('/vendor/devices/register', { installId: INSTALL_ID, platform: isNativeApp() ? 'android' : 'web', model: navigator.userAgent.slice(0, 80) }).catch((e) => setErr(errMsg(e)));
    void refresh().then(runPrintQueue);
    const poll = setInterval(refresh, 8000);
    const printPoll = setInterval(runPrintQueue, 10000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const beatFn = () => api.post('/vendor/heartbeat', { installId: INSTALL_ID }).catch(() => undefined);
    const beat = setInterval(beatFn, 30000);
    void beatFn();
    const socket = io(API_URL, { auth: { token: api.getToken() }, transports: ['websocket', 'polling'] });
    socket.on('connect', () => {
      setSocketUp(true);
      void refresh();
      void runPrintQueue();
    });
    socket.on('disconnect', () => setSocketUp(false));
    socket.on('order', () => void refresh());
    socket.on('print', () => void runPrintQueue());
    const onOnline = () => {
      void refresh();
      void runPrintQueue();
    };
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(poll);
      clearInterval(printPoll);
      clearInterval(tick);
      clearInterval(beat);
      socket.close();
      window.removeEventListener('online', onOnline);
    };
  }, [refresh, runPrintQueue]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  if (!info) return <div className="loading-screen"><p>Loading orders…</p>{!online && <div className="error">Can’t reach QuickPick. Retrying every few seconds.</div>}</div>;

  const by = (s: OrderStatus) => orders.filter((o) => o.status === s).sort((a, b) => queueTime(a) - queueTime(b));
  const connected = online && socketUp;
  const newCount = by('AWAITING_VENDOR').length;
  const paused = !info.shop.acceptingOrders;
  const failedJobs = jobs.filter((j) => j.status === 'FAILED');

  const togglePause = async () => {
    try {
      await api.patch('/vendor/shop/status', { acceptingOrders: paused });
      await refresh();
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  const afterAction = async () => {
    await refresh();
    void runPrintQueue();
  };

  const COLUMNS: [OrderStatus, string, string, string][] = [
    ['AWAITING_VENDOR', 'New', 'new', 'Accept or reject'],
    ['ACCEPTED', 'Accepted', 'accepted', 'Start when ready'],
    ['PREPARING', 'Preparing', 'preparing', 'Mark ready when done'],
    ['READY', 'Ready', 'ready', 'Waiting for pickup'],
  ];

  return (
    <div className="vapp">
      <header className="vtop">
        <div className="vtop-shop">
          <h1>{info.shop.name}</h1>
          <span className={'conn ' + (connected ? 'live' : online ? 'slow' : 'down')}><span className="dot" />{connected ? 'Live' : online ? 'Reconnecting' : 'Offline'}</span>
          <PrinterChip printer={printer} onClick={() => setTab('printer')} />
        </div>
        <div className="vtop-actions">
          <button className={'sound ' + (soundOn ? 'on' : '')} onClick={() => { if (!soundOn) { enableAudio(); setSoundOn(true); } else beep(1); }} aria-label={soundOn ? 'Sound is on. Tap to test' : 'Turn on sound'}>
            <Bell />{soundOn ? 'Sound on' : 'Sound off'}
          </button>
          <button className={'switch ' + (paused ? 'off' : 'on')} role="switch" aria-checked={!paused} onClick={togglePause}>
            <span className="track"><span className="knob" /></span>
            <span>{paused ? 'Orders paused' : 'Taking orders'}</span>
          </button>
          {!confirmSignOut ? <button className="ghost" onClick={() => setConfirmSignOut(true)}>Sign out</button> : (
            <span className="confirm-inline"><span>Sign out of this tablet?</span><button className="ghost" onClick={() => setConfirmSignOut(false)}>No</button><button className="danger-solid" onClick={onLogout}>Sign out</button></span>
          )}
        </div>
      </header>

      {!soundOn && (
        <div className="banner warn">
          <span><b>Sound is off.</b> You won’t hear new orders arrive.</span>
          <button className="big primary" onClick={() => { enableAudio(); setSoundOn(true); }}><Bell />Turn on sound</button>
        </div>
      )}
      {failedJobs.length > 0 && (
        <div className="banner bad" role="alert">
          <span><b>{failedJobs.length} kitchen slip{failedJobs.length === 1 ? '' : 's'} didn’t print.</b> The order{failedJobs.length === 1 ? ' is' : 's are'} still on the board — check the printer, then retry.</span>
          <button className="big" onClick={() => setTab('printer')}>Open printer</button>
        </div>
      )}
      {!printer && <div className="banner warn"><span><b>No kitchen printer set up.</b> Slips can’t print until you add one.</span><button className="big" onClick={() => setTab('printer')}>Set up printer</button></div>}
      {paused && <div className="banner paused"><span><b>New orders are paused.</b> Students can’t order from you until you turn orders back on. Orders already placed still need finishing.</span><button className="big" onClick={togglePause}>Start taking orders</button></div>}
      {!connected && <div className="banner bad"><span>{online ? <><b>Live updates are reconnecting.</b> The board still refreshes every few seconds.</> : <><b>No internet.</b> This board may be out of date. Check the Wi-Fi or switch to a hotspot.</>}</span></div>}
      {err && <div className="banner bad" role="alert"><span>{err}</span><button className="ghost-dark" onClick={() => setErr('')}>Dismiss</button></div>}

      <nav className="tabs" role="tablist" aria-label="Sections">
        <button role="tab" aria-selected={tab === 'orders'} onClick={() => setTab('orders')}>Orders{newCount > 0 && <span className="tab-count">{newCount} new</span>}</button>
        <button role="tab" aria-selected={tab === 'done'} onClick={() => setTab('done')}>Done</button>
        <button role="tab" aria-selected={tab === 'menu'} onClick={() => setTab('menu')}>Menu</button>
        <button role="tab" aria-selected={tab === 'printer'} onClick={() => setTab('printer')}>Printer{failedJobs.length > 0 && <span className="tab-count bad">{failedJobs.length}</span>}</button>
        <button role="tab" aria-selected={tab === 'today'} onClick={() => setTab('today')}>Today</button>
      </nav>

      {tab === 'orders' && (
        <div className="board">
          {COLUMNS.map(([s, label, cls, hint]) => (
            <section key={s} className={'col ' + cls} aria-label={label}>
              <div className="col-head"><h2>{label}</h2><span className="count">{by(s).length}</span></div>
              {by(s).length === 0 && <div className="col-empty">{s === 'AWAITING_VENDOR' ? (paused ? 'Paused — no new orders' : 'No new orders') : hint}</div>}
              {by(s).map((o) => (
                <OrderCard key={o.id} o={o} now={now} timeout={info.shop.acceptTimeoutSeconds} failedJob={failedJobs.find((j) => j.orderId === o.id)} onDone={afterAction} onError={setErr} onHandover={() => setHandover(o)} />
              ))}
            </section>
          ))}
        </div>
      )}
      {tab === 'done' && <DoneTab />}
      {tab === 'menu' && <MenuTab info={info} onChange={refresh} onError={setErr} />}
      {tab === 'printer' && <PrinterTab info={info} jobs={jobs} onChange={afterAction} onError={setErr} />}
      {tab === 'today' && <Today />}

      {printer?.connection === 'SIMULATED' && <SlipTray />}
      {toast && <div className="toast" role="status">{toast}</div>}
      {handover && <HandoverSheet o={handover} onClose={() => setHandover(null)} onDone={() => { setHandover(null); void refresh(); }} />}
    </div>
  );
}

function PrinterChip({ printer, onClick }: { printer: PrinterConfig | null; onClick: () => void }) {
  const state = !printer ? 'none' : printer.status;
  const label = !printer ? 'No printer' : printer.connection === 'SIMULATED' && state !== 'OFFLINE' && state !== 'PAPER_OUT' ? 'Simulated printer' : { ONLINE: 'Printer ready', OFFLINE: 'Printer offline', PAPER_OUT: 'Out of paper', ERROR: 'Printer error', UNKNOWN: 'Printer not checked' }[printer.status];
  const cls = state === 'ONLINE' ? 'live' : state === 'UNKNOWN' ? 'idle' : 'down';
  return <button className={'pchip ' + cls} onClick={onClick}><PrinterIcon />{label}</button>;
}

function OrderCard({ o, now, timeout, failedJob, onDone, onError, onHandover }: { o: OrderView; now: number; timeout: number; failedJob?: PrintJob; onDone: () => Promise<void>; onError: (m: string) => void; onHandover: () => void }) {
  const [busy, setBusy] = useState(false);
  const [prep, setPrep] = useState(10);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [cancelling, setCancelling] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    onError('');
    try {
      await fn();
      await onDone();
    } catch (e) {
      onError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const status = (s: string, body: object = {}) => run(() => api.patch(`/vendor/orders/${o.id}/status`, { status: s, ...body }));
  const left = o.acceptDeadline ? Math.max(0, Math.round((new Date(o.acceptDeadline).getTime() - now) / 1000)) : null;
  const pct = left !== null && timeout > 0 ? Math.min(100, (left / timeout) * 100) : 0;
  const itemCount = o.items.reduce((s, i) => s + i.quantity, 0);
  const walkin = o.orderSource === 'WALKIN_QR';
  const accepted = ['ACCEPTED', 'PREPARING', 'READY'].includes(o.status);

  return (
    <article className={'ocard s-' + o.status}>
      {o.status === 'AWAITING_VENDOR' && left !== null && (
        <div className={'countdown' + (left <= 20 ? ' low' : '')} aria-live="off">
          <div className="bar" style={{ width: `${pct}%` }} />
          <span>{left > 0 ? `Respond in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Time’s up — refunding'}</span>
        </div>
      )}
      <div className="tags">
        <span className={'src ' + (walkin ? 'walkin' : 'pre')}>{walkin ? 'WALK-IN' : 'PRE-ORDER'}</span>
        <span className="paid">Paid ✓</span>
        {accepted && <PrintBadge status={o.printStatus} />}
      </div>
      <div className="ohead">
        <div><div className="onum">{o.orderNumber}</div><div className="who">{o.customerName ?? 'Student'} · {itemCount} item{itemCount === 1 ? '' : 's'}</div></div>
        <div className="pickup">
          {walkin ? <><span>Ready by</span><b>{fmtTime(o.estimatedReadyAt)}</b></> : <><span>Pickup</span><b>{fmtTime(o.slotStartsAt)}</b></>}
        </div>
      </div>
      <ul className="items">
        {o.items.map((i, idx) => (
          <li key={i.menuItemId + idx}>
            <span className="q">{i.quantity}</span>
            <div>
              <span>{i.name}</span>
              {i.modifiers.length > 0 && <small className="mods">{i.modifiers.map((m) => m.name).join(' · ')}</small>}
              {i.notes && <small className="note">Note: {i.notes}</small>}
            </div>
          </li>
        ))}
      </ul>
      {o.prepMinutes && o.status !== 'AWAITING_VENDOR' && <p className="meta">You said about {o.prepMinutes} min to prepare</p>}

      <div className="actions">
        {o.status === 'AWAITING_VENDOR' && !rejecting && (
          <>
            <div className="choose"><span className="choose-label">Minutes to prepare</span>
              <div className="chips" role="radiogroup" aria-label="Preparation time">
                {PREP_CHOICES.map((m) => <button key={m} role="radio" aria-checked={prep === m} className={prep === m ? 'sel' : ''} aria-label={`${m} minutes`} onClick={() => setPrep(m)}>{m}</button>)}
              </div>
            </div>
            <div className="two">
              <button className="big outline-bad" disabled={busy} onClick={() => setRejecting(true)}>Reject</button>
              <button className="big primary" disabled={busy} onClick={() => run(() => api.post(`/vendor/orders/${o.id}/accept`, { prepMinutes: prep }))}>Accept</button>
            </div>
          </>
        )}
        {o.status === 'AWAITING_VENDOR' && rejecting && (
          <>
            <div className="choose"><span className="choose-label">Why can’t you take it? The student gets a full refund.</span>
              <div className="chips wrap" role="radiogroup" aria-label="Reason">
                {REJECT_REASONS.map((r) => <button key={r} role="radio" aria-checked={reason === r} className={reason === r ? 'sel bad' : ''} onClick={() => setReason(r)}>{r}</button>)}
              </div>
            </div>
            <div className="two">
              <button className="big" onClick={() => { setRejecting(false); setReason(''); }}>Back</button>
              <button className="big danger-solid" disabled={busy || !reason} onClick={() => run(() => api.post(`/vendor/orders/${o.id}/reject`, { reason }))}>Reject</button>
            </div>
          </>
        )}
        {o.status === 'ACCEPTED' && (
          <div className="two">
            <button className="big" disabled={busy} onClick={() => status('READY')}>Ready now</button>
            <button className="big primary" disabled={busy} onClick={() => status('PREPARING')}>Start preparing</button>
          </div>
        )}
        {o.status === 'PREPARING' && <button className="big primary" disabled={busy} onClick={() => status('READY')}>Mark ready</button>}
        {o.status === 'READY' && (
          <div className="two">
            <button className="big" disabled={busy} onClick={() => status('NOT_COLLECTED')}>No-show</button>
            <button className="big primary" disabled={busy} onClick={onHandover}>Hand over</button>
          </div>
        )}
        {accepted && (
          <div className="row-actions">
            {failedJob ? (
              <button className="small-btn bad" disabled={busy} onClick={() => run(() => api.post(`/vendor/print-jobs/${failedJob.id}/retry`))}>Retry slip</button>
            ) : (
              <button className="small-btn" disabled={busy} onClick={() => run(() => api.post(`/vendor/orders/${o.id}/reprint`))}><PrinterIcon />Reprint slip</button>
            )}
          </div>
        )}
        {(o.status === 'ACCEPTED' || o.status === 'PREPARING') && (!cancelling ? (
          <button className="text-bad" onClick={() => setCancelling(true)}>Can’t make this order</button>
        ) : (
          <div className="confirm-box">
            <p><b>Cancel {o.orderNumber}?</b> The student is refunded in full.</p>
            <div className="two"><button className="big" onClick={() => setCancelling(false)}>Keep order</button><button className="big danger-solid" disabled={busy} onClick={() => status('CANCELLED', { reason: 'Shop could not fulfil' })}>Cancel and refund</button></div>
          </div>
        ))}
      </div>
    </article>
  );
}

function PrintBadge({ status }: { status?: string }) {
  if (!status || status === 'NONE') return null;
  const map: Record<string, [string, string]> = { PENDING: ['Printing slip…', 'wait'], CLAIMED: ['Printing slip…', 'wait'], PRINTED: ['Slip printed', 'ok'], FAILED: ['Slip failed', 'bad'], CANCELLED: ['Slip cancelled', 'wait'] };
  const [label, cls] = map[status] ?? [status, 'wait'];
  return <span className={'pstat ' + cls}>{label}</span>;
}

// Full-screen keypad so the on-screen keyboard never covers the board.
function HandoverSheet({ o, onClose, onDone }: { o: OrderView; onClose: () => void; onDone: () => void }) {
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [reason, setReason] = useState('');
  const press = (k: string) => {
    setErr('');
    setCode((c) => (k === 'del' ? c.slice(0, -1) : k === 'clr' ? '' : c.length < 6 ? c + k : c));
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (manual) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose, manual]);
  const submit = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.post(`/vendor/orders/${o.id}/verify-otp`, { otp: code });
      onDone();
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'OTP_LOCKED' || e.code === 'OTP_EXPIRED')) setManual(true);
      setErr(errMsg(e));
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  const override = async () => {
    setBusy(true);
    setErr('');
    try {
      await api.post(`/vendor/orders/${o.id}/collect-override`, { reason });
      onDone();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="ho-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-head">
          <div><h2 id="ho-title">Hand over {o.orderNumber}</h2><p className="muted">{o.customerName ?? 'Student'} · {o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</p></div>
          <button className="ghost-dark" onClick={onClose}>Close</button>
        </div>
        {!manual ? (
          <>
            <p className="sheet-ask">Ask for the 6-digit collection code shown in the student’s app</p>
            <div className={'code-boxes six' + (err ? ' wrong' : '')} aria-label={`Entered ${code.length} of 6 digits`}>
              {[0, 1, 2, 3, 4, 5].map((i) => <span key={i} className={code[i] ? 'filled' : i === code.length ? 'next' : ''}>{code[i] ?? ''}</span>)}
            </div>
            {err && <div className="error" role="alert">{err}</div>}
            <div className="keypad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clr', '0', 'del'].map((k) => (
                <button key={k} className={k.length > 1 ? 'fn' : ''} onClick={() => press(k)} aria-label={k === 'del' ? 'Delete' : k === 'clr' ? 'Clear' : k}>{k === 'del' ? '⌫' : k === 'clr' ? 'Clear' : k}</button>
              ))}
            </div>
            <button className="big primary block" disabled={busy || code.length !== 6} onClick={submit}>{busy ? 'Checking…' : 'Confirm handover'}</button>
            <button className="text-link" onClick={() => setManual(true)}>Student can’t show a code?</button>
          </>
        ) : (
          <>
            {err && <div className="error" role="alert">{err}</div>}
            <p className="sheet-ask">Manual handover</p>
            <p className="muted small">Only when the student is here and you’ve checked who they are. This is recorded with your name and reviewed by QuickPick.</p>
            <div className="chips wrap one">
              {OVERRIDE_REASONS.map((r) => <button key={r} className={reason === r ? 'sel' : ''} onClick={() => setReason(r)}>{r}</button>)}
            </div>
            <div className="field"><label htmlFor="ovr">Reason</label><textarea id="ovr" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="What did you check?" /></div>
            <div className="two">
              <button className="big" onClick={() => { setManual(false); setErr(''); }}>Back to code</button>
              <button className="big danger-solid" disabled={busy || reason.trim().length < 10} onClick={override}>Hand over without code</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function DoneTab() {
  const [done, setDone] = useState<OrderView[] | null>(null);
  const [rejected, setRejected] = useState<OrderView[]>([]);
  useEffect(() => {
    api.get<{ orders: OrderView[] }>('/vendor/orders?view=completed').then((r) => setDone(r.orders)).catch(() => setDone([]));
    api.get<{ orders: OrderView[] }>('/vendor/orders?view=rejected').then((r) => setRejected(r.orders)).catch(() => undefined);
  }, []);
  const row = (o: OrderView) => (
    <tr key={o.id}>
      <td><b>{o.orderNumber}</b></td>
      <td><span className={'src small ' + (o.orderSource === 'WALKIN_QR' ? 'walkin' : 'pre')}>{ORDER_SOURCE_LABEL[o.orderSource]}</span></td>
      <td><span className={'badge ' + (o.status === 'COLLECTED' ? 'ok' : 'bad')}>{ORDER_STATUS_LABEL[o.status]}{o.collectedVia === 'MANUAL_OVERRIDE' ? ' (manual)' : ''}</span></td>
      <td className="num">{fmtTime(o.collectedAt ?? o.updatedAt)}</td>
      <td>{o.items.map((i) => `${i.quantity}× ${i.name}`).join(', ')}</td>
    </tr>
  );
  return (
    <div className="page">
      <section className="panel">
        <h2>Collected today</h2>
        <div className="table-wrap"><table><thead><tr><th>Order</th><th>Mode</th><th>Result</th><th>Time</th><th>Items</th></tr></thead><tbody>
          {done === null ? <tr><td colSpan={5} className="muted">Loading…</td></tr> : done.length === 0 ? <tr><td colSpan={5} className="muted">Nothing collected yet today.</td></tr> : done.map(row)}
        </tbody></table></div>
      </section>
      <section className="panel">
        <h2>Rejected or cancelled today</h2>
        <p className="muted small">The student was refunded for each of these.</p>
        <div className="table-wrap"><table><thead><tr><th>Order</th><th>Mode</th><th>Result</th><th>Time</th><th>Items</th></tr></thead><tbody>
          {rejected.length === 0 ? <tr><td colSpan={5} className="muted">None today.</td></tr> : rejected.map(row)}
        </tbody></table></div>
      </section>
    </div>
  );
}

const DietDot = ({ diet }: { diet: MenuItem['diet'] }) => (diet ? <span className={'diet ' + diet.toLowerCase()} aria-label={diet === 'VEG' ? 'Vegetarian' : diet === 'EGG' ? 'Contains egg' : 'Non-vegetarian'} /> : null);

function MenuTab({ info, onChange, onError }: { info: ShopInfo; onChange: () => void; onError: (m: string) => void }) {
  const toggle = async (id: string, available: boolean) => {
    try {
      await api.patch(`/vendor/menu-items/${id}`, { available });
      onChange();
    } catch (e) {
      onError(errMsg(e));
    }
  };
  const toggleMod = async (id: string, available: boolean) => {
    try {
      await api.patch(`/vendor/modifiers/${id}`, { available });
      onChange();
    } catch (e) {
      onError(errMsg(e));
    }
  };
  const soldOut = info.items.filter((m) => !m.available).length;
  return (
    <div className="page">
      <div className="page-head"><h2>Menu</h2><p className="muted">Turn an item or option off when it runs out. Students can’t order it until you turn it back on.{soldOut > 0 && <> <b className="bad-text">{soldOut} sold out.</b></>}</p></div>
      <ul className="menu-list">
        {info.items.map((m) => (
          <li key={m.id} className={m.available ? '' : 'off'}>
            <div className="menu-main">
              <div><b><DietDot diet={m.diet} />{m.name}</b><span className="num muted">{formatPaise(m.basePricePaise)}</span></div>
              <button className={'switch ' + (m.available ? 'on' : 'off')} role="switch" aria-checked={m.available} aria-label={`${m.name} available`} onClick={() => toggle(m.id, !m.available)}>
                <span>{m.available ? 'Available' : 'Sold out'}</span><span className="track"><span className="knob" /></span>
              </button>
            </div>
            {m.modifiers.length > 0 && (
              <div className="mod-row">
                {m.modifiers.map((x) => (
                  <button key={x.id} className={'mod-chip ' + (x.available ? '' : 'off')} onClick={() => toggleMod(x.id, !x.available)} aria-pressed={x.available}>
                    {x.name}{x.pricePaise ? ` +${formatPaise(x.pricePaise)}` : ''} · {x.available ? 'on' : 'off'}
                  </button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function PrinterTab({ info, jobs, onChange, onError }: { info: ShopInfo; jobs: PrintJob[]; onChange: () => Promise<void>; onError: (m: string) => void }) {
  const printer = info.printers[0] ?? null;
  const [editing, setEditing] = useState(!printer);
  const [form, setForm] = useState({ name: printer?.name ?? 'Kitchen printer', connection: (printer?.connection ?? (isNativeApp() ? 'BLUETOOTH' : 'SIMULATED')) as PrinterConfig['connection'], address: printer?.address ?? '', paperWidthMm: printer?.paperWidthMm ?? 80, model: printer?.model ?? '' });
  const [paired, setPaired] = useState<Array<{ name: string; address: string }>>([]);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState('');
  const [, force] = useState(0);
  useEffect(() => simulator.subscribe(() => force((n) => n + 1)), []);
  useEffect(() => {
    if (form.connection === 'BLUETOOTH') void pairedPrinters().then(setPaired);
  }, [form.connection]);

  const save = async () => {
    try {
      await api.post('/vendor/printers', form);
      setEditing(false);
      await onChange();
    } catch (e) {
      onError(errMsg(e));
    }
  };
  const test = async () => {
    if (!printer) return;
    setChecking(true);
    setResult('');
    const s = await checkPrinter(printer);
    try {
      if (s.state === 'ONLINE') await printTicket(printer, testTicket(info.shop.name), 'test-' + Date.now());
      await api.post(`/vendor/printers/${printer.id}/status`, { status: s.state, error: s.detail });
      setResult(s.state === 'ONLINE' ? 'Test slip sent. Check the printer.' : `Printer problem: ${s.detail ?? s.state}`);
    } catch (e) {
      const pe = e instanceof PrintError ? e : null;
      await api.post(`/vendor/printers/${printer.id}/status`, { status: pe?.state ?? 'ERROR', error: (e as Error).message }).catch(() => undefined);
      setResult(`Test failed: ${(e as Error).message}`);
    } finally {
      setChecking(false);
      await onChange();
    }
  };
  const retry = async (id: string) => {
    try {
      await api.post(`/vendor/print-jobs/${id}/retry`);
      await onChange();
    } catch (e) {
      onError(errMsg(e));
    }
  };

  const failed = jobs.filter((j) => j.status === 'FAILED');
  const waiting = jobs.filter((j) => j.status === 'PENDING' || j.status === 'CLAIMED');
  return (
    <div className="page">
      <div className="page-head"><h2>Kitchen printer</h2><p className="muted">Slips print automatically when you accept an order. If printing fails the order stays on the board, and slips retry on their own a few times.</p></div>

      {printer && !editing && (
        <section className="panel">
          <div className="printer-head">
            <div>
              <h3>{printer.name}</h3>
              <p className="muted small">{printer.connection === 'SIMULATED' ? 'Simulated printer — slips appear on screen (browser testing)' : `${printer.connection === 'BLUETOOTH' ? 'Bluetooth' : 'Network'} · ${printer.address}`} · {printer.paperWidthMm} mm</p>
            </div>
            <span className={'pstat ' + (printer.status === 'ONLINE' ? 'ok' : printer.status === 'UNKNOWN' ? 'wait' : 'bad')}>{{ ONLINE: 'Ready', OFFLINE: 'Offline', PAPER_OUT: 'Out of paper', ERROR: 'Error', UNKNOWN: 'Not checked yet' }[printer.status]}</span>
          </div>
          {printer.lastError && printer.status !== 'ONLINE' && <div className="error">{printer.lastError}</div>}
          <div className="row wrap">
            <button className="big primary" disabled={checking} onClick={test}>{checking ? 'Checking…' : 'Test print'}</button>
            <button className="big" onClick={() => setEditing(true)}>Change printer</button>
          </div>
          {result && <p className="notice">{result}</p>}
          {printer.connection === 'SIMULATED' && (
            <div className="sim-controls">
              <span className="muted small">Try failures (simulated printer only):</span>
              {(['none', 'offline', 'paper_out'] as const).map((f) => (
                <button key={f} className={'small-btn ' + (simulator.fault === f ? 'sel' : '')} onClick={() => simulator.setFault(f)}>{{ none: 'Working', offline: 'Switched off', paper_out: 'Out of paper' }[f]}</button>
              ))}
            </div>
          )}
        </section>
      )}

      {editing && (
        <section className="panel">
          <h3>{printer ? 'Change printer' : 'Set up the kitchen printer'}</h3>
          <div className="seg" role="radiogroup" aria-label="Connection">
            {(['BLUETOOTH', 'NETWORK', 'SIMULATED'] as const).map((c) => (
              <button key={c} role="radio" aria-checked={form.connection === c} className={form.connection === c ? 'sel' : ''} onClick={() => setForm({ ...form, connection: c, address: c === 'SIMULATED' ? '' : form.address })}>
                {{ BLUETOOTH: 'Bluetooth', NETWORK: 'Wi-Fi / LAN', SIMULATED: 'Simulated (testing)' }[c]}
              </button>
            ))}
          </div>
          {!isNativeApp() && form.connection !== 'SIMULATED' && <p className="notice">Bluetooth and network printers work in the Android app. In this browser, use the simulated printer.</p>}
          <div className="field"><label htmlFor="pn">Name</label><input id="pn" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          {form.connection === 'BLUETOOTH' && (
            <div className="field">
              <label htmlFor="pa">Printer (pair it in Android Bluetooth settings first)</label>
              {paired.length > 0 ? (
                <select id="pa" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })}>
                  <option value="">Choose a paired printer</option>
                  {paired.map((d) => <option key={d.address} value={d.address}>{d.name} ({d.address})</option>)}
                </select>
              ) : (
                <input id="pa" placeholder="00:11:22:33:44:55" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value.toUpperCase() })} />
              )}
            </div>
          )}
          {form.connection === 'NETWORK' && <div className="field"><label htmlFor="pa">IP address and port</label><input id="pa" placeholder="192.168.1.50:9100" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></div>}
          <div className="field"><label>Paper width</label>
            <div className="seg">{([80, 58] as const).map((w) => <button key={w} className={form.paperWidthMm === w ? 'sel' : ''} onClick={() => setForm({ ...form, paperWidthMm: w })}>{w} mm</button>)}</div>
          </div>
          <div className="row wrap">
            {printer && <button className="big" onClick={() => setEditing(false)}>Cancel</button>}
            <button className="big primary" onClick={save} disabled={form.connection !== 'SIMULATED' && !form.address}>Save printer</button>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Slips that need attention</h2>
        {failed.length === 0 && waiting.length === 0 && <p className="muted">All slips printed.</p>}
        {failed.map((j) => (
          <div key={j.id} className="job bad">
            <div><b>{j.ticket.orderNumber}</b>{j.copyNumber > 1 && <span className="muted"> · copy {j.copyNumber}</span>}<p className="small">Failed after {j.attempt} tries: {j.lastError}</p></div>
            <button className="big primary" onClick={() => retry(j.id)}>Retry</button>
          </div>
        ))}
        {waiting.map((j) => (
          <div key={j.id} className="job">
            <div><b>{j.ticket.orderNumber}</b><p className="small muted">{j.status === 'CLAIMED' ? 'Printing…' : j.attempt > 0 ? `Will retry automatically (try ${j.attempt + 1} of ${j.maxAttempts})` : 'Waiting to print'}{j.lastError ? ` — ${j.lastError}` : ''}</p></div>
          </div>
        ))}
      </section>
    </div>
  );
}

/** On-screen slip output for the simulated printer (browser testing). */
function SlipTray() {
  const [, force] = useState(0);
  const [open, setOpen] = useState(true);
  const count = useRef(simulator.slips.length);
  // Open when a new slip "prints", then fold away after a few seconds so it never covers the board for long.
  useEffect(
    () =>
      simulator.subscribe(() => {
        if (simulator.slips.length > count.current) setOpen(true);
        count.current = simulator.slips.length;
        force((n) => n + 1);
      }),
    [],
  );
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => setOpen(false), 8000);
    return () => clearTimeout(t);
  }, [open, simulator.slips.length]);
  const slips = simulator.slips;
  if (slips.length === 0) return null;
  return (
    <aside className={'tray' + (open ? ' open' : '')} aria-label="Simulated printer output">
      <button className="tray-head" onClick={() => setOpen(!open)}><PrinterIcon />Simulated printer · {slips.length} slip{slips.length === 1 ? '' : 's'} {open ? '▾' : '▸'}</button>
      {open && (
        <div className="tray-body">
          {slips.slice(0, 1).map((s) => <pre key={s.id + s.at} className="slip">{s.lines.join('\n')}</pre>)}
          {slips.length > 1 && <p className="muted small">{slips.length - 1} earlier slip{slips.length === 2 ? '' : 's'} hidden</p>}
          <button className="small-btn" onClick={() => simulator.clear()}>Clear</button>
        </div>
      )}
    </aside>
  );
}

function Today() {
  const [sum, setSum] = useState<any>(null);
  const [days, setDays] = useState<{ day: string; orders: number; entitlementPaise: number }[]>([]);
  useEffect(() => {
    api.get<any>('/vendor/summary').then(setSum).catch(() => undefined);
    api.get<any>('/vendor/settlements').then((r) => setDays(r.days)).catch(() => undefined);
  }, []);
  return (
    <div className="page">
      <div className="stats">
        <div className="stat"><span>Collected today</span><b className="num">{sum?.collectedOrders ?? '–'}</b></div>
        <div className="stat"><span>Food value collected</span><b className="num">{sum ? formatPaise(sum.foodValuePaise) : '–'}</b></div>
        <div className="stat"><span>Walk-in · pre-order</span><b className="num">{sum ? `${sum.bySource.WALKIN_QR.collected} · ${sum.bySource.PREORDER.collected}` : '–'}</b></div>
        <div className="stat"><span>Not fulfilled</span><b className="num">{sum?.notFulfilled ?? '–'}</b></div>
      </div>
      <section className="panel">
        <h2>What you’re owed</h2>
        <p className="muted small">You receive your full menu price for every collected order. This is test data; no real settlement has happened.</p>
        <div className="table-wrap"><table><thead><tr><th>Day</th><th>Orders</th><th>Amount</th></tr></thead><tbody>
          {days.length === 0 && <tr><td colSpan={3} className="muted">Nothing yet.</td></tr>}
          {days.map((d) => <tr key={d.day}><td>{d.day}</td><td className="num">{d.orders}</td><td className="num">{formatPaise(d.entitlementPaise)}</td></tr>)}
        </tbody></table></div>
      </section>
    </div>
  );
}
