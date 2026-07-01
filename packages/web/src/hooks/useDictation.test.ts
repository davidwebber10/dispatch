import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDictation } from './useDictation';
import { useSettings } from '../stores/settings';

vi.mock('../api/client', () => ({ api: { transcribe: vi.fn().mockResolvedValue({ text: 'spoken text' }) } }));
import { api } from '../api/client';

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
  (api.transcribe as any).mockClear();
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
