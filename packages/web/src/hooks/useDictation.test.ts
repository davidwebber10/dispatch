import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDictation } from './useDictation';
import { useSettings } from '../stores/settings';

// The transcription job is mocked: it reports its stages and answers like the daemon would.
const job = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../lib/transcribeJob', () => ({ runTranscription: (...a: unknown[]) => job.run(...a) }));
import { memoryBackend, setRecordingBackend, listRecordings, getRecordingBlob } from '../lib/recordings';
const api = { transcribe: job.run };

// Minimal Web-API mocks (jsdom lacks these).
class FakeRecorder {
  static isTypeSupported = () => true;
  state = 'inactive'; ondataavailable: any = null; onstop: any = null;
  constructor(public stream: any, public opts: any) {}
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) }); this.onstop?.(); }
}
// Observable spies for the mic track + AudioContext (reset per test).
let micTrackStop: ReturnType<typeof vi.fn>;
let audioCtxInstances: Array<{ close: ReturnType<typeof vi.fn> }>;

beforeEach(() => {
  (globalThis as any).MediaRecorder = FakeRecorder;
  audioCtxInstances = [];
  (globalThis as any).AudioContext = class {
    close = vi.fn();
    constructor() { audioCtxInstances.push(this); }
    createMediaStreamSource() { return { connect() {} }; }
    createAnalyser() { return { fftSize: 0, frequencyBinCount: 32, getByteFrequencyData() {} }; }
  };
  micTrackStop = vi.fn();
  (navigator as any).mediaDevices = { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: micTrackStop }] }) };
  useSettings.setState({ sttProvider: 'groq', sttModel: 'whisper-large-v3-turbo', sttSecretName: 'GROQ_API_KEY' });
  setRecordingBackend(memoryBackend());
  job.run.mockReset();
  job.run.mockImplementation(async (_id: string, _o: unknown, onPhase: (p: unknown) => void) => { onPhase({ phase: 'uploading', pct: 0.5 }); onPhase({ phase: 'transcribing' }); return 'spoken text'; });
});

it('records then confirms → transcribes → fires onTranscript → idle', async () => {
  const onTranscript = vi.fn();
  const { result } = renderHook(() => useDictation(onTranscript));
  await act(async () => { await result.current.start(); });
  expect(result.current.state).toBe('recording');
  await act(async () => { await result.current.confirm(); });
  await waitFor(() => expect(result.current.state).toBe('idle'));
  expect(api.transcribe).toHaveBeenCalledTimes(1);
  expect(onTranscript).toHaveBeenCalledWith('spoken text');
});

it('unmounting while recording releases the mic track + AudioContext', async () => {
  const onTranscript = vi.fn();
  const { result, unmount } = renderHook(() => useDictation(onTranscript));
  await act(async () => { await result.current.start(); });
  expect(result.current.state).toBe('recording');
  expect(audioCtxInstances).toHaveLength(1);
  const ctxClose = audioCtxInstances[0].close;
  unmount();
  expect(micTrackStop).toHaveBeenCalled();
  expect(ctxClose).toHaveBeenCalled();
});

it('errors (no upload) when transcription is not configured', async () => {
  useSettings.setState({ sttSecretName: '' });
  const onTranscript = vi.fn();
  const { result } = renderHook(() => useDictation(onTranscript));
  await act(async () => { await result.current.start(); });
  await act(async () => { await result.current.confirm(); });
  await waitFor(() => expect(result.current.state).toBe('error'));
  expect(result.current.error).toMatch(/Settings/i);
  expect(api.transcribe).not.toHaveBeenCalled();
});

describe('keeping a long dictation (2026-11-06)', () => {
  const setHidden = (h: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  it('holds a screen wake lock while recording and lets it go when recording ends', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn().mockResolvedValue({ release });
    (navigator as any).wakeLock = { request };
    const { result } = renderHook(() => useDictation(vi.fn()));
    await act(async () => { await result.current.start(); });
    expect(request).toHaveBeenCalledWith('screen');
    await act(async () => { await result.current.confirm(); });
    expect(release).toHaveBeenCalled();
    delete (navigator as any).wakeLock;
  });

  it('records fine where wake lock is not supported', async () => {
    delete (navigator as any).wakeLock;
    const { result } = renderHook(() => useDictation(vi.fn()));
    await act(async () => { await result.current.start(); });
    expect(result.current.state).toBe('recording');
  });

  it('if the phone locks mid-recording, what was said is transcribed, not lost', async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useDictation(onTranscript));
    await act(async () => { await result.current.start(); });
    await act(async () => { setHidden(true); });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('spoken text'));
    setHidden(false);
  });
});

