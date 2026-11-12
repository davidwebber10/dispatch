import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act, screen } from '@testing-library/react';
import {
  isBoxDownAnswer, isDaemonBackAnswer, noteBoxDown, probeBox, resetBoxRestart, useBoxRestart, reloadTarget,
  setBoxBackHandler, isBoxDown, PROBE_FIRST_MS, PROBE_MAX_MS, SLOW_AFTER_MS,
} from './boxRestart';
import { BoxRestartPill } from '../components/common/BoxRestartPill';
import { useDraft, forgetDraftMemory } from '../hooks/useDraft';
import { useTabs } from '../stores/tabs';
import { reloadForSignIn } from './signInReload';

/** A fake answer. A real Response cannot be marked `redirected` or `opaqueredirect`. */
function ans(status: number, body: string, type = 'application/json', extra: { redirected?: boolean; type?: ResponseType } = {}): Response {
  const headers = new Headers(type ? { 'content-type': type } : {});
  const make = (): Response => ({
    status, ok: status >= 200 && status < 300, redirected: extra.redirected ?? false, type: extra.type ?? 'basic', headers,
    json: async () => JSON.parse(body), text: async () => body, clone: () => make(),
  } as unknown as Response);
  return make();
}

const DAEMON = JSON.stringify({ profile: 'business', hosted: true, osBaseUrl: null, ownerEmail: null, capabilities: ['base-path'] });
const ROUTER_503 = '{"error":"box not ready","state":"starting"}';
const OLD_ENTRY = 'http://localhost:3000/assets/index-OLD.js';
const shell = (entry: string) => `<!doctype html><html><head><script type="module" crossorigin src="${entry}"></script></head></html>`;

/**
 * A router + daemon. `state` decides each answer: 'down' (router 503 JSON for the API, launcher
 * redirect for the page), or the build the daemon now serves.
 */
