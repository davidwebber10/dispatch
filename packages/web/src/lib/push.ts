import { api } from '../api/client';

const DEVICE_KEY = 'dispatch:deviceId';
export function deviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = (crypto.randomUUID?.() ?? String(Math.random()).slice(2)); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && typeof Notification !== 'undefined';
}
/** On iOS, web push requires the PWA be installed (standalone display mode). */
export function iosNeedsInstall(): boolean {
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (!isIOS) return false;
  const standalone = window.matchMedia?.('(display-mode: standalone)')?.matches || (navigator as any).standalone === true;
  return !standalone;
}

async function ready(): Promise<ServiceWorkerRegistration> {
  // The PWA SW is registered by the app shell; ensure it exists.
  if (!navigator.serviceWorker.controller) { try { await navigator.serviceWorker.register('/sw.js'); } catch { /* ignore */ } }
  return navigator.serviceWorker.ready;
}

export async function enablePush(): Promise<'ok' | 'denied' | 'unsupported' | 'ios-install'> {
  if (!pushSupported()) return 'unsupported';
  if (iosNeedsInstall()) return 'ios-install';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  const reg = await ready();
  const { publicKey } = await api.getPushKey();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await api.pushSubscribe(deviceId(), sub.toJSON());
  reportPresence(true);
  return 'ok';
}
export async function disablePush(): Promise<void> {
  try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); await sub?.unsubscribe(); } catch { /* ignore */ }
  try { await api.pushUnsubscribe(deviceId()); } catch { /* ignore */ }
}
export function reportPresence(foreground: boolean, activeTerminalId: string | null = null): void {
  void api.pushPresence(deviceId(), foreground, activeTerminalId).catch(() => {});
}

/** Can THIS context receive web push? Gates every piece of alert UI (design:
 *  incapable contexts show no bell at all — e.g. iOS Safari in-browser, plain-http origins). */
export function canReceiveAlerts(): boolean {
  return pushSupported() && !iosNeedsInstall() && window.isSecureContext;
}

/** One place for enrollment-failure copy (shared by Settings and the bell toggles). */
export function pushErrorMessage(code: string): string {
  return code === 'ios-install' ? 'On iPhone/iPad, add Dispatch to your Home Screen first, then enable.'
    : code === 'unsupported' ? 'Push notifications aren\'t supported in this browser.'
    : code === 'denied' ? 'Notification permission was denied.'
    : 'Couldn\'t enable push notifications — please try again.';
}

/** Enroll this device (permission prompt + subscription) if it isn't already.
 *  Returns null on success, a user-facing message on failure. Must be called
 *  from a user gesture (the permission prompt requires it). */
export async function ensurePushEnrolled(): Promise<string | null> {
  const { useSettings } = await import('../stores/settings'); // dynamic: settings.ts imports this module
  if (useSettings.getState().pushEnabled) return null;
  try { await useSettings.getState().setPushEnabled(true); return null; }
  catch (e: any) { return pushErrorMessage(String(e?.message)); }
}
