import { describe, it, expect, beforeEach, vi } from 'vitest';
import { memoryBackend, setRecordingBackend, saveRecording, listRecordings } from './recordings';
import { runTranscription, TranscribeHttpError, type Transport } from './transcribeJob';

const opts = { provider: 'groq', model: 'm', secretName: 'K' };
beforeEach(() => { setRecordingBackend(memoryBackend()); });

describe('runTranscription', () => {
  it('reports upload progress then the transcribing phase, stores the text, and returns it', async () => {
    const rec = await saveRecording({ mimeType: 'audio/webm', durationMs: 1, status: 'pending' }, new Blob(['audio']));
    const phases: string[] = [];
    const transport: Transport = async (_blob, _o, on) => { on.upload(0.5); on.upload(1); on.uploaded(); return { text: ' hi there ' }; };
    const text = await runTranscription(rec.id, opts, (p) => phases.push(p.phase === 'uploading' ? `up ${Math.round(p.pct * 100)}` : p.phase), { transport, sleep: async () => {} });
    expect(text).toBe('hi there');
    expect(phases).toEqual(['up 0', 'up 50', 'up 100', 'transcribing']);
    expect((await listRecordings())[0]).toMatchObject({ status: 'done', text: 'hi there', attempts: 1 });
  });

  it('a network failure retries twice and then fails, keeping the recording with the error', async () => {
    const rec = await saveRecording({ mimeType: 'audio/webm', durationMs: 1, status: 'pending' }, new Blob(['audio']));
    const transport = vi.fn<Transport>(async () => { throw new Error('Network error'); });
    const sleep = vi.fn(async (_ms: number) => {});
    await expect(runTranscription(rec.id, opts, () => {}, { transport, sleep })).rejects.toThrow(/Network error/);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 3000]);
    expect((await listRecordings())[0]).toMatchObject({ status: 'failed', error: 'Network error', attempts: 3 });
  });

  it('a network failure then success stores the text', async () => {
    const rec = await saveRecording({ mimeType: 'audio/webm', durationMs: 1, status: 'pending' }, new Blob(['audio']));
    let n = 0;
    const transport: Transport = async (_b, _o, on) => { n++; if (n === 1) throw new Error('Network error'); on.uploaded(); return { text: 'second time' }; };
    expect(await runTranscription(rec.id, opts, () => {}, { transport, sleep: async () => {} })).toBe('second time');
    expect((await listRecordings())[0]).toMatchObject({ status: 'done', attempts: 2 });
  });

  it('an HTTP 4xx (configuration) does not retry', async () => {
    const rec = await saveRecording({ mimeType: 'audio/webm', durationMs: 1, status: 'pending' }, new Blob(['audio']));
    const transport = vi.fn<Transport>(async () => { throw new TranscribeHttpError(400, 'Secret GROQ_API_KEY not found'); });
    await expect(runTranscription(rec.id, opts, () => {}, { transport, sleep: async () => {} })).rejects.toThrow(/not found/);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('an unknown recording id fails plainly', async () => {
    await expect(runTranscription('nope', opts, () => {}, { transport: async () => ({ text: '' }), sleep: async () => {} })).rejects.toThrow(/recording is gone/);
  });
});