describe('never lose a recording; say what is happening (2026-11-07)', () => {
  it('saves the recording before it is sent; the stages show; the recording is kept with its id', async () => {
    const seen: string[] = [];
    let release: (t: string) => void = () => {};
    job.run.mockImplementation((_id: string, _o: unknown, onPhase: (p: any) => void) => new Promise((res) => { onPhase({ phase: 'uploading', pct: 0.4 }); release = (t) => { onPhase({ phase: 'transcribing' }); res(t); }; }));
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useDictation(onTranscript));
    await act(async () => { await result.current.start(); });
    let done: Promise<void> = Promise.resolve();
    await act(async () => { done = result.current.confirm(); });
    await waitFor(() => expect(result.current.state).toBe('uploading'));
    seen.push(`${result.current.state} ${Math.round((result.current.progress.pct ?? 0) * 100)}`);
    const rows = await listRecordings();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect((await getRecordingBlob(rows[0].id))!.size).toBeGreaterThan(0);
    expect(result.current.recordingId).toBe(rows[0].id);
    await act(async () => { release('kept text'); await done; });
    expect(seen).toEqual(['uploading 40']);
    expect(onTranscript).toHaveBeenCalledWith('kept text');
    expect(result.current.state).toBe('idle');
  });

  it('a failed transcription keeps the recording; Retry sends the SAME recording, not a new one', async () => {
    job.run.mockRejectedValueOnce(new Error('Network error: the upload did not reach Dispatch.'));
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useDictation(onTranscript));
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.confirm(); });
    expect(result.current.state).toBe('error');
    expect(result.current.error).toMatch(/Network error/);
    const id = result.current.recordingId;
    expect(id).toBeTruthy();
    await act(async () => { await result.current.retry(); });
    expect(job.run).toHaveBeenCalledTimes(2);
    expect(job.run.mock.calls[1][0]).toBe(id);
    expect(onTranscript).toHaveBeenCalledWith('spoken text');
    expect(await listRecordings()).toHaveLength(1);
  });

  it('keeps the screen awake until the text is back, not only while recording', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    (navigator as any).wakeLock = { request: vi.fn().mockResolvedValue({ release }) };
    let finish: () => void = () => {};
    job.run.mockImplementation(() => new Promise((res) => { finish = () => res('t'); }));
    const { result } = renderHook(() => useDictation(vi.fn()));
    await act(async () => { await result.current.start(); });
    let done: Promise<void> = Promise.resolve();
    await act(async () => { done = result.current.confirm(); });
    expect(release).not.toHaveBeenCalled();
    await act(async () => { finish(); await done; });
    expect(release).toHaveBeenCalled();
    delete (navigator as any).wakeLock;
  });

  it('with dictation not set up, the recording is kept (failed) for later', async () => {
    useSettings.setState({ sttSecretName: '' });
    const { result } = renderHook(() => useDictation(vi.fn()));
    await act(async () => { await result.current.start(); });
    await act(async () => { await result.current.confirm(); });
    const rows = await listRecordings();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/Settings/) });
  });
});

describe('back from a lock (2026-11-07)', () => {
  const setHidden = (h: boolean) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  it('a network failure while the app was hidden is retried once when it comes back', async () => {
    job.run.mockRejectedValueOnce(new Error('Network error: the upload did not reach Dispatch.'));
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useDictation(onTranscript));
    await act(async () => { await result.current.start(); });
    await act(async () => { setHidden(true); });
    await waitFor(() => expect(result.current.state).toBe('error'));
    await act(async () => { setHidden(false); });
    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('spoken text'));
    expect(job.run).toHaveBeenCalledTimes(2);
  });
});
