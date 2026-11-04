import { describe, it, expect, vi, afterEach } from 'vitest';
import { installProcessGuards } from './process-guards.js';

function setup(now = { t: 0 }) {
  const handlers: Record<string, (...a: any[]) => void> = {};
  const proc = {
    on: vi.fn((ev: string, fn: any) => { handlers[ev] = fn; return proc; }),
    off: vi.fn(),
    exit: vi.fn(),
  } as any;
  const lines: string[] = [];
  const off = installProcessGuards({ proc, log: (l) => lines.push(l), now: () => now.t });
  return { handlers, proc, lines, off, now };
}
afterEach(() => { delete process.env.DISPATCH_MAX_UNCAUGHT_PER_MINUTE; });

describe('installProcessGuards', () => {
  it('logs an uncaught exception with its stack and stays up', () => {
    const { handlers, proc, lines } = setup();
    handlers.uncaughtException(new Error('boom'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/uncaught exception.*staying up/s);
    expect(lines[0]).toMatch(/Error: boom/);
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('logs an unhandled rejection and stays up, even a non-Error reason', () => {
    const { handlers, proc, lines } = setup();
    handlers.unhandledRejection('plain string');
    handlers.unhandledRejection(new Error('later'));
    expect(lines[0]).toMatch(/unhandled promise rejection/);
    expect(lines[0]).toMatch(/plain string/);
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('exits when the limit is passed inside one minute, with a clear line', () => {
    process.env.DISPATCH_MAX_UNCAUGHT_PER_MINUTE = '3';
    const { handlers, proc, lines } = setup();
    for (let i = 0; i < 3; i++) handlers.uncaughtException(new Error(`e${i}`));
    expect(proc.exit).not.toHaveBeenCalled();
    handlers.uncaughtException(new Error('e3'));
    expect(proc.exit).toHaveBeenCalledWith(1);
    expect(lines.join('\n')).toMatch(/more than 3 uncaught exceptions in one minute/);
  });

  it('does not exit when the errors are spread over more than a minute', () => {
    process.env.DISPATCH_MAX_UNCAUGHT_PER_MINUTE = '2';
    const now = { t: 0 };
    const { handlers, proc } = setup(now);
    for (let i = 0; i < 10; i++) { now.t += 40_000; handlers.uncaughtException(new Error('slow')); }
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('unhandled rejections never count toward the exit limit; 0 never exits', () => {
    process.env.DISPATCH_MAX_UNCAUGHT_PER_MINUTE = '1';
    const a = setup();
    for (let i = 0; i < 20; i++) a.handlers.unhandledRejection(new Error('r'));
    expect(a.proc.exit).not.toHaveBeenCalled();
    process.env.DISPATCH_MAX_UNCAUGHT_PER_MINUTE = '0';
    const b = setup();
    for (let i = 0; i < 50; i++) b.handlers.uncaughtException(new Error('x'));
    expect(b.proc.exit).not.toHaveBeenCalled();
  });

  it('survives an error whose stack getter throws, and a log function that throws', () => {
    process.env.DISPATCH_MAX_UNCAUGHT_PER_MINUTE = '1';
    const { handlers, proc, lines } = setup();
    const bad = new Error('bad');
    Object.defineProperty(bad, 'stack', { get() { throw new Error('getter'); } });
    expect(() => handlers.uncaughtException(bad)).not.toThrow();
    expect(lines).toHaveLength(1);
    const evil = { toString() { throw new Error('x'); }, toJSON() { throw new Error('y'); } };
    expect(() => handlers.unhandledRejection(evil)).not.toThrow();
    expect(lines[1]).toMatch(/could not be described/);
    // The breaker still counts after a bad error.
    handlers.uncaughtException(new Error('again'));
    expect(proc.exit).toHaveBeenCalledWith(1);
    // A log that throws does not stop the exit path.
    const handlers2: Record<string, (...a: any[]) => void> = {};
    const proc2 = { on: (e: string, f: any) => { handlers2[e] = f; }, off: vi.fn(), exit: vi.fn() } as any;
    installProcessGuards({ proc: proc2, log: () => { throw new Error('log failed'); }, now: () => 0 });
    expect(() => { handlers2.uncaughtException(new Error('a')); handlers2.uncaughtException(new Error('b')); }).not.toThrow();
    expect(proc2.exit).toHaveBeenCalledWith(1);
  });

  it('returns a function that removes both handlers', () => {
    const { off, proc } = setup();
    off();
    expect(proc.off).toHaveBeenCalledTimes(2);
  });
});
