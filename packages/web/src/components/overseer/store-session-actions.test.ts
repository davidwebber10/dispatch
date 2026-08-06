// Coordinator session swaps (the CoordinatorMenu actions). Invariant under test:
// at most ONE active coordinator per project — so the current one is archived
// BEFORE any restore/ensure, and a failed archive aborts without touching state.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useOverseer } from './store';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';

beforeEach(() => {
  vi.restoreAllMocks();
  // ensureForProject refreshes the project's threads; stub it out of the way.
  useTabs.setState({ loadTabs: vi.fn().mockResolvedValue(undefined) } as never);
  useOverseer.setState({ coordinatorProject: 'proj-1', coordinatorId: 'coord-1', ensuring: false } as never);
});

describe('newCoordinatorSession — archive current, then find-or-create fresh', () => {
  it('archives the current coordinator and lands on the freshly ensured one', async () => {
    const archive = vi.spyOn(api, 'archiveTerminal').mockResolvedValue(undefined as unknown as void);
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator').mockResolvedValue({ terminalId: 'fresh-1' });

    const result = await useOverseer.getState().newCoordinatorSession('proj-1', 'coord-1');

    expect(result).toBe(true);
    expect(archive).toHaveBeenCalledWith('coord-1');
    await vi.waitFor(() => expect(useOverseer.getState().coordinatorId).toBe('fresh-1'));
    expect(ensure).toHaveBeenCalledWith('proj-1');
  });

  it('a failed archive aborts — the current session stays intact, and resolves false so the caller keeps the menu open', async () => {
    vi.spyOn(api, 'archiveTerminal').mockRejectedValue(new Error('boom'));
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator');

    const result = await useOverseer.getState().newCoordinatorSession('proj-1', 'coord-1');

    expect(result).toBe(false);
    expect(ensure).not.toHaveBeenCalled();
    expect(useOverseer.getState().coordinatorId).toBe('coord-1');
  });

  it('does not touch the store when the view moved to ANOTHER project mid-flight, but resolves true (the view DID move on)', async () => {
    vi.spyOn(api, 'archiveTerminal').mockResolvedValue(undefined as unknown as void);
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator');
    useOverseer.setState({ coordinatorProject: 'proj-2', coordinatorId: 'coord-2' } as never);

    const result = await useOverseer.getState().newCoordinatorSession('proj-1', 'coord-1');

    expect(result).toBe(true);
    expect(ensure).not.toHaveBeenCalled();
    expect(useOverseer.getState().coordinatorId).toBe('coord-2'); // untouched
  });
});

describe('resumeCoordinatorSession — swap an archived coordinator back in', () => {
  it('archives the current coordinator BEFORE restoring, then points the store at the restored id', async () => {
    const archive = vi.spyOn(api, 'archiveTerminal').mockResolvedValue(undefined as unknown as void);
    const restore = vi.spyOn(api, 'restoreTerminal').mockResolvedValue({ id: 'old-1' } as never);

    const result = await useOverseer.getState().resumeCoordinatorSession('proj-1', 'coord-1', 'old-1');

    expect(result).toBe(true);
    expect(archive).toHaveBeenCalledWith('coord-1');
    expect(restore).toHaveBeenCalledWith('old-1');
    // Order: archive strictly before restore (one active coordinator per project).
    expect(archive.mock.invocationCallOrder[0]).toBeLessThan(restore.mock.invocationCallOrder[0]);
    expect(useOverseer.getState().coordinatorId).toBe('old-1');
    expect(useOverseer.getState().coordinatorStream).toEqual([]); // view reset for the swap
  });

  it('falls back to a FRESH coordinator when the restore fails (never zero coordinators), and resolves true (the session DID change)', async () => {
    vi.spyOn(api, 'archiveTerminal').mockResolvedValue(undefined as unknown as void);
    vi.spyOn(api, 'restoreTerminal').mockRejectedValue(new Error('gone'));
    const ensure = vi.spyOn(api, 'ensureOverseerCoordinator').mockResolvedValue({ terminalId: 'fresh-2' });

    const result = await useOverseer.getState().resumeCoordinatorSession('proj-1', 'coord-1', 'old-1');

    expect(result).toBe(true);
    await vi.waitFor(() => expect(useOverseer.getState().coordinatorId).toBe('fresh-2'));
    expect(ensure).toHaveBeenCalledWith('proj-1');
  });

  it('a failed archive aborts the swap entirely and resolves false so the caller keeps the menu open', async () => {
    vi.spyOn(api, 'archiveTerminal').mockRejectedValue(new Error('boom'));
    const restore = vi.spyOn(api, 'restoreTerminal');

    const result = await useOverseer.getState().resumeCoordinatorSession('proj-1', 'coord-1', 'old-1');

    expect(result).toBe(false);
    expect(restore).not.toHaveBeenCalled();
    expect(useOverseer.getState().coordinatorId).toBe('coord-1');
  });
});
