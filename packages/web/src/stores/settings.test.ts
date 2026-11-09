import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSettings, stepSidebarLimit, formatSidebarLimit, loadSharedSettings, clampTextScale } from './settings';
import { api } from '../api/client';

beforeEach(() => { try { localStorage.clear(); } catch {} });

describe('dictation settings (same on every device)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('has sensible defaults', () => {
    const s = useSettings.getState();
    expect(s.sttProvider).toBe('groq');
    expect(s.sttModel).toBe('whisper-large-v3-turbo');
    expect(s.sttSecretName).toBe('');
  });

  it('setters update the store, cache in localStorage, and save to the daemon', () => {
    const put = vi.spyOn(api, 'putDictationSettings').mockResolvedValue({ saved: true });
    useSettings.getState().setSttProvider('openai');
    useSettings.getState().setSttModel('whisper-1');
    useSettings.getState().setSttSecretName('OPENAI_API_KEY');
    expect(useSettings.getState().sttProvider).toBe('openai');
    expect(JSON.parse(localStorage.getItem('dispatch:sttSecretName')!)).toBe('OPENAI_API_KEY');
    expect(put.mock.calls).toEqual([[{ provider: 'openai' }], [{ model: 'whisper-1' }], [{ secretName: 'OPENAI_API_KEY' }]]);
  });

  it('a failed save keeps the local value', async () => {
    vi.spyOn(api, 'putDictationSettings').mockRejectedValue(new Error('offline'));
    useSettings.getState().setSttSecretName('GROQ_API_KEY');
    await Promise.resolve();
    expect(useSettings.getState().sttSecretName).toBe('GROQ_API_KEY');
  });
});

describe('loadSharedSettings', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useSettings.setState({ sttProvider: 'groq', sttModel: 'whisper-large-v3-turbo', sttSecretName: '', coordinatorName: 'Control Plane' });
  });

  it('uses the daemon values when the daemon has them, and caches them', async () => {
    vi.spyOn(api, 'getDictationSettings').mockResolvedValue({ provider: 'openai', model: 'whisper-1', secretName: 'OPENAI_API_KEY', saved: true });
    vi.spyOn(api, 'getCoordinatorSettings').mockResolvedValue({ name: 'Mission Control', saved: true });
    const putD = vi.spyOn(api, 'putDictationSettings');
    const putC = vi.spyOn(api, 'putCoordinatorSettings');
    await loadSharedSettings();
    const s = useSettings.getState();
    expect([s.sttProvider, s.sttModel, s.sttSecretName, s.coordinatorName]).toEqual(['openai', 'whisper-1', 'OPENAI_API_KEY', 'Mission Control']);
    expect(JSON.parse(localStorage.getItem('dispatch:coordinatorName')!)).toBe('Mission Control');
    expect(putD).not.toHaveBeenCalled();
    expect(putC).not.toHaveBeenCalled();
  });

  it("uploads this device's old values once when the daemon has none", async () => {
    localStorage.setItem('dispatch:sttSecretName', JSON.stringify('GROQ_API_KEY'));
    localStorage.setItem('dispatch:coordinatorName', JSON.stringify('Ops'));
    useSettings.setState({ sttSecretName: 'GROQ_API_KEY', coordinatorName: 'Ops' });
    vi.spyOn(api, 'getDictationSettings').mockResolvedValue({ saved: false });
    vi.spyOn(api, 'getCoordinatorSettings').mockResolvedValue({ saved: false });
    const putD = vi.spyOn(api, 'putDictationSettings').mockImplementation(async (p) => ({ ...(p as object), saved: true }) as never);
    const putC = vi.spyOn(api, 'putCoordinatorSettings').mockImplementation(async (p) => ({ name: p.name ?? undefined, saved: true }));
    await loadSharedSettings();
    expect(putD).toHaveBeenCalledWith({ provider: 'groq', model: 'whisper-large-v3-turbo', secretName: 'GROQ_API_KEY' });
    expect(putC).toHaveBeenCalledWith({ name: 'Ops' });
    expect(useSettings.getState().sttSecretName).toBe('GROQ_API_KEY');
    expect(useSettings.getState().coordinatorName).toBe('Ops');
  });

  it('uploads nothing when neither side has a value (defaults stay defaults)', async () => {
    vi.spyOn(api, 'getDictationSettings').mockResolvedValue({ saved: false });
    vi.spyOn(api, 'getCoordinatorSettings').mockResolvedValue({ saved: false });
    const putD = vi.spyOn(api, 'putDictationSettings');
    const putC = vi.spyOn(api, 'putCoordinatorSettings');
    await loadSharedSettings();
    expect(putD).not.toHaveBeenCalled();
    expect(putC).not.toHaveBeenCalled();
    expect(useSettings.getState().coordinatorName).toBe('Control Plane');
  });

  it('keeps the cached values when the daemon cannot be reached', async () => {
    useSettings.setState({ sttSecretName: 'CACHED' });
    vi.spyOn(api, 'getDictationSettings').mockRejectedValue(new Error('offline'));
    vi.spyOn(api, 'getCoordinatorSettings').mockRejectedValue(new Error('offline'));
    await expect(loadSharedSettings()).resolves.toBeUndefined();
    expect(useSettings.getState().sttSecretName).toBe('CACHED');
  });
});

