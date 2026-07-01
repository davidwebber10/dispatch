import type { SttAdapter } from './types.js';
import { makeOpenAICompatibleAdapter } from './openai-compatible.js';
import { deepgramAdapter } from './deepgram.js';
import { elevenlabsAdapter } from './elevenlabs.js';

export interface ProviderEntry {
  id: string;
  label: string;
  models: string[];
  adapter: SttAdapter | null;      // null ⇒ coming-soon
  status: 'ready' | 'coming-soon';
}

const openai = makeOpenAICompatibleAdapter('openai', 'https://api.openai.com/v1');
const groq = makeOpenAICompatibleAdapter('groq', 'https://api.groq.com/openai/v1');

// Adapters added in later tasks are imported and slotted here as they land.
export const REGISTRY: Record<string, ProviderEntry> = {
  groq: { id: 'groq', label: 'Groq', models: ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'], adapter: groq, status: 'ready' },
  openai: { id: 'openai', label: 'OpenAI', models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'], adapter: openai, status: 'ready' },
  deepgram: { id: 'deepgram', label: 'Deepgram', models: ['nova-3', 'nova-2'], adapter: deepgramAdapter, status: 'ready' },
  elevenlabs: { id: 'elevenlabs', label: 'ElevenLabs', models: ['scribe_v2', 'scribe_v1'], adapter: elevenlabsAdapter, status: 'ready' },
  assemblyai: { id: 'assemblyai', label: 'AssemblyAI', models: ['universal-3-pro', 'universal-2'], adapter: null, status: 'coming-soon' },
  google: { id: 'google', label: 'Google Cloud STT', models: [], adapter: null, status: 'coming-soon' },
  azure: { id: 'azure', label: 'Azure AI Speech', models: [], adapter: null, status: 'coming-soon' },
};
