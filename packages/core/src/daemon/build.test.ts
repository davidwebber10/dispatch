// W3-A: buildDaemon is the one composition root. createApp (tests) and startServer (the daemon) both call it.
import { afterEach, describe, expect, test, vi } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { buildDaemon } from './build.js';
import { daemonTimers } from './timers.js';
import { closeKits, kit } from '../../tests/daemon/kit.js';

afterEach(() => { vi.useRealTimers(); closeKits(); });

describe('buildDaemon', () => {
  test('buildDaemon with auth open serves /api/sessions', async () => {
    const k = kit({ auth: 'open' });
    const r = await request(await k.server()).get('/api/sessions');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
    // A caller that is not on this computer is served too: the build has no gate.
    k.peer.address = '192.168.1.9';
    expect((await request(await k.server()).get('/api/sessions').set('Host', '192.168.1.5:3456')).status).toBe(200);
  });

  test('with auth gate a remote Host gets the sign-in page', async () => {
    const k = kit({ auth: 'gate' });
    k.peer.address = '192.168.1.9';
    const page = await request(await k.server()).get('/').set('Host', '192.168.1.5:3456').set('Accept', 'text/html');
    expect(page.status).toBe(401);
    expect(page.text).toContain('id="t"');
    expect(page.headers['x-frame-options']).toBe('DENY'); // the security headers come before the gate
    const api = await request(await k.server()).get('/api/sessions').set('Host', '192.168.1.5:3456');
    expect(api.status).toBe(401);
    expect(api.body).toEqual({ error: 'auth_required' });
    // The owner's own browser on this computer needs no credential.
    k.peer.address = '127.0.0.1';
    expect((await request(await k.server()).get('/api/sessions').set('Host', 'localhost:3456')).status).toBe(200);
  });

  test('timers false creates no interval', () => {
    vi.useFakeTimers();
    const k = kit({ timers: false });
    expect(vi.getTimerCount()).toBe(0);
    const stop = k.daemon.startTimers();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  test('a build creates no interval before startTimers, also with timers true', () => {
    vi.useFakeTimers();
    const k = kit({ timers: true });
    // The plugin workers keep their own 30 s schedule tick (plugins/workers.ts); every other timer waits for startTimers.
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    k.daemon.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  test('stop clears every interval', () => {
    vi.useFakeTimers();
    const k = kit({ timers: true });
    const before = vi.getTimerCount();
    k.daemon.startTimers();
    // One timer for each entry of the list that this build starts (no network: the update, telemetry, marketplace and box entries stay out).
    const names = daemonTimers(k.daemon.services, { network: false }).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['ws-heartbeat', 'scheduler-tick', 'pty-timing', 'auto-archive', 'interim-recap', 'usage-limits', 'usage-gauge']));
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(before + 7);
    k.daemon.stop();
    expect(vi.getTimerCount()).toBe(0);
    k.daemon.stop(); // a second stop is a no-op
  });

  test('the stop function that startTimers returns clears the timers and leaves the daemon running', async () => {
    vi.useFakeTimers();
    const k = kit({ timers: true });
    const before = vi.getTimerCount();
    const stopTimers = k.daemon.startTimers();
    expect(k.daemon.startTimers()).toBe(stopTimers); // a second start adds nothing
    stopTimers();
    expect(vi.getTimerCount()).toBe(before);
    vi.useRealTimers();
    expect((await request(await k.server()).get('/api/sessions')).status).toBe(200);
  });

  test('the full timer list names every interval of the daemon', () => {
    const k = kit({ timers: true });
    expect(daemonTimers(k.daemon.services, { network: true }).map((t) => t.name)).toEqual([
      'ws-heartbeat', 'plugin-watch', 'marketplace-check', 'usage-limits', 'usage-gauge', 'box-heartbeat',
      'pty-timing', 'update-check', 'telemetry', 'scheduler-tick', 'process-reaper', 'auto-archive', 'interim-recap',
    ]);
  });

  test('a build with no db throws a clear error', () => {
    expect(() => buildDaemon({ dataDir: '/tmp/x' } as never)).toThrow(/buildDaemon: "db" is required/);
    const closed = new Database(':memory:');
    closed.close();
    expect(() => buildDaemon({ db: closed, dataDir: '/tmp/x' })).toThrow(/buildDaemon: "db" is closed/);
    const db = new Database(':memory:');
    expect(() => buildDaemon({ db } as never)).toThrow(/buildDaemon: "dataDir" is required/);
    db.close();
  });

  test('a manager map without claude-code throws at build time', () => {
    expect(() => kit({ managers: {} })).toThrow(/claude-code/);
  });
});
