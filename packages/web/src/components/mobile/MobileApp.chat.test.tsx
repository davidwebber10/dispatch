import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MobileApp } from './MobileApp';
import { useTabs } from '../../stores/tabs';
import { api } from '../../api/client';
import { useEndless } from '../../stores/endless';
import { ChatMode } from '../endless/ChatMode';
import { useUI } from '../../stores/ui';
import { useProjects } from '../../stores/projects';
import { act } from '@testing-library/react';

const savedEndless = useEndless.getState();

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

afterEach(() => {
  useEndless.setState(savedEndless, true);
  vi.unstubAllGlobals();
});

describe('MobileApp Chat tab', () => {
  it('opens the Chat page from the bottom tab bar', async () => {
    render(<MobileApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const page = await screen.findByTestId('chat-mode');
    expect(page).toHaveAttribute('data-mobile', '1');
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });

  it('does not add the bottom safe-area inset to the composer on mobile (the tab bar pads it)', async () => {
    render(<MobileApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    const box = (await screen.findByRole('textbox', { name: 'Message' })).closest('div[style*="border-top"]') as HTMLElement;
    expect(box.getAttribute('style')).not.toContain('safe-area-inset-bottom');
    expect(box.style.paddingLeft).toBe('16px');
  });

  it('keeps the bottom safe-area inset on the desktop composer', async () => {
    const { unmount } = render(<ChatMode />);
    const box = (await screen.findByRole('textbox', { name: 'Message' })).closest('div[style*="border-top"]') as HTMLElement;
    expect(box.getAttribute('style')).toContain('safe-area-inset-bottom');
    unmount();
  });
});

describe('MobileApp open-project intent', () => {
  it('opens the project from the Projects tab and clears the intent', async () => {
    render(<MobileApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Chat' }));
    await screen.findByTestId('chat-mode');
    act(() => { useUI.getState().requestOpenProject('s7'); });
    expect(useUI.getState().pendingOpenProject).toBeNull();
    expect(useProjects.getState().activeId).toBe('s7');
    expect(window.location.pathname).toMatch(/\/p\/s7$/);
    expect(screen.queryByTestId('chat-mode')).not.toBeInTheDocument();
  });
});
