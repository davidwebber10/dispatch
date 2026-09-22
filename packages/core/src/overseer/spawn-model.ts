import { modelFor } from './prompts.js';

/**
 * The spawn-time model for a structured thread, harness-aware. MODEL_FOR_TYPE's
 * Claude aliases (sonnet/opus/fable) are meaningful ONLY to the claude CLI — every
 * other harness gets an explicit config.model or its own default, never a tier alias
 * (grok/codex reject them; opencode would write "sonnet" into opencode.json).
 */
export function resolveSpawnModel(input: {
  harness: string;
  config: { model?: unknown; role?: unknown; agentType?: unknown } | null | undefined;
  opencodeDefault?: string;
}): string | undefined {
  if (input.harness === 'claude-code') return modelFor(input.config as never);
  const explicit = typeof input.config?.model === 'string' && input.config.model.trim() ? input.config.model.trim() : undefined;
  if (explicit) return explicit;
  if (input.harness === 'opencode') return input.opencodeDefault;
  return undefined;
}
