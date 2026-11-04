import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api/client';
import { useSettings } from '../stores/settings';
import { syncEnrollment, ensurePushEnrolled, enablePush, disablePush, currentEnrollmentGeneration } from './push';

vi.mock('../api/client', async (orig) => {
  const real = await orig<typeof import('../api/client')>();
  return { ...real, api: { ...real.api, getPushSubscriptions: vi.fn(), pushUnsubscribe: vi.fn().mockResolvedValue({ ok: true }), getPushKey: vi.fn() } };
});

const realSetPushEnabled = useSettings.getState().setPushEnabled; // the real store action, before tests replace it
const setPushEnabled = vi.fn();
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('dispatch:deviceId', 'me');
  setPushEnabled.mockReset().mockResolvedValue(undefined);
  vi.mocked(api.getPushSubscriptions).mockReset();
  vi.mocked(api.pushUnsubscribe).mockClear();
  useSettings.setState({ pushEnabled: true, setPushEnabled } as any);
});

describe('syncEnrollment: a revoked device notices', () => {
  it('turns the switch off when this device\'s row is gone from the daemon list', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [{ deviceId: 'other' }] } as any);
    expect(await syncEnrollment()).toBe(true);
    expect(setPushEnabled).toHaveBeenCalledWith(false);
  });

  it('leaves the switch on when the row is still there', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [{ deviceId: 'me' }] } as any);
    expect(await syncEnrollment()).toBe(false);
    expect(setPushEnabled).not.toHaveBeenCalled();
  });

  it('changes nothing when the list cannot be read, or the switch is already off', async () => {
    vi.mocked(api.getPushSubscriptions).mockRejectedValue(new Error('offline'));
    expect(await syncEnrollment()).toBe(false);
    useSettings.setState({ pushEnabled: false } as any);
    expect(await syncEnrollment()).toBe(false);
    expect(api.getPushSubscriptions).toHaveBeenCalledTimes(1);
    expect(setPushEnabled).not.toHaveBeenCalled();
  });

  it('uses a list the caller already fetched', async () => {
    expect(await syncEnrollment([{ deviceId: 'x' }])).toBe(true);
    expect(api.getPushSubscriptions).not.toHaveBeenCalled();
  });
});

describe('ensurePushEnrolled after a revoke', () => {
  it('enrolls again instead of returning early', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [] } as any);
    // Turning the switch off (as the real setPushEnabled(false) does) then asking to enroll calls setPushEnabled(true).
    setPushEnabled.mockImplementation(async (on: boolean) => { useSettings.setState({ pushEnabled: on } as any); });
    expect(await ensurePushEnrolled()).toBeNull();
    expect(setPushEnabled.mock.calls.map((c) => c[0])).toEqual([false, true]);
  });

  it('returns early when the row is still on the daemon', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue({ subscriptions: [{ deviceId: 'me' }] } as any);
    expect(await ensurePushEnrolled()).toBeNull();
    expect(setPushEnabled).not.toHaveBeenCalled();
  });
});

describe('a stale list answer must not undo a newer enroll', () => {
  it('ignores an empty list that arrives after an enroll finished (the [false, true, false] sequence)', async () => {
    let answer!: (v: any) => void;
    vi.mocked(api.getPushSubscriptions).mockReturnValue(new Promise((r) => { answer = r; }) as any);
    const stale = syncEnrollment(); // Settings opens: the list read starts while the switch is still on
    await Promise.resolve(); await Promise.resolve();
    await enablePush(); // the bell enrolls the device meanwhile (any enroll or un-enroll counts)
    answer({ subscriptions: [] }); // the old, empty answer arrives last
    expect(await stale).toBe(false);
    expect(setPushEnabled).not.toHaveBeenCalled();
  });

  it('ignores a list read that started before an un-enroll too, and counts both ends of each', async () => {
    const g0 = currentEnrollmentGeneration();
    await disablePush();
    expect(currentEnrollmentGeneration()).toBe(g0 + 2);
    expect(await syncEnrollment([{ deviceId: 'x' }], g0)).toBe(false); // read before the change
    expect(await syncEnrollment([{ deviceId: 'x' }], currentEnrollmentGeneration())).toBe(true); // read after it
  });

  it('the list a Settings screen already holds is judged by when it was read', async () => {
    const g = currentEnrollmentGeneration();
    await enablePush();
    expect(await syncEnrollment([], g)).toBe(false);
    expect(setPushEnabled).not.toHaveBeenCalled();
  });
});

