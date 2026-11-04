import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api/client';
import { useSettings } from '../stores/settings';
import { syncEnrollment, ensurePushEnrolled, enablePush, disablePush } from './push';

vi.mock('../api/client', async (orig) => {
  const real = await orig<typeof import('../api/client')>();
  return {
    ...real,
    api: {
      ...real.api,
      getPushSubscriptions: vi.fn(), pushUnsubscribe: vi.fn(), getPushKey: vi.fn(), pushSubscribe: vi.fn(), pushPresence: vi.fn(),
    },
  };
});

// The real store action runs in every test; only the browser (service worker, push manager) and the daemon calls are faked.
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
const tick = async (n = 5) => { for (let i = 0; i < n; i++) await Promise.resolve(); };

let log: string[];
let regFactory: () => any;
const setWorker = (reg: () => any) => {
  regFactory = reg;
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: {}, get ready() { return Promise.resolve(regFactory()); } } });
};
/** A browser whose push manager steps the test can hold open. */
function browser(over: { getSubscription?: () => Promise<any>; subscribe?: () => Promise<any>; ready?: Promise<any> } = {}) {
  const unsubscribe = vi.fn(async () => { log.push('browser-unsubscribe'); return true; });
  const reg = {
    pushManager: {
      getSubscription: over.getSubscription ?? (async () => ({ unsubscribe })),
      subscribe: over.subscribe ?? (async () => { log.push('browser-subscribe'); return { toJSON: () => ({ endpoint: 'https://web.push.apple.com/x', keys: {} }) }; }),
    },
  };
  if (over.ready) Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { controller: {}, ready: over.ready.then(() => reg) } });
  else setWorker(() => reg);
  return { reg, unsubscribe };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('dispatch:deviceId', 'me');
  log = [];
  (window as any).PushManager = function PushManager() {};
  (globalThis as any).Notification = { requestPermission: vi.fn(async () => 'granted') };
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  vi.mocked(api.getPushSubscriptions).mockReset();
  vi.mocked(api.getPushKey).mockReset().mockResolvedValue({ publicKey: 'AQAB' });
  vi.mocked(api.pushSubscribe).mockReset().mockImplementation(async () => { log.push('server-subscribe'); return { ok: true } as any; });
  vi.mocked(api.pushUnsubscribe).mockReset().mockImplementation(async () => { log.push('server-unsubscribe'); return { ok: true } as any; });
  vi.mocked(api.pushPresence).mockReset().mockResolvedValue({ ok: true } as any);
  useSettings.setState({ pushEnabled: true } as any);
  browser();
});
afterEach(() => { delete (navigator as any).serviceWorker; delete (window as any).PushManager; delete (globalThis as any).Notification; vi.useRealTimers(); });

const listWith = (...ids: string[]) => ({ subscriptions: ids.map((deviceId) => ({ deviceId })) }) as any;

