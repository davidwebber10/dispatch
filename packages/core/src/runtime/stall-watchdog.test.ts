import { describe, it, expect } from 'vitest';
import { StallWatchdog, stallThresholdMs, type StallChange, type StallDeps } from './stall-watchdog.js';

const MIN = 60_000;
const TICK = 30_000;

/** A watchdog on a fake clock: `working` and `frames` are what the daemon would answer. */
function setup(thresholdMs = 10 * MIN) {
  const state = { now: 1_000_000, working: new Set<string>(), frames: new Map<string, number>() };
  const changes: StallChange[] = [];
  const deps: StallDeps = {
    listWorking: () => [...state.working].map((id) => ({ id })),
    lastFrameAt: (id) => state.frames.get(id),
    now: () => state.now,
    thresholdMs,
    onChange: (c) => changes.push(c),
  };
  const dog = new StallWatchdog(deps);
  /** Advance the clock in 30 s ticks, as the daemon's scheduler tick does. */
  const run = (ms: number) => { for (let t = 0; t < ms; t += TICK) { state.now += TICK; dog.tick(); } };
  return { state, changes, dog, run, deps };
}

describe('StallWatchdog', () => {
  it('flags a working thread with no frame for longer than the threshold', () => {
    const { state, changes, dog, run } = setup();
    state.working.add('t1');
    dog.tick(); // first sight: the baseline is now
    const seenAt = state.now;
    run(10 * MIN); // exactly the threshold: not longer
    expect(dog.get('t1')).toBeNull();
    run(TICK);
    expect(dog.get('t1')).toEqual({ terminalId: 't1', stalledSince: seenAt, lastFrameAt: null });
    expect(dog.all()).toEqual([{ terminalId: 't1', stalledSince: seenAt, lastFrameAt: null }]);
    expect(changes).toEqual([{ terminalId: 't1', stalledSince: seenAt }]);
  });

  it('flags a working thread with no frame (regression: stale working status)', () => {
    // The old daemon had no check at all: a thread stayed "working" for ever with no sign.
    const { state, dog, run } = setup();
    state.working.add('t1');
    state.frames.set('t1', state.now); // one frame, then silence
    const frameAt = state.now;
    dog.tick();
    run(11 * MIN);
    expect(dog.get('t1')).toEqual({ terminalId: 't1', stalledSince: frameAt, lastFrameAt: frameAt });
  });

  it('measures from the start of the turn when the last frame is from an earlier turn', () => {
    const { state, dog, run } = setup();
    state.frames.set('t1', state.now - 60 * MIN); // the last turn ended an hour ago
    state.working.add('t1'); // a new turn starts now
    dog.tick();
    run(5 * MIN);
    expect(dog.get('t1')).toBeNull();
  });

  it('does not flag an idle thread', () => {
    const { state, changes, dog, run } = setup();
    state.frames.set('idle', state.now); // it has an old frame, but it is not in the working list
    dog.tick();
    run(30 * MIN);
    expect(dog.get('idle')).toBeNull();
    expect(dog.all()).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('clears the flag when a frame arrives', () => {
    const { state, changes, dog, run } = setup();
    state.working.add('t1');
    dog.tick();
    run(11 * MIN);
    expect(dog.get('t1')).not.toBeNull();
    state.frames.set('t1', state.now + 1);
    run(TICK);
    expect(dog.get('t1')).toBeNull();
    expect(changes.at(-1)).toEqual({ terminalId: 't1', stalledSince: null });
  });

  it('clears the flag when the thread stops working', () => {
    const { state, changes, dog, run } = setup();
    state.working.add('t1');
    dog.tick();
    run(11 * MIN);
    state.working.delete('t1');
    run(TICK);
    expect(dog.get('t1')).toBeNull();
    expect(changes.at(-1)).toEqual({ terminalId: 't1', stalledSince: null });
  });

  it('emits one change per edge, not one per tick', () => {
    const { state, changes, dog, run } = setup();
    state.working.add('t1');
    dog.tick();
    run(30 * MIN); // flagged once, then 40 more ticks
    expect(changes).toHaveLength(1);
    state.frames.set('t1', state.now);
    run(5 * MIN);
    expect(changes).toHaveLength(2);
    expect(changes.map((c) => c.stalledSince === null)).toEqual([false, true]);
  });

  it('a tick gap over 90 s resets the baselines and flags nothing', () => {
    const { state, changes, dog, run } = setup();
    state.working.add('t1');
    state.frames.set('t1', state.now);
    dog.tick();
    run(5 * MIN);
    state.now += 8 * 60 * MIN; // the Mac slept for 8 hours
    dog.tick();
    expect(dog.all()).toEqual([]);
    expect(changes).toEqual([]);
    // The count starts again at the wake: 9 minutes later is still under the threshold.
    run(9 * MIN);
    expect(dog.all()).toEqual([]);
    // More than the threshold after the wake, it is flagged, from the wake time.
    run(2 * MIN);
    expect(dog.get('t1')).not.toBeNull();
  });

  it('a tick gap over 90 s keeps a flag that was set before it', () => {
    const { state, changes, dog, run } = setup();
    state.working.add('t1');
    dog.tick();
    run(11 * MIN);
    expect(changes).toHaveLength(1);
    state.now += 60 * MIN;
    dog.tick();
    run(2 * MIN);
    expect(dog.get('t1')).not.toBeNull();
    expect(changes).toHaveLength(1);
  });

  it('never calls a kill, stop or status function', () => {
    // The deps are all the watchdog can reach: two reads, a clock, a number and one report.
    const { deps, state, run, dog } = setup();
    expect(Object.keys(deps).sort()).toEqual(['lastFrameAt', 'listWorking', 'now', 'onChange', 'thresholdMs']);
    // Compile-time: StallDeps has no other key (a kill, stop or status function would be one).
    const exact: Exclude<keyof StallDeps, 'lastFrameAt' | 'listWorking' | 'now' | 'onChange' | 'thresholdMs'> extends never ? true : false = true;
    expect(exact).toBe(true);
    // Run time: a deps object that throws on any other property is never touched.
    const strict = new Proxy(deps, { get(t, k) { if (!(k in t)) throw new Error(`unexpected dep ${String(k)}`); return (t as any)[k]; } });
    const guarded = new StallWatchdog(strict);
    state.working.add('t1');
    guarded.tick();
    for (let i = 0; i < 30; i++) { state.now += TICK; guarded.tick(); }
    expect(guarded.get('t1')).not.toBeNull();
    void run; void dog;
  });

  it('a throw in onChange does not stop the other threads', () => {
    const { state, dog, run, deps } = setup();
    let calls = 0;
    deps.onChange = () => { calls++; throw new Error('broadcast failed'); };
    state.working.add('a'); state.working.add('b');
    dog.tick();
    run(11 * MIN);
    expect(calls).toBe(2);
    expect(dog.all().map((s) => s.terminalId).sort()).toEqual(['a', 'b']);
  });
});

describe('stallThresholdMs', () => {
  it('is 10 minutes by default and DISPATCH_STALL_MINUTES overrides it', () => {
    expect(stallThresholdMs({})).toBe(10 * MIN);
    expect(stallThresholdMs({ DISPATCH_STALL_MINUTES: '1' })).toBe(MIN);
    expect(stallThresholdMs({ DISPATCH_STALL_MINUTES: '2.5' })).toBe(2.5 * MIN);
    expect(stallThresholdMs({ DISPATCH_STALL_MINUTES: 'abc' })).toBe(10 * MIN);
    expect(stallThresholdMs({ DISPATCH_STALL_MINUTES: '0' })).toBe(10 * MIN);
    expect(stallThresholdMs({ DISPATCH_STALL_MINUTES: '-3' })).toBe(10 * MIN);
  });
});
