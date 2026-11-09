// W2-G: "why is this thread in this state". One test per rule of explainThread, a pure function.
import { describe, it, expect } from 'vitest';
import { explainThread, toDeliveryInfo, toParkInfo, threadStatusOf, formatDuration, type ExplainInput, type DeliveryInfo } from './explain.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 60 * MIN;

const input = (over: Partial<ExplainInput> = {}): ExplainInput => ({
  status: 'idle', turnOpen: false, processAlive: true, transport: 'structured',
  lastEvents: [], stall: null, park: null, pendingQuestion: false, deliveries: [], now: NOW, ...over,
});
const actions = (e: { nextSteps: { action: string }[] }) => e.nextSteps.map((s) => s.action);
const delivery = (over: Partial<DeliveryInfo> = {}): DeliveryInfo => ({
  id: 1, direction: 'from', peerId: 'coord-1', peerLabel: null, kind: 'notice', state: 'pending', attempts: 1,
  lastError: null, createdAt: '2026-11-09T11:50:00.000Z', deliveredAt: null, ...over,
});
const park = (over: Record<string, unknown> = {}) => ({
  state: 'parked' as const, provider: 'claude-code', kind: 'session', resetsAt: NOW + 2 * HOUR + 5 * MIN,
  wakeAt: NOW + 2 * HOUR + 6 * MIN, attempts: 0, parkedAt: NOW - 30 * MIN, ...over,
});

describe('explainThread: working', () => {
  it('a working thread with a live process says that a turn is in progress and offers no step', () => {
    const e = explainThread(input({ status: 'working', turnOpen: true, processAlive: true }));
    expect(e.rule).toBe('working');
    expect(e.headline).toBe('Working: a turn is in progress');
    expect(e.reasons).toContain('The process of the thread is alive.');
    expect(e.nextSteps).toEqual([]);
  });

  it('a working thread with a dead process says that the process ended and offers Reset status', () => {
    const e = explainThread(input({ status: 'working', turnOpen: true, processAlive: false }));
    expect(e.rule).toBe('working-dead-process');
    expect(e.headline).toBe('Working, but the process ended');
    expect(e.reasons.join(' ')).toContain('no process runs for this thread');
    expect(e.nextSteps[0]).toEqual({ label: 'Reset status', action: 'reset-status' });
    expect(actions(e)).toEqual(['reset-status', 'restart']);
  });

  it('a dead process wins over a stall flag', () => {
    const e = explainThread(input({ status: 'working', processAlive: false, stall: { terminalId: 't', stalledSince: NOW - 20 * MIN, lastFrameAt: null } }));
    expect(e.rule).toBe('working-dead-process');
  });

  it('a stalled thread says that it only flags', () => {
    const since = NOW - 14 * MIN;
    const e = explainThread(input({ status: 'working', turnOpen: true, stall: { terminalId: 't', stalledSince: since, lastFrameAt: since } }));
    expect(e.rule).toBe('working-stalled');
    expect(e.headline).toBe('Working, but silent for 14 min');
    expect(e.since).toBe(new Date(since).toISOString());
    expect(e.reasons).toContain('The watchdog only flags the thread. It does not stop the process and it does not change the status.');
    expect(e.reasons.join(' ')).toContain('A long tool call or a slow model can be the cause');
    expect(actions(e)).toEqual(['restart', 'reset-status']);
  });

  it('a stalled thread that sent no output at all says so', () => {
    const e = explainThread(input({ status: 'working', stall: { terminalId: 't', stalledSince: NOW - 11 * MIN, lastFrameAt: null } }));
    expect(e.reasons.join(' ')).toContain('sent no output since Dispatch started');
  });

  it('a working structured thread with no open turn says that the status can be stale and offers Reset status', () => {
    const e = explainThread(input({ status: 'working', turnOpen: false, processAlive: true, transport: 'structured' }));
    expect(e.rule).toBe('working-no-open-turn');
    expect(e.headline).toBe('Working, but no turn is open');
    expect(actions(e)).toEqual(['reset-status']);
  });

  it('a working CLI thread with no open turn is a plain working thread (the CLI records no turn)', () => {
    const e = explainThread(input({ status: 'working', turnOpen: false, processAlive: true, transport: 'pty' }));
    expect(e.rule).toBe('working');
  });

  it('a working Pretty thread whose turn flag is not kept (null) is a plain working thread', () => {
    expect(explainThread(input({ status: 'working', turnOpen: null, processAlive: true })).rule).toBe('working');
  });

  it('a working thread whose process state is not known gives the plain working headline and says that it is not known', () => {
    const e = explainThread(input({ status: 'working', turnOpen: true, processAlive: null }));
    expect(e.rule).toBe('working');
    expect(e.reasons).toContain('Dispatch could not read the process state of the thread.');
  });
});