describe('reconciliations run one at a time, each with its own list', () => {
  const flip = () => setPushEnabled.mockImplementation(async (on: boolean) => { useSettings.setState({ pushEnabled: on } as any); });

  it('two reconciliations un-enroll once, not twice', async () => {
    let finishDisable!: () => void;
    setPushEnabled.mockImplementation((on: boolean) => new Promise<void>((r) => { finishDisable = () => { useSettings.setState({ pushEnabled: on } as any); r(); }; }));
    const first = syncEnrollment([]);
    await vi.waitFor(() => expect(setPushEnabled).toHaveBeenCalledTimes(1)); // the first is inside its un-enroll
    const second = syncEnrollment([]); // asked meanwhile
    await Promise.resolve();
    expect(setPushEnabled).toHaveBeenCalledTimes(1); // it waits its turn, it does not run at the same time
    finishDisable();
    expect(await first).toBe(true);
    expect(await second).toBe(false); // the switch is off now, so there is nothing to do
    expect(setPushEnabled).toHaveBeenCalledTimes(1);
  });

  it('a newer list is not thrown away for an older one that was still reading: the older says present, the newer says gone', async () => {
    flip();
    let olderAnswer!: (v: any) => void;
    vi.mocked(api.getPushSubscriptions).mockReturnValueOnce(new Promise((r) => { olderAnswer = r; }) as any);
    const older = syncEnrollment(); // reads the list from the daemon: slow, and it will still show this device
    await vi.waitFor(() => expect(api.getPushSubscriptions).toHaveBeenCalledTimes(1));
    const newer = syncEnrollment([{ deviceId: 'other' }]); // a fresh list that does NOT have this device
    olderAnswer({ subscriptions: [{ deviceId: 'me' }] });
    expect(await older).toBe(false);
    expect(await newer).toBe(true); // the newer list still acts
    expect(setPushEnabled).toHaveBeenCalledWith(false);
    expect(useSettings.getState().pushEnabled).toBe(false);
  });

  it('a list read that never answers times out, changes nothing, and does not block the next reconciliation', async () => {
    vi.useFakeTimers();
    flip();
    vi.mocked(api.getPushSubscriptions).mockReturnValueOnce(new Promise(() => {}) as any);
    const hung = syncEnrollment();
    await vi.advanceTimersByTimeAsync(7900);
    expect(setPushEnabled).not.toHaveBeenCalled();
    const next = syncEnrollment([]); // asked while the read is still hanging; it waits behind it
    await vi.advanceTimersByTimeAsync(300); // the 8 s limit passes
    expect(await hung).toBe(false); // could not read: nothing changed
    expect(await next).toBe(true); // then the queued one ran with its own list (this device is not in it)
    expect(setPushEnabled).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('an un-enroll that never finishes does not hold the queue: the next reconciliation runs after the time limit', async () => {
    vi.useFakeTimers();
    setPushEnabled.mockImplementationOnce(() => new Promise(() => {})); // hangs (a service worker that never gets ready)
    const hung = syncEnrollment([]);
    const later = syncEnrollment([{ deviceId: 'me' }]); // this device's row is present: nothing to do
    await vi.advanceTimersByTimeAsync(8100);
    expect(await hung).toBe(false); // it did not finish, so nothing was switched off
    expect(await later).toBe(false); // it ran, and was not stuck behind the hung one
    vi.useRealTimers();
  });

  it('a late un-enroll that finishes after a newer enroll changes nothing (no browser unsubscribe, no server call, switch stays on)', async () => {
    let ready!: (reg: any) => void;
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const reg = { pushManager: { getSubscription: vi.fn().mockResolvedValue({ unsubscribe }) } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: new Promise((r) => { ready = r; }) } });
    useSettings.setState({ pushEnabled: true, setPushEnabled: realSetPushEnabled } as any);
    try {
      const g0 = currentEnrollmentGeneration();
      const late = useSettings.getState().setPushEnabled(false); // starts: waits for the service worker
      await vi.waitFor(() => expect(currentEnrollmentGeneration()).toBeGreaterThan(g0)); // the un-enroll is under way
      await enablePush(); // a newer enroll starts and finishes while the un-enroll waits
      ready(reg); // now the old un-enroll wakes up
      await late;
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(api.pushUnsubscribe).not.toHaveBeenCalled();
      expect(useSettings.getState().pushEnabled).toBe(true);
    } finally {
      delete (navigator as any).serviceWorker;
    }
  });

  it('an un-enroll with nothing racing it still does all its steps', async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager: { getSubscription: async () => ({ unsubscribe }) } }) } });
    try {
      expect(await disablePush()).toBe(true);
      expect(unsubscribe).toHaveBeenCalledTimes(1);
      expect(api.pushUnsubscribe).toHaveBeenCalledWith('me');
    } finally {
      delete (navigator as any).serviceWorker;
    }
  });

});