describe('one queue: operations run one at a time, newest request wins', () => {
  it('an enable and a disable never overlap: the second starts after the first has finished', async () => {
    const gate = deferred<void>();
    browser({ subscribe: async () => { log.push('browser-subscribe-start'); await gate.promise; log.push('browser-subscribe-end'); return { toJSON: () => ({}) }; } });
    const enable = useSettings.getState().setPushEnabled(true);
    await vi.waitFor(() => expect(log).toContain('browser-subscribe-start'));
    const disable = useSettings.getState().setPushEnabled(false); // asked while the enable is mid-step
    await tick(20);
    expect(log).not.toContain('browser-unsubscribe'); // it is waiting its turn
    gate.resolve();
    await enable; await disable;
    // The enable stopped after its subscribe step because a newer request (off) replaced it; then the disable ran whole.
    expect(log).not.toContain('server-subscribe');
    expect(log.indexOf('browser-subscribe-end')).toBeLessThan(log.indexOf('browser-unsubscribe'));
    expect(log).toContain('server-unsubscribe');
    expect(useSettings.getState().pushEnabled).toBe(false);
  });

  it('superseded disable (r8): a disable in flight when an enable is asked stops before its daemon step, and the enable finishes', async () => {
    const hold = deferred<boolean>();
    const { reg } = browser({ getSubscription: async () => ({ unsubscribe: async () => { log.push('browser-unsubscribe-start'); await hold.promise; log.push('browser-unsubscribe-end'); return true; } }) });
    void reg;
    const disable = useSettings.getState().setPushEnabled(false);
    await vi.waitFor(() => expect(log).toContain('browser-unsubscribe-start'));
    const enable = useSettings.getState().setPushEnabled(true);
    await tick(20); // the enable request is registered
    hold.resolve(true);
    await disable; await enable;
    expect(log).not.toContain('server-unsubscribe'); // the old disable never reached its daemon step
    expect(log).toContain('server-subscribe');
    expect(useSettings.getState().pushEnabled).toBe(true); // the newest request won
  });

  it('a disable then an enable then a disable: only the last state is applied', async () => {
    const a = useSettings.getState().setPushEnabled(false);
    const b = useSettings.getState().setPushEnabled(true);
    const c = useSettings.getState().setPushEnabled(false);
    await Promise.all([a, b, c]);
    expect(log.filter((l) => l === 'server-subscribe')).toHaveLength(0);
    expect(useSettings.getState().pushEnabled).toBe(false);
  });
});

describe('every step has a time limit (hung steps, r7)', () => {
  it('a service worker that never becomes ready does not hold the queue: the disable carries on to the daemon, and a later enable runs', async () => {
    vi.useFakeTimers();
    browser({ ready: new Promise(() => {}) }); // never ready
    const disable = useSettings.getState().setPushEnabled(false);
    await vi.advanceTimersByTimeAsync(10_100); // the browser step times out; the daemon step goes ahead
    await disable;
    expect(log).toContain('server-unsubscribe');
    expect(useSettings.getState().pushEnabled).toBe(false);
    browser(); // the service worker is back
    await useSettings.getState().setPushEnabled(true);
    expect(log).toContain('server-subscribe');
    expect(useSettings.getState().pushEnabled).toBe(true);
  });

  it('an enable whose subscribe never answers ends as a timeout, leaves the switch off, and frees the queue', async () => {
    vi.useFakeTimers();
    browser({ subscribe: () => new Promise(() => {}) });
    useSettings.setState({ pushEnabled: false } as any);
    const enable = useSettings.getState().setPushEnabled(true).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(String(await enable)).toMatch(/timeout/);
    expect(useSettings.getState().pushEnabled).toBe(false);
    browser();
    await useSettings.getState().setPushEnabled(true);
    expect(useSettings.getState().pushEnabled).toBe(true);
  });

  it('a daemon call that never answers makes a disable report not-done, and frees the queue', async () => {
    vi.useFakeTimers();
    vi.mocked(api.pushUnsubscribe).mockReturnValueOnce(new Promise(() => {}) as any);
    const p = disablePush();
    await vi.advanceTimersByTimeAsync(10_100);
    expect(await p).toBe(false);
    expect(await disablePush()).toBe(true); // the next one runs
  });
});

describe('a time-out in one operation never cancels a newer one (r9)', () => {
  it('a sync whose disable is stuck in the browser step: the user\'s own disable, queued behind it, still completes in full', async () => {
    vi.useFakeTimers();
    vi.mocked(api.getPushSubscriptions).mockResolvedValue(listWith()); // this device is gone from the daemon
    const stuck = deferred<any>();
    browser({ getSubscription: () => stuck.promise }); // the browser step hangs
    const sync = syncEnrollment();
    await vi.advanceTimersByTimeAsync(50);
    const user = useSettings.getState().setPushEnabled(false); // the user turns it off meanwhile
    await vi.advanceTimersByTimeAsync(10_100); // the stuck step times out
    await vi.advanceTimersByTimeAsync(10_100); // (the second disable's own browser step times out too)
    await sync; await user;
    expect(log.filter((l) => l === 'server-unsubscribe').length).toBeGreaterThanOrEqual(1);
    expect(useSettings.getState().pushEnabled).toBe(false);
  });
});

