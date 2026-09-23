// Store sequencing — Control Plane peeks for an existing coordinator before creating one.
// ensureForProject must NOT auto-create; it peeks via listTerminals, and only find-or-creates
// when a live coordinator already exists. When none exists, it flips setupNeeded so the inline
// setup card (built separately) can drive startCoordinator with the user's harness/model choice.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOverseer } from './store';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';
import type { Terminal } from '../../api/types';

const term = (overrides: Partial<Terminal>): Terminal =>
  ({
    id: 't1',
    sessionId: 'proj-1',
    type: 'claude-code',
    label: 'x',
    pid: null,
    externalId: null,
    workingDir: null,
    status: 'working',
    createdAt: '',
    config: {},
    archivedAt: null,
    sortOrder: 0,
    ...overrides,
  }) as Terminal;

beforeEach(() => {
  vi.restoreAllMocks();
  // ensureForProject refreshes the project's threads; stub it out of the way.
  useTabs.setState({ loadTabs: vi.fn().mockResolvedValue(undefined) } as never);
  useOverseer.setState({
    coordinatorProject: null,
    coordinatorId: null,
    ensuring: false,
    setupNeeded: false,
    setupSelection: { workerHarness: 'claude-code', model: 'sonnet', coordinatorHarness: 'claude-code' },
  } as never);
});

describe('ensureForProject — peeks before creating', () => {
  it('finds an existing coordinator row → revives it with NO opts; setupNeeded stays false', async () => {
    vi.spyOn(api, 'listTerminals').mockResolvedValue([term({ id: 'coord-1', config: { role: 'coordinator' } })]);
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator').mockResolvedValue({ terminalId: 'coord-1' });

    useOverseer.getState().ensureForProject('proj-1');

    await vi.waitFor(() => expect(useOverseer.getState().coordinatorId).toBe('coord-1'));
    expect(ensure).toHaveBeenCalledWith('proj-1');
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(useOverseer.getState().setupNeeded).toBe(false);
  });

  it('finds no coordinator row → does NOT create; flips setupNeeded', async () => {
    vi.spyOn(api, 'listTerminals').mockResolvedValue([]);
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator');

    useOverseer.getState().ensureForProject('proj-1');

    await vi.waitFor(() => expect(useOverseer.getState().setupNeeded).toBe(true));
    expect(ensure).not.toHaveBeenCalled();
    expect(useOverseer.getState().ensuring).toBe(false);
    expect(useOverseer.getState().coordinatorId).toBeNull();
  });

  it('listTerminals rejects → falls back to a plain ensure (no opts); setupNeeded stays false', async () => {
    vi.spyOn(api, 'listTerminals').mockRejectedValue(new Error('network'));
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator').mockResolvedValue({ terminalId: 'coord-fallback' });

    useOverseer.getState().ensureForProject('proj-1');

    await vi.waitFor(() => expect(useOverseer.getState().coordinatorId).toBe('coord-fallback'));
    expect(ensure).toHaveBeenCalledWith('proj-1');
    expect(useOverseer.getState().setupNeeded).toBe(false);
  });
});

describe('startCoordinator — create with the setup selection', () => {
  it('calls ensureOverseerCoordinator with the current setupSelection, sets coordinatorId, clears setupNeeded', async () => {
    useOverseer.setState({
      coordinatorProject: 'proj-1',
      setupNeeded: true,
      setupSelection: { workerHarness: 'codex', model: 'gpt-5', coordinatorHarness: 'claude-code' },
    } as never);
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator').mockResolvedValue({ terminalId: 'coord-new' });

    await useOverseer.getState().startCoordinator('proj-1');

    expect(ensure).toHaveBeenCalledWith('proj-1', { coordinatorHarness: 'claude-code', model: 'gpt-5', workerHarness: 'codex' });
    expect(useOverseer.getState().coordinatorId).toBe('coord-new');
    expect(useOverseer.getState().setupNeeded).toBe(false);
  });

  it('sends coordinatorHarness: "codex" when the setup card selected a Codex coordinator', async () => {
    useOverseer.setState({
      coordinatorProject: 'proj-1',
      setupNeeded: true,
      setupSelection: { workerHarness: 'claude-code', model: '', coordinatorHarness: 'codex' },
    } as never);
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator').mockResolvedValue({ terminalId: 'coord-codex' });

    await useOverseer.getState().startCoordinator('proj-1');

    expect(ensure).toHaveBeenCalledWith('proj-1', { coordinatorHarness: 'codex', model: '', workerHarness: 'claude-code' });
    expect(useOverseer.getState().coordinatorId).toBe('coord-codex');
  });
});

describe('startCoordinator — failure is visible on the setup card (review L2)', () => {
  it('a rejected create sets setupError (the card shows it), and the next attempt clears it', async () => {
    useOverseer.setState({
      coordinatorProject: 'proj-1',
      setupNeeded: true,
      setupError: null,
      setupSelection: { workerHarness: 'claude-code', model: '', coordinatorHarness: 'codex' },
    } as never);
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator').mockRejectedValueOnce(new Error('POST failed: 400'));

    await useOverseer.getState().startCoordinator('proj-1');
    expect(useOverseer.getState().setupError).toMatch(/could not start/i);
    expect(useOverseer.getState().ensuring).toBe(false);

    ensure.mockResolvedValueOnce({ terminalId: 'coord-ok' });
    await useOverseer.getState().startCoordinator('proj-1');
    expect(useOverseer.getState().setupError).toBeNull();
  });
});

