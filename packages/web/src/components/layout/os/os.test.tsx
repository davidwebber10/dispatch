import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { setHostContextForTest } from '../../../lib/hostContext';
import { loadOsShell, parseShell, resetOsShellForTest } from './shellApi';
import { osIcon } from './OsIcon';
import { AppWindow, ChartBar } from '@phosphor-icons/react';
import { OsAppSwitcher } from './OsAppSwitcher';

afterEach(() => { setHostContextForTest({}); resetOsShellForTest(); vi.restoreAllMocks(); });

describe('the OS shell client', () => {
  it('keeps only well-formed apps with a web address', () => {
    const s = parseShell({ user: { email: 'a@b', name: 'A B' }, apps: [
      { id: 'x', label: 'X', icon: 'ChartBar', url: '/x' },
      { id: 'y', label: 'Y', icon: 'Nope', url: 'javascript:alert(1)' },
      { id: 'z', label: 'Z', url: 'https://os.example/z', current: true },
      { label: 'no id', url: '/q' },
    ] });
    expect(s?.apps.map((a) => a.id)).toEqual(['x', 'z']);
    expect(s?.apps[1].current).toBe(true);
    expect(s?.user).toEqual({ email: 'a@b', name: 'A B' });
    expect(parseShell({ apps: 'no' })).toBeNull();
  });

  it('a local page never asks', async () => {
    const f = vi.fn();
    expect(await loadOsShell(f as unknown as typeof fetch)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('a hosted page asks OS with its cookie and makes relative URLs absolute; a failure is null', async () => {
    setHostContextForTest({ hosted: true, osBaseUrl: 'https://os.example' });
    const f = vi.fn(async () => new Response(JSON.stringify({ user: null, apps: [{ id: 'a', label: 'Ask', icon: 'Sparkle', url: '/ask' }] })));
    const s = await loadOsShell(f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledWith('https://os.example/api/dispatch/shell', expect.objectContaining({ credentials: 'include' }));
    expect(s?.apps[0].url).toBe('https://os.example/ask');
    resetOsShellForTest();
    expect(await loadOsShell((async () => { throw new Error('offline'); }) as unknown as typeof fetch)).toBeNull();
  });

  it('maps known icon names and falls back for the rest', () => {
    expect(osIcon('ChartBar')).toBe(ChartBar);
    expect(osIcon('NoSuchIcon')).toBe(AppWindow);
  });
});

describe('the app switcher', () => {
  it('with no answer from OS it lists only the current app', () => {
    render(<OsAppSwitcher shell={null} open setOpen={() => {}} />);
    expect(screen.getAllByRole('menuitem').map((a) => a.textContent)).toEqual(['Dispatch']);
  });

  it('lists the OS apps as links; the current one is marked and is not a link away', async () => {
    const setOpen = vi.fn();
    render(<OsAppSwitcher open setOpen={setOpen} shell={{ user: null, apps: [
      { id: 'ask', label: 'Ask', icon: 'Sparkle', url: 'https://os.example/ask' },
      { id: 'dispatch', label: 'Dispatch', icon: 'Robot', url: 'https://os.example/dispatch/', current: true },
    ] }} />);
    const items = screen.getAllByRole('menuitem');
    expect(items.map((a) => a.textContent)).toEqual(['Ask', 'Dispatch']);
    expect(items[0].getAttribute('href')).toBe('https://os.example/ask');
    expect(items[1].getAttribute('aria-current')).toBe('true');
    expect(items[1].getAttribute('href')).toBeNull();
    expect(screen.queryByText(/Back to/)).toBeNull();
    fireEvent.click(items[1]);
    await waitFor(() => expect(setOpen).toHaveBeenCalledWith(false));
  });
});
