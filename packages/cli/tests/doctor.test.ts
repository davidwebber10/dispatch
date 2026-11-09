// W2-G: `dispatch doctor <thread id>` prints why a thread is in its state, from
// GET /api/terminals/:id/diagnostics. One output test for each state that the route explains.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { runCommand } from '../src/index.js';
import { formatDoctor } from '../src/doctor.js';

const THREAD_KEY = `dtk_${'T'.repeat(43)}`;
let out: string[];
beforeEach(() => {
  out = [];
  // The test may run inside a Dispatch thread: start from a clean thread environment.
  for (const n of ['DISPATCH_AUTH', 'DISPATCH_AUTH_FILE', 'DISPATCH_TERMINAL_ID', 'DISPATCH_TERMINAL', 'DISPATCH_API']) vi.stubEnv(n, '');
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const res = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  json: async () => body,
});
const ev = (event_type: string, observed_at: string, status: string, disposition = 'applied') => ({ event_type, generation: null, turn_id: null, observed_at, status, disposition });
const RESET = { label: 'Reset status', action: 'reset-status' };
const RESTART = { label: 'Restart thread', action: 'restart' };
const USAGE = { label: 'Open usage limits', action: 'open-usage' };

/** A diagnostics answer. `over` sets the state under test. */
function answer(over: Record<string, unknown> = {}) {
  return {
    lifecycle: null, captureFailure: null,
    events: [ev('status.working', '2026-11-09T11:58:00.000Z', 'working'), ev('turn.completed', '2026-11-09T11:40:10.000Z', 'waiting', 'turn-already-closed')],
    status: 'working', transport: 'structured', turnOpen: true,
    process: { alive: true, transport: 'structured' }, stall: null, park: null, pendingQuestion: null, deliveries: [],
    explanation: { rule: 'working', headline: 'Working: a turn is in progress', since: '2026-11-09T11:58:00.000Z', reasons: ['The process of the thread is alive.'], nextSteps: [] },
    ...over,
  };
}

async function doctor(body: unknown, args: string[] = ['t-1'], status = 200) {
  const apiFetch = vi.fn(async (_url: string, _init?: RequestInit) => res(status, body));
  await runCommand(['doctor', ...args], { daemon: {} as any, port: 4127, processEnv: {}, readOwnerToken: () => 'owner-tok', apiFetch } as any);
  return { text: out.join('\n'), apiFetch };
}

