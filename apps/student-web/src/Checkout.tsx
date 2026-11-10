import { formatPaise, type OrderView, type PriceBreakdown } from '@qp2/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, cartItemsPayload, errMsg, fmtTime, navigate, type Cart, type Slot } from './lib';
import { SignIn } from './SignIn';
import { Alert, Back, Icon, ModeBadge } from './ui';

interface Quote { shopName: string; slot: { id: string; startsAt: string } | null; estimate: { minutes: number; queueLength: number } | null; breakdown: PriceBreakdown; policyApproved: boolean }

/** Send the browser to the hosted (sandbox) payment page. The return to the app is never treated as proof of payment. */
export async function startPayment(orderId: string) {
  const r = await api.post<{ checkoutUrl: string }>('/payments/checkout', { orderId, returnUrl: `${location.origin}/orders/${orderId}?from=checkout` });
  window.location.assign(r.checkoutUrl);
}

export function Checkout({ cart, setCart, authed }: { cart: Cart | null; setCart: (c: Cart | null) => void; authed: boolean }) {
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slotId, setSlotId] = useState('');
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [needSignIn, setNeedSignIn] = useState(false);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const idemKey = useRef(crypto.randomUUID());
  const items = useMemo(() => (cart ? cartItemsPayload(cart) : []), [cart]);
  const preorder = cart?.mode === 'PREORDER';

  useEffect(() => {
    if (!cart || !preorder) return;
    api.get<{ slots: Slot[] }>(`/shops/${cart.shopId}/pickup-slots`).then((r) => setSlots(r.slots)).catch((e) => setErr(errMsg(e)));
  }, [cart?.shopId, preorder]);

  useEffect(() => {
    if (!cart || !authed || items.length === 0 || (preorder && !slotId)) return setQuote(null);
    setErr('');
    api
      .post<Quote>('/orders/quote', { source: cart.mode, shopId: cart.shopId, slotId: preorder ? slotId : undefined, items })
      .then(setQuote)
      .catch((e) => {
        setQuote(null);
        setErr(errMsg(e));
      });
  }, [slotId, cart, items, authed, preorder]);

  if (!cart || items.length === 0) {
    return <div className="empty"><h2>Your cart is empty</h2><p>Add something from a shop to start an order.</p><a className="btn primary" href="/">Go home</a></div>;
  }
  const menuHref = cart.mode === 'WALKIN_QR' && cart.qrToken ? `/s/${cart.qrToken}` : `/shop/${cart.shopId}`;

  const setQty = (key: string, qty: number) => {
    const lines = cart.lines.map((l) => (l.key === key ? { ...l, qty } : l)).filter((l) => l.qty > 0);
    setCart(lines.length ? { ...cart, lines } : null);
  };
  const setNote = (key: string, notes: string) => setCart({ ...cart, lines: cart.lines.map((l) => (l.key === key ? { ...l, notes: notes.slice(0, 140) } : l)) });

  const pay = async () => {
    if (!authed) return setNeedSignIn(true);
    setBusy(true);
    setErr('');
    try {
      const created = await api.post<{ order: OrderView }>('/orders', { source: cart.mode, shopId: cart.shopId, slotId: preorder ? slotId : undefined, items }, { 'Idempotency-Key': idemKey.current });
      setCart(null); // the order now holds the cart; payment retries reuse it
      await startPayment(created.order.id);
    } catch (e) {
      setErr(errMsg(e));
      idemKey.current = crypto.randomUUID();
      setBusy(false);
    }
  };

  const chosen = slots?.find((s) => s.id === slotId);
  const label = !authed ? 'Sign in to pay' : preorder && !slotId ? 'Choose a pickup time' : quote ? `Pay ${formatPaise(quote.breakdown.totalPaise)}` : 'Checking prices…';

  return (
    <>
      <Back href={menuHref}>{cart.shopName}</Back>
      <div className="page-head">
        <ModeBadge mode={cart.mode} />
        <h1 style={{ marginTop: 8 }}>Review your order</h1>
        {cart.mode === 'WALKIN_QR' && <p>You’re ordering at {cart.shopName}’s counter. Pay here and we’ll tell you when it’s ready.</p>}
      </div>

      <section className="section" style={{ marginTop: 0 }}>
        <div className="section-head"><h2>{cart.shopName}</h2><a className="small" style={{ fontWeight: 600 }} href={menuHref}>Add items</a></div>
        <ul className="lines editable">
          {cart.lines.map((l) => (
            <li key={l.key}>
              <div className="grow">
                <div className="line-top"><span>{l.name}</span><span className="amt">{formatPaise(l.unitPricePaise * l.qty)}</span></div>
                {l.modifierNames.length > 0 && <div className="sub small">{l.modifierNames.join(' · ')}</div>}
                {editingNote === l.key ? (
                  <input className="note-input" autoFocus maxLength={140} value={l.notes} onChange={(e) => setNote(l.key, e.target.value)} onBlur={() => setEditingNote(null)} placeholder="Cooking note for the kitchen" aria-label={`Note for ${l.name}`} />
                ) : (
                  <button className="linkbtn small" onClick={() => setEditingNote(l.key)}>{l.notes ? `Note: ${l.notes}` : 'Add a cooking note'}</button>
                )}
              </div>
              <div className="stepper sm" role="group" aria-label={`${l.name} quantity`}>
                <button aria-label={`Remove one ${l.name}`} onClick={() => setQty(l.key, l.qty - 1)}>−</button>
                <span>{l.qty}</span>
                <button aria-label={`Add one ${l.name}`} onClick={() => setQty(l.key, Math.min(20, l.qty + 1))}>+</button>
              </div>
            </li>
          ))}
        </ul>
      </section>

      {preorder ? (
        <section className="section">
          <div className="section-head"><h2>Pickup time</h2>{chosen && <span className="small sub">Ready from {fmtTime(chosen.startsAt)}</span>}</div>
          {!slots ? <p className="loading">Loading pickup times…</p> : slots.length === 0 ? (
            <Alert tone="info">No pickup times are left today. The shop may be closed or fully booked.</Alert>
          ) : (
            <div className="slots" role="group" aria-label="Pickup times">
              {slots.map((s) => (
                <button key={s.id} className={'slot' + (!s.full && s.remaining <= 2 ? ' low' : '')} aria-pressed={slotId === s.id} disabled={s.full} onClick={() => setSlotId(s.id)}>
                  <b>{fmtTime(s.startsAt)}</b><small>{s.full ? 'Full' : `${s.remaining} left`}</small>
                </button>
              ))}
            </div>
          )}
        </section>
      ) : (
        <section className="section">
          <div className="estimate">{Icon.clock}<div><b>{quote?.estimate ? `Ready in about ${quote.estimate.minutes} min` : 'Ready soon'}</b><span className="sub small">{quote?.estimate?.queueLength ? `${quote.estimate.queueLength} order${quote.estimate.queueLength === 1 ? '' : 's'} ahead in the kitchen. ` : ''}The shop confirms the time when it accepts.</span></div></div>
        </section>
      )}

      {quote && (
        <section className="section">
          <h2>Payment summary</h2>
          <Breakdown b={quote.breakdown} unapproved={!quote.policyApproved} />
        </section>
      )}

      {err && <div style={{ marginTop: 20 }}><Alert tone="error">{err}</Alert></div>}
      {needSignIn && !authed && <div className="card-inline"><SignIn compact title="Sign in to pay" onDone={() => setNeedSignIn(false)} /></div>}

      <div style={{ marginTop: 24 }}>
        <button className="btn quiet block" onClick={() => { setCart(null); navigate('/'); }}>Clear cart</button>
      </div>

      <div className="dock"><div className="dock-inner">
        <button className="btn primary" disabled={busy || (authed && (!quote || (preorder && !slotId)))} onClick={pay}>{busy ? 'Opening payment…' : label}</button>
      </div></div>
    </>
  );
}

export function Breakdown({ b, unapproved }: { b: PriceBreakdown; unapproved: boolean }) {
  return (
    <div className="summary">
      <div className="line"><span>Food</span><span>{formatPaise(b.subtotalPaise)}</span></div>
      <div className="line"><span>QuickPick convenience fee ({b.feeRateBps / 100}%)</span><span>{formatPaise(b.feePaise)}</span></div>
      {b.taxMode === 'EXCLUSIVE' && <div className="line"><span>Tax on fee ({b.taxRateBps / 100}%)</span><span>{formatPaise(b.taxPaise)}</span></div>}
      {b.taxMode === 'INCLUSIVE' && <div className="line minor"><span>Fee includes tax of</span><span>{formatPaise(b.taxPaise)}</span></div>}
      <div className="line total"><span>You pay</span><span>{formatPaise(b.totalPaise)}</span></div>
      <p className="note">The shop receives its full menu price. The fee pays for ordering from your phone; it isn’t charged at the counter.</p>
      {unapproved && <p className="note warn">Test pricing: the tax treatment of this fee hasn’t been approved yet.</p>}
    </div>
  );
}
