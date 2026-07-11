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
    // Mic requires a secure context: on a plain-http origin (e.g. a Tailscale
    // hostname without TLS) mediaDevices doesn't exist at all, and no amount of
    // retrying can ever prompt — say so instead of a misleading "denied".
    if (!navigator.mediaDevices?.getUserMedia) {
      setError('Microphone needs a secure connection — open Dispatch from an https:// address.');
      setState('error');
      return;
    }
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
    } catch (err) {
      teardown();
      // Differentiate the failure: once iOS remembers a "deny" for an installed
      // web app, getUserMedia rejects instantly and only the Settings app can
      // re-allow it — Retry alone will never re-prompt. Tell the user the way out.
      const name = err instanceof DOMException ? err.name : '';
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        setError('Microphone access is blocked. Allow it in Settings → Dispatch → Microphone, then retry.');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setError('No microphone was found on this device.');
      } else if (name === 'NotReadableError') {
        setError('The microphone is in use by another app.');
      } else {
        setError('Could not start the microphone.');
      }
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
