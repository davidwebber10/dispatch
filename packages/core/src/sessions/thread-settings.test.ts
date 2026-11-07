import { describe, it, expect } from 'vitest';
import { adoptTranscriptSettings } from './thread-settings.js';

describe('adoptTranscriptSettings', () => {
  it('saves the family alias and a changed effort when the owner switched inside the thread', () => {
    const cfg: Record<string, any> = { model: 'fable' };
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5', effort: 'high', effortChanged: true })).toBe(true);
    expect(cfg).toEqual({ model: 'opus', effort: 'high' });
  });
  it('keeps other config keys', () => {
    const cfg: Record<string, any> = { model: 'fable', pinned: true, transport: 'structured' };
    adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5' });
    expect(cfg).toEqual({ model: 'opus', pinned: true, transport: 'structured' });
  });
  it('keeps a tier alias while the transcript model is the same family', () => {
    const cfg: Record<string, any> = { model: 'opus' };
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5' })).toBe(false);
    expect(cfg.model).toBe('opus');
  });
  it('saves the family alias, not the full id, when no model was saved (new versions keep arriving)', () => {
    const cfg: Record<string, any> = {};
    expect(adoptTranscriptSettings(cfg, { model: 'claude-sonnet-5-5' })).toBe(true);
    expect(cfg.model).toBe('sonnet');
  });
  it('saves a 1M variant or an unknown family as the full id', () => {
    const a: Record<string, any> = { model: 'opus' };
    adoptTranscriptSettings(a, { model: 'claude-opus-4-8[1m]' });
    expect(a.model).toBe('claude-opus-4-8[1m]');
    const b: Record<string, any> = {};
    adoptTranscriptSettings(b, { model: 'claude-mystery-9' });
    expect(b.model).toBe('claude-mystery-9');
  });
  it('does not pin an effort that never changed (it is just the model default)', () => {
    const cfg: Record<string, any> = { model: 'opus' };
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5', effort: 'high', effortChanged: false })).toBe(false);
    expect(cfg.effort).toBeUndefined();
  });
  it('follows later effort changes once an effort is saved', () => {
    const cfg: Record<string, any> = { model: 'opus', effort: 'high' };
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5', effort: 'max', effortChanged: false })).toBe(true);
    expect(cfg.effort).toBe('max');
  });
  it('reports no change when nothing differs', () => {
    const cfg: Record<string, any> = { model: 'claude-opus-5-5', effort: 'high' };
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5', effort: 'high' })).toBe(false);
  });
  it('never overrides a coordinator, role or agent-type thread', () => {
    for (const extra of [{ role: 'coordinator' }, { role: 'agent' }, { agentType: 'reviewer' }]) {
      const cfg: Record<string, any> = { model: 'fable', ...extra };
      expect(adoptTranscriptSettings(cfg, { model: 'claude-haiku-5-5', effort: 'low', effortChanged: true })).toBe(false);
      expect(cfg.model).toBe('fable');
      expect(cfg.effort).toBeUndefined();
    }
  });
  it('does nothing without a transcript', () => {
    expect(adoptTranscriptSettings({ model: 'fable' }, null)).toBe(false);
  });
});

// Review round 1 (PR #155): a pick made in the picker must win over what the transcript shows.
describe('adoptTranscriptSettings — a saved pick wins over the transcript', () => {
  it('keeps a picked model while the transcript still shows the old one', () => {
    const cfg: Record<string, any> = { model: 'haiku', settingsPinned: { model: true } };
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5' })).toBe(false);
    expect(cfg).toEqual({ model: 'haiku', settingsPinned: { model: true } });
  });
  it('lets go of the pin once the transcript shows the pick took hold, and follows the CLI after that', () => {
    const cfg: Record<string, any> = { model: 'haiku', settingsPinned: { model: true } };
    expect(adoptTranscriptSettings(cfg, { model: 'claude-haiku-5-5' })).toBe(true);
    expect(cfg.settingsPinned).toBeUndefined();
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5' })).toBe(true);
    expect(cfg.model).toBe('opus');
  });
  it('a picked Default (no saved model) is not filled in from the transcript', () => {
    const cfg: Record<string, any> = { settingsPinned: { model: true } };
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5' })).toBe(false);
    expect(cfg.model).toBeUndefined();
    expect(cfg.settingsPinned).toEqual({ model: true });
  });
  it('keeps a picked effort over a different transcript effort, then releases it when they match', () => {
    const cfg: Record<string, any> = { model: 'opus', effort: 'low', settingsPinned: { effort: true } };
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5', effort: 'high', effortChanged: true })).toBe(false);
    expect(cfg.effort).toBe('low');
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5', effort: 'low', effortChanged: true })).toBe(true);
    expect(cfg.settingsPinned).toBeUndefined();
  });
  it('pins are per setting: a pinned effort does not stop the model from following the CLI', () => {
    const cfg: Record<string, any> = { model: 'opus', effort: 'low', settingsPinned: { effort: true } };
    adoptTranscriptSettings(cfg, { model: 'claude-fable-5-1', effort: 'high', effortChanged: true });
    expect(cfg).toMatchObject({ model: 'fable', effort: 'low' });
  });
});