describe('explainThread: waiting and idle', () => {
  it('an input with no special condition gives a plain headline and no next step', () => {
    const e = explainThread(input());
    expect(e.rule).toBe('idle');
    expect(e.headline).toBe('Waiting for your next message');
    expect(e.nextSteps).toEqual([]);
  });

  it('an idle thread with no process says that the next message starts it', () => {
    const e = explainThread(input({ processAlive: false }));
    expect(e.rule).toBe('idle');
    expect(e.reasons).toContain('No process runs for this thread. The next message starts it.');
    expect(e.nextSteps).toEqual([]);
  });

  it('an idle thread with a pending notice names the target', () => {
    const e = explainThread(input({ deliveries: [delivery({ peerId: 'coord-1', peerLabel: 'Control Plane' })] }));
    expect(e.rule).toBe('idle-pending-delivery');
    expect(e.headline).toBe('Waiting, with 1 notice that is not delivered');
    expect(e.reasons.join(' ')).toContain('A notice for the thread "Control Plane" (coord-1) waits');
    expect(e.reasons.join(' ')).toContain('Dispatch delivers it when that thread runs again');
    expect(e.nextSteps).toEqual([]);
  });

  it('an idle thread with a notice that waits for it names the sender', () => {
    const e = explainThread(input({ processAlive: false, deliveries: [delivery({ direction: 'to', peerId: 'worker-9', peerLabel: null })] }));
    expect(e.rule).toBe('idle-pending-delivery');
    expect(e.reasons.join(' ')).toContain('A notice from the thread worker-9 waits for this thread');
  });

  it('a delivered or dropped notice does not change the headline; a dropped one is a reason', () => {
    const e = explainThread(input({ deliveries: [delivery({ state: 'delivered' }), delivery({ id: 2, state: 'dropped', lastError: 'target archived' })] }));
    expect(e.rule).toBe('idle');
    expect(e.reasons.join(' ')).toContain('was dropped: target archived');
  });

  it('a done thread says that the process ended normally', () => {
    const e = explainThread(input({ status: 'done', processAlive: false }));
    expect(e.rule).toBe('done');
    expect(e.headline).toBe('Done: the process ended normally');
    expect(e.nextSteps).toEqual([]);
  });

  it('a starting thread says that the process starts', () => {
    const e = explainThread(input({ status: 'starting' }));
    expect(e.rule).toBe('starting');
    expect(e.headline).toBe('Starting: the process of the thread starts');
  });
});

describe('explainThread: needs input', () => {
  it('needs input with a live process and an open question says to answer in the thread', () => {
    const e = explainThread(input({ status: 'needs_input', turnOpen: true, pendingQuestion: true }));
    expect(e.rule).toBe('needs-input-question');
    expect(e.headline).toBe('Needs input: the thread waits for your answer');
    expect(e.nextSteps).toEqual([]);
  });

  it('needs input with a restored question says that the question was kept and that an answer starts the thread', () => {
    const e = explainThread(input({ status: 'needs_input', pendingQuestion: true, processAlive: false }));
    expect(e.rule).toBe('needs-input-restored-question');
    expect(e.headline).toBe('Needs input: the question was kept across a restart');
    expect(e.reasons.join(' ')).toContain('Your answer starts the thread again');
    expect(e.nextSteps).toEqual([]);
  });

  it('needs input with a dead process and no saved question offers Reset status and Restart', () => {
    const e = explainThread(input({ status: 'needs_input', pendingQuestion: false, processAlive: false }));
    expect(e.rule).toBe('needs-input-dead-process');
    expect(e.headline).toBe('Needs input, but the process ended');
    expect(actions(e)).toEqual(['reset-status', 'restart']);
  });

  it('needs input on a CLI thread with no recorded question points at the terminal', () => {
    const e = explainThread(input({ status: 'needs_input', transport: 'pty' }));
    expect(e.rule).toBe('needs-input-cli');
    expect(e.reasons.join(' ')).toContain('in its terminal');
    expect(actions(e)).toEqual(['reset-status']);
  });

  it('needs input on a Pretty thread with no recorded question offers Reset status', () => {
    const e = explainThread(input({ status: 'needs_input', transport: 'structured' }));
    expect(e.rule).toBe('needs-input-no-question');
    expect(actions(e)).toEqual(['reset-status']);
  });
});

