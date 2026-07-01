import type { SttAdapter, TranscribeInput, TranscribeResult } from './types.js';

/** Map an audio mime to a filename+extension the Whisper endpoints sniff. */
export function filenameForMime(mime: string): string {
  const base = (mime || '').split(';')[0].trim();
  const ext: Record<string, string> = {
    'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac',
  };
  return `audio.${ext[base] ?? 'webm'}`;
}

/**
 * One adapter for every OpenAI-compatible /audio/transcriptions endpoint
 * (OpenAI, Groq, Azure-OpenAI-Whisper). Only baseURL/model/key differ.
 */
export function makeOpenAICompatibleAdapter(id: string, baseURL: string): SttAdapter {
  return {
    id,
    async transcribe(model: string, apiKey: string, input: TranscribeInput): Promise<TranscribeResult> {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(input.audio)], { type: input.mimeType }), filenameForMime(input.mimeType));
      form.append('model', model);
      if (input.language) form.append('language', input.language);
      if (input.prompt) form.append('prompt', input.prompt);
      const res = await fetch(`${baseURL}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      if (!res.ok) throw new Error(`${id} ${res.status}: ${await res.text()}`);
      const j: any = await res.json();
      return { text: j?.text ?? '', language: j?.language, raw: j };
    },
  };
}
