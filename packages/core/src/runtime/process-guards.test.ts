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
afterEach(() => { delete process.env.DISPATCH_MAX_UNCAUGHT_PER_MINUTE; delete process.env.DISPATCH_MAX_CRASH_LOGS_PER_MINUTE; vi.useRealTimers(); });

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
    const odd = new Error('odd');
    Object.defineProperty(odd, 'stack', { value: { toString() { throw new Error('coercion escaped'); } } });
    expect(() => handlers.uncaughtException(odd)).not.toThrow();
    const evil = { toString() { throw new Error('x'); }, toJSON() { throw new Error('y'); } };
    expect(() => handlers.unhandledRejection(evil)).not.toThrow();
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.join('\n')).toMatch(/could not be described/);
    // The breaker still counts after a bad error (limit 1, so the second one in the minute exits).
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

describe('crash log rate limit', () => {
  it('logs the first N unhandled rejections in a minute, says once that the rest are counted, then writes a count', () => {
    process.env.DISPATCH_MAX_CRASH_LOGS_PER_MINUTE = '3';
    const { handlers, lines, now } = setup();
    for (let i = 0; i < 100; i++) handlers.unhandledRejection(new Error(`r${i}`));
    const rejections = lines.filter((l) => /unhandled promise rejection; staying up/.test(l));
    expect(rejections).toHaveLength(3);
    expect(lines.filter((l) => /more than 3 unhandled promise rejections in one minute/.test(l))).toHaveLength(1);
    expect(lines).toHaveLength(4); // 3 reports + the one notice; the other 97 wrote nothing
    now.t += 61_000;
    handlers.unhandledRejection(new Error('next minute'));
    expect(lines.some((l) => /97 more unhandled promise rejections in the last minute were not logged/.test(l))).toBe(true);
    expect(lines[lines.length - 1]).toMatch(/next minute/); // a new minute logs again
  });

  it('writes the count at the end of the minute even when nothing else throws', () => {
    vi.useFakeTimers();
    process.env.DISPATCH_MAX_CRASH_LOGS_PER_MINUTE = '1';
    const { handlers, lines } = setup();
    for (let i = 0; i < 5; i++) handlers.unhandledRejection(new Error('r'));
    vi.advanceTimersByTime(60_001);
    expect(lines.some((l) => /4 more unhandled promise rejections/.test(l))).toBe(true);
  });

  it('rate-limits uncaught exceptions when the exit limit is 0, and the logging cannot cause an exit', () => {
    process.env.DISPATCH_MAX_UNCAUGHT_PER_MINUTE = '0';
    process.env.DISPATCH_MAX_CRASH_LOGS_PER_MINUTE = '2';
    const { handlers, proc, lines } = setup();
    for (let i = 0; i < 50; i++) handlers.uncaughtException(new Error(`e${i}`));
    expect(lines.filter((l) => /uncaught exception \(/.test(l))).toHaveLength(2);
    expect(lines).toHaveLength(3);
    expect(proc.exit).not.toHaveBeenCalled();
  });

  it('with an exit limit, every uncaught exception is logged (the flood ends in an exit)', () => {
    process.env.DISPATCH_MAX_UNCAUGHT_PER_MINUTE = '5';
    process.env.DISPATCH_MAX_CRASH_LOGS_PER_MINUTE = '1';
    const { handlers, proc, lines } = setup();
    for (let i = 0; i < 6; i++) handlers.uncaughtException(new Error(`e${i}`));
    expect(lines.filter((l) => /uncaught exception \(/.test(l))).toHaveLength(6);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it('0 logs every report', () => {
    process.env.DISPATCH_MAX_CRASH_LOGS_PER_MINUTE = '0';
    const { handlers, lines } = setup();
    for (let i = 0; i < 40; i++) handlers.unhandledRejection(new Error('r'));
    expect(lines).toHaveLength(40);
  });

  it('a flush timer from the previous minute does not clear the next minute\'s count', () => {
    vi.useFakeTimers();
    process.env.DISPATCH_MAX_CRASH_LOGS_PER_MINUTE = '1';
    const { handlers, lines, now } = setup();
    const rej = () => handlers.unhandledRejection(new Error('r'));
    now.t = 0; rej(); // logged
    now.t = 59_000; rej(); // counted: notice + a flush timer due at 60 s
    now.t = 60_000; rej(); // a new minute: the old minute is summarised, this one is logged
    expect(lines.filter((l) => /1 more unhandled promise rejections/.test(l))).toHaveLength(1);
    now.t = 61_000; rej(); // counted in the NEW minute
    const before = lines.length;
    vi.advanceTimersByTime(1500); // past the old timer's due time (it was cancelled)
    expect(lines).toHaveLength(before);
    expect(lines.filter((l) => /more than 1 unhandled promise rejections in one minute/.test(l))).toHaveLength(2); // one notice per minute
    now.t = 120_000;
    vi.advanceTimersByTime(60_000); // the new minute's own flush
    expect(lines.filter((l) => /1 more unhandled promise rejections in the last minute/.test(l))).toHaveLength(2);
    expect(lines.filter((l) => /more unhandled promise rejections in the last minute/.test(l))).toHaveLength(2); // no third, split summary
  });
});

