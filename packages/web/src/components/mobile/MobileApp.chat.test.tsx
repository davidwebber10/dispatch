import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileApp } from './MobileApp';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';

beforeAll(() => {
  class Noop { observe() {} unobserve() {} disconnect() {} }
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = Noop;
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = Noop;
});

beforeEach(() => {
  window.history.pushState({}, '', '/');
  Object.defineProperty(window, 'innerWidth', { value: 390, configurable: true, writable: true });
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: window.innerWidth <= 768, media: query, addEventListener: () => {}, removeEventListener: () => {} }));
  useTabs.setState({ byProject: {}, openTabIds: [], activeTabId: null, tabSession: {} });
  vi.restoreAllMocks();
  vi.spyOn(api, 'listSessions').mockResolvedValue([] as any);
  vi.spyOn(api, 'listTerminals').mockResolvedValue([] as any);
  vi.spyOn(api, 'endlessMessages').mockResolvedValue({ messages: [], hasMore: false, hasMoreAfter: false });
  vi.spyOn(api, 'endlessState').mockResolvedValue({ turn: { status: 'idle', error: null }, total: 0, compactor: { unbuilt: 0, merges: 0, running: 0 } });
  vi.spyOn(api, 'endlessProjects').mockResolvedValue([]);
});

describe('MobileApp Chat tab', () => {
  it('opens the Chat page from the bottom tab bar', async () => {
    render(<MobileApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const page = await screen.findByTestId('chat-mode');
    expect(page).toHaveAttribute('data-mobile', '1');
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });
});