describe('ensureForProject — stale peek race (regression, Finding D)', () => {
  it('a slow peek that resolves AFTER startCoordinator has already set a live coordinator must not clobber it', async () => {
    let resolvePeek1: (terminals: Terminal[]) => void = () => {};
    const peek1 = new Promise<Terminal[]>((resolve) => { resolvePeek1 = resolve; });
    vi.spyOn(api, 'listTerminals')
      .mockReturnValueOnce(peek1) // peek1: DELAYED — still in flight when everything else below happens
      .mockResolvedValueOnce([]); // peek2: resolves empty right away
    vi.spyOn(api, 'ensureOverseerCoordinator').mockResolvedValue({ terminalId: 'coord-new' });

    // peek1: kick off the first ensureForProject run for project A; its listTerminals call
    // is now pending on the un-resolved `peek1` promise above.
    useOverseer.getState().ensureForProject('proj-1');
    expect(useOverseer.getState().ensuring).toBe(true);

    // A second, newer run lands for the SAME project while peek1 is still in flight (e.g. a
    // retry/remount). Force past the same-project "already ensuring" guard the way some other
    // in-flight state transition legitimately could — this run's own peek resolves empty,
    // correctly flipping setupNeeded.
    useOverseer.setState({ ensuring: false } as never);
    useOverseer.getState().ensureForProject('proj-1');
    await vi.waitFor(() => expect(useOverseer.getState().setupNeeded).toBe(true));

    // The user picks a harness/model on the (correctly shown) setup card and starts the
    // coordinator — this is the newest, authoritative run.
    await useOverseer.getState().startCoordinator('proj-1');
    expect(useOverseer.getState().coordinatorId).toBe('coord-new');
    expect(useOverseer.getState().setupNeeded).toBe(false);

    // THEN the stale peek1 (from the very first, now thoroughly superseded run) finally
    // resolves with no coordinator found. Without the generation guard, its continuation
    // reads `coordinatorProject === 'proj-1'` (still true — the project never changed) and
    // wrongly flips setupNeeded back to true, resurrecting the setup card over a live
    // coordinator that already exists.
    resolvePeek1([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(useOverseer.getState().setupNeeded).toBe(false);
    expect(useOverseer.getState().coordinatorId).toBe('coord-new');
  });
});

describe('sendDirective — starts the coordinator first when none exists and setup is needed', () => {
  it('creates the coordinator via startCoordinator before sending the directive', async () => {
    useOverseer.setState({
      coordinatorProject: 'proj-1',
      coordinatorId: null,
      setupNeeded: true,
      setupSelection: { workerHarness: 'claude-code', model: 'sonnet', coordinatorHarness: 'claude-code' },
      composerImagesByProject: {},
    } as never);
    vi.spyOn(api, 'ensureOverseerCoordinator').mockResolvedValue({ terminalId: 'coord-live' });
    const send = vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as unknown as void);

    useOverseer.getState().sendDirective('hello');

    await vi.waitFor(() => expect(send).toHaveBeenCalledWith('coord-live', 'hello'));
    expect(useOverseer.getState().setupNeeded).toBe(false);
  });
});

describe('sendDirective — mid-flight guards on the first-directive (setup) path (regression)', () => {
  it('startCoordinator rejects → sendDirective surfaces a sendError and sends nothing', async () => {
    useOverseer.setState({
      coordinatorProject: 'proj-1',
      coordinatorId: null,
      setupNeeded: true,
      setupSelection: { workerHarness: 'claude-code', model: 'sonnet', coordinatorHarness: 'claude-code' },
      composerImagesByProject: {},
      sendError: null,
    } as never);
    vi.spyOn(api, 'ensureOverseerCoordinator').mockRejectedValue(new Error('boom'));
    const send = vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as unknown as void);

    useOverseer.getState().sendDirective('hello');

    await vi.waitFor(() => expect(useOverseer.getState().sendError).not.toBeNull());
    // Give any pending microtasks a chance to settle before asserting the negative.
    await new Promise((r) => setTimeout(r, 10));
    expect(send).not.toHaveBeenCalled();
  });

  it('the project switches during startCoordinator → the directive is dropped, never sent to the new project\'s coordinator', async () => {
    useOverseer.setState({
      coordinatorProject: 'proj-1',
      coordinatorId: null,
      setupNeeded: true,
      setupSelection: { workerHarness: 'claude-code', model: 'sonnet', coordinatorHarness: 'claude-code' },
      composerImagesByProject: {},
      sendError: null,
    } as never);
    // Simulate a concurrent project switch (e.g. ensureForProject for a newly active
    // project) landing WHILE this project's startCoordinator create call is in flight.
    vi.spyOn(api, 'ensureOverseerCoordinator').mockImplementation(async () => {
      useOverseer.setState({ coordinatorProject: 'proj-2', coordinatorId: 'coord-2' } as never);
      return { terminalId: 'coord-1' };
    });
    const send = vi.spyOn(api, 'sendStructuredMessage').mockResolvedValue(undefined as unknown as void);

    useOverseer.getState().sendDirective('hello');

    await vi.waitFor(() => expect(useOverseer.getState().coordinatorId).toBe('coord-2'));
    // Give sendDirective's own post-await continuation a chance to run (and, pre-fix,
    // to wrongly fire the send) before asserting it never did.
    await new Promise((r) => setTimeout(r, 10));
    expect(send).not.toHaveBeenCalled();
  });
});
