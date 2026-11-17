import { describe, it, expect, vi, afterEach } from 'vitest';
import { assemblyaiAdapter, CLEAN_TRANSCRIPT_PROMPT } from './assemblyai.js';

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

// Capture the JSON body that the adapter submits to /v2/transcript.
async function submittedBody(model: string, keyterms?: string[]): Promise<any> {
  let body: any;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any, init: any) => {
    const u = String(url);
    if (u.endsWith('/v2/upload')) return new Response(JSON.stringify({ upload_url: 'u' }), { status: 200 });
    if (u.endsWith('/v2/transcript')) { body = JSON.parse(init.body); return new Response(JSON.stringify({ id: 't', status: 'queued' }), { status: 200 }); }
    return new Response(JSON.stringify({ status: 'completed', text: 'ok' }), { status: 200 });
  });
  await assemblyaiAdapter.transcribe(model, 'k', { audio: Buffer.from('a'), mimeType: 'audio/webm', keyterms });
  return body;
}

describe('filler request settings', () => {
  it('turns disfluencies off and sends the clean-transcript prompt on universal-3-pro', async () => {
    const b = await submittedBody('universal-3-pro');
    expect(b.disfluencies).toBe(false);
    expect(b.prompt).toBe(CLEAN_TRANSCRIPT_PROMPT);
    expect(b.prompt).toMatch(/um, uh/);
    expect(b.speech_models).toEqual(['universal-3-pro']);
  });

  it('sends the prompt on assemblyai-stt-3-7 too', async () => {
    const b = await submittedBody('assemblyai-stt-3-7');
    expect(b.disfluencies).toBe(false);
    expect(b.prompt).toBe(CLEAN_TRANSCRIPT_PROMPT);
  });

  it('sends disfluencies but no prompt on universal-2, which rejects a prompt with HTTP 400', async () => {
    const b = await submittedBody('universal-2');
    expect(b.disfluencies).toBe(false);
    expect(b).not.toHaveProperty('prompt');
  });

  it('keeps keyterms_prompt alongside the prompt', async () => {
    const b = await submittedBody('universal-3-pro', ['Quillon Vexhammer']);
    expect(b.keyterms_prompt).toEqual(['Quillon Vexhammer']);
    expect(b.prompt).toBe(CLEAN_TRANSCRIPT_PROMPT);
  });

  it('keeps keyterms_prompt on universal-2 without a prompt', async () => {
    const b = await submittedBody('universal-2', ['Zyntrella']);
    expect(b.keyterms_prompt).toEqual(['Zyntrella']);
    expect(b).not.toHaveProperty('prompt');
  });
});
