import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings } from '../stores/settings';
import { saveRecording, updateRecording } from '../lib/recordings';
import { runTranscription, type Phase } from '../lib/transcribeJob';

export type DictationState = 'idle' | 'recording' | 'uploading' | 'transcribing' | 'error';

export interface Dictation {
  state: DictationState;
  error: string | null;
  /** Uploading: the fraction sent. Transcribing: the seconds since the upload finished. */
  progress: { pct?: number; elapsedS?: number };
  /** The saved recording this dictation is about (kept on the device until it is transcribed). */
  recordingId: string | null;
  start(): Promise<void>;
  cancel(): void;
  confirm(): Promise<void>;
  /** After a failure: send the same saved recording again (or start a new one when there is none). */
  retry(): Promise<void>;
  reset(): void;
  getAnalyser(): AnalyserNode | null;
  /** Insert a transcript from elsewhere (the Recordings sheet) the way a dictation does. */
  insert(text: string): void;
}

/** While recording, what was said is written to the device this often. */
const PERSIST_MS = 4000;

function pickMimeType(): string {
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
  const MR: any = (globalThis as any).MediaRecorder;
  for (const c of cands) if (MR?.isTypeSupported?.(c)) return c;
  return '';
}

export function useDictation(onTranscript: (text: string) => void): Dictation {
  const [state, setState] = useState<DictationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ pct?: number; elapsedS?: number }>({});
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const recIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<number>(0);
  const persistTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeRef = useRef<string>('audio/webm');
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  // Keep the screen on while recording (2026-11-06): a long dictation let the phone lock, and the
  // recording was lost. Released when recording ends; the browser drops it when the page hides.
  const wakeRef = useRef<{ release(): Promise<void> } | null>(null);
  const lockScreen = useCallback(async () => {
    try {
      const wl = (navigator as unknown as { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (wl && !wakeRef.current) wakeRef.current = await wl.request('screen');
    } catch { /* not supported, or refused (low power mode): recording still works */ }
  }, []);
  const unlockScreen = useCallback(() => {
    const w = wakeRef.current;
    wakeRef.current = null;
    void w?.release().catch(() => { /* already released */ });
  }, []);

  const stopPersisting = () => { if (persistTimer.current) { clearInterval(persistTimer.current); persistTimer.current = null; } };
  const teardown = useCallback(() => {
    stopPersisting();
    unlockScreen();
    try { recorderRef.current?.state === 'recording' && recorderRef.current.stop(); } catch { /* */ }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { audioCtxRef.current?.close(); } catch { /* */ }
    recorderRef.current = null; streamRef.current = null; analyserRef.current = null; audioCtxRef.current = null;
  }, [unlockScreen]);

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
      // One-second slices: what was said is already in hand if the page is interrupted.
      rec.start(1000);
      setState('recording');
      setProgress({});
      void lockScreen();
      // Saved on the device from the first seconds: a lock, a crash or a reload keeps what was said.
      startedAtRef.current = Date.now();
      recIdRef.current = null; setRecordingId(null);
      void saveRecording({ mimeType: mimeRef.current, durationMs: 0, status: 'recording' }, new Blob([], { type: mimeRef.current }))
        .then((r) => { recIdRef.current = r.id; setRecordingId(r.id); })
        .catch(() => { /* no storage: the recording still works, it is just not kept */ });
      persistTimer.current = setInterval(() => {
        const id = recIdRef.current;
        if (id) void updateRecording(id, { durationMs: Date.now() - startedAtRef.current }, new Blob(chunksRef.current, { type: mimeRef.current })).catch(() => {});
      }, PERSIST_MS);
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
  }, [teardown, lockScreen]);

  const cancel = useCallback(() => {
    teardown(); setError(null); setState('idle');
    // Cancel means "not this one": the saved copy goes too.
    const id = recIdRef.current; recIdRef.current = null; setRecordingId(null);
    if (id) void import('../lib/recordings').then((m) => m.deleteRecording(id)).catch(() => {});
  }, [teardown]);
  const reset = useCallback(() => { setError(null); setProgress({}); setState('idle'); }, []);

  // Seconds while the provider works: a long recording takes a while, and the screen says so.
  const transcribingSince = useRef<number>(0);
  useEffect(() => {
    if (state !== 'transcribing') return;
    transcribingSince.current = Date.now();
    setProgress({ elapsedS: 0 });
    const t = setInterval(() => setProgress({ elapsedS: Math.floor((Date.now() - transcribingSince.current) / 1000) }), 1000);
    return () => clearInterval(t);
  }, [state]);

  /** Send a saved recording; the screen stays awake until the text is back. */
  const transcribeSaved = useCallback(async (id: string) => {
    const { sttProvider, sttModel, sttSecretName } = useSettings.getState();
    if (!sttProvider || !sttModel || !sttSecretName) {
      await updateRecording(id, { status: 'failed', error: 'Set up dictation in Settings → Dictation, then transcribe it from Recordings.' }).catch(() => {});
      unlockScreen();
      setError('Set up dictation in Settings → Dictation. The recording is kept.');
      setState('error');
      return;
    }
    void lockScreen();
    setError(null);
    setState('uploading'); setProgress({ pct: 0 });
    try {
      const text = await runTranscription(id, { provider: sttProvider, model: sttModel, secretName: sttSecretName }, (p: Phase) => {
        if (p.phase === 'uploading') { setState('uploading'); setProgress({ pct: p.pct }); }
        else setState('transcribing');
      });
      unlockScreen();
      if (text) onTranscript(text);
      setProgress({});
      setState('idle');
    } catch (e) {
      unlockScreen();
      setError(`${e instanceof Error ? e.message : 'Transcription failed.'} The recording is kept.`);
      setState('error');
    }
  }, [onTranscript, lockScreen, unlockScreen]);

  const confirm = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) { setState('idle'); return; }
    const mime = mimeRef.current;
    const done: Promise<Blob> = new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(chunksRef.current, { type: mime }));
    });
    try { rec.stop(); } catch { /* */ }
    stopPersisting();
    const blob = await done;
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* */ }
    try { audioCtxRef.current?.close(); } catch { /* */ }
    recorderRef.current = null; streamRef.current = null; analyserRef.current = null; audioCtxRef.current = null;

    if (blob.size === 0) { unlockScreen(); setState('idle'); return; }
    // The final audio is on the device before anything is sent.
    const durationMs = Date.now() - startedAtRef.current;
    let id = recIdRef.current;
    try {
      if (id && await updateRecording(id, { status: 'pending', durationMs }, blob)) { /* updated */ }
      else { id = (await saveRecording({ mimeType: mime, durationMs, status: 'pending' }, blob)).id; }
    } catch { id = null; }
    if (!id) {
      unlockScreen();
      setError('Could not keep the recording on this device.');
      setState('error');
      return;
    }
    recIdRef.current = id; setRecordingId(id);
    await transcribeSaved(id);
  }, [transcribeSaved, unlockScreen]);

  const retry = useCallback(async () => {
    const id = recIdRef.current;
    if (id) await transcribeSaved(id);
    else await start();
  }, [transcribeSaved, start]);

  const insert = useCallback((text: string) => { if (text.trim()) onTranscript(text.trim()); }, [onTranscript]);

  // If the phone locks or the app goes to the background anyway, keep what was said: stop and
  // transcribe it now (it is inserted when the request returns). Coming back takes the wake lock
  // again in case only the screen dimmed.
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  useEffect(() => {
    if (state !== 'recording') return;
    const onVisibility = () => {
      if (document.hidden) void confirmRef.current();
      else void lockScreen();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [state, lockScreen]);

  // Back from a lock: a network failure while hidden (the phone suspended the upload) is retried once.
  const autoRetried = useRef<string | null>(null);
  const retryRef = useRef(retry);
  retryRef.current = retry;
  useEffect(() => {
    if (state !== 'error') return;
    const onVisibility = () => {
      const id = recIdRef.current;
      if (document.hidden || !id || autoRetried.current === id || !/network error/i.test(error ?? '')) return;
      autoRetried.current = id;
      void retryRef.current();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [state, error]);

  const getAnalyser = useCallback(() => analyserRef.current, []);

  return { state, error, progress, recordingId, start, cancel, confirm, retry, reset, getAnalyser, insert };
}
