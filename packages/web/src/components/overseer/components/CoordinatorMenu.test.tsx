// CoordinatorMenu — the Control Plane session menu (Restart / New session / Previous
// sessions). Coordinator semantics differ from worker Stop/Archive: Restart relaunches
// in place (same conversation, tools re-read at spawn); New session and Previous
// sessions go through the store's swap actions (one active coordinator per project).
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../../../api/client';
import { useOverseer } from '../store';
import { CoordinatorMenu } from './CoordinatorMenu';

const newSession = vi.fn().mockResolvedValue(true);
const resumeSession = vi.fn().mockResolvedValue(true);

beforeEach(() => {
  vi.restoreAllMocks();
  newSession.mockClear();
  resumeSession.mockClear();
  useOverseer.setState({
    newCoordinatorSession: newSession,
    resumeCoordinatorSession: resumeSession,
  } as never);
});
afterEach(cleanup);

const mount = () => render(<CoordinatorMenu terminalId="coord-1" sessionId="proj-1" />);
const openMenu = () => fireEvent.click(screen.getByTitle('Session menu'));

describe('CoordinatorMenu — Restart', () => {
  it('relaunches the coordinator in place', async () => {
    const relaunch = vi.spyOn(api, 'relaunchTerminal').mockResolvedValue({ id: 'coord-1' } as never);
    mount();
    openMenu();
    fireEvent.click(screen.getByText('Restart session'));
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalledWith('coord-1'));
    expect(newSession).not.toHaveBeenCalled();
  });
});

describe('CoordinatorMenu — New session (two-step confirm)', () => {
  it('the first click only arms the confirm — nothing is archived yet', () => {
    mount();
    openMenu();
    fireEvent.click(screen.getByText('New session…'));
    expect(newSession).not.toHaveBeenCalled();
    expect(screen.getByText(/End this session\?/)).toBeInTheDocument();
  });

  it('Confirm runs the store swap; Cancel disarms', async () => {
    mount();
    openMenu();
    fireEvent.click(screen.getByText('New session…'));
    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText(/End this session\?/)).not.toBeInTheDocument();
    expect(newSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('New session…'));
    fireEvent.click(screen.getByText('Confirm'));
    await vi.waitFor(() => expect(newSession).toHaveBeenCalledWith('proj-1', 'coord-1'));
  });

  it('a `false` result (the archive failed — nothing changed) keeps the confirm UI open instead of closing the menu', async () => {
    newSession.mockResolvedValueOnce(false);
    mount();
    openMenu();
    fireEvent.click(screen.getByText('New session…'));
    fireEvent.click(screen.getByText('Confirm'));
    await vi.waitFor(() => expect(newSession).toHaveBeenCalledWith('proj-1', 'coord-1'));
    // The menu (and its confirm step) is still open/rendered — a false result must NOT
    // silently close it the way a resolved `true`/undefined success path does.
    expect(screen.getByText(/End this session\?/)).toBeInTheDocument();
    expect(screen.getByText('Confirm')).toBeInTheDocument();
  });
});

describe('CoordinatorMenu — Previous sessions', () => {
  it('lists only archived COORDINATORS and swaps the chosen one in', async () => {
    vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([
      { id: 'old-1', type: 'claude-code', config: { role: 'coordinator' }, archivedAt: '2026-08-01T10:00:00Z' },
      { id: 'w-1', type: 'claude-code', config: { role: 'agent' }, archivedAt: '2026-08-02T10:00:00Z' },
    ] as never);
    mount();
    openMenu();
    fireEvent.click(screen.getByText('Previous sessions…'));
    const row = await screen.findByText(/Archived .*2026/); // one coordinator row
    expect(screen.queryAllByText(/Archived /)).toHaveLength(1); // the worker is filtered out
    fireEvent.click(row);
    await vi.waitFor(() => expect(resumeSession).toHaveBeenCalledWith('proj-1', 'coord-1', 'old-1'));
  });

  it('shows an empty state when no archived coordinators exist', async () => {
    vi.spyOn(api, 'listArchivedTerminals').mockResolvedValue([] as never);
    mount();
    openMenu();
    fireEvent.click(screen.getByText('Previous sessions…'));
    expect(await screen.findByText('No previous sessions.')).toBeInTheDocument();
  });

  it('a fetch error does NOT show the misleading empty state — the button stays so the user can retry', async () => {
    vi.spyOn(api, 'listArchivedTerminals').mockRejectedValue(new Error('network down'));
    mount();
    openMenu();
    fireEvent.click(screen.getByText('Previous sessions…'));
    await vi.waitFor(() => expect(api.listArchivedTerminals).toHaveBeenCalled());
    expect(screen.queryByText('No previous sessions.')).not.toBeInTheDocument();
    expect(screen.getByText('Previous sessions…')).toBeInTheDocument();
  });
});