function world() {
  const w = { state: 'down' as 'down' | 'launcher-html' | 'redirect' | 'old' | 'new', calls: [] as Array<{ url: string; init: RequestInit }> };
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    w.calls.push({ url, init });
    const page = url === reloadTarget();
    if (w.state === 'down') return page ? ans(302, '', 'text/html', { type: 'opaqueredirect' }) : ans(503, ROUTER_503);
    if (w.state === 'redirect') return ans(0, '', '', { type: 'opaqueredirect' });
    if (w.state === 'launcher-html') return ans(200, '<html>launcher</html>', 'text/html', { redirected: true });
    if (page) return ans(200, shell(w.state === 'old' ? OLD_ENTRY : 'http://localhost:3000/assets/index-NEW.js'), 'text/html');
    return ans(200, DAEMON);
  });
  return { w, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe('answers', () => {
  it('the router\'s 503 {error,state}, a 502, a redirect and the launcher HTML are "down"; the daemon\'s own 503 is not', async () => {
    expect(await isBoxDownAnswer(ans(503, ROUTER_503))).toBe(true);
    expect(await isBoxDownAnswer(ans(502, ''))).toBe(true);
    expect(await isBoxDownAnswer(ans(200, '<html>launcher</html>', 'text/html'))).toBe(true);
    expect(await isBoxDownAnswer(ans(0, '', '', { type: 'opaqueredirect' }))).toBe(true);
    expect(await isBoxDownAnswer(ans(503, '{"error":"chat is off"}'))).toBe(false);
    expect(await isBoxDownAnswer(ans(404, '{"error":"nope"}'))).toBe(false);
  });

  it('only a 200 JSON answer in the daemon\'s shape is "back"', async () => {
    expect(await isDaemonBackAnswer(ans(200, DAEMON))).toBe(true);
    expect(await isDaemonBackAnswer(ans(200, DAEMON, 'application/json', { redirected: true }))).toBe(false);
    expect(await isDaemonBackAnswer(ans(0, '', '', { type: 'opaqueredirect' }))).toBe(false);
    expect(await isDaemonBackAnswer(ans(200, '<html>launcher</html>', 'text/html'))).toBe(false);
    expect(await isDaemonBackAnswer(ans(200, '{"kind":"owner"}'))).toBe(false); // JSON, but not the daemon's host context
    for (const s of [401, 409, 502, 503]) expect(await isDaemonBackAnswer(ans(s, DAEMON))).toBe(false);
  });
});

describe('a hosted workspace restarting', () => {
  beforeEach(() => { vi.useFakeTimers(); resetBoxRestart(); localStorage.clear(); });
  afterEach(() => { resetBoxRestart(); vi.useRealTimers(); });

  it('down → probes → back on the same build: no reload, the sockets reconnect, the pill goes', async () => {
    const { w, fetchImpl } = world();
    const reload = vi.fn();
    const back = vi.fn();
    setBoxBackHandler(back);
    noteBoxDown({ fetchImpl, reload, currentEntry: () => OLD_ENTRY });
    noteBoxDown({ fetchImpl, reload, currentEntry: () => OLD_ENTRY }); // a second failure starts no second wait
    expect(isBoxDown()).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reload).not.toHaveBeenCalled();
    const probe = w.calls.find((c) => c.url === '/api/host-context')!;
    expect(probe.init).toMatchObject({ redirect: 'manual', cache: 'no-store', headers: { Accept: 'application/json' } });
    w.state = 'old';
    await vi.advanceTimersByTimeAsync(PROBE_MAX_MS);
    expect(reload).not.toHaveBeenCalled();
    expect(back).toHaveBeenCalledTimes(1);
    expect(isBoxDown()).toBe(false);
    // The wait is over: no more probes.
    const n = w.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(w.calls.length).toBe(n);
  });

  it('back on a new build: ONE reload, at the page\'s own address under the base path', async () => {
    const { w, fetchImpl } = world();
    const reload = vi.fn();
    const back = vi.fn();
    setBoxBackHandler(back);
    noteBoxDown({ fetchImpl, reload, currentEntry: () => OLD_ENTRY });
    await vi.advanceTimersByTimeAsync(20_000);
    w.state = 'new';
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reload.mock.calls[0][0].startsWith(reloadTarget())).toBe(true);
    expect(back).not.toHaveBeenCalled();
    // The shell was asked for without following redirects, so the launcher can never count as the new build.
    expect(w.calls.find((c) => c.url === reloadTarget())!.init).toMatchObject({ redirect: 'manual', cache: 'no-store' });
  });

  it('a redirect and the launcher HTML are "not back": it never reloads, and the probe backs off from 1.5 s to 5 s', async () => {
    const { w, fetchImpl } = world();
    const reload = vi.fn();
    const back = vi.fn();
    setBoxBackHandler(back);
    w.state = 'redirect';
    noteBoxDown({ fetchImpl, reload, currentEntry: () => OLD_ENTRY });
    const times: number[] = [];
    const start = Date.now();
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => { times.push(Date.now() - start); return ans(0, '', '', { type: 'opaqueredirect' }); });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(times.slice(0, 4)).toEqual([PROBE_FIRST_MS, PROBE_FIRST_MS + 2250, PROBE_FIRST_MS + 2250 + 3375, PROBE_FIRST_MS + 2250 + 3375 + PROBE_MAX_MS]);
    (fetchImpl as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ans(200, '<html>launcher</html>', 'text/html', { redirected: true }));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(reload).not.toHaveBeenCalled();
    expect(back).not.toHaveBeenCalled();
    expect(isBoxDown()).toBe(true);
  });

  it('the daemon answers but its page still redirects (router not ready for page loads): it keeps waiting', async () => {
    const reload = vi.fn();
    const f = vi.fn(async (url: string) => (url === reloadTarget() ? ans(302, '', 'text/html', { type: 'opaqueredirect' }) : ans(200, DAEMON)));
    noteBoxDown({ fetchImpl: f as unknown as typeof fetch, reload, currentEntry: () => OLD_ENTRY });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reload).not.toHaveBeenCalled();
    expect(isBoxDown()).toBe(true);
  });

  it('after 3 minutes one plain line is added, with no machine words', async () => {
    const { fetchImpl } = world();
    noteBoxDown({ fetchImpl, reload: vi.fn(), currentEntry: () => OLD_ENTRY });
    render(<BoxRestartPill />);
    expect(screen.getByTestId('box-restart').textContent).toBe('Reconnecting…');
    await act(async () => { await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS - 1000); });
    expect(screen.queryByTestId('box-restart-slow')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const text = screen.getByTestId('box-restart').textContent ?? '';
    expect(text).toContain('This takes longer than usual.');
    expect(text).not.toMatch(/box|container|server|daemon|restart/i);
  });

  it('an unsent draft and the open tabs survive the wait and the reconnect', async () => {
    const { w, fetchImpl } = world();
    const { result } = renderHook(() => useDraft('t-draft'));
    act(() => result.current[1]('half-typed message'));
    const tabsBefore = useTabs.getState().byProject;
    const reload = vi.fn();
    noteBoxDown({ fetchImpl, reload, currentEntry: () => OLD_ENTRY });
    await vi.advanceTimersByTimeAsync(SLOW_AFTER_MS + 60_000);
    w.state = 'old';
    await vi.advanceTimersByTimeAsync(PROBE_MAX_MS);
    expect(reload).not.toHaveBeenCalled();
    expect(result.current[0]).toBe('half-typed message');
    expect(useTabs.getState().byProject).toBe(tabsBefore);
    // Even a reload (a new build) keeps it: the draft is in local storage.
    forgetDraftMemory();
    expect(renderHook(() => useDraft('t-draft')).result.current[0]).toBe('half-typed message');
  });

  it('no sign-in reload while down', () => {
    useBoxRestart.setState({ down: true });
    sessionStorage.clear();
    reloadForSignIn();
    expect(sessionStorage.getItem('dispatch:signin-reload')).toBeNull();
  });
});

describe('a local install (no base path)', () => {
  beforeEach(() => resetBoxRestart());
  it('a socket that keeps closing asks nothing and shows nothing: the sockets\' own retry is unchanged', async () => {
    const f = vi.fn(async () => ans(503, ROUTER_503));
    await probeBox({ fetchImpl: f as unknown as typeof fetch });
    expect(f).not.toHaveBeenCalled();
    expect(useBoxRestart.getState().down).toBe(false);
  });
});

describe('the router\'s 409', () => {
  beforeEach(() => resetBoxRestart());
  it('update-needed goes to the base path; a legacy move goes to its location; a daemon 409 is data', async () => {
    const { routerConflictTarget } = await import('./boxRestart');
    expect(await routerConflictTarget(ans(409, '{"error":"x","reason":"update-needed"}'))).toBe(reloadTarget());
    expect(await routerConflictTarget(ans(409, '{"error":"x","location":"/dispatch/"}'))).toBe('/dispatch/');
    expect(await routerConflictTarget(ans(409, '{"error":"x","location":"//evil.example/"}'))).toBeNull();
    expect(await routerConflictTarget(ans(409, '{"error":"thread is busy"}'))).toBeNull();
    expect(await routerConflictTarget(ans(503, '{"state":"starting"}'))).toBeNull();
  });
  it('leaves once', async () => {
    const { leaveFor } = await import('./boxRestart');
    const go = vi.fn();
    leaveFor('/dispatch/', go);
    leaveFor('/dispatch/', go);
    expect(go).toHaveBeenCalledTimes(1);
    expect(useBoxRestart.getState().down).toBe(true);
  });
});