describe('Control Plane name (same on every device)', () => {
  it('saves to the daemon once typing pauses, not per keystroke', () => {
    vi.useFakeTimers();
    try {
      const put = vi.spyOn(api, 'putCoordinatorSettings').mockResolvedValue({ name: 'Ops', saved: true });
      useSettings.getState().setCoordinatorName('O');
      useSettings.getState().setCoordinatorName('Op');
      useSettings.getState().setCoordinatorName('Ops');
      expect(useSettings.getState().coordinatorName).toBe('Ops');
      expect(put).not.toHaveBeenCalled();
      vi.advanceTimersByTime(500);
      expect(put).toHaveBeenCalledTimes(1);
      expect(put).toHaveBeenCalledWith({ name: 'Ops' });
    } finally { vi.useRealTimers(); }
  });
});

describe('removed dead settings', () => {
  it('no longer carries the unused view mode or tip flag', () => {
    const s = useSettings.getState() as unknown as Record<string, unknown>;
    expect('mobileViewMode' in s).toBe(false);
    expect('resumeAdviceDismissed' in s).toBe(false);
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

describe('showPrettyHint setting', () => {
  it('defaults to shown and persists the setter', () => {
    useSettings.setState({ showPrettyHint: true });
    expect(useSettings.getState().showPrettyHint).toBe(true);
    useSettings.getState().setShowPrettyHint(false);
    expect(useSettings.getState().showPrettyHint).toBe(false);
    expect(JSON.parse(localStorage.getItem('dispatch:showPrettyHint')!)).toBe(false);
  });
});

describe('showUsageBanner setting (#127)', () => {
  it('defaults to shown and persists under dispatch:usageBanner', () => {
    expect(useSettings.getState().showUsageBanner).toBe(true);
    useSettings.getState().setShowUsageBanner(false);
    expect(useSettings.getState().showUsageBanner).toBe(false);
    expect(JSON.parse(localStorage.getItem('dispatch:usageBanner')!)).toBe(false);
    useSettings.getState().setShowUsageBanner(true);
    expect(JSON.parse(localStorage.getItem('dispatch:usageBanner')!)).toBe(true);
  });
});

describe('text scale', () => {
  const clearFontSize = () => document.documentElement.style.removeProperty('font-size');
  beforeEach(() => { clearFontSize(); useSettings.setState({ textScale: 1 }); });
  afterEach(clearFontSize);

  async function reload() {
    vi.resetModules();
    return (await import('./settings')).useSettings;
  }

  it('clamps to 0.75..1.5 and rounds to 5%', () => {
    expect(clampTextScale(1.53)).toBe(1.5);
    expect(clampTextScale(1.12)).toBe(1.1);
    expect(clampTextScale(0.1)).toBe(0.75);
    expect(clampTextScale(9)).toBe(1.5);
    expect(clampTextScale(1.25)).toBe(1.25);
  });
  it('anything not a finite number is 1', () => {
    for (const junk of ['abc', '1.2', null, undefined, NaN, Infinity, {}, true]) expect(clampTextScale(junk)).toBe(1);
  });
  it('a saved scale loads clamped and rounded', async () => {
    localStorage.setItem('dispatch:textScale', '1.53');
    expect((await reload()).getState().textScale).toBe(1.5);
    localStorage.setItem('dispatch:textScale', '0.1');
    expect((await reload()).getState().textScale).toBe(0.75);
  });
  it('a garbage saved scale loads as 1', async () => {
    localStorage.setItem('dispatch:textScale', '"abc"');
    expect((await reload()).getState().textScale).toBe(1);
    localStorage.setItem('dispatch:textScale', '{not json');
    expect((await reload()).getState().textScale).toBe(1);
  });
  it('a saved scale is applied to <html> at load', async () => {
    localStorage.setItem('dispatch:textScale', '1.2');
    await reload();
    expect(document.documentElement.style.fontSize).toMatch(/19\.2px|16px \* 1\.2/);
  });
  it('a saved scale of 1 leaves no inline font-size at load', async () => {
    localStorage.setItem('dispatch:textScale', '1');
    await reload();
    expect(document.documentElement.style.fontSize).toBe('');
  });
  it('setTextScale saves, applies, and at 1 removes the inline font-size', () => {
    useSettings.getState().setTextScale(1.2);
    expect(useSettings.getState().textScale).toBe(1.2);
    expect(JSON.parse(localStorage.getItem('dispatch:textScale')!)).toBe(1.2);
    expect(document.documentElement.style.fontSize).toMatch(/19\.2px|16px \* 1\.2/);
    useSettings.getState().setTextScale(1);
    expect(document.documentElement.style.fontSize).toBe('');
    expect(document.documentElement.getAttribute('style') ?? '').not.toContain('font-size');
  });
  it('setTextScale clamps, and resetTextScale goes back to 1', () => {
    useSettings.getState().setTextScale(3);
    expect(useSettings.getState().textScale).toBe(1.5);
    useSettings.getState().setTextScale(Number.NaN);
    expect(useSettings.getState().textScale).toBe(1);
    useSettings.getState().setTextScale(0.8);
    useSettings.getState().resetTextScale();
    expect(useSettings.getState().textScale).toBe(1);
    expect(document.documentElement.style.fontSize).toBe('');
  });
});
