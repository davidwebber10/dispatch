import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettings, stepSidebarLimit, formatSidebarLimit } from './settings';

beforeEach(() => { try { localStorage.clear(); } catch {} });

describe('transcription settings', () => {
  it('has sensible defaults', () => {
    const s = useSettings.getState();
    expect(s.sttProvider).toBe('groq');
    expect(s.sttModel).toBe('whisper-large-v3-turbo');
    expect(s.sttSecretName).toBe('');
  });
  it('persists setters to localStorage', () => {
    useSettings.getState().setSttProvider('openai');
    useSettings.getState().setSttModel('whisper-1');
    useSettings.getState().setSttSecretName('OPENAI_API_KEY');
    expect(useSettings.getState().sttProvider).toBe('openai');
    expect(JSON.parse(localStorage.getItem('dispatch:sttSecretName')!)).toBe('OPENAI_API_KEY');
  });
});

describe('mobileViewMode setting', () => {
  it('defaults to threads', () => {
    expect(useSettings.getState().mobileViewMode).toBe('threads');
  });

  it('setMobileViewMode(board) updates the store and persists to localStorage', () => {
    useSettings.getState().setMobileViewMode('board');
    expect(useSettings.getState().mobileViewMode).toBe('board');
    expect(JSON.parse(localStorage.getItem('dispatch:mobileViewMode')!)).toBe('board');
  });

  it('setMobileViewMode(threads) updates the store back and persists', () => {
    useSettings.getState().setMobileViewMode('board');
    useSettings.getState().setMobileViewMode('threads');
    expect(useSettings.getState().mobileViewMode).toBe('threads');
    expect(JSON.parse(localStorage.getItem('dispatch:mobileViewMode')!)).toBe('threads');
  });

  it('reads a previously-saved value back on module init — the real save/load round trip', async () => {
    localStorage.setItem('dispatch:mobileViewMode', JSON.stringify('board'));
    // `load()` runs at module scope (mirrors every other useSettings field), so re-importing
    // the module fresh is what actually exercises "persists": a genuine reload, not just
    // re-reading the same in-memory store we just wrote to.
    vi.resetModules();
    const fresh = await import('./settings');
    expect(fresh.useSettings.getState().mobileViewMode).toBe('board');
  });
});

describe('sidebar list limits', () => {
  it('defaults both limits to 10', () => {
    expect(useSettings.getState().sidebarMaxThreads).toBe(10);
    expect(useSettings.getState().sidebarMaxFiles).toBe(10);
  });

  it('setters persist to localStorage under their own keys', () => {
    useSettings.getState().setSidebarMaxThreads(25);
    useSettings.getState().setSidebarMaxFiles(5);
    expect(useSettings.getState().sidebarMaxThreads).toBe(25);
    expect(useSettings.getState().sidebarMaxFiles).toBe(5);
    expect(JSON.parse(localStorage.getItem('dispatch:sidebarMaxThreads')!)).toBe(25);
    expect(JSON.parse(localStorage.getItem('dispatch:sidebarMaxFiles')!)).toBe(5);
  });

  it('setters clamp to 3–50 but pass 0 (All) through', () => {
    useSettings.getState().setSidebarMaxThreads(1);
    expect(useSettings.getState().sidebarMaxThreads).toBe(3);
    useSettings.getState().setSidebarMaxThreads(999);
    expect(useSettings.getState().sidebarMaxThreads).toBe(50);
    useSettings.getState().setSidebarMaxThreads(0);
    expect(useSettings.getState().sidebarMaxThreads).toBe(0);
  });

  it('stepSidebarLimit walks 3…50 then All, and back down from All', () => {
    expect(stepSidebarLimit(10, 1)).toBe(11);
    expect(stepSidebarLimit(10, -1)).toBe(9);
    expect(stepSidebarLimit(50, 1)).toBe(0);   // past max → All
    expect(stepSidebarLimit(0, 1)).toBe(0);    // All is the ceiling
    expect(stepSidebarLimit(0, -1)).toBe(50);  // down from All → max
    expect(stepSidebarLimit(3, -1)).toBe(3);   // floor
  });

  it('formatSidebarLimit renders 0 as All', () => {
    expect(formatSidebarLimit(0)).toBe('All');
    expect(formatSidebarLimit(10)).toBe('10');
  });
});
