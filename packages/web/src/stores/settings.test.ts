import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSettings } from './settings';

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