describe('explainThread: error', () => {
  it('an error with a dead process says that the process ended and offers Restart first', () => {
    const e = explainThread(input({ status: 'error', processAlive: false }));
    expect(e.rule).toBe('error-dead-process');
    expect(e.headline).toBe('Error: the process ended with an error');
    expect(actions(e)).toEqual(['restart', 'reset-status']);
  });

  it('an error with a live process says that the last turn failed', () => {
    const e = explainThread(input({ status: 'error', processAlive: true }));
    expect(e.rule).toBe('error');
    expect(e.headline).toBe('Error: the last turn failed');
    expect(actions(e)).toEqual(['reset-status', 'restart']);
  });
});

describe('explainThread: parked on a limit', () => {
  it('a parked thread names the reset time', () => {
    const e = explainThread(input({ status: 'idle', park: park() }));
    expect(e.rule).toBe('parked-limit');
    expect(e.headline).toBe('Paused on a usage limit until 2026-11-09 14:05 UTC');
    expect(e.since).toBe(new Date(NOW - 30 * MIN).toISOString());
    expect(e.reasons.join(' ')).toContain('The session limit of claude-code stopped the thread');
    expect(e.reasons.join(' ')).toContain('in 2 h 6 min');
    expect(actions(e)).toEqual(['open-usage']);
  });

  it('a parked thread with no read reset time names the next try', () => {
    const e = explainThread(input({ park: park({ resetsAt: null, wakeAt: NOW + 15 * MIN }) }));
    expect(e.headline).toBe('Paused on a usage limit; the reset time is not known');
    expect(e.reasons.join(' ')).toContain('Dispatch tries again at 2026-11-09 12:15 UTC');
  });

  it('a parked thread in the error status is still explained by the limit', () => {
    expect(explainThread(input({ status: 'error', processAlive: false, park: park() })).rule).toBe('parked-limit');
  });

  it('a thread that Dispatch gave up on says that Dispatch does not try again', () => {
    const e = explainThread(input({ park: park({ state: 'capped', attempts: 3 }) }));
    expect(e.rule).toBe('capped-limit');
    expect(e.headline).toBe('Stopped on a usage limit');
    expect(e.reasons.join(' ')).toContain('Dispatch tried 3 times and does not try again');
    expect(actions(e)).toEqual(['open-usage']);
  });

  it('a working thread is not explained by an old park row; a resumed thread says that Dispatch resumed it', () => {
    const e = explainThread(input({ status: 'working', turnOpen: true, park: park({ state: 'woken', attempts: 1 }) }));
    expect(e.rule).toBe('working');
    expect(e.reasons.join(' ')).toContain('Dispatch resumed this thread after a usage limit');
    expect(explainThread(input({ status: 'working', turnOpen: true, park: park() })).rule).toBe('working');
  });
});

describe('explainThread: queued and scheduled', () => {
  it('a queued thread says that it did not start', () => {
    const e = explainThread(input({ status: 'queued', processAlive: false }));
    expect(e.rule).toBe('queued');
    expect(e.headline).toBe('Queued: the thread did not start yet');
    expect(e.reasons.join(' ')).toContain('holds its task and has no process');
    expect(e.nextSteps).toEqual([]);
  });

  it('a scheduled thread with a live process waits for its wake', () => {
    const e = explainThread(input({ status: 'scheduled' }));
    expect(e.rule).toBe('scheduled');
    expect(e.headline).toBe('Scheduled: the thread waits for a wake that it set');
    expect(e.nextSteps).toEqual([]);
  });

  it('a scheduled thread with a dead process says that the wake cannot fire and offers Restart', () => {
    const e = explainThread(input({ status: 'scheduled', processAlive: false }));
    expect(e.rule).toBe('scheduled-dead-process');
    expect(e.headline).toBe('Scheduled, but the process ended');
    expect(actions(e)).toEqual(['restart', 'reset-status']);
  });
});

