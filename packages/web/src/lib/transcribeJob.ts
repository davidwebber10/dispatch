import { apiPath } from './basePath';
import { getRecording, getRecordingBlob, updateRecording } from './recordings';

/**
 * One transcription of a saved recording, with its stages for the screen: uploading (a fraction),
 * then transcribing (the daemon is waiting on the provider). A network failure retries twice
 * (1 s, 3 s); an HTTP answer does not (a 4xx is the setup, a 5xx the provider's own message). The
 * result, or the error, is written to the recording, so nothing said is lost.
 */
export type Phase = { phase: 'uploading'; pct: number } | { phase: 'transcribing' };
export interface TranscribeOptions { provider: string; model: string; secretName: string; language?: string }
export interface TransportEvents { upload(fraction: number): void; uploaded(): void }
export type Transport = (blob: Blob, o: TranscribeOptions & { mimeType: string }, on: TransportEvents) => Promise<{ text: string }>;

export class TranscribeHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** The upload with progress (fetch has none): XMLHttpRequest. */
export const xhrTransport: Transport = (blob, o, on) => new Promise((resolve, reject) => {
  const fd = new FormData();
  fd.append('file', blob, 'audio');
  fd.append('provider', o.provider); fd.append('model', o.model); fd.append('secretName', o.secretName); fd.append('mimeType', o.mimeType);
  if (o.language) fd.append('language', o.language);
  const xhr = new XMLHttpRequest();
  xhr.open('POST', apiPath('/api/transcribe'));
  xhr.timeout = 5 * 60 * 1000;
  xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total > 0) on.upload(e.loaded / e.total); };
  xhr.upload.onload = () => { on.upload(1); on.uploaded(); };
  xhr.onload = () => {
    let body: { text?: string; error?: string } = {};
    try { body = JSON.parse(xhr.responseText || '{}'); } catch { body = {}; }
    if (xhr.status >= 200 && xhr.status < 300) resolve({ text: String(body.text ?? '') });
    else reject(new TranscribeHttpError(xhr.status, body.error || `Transcription failed (${xhr.status}).`));
  };
  xhr.onerror = () => reject(new Error('Network error: the upload did not reach Dispatch.'));
  xhr.ontimeout = () => reject(new Error('Network error: no answer after five minutes.'));
  xhr.send(fd);
});

const RETRY_DELAYS = [1000, 3000];

export async function runTranscription(id: string, o: TranscribeOptions, onPhase: (p: Phase) => void, deps: { transport?: Transport; sleep?: (ms: number) => Promise<void> } = {}): Promise<string> {
  const transport = deps.transport ?? xhrTransport;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rec = await getRecording(id);
  const blob = rec ? await getRecordingBlob(id) : null;
  if (!rec || !blob) throw new Error('This recording is gone from the device.');
  let attempts = rec.attempts;
  for (let i = 0; ; i++) {
    attempts++;
    await updateRecording(id, { status: 'sending', attempts, error: undefined });
    onPhase({ phase: 'uploading', pct: 0 });
    let uploaded = false;
    try {
      const { text } = await transport(blob, { ...o, mimeType: rec.mimeType }, {
        upload: (f) => { if (!uploaded) onPhase({ phase: 'uploading', pct: Math.max(0, Math.min(1, f)) }); },
        uploaded: () => { if (!uploaded) { uploaded = true; onPhase({ phase: 'transcribing' }); } },
      });
      if (!uploaded) onPhase({ phase: 'transcribing' });
      const clean = text.trim();
      await updateRecording(id, { status: 'done', text: clean, attempts });
      return clean;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const network = !(e instanceof TranscribeHttpError);
      if (network && i < RETRY_DELAYS.length) { await sleep(RETRY_DELAYS[i]); continue; }
      await updateRecording(id, { status: 'failed', error: msg, attempts });
      throw e instanceof Error ? e : new Error(msg);
    }
  }
}
