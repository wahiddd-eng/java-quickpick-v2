import { formatPaise, type OrderSource } from '@qp2/shared';
import { useEffect, useMemo, useState } from 'react';
import { api, errMsg, fmtClock, lineKey, type Cart, type CartLine, type MenuItem, type Modifier, type Shop } from './lib';
import { Alert, Back, DietMark, Icon } from './ui';

interface MenuData { shop: Shop; categories: { id: string; name: string }[]; items: MenuItem[] }
interface QrResult { shop: Shop; walkin: { orderable: boolean; reason: string | null; message: string | null }; estimate: { minutes: number; queueLength: number } | null }

/** Walk-in entry: /s/:token from the shop's QR. Identifies the shop with no searching, then shows its menu. */
export function WalkinEntry({ token, cart, setCart }: { token: string; cart: Cart | null; setCart: (c: Cart | null) => void }) {
  const [qr, setQr] = useState<QrResult | null>(null);
  const [err, setErr] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    setQr(null);
    setErr(null);
    api
      .get<QrResult>(`/qr/${encodeURIComponent(token)}`)
      .then(setQr)
      .catch((e) => setErr({ code: e?.code ?? 'ERROR', message: errMsg(e) }));
  }, [token]);

  if (err) {
    return (
      <div className="qr-problem">
        <span className="qr-icon bad">{Icon.qr}</span>
        <h1>{err.code === 'QR_NOT_FOUND' ? 'We don’t recognise this QR code' : 'Couldn’t open this shop'}</h1>
        <p className="sub">{err.code === 'QR_NOT_FOUND' ? 'It may be old or not a Java QuickPick shop code. Scan the code on the shop’s counter again, or ask the shop.' : err.message}</p>
        <div className="stack-actions"><a className="btn primary block" href="/scan">Scan again</a><a className="btn block" href="/preorder">See all shops</a></div>
      </div>
    );
  }
  if (!qr) return <p className="loading">Opening the shop…</p>;
  if (!qr.walkin.orderable) {
    return (
      <div className="qr-problem">
        <span className="qr-icon">{Icon.qr}</span>
        <p className="eyebrow">Walk-in · {qr.shop.name}</p>
        <h1>{qr.walkin.reason === 'CLOSED' ? 'This shop is closed right now' : qr.walkin.reason === 'PAUSED' ? 'App orders are paused' : 'Ordering isn’t available here'}</h1>
        <p className="sub">{qr.walkin.message}</p>
        <div className="stack-actions">
          {qr.shop.preorder.orderable && qr.walkin.reason === 'CLOSED' && <a className="btn primary block" href={`/shop/${qr.shop.id}`}>Pre-order for later</a>}
          <a className="btn block" href="/">Home</a>
        </div>
      </div>
    );
  }
  return <ShopMenu shopId={qr.shop.id} mode="WALKIN_QR" qrToken={token} estimate={qr.estimate} cart={cart} setCart={setCart} />;
}