// These two use the REAL store action and mock only below it (the service worker and the daemon calls).
describe('disable races (real setPushEnabled; service worker and api mocked)', () => {
  const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
  const setWorker = (value: unknown) => Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value });
  beforeEach(() => { useSettings.setState({ pushEnabled: true, setPushEnabled: realSetPushEnabled } as any); });
  afterEach(() => { delete (navigator as any).serviceWorker; vi.useRealTimers(); });

  it('an older un-enroll that finishes does not cancel the newer one (A waits in unsubscribe, B in getSubscription)', async () => {
    const unsubA = deferred<boolean>();
    const subB = deferred<{ unsubscribe: () => Promise<boolean> }>();
    const unsubscribeB = vi.fn().mockResolvedValue(true);
    let call = 0;
    setWorker({ ready: Promise.resolve({ pushManager: { getSubscription: () => (++call === 1 ? Promise.resolve({ unsubscribe: () => unsubA.promise }) : subB.promise) } }) });
    const g0 = currentEnrollmentGeneration();
    const a = disablePush();
    await vi.waitFor(() => expect(call).toBe(1)); // A is inside unsubscribe()
    // B is a second un-enroll that takes over; it reaches getSubscription() and waits there.
    const b = disablePush();
    await vi.waitFor(() => expect(call).toBe(2));
    unsubA.resolve(true); // A finishes its unsubscribe, sees that B is newer, and stops
    expect(await a).toBe(false);
    subB.resolve({ unsubscribe: unsubscribeB }); // B carries on
    expect(await b).toBe(true); // A's end did not invalidate B
    expect(unsubscribeB).toHaveBeenCalledTimes(1);
    expect(api.pushUnsubscribe).toHaveBeenCalledWith('me'); // the server row is removed by B, once
    expect(api.pushUnsubscribe).toHaveBeenCalledTimes(1);
    expect(currentEnrollmentGeneration()).toBeGreaterThan(g0);
  });

  it('the time limit cancels the stuck un-enroll: a later reconciliation that keeps the device enrolled is not undone when the service worker finally answers', async () => {
    vi.useFakeTimers();
    const ready = deferred<any>();
    const unsubscribe = vi.fn().mockResolvedValue(true);
    setWorker({ ready: ready.promise });
    const a = syncEnrollment([]); // this device is missing from the list: it starts an un-enroll, which stalls on the service worker
    const b = syncEnrollment([{ deviceId: 'me' }]); // queued behind it; this device IS present, so it leaves enrollment alone
    await vi.advanceTimersByTimeAsync(8100); // the limit passes: A is cancelled and the queue moves on
    expect(await a).toBe(false);
    expect(await b).toBe(false);
    expect(useSettings.getState().pushEnabled).toBe(true);
    ready.resolve({ pushManager: { getSubscription: async () => ({ unsubscribe }) } }); // the service worker answers, very late
    await vi.advanceTimersByTimeAsync(50);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(api.pushUnsubscribe).not.toHaveBeenCalled();
    expect(useSettings.getState().pushEnabled).toBe(true); // the late un-enroll did nothing
  });
});

