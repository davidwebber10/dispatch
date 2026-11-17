import { describe, it, expect, vi } from 'vitest';
import { TranscriptionService } from './service.js';
import type { ProviderEntry } from './registry.js';

function reg(overrides: Partial<Record<string, ProviderEntry>> = {}): Record<string, ProviderEntry> {
  return {
    groq: { id: 'groq', label: 'Groq', models: ['whisper-large-v3-turbo'], status: 'ready',
      adapter: { id: 'groq', transcribe: vi.fn().mockResolvedValue({ text: 'hi', raw: {} }) } },
    google: { id: 'google', label: 'Google', models: [], status: 'coming-soon', adapter: null },
    ...overrides,
  };
}

const secrets = (val: string | null) => ({ getSecret: vi.fn().mockResolvedValue(val) }) as any;

describe('TranscriptionService', () => {
  it('resolves the key and calls the provider adapter', async () => {
    const registry = reg();
    const svc = new TranscriptionService(secrets('gsk_x'), registry);
    const out = await svc.transcribe({ provider: 'groq', model: 'whisper-large-v3-turbo', secretName: 'GROQ_API_KEY', audio: Buffer.from('a'), mimeType: 'audio/webm', prompt: 'p' });
    expect(out.text).toBe('hi');
    expect(registry.groq.adapter!.transcribe).toHaveBeenCalledWith('whisper-large-v3-turbo', 'gsk_x', expect.objectContaining({ mimeType: 'audio/webm', prompt: 'p' }));
  });

  it('rejects unknown or coming-soon providers', async () => {
    const svc = new TranscriptionService(secrets('k'), reg());
    await expect(svc.transcribe({ provider: 'nope', model: 'm', secretName: 's', audio: Buffer.from('a'), mimeType: 'audio/webm' })).rejects.toThrow(/Unknown or unavailable/);
    await expect(svc.transcribe({ provider: 'google', model: 'm', secretName: 's', audio: Buffer.from('a'), mimeType: 'audio/webm' })).rejects.toThrow(/Unknown or unavailable/);
  });

  it('rejects when the secret is missing', async () => {
    const svc = new TranscriptionService(secrets(null), reg());
    await expect(svc.transcribe({ provider: 'groq', model: 'whisper-large-v3-turbo', secretName: 'X', audio: Buffer.from('a'), mimeType: 'audio/webm' })).rejects.toThrow(/Secret not found/);
  });

  describe('filler cleanup', () => {
    const TEXT = 'So, um, I think we should, uh, go.';
    const CLEAN = 'So, I think we should go.';
    const run = (text: string, language?: string, reported?: string) => {
      const registry = reg({
        groq: { id: 'groq', label: 'Groq', models: ['m'], status: 'ready',
          adapter: { id: 'groq', transcribe: vi.fn().mockResolvedValue({ text, language: reported, raw: { text } }) } },
      });
      return new TranscriptionService(secrets('k'), registry)
        .transcribe({ provider: 'groq', model: 'm', secretName: 'S', audio: Buffer.from('a'), mimeType: 'audio/webm', language });
    };

    it('removes fillers when the provider reports English, and keeps the provider response in raw', async () => {
      const out = await run(TEXT, undefined, 'en');
      expect(out.text).toBe(CLEAN);
      expect(out.raw).toEqual({ text: TEXT });
    });

    it.each(['en', 'en_us', 'en-GB', 'english', 'eng'])('cleans when the provider reports %s', async (code) => {
      expect((await run(TEXT, undefined, code)).text).toBe(CLEAN);
    });

    it('leaves the text alone when no language comes back and none was asked for', async () => {
      expect((await run(TEXT)).text).toBe(TEXT);
      expect((await run('Wo ist er? Um fünf Uhr.')).text).toBe('Wo ist er? Um fünf Uhr.');
    });

    it('cleans when the provider reports nothing but the caller asked for English', async () => {
      expect((await run(TEXT, 'en')).text).toBe(CLEAN);
    });

    it('leaves the text alone when the caller asked for another language', async () => {
      expect((await run('Wo ist er? Um fünf Uhr.', 'de')).text).toBe('Wo ist er? Um fünf Uhr.');
      expect((await run(TEXT, 'de', 'en')).text).toBe(TEXT);
    });

    it('leaves the text alone when the provider reports another language', async () => {
      expect((await run('Wo ist er? Um fünf Uhr.', undefined, 'german')).text).toBe('Wo ist er? Um fünf Uhr.');
      expect((await run('Wo ist er? Um fünf Uhr.', 'en', 'de')).text).toBe('Wo ist er? Um fünf Uhr.');
    });
  });
});
