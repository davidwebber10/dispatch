import type { TranscribeResult } from './types.js';
import { REGISTRY, type ProviderEntry } from './registry.js';

interface SecretsLike { getSecret(name: string): Promise<string | null>; }

export interface TranscribeOptions {
  provider: string;
  model: string;
  secretName: string;
  audio: Buffer;
  mimeType: string;
  language?: string;
  prompt?: string;
}

export class TranscriptionService {
  constructor(
    private readonly secrets: SecretsLike,
    private readonly registry: Record<string, ProviderEntry> = REGISTRY,
  ) {}

  async transcribe(opts: TranscribeOptions): Promise<TranscribeResult> {
    const entry = this.registry[opts.provider];
    if (!entry || entry.status !== 'ready' || !entry.adapter) {
      throw new Error(`Unknown or unavailable provider: ${opts.provider}`);
    }
    if (!opts.model) throw new Error('model is required');
    if (!opts.secretName) throw new Error('secretName is required');
    const key = await this.secrets.getSecret(opts.secretName);
    if (!key) throw new Error(`Secret not found: ${opts.secretName}`);
    return entry.adapter.transcribe(opts.model, key, {
      audio: opts.audio, mimeType: opts.mimeType, language: opts.language, prompt: opts.prompt,
    });
  }
}
