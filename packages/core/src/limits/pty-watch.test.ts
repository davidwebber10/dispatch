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
});
