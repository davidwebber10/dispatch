export interface TranscribeInput {
  audio: Buffer;
  mimeType: string;      // e.g. 'audio/webm', 'audio/mp4'
  language?: string;     // ISO-639-1; undefined = auto-detect
  prompt?: string;       // free-form bias hint (OpenAI/Groq)
  keyterms?: string[];   // structured term list (Deepgram/ElevenLabs/AssemblyAI)
}

export interface TranscribeResult {
  text: string;
  language?: string;
  raw: unknown;          // provider response, for debugging
}

export interface SttAdapter {
  id: string;
  transcribe(model: string, apiKey: string, input: TranscribeInput): Promise<TranscribeResult>;
}
