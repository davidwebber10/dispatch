import { describe, it, expect, vi, afterEach } from 'vitest';
import { deepgramAdapter } from './deepgram.js';

afterEach(() => vi.restoreAllMocks());

it('POSTs raw audio to /v1/listen with Token auth and parses nested transcript', async () => {
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
    JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'nested text' }] }] } }), { status: 200 }));
  const out = await deepgramAdapter.transcribe('nova-3', 'dg_key', { audio: Buffer.from('A'), mimeType: 'audio/mp4', keyterms: ['Dispatch'] });
  expect(out.text).toBe('nested text');
  const [url, init] = fetchMock.mock.calls[0];
  expect(String(url)).toContain('https://api.deepgram.com/v1/listen?');
  expect(String(url)).toContain('model=nova-3');
  expect(String(url)).toContain('keyterm=Dispatch');
  expect((init as any).headers.Authorization).toBe('Token dg_key');
  expect((init as any).headers['Content-Type']).toBe('audio/mp4');
});

it('throws on non-2xx', async () => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 403 }));
  await expect(deepgramAdapter.transcribe('nova-3', 'x', { audio: Buffer.from('a'), mimeType: 'audio/webm' })).rejects.toThrow(/deepgram 403/);
});
