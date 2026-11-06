import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUsageLimits, acceptSummary } from './usageLimits';
import { api } from '../api/client';
import { resyncAfterReconnect } from '../lib/resync';

const body = { warnPercent: 80, providers: [{ provider: 'claude-code', asOf: 1, windows: { five_hour: { usedPercent: 46, resetsAt: 2 } } }], paused: [] };

beforeEach(() => {
  useUsageLimits.setState({ summary: null, rev: 0, epoch: null, retired: [] } as any);
  vi.restoreAllMocks();
});

describe('useUsageLimits', () => {
  it('loads the summary', async () => {
    vi.spyOn(api, 'getUsageSummary').mockResolvedValue({ ...body, type: 'usage-limits' } as any);
    await useUsageLimits.getState().load();
    expect(useUsageLimits.getState().summary).toEqual(body);
  });

  it('a failed load keeps what is there', async () => {
    useUsageLimits.setState({ summary: body });
    vi.spyOn(api, 'getUsageSummary').mockRejectedValue(new Error('404'));
    await useUsageLimits.getState().load();
    expect(useUsageLimits.getState().summary).toEqual(body);
  });

  it('applies a usage-limits event and ignores others or a malformed one', () => {
    useUsageLimits.getState().applyEvent({ type: 'preview:new' });
    expect(useUsageLimits.getState().summary).toBeNull();
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', warnPercent: 'x', providers: [], paused: [] });
    expect(useUsageLimits.getState().summary).toBeNull();
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...body, warnPercent: 90 });
    expect(useUsageLimits.getState().summary).toEqual({ ...body, warnPercent: 90 });
  });

  it('a slow GET answered after a newer event does not undo it', async () => {
    let resolveGet!: (v: unknown) => void;
    vi.spyOn(api, 'getUsageSummary').mockReturnValue(new Promise((r) => { resolveGet = r; }) as any);
    const loading = useUsageLimits.getState().load();
    // A pause event (built at 200) arrives while the GET (built at 100) is still in flight.
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...body, at: 200, paused: [{ provider: 'claude-code' }] });
    resolveGet({ ...body, type: 'usage-limits', at: 100, paused: [] });
    await loading;
    expect(useUsageLimits.getState().summary?.paused).toHaveLength(1);
  });

  it('an older event does not undo a newer GET; a newer one wins', async () => {
    vi.spyOn(api, 'getUsageSummary').mockResolvedValue({ ...body, type: 'usage-limits', at: 300, warnPercent: 70 } as any);
    await useUsageLimits.getState().load();
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...body, at: 250, warnPercent: 99 });
    expect(useUsageLimits.getState().summary?.warnPercent).toBe(70);
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...body, at: 301, warnPercent: 85 });
    expect(useUsageLimits.getState().summary?.warnPercent).toBe(85);
  });

  it('a body with no stamp (an older daemon) is always applied', () => {
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...body, at: 500 });
    useUsageLimits.getState().applyEvent({ type: 'usage-limits', ...body, warnPercent: 60 });
    expect(useUsageLimits.getState().summary?.warnPercent).toBe(60);
  });

  it('reloads on a reconnect', async () => {
    const load = vi.spyOn(api, 'getUsageSummary').mockResolvedValue(body as any);
    await resyncAfterReconnect();
    expect(load).toHaveBeenCalledTimes(1);
    expect(useUsageLimits.getState().summary).toEqual(body);
  });
});

// Every ordering probe the reviewers ran against #131, as one table. Each step is a socket event,
// a load starting, a load answering, or a load failing. `warn` marks which summary is shown.
type Step =
  | { ev: [epoch: string | null, rev: number | null, warn: number] }
  | { start: string }
  | { answer: [load: string, epoch: string | null, rev: number | null, warn: number] }
  | { fail: string };
interface Case { name: string; steps: Step[]; warn: number | null; epoch?: string | null; rev?: number }

// With no epoch, the rev is sent as `at`, as a 3.12 to 3.17 daemon does.
const msg = (epoch: string | null, rev: number | null, warn: number) => ({
  type: 'usage-limits' as const, ...body, warnPercent: warn, ...(epoch === null ? {} : { epoch }), ...(rev === null ? {} : epoch === null ? { at: rev } : { rev }),
});

