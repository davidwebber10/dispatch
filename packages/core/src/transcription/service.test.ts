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
});
