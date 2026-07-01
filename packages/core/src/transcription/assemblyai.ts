import type { SttAdapter, TranscribeInput, TranscribeResult } from './types.js';

const BASE = 'https://api.assemblyai.com';
const MAX_POLLS = 60;
const POLL_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const assemblyaiAdapter: SttAdapter = {
  id: 'assemblyai',
  async transcribe(model: string, apiKey: string, input: TranscribeInput): Promise<TranscribeResult> {
    const auth = { authorization: apiKey };
    // 1. upload raw bytes
    const up = await fetch(`${BASE}/v2/upload`, { method: 'POST', headers: { ...auth, 'content-type': 'application/octet-stream' }, body: new Uint8Array(input.audio) });
    if (!up.ok) throw new Error(`assemblyai ${up.status}: ${await up.text()}`);
    const { upload_url } = (await up.json()) as any;
    // 2. submit
    const body: any = { audio_url: upload_url, speech_models: [model] };
    if (input.language) body.language_code = input.language;
    if (input.keyterms?.length) body.keyterms_prompt = input.keyterms;
    const sub = await fetch(`${BASE}/v2/transcript`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!sub.ok) throw new Error(`assemblyai ${sub.status}: ${await sub.text()}`);
    const { id } = (await sub.json()) as any;
    // 3. poll
    for (let i = 0; i < MAX_POLLS; i++) {
      const p = await fetch(`${BASE}/v2/transcript/${id}`, { headers: auth });
      if (!p.ok) throw new Error(`assemblyai ${p.status}: ${await p.text()}`);
      const j: any = await p.json();
      if (j.status === 'completed') return { text: j.text ?? '', language: j.language_code, raw: j };
      if (j.status === 'error') throw new Error(`assemblyai: ${j.error ?? 'transcription error'}`);
      await sleep(POLL_MS);
    }
    throw new Error('assemblyai: transcription timed out');
  },
};
