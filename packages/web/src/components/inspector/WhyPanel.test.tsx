// W2-G: the "Why is this thread in this state?" panel. The daemon decides the explanation
// (core status/explain.ts); the panel shows it and runs the next steps through routes that exist.
import { render, screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { vi, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { WhyPanel } from './WhyPanel';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import { useUI } from '../../stores/ui';
import type { ThreadDiagnostics } from '../../api/types';

const ev = (event_type: string, observed_at: string, status: string, disposition = 'applied') => ({ event_type, generation: null, turn_id: null, observed_at, status, disposition });
const RESET = { label: 'Reset status', action: 'reset-status' as const };
const RESTART = { label: 'Restart thread', action: 'restart' as const };
const USAGE = { label: 'Open usage limits', action: 'open-usage' as const };

function diag(over: Partial<ThreadDiagnostics> = {}): ThreadDiagnostics {
  return {
    lifecycle: null, captureFailure: null,
    events: [ev('status.working', '2026-11-09T11:58:00.000Z', 'working'), ev('turn.completed', '2026-11-09T11:40:10.000Z', 'waiting', 'turn-already-closed')],
    status: 'working', transport: 'structured', turnOpen: true,
    process: { alive: true, transport: 'structured' }, stall: null, park: null, pendingQuestion: null, deliveries: [],
    explanation: { rule: 'working', headline: 'Working: a turn is in progress', since: '2026-11-09T11:58:00.000Z', reasons: ['The process of the thread is alive.', 'The last lifecycle event was status.working, 2 min ago.'], nextSteps: [] },
    ...over,
  };
}
const dead = () => diag({
  process: { alive: false, transport: 'structured' },
  explanation: { rule: 'working-dead-process', headline: 'Working, but the process ended', since: null, reasons: ['The status is "working", and no process runs for this thread.', 'No event closed the turn, so the status did not change.'], nextSteps: [RESET, RESTART] },
});

let load: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  load = vi.spyOn(api, 'getThreadDiagnostics');
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('WhyPanel', () => {
  it('shows the headline and the reasons', async () => {
    load.mockResolvedValue(dead());
    render(<WhyPanel terminalId="t1" />);
    expect(await screen.findByRole('heading', { name: 'Working, but the process ended' })).toBeTruthy();
    expect(load).toHaveBeenCalledWith('t1');
    const reasons = within(screen.getByRole('list', { name: 'Reasons' })).getAllByRole('listitem').map((li) => li.textContent);
    expect(reasons).toEqual(['The status is "working", and no process runs for this thread.', 'No event closed the turn, so the status did not change.']);
    expect(screen.getByText('Not running')).toBeTruthy();
    expect(screen.getByText('Pretty')).toBeTruthy();
  });

  it('shows a loading line before the answer comes', async () => {
    let done!: (d: ThreadDiagnostics) => void;
    load.mockReturnValue(new Promise<ThreadDiagnostics>((r) => { done = r; }));
    render(<WhyPanel terminalId="t1" />);
    expect(screen.getByRole('status').textContent).toContain('Reading the thread state');
    done(diag());
    expect(await screen.findByRole('heading', { name: 'Working: a turn is in progress' })).toBeTruthy();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('a next-step button calls the matching API function', async () => {
    load.mockResolvedValueOnce(dead()).mockResolvedValue(diag({ status: 'idle', explanation: { rule: 'idle', headline: 'Waiting for your next message', since: null, reasons: ['The last turn ended and the thread has no open turn.'], nextSteps: [] } }));
    const reset = vi.spyOn(api, 'resetTerminalStatus').mockResolvedValue(undefined);
    const relaunch = vi.spyOn(api, 'relaunchTerminal').mockResolvedValue({ id: 't1', sessionId: 'p1' } as never);
    render(<WhyPanel terminalId="t1" sessionId="p1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset status' }));
    await waitFor(() => expect(reset).toHaveBeenCalledWith('t1'));
    expect(relaunch).not.toHaveBeenCalled();
    // The panel reads the state again after the step, and the list of threads is loaded again.
    expect(await screen.findByRole('heading', { name: 'Waiting for your next message' })).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
    expect(useTabs.getState().loadTabs).toHaveBeenCalledWith('p1');
  });

  it('Restart thread calls the relaunch route', async () => {
    load.mockResolvedValue(dead());
    const reset = vi.spyOn(api, 'resetTerminalStatus').mockResolvedValue(undefined);
    const relaunch = vi.spyOn(api, 'relaunchTerminal').mockResolvedValue({ id: 't1', sessionId: 'p1' } as never);
    render(<WhyPanel terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Restart thread' }));
    await waitFor(() => expect(relaunch).toHaveBeenCalledWith('t1'));
    expect(reset).not.toHaveBeenCalled();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('Open usage limits opens the Settings section and closes the panel; it calls no thread route', async () => {
    load.mockResolvedValue(diag({
      status: 'idle', park: { state: 'parked', provider: 'claude-code', kind: 'session', resetsAt: 1, wakeAt: 2, attempts: 0, parkedAt: 0 },
      explanation: { rule: 'parked-limit', headline: 'Paused on a usage limit until 2026-11-09 14:05 UTC', since: '2026-11-09T11:30:00.000Z', reasons: ['The session limit of claude-code stopped the thread.'], nextSteps: [USAGE] },
    }));
    const requestSettings = vi.spyOn(useUI.getState(), 'requestSettings').mockImplementation(() => {});
    const onClose = vi.fn();
    render(<WhyPanel terminalId="t1" onClose={onClose} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open usage limits' }));
    expect(requestSettings).toHaveBeenCalledWith('usage');
    expect(onClose).toHaveBeenCalled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('a step that fails shows its error inside the panel and keeps the explanation', async () => {
    load.mockResolvedValue(dead());
    vi.spyOn(api, 'resetTerminalStatus').mockRejectedValue(new Error('Status service unavailable'));
    render(<WhyPanel terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset status' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Reset status failed: Status service unavailable');
    expect(screen.getByRole('heading', { name: 'Working, but the process ended' })).toBeTruthy();
  });

  it('shows a load error inside the panel', async () => {
    load.mockRejectedValueOnce(new Error('HTTP 500')).mockResolvedValue(diag());
    render(<WhyPanel terminalId="t1" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read the thread state: HTTP 500');
    expect(screen.queryByRole('heading')).toBeNull();
    // Try again reads once more, inside the same panel.
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Working: a turn is in progress' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an answer with no explanation (an older daemon) says so and still shows the events', async () => {
    load.mockResolvedValue({ lifecycle: null, captureFailure: null, events: [ev('status.working', '2026-11-09T11:58:00.000Z', 'working')] } as unknown as ThreadDiagnostics);
    render(<WhyPanel terminalId="t1" />);
    expect((await screen.findByRole('alert')).textContent).toContain('The daemon gave no explanation');
    expect(screen.getByText('status.working')).toBeTruthy();
  });

  it('Refresh reads the state again', async () => {
    load.mockResolvedValue(diag());
    render(<WhyPanel terminalId="t1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it('shows the last 20 lifecycle events in a table, newest first, and names a result that was not applied', async () => {
    const events = Array.from({ length: 45 }, (_, n) => ev(`event.${n}`, '2026-11-09T11:00:00.000Z', 'working', n === 1 ? 'stale-turn' : 'applied'));
    load.mockResolvedValue(diag({ events }));
    render(<WhyPanel terminalId="t1" />);
    const table = await screen.findByRole('table', { name: 'Last lifecycle events' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(21); // the header and 20 events
    expect(rows[1].textContent).toContain('event.0');
    expect(rows[2].textContent).toContain('stale-turn');
    expect(within(table).queryByText('event.20')).toBeNull();
    expect(screen.getByText('The 20 newest of 45 events.')).toBeTruthy();
  });

  it('shows the deliveries with their state and the other thread', async () => {
    load.mockResolvedValue(diag({
      status: 'idle',
      deliveries: [
        { id: 2, direction: 'from', peerId: 'coord', peerLabel: 'Control Plane', kind: 'notice', state: 'pending', attempts: 2, lastError: 'not-alive', createdAt: '2026-11-09T10:00:00.000Z', deliveredAt: null },
        { id: 1, direction: 'to', peerId: 'w-9', peerLabel: null, kind: 'watch', state: 'delivered', attempts: 1, lastError: null, createdAt: '2026-11-09T09:00:00.000Z', deliveredAt: '2026-11-09T09:00:01.000Z' },
      ],
      explanation: { rule: 'idle-pending-delivery', headline: 'Waiting, with 1 notice that is not delivered', since: null, reasons: ['A notice for the thread "Control Plane" (coord) waits.'], nextSteps: [] },
    }));
    render(<WhyPanel terminalId="t1" />);
    const table = await screen.findByRole('table', { name: 'Deliveries' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1].textContent).toContain('Pending');
    expect(rows[1].textContent).toContain('To Control Plane');
    expect(rows[1].textContent).toContain('not-alive');
    expect(rows[2].textContent).toContain('Delivered');
    expect(rows[2].textContent).toContain('From w-9');
  });

  it('shows no deliveries table when there is none', async () => {
    load.mockResolvedValue(diag());
    render(<WhyPanel terminalId="t1" />);
    await screen.findByRole('heading');
    expect(screen.queryByRole('table', { name: 'Deliveries' })).toBeNull();
  });

  // One fixture for each state that the panel explains.
  it.each([
    ['working with a live process', diag(), 'Working: a turn is in progress', 'Running', []],
    ['working with a dead process', dead(), 'Working, but the process ended', 'Not running', ['Reset status', 'Restart thread']],
    ['stalled', diag({ stall: { stalledSince: '2026-11-09T11:46:00.000Z', lastFrameAt: null }, explanation: { rule: 'working-stalled', headline: 'Working, but silent for 14 min', since: '2026-11-09T11:46:00.000Z', reasons: ['The watchdog only flags the thread. It does not stop the process and it does not change the status.'], nextSteps: [RESTART, RESET] } }), 'Working, but silent for 14 min', 'Running', ['Restart thread', 'Reset status']],
    ['waiting', diag({ status: 'idle', explanation: { rule: 'idle', headline: 'Waiting for your next message', since: null, reasons: ['The last turn ended and the thread has no open turn.'], nextSteps: [] } }), 'Waiting for your next message', 'Running', []],
    ['needs input', diag({ status: 'needs_input', pendingQuestion: { source: 'live', toolName: 'AskUserQuestion', question: true, createdAt: null }, explanation: { rule: 'needs-input-question', headline: 'Needs input: the thread waits for your answer', since: null, reasons: ['The question shows in the thread. The turn continues after your answer.'], nextSteps: [] } }), 'Needs input: the thread waits for your answer', 'Running', []],
    ['error', diag({ status: 'error', process: { alive: false, transport: 'structured' }, explanation: { rule: 'error-dead-process', headline: 'Error: the process ended with an error', since: null, reasons: ['The process of the thread stopped with an error code.'], nextSteps: [RESTART, RESET] } }), 'Error: the process ended with an error', 'Not running', ['Restart thread', 'Reset status']],
    ['parked on a limit', diag({ status: 'idle', park: { state: 'parked', provider: 'claude-code', kind: 'session', resetsAt: 1, wakeAt: 2, attempts: 0, parkedAt: 0 }, explanation: { rule: 'parked-limit', headline: 'Paused on a usage limit until 2026-11-09 14:05 UTC', since: null, reasons: ['The session limit of claude-code stopped the thread.'], nextSteps: [USAGE] } }), 'Paused on a usage limit until 2026-11-09 14:05 UTC', 'Running', ['Open usage limits']],
    ['queued', diag({ status: 'queued', process: { alive: false, transport: 'structured' }, events: [], explanation: { rule: 'queued', headline: 'Queued: the thread did not start yet', since: null, reasons: ['The thread holds its task and has no process.'], nextSteps: [] } }), 'Queued: the thread did not start yet', 'Not running', []],
  ] as const)('%s: the headline, the process and the steps', async (_name, answer, headline, processText, steps) => {
    load.mockResolvedValue(answer as ThreadDiagnostics);
    render(<WhyPanel terminalId="t1" />);
    expect(await screen.findByRole('heading', { name: headline })).toBeTruthy();
    expect(screen.getByText(processText)).toBeTruthy();
    const group = screen.queryByRole('group', { name: 'Next steps' });
    expect(group ? within(group).getAllByRole('button').map((b) => b.textContent) : []).toEqual([...steps]);
    expect(answer.explanation!.reasons.every((r) => screen.getByText(r))).toBe(true);
    // The panel explains. It never asks for an answer itself (constraint 3: no ask strip, no Answer button).
    expect(screen.queryByRole('button', { name: /answer/i })).toBeNull();
  });

  it('a process state that is not known says so', async () => {
    load.mockResolvedValue(diag({ process: null }));
    render(<WhyPanel terminalId="t1" />);
    await screen.findByRole('heading');
    expect(screen.getByText('Not known')).toBeTruthy();
  });

  it('reads again when the thread changes', async () => {
    load.mockResolvedValue(diag());
    const { rerender } = render(<WhyPanel terminalId="t1" />);
    await screen.findByRole('heading');
    rerender(<WhyPanel terminalId="t2" />);
    await waitFor(() => expect(load).toHaveBeenCalledWith('t2'));
  });
});