export function ShopMenu({
  shopId,
  mode,
  qrToken,
  estimate,
  cart,
  setCart,
}: {
  shopId: string;
  mode: OrderSource;
  qrToken?: string;
  estimate?: { minutes: number } | null;
  cart: Cart | null;
  setCart: (c: Cart | null) => void;
}) {
  const [data, setData] = useState<MenuData | null>(null);
  const [err, setErr] = useState('');
  const [sheet, setSheet] = useState<MenuItem | null>(null);
  const [pending, setPending] = useState<{ line: CartLine } | null>(null);
  useEffect(() => {
    api.get<MenuData>(`/shops/${shopId}/menu`).then(setData).catch((e) => setErr(errMsg(e)));
  }, [shopId]);

  const mine = cart && cart.shopId === shopId && cart.mode === mode ? cart : null;
  const sections = useMemo(() => {
    if (!data) return [];
    return [...data.categories, { id: '', name: 'More' }].map((c) => ({ ...c, items: data.items.filter((i) => (i.categoryId ?? '') === c.id) })).filter((c) => c.items.length);
  }, [data]);

  if (err) return <><Back href={mode === 'WALKIN_QR' ? '/' : '/preorder'}>{mode === 'WALKIN_QR' ? 'Home' : 'All shops'}</Back><Alert tone="error">{err}</Alert></>;
  if (!data) return <p className="loading">Loading menu…</p>;
  const { shop } = data;
  const avail = mode === 'WALKIN_QR' ? shop.walkin : shop.preorder;

  const addLine = (line: CartLine, base: Cart | null = mine) => {
    const b: Cart = base ?? { mode, shopId, shopName: shop.name, qrToken, lines: [] };
    const existing = b.lines.find((l) => l.key === line.key);
    const lines = existing ? b.lines.map((l) => (l.key === line.key ? { ...l, qty: Math.min(20, l.qty + line.qty) } : l)) : [...b.lines, line];
    setCart({ ...b, lines });
  };
  const tryAdd = (line: CartLine) => {
    if (cart && cart.lines.length && (cart.shopId !== shopId || cart.mode !== mode)) return setPending({ line });
    addLine(line);
  };
  const qtyOf = (itemId: string) => (mine ? mine.lines.filter((l) => l.menuItemId === itemId).reduce((s, l) => s + l.qty, 0) : 0);
  const changePlain = (it: MenuItem, delta: number) => {
    const key = lineKey(it.id, [], '');
    if (delta > 0) return tryAdd({ key, menuItemId: it.id, name: it.name, unitPricePaise: it.basePricePaise, qty: 1, modifierIds: [], modifierNames: [], notes: '' });
    if (!mine) return;
    const lines = mine.lines.map((l) => (l.key === key ? { ...l, qty: l.qty - 1 } : l)).filter((l) => l.qty > 0);
    setCart(lines.length ? { ...mine, lines } : null);
  };

  return (
    <>
      <Back href={mode === 'WALKIN_QR' ? '/' : '/preorder'}>{mode === 'WALKIN_QR' ? 'Home' : 'All shops'}</Back>
      <div className="shop-head">
        {mode === 'WALKIN_QR' && <p className="eyebrow walkin">Walk-in order · you’re at the counter</p>}
        <div className="shop-title">
          {shop.logoUrl ? <img className="logo" src={shop.logoUrl} alt="" /> : <span className="monogram lg" aria-hidden>{shop.code}</span>}
          <div>
            <h1>{shop.name}</h1>
            {shop.cuisineTags.length > 0 && <p className="sub small">{shop.cuisineTags.join(' · ')}</p>}
          </div>
        </div>
        {shop.description && <p className="sub" style={{ marginTop: 8 }}>{shop.description}</p>}
        <div className="facts">
          {mode === 'WALKIN_QR' ? (
            <span className="fact strong">{Icon.clock}Ready in about {estimate?.minutes ?? shop.avgPrepMinutes} min</span>
          ) : (
            <span className="fact">{Icon.clock}Pickup {fmtClock(shop.openTime)} – {fmtClock(shop.closeTime)}</span>
          )}
          {mode === 'PREORDER' && <span className="fact">About {shop.avgPrepMinutes} min to prepare</span>}
        </div>
      </div>
      {!avail.orderable && <div style={{ marginTop: 16 }}><Alert tone="error">{avail.message}</Alert></div>}
      {pending && (
        <div className="dialog" role="alertdialog" aria-labelledby="switch-title">
          <h2 id="switch-title">Start a new order?</h2>
          <p className="sub" style={{ marginTop: 6 }}>Your cart has a {cart?.mode === 'WALKIN_QR' ? 'walk-in' : 'pre-order'} from {cart?.shopName}. Each order is from one shop, so adding this clears your cart.</p>
          <div className="actions">
            <button className="btn" onClick={() => setPending(null)}>Keep my cart</button>
            <button className="btn primary" onClick={() => { const l = pending.line; setPending(null); addLine(l, null); }}>Clear and add</button>
          </div>
        </div>
      )}
      <p className="fee-note">Shop’s own menu prices. A {mode === 'WALKIN_QR' ? 'small' : ''} QuickPick convenience fee is shown before you pay.</p>

      {sections.length > 1 && (
        <nav className="chips" aria-label="Menu sections">
          {sections.map((sec) => <button key={sec.id || 'more'} className="chip" onClick={() => document.getElementById(`cat-${sec.id || 'more'}`)?.scrollIntoView({ behavior: 'smooth' })}>{sec.name}</button>)}
        </nav>
      )}

      {sections.map((sec) => (
        <section key={sec.id || 'more'} id={`cat-${sec.id || 'more'}`} className="category" aria-label={sec.name}>
          {sections.length > 1 && <h2>{sec.name}</h2>}
          {sec.items.map((it) => {
            const qty = qtyOf(it.id);
            const hasOptions = it.modifiers.length > 0;
            return (
              <div key={it.id} className={'dish' + (it.available ? '' : ' off')}>
                {it.imageUrl && <img className="dish-img" src={it.imageUrl} alt="" loading="lazy" />}
                <div className="grow">
                  <h3><DietMark diet={it.diet} />{it.name}</h3>
                  {it.description && <p className="desc">{it.description}</p>}
                  <p className="price">{formatPaise(it.basePricePaise)}{hasOptions && <span className="sub small"> · options</span>}</p>
                </div>
                {!it.available ? <span className="soldout">Sold out</span> : hasOptions ? (
                  <button className="add" disabled={!avail.orderable} onClick={() => setSheet(it)} aria-label={`Choose options for ${it.name}`}>{qty > 0 ? `${qty} · Add` : 'Add'}</button>
                ) : qty === 0 ? (
                  <button className="add" disabled={!avail.orderable} onClick={() => changePlain(it, 1)} aria-label={`Add ${it.name}`}>Add</button>
                ) : (
                  <div className="stepper" role="group" aria-label={`${it.name} quantity`}>
                    <button aria-label={`Remove one ${it.name}`} onClick={() => changePlain(it, -1)}>−</button>
                    <span aria-live="polite">{qty}</span>
                    <button aria-label={`Add one ${it.name}`} onClick={() => changePlain(it, 1)}>+</button>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      ))}

      {sheet && <OptionsSheet item={sheet} onClose={() => setSheet(null)} onAdd={(line) => { setSheet(null); tryAdd(line); }} />}
    </>
  );
}

/** Choose add-ons / customisation, quantity and a cooking note for one item. Validates required and single-choice groups. */
function OptionsSheet({ item, onClose, onAdd }: { item: MenuItem; onClose: () => void; onAdd: (l: CartLine) => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, Modifier[]>();
    for (const x of item.modifiers) m.set(x.group, [...(m.get(x.group) ?? []), x]);
    return [...m.entries()].map(([name, opts]) => ({ name, opts, one: opts.some((o) => o.selection === 'ONE'), required: opts.some((o) => o.required) }));
  }, [item]);
  const [picked, setPicked] = useState<string[]>(() => groups.filter((g) => g.required && g.one).map((g) => g.opts.find((o) => o.available)?.id).filter(Boolean) as string[]);
  const [qty, setQty] = useState(1);
  const [notes, setNotes] = useState('');
  const toggle = (g: (typeof groups)[number], id: string) =>
    setPicked((p) => (g.one ? [...p.filter((x) => !g.opts.some((o) => o.id === x)), id] : p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const missing = groups.find((g) => g.required && !g.opts.some((o) => picked.includes(o.id)));
  const chosen = item.modifiers.filter((m) => picked.includes(m.id));
  const unit = item.basePricePaise + chosen.reduce((s, m) => s + m.pricePaise, 0);

  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="opt-title" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet">
        <div className="sheet-head"><h2 id="opt-title"><DietMark diet={item.diet} />{item.name}</h2><button className="linkbtn" onClick={onClose}>Close</button></div>
        {item.description && <p className="sub small">{item.description}</p>}
        {groups.map((g) => (
          <fieldset key={g.name} className="optgroup">
            <legend>{g.name} <span className="sub small">{g.required ? 'Required' : g.one ? 'Choose one' : 'Optional'}</span></legend>
            {g.opts.map((o) => (
              <label key={o.id} className={'opt' + (o.available ? '' : ' off')}>
                <input type={g.one ? 'radio' : 'checkbox'} name={g.name} disabled={!o.available} checked={picked.includes(o.id)} onChange={() => toggle(g, o.id)} />
                <span className="grow">{o.name}{!o.available && ' (sold out)'}</span>
                <span className="num sub">{o.pricePaise ? `+${formatPaise(o.pricePaise)}` : ''}</span>
              </label>
            ))}
          </fieldset>
        ))}
        <div className="field"><label htmlFor="note">Cooking note (optional)</label><input id="note" maxLength={140} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. less oil, no onion" /></div>
        <div className="sheet-foot">
          <div className="stepper" role="group" aria-label="Quantity">
            <button aria-label="One fewer" onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
            <span>{qty}</span>
            <button aria-label="One more" onClick={() => setQty((q) => Math.min(20, q + 1))}>+</button>
          </div>
          <button
            className="btn primary grow"
            disabled={!!missing}
            onClick={() =>
              onAdd({ key: lineKey(item.id, picked, notes), menuItemId: item.id, name: item.name, unitPricePaise: unit, qty, modifierIds: picked, modifierNames: chosen.map((c) => c.name), notes: notes.trim() })
            }
          >
            {missing ? `Choose a ${missing.name.toLowerCase()}` : `Add · ${formatPaise(unit * qty)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
