import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AutoArchiveModal } from './AutoArchiveModal';
import { api } from '../../api/client';
import { useTabs } from '../../stores/tabs';
import type { Terminal } from '../../api/types';

vi.mock('../../api/client', () => ({
  api: { setAutoArchive: vi.fn().mockResolvedValue({}) },
}));

const tab = (config: Record<string, unknown>): Terminal => ({
  id: 't1', sessionId: 's1', type: 'claude-code', label: 'quick q', pid: null, externalId: null,
  workingDir: null, status: 'waiting', createdAt: '2026-07-14T00:00:00.000Z', config,
  archivedAt: null, sortOrder: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(useTabs.getState(), 'loadTabs').mockResolvedValue(undefined as any);
});

describe('AutoArchiveModal', () => {
  it('starts off for a thread with no policy', () => {
    render(<AutoArchiveModal tab={tab({ transport: 'structured' })} onClose={() => {}} />);
    expect((screen.getByRole('switch', { name: /auto-archive thread/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('pre-fills the existing policy', () => {
    render(<AutoArchiveModal tab={tab({ autoArchive: true, autoArchiveMs: 3 * 3_600_000 })} onClose={() => {}} />);
    expect((screen.getByRole('switch', { name: /auto-archive thread/i }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Inactivity before archiving') as HTMLInputElement).value).toBe('3');
  });

  it('saves an enabled policy through the dedicated endpoint', async () => {
    const onClose = vi.fn();
    render(<AutoArchiveModal tab={tab({ transport: 'structured' })} onClose={onClose} />);
    fireEvent.click(screen.getByRole('switch', { name: /auto-archive thread/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(api.setAutoArchive).toHaveBeenCalledWith('t1', true, 43_200_000));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('saves a disabled policy (takes a thread off the clock)', async () => {
    render(<AutoArchiveModal tab={tab({ autoArchive: true, autoArchiveMs: 60_000 })} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('switch', { name: /auto-archive thread/i }));
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(api.setAutoArchive).toHaveBeenCalledWith('t1', false, 60_000));
  });
});
