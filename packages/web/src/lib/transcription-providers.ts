// Mirrors packages/core/src/transcription/registry.ts. Keep the two in sync.

export interface ProviderModel {
  id: string;
  label: string;
}

export interface ProviderInfo {
  id: string;
  label: string;
  models: ProviderModel[];
  status: 'ready' | 'coming-soon';
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: 'groq',
    label: 'Groq',
    status: 'ready',
    models: [
      { id: 'whisper-large-v3-turbo', label: 'Whisper large v3 turbo (fast)' },
      { id: 'whisper-large-v3', label: 'Whisper large v3' },
      { id: 'distil-whisper-large-v3-en', label: 'Distil-Whisper (English)' },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI',
    status: 'ready',
    models: [
      { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe' },
      { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe' },
      { id: 'whisper-1', label: 'whisper-1' },
    ],
  },
  {
    id: 'deepgram',
    label: 'Deepgram',
    status: 'ready',
    models: [
      { id: 'nova-3', label: 'Nova-3' },
      { id: 'nova-2', label: 'Nova-2' },
    ],
  },
  {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    status: 'ready',
    models: [
      { id: 'scribe_v2', label: 'Scribe v2' },
      { id: 'scribe_v1', label: 'Scribe v1' },
    ],
  },
  {
    id: 'assemblyai',
    label: 'AssemblyAI',
    status: 'ready',
    models: [
      { id: 'universal-3-pro', label: 'Universal-3 Pro' },
      { id: 'universal-2', label: 'Universal-2' },
    ],
  },
  { id: 'google', label: 'Google Cloud STT', status: 'coming-soon', models: [] },
  { id: 'azure', label: 'Azure AI Speech', status: 'coming-soon', models: [] },
];

export function getProvider(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
