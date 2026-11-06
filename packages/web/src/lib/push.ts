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

// ---- Enrollment: one queue --------------------------------------------------------------------------------------
// Every enable, disable and list-sync runs through ONE queue, one at a time, so two of them never overlap and none
// can act on a state an earlier one has changed. The newest requested state wins: `desired` is set the moment an
// enable or disable is asked for, and an older operation that sees it differ stops at its next step. Every network or
// service-worker step has a time limit, so a step that never answers cannot hold the queue.
export type EnableResult = 'ok' | 'denied' | 'unsupported' | 'ios-install' | 'timeout' | 'superseded';

/** The most any single step may take (a service worker, the daemon, the browser's push service). */
const STEP_TIMEOUT_MS = 10_000;
class StepTimeout extends Error {}
function step<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new StepTimeout('push step timed out')), STEP_TIMEOUT_MS); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

let desired: 'on' | 'off' | null = null; // the newest state anyone asked for
let pending = 0; // enable and disable requests not finished yet
let tail: Promise<unknown> = Promise.resolve();
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const run = tail.then(op, op);
  tail = run.then(() => undefined, () => undefined);
  return run;
}

/** Ask for this device's push to be on. Resolves when it has run, or been replaced by a newer request ('superseded'). */
export function enablePush(): Promise<EnableResult> {
  desired = 'on'; pending++;
  return enqueue(async () => { try { return await runEnable(); } finally { pending--; } });
}
async function runEnable(): Promise<EnableResult> {
  if (desired !== 'on') return 'superseded';
  if (!pushSupported()) return 'unsupported';
  if (iosNeedsInstall()) return 'ios-install';
  try {
    const perm = await Notification.requestPermission(); // waits for the person: no time limit
    if (perm !== 'granted') return 'denied';
    if (desired !== 'on') return 'superseded';
    const reg = await step(ready());
    if (desired !== 'on') return 'superseded';
    const { publicKey } = await step(api.getPushKey());
    if (desired !== 'on') return 'superseded';
    const sub = await step(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
    if (desired !== 'on') return 'superseded';
    await step(api.pushSubscribe(deviceId(), sub.toJSON()));
  } catch (e) {
    if (e instanceof StepTimeout) return 'timeout';
    throw e;
  }
  reportPresence(true, useViewing.getState().id);
  return 'ok';
}

/** Ask for this device's push to be off. Resolves true when it finished, false when a newer request replaced it or a step timed out. */
export function disablePush(): Promise<boolean> {
  desired = 'off'; pending++;
  return enqueue(async () => { try { return await runDisable(); } finally { pending--; } });
}
async function runDisable(): Promise<boolean> {
  if (desired !== 'off') return false;
  // The browser's own subscription. A failure or time-out here is not fatal: the daemon row below is what stops alerts.
  try {
    const reg = await step(navigator.serviceWorker.ready);
    if (desired !== 'off') return false;
    const sub = await step(reg.pushManager.getSubscription());
    if (desired !== 'off') return false;
    await step(Promise.resolve(sub?.unsubscribe()));
  } catch { /* go on to the daemon */ }
  if (desired !== 'off') return false;
  try { await step(api.pushUnsubscribe(deviceId())); } catch (e) { if (e instanceof StepTimeout) return false; }
  return true;
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
 * The owner can revoke this device in Settings > Notifications > Notification devices, or the daemon can drop its row
 * (a 410 from the push service). This browser would still think it is enrolled: its local switch stays on and
 * `ensurePushEnrolled` returns early, so it never receives an alert again and never asks to. This reads the daemon's
 * list, and if this device's row is gone, turns the switch off so the next "on" enrolls again.
 *
 * It runs in the queue and reads the list on its own turn, so the list is read after every earlier enable or
 * disable has finished and cannot be stale. If anyone has asked for a newer state since, it stands down. A list that
 * cannot be read in time changes nothing. Returns true when it switched the device off.
 */
export async function syncEnrollment(): Promise<boolean> {
  const { useSettings } = await import('../stores/settings'); // dynamic: settings.ts imports this module
  if (!useSettings.getState().pushEnabled) return false;
  // The turn decides; it does not wait for the disable it asks for (that would wait behind itself).
  const turn = await enqueue(async (): Promise<{ followUp: Promise<boolean> | null }> => {
    const store = useSettings.getState();
    if (!store.pushEnabled) return { followUp: null };
    let list: { deviceId: string }[];
    try { list = (await step(api.getPushSubscriptions())).subscriptions; } catch { return { followUp: null }; }
    if (pending > 0) return { followUp: null }; // someone asked for a newer state while the list was read
    if (list.some((s) => s.deviceId === deviceId())) return { followUp: null };
    const followUp = disablePush().then((done) => { if (done) useSettings.getState().setPushEnabledLocal(false); return done; });
    return { followUp };
  }).catch(() => ({ followUp: null }));
  return turn.followUp ? await turn.followUp.catch(() => false) : false;
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
