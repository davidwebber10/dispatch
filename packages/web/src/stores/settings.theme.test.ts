import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A controllable prefers-color-scheme: tests flip `dark` and fire the change listeners.
function mockColorScheme(initialDark: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const mql = {
    matches: initialDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
    addListener: (fn: (e: { matches: boolean }) => void) => listeners.add(fn),
    removeListener: (fn: (e: { matches: boolean }) => void) => listeners.delete(fn),
  };
  window.matchMedia = vi.fn((q: string) => (q.includes('prefers-color-scheme') ? mql : { ...mql, matches: false, media: q })) as unknown as typeof window.matchMedia;
  return { set(dark: boolean) { mql.matches = dark; listeners.forEach((fn) => fn({ matches: dark })); } };
}

async function freshStores() {
  vi.resetModules();
  const settings = await import('./settings');
  const themes = await import('../themes/apply');
  return { useSettings: settings.useSettings, useActiveTheme: themes.useActiveTheme };
}

const canvas = () => document.documentElement.style.getPropertyValue('--color-canvas');
const original = window.matchMedia;

describe('the theme setting', () => {
  beforeEach(() => { localStorage.clear(); document.documentElement.removeAttribute('style'); });
  afterEach(() => { window.matchMedia = original; });

  it("defaults to Dispatch Dark, so nothing changes for an existing user", async () => {
    mockColorScheme(false);
    const { useSettings, useActiveTheme } = await freshStores();
    expect(useSettings.getState().theme).toBe('dispatch-dark');
    expect(useActiveTheme.getState().theme.id).toBe('dispatch-dark');
    expect(canvas()).toBe('#08080A');
  });

  it('persists the chosen theme and applies it at once', async () => {
    mockColorScheme(false);
    let { useSettings, useActiveTheme } = await freshStores();
    useSettings.getState().setTheme('dracula');
    expect(JSON.parse(localStorage.getItem('dispatch:theme')!)).toBe('dracula');
    expect(useActiveTheme.getState().theme.id).toBe('dracula');
    expect(document.documentElement.dataset.theme).toBe('dracula');
    ({ useSettings, useActiveTheme } = await freshStores());
    expect(useSettings.getState().theme).toBe('dracula');
    expect(useActiveTheme.getState().theme.id).toBe('dracula');
  });

  it("'system' picks Dispatch Light or Dark from prefers-color-scheme and follows a change", async () => {
    const scheme = mockColorScheme(false);
    const { useSettings, useActiveTheme } = await freshStores();
    useSettings.getState().setTheme('system');
    expect(useActiveTheme.getState().theme.id).toBe('dispatch-light');
    scheme.set(true);
    expect(useActiveTheme.getState().theme.id).toBe('dispatch-dark');
    expect(canvas()).toBe('#08080A');
    scheme.set(false);
    expect(useActiveTheme.getState().theme.id).toBe('dispatch-light');
  });

  it('a fixed theme ignores a change of the device color scheme', async () => {
    const scheme = mockColorScheme(false);
    const { useSettings, useActiveTheme } = await freshStores();
    useSettings.getState().setTheme('nord');
    scheme.set(true);
    expect(useActiveTheme.getState().theme.id).toBe('nord');
  });

  it("the accent: '' follows the theme; a chosen accent overrides it in every theme", async () => {
    mockColorScheme(false);
    const { useSettings } = await freshStores();
    const accent = () => document.documentElement.style.getPropertyValue('--color-accent');
    expect(useSettings.getState().accent).toBe('');
    useSettings.getState().setTheme('nord');
    expect(accent()).toBe('#88C0D0');
    useSettings.getState().setAccent('#FF6AC1');
    expect(accent()).toBe('#FF6AC1');
    useSettings.getState().setTheme('github-light');
    expect(accent()).toBe('#FF6AC1');
    useSettings.getState().setAccent('');
    expect(accent()).toBe('#0969DA');
  });

  it('keeps an accent saved before themes existed', async () => {
    mockColorScheme(false);
    localStorage.setItem('dispatch:accent', JSON.stringify('#0091FF'));
    const { useSettings } = await freshStores();
    expect(useSettings.getState().accent).toBe('#0091FF');
    expect(document.documentElement.style.getPropertyValue('--color-accent')).toBe('#0091FF');
  });
});
