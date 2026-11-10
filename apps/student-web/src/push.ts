import { api } from './lib';

/**
 * Firebase Cloud Messaging for the PWA. Enabled only when the build has a Firebase web config:
 *   VITE_FIREBASE_CONFIG='{"apiKey":"…","projectId":"…","messagingSenderId":"…","appId":"…"}'
 *   VITE_FIREBASE_VAPID_KEY='…'
 * Without it, students still get every update in the app (inbox + live tracker), and the page shows a browser
 * notification while it is open. NOT yet tested against a real Firebase project.
 */
const config = import.meta.env.VITE_FIREBASE_CONFIG as string | undefined;
const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined;

export const pushConfigured = () => !!(config && vapidKey && 'serviceWorker' in navigator && 'Notification' in window);

export async function enablePush(): Promise<'enabled' | 'denied' | 'unavailable'> {
  if (!('Notification' in window)) return 'unavailable';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  if (!pushConfigured()) return 'enabled'; // in-page notifications only
  try {
    const [{ initializeApp }, { getMessaging, getToken }] = await Promise.all([import('@firebase/app'), import('@firebase/messaging')]);
    const app = initializeApp(JSON.parse(config!));
    const registration = await navigator.serviceWorker.register('/sw.js');
    const token = await getToken(getMessaging(app), { vapidKey, serviceWorkerRegistration: registration });
    if (token) await api.post('/me/push-tokens', { token, platform: 'WEB' });
    return 'enabled';
  } catch {
    return 'unavailable';
  }
}

/** While the app is open, mirror new in-app notifications as a system notification (works without Firebase). */
export function showLocalNotification(title: string, body: string, url: string) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  try {
    const n = new Notification(title, { body, icon: '/icon.svg', tag: url });
    n.onclick = () => {
      window.focus();
      location.assign(url);
    };
  } catch {
    /* some mobile browsers only allow notifications from a service worker */
  }
}