describe('stale lists cannot undo an enroll (r7 and r9)', () => {
  it('the list is read on the sync\'s own turn, after an enable that was running has finished', async () => {
    const gate = deferred<void>();
    browser({ subscribe: async () => { await gate.promise; log.push('browser-subscribe-end'); return { toJSON: () => ({}) }; } });
    useSettings.setState({ pushEnabled: false } as any);
    const enable = useSettings.getState().setPushEnabled(true);
    await tick(20);
    useSettings.setState({ pushEnabled: true } as any); // (the switch is on while the enable runs)
    vi.mocked(api.getPushSubscriptions).mockImplementation(async () => { log.push('list-read'); return listWith('me'); });
    const sync = syncEnrollment();
    await tick(20);
    expect(log).not.toContain('list-read'); // it waits for the enable
    gate.resolve();
    await enable; await sync;
    expect(log.indexOf('browser-subscribe-end')).toBeLessThan(log.indexOf('list-read'));
  });

  it('an empty list that arrives after an enable was asked is ignored: the device stays enrolled', async () => {
    const answer = deferred<any>();
    vi.mocked(api.getPushSubscriptions).mockReturnValue(answer.promise);
    const sync = syncEnrollment();
    await vi.waitFor(() => expect(api.getPushSubscriptions).toHaveBeenCalled()); // the sync is waiting on its list
    const enable = useSettings.getState().setPushEnabled(true); // the person enables meanwhile
    answer.resolve(listWith()); // the empty answer arrives
    expect(await sync).toBe(false); // it stood down
    await enable;
    expect(log).not.toContain('server-unsubscribe');
    expect(useSettings.getState().pushEnabled).toBe(true);
  });

  it('a list that cannot be read, or reads too slowly, changes nothing', async () => {
    vi.useFakeTimers();
    vi.mocked(api.getPushSubscriptions).mockRejectedValueOnce(new Error('offline'));
    expect(await syncEnrollment()).toBe(false);
    vi.mocked(api.getPushSubscriptions).mockReturnValueOnce(new Promise(() => {}) as any);
    const slow = syncEnrollment();
    await vi.advanceTimersByTimeAsync(10_100);
    expect(await slow).toBe(false);
    expect(useSettings.getState().pushEnabled).toBe(true);
    expect(log).toEqual([]);
  });
});

describe('syncEnrollment: a revoked device notices', () => {
  it('turns the switch off and removes its subscription when its row is gone from the daemon list', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue(listWith('other'));
    expect(await syncEnrollment()).toBe(true);
    expect(useSettings.getState().pushEnabled).toBe(false);
    expect(log).toContain('server-unsubscribe');
  });

  it('leaves the switch on when the row is still there, or the switch is already off', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue(listWith('me'));
    expect(await syncEnrollment()).toBe(false);
    expect(useSettings.getState().pushEnabled).toBe(true);
    useSettings.setState({ pushEnabled: false } as any);
    expect(await syncEnrollment()).toBe(false);
    expect(api.getPushSubscriptions).toHaveBeenCalledTimes(1);
  });
});

describe('ensurePushEnrolled after a revoke', () => {
  it('enrolls again instead of returning early', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue(listWith());
    expect(await ensurePushEnrolled()).toBeNull();
    expect(log.indexOf('server-unsubscribe')).toBeLessThan(log.indexOf('server-subscribe'));
    expect(useSettings.getState().pushEnabled).toBe(true);
  });

  it('returns early when the row is still on the daemon', async () => {
    vi.mocked(api.getPushSubscriptions).mockResolvedValue(listWith('me'));
    expect(await ensurePushEnrolled()).toBeNull();
    expect(log).toEqual([]);
  });
});

describe('enablePush results', () => {
  it('reports unsupported / denied without touching the daemon', async () => {
    delete (window as any).PushManager;
    expect(await enablePush()).toBe('unsupported');
    (window as any).PushManager = function PushManager() {};
    (globalThis as any).Notification.requestPermission = vi.fn(async () => 'denied');
    expect(await enablePush()).toBe('denied');
    expect(api.pushSubscribe).not.toHaveBeenCalled();
  });
});
