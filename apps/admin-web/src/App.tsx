import { ApiError, ORDER_SOURCE_LABEL, ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL, createApiClient, formatPaise, type OrderSource, type OrderStatus, type OrderView, type PaymentStatus } from '@qp2/shared';
import React, { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:4100';
const api = createApiClient({ baseUrl: API_URL, tokenKey: 'qp2_admin_token', onUnauthorized: () => window.dispatchEvent(new Event('qp-logout')) });
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const dt = (s: string | null | undefined) => (s ? new Date(s).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—');
const cap = (s: string) => (s ? s[0] + s.slice(1).toLowerCase().replace(/_/g, ' ') : s);
const ostatus = (s: string) => ORDER_STATUS_LABEL[s as OrderStatus] ?? cap(s);
const pstatus = (s: string) => PAYMENT_STATUS_LABEL[s as PaymentStatus] ?? cap(s);
const rupeesToPaise = (v: string) => Math.round(parseFloat(v) * 100);
const todayIst = () => new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);

type Tab = 'overview' | 'orders' | 'shops' | 'menu' | 'vendors' | 'devices' | 'printers' | 'payments' | 'recon' | 'settlements' | 'pricing' | 'support' | 'audit';
const TABS: [Tab, string][] = [
  ['overview', 'Overview'], ['orders', 'Orders'], ['shops', 'Shops & QR codes'], ['menu', 'Menus'], ['vendors', 'Vendors'], ['devices', 'Tablets'], ['printers', 'Printers'],
  ['payments', 'Payments & refunds'], ['recon', 'Reconciliation'], ['settlements', 'Settlements'], ['pricing', 'Pricing'], ['support', 'Support'], ['audit', 'Audit log'],
];

export function App() {
  const [user, setUser] = useState<{ name: string; role: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [tab, setTab] = useState<Tab>('overview');
  useEffect(() => {
    if (!api.getToken()) return void setChecked(true);
    api.get<{ user: { name: string; role: string } }>('/me').then((r) => setUser(r.user)).catch(() => api.clearToken()).finally(() => setChecked(true));
    const on = () => { api.clearToken(); setUser(null); };
    window.addEventListener('qp-logout', on);
    return () => window.removeEventListener('qp-logout', on);
  }, []);
  if (!checked) return <p className="muted" style={{ padding: 16 }}>Loading…</p>;
  if (!user || !['ADMIN', 'SUPER_ADMIN'].includes(user.role)) return <Login onDone={setUser} />;
  return (
    <>
      <div className="sandbox-banner">Test mode: real payments stay off until the payment provider, a CA and the relevant authorities approve the structure</div>
      <div className="layout">
        <nav className="side" aria-label="Sections">
          <div className="brand"><span className="mark" aria-hidden><Cup /></span><div><b>Java QuickPick</b><span>Admin · V2</span></div></div>
          <div className="side-links">{TABS.map(([k, label]) => <button key={k} className={tab === k ? 'active' : ''} aria-current={tab === k ? 'page' : undefined} onClick={() => setTab(k)}>{label}</button>)}</div>
          <div className="side-foot">
            <div className="who"><b>{user.name}</b><span>{user.role === 'SUPER_ADMIN' ? 'Platform owner' : 'Admin'}</span></div>
            <button onClick={() => { api.clearToken(); setUser(null); }}>Sign out</button>
          </div>
        </nav>
        <main className="main">
          {tab === 'overview' && <Overview />}
          {tab === 'orders' && <Orders />}
          {tab === 'shops' && <Shops />}
          {tab === 'menu' && <Menus />}
          {tab === 'vendors' && <Vendors />}
          {tab === 'devices' && <Devices />}
          {tab === 'printers' && <Printers />}
          {tab === 'payments' && <Payments />}
          {tab === 'recon' && <Reconciliation />}
          {tab === 'settlements' && <Settlements />}
          {tab === 'pricing' && <Pricing superAdmin={user.role === 'SUPER_ADMIN'} />}
          {tab === 'support' && <Support />}
          {tab === 'audit' && <Audit />}
        </main>
      </div>
    </>
  );
}

const Cup = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9h13v4a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6V9Z" /><path d="M17 10h1.5a2.5 2.5 0 0 1 0 5H17" /><path d="M8 3v3M12 3v3" /></svg>;

function Login({ onDone }: { onDone: (u: { name: string; role: string }) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setErr('');
    try {
      const r = await api.post<{ token: string; user: { name: string; role: string } }>('/auth/login', { email, password });
      if (!['ADMIN', 'SUPER_ADMIN'].includes(r.user.role)) return setErr('This sign-in is for administrators only.');
      api.setToken(r.token);
      onDone(r.user);
    } catch (e) {
      setErr(errMsg(e));
    }
  };
  return (
    <div className="admin-login">
      <form className="card stack" onSubmit={submit}>
        <div className="brand dark"><span className="mark" aria-hidden><Cup /></span><div><b>Java QuickPick</b><span>Admin · V2</span></div></div>
        <h1>Sign in</h1>
        <div className="field"><label htmlFor="e">Email</label><input id="e" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
        <div className="field"><label htmlFor="p">Password</label><input id="p" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        {err && <div className="error" role="alert">{err}</div>}
        <button className="primary">Sign in</button>
      </form>
    </div>
  );
}

// ---------- helpers ----------
function useLoad<T>(path: string, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const reload = useCallback(() => {
    api.get<T>(path).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(errMsg(e)));
  }, [path]);
  useEffect(reload, [reload, ...deps]);
  return { data, err, reload };
}
const Section = ({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) => (
  <section className="card stack"><div className="section-head"><h2>{title}</h2>{right}</div>{children}</section>
);
const Err = ({ msg }: { msg: string }) => (msg ? <div className="error" role="alert">{msg}</div> : null);
const tone = (s: string) =>
  ['COLLECTED', 'SUCCEEDED', 'REFUNDED', 'PROCESSED', 'ACTIVE', 'RESOLVED', 'AUTO_RESOLVED', 'PRINTED', 'ONLINE', 'SENT', 'SIMULATED', 'SUCCESS', 'LOANED'].includes(s)
    ? 'ok'
    : ['REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED', 'SUSPENDED', 'NOT_COLLECTED', 'REFUND_FAILED', 'OFFLINE', 'PAPER_OUT', 'ERROR', 'OPEN', 'MISMATCH', 'LOCKED', 'OVERRIDE', 'LOST', 'DAMAGED'].includes(s)
      ? 'bad'
      : 'warn';
const Mode = ({ s }: { s: OrderSource }) => <span className={'mode ' + (s === 'WALKIN_QR' ? 'walkin' : 'pre')}>{ORDER_SOURCE_LABEL[s]}</span>;

// ---------- overview ----------
function Overview() {
  const [date, setDate] = useState(todayIst());
  const [days, setDays] = useState(1);
  const { data, err } = useLoad<any>(`/admin/analytics?date=${date}&days=${days}`, [date, days]);
  const [csvErr, setCsvErr] = useState('');
  const download = async () => {
    try {
      const text = await api.text(`/admin/export/orders.csv?date=${date}`);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
      a.download = `quickpick-v2-orders-${date}.csv`;
      a.click();
    } catch (e) {
      setCsvErr(errMsg(e));
    }
  };
  const peakMax = data ? Math.max(1, ...data.peakHours.map((h: any) => h.preorder + h.walkin)) : 1;
  const hours = data ? data.peakHours.filter((h: any) => h.hour >= 7 && h.hour <= 22) : [];
  return (
    <>
      <Section
        title="Overview"
        right={<div className="row"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Start date" style={{ width: 160 }} /><select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Range"><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option></select><button onClick={download}>Export CSV</button></div>}
      >
        <Err msg={err || csvErr} />
        {data && (
          <div className="kpis">
            {[
              ['Shops (active / total)', `${data.activeShops} / ${data.totalShops}`],
              ['Paid orders', data.paidOrders],
              ['Food value', formatPaise(data.foodGmvPaise)],
              ['QuickPick fees (gross)', formatPaise(data.grossFeePaise)],
              ['Payments collected', formatPaise(data.paymentsCollectedPaise)],
              ['Refunds processed', formatPaise(data.refundsProcessedPaise)],
              ['Rejected / cancelled / expired', data.cancelledOrders],
            ].map(([l, v]) => <div className="kpi" key={String(l)}><span>{l}</span><b className="num">{v}</b></div>)}
          </div>
        )}
        <p className="muted small">Gross fees are not profit: payment charges, taxes, refunds, hosting, tablets, printers and support are not deducted. Sandbox data only.</p>
      </Section>
      {data && (
        <div className="two-col">
          <Section title="By ordering mode">
            <div className="modes-split">
              {(['PREORDER', 'WALKIN_QR'] as const).map((s) => (
                <div key={s} className={'mode-box ' + (s === 'WALKIN_QR' ? 'walkin' : 'pre')}>
                  <Mode s={s} />
                  <b className="num">{data.bySource[s].orders}</b><span>paid orders</span>
                  <span className="small">{formatPaise(data.bySource[s].foodGmvPaise)} food · {formatPaise(data.bySource[s].feePaise)} fees</span>
                </div>
              ))}
            </div>
          </Section>
          <Section title="Peak ordering hours (IST)">
            <div className="bars" role="img" aria-label="Paid orders per hour, pre-order and walk-in">
              {hours.map((h: any) => (
                <div key={h.hour} className="bar-col" title={`${h.hour}:00 — ${h.preorder} pre-order, ${h.walkin} walk-in`}>
                  <div className="bar-stack" style={{ height: `${((h.preorder + h.walkin) / peakMax) * 100}%` }}>
                    <span className="seg walkin" style={{ flex: h.walkin }} />
                    <span className="seg pre" style={{ flex: h.preorder }} />
                  </div>
                  <span className="bar-label">{h.hour % 12 || 12}{h.hour < 12 ? 'a' : 'p'}</span>
                </div>
              ))}
            </div>
            <p className="legend small"><span className="dot pre" /> Pre-order <span className="dot walkin" /> Walk-in</p>
          </Section>
        </div>
      )}
      {data && (
        <Section title="By shop">
          <div className="table-wrap"><table><thead><tr><th>Shop</th><th>Paid orders</th><th>Walk-in</th><th>Pre-order</th><th>Food value</th><th>Fees</th><th>Rejected</th></tr></thead><tbody>
            {data.byShop.map((s: any) => <tr key={s.shopId}><td><b>{s.code}</b> {s.name}</td><td className="num">{s.orders}</td><td className="num">{s.walkin}</td><td className="num">{s.preorder}</td><td className="price">{formatPaise(s.foodGmvPaise)}</td><td className="price">{formatPaise(s.feePaise)}</td><td className="num">{s.rejected}</td></tr>)}
          </tbody></table></div>
          <p className="muted small">Each vendor sees only their own shop’s figures on their tablet.</p>
        </Section>
      )}
    </>
  );
}

// ---------- orders ----------
function Orders() {
  const [status, setStatus] = useState('');
  const [source, setSource] = useState('');
  const qs = new URLSearchParams({ ...(status ? { status } : {}), ...(source ? { source } : {}) }).toString();
  const { data, err, reload } = useLoad<{ orders: OrderView[] }>(`/admin/orders${qs ? `?${qs}` : ''}`);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { const t = setInterval(reload, 15000); return () => clearInterval(t); }, [reload]);
  return (
    <Section
      title="Orders"
      right={<div className="row">
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Filter by mode"><option value="">All modes</option><option value="WALKIN_QR">Walk-in</option><option value="PREORDER">Pre-order</option></select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status"><option value="">All statuses</option>{Object.keys(ORDER_STATUS_LABEL).map((s) => <option key={s} value={s}>{ostatus(s)}</option>)}</select>
        <button onClick={reload}>Refresh</button>
      </div>}
    >
      <Err msg={err} />
      <div className="table-wrap"><table><thead><tr><th>Order</th><th>Mode</th><th>Shop</th><th>Status</th><th>Payment</th><th>Total</th><th>Pickup / estimate</th><th>Placed</th><th /></tr></thead><tbody>
        {data?.orders.map((o) => (
          <tr key={o.id} className={open === o.id ? 'selected' : ''}>
            <td><b>{o.orderNumber}</b></td><td><Mode s={o.orderSource} /></td><td>{o.shopName}</td><td><span className={'badge ' + tone(o.status)}>{ostatus(o.status)}</span></td><td>{pstatus(o.paymentStatus)}</td>
            <td className="price">{formatPaise(o.totalPaise)}</td><td>{o.slotStartsAt ? dt(o.slotStartsAt) : o.estimatedReadyAt ? `~${dt(o.estimatedReadyAt)}` : '—'}</td><td className="small">{dt(o.createdAt)}</td>
            <td><button className="small" onClick={() => setOpen(open === o.id ? null : o.id)}>{open === o.id ? 'Hide' : 'Details'}</button></td>
          </tr>
        ))}
        {data?.orders.length === 0 && <tr><td colSpan={9} className="muted">No orders.</td></tr>}
      </tbody></table></div>
      {open && <OrderDetail key={open} id={open} onChange={reload} />}
    </Section>
  );
}

function OrderDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const { data, err, reload } = useLoad<any>(`/admin/orders/${id}`);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [ovr, setOvr] = useState('');
  const [msg, setMsg] = useState('');
  if (!data) return <Err msg={err} />;
  const o = data.order;
  const refund = async () => {
    setMsg('');
    try {
      await api.post('/admin/refunds', { orderId: id, reason, ...(amount ? { amountPaise: rupeesToPaise(amount) } : {}) }, { 'Idempotency-Key': crypto.randomUUID() });
      setAmount(''); setReason(''); reload(); onChange();
    } catch (e) { setMsg(errMsg(e)); }
  };
  const override = async () => {
    setMsg('');
    try { await api.post(`/admin/orders/${id}/collect-override`, { reason: ovr }); setOvr(''); reload(); onChange(); } catch (e) { setMsg(errMsg(e)); }
  };
  return (
    <div className="card stack detail">
      <div className="row between wrap"><h3>{o.orderNumber} · <Mode s={o.orderSource} /> · {o.shopName}</h3><span className="muted small">Student: {o.customerName} (first name only)</span></div>
      <div className="grid2">
        <div><h3>Timeline</h3><ul className="timeline">{data.events.map((e: any, i: number) => <li key={i}><b>{ostatus(e.to)}</b> <span className="muted">{dt(e.at)}, by {cap(e.actor)}{e.reason ? `: ${e.reason}` : ''}</span></li>)}</ul></div>
        <div>
          <h3>Items</h3>
          {o.items.map((i: any, k: number) => <p key={k} className="small">{i.quantity}× {i.name}{i.modifiers.length ? ` (${i.modifiers.map((m: any) => m.name).join(', ')})` : ''}{i.notes ? ` — “${i.notes}”` : ''} <span className="price">{formatPaise(i.lineTotalPaise)}</span></p>)}
          <p className="small">Food {formatPaise(o.subtotalPaise)} · Fee ({o.feeRateBps / 100}%) {formatPaise(o.feePaise)} · Tax {formatPaise(o.taxPaise)} · <b>Total {formatPaise(o.totalPaise)}</b></p>
          <p className="small">{o.slotStartsAt ? `Pickup slot ${dt(o.slotStartsAt)}` : `Estimate ${dt(o.estimatedReadyAt)}`}{o.prepMinutes ? ` · prep ${o.prepMinutes} min` : ''}{o.collectedVia ? ` · ${o.collectedVia === 'OTP' ? 'collected with code' : 'manual handover (audited)'}` : ''}</p>
        </div>
        <div><h3>Payment attempts</h3>{data.paymentAttempts.map((a: any) => <p key={a.attemptNo} className="small">#{a.attemptNo} <span className={'badge ' + tone(a.status)}>{cap(a.status)}</span> {dt(a.at)}{a.error ? ` — ${a.error}` : ''}</p>)}{data.paymentAttempts.length === 0 && <p className="muted small">None</p>}
          {data.payments.map((p: any) => <p key={p.id} className="small mono">{p.providerRef} · {formatPaise(p.amountPaise)} · {pstatus(p.status)}</p>)}</div>
        <div><h3>Planned split</h3>{data.splits.map((s: any) => <p key={s.beneficiary} className="small">{cap(s.beneficiary)}: {formatPaise(s.amountPaise)} <span className="muted">({cap(s.status)})</span></p>)}{data.splits.length === 0 && <p className="muted small">None</p>}</div>
        <div><h3>Refunds</h3>{data.refunds.map((r: any) => <p key={r.id} className="small">{formatPaise(r.amountPaise)} <span className={'badge ' + tone(r.status)}>{cap(r.status)}</span> {r.reason}{r.failureReason ? ` — ${r.failureReason}` : ''}</p>)}{data.refunds.length === 0 && <p className="muted small">None</p>}</div>
        <div><h3>Kitchen slips</h3>{data.printJobs.map((j: any) => <p key={j.copyNumber} className="small">Copy {j.copyNumber} ({cap(j.reason)}) <span className={'badge ' + tone(j.status)}>{cap(j.status)}</span> {j.attempts} tr{j.attempts === 1 ? 'y' : 'ies'}{j.lastError ? ` — ${j.lastError}` : ''}</p>)}{data.printJobs.length === 0 && <p className="muted small">None (printed only after acceptance)</p>}</div>
        <div><h3>Collection code checks</h3>{data.otpLog.map((l: any, i: number) => <p key={i} className="small"><span className={'badge ' + tone(l.outcome)}>{cap(l.outcome)}</span> {dt(l.at)}{l.note ? ` — ${l.note}` : ''}</p>)}{data.otpLog.length === 0 && <p className="muted small">None yet</p>}</div>
        <div><h3>Notifications</h3>{data.notifications.filter((n: any) => n.channel === 'PUSH').map((n: any, i: number) => <p key={i} className="small">{cap(n.type)} <span className={'badge ' + tone(n.status)}>{cap(n.status)}</span>{n.attempts > 1 ? ` · ${n.attempts} tries` : ''}{n.lastError ? ` — ${n.lastError}` : ''}</p>)}{data.notifications.length === 0 && <p className="muted small">None</p>}</div>
      </div>
      {['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUND_FAILED'].includes(o.paymentStatus) && (
        <div className="row wrap"><input style={{ maxWidth: 140 }} placeholder="₹ (blank = all)" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Refund amount in rupees" /><input placeholder="Refund reason" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Refund reason" /><button className="danger" disabled={!reason.trim()} onClick={refund}>Issue refund</button></div>
      )}
      {o.status === 'READY' && (
        <div className="row wrap"><input placeholder="Why hand over without the code? (checked ID…)" value={ovr} onChange={(e) => setOvr(e.target.value)} aria-label="Override reason" /><button className="danger" disabled={ovr.trim().length < 10} onClick={override}>Mark collected (audited)</button></div>
      )}
      <Err msg={msg} />
    </div>
  );
}

// ---------- shops ----------
type ShopForm = {
  code: string; name: string; description: string; cuisineTags: string; logoUrl: string; vendorId: string; openTime: string; closeTime: string; slotMinutes: number; slotCapacity: number;
  avgPrepMinutes: number; kitchenParallel: number; acceptTimeoutSeconds: number; fssaiNumber: string; ownerContact: string; acceptingOrders: boolean; preorderEnabled: boolean; walkinEnabled: boolean; isDemo: boolean;
};
const BLANK_SHOP: ShopForm = { code: '', name: '', description: '', cuisineTags: '', logoUrl: '', vendorId: '', openTime: '11:30', closeTime: '15:00', slotMinutes: 10, slotCapacity: 5, avgPrepMinutes: 10, kitchenParallel: 2, acceptTimeoutSeconds: 90, fssaiNumber: '', ownerContact: '', acceptingOrders: true, preorderEnabled: true, walkinEnabled: true, isDemo: false };
const toForm = (s: any): ShopForm => ({ ...BLANK_SHOP, ...Object.fromEntries(Object.keys(BLANK_SHOP).map((k) => [k, s[k] ?? (BLANK_SHOP as any)[k]])) } as ShopForm);
const toApi = (f: ShopForm) => ({ ...f, code: f.code.trim().toUpperCase(), name: f.name.trim(), description: f.description.trim(), cuisineTags: f.cuisineTags.trim(), logoUrl: f.logoUrl.trim() || null, vendorId: f.vendorId || null, fssaiNumber: f.fssaiNumber.trim() || null, ownerContact: f.ownerContact.trim() || null });
const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const clock12 = (t: string) => { const h = Number(t.slice(0, 2)); const m = t.slice(3, 5); return `${h % 12 || 12}${m === '00' ? '' : ':' + m} ${h >= 12 ? 'pm' : 'am'}`; };
function hoursProblem(f: ShopForm): string {
  if (!/^\d{2}:\d{2}$/.test(f.openTime) || !/^\d{2}:\d{2}$/.test(f.closeTime)) return 'Enter both opening and closing times.';
  if (mins(f.closeTime) <= mins(f.openTime)) return 'Closing time must be after opening time.';
  if (mins(f.closeTime) - mins(f.openTime) < f.slotMinutes) return 'Opening hours must be at least one pickup slot long.';
  return '';
}

function ShopFields({ f, set, editing, vendors }: { f: ShopForm; set: (f: ShopForm) => void; editing: boolean; vendors: any[] }) {
  const problem = hoursProblem(f);
  const count = problem ? 0 : Math.floor((mins(f.closeTime) - mins(f.openTime)) / f.slotMinutes);
  const id = editing ? 'e' : 'n';
  const num = (k: keyof ShopForm, min: number, max: number) => (e: React.ChangeEvent<HTMLInputElement>) => set({ ...f, [k]: Math.max(min, Math.min(max, Number(e.target.value) || min)) });
  return (
    <>
      <div className="fs"><h3>Shop details</h3><div className="grid2">
        <div className="field"><label htmlFor={id + 'code'}>Shop code (on the counter sign)</label><input id={id + 'code'} value={f.code} maxLength={12} placeholder="JG03" onChange={(e) => set({ ...f, code: e.target.value.toUpperCase() })} /></div>
        <div className="field"><label htmlFor={id + 'name'}>Name</label><input id={id + 'name'} value={f.name} maxLength={100} onChange={(e) => set({ ...f, name: e.target.value })} /></div>
        <div className="field"><label htmlFor={id + 'tags'}>Food categories (comma separated)</label><input id={id + 'tags'} value={f.cuisineTags} placeholder="South Indian, Coffee" onChange={(e) => set({ ...f, cuisineTags: e.target.value })} /></div>
        <div className="field"><label htmlFor={id + 'desc'}>Description shown to students</label><input id={id + 'desc'} value={f.description} maxLength={500} onChange={(e) => set({ ...f, description: e.target.value })} /></div>
        <div className="field"><label htmlFor={id + 'logo'}>Logo image URL (optional)</label><input id={id + 'logo'} value={f.logoUrl} placeholder="https://…" onChange={(e) => set({ ...f, logoUrl: e.target.value })} /></div>
        <div className="field"><label htmlFor={id + 'vendor'}>Vendor (who is paid)</label><select id={id + 'vendor'} value={f.vendorId} onChange={(e) => set({ ...f, vendorId: e.target.value })}><option value="">Not linked yet</option>{vendors.map((v) => <option key={v.id} value={v.id}>{v.legalName}</option>)}</select></div>
        <div className="field"><label htmlFor={id + 'fssai'}>FSSAI number (as provided)</label><input id={id + 'fssai'} value={f.fssaiNumber} maxLength={40} onChange={(e) => set({ ...f, fssaiNumber: e.target.value })} /></div>
        <div className="field"><label htmlFor={id + 'contact'}>Owner contact (QuickPick staff only)</label><input id={id + 'contact'} value={f.ownerContact} maxLength={200} onChange={(e) => set({ ...f, ownerContact: e.target.value })} /></div>
      </div></div>

      <div className="fs"><h3>Ordering modes</h3>
        <label className="check"><input type="checkbox" checked={f.walkinEnabled} onChange={(e) => set({ ...f, walkinEnabled: e.target.checked })} /> Walk-in QR orders <span className="muted small">(students at the counter scan the shop’s QR)</span></label>
        <label className="check"><input type="checkbox" checked={f.preorderEnabled} onChange={(e) => set({ ...f, preorderEnabled: e.target.checked })} /> Pre-orders with a pickup slot</label>
        {editing && <label className="check"><input type="checkbox" checked={f.acceptingOrders} onChange={(e) => set({ ...f, acceptingOrders: e.target.checked })} /> Taking orders now <span className="muted small">(the shop can also pause from its tablet)</span></label>}
        <label className="check"><input type="checkbox" checked={f.isDemo} onChange={(e) => set({ ...f, isDemo: e.target.checked })} /> Demo shop</label>
      </div>

      <div className="fs"><h3>Hours, pickup slots and kitchen speed (IST)</h3><div className="grid2">
        <div className="field"><label htmlFor={id + 'open'}>Opens</label><input id={id + 'open'} type="time" step={300} value={f.openTime} onChange={(e) => set({ ...f, openTime: e.target.value })} /></div>
        <div className="field"><label htmlFor={id + 'close'}>Closes</label><input id={id + 'close'} type="time" step={300} value={f.closeTime} onChange={(e) => set({ ...f, closeTime: e.target.value })} /></div>
        <div className="field"><label htmlFor={id + 'slot'}>Pickup slot length</label><select id={id + 'slot'} value={f.slotMinutes} onChange={(e) => set({ ...f, slotMinutes: Number(e.target.value) })}>{[5, 10, 15, 20, 30, 45, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}</select></div>
        <div className="field"><label htmlFor={id + 'cap'}>Pre-orders per slot</label><input id={id + 'cap'} type="number" min={0} max={100} value={f.slotCapacity} onChange={num('slotCapacity', 0, 100)} /></div>
        <div className="field"><label htmlFor={id + 'prep'}>Average minutes per order</label><input id={id + 'prep'} type="number" min={1} max={120} value={f.avgPrepMinutes} onChange={num('avgPrepMinutes', 1, 120)} /></div>
        <div className="field"><label htmlFor={id + 'par'}>Orders the kitchen makes at once</label><input id={id + 'par'} type="number" min={1} max={20} value={f.kitchenParallel} onChange={num('kitchenParallel', 1, 20)} /></div>
        <div className="field"><label htmlFor={id + 'acc'}>Time to accept a new order</label><select id={id + 'acc'} value={f.acceptTimeoutSeconds} onChange={(e) => set({ ...f, acceptTimeoutSeconds: Number(e.target.value) })}>{[...new Set([30, 60, 90, 120, 180, 300, f.acceptTimeoutSeconds])].sort((a, b) => a - b).map((t) => <option key={t} value={t}>{t < 60 ? `${t} s` : `${(t / 60).toFixed(t % 60 ? 1 : 0)} min`}</option>)}</select></div>
      </div>
        {problem ? <div className="error" role="alert">{problem}</div> : (
          <p className="preview"><b>{count} pickup time{count === 1 ? '' : 's'}</b> a day, every {f.slotMinutes} min from {clock12(f.openTime)}, up to {f.slotCapacity} pre-order{f.slotCapacity === 1 ? '' : 's'} each. Walk-in estimate starts at {f.avgPrepMinutes} min and grows by {f.avgPrepMinutes} min for every {f.kitchenParallel} orders in the queue.</p>
        )}
      </div>
    </>
  );
}

function QrPanel({ shopId, onClose }: { shopId: string; onClose: () => void }) {
  const { data, err, reload } = useLoad<{ url: string; svg: string; name: string; code: string; version: number }>(`/admin/shops/${shopId}/qr`);
  const [confirm, setConfirm] = useState(false);
  const [msg, setMsg] = useState('');
  const token = data?.url.split('/s/')[1] ?? '';
  // Generated tokens are 12 letters/digits: print them as abcd-efgh-jkmn. (Typed dashes are ignored by the API.)
  const pretty = /^[a-z0-9]{12}$/.test(token) ? token.replace(/(.{4})(?=.)/g, '$1-') : token;
  const download = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([data!.svg], { type: 'image/svg+xml' }));
    a.download = `quickpick-${data!.code}-qr-v${data!.version}.svg`;
    a.click();
  };
  const poster = () => {
    const w = window.open('', '_blank');
    if (!w) return;
    w.document.write(`<!doctype html><title>${data!.code} QR poster</title><style>body{font-family:system-ui,sans-serif;text-align:center;padding:40px}h1{font-size:40px;margin:0}h2{font-weight:500;margin:8px 0 24px}svg{width:360px;height:360px}p{font-size:18px}.code{font:600 22px ui-monospace,monospace;letter-spacing:.08em}</style><h1>${data!.name}</h1><h2>Scan to order &amp; pay — no queue</h2>${data!.svg}<p>Java QuickPick · Walk-in order</p><p class="code">${pretty}</p><script>setTimeout(()=>print(),300)</script>`);
    w.document.close();
  };
  const regen = async () => {
    setMsg('');
    try { await api.post(`/admin/shops/${shopId}/qr/regenerate`); setConfirm(false); reload(); setMsg('New QR created. Print and display it — the old one no longer works.'); } catch (e) { setMsg(errMsg(e)); }
  };
  return (
    <Section title={`Walk-in QR — ${data?.name ?? ''}`} right={<button onClick={onClose}>Close</button>}>
      <Err msg={err} />
      {data && (
        <div className="qr-row">
          <div className="qr-img" dangerouslySetInnerHTML={{ __html: data.svg }} />
          <div className="stack">
            <p>Students scan this at <b>{data.name}</b>’s counter. It opens the shop’s menu in walk-in mode on any phone browser — no install, no searching.</p>
            <p className="small">Link: <span className="mono">{data.url}</span></p>
            <p className="small">Code printed under the QR (for typing in): <b className="mono">{pretty}</b> · version {data.version}</p>
            <div className="row wrap"><button className="primary" onClick={poster}>Print poster</button><button onClick={download}>Download SVG</button>
              {!confirm ? <button className="danger" onClick={() => setConfirm(true)}>Replace QR…</button> : <><span className="small">Old posters stop working.</span><button className="danger" onClick={regen}>Replace now</button><button onClick={() => setConfirm(false)}>Cancel</button></>}
            </div>
            {msg && <div className="success">{msg}</div>}
          </div>
        </div>
      )}
    </Section>
  );
}

function EditShop({ shop, vendors, onClose, onSaved }: { shop: any; vendors: any[]; onClose: () => void; onSaved: (name: string) => void }) {
  const original = toForm(shop);
  const [f, setF] = useState<ShopForm>(original);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, []);
  const a = toApi(f);
  const o = toApi(original);
  const changes = Object.fromEntries(Object.entries(a).filter(([k, v]) => v !== (o as any)[k]));
  const dirty = Object.keys(changes).length > 0;
  const save = async () => {
    setMsg('');
    if (!a.name) return setMsg('Give the shop a name.');
    const problem = hoursProblem(f);
    if (problem) return setMsg(problem);
    setBusy(true);
    try { await api.patch(`/admin/shops/${shop.id}`, changes); onSaved(a.name); } catch (e) { setMsg(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <div ref={ref}>
      <Section title={`Edit ${shop.name}`} right={<button onClick={onClose}>Close</button>}>
        <ShopFields f={f} set={setF} editing vendors={vendors} />
        <Err msg={msg} />
        <div className="row wrap form-actions">
          <button className="primary" disabled={!dirty || busy} onClick={save}>{busy ? 'Saving…' : 'Save changes'}</button>
          <button onClick={() => setF(original)} disabled={!dirty || busy}>Undo changes</button>
        </div>
      </Section>
    </div>
  );
}

function Shops() {
  const { data, err, reload } = useLoad<{ shops: any[] }>('/admin/shops');
  const vendors = useLoad<{ vendors: any[] }>('/admin/vendors');
  const [form, setForm] = useState<ShopForm>(BLANK_SHOP);
  const [msg, setMsg] = useState('');
  const [saved, setSaved] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const create = async () => {
    setMsg(''); setSaved('');
    const problem = hoursProblem(form);
    if (problem) return setMsg(problem);
    const { acceptingOrders: _a, ...body } = toApi(form);
    try { await api.post('/admin/shops', body); setSaved(`Created ${body.name}. It stays hidden from students until you activate it.`); setForm(BLANK_SHOP); reload(); } catch (e) { setMsg(errMsg(e)); }
  };
  const patch = async (id: string, body: object) => { setMsg(''); setSaved(''); try { await api.patch(`/admin/shops/${id}`, body); reload(); } catch (e) { setMsg(errMsg(e)); } };
  const editShop = data?.shops.find((s) => s.id === editing);
  return (
    <>
      <Section title="Shops"><Err msg={err || msg} />{saved && <div className="success" role="status">{saved}</div>}
        <div className="table-wrap"><table><thead><tr><th>Shop</th><th>Status</th><th>Modes</th><th>Hours (IST)</th><th>Kitchen</th><th>Vendor</th><th /></tr></thead><tbody>
          {data?.shops.map((s) => (
            <tr key={s.id} className={editing === s.id || qr === s.id ? 'selected' : ''}>
              <td><b>{s.code}</b> {s.name}{s.isDemo && <> <span className="badge info">demo</span></>}<div className="muted small">{s.cuisineTags}</div></td>
              <td><span className={'badge ' + tone(s.status)}>{cap(s.status)}</span>{!s.acceptingOrders && <> <span className="badge warn">paused</span></>}</td>
              <td className="small">{s.walkinEnabled ? 'Walk-in' : <s>Walk-in</s>} · {s.preorderEnabled ? 'Pre-order' : <s>Pre-order</s>}</td>
              <td className="num">{clock12(s.openTime)} – {clock12(s.closeTime)}</td>
              <td className="small">{s.slotCapacity}/slot · ~{s.avgPrepMinutes} min × {s.kitchenParallel}</td>
              <td className="small">{s.vendorName ?? <span className="muted">Not linked</span>}</td>
              <td><div className="row wrap" style={{ justifyContent: 'flex-end' }}>
                <button className="small" onClick={() => { setEditing(null); setQr(qr === s.id ? null : s.id); }}>QR code</button>
                <button className="small" onClick={() => { setSaved(''); setQr(null); setEditing(editing === s.id ? null : s.id); }} aria-expanded={editing === s.id}>{editing === s.id ? 'Close' : 'Edit'}</button>
                {s.status !== 'ACTIVE' && <button className="small ok" onClick={() => patch(s.id, { status: 'ACTIVE' })}>Activate</button>}
                {s.status === 'ACTIVE' && <button className="small danger" onClick={() => patch(s.id, { status: 'SUSPENDED' })}>Suspend</button>}
              </div></td>
            </tr>
          ))}
        </tbody></table></div>
      </Section>
      {qr && <QrPanel key={qr} shopId={qr} onClose={() => setQr(null)} />}
      {editShop && <EditShop key={editShop.id} shop={editShop} vendors={vendors.data?.vendors ?? []} onClose={() => setEditing(null)} onSaved={(name) => { setEditing(null); setSaved(`Saved changes to ${name}.`); reload(); }} />}
      <Section title="Onboard a shop">
        <ShopFields f={form} set={setForm} editing={false} vendors={vendors.data?.vendors ?? []} />
        <div className="row wrap form-actions"><button className="primary" disabled={!form.name.trim() || !form.code.trim()} onClick={create}>Create shop</button><span className="muted small">New shops start as a draft with their own QR code, hidden from students until you activate them.</span></div>
      </Section>
    </>
  );
}

// ---------- menus ----------
function Menus() {
  const shops = useLoad<{ shops: any[] }>('/admin/shops');
  const [shopId, setShopId] = useState('');
  useEffect(() => { if (!shopId && shops.data?.shops[0]) setShopId(shops.data.shops[0].id); }, [shops.data, shopId]);
  const menu = useLoad<any>(shopId ? `/admin/shops/${shopId}/menu` : '/admin/shops', [shopId]);
  const [cat, setCat] = useState('');
  const [item, setItem] = useState({ name: '', price: '', categoryId: '', diet: '' });
  const [openItem, setOpenItem] = useState<string | null>(null);
  const [mod, setMod] = useState({ groupName: '', name: '', price: '0', selection: 'MANY', required: false });
  const [msg, setMsg] = useState('');
  const run = async (fn: () => Promise<unknown>) => { setMsg(''); try { await fn(); menu.reload(); } catch (e) { setMsg(errMsg(e)); } };
  const isMenu = shopId && menu.data?.items;
  return (
    <Section title="Menus" right={<select value={shopId} onChange={(e) => setShopId(e.target.value)} aria-label="Shop">{shops.data?.shops.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select>}>
      <Err msg={msg || menu.err} />
      {isMenu && <div className="table-wrap"><table><thead><tr><th>Item</th><th>Diet</th><th>Price (₹)</th><th>Options</th><th>Available</th></tr></thead><tbody>
        {menu.data.items.map((i: any) => (
          <React.Fragment key={i.id}>
            <tr className={openItem === i.id ? 'selected' : ''}>
              <td>{i.name}</td>
              <td><select value={i.diet ?? ''} onChange={(e) => run(() => api.patch(`/admin/menu-items/${i.id}`, { diet: e.target.value || null }))} aria-label={`Diet for ${i.name}`}><option value="">Not stated</option><option value="VEG">Veg</option><option value="EGG">Egg</option><option value="NON_VEG">Non-veg</option></select></td>
              <td><input style={{ width: 100, minHeight: 36 }} defaultValue={(i.basePricePaise / 100).toFixed(2)} inputMode="decimal" aria-label={`Price for ${i.name}`} onBlur={(e) => { const p = rupeesToPaise(e.target.value); if (Number.isFinite(p) && p !== i.basePricePaise) void run(() => api.patch(`/admin/menu-items/${i.id}`, { basePricePaise: p })); }} /></td>
              <td><button className="small" onClick={() => setOpenItem(openItem === i.id ? null : i.id)}>{i.modifiers.length} option{i.modifiers.length === 1 ? '' : 's'}</button></td>
              <td><button className={'small ' + (i.available ? 'ok' : 'danger')} onClick={() => run(() => api.patch(`/admin/menu-items/${i.id}`, { available: !i.available }))}>{i.available ? 'Available' : 'Sold out'}</button></td>
            </tr>
            {openItem === i.id && (
              <tr><td colSpan={5} className="sub-row">
                {i.modifiers.length > 0 && <ul className="mods">{i.modifiers.map((m: any) => <li key={m.id}><b>{m.group}</b>: {m.name} {m.pricePaise ? `+${formatPaise(m.pricePaise)}` : ''} <span className="muted small">{m.selection === 'ONE' ? 'choose one' : 'any'}{m.required ? ', required' : ''}</span> <button className={'small ' + (m.available ? 'ok' : 'danger')} onClick={() => run(() => api.patch(`/admin/modifiers/${m.id}`, { available: !m.available }))}>{m.available ? 'On' : 'Off'}</button></li>)}</ul>}
                <div className="row wrap">
                  <input style={{ maxWidth: 160 }} placeholder="Group (e.g. Add-ons)" value={mod.groupName} onChange={(e) => setMod({ ...mod, groupName: e.target.value })} aria-label="Option group" />
                  <input style={{ maxWidth: 160 }} placeholder="Option name" value={mod.name} onChange={(e) => setMod({ ...mod, name: e.target.value })} aria-label="Option name" />
                  <input style={{ maxWidth: 90 }} placeholder="₹ extra" inputMode="decimal" value={mod.price} onChange={(e) => setMod({ ...mod, price: e.target.value })} aria-label="Extra price" />
                  <select style={{ maxWidth: 130 }} value={mod.selection} onChange={(e) => setMod({ ...mod, selection: e.target.value })} aria-label="Selection"><option value="MANY">Any number</option><option value="ONE">Choose one</option></select>
                  <label className="check"><input type="checkbox" checked={mod.required} onChange={(e) => setMod({ ...mod, required: e.target.checked })} /> Required</label>
                  <button className="primary" disabled={!mod.groupName || !mod.name} onClick={() => run(async () => { await api.post(`/admin/menu-items/${i.id}/modifiers`, { groupName: mod.groupName, name: mod.name, pricePaise: rupeesToPaise(mod.price || '0'), selection: mod.selection, required: mod.required }); setMod({ ...mod, name: '', price: '0' }); })}>Add option</button>
                </div>
              </td></tr>
            )}
          </React.Fragment>
        ))}</tbody></table></div>}
      <p className="muted small">Price and option edits apply to new orders only; existing orders keep their snapshot.</p>
      <div className="row wrap"><input style={{ maxWidth: 220 }} placeholder="New category" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="New category" /><button disabled={!cat || !shopId} onClick={() => run(async () => { await api.post(`/admin/shops/${shopId}/categories`, { name: cat }); setCat(''); })}>Add category</button></div>
      <div className="row wrap"><input style={{ maxWidth: 220 }} placeholder="Item name" value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} aria-label="Item name" /><input style={{ maxWidth: 110 }} placeholder="₹ price" inputMode="decimal" value={item.price} onChange={(e) => setItem({ ...item, price: e.target.value })} aria-label="Item price" />
        <select style={{ maxWidth: 180 }} value={item.categoryId} onChange={(e) => setItem({ ...item, categoryId: e.target.value })} aria-label="Category"><option value="">No category</option>{menu.data?.categories?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select style={{ maxWidth: 140 }} value={item.diet} onChange={(e) => setItem({ ...item, diet: e.target.value })} aria-label="Diet"><option value="">Diet not stated</option><option value="VEG">Veg</option><option value="EGG">Egg</option><option value="NON_VEG">Non-veg</option></select>
        <button className="primary" disabled={!item.name || !item.price || !shopId} onClick={() => run(async () => { await api.post(`/admin/shops/${shopId}/menu-items`, { name: item.name, basePricePaise: rupeesToPaise(item.price), categoryId: item.categoryId || null, diet: item.diet || null }); setItem({ name: '', price: '', categoryId: '', diet: '' }); })}>Add item</button></div>
    </Section>
  );
}

// ---------- vendors ----------
function Vendors() {
  const v = useLoad<{ vendors: any[] }>('/admin/vendors');
  const users = useLoad<{ users: any[] }>('/admin/vendor-users');
  const shops = useLoad<{ shops: any[] }>('/admin/shops');
  const [b, setB] = useState({ legalName: '', contactName: '', contactPhone: '' });
  const [f, setF] = useState({ name: '', email: '', password: '', shopId: '' });
  const [msg, setMsg] = useState('');
  return (
    <>
      <Section title="Vendors (businesses that are paid)"><Err msg={v.err || msg} />
        <div className="table-wrap"><table><thead><tr><th>Business</th><th>Contact</th><th>Shops</th><th>Payout set-up</th></tr></thead><tbody>
          {v.data?.vendors.map((x) => <tr key={x.id}><td><b>{x.legalName}</b></td><td className="small">{x.contactName}{x.contactPhone ? ` · ${x.contactPhone}` : ''}</td><td className="small">{x.shops.map((s: any) => s.code).join(', ') || '—'}</td>
            <td><select value={x.payoutStatus} onChange={async (e) => { try { await api.patch(`/admin/vendors/${x.id}`, { payoutStatus: e.target.value }); v.reload(); } catch (er) { setMsg(errMsg(er)); } }} aria-label={`Payout status for ${x.legalName}`}>{['NOT_STARTED', 'PENDING_KYC', 'ACTIVE', 'SUSPENDED'].map((s) => <option key={s} value={s}>{cap(s)}</option>)}</select></td></tr>)}
        </tbody></table></div>
        <div className="row wrap"><input style={{ maxWidth: 240 }} placeholder="Legal business name" value={b.legalName} onChange={(e) => setB({ ...b, legalName: e.target.value })} aria-label="Legal business name" /><input style={{ maxWidth: 180 }} placeholder="Contact name" value={b.contactName} onChange={(e) => setB({ ...b, contactName: e.target.value })} aria-label="Contact name" /><input style={{ maxWidth: 160 }} placeholder="Phone" value={b.contactPhone} onChange={(e) => setB({ ...b, contactPhone: e.target.value })} aria-label="Contact phone" />
          <button className="primary" disabled={!b.legalName} onClick={async () => { setMsg(''); try { await api.post('/admin/vendors', { ...b, contactPhone: b.contactPhone || null }); setB({ legalName: '', contactName: '', contactPhone: '' }); v.reload(); } catch (e) { setMsg(errMsg(e)); } }}>Add vendor</button></div>
        <p className="muted small">Payout onboarding (KYC, bank account) happens with the payment provider once it is approved. Link each shop to its vendor under Shops → Edit.</p>
      </Section>
      <Section title="Shop logins (tablet users)"><Err msg={users.err} />
        <div className="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Shop</th><th>Role</th></tr></thead><tbody>{users.data?.users.map((x) => <tr key={x.id + x.shopId}><td>{x.name}</td><td>{x.email}</td><td>{x.shopName}</td><td>{cap(x.memberRole)}</td></tr>)}</tbody></table></div>
        <div className="grid2">
          <div className="field"><label htmlFor="vn">Name</label><input id="vn" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
          <div className="field"><label htmlFor="ve">Email</label><input id="ve" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></div>
          <div className="field"><label htmlFor="vp">Initial password (min 8)</label><input id="vp" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          <div className="field"><label htmlFor="vs">Shop</label><select id="vs" value={f.shopId} onChange={(e) => setF({ ...f, shopId: e.target.value })}><option value="">Choose…</option>{shops.data?.shops.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select></div>
        </div>
        <button className="primary" disabled={!f.name || !f.email || f.password.length < 8 || !f.shopId} onClick={async () => { setMsg(''); try { await api.post('/admin/vendor-users', f); setF({ name: '', email: '', password: '', shopId: '' }); users.reload(); } catch (e) { setMsg(errMsg(e)); } }}>Create login</button>
        <p className="muted small">A shop login can only see and act on its own shop’s orders, menu, printers and reports.</p>
      </Section>
    </>
  );
}

// ---------- tablets ----------
function Devices() {
  const d = useLoad<{ devices: any[] }>('/admin/devices');
  const shops = useLoad<{ shops: any[] }>('/admin/shops');
  const [tag, setTag] = useState('');
  const [model, setModel] = useState('');
  const [msg, setMsg] = useState('');
  useEffect(() => { const t = setInterval(d.reload, 15000); return () => clearInterval(t); }, [d.reload]);
  const assign = async (deviceId: string, shopId: string | null) => { setMsg(''); try { await api.post('/admin/devices/assign', { deviceId, shopId }); d.reload(); } catch (e) { setMsg(errMsg(e)); } };
  return (
    <>
      <Section title="Tablets (QuickPick property, loaned to shops)"><Err msg={msg || d.err} />
        <div className="table-wrap"><table><thead><tr><th>Asset tag</th><th>Device</th><th>Shop</th><th>Status</th><th>Last seen</th></tr></thead><tbody>
          {d.data?.devices.map((x) => (
            <tr key={x.id}>
              <td>{x.assetTag ? <b>{x.assetTag}</b> : <span className="muted small">untagged</span>}</td>
              <td className="small">{x.platform}{x.appVersion ? ` ${x.appVersion}` : ''}<div className="mono">{x.installId ?? x.model}</div></td>
              <td><select value={x.shopId ?? ''} onChange={(e) => assign(x.id, e.target.value || null)} aria-label={`Assign ${x.assetTag ?? x.installId}`}><option value="">Unassigned</option>{shops.data?.shops.map((s) => <option key={s.id} value={s.id}>{s.code} {s.name}</option>)}</select></td>
              <td><span className={'badge ' + tone(x.status)}>{cap(x.status)}</span></td>
              <td>{x.lastSeenAt ? <><span className={'badge ' + (x.online ? 'ok' : 'bad')}>{x.online ? 'online' : 'offline'}</span> <span className="small muted">{dt(x.lastSeenAt)}</span></> : <span className="muted">never</span>}</td>
            </tr>
          ))}</tbody></table></div>
        <p className="muted small">Tablets register themselves when a shop signs in. Give each one its asset tag when you hand it over.</p>
      </Section>
      <Section title="Register a tablet before handover"><div className="row wrap"><input style={{ maxWidth: 180 }} placeholder="Asset tag e.g. JQ-TAB-003" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Asset tag" /><input style={{ maxWidth: 240 }} placeholder="Model" value={model} onChange={(e) => setModel(e.target.value)} aria-label="Model" />
        <button className="primary" disabled={!tag} onClick={async () => { try { await api.post('/admin/devices', { assetTag: tag, model }); setTag(''); setModel(''); d.reload(); } catch (e) { setMsg(errMsg(e)); } }}>Register</button></div></Section>
    </>
  );
}

function Printers() {
  const p = useLoad<{ printers: any[] }>('/admin/printers');
  useEffect(() => { const t = setInterval(p.reload, 15000); return () => clearInterval(t); }, [p.reload]);
  return (
    <Section title="Printer health" right={<button onClick={p.reload}>Refresh</button>}><Err msg={p.err} />
      <div className="table-wrap"><table><thead><tr><th>Shop</th><th>Printer</th><th>Connection</th><th>Status</th><th>Last report</th><th>Printed today</th><th>Waiting</th><th>Failed</th></tr></thead><tbody>
        {p.data?.printers.map((x) => (
          <tr key={x.id}>
            <td><b>{x.shopCode}</b> {x.shopName}</td><td>{x.name}<div className="muted small">{x.model} · {x.paperWidthMm} mm</div></td>
            <td className="small">{cap(x.connection)}{x.address ? <div className="mono">{x.address}</div> : null}</td>
            <td><span className={'badge ' + tone(x.status)}>{cap(x.status)}</span>{x.stale && x.status !== 'UNKNOWN' && <> <span className="badge warn">stale</span></>}{x.lastError && <div className="small bad-text">{x.lastError}</div>}</td>
            <td className="small">{dt(x.lastStatusAt)}</td><td className="num">{x.printedToday}</td><td className="num">{x.waiting}</td><td className="num">{x.failed > 0 ? <span className="badge bad">{x.failed}</span> : 0}</td>
          </tr>
        ))}
        {p.data?.printers.length === 0 && <tr><td colSpan={8} className="muted">No printers set up yet. Shops add them from the tablet’s Printer tab.</td></tr>}
      </tbody></table></div>
      <p className="muted small">Status comes from the tablet: every print attempt and every “Test print” reports what the printer did. Paper-out shows only on printers that report it.</p>
    </Section>
  );
}

// ---------- money ----------
function Payments() {
  const pay = useLoad<{ payments: any[] }>('/admin/payments');
  const ref = useLoad<{ refunds: any[] }>('/admin/refunds');
  const [msg, setMsg] = useState('');
  return (
    <>
      <Section title="Payments (sandbox provider)"><Err msg={pay.err} />
        <div className="table-wrap"><table><thead><tr><th>Order</th><th>Mode</th><th>Shop</th><th>Amount</th><th>Refunded</th><th>Attempts</th><th>Status</th><th>When</th></tr></thead><tbody>
          {pay.data?.payments.map((p) => <tr key={p.id}><td><b>{p.orderNumber}</b></td><td><Mode s={p.orderSource} /></td><td>{p.shopName}</td><td className="price">{formatPaise(p.amountPaise)}</td><td className="price">{formatPaise(p.refundedPaise)}</td><td className="num">{p.attempts}</td><td><span className={'badge ' + tone(p.status)}>{pstatus(p.status)}</span></td><td className="small">{dt(p.createdAt)}</td></tr>)}
        </tbody></table></div></Section>
      <Section title="Refunds"><Err msg={ref.err || msg} />
        <div className="table-wrap"><table><thead><tr><th>Order</th><th>Shop</th><th>Amount</th><th>Reason</th><th>Status</th><th>When</th><th /></tr></thead><tbody>
          {ref.data?.refunds.map((r) => <tr key={r.id}><td><b>{r.orderNumber}</b></td><td>{r.shopName}</td><td className="price">{formatPaise(r.amountPaise)}</td><td className="small">{r.reason}{r.failureReason ? <div className="bad-text">{r.failureReason}</div> : null}</td><td><span className={'badge ' + tone(r.status)}>{cap(r.status)}</span></td><td className="small">{dt(r.createdAt)}</td>
            <td>{r.status === 'FAILED' && <button className="small primary" onClick={async () => { setMsg(''); try { await api.post(`/admin/refunds/${r.id}/retry`); ref.reload(); pay.reload(); } catch (e) { setMsg(errMsg(e)); } }}>Retry refund</button>}</td></tr>)}
          {ref.data?.refunds.length === 0 && <tr><td colSpan={7} className="muted">No refunds.</td></tr>}
        </tbody></table></div></Section>
    </>
  );
}

function Reconciliation() {
  const rec = useLoad<{ rows: any[]; records: any[] }>('/admin/reconciliation');
  const [msg, setMsg] = useState('');
  return (
    <>
      <Section title="Provider reconciliation" right={<button onClick={async () => { try { const r = await api.post<{ fixed: number }>('/admin/reconciliation/run'); setMsg(r.fixed ? `Applied ${r.fixed} correction${r.fixed === 1 ? '' : 's'} from the provider.` : 'Everything matches the provider.'); rec.reload(); } catch (e) { setMsg(errMsg(e)); } }}>Check with provider now</button>}>
        {msg && <div className="success">{msg}</div>}<Err msg={rec.err} />
        <p className="muted small">Runs automatically every 30 seconds. Lost webhooks and closed browsers are corrected here; refund failures stay open until a person deals with them.</p>
        <div className="table-wrap"><table><thead><tr><th>When</th><th>Kind</th><th>Order</th><th>Ours → provider</th><th>Amount</th><th>Action</th><th>Status</th></tr></thead><tbody>
          {rec.data?.records.map((r) => <tr key={r.id}><td className="small">{dt(r.at)}</td><td>{cap(r.kind)}</td><td>{r.orderNumber}</td><td className="small">{cap(r.expectedStatus ?? '')} → {cap(r.providerStatus ?? '')}</td><td className="price">{r.amountPaise !== null ? formatPaise(r.amountPaise) : '—'}</td><td className="small">{cap(r.action)}</td><td><span className={'badge ' + tone(r.status)}>{cap(r.status)}</span></td></tr>)}
          {rec.data?.records.length === 0 && <tr><td colSpan={7} className="muted">No differences found yet.</td></tr>}
        </tbody></table></div>
      </Section>
      <Section title="Ledger check (paid vs planned split)">
        <div className="table-wrap"><table><thead><tr><th>Order</th><th>Paid</th><th>Planned split</th><th>Refunded</th><th>Status</th><th>Check</th></tr></thead><tbody>
          {rec.data?.rows.map((r) => <tr key={r.orderNumber}><td>{r.orderNumber}</td><td className="price">{formatPaise(r.paidPaise)}</td><td className="price">{formatPaise(r.plannedSplitPaise)}</td><td className="price">{formatPaise(r.refundedPaise)}</td><td>{pstatus(r.paymentStatus)}</td><td>{r.matches ? <span className="badge ok">matches</span> : <span className="badge bad">diff {formatPaise(r.differencePaise)}</span>}</td></tr>)}
        </tbody></table></div>
      </Section>
    </>
  );
}

function Settlements() {
  const s = useLoad<{ settlements: any[]; note: string }>('/admin/settlements');
  const [date, setDate] = useState(todayIst());
  const [msg, setMsg] = useState('');
  return (
    <Section title="Vendor settlement statements" right={<div className="row"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Day" style={{ width: 160 }} /><button className="primary" onClick={async () => { setMsg(''); try { const r = await api.post<{ settlements: any[] }>('/admin/settlements/generate', { date }); setMsg(`${r.settlements.length} statement${r.settlements.length === 1 ? '' : 's'} created or updated.`); s.reload(); } catch (e) { setMsg(errMsg(e)); } }}>Build statements for day</button></div>}>
      {msg && <div className="success">{msg}</div>}<Err msg={s.err} />
      <div className="table-wrap"><table><thead><tr><th>Day</th><th>Shop</th><th>Orders</th><th>Vendor entitlement</th><th>Status</th></tr></thead><tbody>
        {s.data?.settlements.map((x) => <tr key={x.id}><td>{String(x.periodStart).slice(0, 10)}</td><td>{x.shopName}</td><td className="num">{x.orders}</td><td className="price">{formatPaise(x.netPaise)}</td><td><span className="badge warn">{cap(x.status)}</span></td></tr>)}
        {s.data?.settlements.length === 0 && <tr><td colSpan={5} className="muted">No statements yet.</td></tr>}
      </tbody></table></div>
      <p className="muted small">{s.data?.note} Statements include collected orders only; each vendor receives the full menu price of its orders.</p>
    </Section>
  );
}

function Pricing({ superAdmin }: { superAdmin: boolean }) {
  const p = useLoad<{ policies: any[] }>('/admin/pricing-policies');
  const [f, setF] = useState({ orderSource: 'WALKIN_QR', feePct: '7', taxMode: 'NONE', taxPct: '0', approved: false, note: '' });
  const [msg, setMsg] = useState('');
  const save = async () => {
    setMsg('');
    try { await api.patch('/admin/pricing-policy', { orderSource: f.orderSource, feeRateBps: Math.round(parseFloat(f.feePct) * 100), taxMode: f.taxMode, taxRateBps: Math.round(parseFloat(f.taxPct) * 100), approved: f.approved, note: f.note }); p.reload(); setMsg('Published.'); } catch (e) { setMsg(errMsg(e)); }
  };
  return (
    <>
      {(['PREORDER', 'WALKIN_QR'] as const).map((src) => {
        const rows = p.data?.policies.filter((x) => x.orderSource === src) ?? [];
        return (
          <Section key={src} title={`${ORDER_SOURCE_LABEL[src]} fee versions`}><Err msg={p.err} />
            <div className="table-wrap"><table><thead><tr><th>Version</th><th>Fee</th><th>Tax on fee</th><th>Approved (CA)</th><th>Effective from</th><th>Note</th></tr></thead><tbody>
              {rows.map((x, i) => <tr key={x.id}><td><b>v{x.version}</b>{i === 0 && <> <span className="badge ok">current</span></>}</td><td>{x.feeRateBps / 100}%</td><td>{x.taxMode === 'NONE' ? 'None' : `${cap(x.taxMode)} ${x.taxRateBps / 100}%`}</td><td>{x.approved ? <span className="badge ok">approved</span> : <span className="badge warn">NOT approved</span>}</td><td className="small">{dt(x.effectiveFrom)}</td><td className="small">{x.note}</td></tr>)}
            </tbody></table></div>
          </Section>
        );
      })}
      <Section title="Publish a new fee version">
        {!superAdmin && <div className="notice">Only the platform owner (super-admin) can change pricing.</div>}
        <div className="grid2">
          <div className="field"><label htmlFor="ps">Ordering mode</label><select id="ps" value={f.orderSource} onChange={(e) => setF({ ...f, orderSource: e.target.value })}><option value="WALKIN_QR">Walk-in QR</option><option value="PREORDER">Pre-order</option></select></div>
          <div className="field"><label htmlFor="pf">Convenience fee (% of food subtotal)</label><input id="pf" inputMode="decimal" value={f.feePct} onChange={(e) => setF({ ...f, feePct: e.target.value })} /></div>
          <div className="field"><label htmlFor="pm">Tax treatment of the fee</label><select id="pm" value={f.taxMode} onChange={(e) => setF({ ...f, taxMode: e.target.value })}><option value="NONE">None</option><option value="EXCLUSIVE">Added on top</option><option value="INCLUSIVE">Included in fee</option></select></div>
          <div className="field"><label htmlFor="pt">Tax rate (%)</label><input id="pt" inputMode="decimal" value={f.taxPct} onChange={(e) => setF({ ...f, taxPct: e.target.value })} disabled={f.taxMode === 'NONE'} /></div>
          <div className="field"><label htmlFor="pn">Note</label><input id="pn" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></div>
        </div>
        <label className="check"><input type="checkbox" checked={f.approved} onChange={(e) => setF({ ...f, approved: e.target.checked })} /> Tick only after the CA’s written opinion approves this treatment</label>
        {msg && <div className={msg === 'Published.' ? 'success' : 'error'}>{msg}</div>}
        <button className="primary" disabled={!superAdmin} onClick={save}>Publish new version</button>
        <p className="muted small">Each order stores the policy it was priced under, so a change never alters past orders.</p>
      </Section>
    </>
  );
}

// ---------- support + audit ----------
function Support() {
  const c = useLoad<{ complaints: any[] }>('/admin/complaints');
  const [msg, setMsg] = useState('');
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const set = async (id: string, status: string, resolution?: string) => { try { await api.patch(`/admin/complaints/${id}`, { status, resolution }); setResolving(null); setNote(''); c.reload(); } catch (e) { setMsg(errMsg(e)); } };
  return (
    <Section title="Support requests"><Err msg={c.err || msg} />
      <div className="table-wrap"><table><thead><tr><th>Order</th><th>Shop</th><th>Category</th><th>Description</th><th>Status</th><th>Resolution</th><th /></tr></thead><tbody>
        {c.data?.complaints.map((x) => (
          <tr key={x.id}><td>{x.orderNumber}</td><td>{x.shopName}</td><td>{x.category}</td><td>{x.description}</td><td><span className={'badge ' + tone(x.status)}>{cap(x.status)}</span></td><td>{x.resolution}</td>
            <td>{resolving === x.id ? <div className="row"><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Resolution note" aria-label="Resolution note" /><button className="small ok" onClick={() => set(x.id, 'RESOLVED', note)}>Save</button></div> : <div className="row wrap">{x.status === 'OPEN' && <button className="small" onClick={() => set(x.id, 'IN_PROGRESS')}>Start</button>}{x.status !== 'RESOLVED' && <button className="small ok" onClick={() => setResolving(x.id)}>Resolve</button>}</div>}</td></tr>
        ))}
        {c.data?.complaints.length === 0 && <tr><td colSpan={7} className="muted">No support requests.</td></tr>}
      </tbody></table></div>
    </Section>
  );
}

function Audit() {
  const a = useLoad<{ logs: any[] }>('/admin/audit-logs');
  const o = useLoad<{ overrides: any[] }>('/admin/pickup-overrides');
  return (
    <>
      <Section title="Handovers without a collection code"><Err msg={o.err} />
        <div className="table-wrap"><table><thead><tr><th>When</th><th>Order</th><th>Shop</th><th>By</th><th>Reason</th></tr></thead><tbody>
          {o.data?.overrides.map((x, i) => <tr key={i}><td className="small">{dt(x.at)}</td><td>{x.orderNumber}</td><td>{x.shopName}</td><td className="small">{x.by} ({cap(x.role ?? '')})</td><td>{x.reason}</td></tr>)}
          {o.data?.overrides.length === 0 && <tr><td colSpan={5} className="muted">None.</td></tr>}
        </tbody></table></div>
      </Section>
      <Section title="Audit log (sensitive and financial actions)"><Err msg={a.err} />
        <div className="table-wrap"><table><thead><tr><th>When</th><th>Role</th><th>Action</th><th>Entity</th><th>Details</th></tr></thead><tbody>
          {a.data?.logs.map((l) => <tr key={l.id}><td className="small">{dt(l.created_at)}</td><td>{l.actor_role}</td><td><b>{l.action}</b></td><td>{l.entity_type} <span className="mono">{l.entity_id?.slice(0, 8)}</span></td><td className="mono">{JSON.stringify(l.metadata)}</td></tr>)}
        </tbody></table></div>
      </Section>
    </>
  );
}
