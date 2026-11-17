import type { SttAdapter, TranscribeInput, TranscribeResult } from './types.js';

const BASE = 'https://api.assemblyai.com';
const MAX_POLLS = 60;
const POLL_MS = 1000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Asks the model for a clean transcript. It lists the patterns to leave out
// and uses soft wording, as AssemblyAI's prompt guidance suggests.
// Measured 2026-11-17: universal-3-pro accepts this but still returns um and
// uh, so the word-list pass in cleanup.ts is what removes them there. The
// prompt costs one request field, so it stays for the models that honor it.
export const CLEAN_TRANSCRIPT_PROMPT =
  'Clean transcript, leaving out filler sounds such as um, uh, er, ah and hmm, false starts, stutters and repeated words.';

// universal-2 rejects a prompt with HTTP 400, so it gets disfluencies only.
const supportsPrompt = (model: string) => !/^universal-2/i.test(model);

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
    // Ask for no fillers. Universal-2 honors this; universal-3-pro and
    // assemblyai-stt-3-7 accept it and only sometimes act on it.
    body.disfluencies = false;
    if (supportsPrompt(model)) body.prompt = CLEAN_TRANSCRIPT_PROMPT;
    // The docs say prompt and keyterms_prompt are exclusive on pre-recorded
    // audio. The live API accepts both on universal-3-pro and
    // assemblyai-stt-3-7, and the keyterms still take effect (checked
    // 2026-11-17), so both are sent.
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