const CASES: Case[] = [
  { name: 'GET older than a socket event in one epoch is dropped',
    steps: [{ start: 'a' }, { ev: ['e', 20, 90] }, { answer: ['a', 'e', 10, 70] }], warn: 90, rev: 20 },
  { name: 'GET newer than a socket event in one epoch lands, then an older event is dropped',
    steps: [{ ev: ['e', 5, 60] }, { start: 'a' }, { answer: ['a', 'e', 30, 70] }, { ev: ['e', 25, 50] }], warn: 70, rev: 30 },
  { name: 'overlapping loads: A answers late and is superseded, B fails, the event stays',
    steps: [{ start: 'A' }, { ev: ['e', 20, 90] }, { start: 'B' }, { answer: ['A', 'e', 10, 70] }, { fail: 'B' }], warn: 90, epoch: 'e', rev: 20 },
  { name: 'a superseded load with a higher rev is dropped',
    steps: [{ start: 'A' }, { start: 'B' }, { answer: ['B', 'e', 40, 75] }, { answer: ['A', 'e', 50, 60] }], warn: 75, rev: 40 },
  { name: 'boot GET to A, A restarts, reconnect GET to B with no epoch held, A answers first: B lands',
    steps: [{ start: 'boot' }, { start: 'reconnect' }, { answer: ['boot', 'A', 900, 70] }, { answer: ['reconnect', 'B', 5, 85] }], warn: 85, epoch: 'B', rev: 5 },
  { name: 'a superseded load with no rev is dropped',
    steps: [{ start: 'A' }, { start: 'B' }, { answer: ['B', null, null, 75] }, { answer: ['A', null, null, 60] }], warn: 75, epoch: null },
  { name: 'startup: the first GET reaches A, A restarts, B arrives by socket, A answers late: B stays',
    steps: [{ start: 'g' }, { ev: ['B', 5, 85] }, { answer: ['g', 'A', 900, 70] }, { ev: ['B', 6, 88] }], warn: 88, epoch: 'B', rev: 6 },
  { name: 'startup: a GET started before the first event, answered by that same epoch with a newer rev, lands',
    steps: [{ start: 'g' }, { ev: ['B', 5, 85] }, { answer: ['g', 'B', 9, 70] }, { ev: ['B', 8, 50] }], warn: 70, epoch: 'B', rev: 9 },
  { name: 'restart after a clock rollback: 1000, then a new epoch GET at 900, then 901 lands, 899 does not',
    steps: [{ ev: ['old', 1000, 60] }, { start: 'a' }, { answer: ['a', 'new', 900, 75] }, { ev: ['new', 901, 85] }, { ev: ['new', 899, 50] }], warn: 85, epoch: 'new', rev: 901 },
  { name: 'restart: the new daemon\'s first socket event lands before any reload',
    steps: [{ ev: ['old', 1000, 60] }, { ev: ['new', 901, 85] }], warn: 85, epoch: 'new', rev: 901 },
  { name: 'old-epoch GET after a new-epoch event is dropped, and A stays retired',
    steps: [{ ev: ['A', 1000, 60] }, { start: 'g' }, { ev: ['B', 900, 85] }, { answer: ['g', 'A', 2000, 70] }, { ev: ['A', 3000, 50] }, { ev: ['B', 901, 88] }], warn: 88, epoch: 'B', rev: 901 },
  { name: 'A to B to C with late A and B answers: C stays',
    steps: [{ ev: ['A', 1, 60] }, { start: 'a' }, { ev: ['B', 1, 70] }, { start: 'b' }, { ev: ['C', 1, 80] }, { answer: ['a', 'A', 9, 61] }, { answer: ['b', 'B', 9, 71] }], warn: 80, epoch: 'C', rev: 1 },
  { name: 'A to B to C, a late B answer from the newest load is still dropped',
    steps: [{ ev: ['A', 1, 60] }, { ev: ['B', 1, 70] }, { start: 'b' }, { ev: ['C', 1, 80] }, { answer: ['b', 'B', 9, 71] }], warn: 80, epoch: 'C' },
  { name: 'first load with no event lands',
    steps: [{ start: 'a' }, { answer: ['a', 'A', 20, 75] }], warn: 75, epoch: 'A', rev: 20 },
  { name: 'first load with an earlier same-epoch event: the newer GET lands',
    steps: [{ start: 'a' }, { ev: ['A', 10, 60] }, { answer: ['a', 'A', 20, 75] }], warn: 75, epoch: 'A', rev: 20 },
  { name: 'a late legacy GET (no epoch, no rev) after a real epoch is dropped, and B keeps landing',
    steps: [{ start: 'g' }, { ev: ['B', 900, 85] }, { answer: ['g', null, null, 70] }, { ev: ['B', 901, 88] }], warn: 88, epoch: 'B', rev: 901 },
  { name: 'a legacy socket event after a real epoch is dropped and retires nothing',
    steps: [{ ev: ['B', 900, 85] }, { ev: [null, null, 70] }, { ev: ['B', 901, 88] }], warn: 88, epoch: 'B', rev: 901 },
  { name: 'a 3.12 to 3.17 daemon (no epoch, only `at`): an older GET after a newer event is dropped',
    steps: [{ start: 'a' }, { ev: [null, 200, 90] }, { answer: ['a', null, 100, 70] }], warn: 90, epoch: null, rev: 200 },
  { name: 'upgrade from an `at`-only daemon: the first real epoch lands even with a smaller rev',
    steps: [{ ev: [null, 5000, 60] }, { ev: ['B', 10, 85] }, { ev: [null, 9000, 70] }], warn: 85, epoch: 'B', rev: 10 },
  { name: 'a daemon without epochs or revisions: every summary lands',
    steps: [{ ev: [null, null, 60] }, { start: 'a' }, { answer: ['a', null, null, 70] }, { ev: [null, null, 80] }], warn: 80, epoch: null },
];

