import { ORDER_STATUS_LABEL, TERMINAL_STATUSES, formatPaise, type OrderView } from '@qp2/shared';
import { useCallback, useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { Checkout } from './Checkout';
import { API_URL, api, cartCount, cartTotal, errMsg, fmtClock, fmtDay, fmtTime, linkHandler, loadCart, navigate, plural, saveCart, useLocation, type Cart, type Shop } from './lib';
import { ShopMenu, WalkinEntry } from './Menu';
import { OrderPage, pillTone } from './OrderPage';
import { enablePush, showLocalNotification } from './push';
import { Scan } from './Scan';
import { SignIn } from './SignIn';
import { Alert, Back, Icon, ModeBadge } from './ui';

interface InboxItem { id: string; orderId: string | null; type: string; title: string; body: string; createdAt: string; readAt: string | null }

export function App() {
  const { path, query } = useLocation();
  const [authed, setAuthed] = useState(!!api.getToken());
  const [cart, setCartState] = useState<Cart | null>(loadCart);
  const [unread, setUnread] = useState(0);
  const [banner, setBanner] = useState<InboxItem | null>(null);
  const setCart = (c: Cart | null) => {
    setCartState(c && c.lines.length ? c : null);
    saveCart(c);
  };

  useEffect(() => {
    document.addEventListener('click', linkHandler);
    const out = () => {
      api.clearToken();
      setAuthed(false);
    };
    const inn = () => setAuthed(true);
    window.addEventListener('qp-logout', out);
    window.addEventListener('qp-login', inn);
    return () => {
      document.removeEventListener('click', linkHandler);
      window.removeEventListener('qp-logout', out);
      window.removeEventListener('qp-login', inn);
    };
  }, []);

  // In-app notifications: the always-available fallback for push. Signalled over Socket.IO, polled as a backstop.
  const lastSeen = useRefState<string | null>(null);
  const checkInbox = useCallback(async () => {
    if (!api.getToken()) return;
    try {
      const r = await api.get<{ notifications: InboxItem[]; unread: number }>('/me/notifications');
      setUnread(r.unread);
      const newest = r.notifications[0];
      if (newest && lastSeen.current && newest.id !== lastSeen.current && !newest.readAt) {
        setBanner(newest);
        showLocalNotification(newest.title, newest.body, newest.orderId ? `/orders/${newest.orderId}` : '/inbox');
      }
      if (newest) lastSeen.current = newest.id;
    } catch {
      /* offline: try again on the next tick */
    }
  }, [lastSeen]);
  useEffect(() => {
    if (!authed) return;
    void checkInbox();
    const t = setInterval(checkInbox, 15000);
    const socket = io(API_URL, { auth: { token: api.getToken() }, transports: ['websocket', 'polling'] });
    socket.on('notification', () => void checkInbox());
    return () => {
      clearInterval(t);
      socket.close();
    };
  }, [authed, checkInbox]);
  useEffect(() => {
    if (!banner) return;
    const t = setTimeout(() => setBanner(null), 6000);
    return () => clearTimeout(t);
  }, [banner]);

  const seg = path.split('/').filter(Boolean);
  const [p0, p1] = [seg[0] ?? '', seg[1]];
  const count = cartCount(cart);
  const needsAuth = p0 === 'orders' || p0 === 'inbox';

  let page;
  if (needsAuth && !authed) page = <div className="section"><SignIn title={p0 === 'inbox' ? 'Sign in to see your notifications' : 'Sign in to see your orders'} onDone={() => setAuthed(true)} /></div>;
  else if (p0 === 's' && p1) page = <WalkinEntry token={p1} cart={cart} setCart={setCart} />;
  else if (p0 === 'shop' && p1) page = <ShopMenu shopId={p1} mode="PREORDER" cart={cart} setCart={setCart} />;
  else if (p0 === 'preorder') page = <PreorderShops cart={cart} />;
  else if (p0 === 'scan') page = <Scan />;
  else if (p0 === 'cart') page = <Checkout cart={cart} setCart={setCart} authed={authed} />;
  else if (p0 === 'orders' && p1) page = <OrderPage orderId={p1} fromCheckout={query.get('from') === 'checkout'} />;
  else if (p0 === 'orders') page = <History />;
  else if (p0 === 'inbox') page = <Inbox onRead={() => setUnread(0)} />;
  else page = <Home authed={authed} cart={cart} />;

  const showCartBar = cart && count > 0 && (p0 === 's' || p0 === 'shop' || p0 === '' || p0 === 'preorder');

  return (
    <div className="shell">
      <div className="testmode">Test mode: payments are simulated and no money is charged</div>
      <header className="header">
        <a className="wordmark" href="/" aria-label="Java QuickPick home">
          <span className="mark">{Icon.cup}</span>
          <span><b>Java QuickPick</b><span>Java Green, SRM KTR</span></span>
        </a>
        <nav aria-label="Account">
          {authed ? (
            <>
              <a className={'navlink' + (p0 === 'orders' ? ' active' : '')} href="/orders">Orders</a>
              <a className={'navlink bell' + (p0 === 'inbox' ? ' active' : '')} href="/inbox" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>{Icon.bell}{unread > 0 && <span className="dotcount">{unread}</span>}</a>
              <button className="navlink" onClick={() => { api.clearToken(); setAuthed(false); navigate('/'); }}>Sign out</button>
            </>
          ) : (
            <a className="navlink" href="/orders">Sign in</a>
          )}
        </nav>
      </header>

      {banner && (
        <a className="inapp" href={banner.orderId ? `/orders/${banner.orderId}` : '/inbox'} role="status" onClick={() => setBanner(null)}>
          {Icon.bell}<span><b>{banner.title}</b><span>{banner.body}</span></span>
        </a>
      )}

      <main>{page}</main>

      {showCartBar && (
        <div className="dock"><div className="dock-inner">
          <button className="cartbar" onClick={() => navigate('/cart')}>
            <span><span className="count">{plural(count, 'item')} · {cart!.mode === 'WALKIN_QR' ? 'walk-in at' : 'pre-order from'} {cart!.shopName}</span><span className="total">{formatPaise(cartTotal(cart))}</span></span>
            <span className="go">Review {Icon.chevronRight}</span>
          </button>
        </div></div>
      )}
    </div>
  );
}

function useRefState<T>(initial: T) {
  const [ref] = useState(() => ({ current: initial }));
  return ref;
}

// ---------- home: the two ordering modes ----------
function Home({ authed, cart }: { authed: boolean; cart: Cart | null }) {
  const [shops, setShops] = useState<Shop[] | null>(null);
  const [orders, setOrders] = useState<OrderView[]>([]);
  const [err, setErr] = useState('');
  const [alerts, setAlerts] = useState<string>(() => ('Notification' in window ? Notification.permission : 'unsupported'));
  useEffect(() => {
    api.get<{ shops: Shop[] }>('/shops').then((r) => setShops(r.shops)).catch((e) => setErr(errMsg(e)));
    if (authed) api.get<{ orders: OrderView[] }>('/me/orders').then((r) => setOrders(r.orders)).catch(() => undefined);
  }, [authed]);
  const active = orders.filter((o) => !TERMINAL_STATUSES.includes(o.status) && !(o.status === 'PENDING_PAYMENT' && o.expiresAt && new Date(o.expiresAt) < new Date()));
  const recent = orders.filter((o) => TERMINAL_STATUSES.includes(o.status)).slice(0, 3);

  return (
    <>
      <div className="hero">
        <h1>Food from Java Green, without the queue.</h1>
        <p>Order ahead for a pickup time, or order from the counter with the shop’s QR. Pay on your phone, collect with a code.</p>
      </div>

      {active.length > 0 && (
        <section className="section" style={{ marginTop: 18 }} aria-label="Active orders">
          <h2>Your active orders</h2>
          <ul className="list compact">
            {active.map((o) => (
              <li key={o.id}>
                <a className="row-link" href={`/orders/${o.id}`}>
                  <span className="grow">
                    <span className="row-title"><h2>{o.shopName}</h2><span className={`pill ${pillTone(o.status)}`}>{o.status === 'READY' ? 'Ready — show code' : ORDER_STATUS_LABEL[o.status]}</span></span>
                    <span className="row-meta"><ModeBadge mode={o.orderSource} /><span>{o.orderNumber}</span><span>{o.slotStartsAt ? `Pickup ${fmtTime(o.slotStartsAt)}` : o.estimatedReadyAt ? `Ready ~${fmtTime(o.estimatedReadyAt)}` : ''}</span></span>
                  </span>
                  {Icon.chevronRight}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="modes">
        <a className="mode-card pre" href="/preorder">
          <span className="mode-icon">{Icon.clock}</span>
          <span className="grow">
            <b>Pre-order</b>
            <span>Not at Java Green yet? Choose a shop, pick a pickup time and pay now. Your food is ready when you arrive.</span>
          </span>
          {Icon.chevronRight}
        </a>
        <a className="mode-card walkin" href="/scan">
          <span className="mode-icon">{Icon.qr}</span>
          <span className="grow">
            <b>Walk-in</b>
            <span>Already at a shop? Scan the QR on its counter, order and pay from your phone. No app install needed.</span>
          </span>
          {Icon.chevronRight}
        </a>
      </div>

      {cart && <p className="sub small" style={{ marginTop: 10 }}>You have a {cart.mode === 'WALKIN_QR' ? 'walk-in' : 'pre-order'} cart from {cart.shopName}. <a href="/cart">Review it</a></p>}

      {authed && alerts === 'default' && (
        <div className="alert info" style={{ marginTop: 16 }}>
          <span className="grow">Get a notification when your order is ready.</span>
          <button className="linkbtn" onClick={async () => setAlerts(await enablePush())}>Turn on</button>
        </div>
      )}

      <section className="section">
        <div className="section-head"><h2>Shops on Java QuickPick</h2><a className="small" href="/preorder" style={{ fontWeight: 600 }}>Pre-order</a></div>
        {err && <Alert tone="error">{err}</Alert>}
        {!shops && !err && <p className="loading">Loading shops…</p>}
        {shops && <ShopList shops={shops} cart={cart} />}
      </section>

      {recent.length > 0 && (
        <section className="section">
          <div className="section-head"><h2>Recent orders</h2><a className="small" href="/orders" style={{ fontWeight: 600 }}>All orders</a></div>
          <ul className="list compact">
            {recent.map((o) => (
              <li key={o.id}><a className="row-link" href={`/orders/${o.id}`}><span className="grow"><span className="row-title"><h2>{o.shopName}</h2><span className="num">{formatPaise(o.totalPaise)}</span></span><span className="row-meta"><span className={`pill ${pillTone(o.status)}`}>{ORDER_STATUS_LABEL[o.status]}</span><span>{fmtDay(o.createdAt)}</span></span></span>{Icon.chevronRight}</a></li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function ShopStatus({ shop }: { shop: Shop }) {
  if (!shop.acceptingOrders) return <span className="pill bad">Paused</span>;
  if (!shop.openNow) return <span className="pill">Closed now</span>;
  return <span className="pill open">Open</span>;
}

function ShopList({ shops, cart }: { shops: Shop[]; cart: Cart | null }) {
  if (shops.length === 0) return <div className="empty"><h2>No shops are live yet</h2><p>Check back closer to lunch.</p></div>;
  return (
    <ul className="list">
      {shops.map((s) => (
        <li key={s.id}>
          <a className="row-link" href={`/shop/${s.id}`}>
            {s.logoUrl ? <img className="logo" src={s.logoUrl} alt="" /> : <span className="monogram" aria-hidden>{s.code}</span>}
            <span className="grow">
              <span className="row-title"><h2>{s.name}</h2><ShopStatus shop={s} /></span>
              {s.cuisineTags.length > 0 && <span className="row-desc" style={{ display: 'block' }}>{s.cuisineTags.join(' · ')}</span>}
              <span className="row-meta">
                <span>{fmtClock(s.openTime)} – {fmtClock(s.closeTime)}</span>
                <span>~{s.avgPrepMinutes} min</span>
                {cart?.shopId === s.id && <span style={{ color: 'var(--leaf)', fontWeight: 600 }}>{plural(cartCount(cart), 'item')} in cart</span>}
                {s.isDemo && <span>Demo</span>}
              </span>
            </span>
            {Icon.chevronRight}
          </a>
        </li>
      ))}
    </ul>
  );
}

function PreorderShops({ cart }: { cart: Cart | null }) {
  const [shops, setShops] = useState<Shop[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get<{ shops: Shop[] }>('/shops').then((r) => setShops(r.shops.filter((s) => s.preorderEnabled))).catch((e) => setErr(errMsg(e)));
  }, []);
  return (
    <>
      <Back href="/">Home</Back>
      <div className="page-head">
        <span className="mode pre">Pre-order</span>
        <h1 style={{ marginTop: 8 }}>Choose a shop</h1>
        <p>Order from one shop at a time and pick when to collect. You’ll see every charge before you pay.</p>
      </div>
      {err && <Alert tone="error">{err}</Alert>}
      {!shops && !err && <p className="loading">Loading shops…</p>}
      {shops && <ShopList shops={shops} cart={cart} />}
    </>
  );
}

function History() {
  const [orders, setOrders] = useState<OrderView[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get<{ orders: OrderView[] }>('/me/orders').then((r) => setOrders(r.orders)).catch((e) => { setErr(errMsg(e)); setOrders([]); });
  }, []);
  if (!orders) return <p className="loading">Loading your orders…</p>;
  return (
    <>
      <div className="page-head"><h1>Your orders</h1></div>
      {err && <Alert tone="error">{err}</Alert>}
      {orders.length === 0 && !err && <div className="empty"><h2>No orders yet</h2><p>Your current and past orders will appear here.</p><a className="btn primary" href="/">Start an order</a></div>}
      {orders.length > 0 && (
        <ul className="list">
          {orders.map((o) => (
            <li key={o.id}>
              <a className="row-link order-row" href={`/orders/${o.id}`}>
                <span className="grow">
                  <span className="row-title"><h2>{o.shopName}</h2><span className="total">{formatPaise(o.totalPaise)}</span></span>
                  <span className="row-meta" style={{ alignItems: 'center' }}>
                    <span className={`pill ${pillTone(o.status)}`}>{ORDER_STATUS_LABEL[o.status]}</span>
                    <ModeBadge mode={o.orderSource} />
                    <span>{fmtDay(o.createdAt)}, {fmtTime(o.slotStartsAt ?? o.createdAt)}</span>
                    <span>{o.orderNumber}</span>
                  </span>
                </span>
                {Icon.chevronRight}
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Inbox({ onRead }: { onRead: () => void }) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  useEffect(() => {
    api.get<{ notifications: InboxItem[] }>('/me/notifications').then((r) => {
      setItems(r.notifications);
      if (r.notifications.some((n) => !n.readAt)) api.post('/me/notifications/read', {}).then(onRead).catch(() => undefined);
    }).catch(() => setItems([]));
  }, [onRead]);
  if (!items) return <p className="loading">Loading…</p>;
  return (
    <>
      <div className="page-head"><h1>Notifications</h1><p>Every update about your orders, even if a push notification didn’t reach your phone.</p></div>
      {items.length === 0 ? <div className="empty"><h2>Nothing yet</h2></div> : (
        <ul className="list">
          {items.map((n) => (
            <li key={n.id}>
              <a className={'row-link inbox-row' + (n.readAt ? '' : ' unread')} href={n.orderId ? `/orders/${n.orderId}` : '/'}>
                <span className="grow"><span className="row-title"><h2>{n.title}</h2><span className="small sub">{fmtTime(n.createdAt)}</span></span><span className="row-desc" style={{ whiteSpace: 'normal' }}>{n.body}</span></span>
                {Icon.chevronRight}
              </a>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
