import { describe, it, expect, beforeEach } from 'vitest';
import { memoryBackend, setRecordingBackend, saveRecording, updateRecording, listRecordings, getRecordingBlob, deleteRecording, pruneRecordings, markInterrupted, KEEP_RECORDINGS } from './recordings';

beforeEach(() => { setRecordingBackend(memoryBackend()); });

describe('recordings store (dictation never loses a recording)', () => {
  it('saves a recording with its audio, updates it, lists newest first, reads the blob, deletes', async () => {
    const a = await saveRecording({ mimeType: 'audio/webm', durationMs: 1000, status: 'recording' }, new Blob(['aa']));
    const b = await saveRecording({ mimeType: 'audio/webm', durationMs: 2000, status: 'pending' }, new Blob(['bbb']));
    expect((await listRecordings()).map((r) => r.id)).toEqual([b.id, a.id]);
    await updateRecording(a.id, { status: 'done', text: 'hello' }, new Blob(['aaaa']));
    const got = (await listRecordings()).find((r) => r.id === a.id)!;
    expect(got).toMatchObject({ status: 'done', text: 'hello', bytes: 4 });
    expect((await getRecordingBlob(a.id))!.size).toBe(4);
    await deleteRecording(a.id);
    expect((await listRecordings()).map((r) => r.id)).toEqual([b.id]);
    expect(await getRecordingBlob(a.id)).toBeNull();
  });

  it('keeps the newest recordings only', async () => {
    for (let i = 0; i < KEEP_RECORDINGS + 3; i++) await saveRecording({ mimeType: 'audio/webm', durationMs: i, status: 'done', text: `t${i}` }, new Blob(['x']));
    await pruneRecordings();
    const rows = await listRecordings();
    expect(rows).toHaveLength(KEEP_RECORDINGS);
    expect(rows[0].text).toBe(`t${KEEP_RECORDINGS + 2}`);
  });

  it('a recording left recording or sending at start becomes failed (interrupted), with its audio kept', async () => {
    const a = await saveRecording({ mimeType: 'audio/webm', durationMs: 1, status: 'recording' }, new Blob(['a']));
    const b = await saveRecording({ mimeType: 'audio/webm', durationMs: 1, status: 'sending' }, new Blob(['b']));
    const c = await saveRecording({ mimeType: 'audio/webm', durationMs: 1, status: 'done', text: 'ok' }, new Blob(['c']));
    expect(await markInterrupted()).toBe(2);
    const rows = await listRecordings();
    expect(rows.find((r) => r.id === a.id)).toMatchObject({ status: 'failed', error: expect.stringMatching(/interrupted/) });
    expect(rows.find((r) => r.id === b.id)!.status).toBe('failed');
    expect(rows.find((r) => r.id === c.id)!.status).toBe('done');
    expect(await getRecordingBlob(a.id)).not.toBeNull();
  });
});
