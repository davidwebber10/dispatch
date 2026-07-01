import type { SttAdapter, TranscribeInput, TranscribeResult } from './types.js';

export const deepgramAdapter: SttAdapter = {
  id: 'deepgram',
  async transcribe(model: string, apiKey: string, input: TranscribeInput): Promise<TranscribeResult> {
    const params = new URLSearchParams({ model, smart_format: 'true' });
    if (input.language) params.set('language', input.language);
    for (const t of input.keyterms ?? []) params.append('keyterm', t); // Nova-3 term biasing
    const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': input.mimeType },
      body: new Uint8Array(input.audio),
    });
    if (!res.ok) throw new Error(`deepgram ${res.status}: ${await res.text()}`);
    const j: any = await res.json();
    const text = j?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    return { text, raw: j };
  },
};
