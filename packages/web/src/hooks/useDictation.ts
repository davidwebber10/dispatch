import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings } from '../stores/settings';
import { api } from '../api/client';

export type DictationState = 'idle' | 'recording' | 'transcribing' | 'error';

export interface Dictation {
  state: DictationState;
  error: string | null;
  start(): Promise<void>;
  cancel(): void;
  confirm(): Promise<void>;
  reset(): void;
  getAnalyser(): AnalyserNode | null;
}

function pickMimeType(): string {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
  const MR: any = (globalThis as any).MediaRecorder;
  for (const c of cands) if (MR?.isTypeSupported?.(c)) return c;
  return '';
}

export function useDictation(onTranscript: (text: string) => void): Dictation {
  const [state, setState] = useState<DictationState>('idle');
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>('audio/webm');
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const teardown = useCallback(() => {
    try { recorderRef.current?.state === 'recording' && recorderRef.current.stop(); } catch { /* */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { audioCtxRef.current?.close(); } catch { /* */ }
    recorderRef.current = null; streamRef.current = null; analyserRef.current = null; audioCtxRef.current = null;
  }, []);

  // Release mic/AudioContext if the component unmounts mid-recording (teardown is stable, so this runs on unmount only).
  useEffect(() => teardown, [teardown]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];
      const mime = pickMimeType();
      mimeRef.current = mime || 'audio/webm';
      const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
      recorderRef.current = rec;
      // waveform tap
      const Ctx: any = (globalThis as any).AudioContext || (globalThis as any).webkitAudioContext;
      if (Ctx) {
        const ctx = new Ctx(); audioCtxRef.current = ctx;
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser(); analyser.fftSize = 1024;
        src.connect(analyser); analyserRef.current = analyser;
      }
      rec.start();
      setState('recording');
    } catch {
      teardown();
      setError('Microphone permission denied.');
      setState('error');
    }
  }, [teardown]);

  const cancel = useCallback(() => { teardown(); setError(null); setState('idle'); }, [teardown]);
  const reset = useCallback(() => { setError(null); setState('idle'); }, []);

  const confirm = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) { setState('idle'); return; }
    const mime = mimeRef.current;
    const done: Promise<Blob> = new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: mime }));
    });
    try { rec.stop(); } catch { /* */ }
    const blob = await done;
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { audioCtxRef.current?.close(); } catch { /* */ }

    if (blob.size === 0) { teardown(); setState('idle'); return; }

    const { sttProvider, sttModel, sttSecretName } = useSettings.getState();
    if (!sttProvider || !sttModel || !sttSecretName) {
      teardown();
      setError('Set up transcription in Settings → Transcription.');
      setState('error');
      return;
    }
    setState('transcribing');
    try {
      const { text } = await api.transcribe(blob, { provider: sttProvider, model: sttModel, secretName: sttSecretName, mimeType: mime });
      teardown();
      if (text.trim()) onTranscript(text.trim());
      setState('idle');
    } catch (e) {
      teardown();
      setError(e instanceof Error ? e.message : 'Transcription failed.');
      setState('error');
    }
  }, [onTranscript, teardown]);

  const getAnalyser = useCallback(() => analyserRef.current, []);

  return { state, error, start, cancel, confirm, reset, getAnalyser };
}
