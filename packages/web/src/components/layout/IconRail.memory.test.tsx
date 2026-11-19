import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { IconRail } from './IconRail';
import { useUI } from '../../stores/ui';
import { useMemory } from '../../stores/memory';
import { api } from '../../api/client';

const settings = (enabled: boolean) => ({ enabled, paused: false, blockChars: 4000, projectsOff: [], available: enabled });

beforeEach(() => { useUI.setState({ view: 'workspace' }); useMemory.setState({ settings: null, scopes: null }); });
afterEach(() => { vi.restoreAllMocks(); });

/** Memory is off by default (owner, 2026-11-19): its rail item shows only while it is on. */
describe('IconRail: Memory', () => {
  it('is hidden while memory is off, and shows when it is turned on', async () => {
    vi.spyOn(api, 'memorySettings').mockResolvedValue(settings(false));
    render(<IconRail />);
    await act(async () => { await useMemory.getState().loadSettings(); });
    expect(screen.queryByTitle('Memory')).toBeNull();
    act(() => { useMemory.setState({ settings: settings(true) }); });
    const titles = screen.getAllByRole('button').map((b) => b.getAttribute('title'));
    expect(titles.indexOf('Memory')).toBe(titles.indexOf('Chat') + 1);
  });
});