describe('summary ordering', () => {
  it.each(CASES)('$name', async (c) => {
    const pending = new Map<string, { ok: (v: unknown) => void; no: (e: Error) => void; done: Promise<void> }>();
    const spy = vi.spyOn(api, 'getUsageSummary');
    for (const step of c.steps) {
      if ('ev' in step) useUsageLimits.getState().applyEvent(msg(...step.ev));
      else if ('start' in step) {
        let ok!: (v: unknown) => void; let no!: (e: Error) => void;
        spy.mockReturnValueOnce(new Promise((r, j) => { ok = r; no = j; }) as any);
        pending.set(step.start, { ok, no, done: useUsageLimits.getState().load() });
      } else if ('answer' in step) {
        const [id, ...rest] = step.answer;
        pending.get(id)!.ok(msg(...rest));
        await pending.get(id)!.done;
      } else {
        pending.get(step.fail)!.no(new Error('offline'));
        await pending.get(step.fail)!.done;
      }
    }
    const st = useUsageLimits.getState();
    expect(st.summary?.warnPercent ?? null).toBe(c.warn);
    if (c.epoch !== undefined) expect(st.epoch).toBe(c.epoch);
    if (c.rev !== undefined) expect(st.rev).toBe(c.rev);
  });

  it('keeps only a few retired epochs', () => {
    for (let i = 0; i < 20; i++) useUsageLimits.getState().applyEvent(msg(`e${i}`, 1, 60));
    expect(useUsageLimits.getState().retired.length).toBeLessThanOrEqual(8);
    expect(useUsageLimits.getState().retired).toContain('e18');
  });

  it('acceptSummary: the rule on its own', () => {
    const at = (epoch: string | null, rev: number, retired: string[] = []) => ({ epoch, rev, retired });
    expect(acceptSummary(at('A', 10, ['Z']), { epoch: 'Z', rev: 99 })).toBeNull();
    expect(acceptSummary(at('A', 10), { epoch: 'A', rev: 10 })).toBeNull();
    expect(acceptSummary(at('A', 10), { epoch: 'A', rev: 11 })).toEqual(at('A', 11));
    expect(acceptSummary(at(null, 0), { epoch: 'A', rev: 5 })).toEqual(at('A', 5));
    expect(acceptSummary(at('A', 10), { epoch: 'B', rev: 3 })).toEqual(at('B', 3, ['A']));
    expect(acceptSummary(at('A', 10), { epoch: null, rev: null })).toBeNull();
    expect(acceptSummary(at(null, 0), { epoch: null, rev: null })).toEqual(at(null, 0));
  });
});
