import { describe, it, expect } from 'vitest';
import { adoptTranscriptSettings } from './thread-settings.js';

describe('adoptTranscriptSettings', () => {
  it('saves a model and effort the owner changed inside the thread', () => {
    const cfg: Record<string, any> = { model: 'fable' };
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5', effort: 'high' })).toBe(true);
    expect(cfg).toEqual({ model: 'claude-opus-5-5', effort: 'high' });
  });
  it('keeps a tier alias while the transcript model is the same family', () => {
    const cfg: Record<string, any> = { model: 'opus' };
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5' })).toBe(false);
    expect(cfg.model).toBe('opus');
  });
  it('saves the model when none was saved', () => {
    const cfg: Record<string, any> = {};
    expect(adoptTranscriptSettings(cfg, { model: 'claude-sonnet-5-5' })).toBe(true);
    expect(cfg.model).toBe('claude-sonnet-5-5');
  });
  it('reports no change when nothing differs', () => {
    const cfg: Record<string, any> = { model: 'claude-opus-5-5', effort: 'high' };
    expect(adoptTranscriptSettings(cfg, { model: 'claude-opus-5-5', effort: 'high' })).toBe(false);
  });
  it('never overrides a coordinator, role or agent-type thread', () => {
    for (const extra of [{ role: 'coordinator' }, { role: 'agent' }, { agentType: 'reviewer' }]) {
      const cfg: Record<string, any> = { model: 'fable', ...extra };
      expect(adoptTranscriptSettings(cfg, { model: 'claude-haiku-5-5', effort: 'low' })).toBe(false);
      expect(cfg.model).toBe('fable');
      expect(cfg.effort).toBeUndefined();
    }
  });
  it('does nothing without a transcript', () => {
    const cfg: Record<string, any> = { model: 'fable' };
    expect(adoptTranscriptSettings(cfg, null)).toBe(false);
  });
});
