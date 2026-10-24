import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PtyLimitWatcher } from './pty-watch.js';

const banner = "  ⎿  You've hit your session limit · resets 1:10am (America/Indianapolis)\r\n";
let hits: { id: string; kind: string }[];
let idle: boolean;
let w: PtyLimitWatcher;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 24, 4, 31));
  hits = []; idle = true;
  w = new PtyLimitWatcher({ isIdle: () => idle, onLimit: (id, l) => hits.push({ id, kind: l.kind }), confirmMs: 5000 });
});
afterEach(() => { w.forget('t1'); vi.useRealTimers(); });
const quiet = (ms = 5000) => vi.advanceTimersByTime(ms);

describe('PtyLimitWatcher', () => {
  it('parks only after the terminal stays quiet for the confirm delay', () => {
    w.feed('t1', banner);
    expect(hits).toEqual([]);
    vi.advanceTimersByTime(5000);
    expect(hits).toEqual([{ id: 't1', kind: 'session' }]);
  });
  it('a banner split across two chunks is still found', () => {
    w.feed('t1', "You've hit your session limit · res");
    w.feed('t1', 'ets 1:10am (America/Indianapolis)\r\n');
    vi.advanceTimersByTime(5000);
    expect(hits).toHaveLength(1);
  });
  it('an agent that quotes the text and keeps working never parks', () => {
    w.feed('t1', banner);
    idle = false; // the terminal went on working
    vi.advanceTimersByTime(5000);
    expect(hits).toEqual([]);
  });
  it('reports a banner once, not on every redraw', () => {
    w.feed('t1', banner); w.feed('t1', banner); w.feed('t1', banner);
    vi.advanceTimersByTime(5000);
    w.feed('t1', banner);
    vi.advanceTimersByTime(5000);
    expect(hits).toHaveLength(1);
  });
  it('ordinary output is ignored', () => {
    w.feed('t1', 'npm test\r\nall green\r\n');
    vi.advanceTimersByTime(10000);
    expect(hits).toEqual([]);
  });
  it('new output after the banner (the agent went on talking) restarts the quiet wait', () => {
    w.feed('t1', banner);
    quiet(3000);
    w.feed('t1', 'Here is how the limit banner works...\r\n');
    quiet(3000);
    expect(hits).toEqual([]);
    quiet(2000);
    expect(hits).toHaveLength(1);
  });
  it('a repaint that is only the banner does not restart the wait', () => {
    w.feed('t1', banner);
    quiet(3000);
    w.feed('t1', banner);
    quiet(2000);
    expect(hits).toHaveLength(1);
  });
  it('forget cancels a pending detection (the owner took over)', () => {
    w.feed('t1', banner);
    w.forget('t1');
    quiet(10000);
    expect(hits).toEqual([]);
  });
  it('reads the reset from the whole banner when the chunks split it', () => {
    const seen: (number | null)[] = [];
    const w2 = new PtyLimitWatcher({ isIdle: () => true, onLimit: (_i, l) => seen.push(l.resetsAt), confirmMs: 5000 });
    w2.feed('t2', "You've hit your session limit · resets");
    w2.feed('t2', ' 1:10am (America/Indianapolis)\r\n');
    vi.advanceTimersByTime(5000);
    expect(seen).toEqual([Date.UTC(2026, 9, 24, 5, 10)]);
    w2.forget('t2');
  });
  it('a redraw of the same banner after the reset passed is not a new limit', () => {
    w.feed('t1', banner); quiet(5000);
    vi.setSystemTime(Date.UTC(2026, 9, 24, 5, 11));
    w.feed('t1', banner); quiet(5000);
    expect(hits).toHaveLength(1);
  });
});