describe('explainThread: since and the last event', () => {
  const ev = (event_type: string, observed_at: string, status: string, disposition = 'applied') => ({ event_type, generation: null, turn_id: null, observed_at, status, disposition });

  it('since is the oldest event of the newest run of events with the current status', () => {
    // Newest first, as the route gives them.
    const e = explainThread(input({ status: 'working', turnOpen: true, lastEvents: [
      ev('status.working', '2026-11-09T11:58:00.000Z', 'working'),
      ev('turn.started', '2026-11-09T11:55:00.000Z', 'working'),
      ev('turn.completed', '2026-11-09T11:40:00.000Z', 'waiting'),
      ev('turn.started', '2026-11-09T11:30:00.000Z', 'working'),
    ] }));
    expect(e.since).toBe('2026-11-09T11:55:00.000Z');
    expect(e.reasons).toContain('The last lifecycle event was status.working, 2 min ago.');
  });

  it('since is null when there is no event', () => {
    expect(explainThread(input()).since).toBeNull();
  });

  it('a rejected last event is named with its disposition', () => {
    const e = explainThread(input({ lastEvents: [ev('turn.completed', '2026-11-09T11:59:30.000Z', 'waiting', 'turn-already-closed')] }));
    expect(e.reasons).toContain('The last lifecycle event was turn.completed (not applied: turn-already-closed), under 1 min ago.');
  });
});

describe('helpers', () => {
  it('formatDuration', () => {
    expect(formatDuration(20_000)).toBe('under 1 min');
    expect(formatDuration(14 * MIN + 59_000)).toBe('14 min');
    expect(formatDuration(2 * HOUR + 5 * MIN)).toBe('2 h 5 min');
    expect(formatDuration(3 * HOUR)).toBe('3 h');
    expect(formatDuration(50 * HOUR)).toBe('2 d 2 h');
  });

  it('threadStatusOf maps the stored terminal status to a thread status', () => {
    expect(threadStatusOf('working', null)).toBe('working');
    expect(threadStatusOf('waiting', null)).toBe('idle');
    expect(threadStatusOf('waiting', 'done')).toBe('done');
    expect(threadStatusOf('waiting', 'starting')).toBe('starting');
    expect(threadStatusOf('waiting', 'working')).toBe('idle'); // the terminal row is what the owner sees
    expect(threadStatusOf('needs_input', 'working')).toBe('needs_input');
    expect(threadStatusOf('queued', null)).toBe('queued');
    expect(threadStatusOf('scheduled', null)).toBe('scheduled');
    expect(threadStatusOf('error', null)).toBe('error');
    expect(threadStatusOf('something-new', null)).toBe('idle');
  });

  it('toDeliveryInfo reads an outbox row in either naming and never keeps the body', () => {
    const snake = toDeliveryInfo({ id: 7, target_terminal_id: 'me', source_terminal_id: 'w1', kind: 'notice', body: 'secret text', dedup_key: 'k', state: 'pending', attempts: 2, last_error: 'not-alive', created_at: 'c', delivered_at: null }, 'me');
    expect(snake).toEqual({ id: 7, direction: 'to', peerId: 'w1', peerLabel: null, kind: 'notice', state: 'pending', attempts: 2, lastError: 'not-alive', createdAt: 'c', deliveredAt: null });
    const camel = toDeliveryInfo({ id: 8, targetId: 'coord', sourceId: 'me', kind: 'watch', body: 'secret text', state: 'delivered', attempts: 1, deliveredAt: 'd' }, 'me', (id) => (id === 'coord' ? 'Control Plane' : null));
    expect(camel).toMatchObject({ id: 8, direction: 'from', peerId: 'coord', peerLabel: 'Control Plane', state: 'delivered', deliveredAt: 'd' });
    expect(JSON.stringify([snake, camel])).not.toContain('secret text');
    expect(toDeliveryInfo(null, 'me')).toBeNull();
    expect(toDeliveryInfo({ id: 1 }, 'me')).toBeNull();
  });

  it('toParkInfo reads a park row and leaves the limit message out', () => {
    const row = { terminal_id: 't', provider: 'codex', kind: 'weekly', resets_at: 5, wake_at: 6, message: 'banner text', parsed: 1, attempts: 2, state: 'parked', parked_at: 1, detected_at: 1, cleared_at: null, updated_at: 1 };
    expect(toParkInfo(row)).toEqual({ state: 'parked', provider: 'codex', kind: 'weekly', resetsAt: 5, wakeAt: 6, attempts: 2, parkedAt: 1 });
    expect(toParkInfo(null)).toBeNull();
  });
});
