import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeOpenAICompatibleAdapter, filenameForMime } from './openai-compatible.js';

afterEach(() => vi.restoreAllMocks());

describe('filenameForMime', () => {
  it('maps common mimes to extensions', () => {
    expect(filenameForMime('audio/webm')).toBe('audio.webm');
    expect(filenameForMime('audio/mp4')).toBe('audio.mp4');
    expect(filenameForMime('audio/mpeg')).toBe('audio.mp3');
    expect(filenameForMime('weird/thing')).toBe('audio.webm');
  });
});

describe('openai-compatible adapter', () => {
  it('POSTs multipart to <baseURL>/audio/transcriptions with bearer auth and returns text', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ text: 'hello world', language: 'en' }), { status: 200 }),
    );
    const groq = makeOpenAICompatibleAdapter('groq', 'https://api.groq.com/openai/v1');
    const out = await groq.transcribe('whisper-large-v3-turbo', 'sk-test', {
      audio: Buffer.from('AUDIO'), mimeType: 'audio/mp4', prompt: 'coding',
    });
    expect(out.text).toBe('hello world');
    expect(out.language).toBe('en');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect((init as any).method).toBe('POST');
    expect((init as any).headers.Authorization).toBe('Bearer sk-test');
    expect((init as any).body).toBeInstanceOf(FormData);
    const form = (init as any).body as FormData;
    expect(form.get('model')).toBe('whisper-large-v3-turbo');
    expect(form.get('prompt')).toBe('coding');
  });

  it('throws with status + body on non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('bad key', { status: 401 }));
    const openai = makeOpenAICompatibleAdapter('openai', 'https://api.openai.com/v1');
    await expect(openai.transcribe('whisper-1', 'x', { audio: Buffer.from('a'), mimeType: 'audio/webm' }))
      .rejects.toThrow(/openai 401: bad key/);
  });
});
