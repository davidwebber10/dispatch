import { describe, it, expect, vi, afterEach } from 'vitest';
import { assemblyaiAdapter } from './assemblyai.js';

afterEach(() => vi.restoreAllMocks());

it('uploads, submits, then polls until completed', async () => {
  const calls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
    const u = String(url); calls.push(u);
    if (u.endsWith('/v2/upload')) return new Response(JSON.stringify({ upload_url: 'https://cdn/aai/xyz' }), { status: 200 });
    if (u.endsWith('/v2/transcript')) return new Response(JSON.stringify({ id: 'tid-1', status: 'queued' }), { status: 200 });
    if (u.endsWith('/v2/transcript/tid-1')) return new Response(JSON.stringify({ status: 'completed', text: 'aai done' }), { status: 200 });
    return new Response('?', { status: 404 });
  });
  const out = await assemblyaiAdapter.transcribe('universal-3-pro', 'aai_key', { audio: Buffer.from('A'), mimeType: 'audio/mp4' });
  expect(out.text).toBe('aai done');
  expect(calls[0]).toContain('/v2/upload');
  expect(calls[1]).toContain('/v2/transcript');
  expect(calls[2]).toContain('/v2/transcript/tid-1');
});

it('throws when the job errors', async () => {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
    const u = String(url);
    if (u.endsWith('/v2/upload')) return new Response(JSON.stringify({ upload_url: 'u' }), { status: 200 });
    if (u.endsWith('/v2/transcript')) return new Response(JSON.stringify({ id: 't2', status: 'queued' }), { status: 200 });
    return new Response(JSON.stringify({ status: 'error', error: 'decode failed' }), { status: 200 });
  });
  await expect(assemblyaiAdapter.transcribe('universal-2', 'x', { audio: Buffer.from('a'), mimeType: 'audio/webm' })).rejects.toThrow(/decode failed/);
});
