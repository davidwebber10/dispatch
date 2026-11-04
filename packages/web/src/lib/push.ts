import { api } from '../api/client';
import { useViewing } from '../stores/viewing';

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

/**
 * Counts every enroll or un-enroll. A list read that started before one finished is stale: it must not undo it
 * (a slow "your row is gone" answer arriving after this device enrolled again would unsubscribe it).
 */
let enrollmentGeneration = 0;
export const currentEnrollmentGeneration = (): number => enrollmentGeneration;

export async function enablePush(): Promise<'ok' | 'denied' | 'unsupported' | 'ios-install'> {
  enrollmentGeneration++;
  try { return await enablePushInner(); } finally { enrollmentGeneration++; }
}
async function enablePushInner(): Promise<'ok' | 'denied' | 'unsupported' | 'ios-install'> {
  if (!pushSupported()) return 'unsupported';
  if (iosNeedsInstall()) return 'ios-install';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  const reg = await ready();
  const { publicKey } = await api.getPushKey();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
  await api.pushSubscribe(deviceId(), sub.toJSON());
  reportPresence(true, useViewing.getState().id);
  return 'ok';
}
/**
 * Turn this device's push off. Returns false when an enroll or another un-enroll started while it waited (so it
 * stopped before its next step and changed nothing more): a late disable must not undo a newer enrollment.
 */
export async function disablePush(): Promise<boolean> {
  const mine = ++enrollmentGeneration;
  try { return await disablePushInner(mine); } finally { enrollmentGeneration++; }
}
async function disablePushInner(mine: number): Promise<boolean> {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (enrollmentGeneration !== mine) return false;
    const sub = await reg.pushManager.getSubscription();
    if (enrollmentGeneration !== mine) return false;
    await sub?.unsubscribe();
  } catch { /* ignore */ }
  if (enrollmentGeneration !== mine) return false;
  try { await api.pushUnsubscribe(deviceId()); } catch { /* ignore */ }
  return enrollmentGeneration === mine;
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
  // The daemon's own "too many stored subscriptions" text says what to do; show it as it is.
  if (/push subscriptions/.test(code)) return code;
  return code === 'ios-install' ? 'On iPhone/iPad, add Dispatch to your Home Screen first, then enable.'
    : code === 'unsupported' ? 'Push notifications aren\'t supported in this browser.'
    : code === 'denied' ? 'Notification permission was denied.'
    : 'Couldn\'t enable push notifications — please try again.';
}

/**
 * The owner can revoke this device in Settings > Access > Notification devices, or the daemon can drop its row
 * (a 410 from the push service). This browser would still think it is enrolled: its local switch stays on and
 * `ensurePushEnrolled` returns early, so it never receives an alert again and never asks to. Compare this device's
 * id with the daemon's list; if the row is gone, turn the switch off so the next "on" enrolls again. Pass a list you
 * already fetched, or it fetches one. A list that cannot be read changes nothing. Returns true when it switched off.
 */
/** How long a push-list read, or the un-enroll that follows, may take before the queue moves on. A read that times out changes nothing. */
const LIST_TIMEOUT_MS = 8000;
// Reconciliations run one after another, each with its OWN list. A newer one is never dropped for an older one that
// was already running (an old list that still shows this device must not hide a newer list that says it is gone).
let reconcileQueue: Promise<unknown> = Promise.resolve();
export function syncEnrollment(known?: { deviceId: string }[], startedAt?: number): Promise<boolean> {
  const asked = startedAt ?? enrollmentGeneration; // the state when the caller asked, not when its turn comes
  const run = reconcileQueue.then(() => syncEnrollmentOnce(known, asked), () => syncEnrollmentOnce(known, asked));
  reconcileQueue = run.catch(() => undefined);
  return run;
}
async function syncEnrollmentOnce(known?: { deviceId: string }[], startedAt?: number): Promise<boolean> {
  // `startedAt` is the generation when the caller began reading its list; without it, the generation now (taken
  // first, before any await, so nothing that finishes while this function waits can be missed).
  const gen = startedAt ?? enrollmentGeneration;
  const { useSettings } = await import('../stores/settings'); // dynamic: settings.ts imports this module
  if (!useSettings.getState().pushEnabled) return false;
  let list = known;
  if (!list) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const read = api.getPushSubscriptions().then((r) => r.subscriptions);
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('push list timed out')), LIST_TIMEOUT_MS); });
      list = await Promise.race([read, timeout]);
    } catch { return false; } finally { clearTimeout(timer); }
  }
  if (list.some((s) => s.deviceId === deviceId())) return false;
  // An enroll or un-enroll finished (or is running) since this list was read: the answer is out of date.
  if (gen !== enrollmentGeneration) return false;
  // Bounded like the list read: a service worker that never becomes ready must not hold every later reconciliation.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      useSettings.getState().setPushEnabled(false),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, LIST_TIMEOUT_MS); }),
    ]);
  } catch { /* the daemon side is already gone */ } finally { clearTimeout(timer); }
  return true;
}

/** Enroll this device (permission prompt + subscription) if it isn't already.
 *  Returns null on success, a user-facing message on failure. Must be called
 *  from a user gesture (the permission prompt requires it). */
export async function ensurePushEnrolled(): Promise<string | null> {
  const { useSettings } = await import('../stores/settings'); // dynamic: settings.ts imports this module
  // A device the owner revoked still has its switch on: check the daemon's list before trusting it.
  if (useSettings.getState().pushEnabled) await syncEnrollment();
  if (useSettings.getState().pushEnabled) return null;
  try { await useSettings.getState().setPushEnabled(true); return null; }
  catch (e: any) { return pushErrorMessage(String(e?.message)); }
}
