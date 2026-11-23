import { describe, expect, test, vi, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { wireStopOnAuthFailure, wireRestartOnAuthFailure, takeAuthRestart, isAuthStop } from './auth-stop.js';

afterEach(() => { vi.useRealTimers(); });
const mgr = () => new EventEmitter() as any;
const next = () => new Promise((r) => setImmediate(r));

describe('wireStopOnAuthFailure (hosted)', () => {
  test('stops the thread when its failed turn ends: Claude says `failed`, not `idle`', async () => {
    const m = mgr(); let quietDuringStop = false;
    const stop = vi.fn(() => { quietDuringStop = isAuthStop('t1'); });
    const off = wireStopOnAuthFailure({ managers: [m], stop });
    m.emit('auth-required', 't1', {});
    m.emit('failed', 't1');
    await next();
    expect(stop).toHaveBeenCalledWith('t1');
    expect(quietDuringStop).toBe(true);  // its exit is quiet while the stop runs
    expect(isAuthStop('t1')).toBe(false); // and not after
    off();
  });

  test('a process that exits first takes the waiting stop with it: a new process is not stopped', async () => {
    vi.useFakeTimers();
    const m = mgr(); const stop = vi.fn();
    const off = wireStopOnAuthFailure({ managers: [m], stop, delayMs: 10_000 });
    m.emit('auth-required', 't2', {});
    m.emit('exit', 't2', 0);          // Switch account or a restart replaced the process
    await vi.advanceTimersByTimeAsync(11_000);
    expect(stop).not.toHaveBeenCalled();
    off();
  });
});

describe('wireRestartOnAuthFailure (local)', () => {
  test('a login failure asks for one fresh process; an idle turn or an exit clears it', () => {
    const m = mgr();
    const off = wireRestartOnAuthFailure([m]);
    m.emit('auth-required', 'a', {});
    expect(takeAuthRestart('a')).toBe(true);
    expect(takeAuthRestart('a')).toBe(false);     // once
    m.emit('auth-required', 'b', {}); m.emit('idle', 'b');
    expect(takeAuthRestart('b')).toBe(false);
    m.emit('auth-required', 'c', {}); m.emit('exit', 'c', 0);
    expect(takeAuthRestart('c')).toBe(false);
    off();
  });
});