describe('dispatch doctor: the request', () => {
  test('it reads the diagnostics route of the thread on the PORT daemon, with the owner token in a header', async () => {
    const { apiFetch } = await doctor(answer());
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe('http://localhost:4127/api/terminals/t-1/diagnostics');
    expect(((apiFetch.mock.calls[0][1] as RequestInit).headers as Record<string, string>).Authorization).toBe('Bearer owner-tok');
    expect((apiFetch.mock.calls[0][1] as RequestInit).method ?? 'GET').toBe('GET');
  });

  test('the thread id is encoded in the path', async () => {
    const { apiFetch } = await doctor(answer(), ['a/b c']);
    expect(apiFetch.mock.calls[0][0]).toBe('http://localhost:4127/api/terminals/a%2Fb%20c/diagnostics');
  });

  test('no thread id gives the usage line and no request', async () => {
    const apiFetch = vi.fn();
    await expect(Promise.resolve(runCommand(['doctor'], { daemon: {} as any, port: 4127, processEnv: {}, readOwnerToken: () => 'o', apiFetch } as any))).rejects.toThrow('usage: dispatch doctor <thread id> [--json]');
    await expect(Promise.resolve(runCommand(['doctor', '--json'], { daemon: {} as any, port: 4127, processEnv: {}, readOwnerToken: () => 'o', apiFetch } as any))).rejects.toThrow(/usage: dispatch doctor/);
    await expect(Promise.resolve(runCommand(['doctor', 't-1', '--what'], { daemon: {} as any, port: 4127, processEnv: {}, readOwnerToken: () => 'o', apiFetch } as any))).rejects.toThrow(/usage: dispatch doctor/);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  test.each([
    ['a dtk_ key', { DISPATCH_AUTH: THREAD_KEY, DISPATCH_API: 'http://127.0.0.1:3456' }],
    ['a key file', { DISPATCH_AUTH_FILE: '/some/file' }],
    ['only a thread marker', { DISPATCH_TERMINAL_ID: 't1' }],
  ])('inside a Dispatch thread (%s) it refuses, sends nothing and reads no owner token', async (_n, env) => {
    const apiFetch = vi.fn();
    const readOwnerToken = vi.fn(() => 'owner-tok');
    await expect(Promise.resolve(runCommand(['doctor', 't-1'], { daemon: {} as any, port: 4127, processEnv: env, readOwnerToken, apiFetch } as any)))
      .rejects.toThrow('Run this in your own terminal, not in a Dispatch thread.');
    expect(apiFetch).not.toHaveBeenCalled();
    expect(readOwnerToken).not.toHaveBeenCalled();
  });

  test('a thread that is not known gives one clear line', async () => {
    await expect(doctor({ error: 'Thread not found' }, ['nope'], 404)).rejects.toThrow('Thread not found: nope');
    expect(out).toEqual([]);
  });

  test('another HTTP error names the status', async () => {
    await expect(doctor({ error: 'no' }, ['t-1'], 403)).rejects.toThrow('GET /api/terminals/t-1/diagnostics -> HTTP 403');
  });

  test('a daemon that is not running gives the usual line', async () => {
    const apiFetch = vi.fn(async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
    await expect(Promise.resolve(runCommand(['doctor', 't-1'], { daemon: {} as any, port: 4127, processEnv: {}, readOwnerToken: () => 'o', apiFetch } as any))).rejects.toThrow('daemon not running (dispatch start)');
  });

  test('--json prints the raw answer and nothing else', async () => {
    const body = answer();
    const { text } = await doctor(body, ['t-1', '--json']);
    expect(JSON.parse(text)).toEqual(body);
    const { text: flagFirst } = await (async () => { out = []; return doctor(body, ['--json', 't-1']); })();
    expect(JSON.parse(flagFirst)).toEqual(body);
  });
});

describe('dispatch doctor: the output for each state', () => {
  test('working with a live process', async () => {
    const { text } = await doctor(answer());
    expect(text).toBe([
      'Thread t-1',
      'Status: working    Transport: Pretty    Process: running',
      '',
      'Working: a turn is in progress',
      'Since 2026-11-09 11:58 UTC',
      '',
      'Why:',
      '  - The process of the thread is alive.',
      '',
      'Next steps: none.',
      '',
      'Deliveries: none.',
      '',
      'Last events (newest first):',
      '  TIME (UTC)           EVENT           STATUS   RESULT',
      '  2026-11-09 11:58:00  status.working  working  applied',
      '  2026-11-09 11:40:10  turn.completed  waiting  turn-already-closed',
    ].join('\n'));
  });

  test('working with a dead process: the steps name the commands to run', async () => {
    const { text } = await doctor(answer({
      process: { alive: false, transport: 'structured' },
      explanation: { rule: 'working-dead-process', headline: 'Working, but the process ended', since: null, reasons: ['The status is "working", and no process runs for this thread.', 'No event closed the turn, so the status did not change.'], nextSteps: [RESET, RESTART] },
    }));
    expect(text).toContain('Status: working    Transport: Pretty    Process: not running');
    expect(text).toContain('\nWorking, but the process ended\n');
    expect(text).not.toContain('Since ');
    expect(text).toContain('  - The status is "working", and no process runs for this thread.');
    expect(text).toContain([
      'Next steps:',
      '  - Reset status:    dispatch api POST /api/terminals/t-1/reset-status',
      '  - Restart thread:  dispatch api POST /api/terminals/t-1/relaunch',
    ].join('\n'));
  });

  test('stalled', async () => {
    const { text } = await doctor(answer({
      stall: { stalledSince: '2026-11-09T11:46:00.000Z', lastFrameAt: '2026-11-09T11:46:00.000Z' },
      explanation: { rule: 'working-stalled', headline: 'Working, but silent for 14 min', since: '2026-11-09T11:46:00.000Z', reasons: ['The watchdog only flags the thread. It does not stop the process and it does not change the status.'], nextSteps: [RESTART, RESET] },
    }));
    expect(text).toContain('\nWorking, but silent for 14 min\nSince 2026-11-09 11:46 UTC\n');
    expect(text).toContain('Stall flag: no output since 2026-11-09 11:46 UTC');
    expect(text).toContain('  - The watchdog only flags the thread. It does not stop the process and it does not change the status.');
  });

  test('waiting (idle), on a CLI thread', async () => {
    const { text } = await doctor(answer({
      status: 'idle', transport: 'pty', process: { alive: true, transport: 'pty' },
      explanation: { rule: 'idle', headline: 'Waiting for your next message', since: null, reasons: ['The last turn ended and the thread has no open turn.'], nextSteps: [] },
    }));
    expect(text).toContain('Status: idle    Transport: CLI    Process: running');
    expect(text).toContain('\nWaiting for your next message\n');
    expect(text).toContain('Next steps: none.');
  });

  test('needs input', async () => {
    const { text } = await doctor(answer({
      status: 'needs_input', pendingQuestion: { source: 'saved', toolName: null, question: true, createdAt: '2026-11-09T10:00:00.000Z' }, process: { alive: false, transport: 'structured' },
      explanation: { rule: 'needs-input-restored-question', headline: 'Needs input: the question was kept across a restart', since: null, reasons: ['The question shows in the thread. Your answer starts the thread again.'], nextSteps: [] },
    }));
    expect(text).toContain('Status: needs_input    Transport: Pretty    Process: not running');
    expect(text).toContain('Open question: saved across a restart');
    expect(text).toContain('\nNeeds input: the question was kept across a restart\n');
  });

  test('error', async () => {
    const { text } = await doctor(answer({
      status: 'error', process: { alive: false, transport: 'structured' },
      explanation: { rule: 'error-dead-process', headline: 'Error: the process ended with an error', since: null, reasons: ['r'], nextSteps: [RESTART, RESET] },
    }));
    expect(text).toContain('\nError: the process ended with an error\n');
    expect(text.indexOf('Restart thread:')).toBeLessThan(text.indexOf('Reset status:'));
  });

  test('parked on a limit: the usage step names the place in the app', async () => {
    const { text } = await doctor(answer({
      status: 'idle', park: { state: 'parked', provider: 'claude-code', kind: 'session', resetsAt: Date.parse('2026-11-09T14:05:00.000Z'), wakeAt: Date.parse('2026-11-09T14:06:00.000Z'), attempts: 0, parkedAt: Date.parse('2026-11-09T11:30:00.000Z') },
      explanation: { rule: 'parked-limit', headline: 'Paused on a usage limit until 2026-11-09 14:05 UTC', since: '2026-11-09T11:30:00.000Z', reasons: ['The session limit of claude-code stopped the thread.'], nextSteps: [USAGE] },
    }));
    expect(text).toContain('\nPaused on a usage limit until 2026-11-09 14:05 UTC\nSince 2026-11-09 11:30 UTC\n');
    expect(text).toContain('Usage limit: session limit of claude-code, parked, next try 2026-11-09 14:06 UTC');
    expect(text).toContain('  - Open usage limits:  in the app, open Settings, then Usage limits');
  });

  test('queued', async () => {
    const { text } = await doctor(answer({
      status: 'queued', process: { alive: false, transport: 'structured' }, events: [],
      explanation: { rule: 'queued', headline: 'Queued: the thread did not start yet', since: null, reasons: ['The thread holds its task and has no process.'], nextSteps: [] },
    }));
    expect(text).toContain('Status: queued    Transport: Pretty    Process: not running');
    expect(text).toContain('\nQueued: the thread did not start yet\n');
    expect(text).toContain('Last events: none.');
  });

  test('deliveries are a table with the state, the direction and the peer', async () => {
    const { text } = await doctor(answer({
      status: 'idle',
      deliveries: [
        { id: 2, direction: 'from', peerId: 'coord', peerLabel: 'Control Plane', kind: 'notice', state: 'pending', attempts: 2, lastError: 'not-alive', createdAt: '2026-11-09T10:00:00.000Z', deliveredAt: null },
        { id: 1, direction: 'to', peerId: 'w-9', peerLabel: null, kind: 'watch', state: 'delivered', attempts: 1, lastError: null, createdAt: '2026-11-09T09:00:00.000Z', deliveredAt: '2026-11-09T09:00:01.000Z' },
      ],
      explanation: { rule: 'idle-pending-delivery', headline: 'Waiting, with 1 notice that is not delivered', since: null, reasons: ['A notice for the thread "Control Plane" (coord) waits.'], nextSteps: [] },
    }));
    expect(text).toContain([
      'Deliveries (newest first):',
      '  STATE      DIRECTION  THREAD                 KIND    TRIES  CREATED (UTC)        NOTE',
      '  pending    to         Control Plane (coord)  notice  2      2026-11-09 10:00:00  not-alive',
      '  delivered  from       w-9                    watch   1      2026-11-09 09:00:00',
    ].join('\n'));
  });

  test('only the newest 20 events print, with a line that says how many more exist', () => {
    const events = Array.from({ length: 45 }, (_, n) => ev(`e${n}`, '2026-11-09T11:00:00.000Z', 'working'));
    const text = formatDoctor('t-1', answer({ events }));
    expect(text).toContain('  2026-11-09 11:00:00  e19');
    expect(text).not.toContain('  2026-11-09 11:00:00  e20');
    expect(text).toContain('  (25 older events not shown; --json prints all of them)');
  });

  test('a process state that is not known, and a daemon with no explanation (older than W2-G)', () => {
    expect(formatDoctor('t-1', answer({ process: null }))).toContain('Process: not known');
    const old = formatDoctor('t-1', { lifecycle: null, captureFailure: null, events: [ev('status.working', '2026-11-09T11:58:00.000Z', 'working')] });
    expect(old).toContain('This daemon gave no explanation. Update Dispatch, then restart the daemon.');
    expect(old).toContain('  2026-11-09 11:58:00  status.working  working  applied');
  });

  test('a capture failure is named', () => {
    const text = formatDoctor('t-1', answer({ captureFailure: { terminal_id: 't-1', event_type: 'capture.failed', observed_at: '2026-11-09T11:00:00.000Z', occurrences: 3, reason: 'bad frame' } }));
    expect(text).toContain('Capture failure: bad frame (3 times, last 2026-11-09 11:00 UTC)');
  });
});
