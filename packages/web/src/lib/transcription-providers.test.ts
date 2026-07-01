import { describe, it, expect } from 'vitest';
import { PROVIDERS, getProvider } from './transcription-providers';

it('exposes ready providers with models and defaults matching the store', () => {
  const groq = getProvider('groq');
  expect(groq?.status).toBe('ready');
  expect(groq?.models.map((m) => m.id)).toContain('whisper-large-v3-turbo');
  expect(PROVIDERS.find((p) => p.id === 'google')?.status).toBe('coming-soon');
});
