import { describe, it, expect, vi, afterEach } from 'vitest';
import { elevenlabsAdapter } from './elevenlabs.js';

afterEach(() => vi.restoreAllMocks());

it('POSTs multipart to /v1/speech-to-text with xi-api-key + model_id', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ text: 'scribe out', language_code: 'en' }), { status: 200 }));
  const out = await elevenlabsAdapter.transcribe('scribe_v2', 'xi_key', { audio: Buffer.from('A'), mimeType: 'audio/mp4', language: 'en' });
  expect(out.text).toBe('scribe out');
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toBe('https://api.elevenlabs.io/v1/speech-to-text');
  expect((init as any).headers['xi-api-key']).toBe('xi_key');
  const form = (init as any).body as FormData;
  expect(form.get('model_id')).toBe('scribe_v2');
  expect(form.get('language_code')).toBe('en');
});

it('throws on non-2xx', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad', { status: 401 }));
  await expect(elevenlabsAdapter.transcribe('scribe_v2', 'x', { audio: Buffer.from('a'), mimeType: 'audio/webm' })).rejects.toThrow(/elevenlabs 401/);
});
