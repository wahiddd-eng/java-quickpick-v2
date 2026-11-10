import { ORDER_STATUS_LABEL, PAYMENT_STATUS_LABEL, formatPaise, type OrderStatus, type OrderView } from '@qp2/shared';
import { useCallback, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { startPayment } from './Checkout';
import { API_URL, api, errMsg, fmtDay, fmtTime } from './lib';
import { Alert, Back, Icon, ModeBadge } from './ui';

const FLOW: OrderStatus[] = ['AWAITING_VENDOR', 'ACCEPTED', 'PREPARING', 'READY', 'COLLECTED'];
const END_BAD: OrderStatus[] = ['REJECTED', 'CANCELLED', 'EXPIRED', 'NOT_COLLECTED'];
const STEP_LABEL: Record<string, string> = { AWAITING_VENDOR: 'Payment verified, sent to the shop', ACCEPTED: 'Accepted by the shop', PREPARING: 'Being prepared', READY: 'Ready for collection', COLLECTED: 'Collected' };
const HEADLINE: Partial<Record<OrderStatus, string>> = {
  AWAITING_VENDOR: 'Waiting for the shop to accept',
  ACCEPTED: 'The shop accepted your order',
  PREPARING: 'Your food is being prepared',
  READY: 'Ready — show your code',
  COLLECTED: 'Collected. Enjoy your meal',
  REJECTED: 'The shop couldn’t take this order',
  CANCELLED: 'Order cancelled',
  EXPIRED: 'This order expired',
  NOT_COLLECTED: 'Marked as not collected',
};
export const pillTone = (s: OrderStatus) => (s === 'READY' || s === 'COLLECTED' ? 'good' : END_BAD.includes(s) ? 'bad' : s === 'PENDING_PAYMENT' ? 'warn' : 'live');

type FullOrder = OrderView & { otpExpiresAt?: string };
type OrderData = { order: FullOrder; events: { status: OrderStatus; reason: string | null; at: string }[]; refunds: { amountPaise: number; status: string; at: string }[] };

/** REST is the source of truth: refetch on a timer, on every socket signal and on reconnect (covers a phone that went offline). */
function useOrderLive(orderId: string, onChange: () => void) {
  useEffect(() => {
    const t = setInterval(onChange, 5000);
    const token = api.getToken();
    const socket = token ? io(API_URL, { auth: { token }, transports: ['websocket', 'polling'] }) : null;
    socket?.on('order', (e: { orderId: string }) => e.orderId === orderId && onChange());
    socket?.on('connect', onChange);
    const vis = () => document.visibilityState === 'visible' && onChange();
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('online', onChange);
    return () => {
      clearInterval(t);
      socket?.close();
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('online', onChange);
    };
  }, [orderId, onChange]);
}

export function OrderPage({ orderId, fromCheckout }: { orderId: string; fromCheckout: boolean }) {
  const [data, setData] = useState<OrderData | null>(null);
  const [err, setErr] = useState('');
  const [help, setHelp] = useState(false);
  const [helpText, setHelpText] = useState('');
  const [sent, setSent] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [paying, setPaying] = useState(false);
  const load = useCallback(() => {
    api.get<OrderData>(`/orders/${orderId}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(errMsg(e)));
  }, [orderId]);
  useEffect(load, [load]);
  useOrderLive(orderId, load);

  if (err && !data) return <><Back href="/orders">Orders</Back><Alert tone="error">{err}</Alert></>;
  if (!data) return <p className="loading">Loading order…</p>;
  const { order, events } = data;
  const idx = FLOW.indexOf(order.status);
  const bad = END_BAD.includes(order.status);
  const unpaid = order.status === 'PENDING_PAYMENT';
  const cancellable = unpaid || order.status === 'AWAITING_VENDOR';
  const walkin = order.orderSource === 'WALKIN_QR';
  const reachedAt = (s: OrderStatus) => [...events].reverse().find((e) => e.status === s)?.at;
  const lastReason = events.at(-1)?.reason;
  const timeText = walkin ? (order.estimatedReadyAt ? `Ready by about ${fmtTime(order.estimatedReadyAt)}` : '') : order.slotStartsAt ? `Pickup ${fmtTime(order.slotStartsAt)} – ${fmtTime(order.slotEndsAt)}` : '';

  const retryPay = async () => {
    setPaying(true);
    try {
      await startPayment(order.id);
    } catch (e) {
      setErr(errMsg(e));
      setPaying(false);
    }
  };

  const sub =
    order.status === 'READY' ? `Go to ${order.shopName} and show this code at the counter.`
    : order.status === 'PREPARING' || order.status === 'ACCEPTED' ? `${timeText} at ${order.shopName}. We’ll notify you when it’s ready.`
    : order.status === 'AWAITING_VENDOR' ? `${order.shopName} usually accepts within a minute or two. If they can’t, you’re refunded in full.`
    : bad ? (lastReason ? `Reason: ${lastReason}` : 'Any payment for this order is refunded in full.') : '';

  return (
    <>
      <Back href="/orders">Orders</Back>

      {unpaid ? (
        <div className="status-head">
          <ModeBadge mode={order.orderSource} />
          {order.paymentStatus === 'FAILED' ? (
            <>
              <h1 style={{ marginTop: 10 }}>Payment didn’t go through</h1>
              <p>No money was taken. You can try again — this order is held until {fmtTime(order.expiresAt)}.</p>
            </>
          ) : (
            <>
              <h1 style={{ marginTop: 10 }}>{fromCheckout ? 'Confirming your payment…' : 'Waiting for payment'}</h1>
              <p>{fromCheckout ? 'This updates as soon as the payment provider confirms it with our server — usually a few seconds.' : 'Finish paying to send the order to the shop.'}</p>
            </>
          )}
          <div className="stack-actions">
            <button className="btn primary block" disabled={paying} onClick={retryPay}>{paying ? 'Opening payment…' : order.paymentStatus === 'FAILED' ? `Try again · ${formatPaise(order.totalPaise)}` : `Continue to payment · ${formatPaise(order.totalPaise)}`}</button>
          </div>
        </div>
      ) : (
        <div className="status-head">
          <div className="row-meta" style={{ alignItems: 'center' }}><span className={`pill ${pillTone(order.status)}`}>{ORDER_STATUS_LABEL[order.status]}</span><ModeBadge mode={order.orderSource} /></div>
          <h1 style={{ marginTop: 10 }}>{HEADLINE[order.status] ?? ORDER_STATUS_LABEL[order.status]}</h1>
          {sub && <p>{sub}</p>}
        </div>
      )}

      {order.status === 'READY' && order.pickupOtp && (
        <div className="ticket ready" aria-label="Collection code">
          <div className="ticket-top">
            <div className="label">Collection code — show it at the counter</div>
            <div className="ticket-code six" aria-label={`Collection code ${order.pickupOtp.split('').join(' ')}`}>{order.pickupOtp.slice(0, 3)}<span className="gap" />{order.pickupOtp.slice(3)}</div>
            <div className="hint">Only show this at {order.shopName}. Valid until {fmtTime(order.otpExpiresAt)}.</div>
          </div>
          <div className="ticket-bottom">
            <span className="k">Shop</span><span className="k">Order</span>
            <span className="v">{order.shopName}</span><span className="v">{order.orderNumber}</span>
          </div>
        </div>
      )}
      {order.status === 'READY' && !order.pickupOtp && (
        <div style={{ marginTop: 18 }}>
          <Alert tone="warn">{order.otpState === 'EXPIRED' ? 'Your collection code has expired. Go to the shop with your order number and they can hand it over after checking.' : order.otpState === 'LOCKED' ? 'Too many wrong codes were tried. Show your order number at the counter; the shop can hand it over after checking.' : 'Your code is loading…'}</Alert>
        </div>
      )}
      {(order.status === 'ACCEPTED' || order.status === 'PREPARING' || order.status === 'AWAITING_VENDOR') && (
        <div className="code-later">{Icon.clock}<div><b>{order.orderNumber}</b><span className="sub small">{order.status === 'AWAITING_VENDOR' ? 'Your collection code appears here when the order is ready.' : `${timeText}. Your collection code appears here when the order is ready.`}</span></div></div>
      )}

      {!bad && !unpaid && (
        <section className="section">
          <h2>Progress</h2>
          <ol className="steps" aria-label="Order progress">
            {FLOW.map((s, i) => {
              const done = i < idx || order.status === 'COLLECTED';
              const current = i === idx && order.status !== 'COLLECTED';
              const at = reachedAt(s);
              if (s === 'PREPARING' && !at && idx > i) return null; // shop went straight to ready
              return (
                <li key={s} className={done ? 'done' : current ? 'current' : ''} aria-current={current ? 'step' : undefined}>
                  <span className="dot">{done ? Icon.check : null}</span>
                  <span>{STEP_LABEL[s]}</span>
                  {at && (done || current) ? <time dateTime={at}>{fmtTime(at)}</time> : <span />}
                </li>
              );
            })}
          </ol>
          {order.status === 'COLLECTED' && order.collectedAt && <p className="sub small" style={{ marginTop: 10 }}>Collected {fmtDay(order.collectedAt)} at {fmtTime(order.collectedAt)}{order.collectedVia === 'MANUAL_OVERRIDE' ? ' (handed over by the shop without a code)' : ''}.</p>}
        </section>
      )}

      <section className="section">
        <div className="section-head"><h2>Receipt</h2><span className="small sub">{order.orderNumber}</span></div>
        <div className="summary">
          {order.items.map((i, k) => (
            <div key={i.menuItemId + k}>
              <div className="line"><span>{i.quantity}× {i.name}</span><span>{formatPaise(i.lineTotalPaise)}</span></div>
              {(i.modifiers.length > 0 || i.notes) && <div className="line minor indent"><span>{[...i.modifiers.map((m) => m.name), i.notes && `Note: ${i.notes}`].filter(Boolean).join(' · ')}</span><span /></div>}
            </div>
          ))}
          <div className="line minor"><span>QuickPick convenience fee ({order.feeRateBps / 100}%)</span><span>{formatPaise(order.feePaise)}</span></div>
          {order.taxPaise > 0 && <div className="line minor"><span>Tax</span><span>{formatPaise(order.taxPaise)}</span></div>}
          <div className="line total"><span>Total</span><span>{formatPaise(order.totalPaise)}</span></div>
          <div className="line minor" style={{ marginTop: 6 }}><span>Payment</span><span>{PAYMENT_STATUS_LABEL[order.paymentStatus]}</span></div>
          {data.refunds.map((r, i) => (
            <div className="line minor" key={i}><span>{r.status === 'PROCESSED' ? 'Refunded' : r.status === 'FAILED' ? 'Refund delayed — our team is on it' : 'Refund in progress'}</span><span>{formatPaise(r.amountPaise)}</span></div>
          ))}
        </div>
      </section>

      {err && <div style={{ marginTop: 16 }}><Alert tone="error">{err}</Alert></div>}

      <div className="order-actions">
        {cancellable && !confirmCancel && <button className="btn danger block" onClick={() => setConfirmCancel(true)}>Cancel order</button>}
        {cancellable && confirmCancel && (
          <div className="dialog" role="alertdialog" aria-labelledby="cancel-title" style={{ marginTop: 0 }}>
            <h2 id="cancel-title">Cancel this order?</h2>
            <p className="sub" style={{ marginTop: 6 }}>{order.paymentStatus === 'SUCCEEDED' ? `You’ll be refunded ${formatPaise(order.totalPaise)} in full.` : 'Nothing has been charged.'}</p>
            <div className="actions">
              <button className="btn" onClick={() => setConfirmCancel(false)}>Keep order</button>
              <button className="btn danger" onClick={async () => { try { await api.post(`/orders/${orderId}/cancel`); setConfirmCancel(false); load(); } catch (e) { setErr(errMsg(e)); } }}>Cancel order</button>
            </div>
          </div>
        )}
        {!unpaid && (sent ? <Alert tone="good">Report sent. The QuickPick team will look into it and contact you.</Alert> : !help ? (
          <button className="btn quiet block" onClick={() => setHelp(true)}>Report a problem with this order</button>
        ) : (
          <div className="dialog support" style={{ marginTop: 0 }}>
            <div className="field"><label htmlFor="help">What went wrong?</label><textarea id="help" rows={3} value={helpText} onChange={(e) => setHelpText(e.target.value)} placeholder="For example: an item was missing" /></div>
            <div className="actions">
              <button className="btn" onClick={() => setHelp(false)}>Close</button>
              <button className="btn primary" disabled={!helpText.trim()} onClick={async () => { try { await api.post(`/orders/${orderId}/support`, { category: 'Order issue', description: helpText }); setSent(true); } catch (e) { setErr(errMsg(e)); } }}>Send report</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
