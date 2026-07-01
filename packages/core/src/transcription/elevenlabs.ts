import type { SttAdapter, TranscribeInput, TranscribeResult } from './types.js';
import { filenameForMime } from './openai-compatible.js';

export const elevenlabsAdapter: SttAdapter = {
  id: 'elevenlabs',
  async transcribe(model: string, apiKey: string, input: TranscribeInput): Promise<TranscribeResult> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(input.audio)], { type: input.mimeType }), filenameForMime(input.mimeType));
    form.append('model_id', model);
    if (input.language) form.append('language_code', input.language);
    for (const t of input.keyterms ?? []) form.append('keyterms', t);
    const res = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': apiKey },
      body: form,
    });
    if (!res.ok) throw new Error(`elevenlabs ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    return { text: j?.text ?? '', language: j?.language_code, raw: j };
  },
};
