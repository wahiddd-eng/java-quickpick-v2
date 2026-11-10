// Service worker: makes the app installable and shows push notifications (FCM web push).
// It deliberately caches NOTHING, so order and payment data is always live from the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = {}; }
  const n = payload.notification || {};
  const data = payload.data || {};
  const link = (payload.fcmOptions && payload.fcmOptions.link) || (data.orderId ? `/orders/${data.orderId}` : '/');
  event.waitUntil(self.registration.showNotification(n.title || 'Java QuickPick', { body: n.body || '', icon: '/icon.svg', data: { link }, tag: data.orderId || undefined }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = (event.notification.data && event.notification.data.link) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) if ('focus' in w) { w.navigate(link); return w.focus(); }
      return self.clients.openWindow(link);
    }),
  );
});
