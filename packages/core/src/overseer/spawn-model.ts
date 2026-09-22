import { modelFor } from './prompts.js';

/** Claude tier aliases — resolved downstream by the claude-code spawn path (--model sonnet
 *  etc.), meaningless (and often a different, real model id in disguise) to any other CLI.
 *  Single source of truth: reused by worker-payload.ts's guard instead of a private Set. */
const CLAUDE_TIER_ALIASES = new Set(['sonnet', 'opus', 'haiku', 'fable']);

export function isClaudeTierAlias(model: string): boolean {
  return CLAUDE_TIER_ALIASES.has(model);
}

/**
 * The spawn-time model for a structured thread, harness-aware. MODEL_FOR_TYPE's
 * Claude aliases (sonnet/opus/fable) are meaningful ONLY to the claude CLI — every
 * other harness gets an explicit config.model or its own default, never a tier alias
 * (grok/codex reject them; opencode would write "sonnet" into opencode.json).
 *
 * A Claude tier alias reaching here for a non-claude harness — whether as an explicit
 * config.model OR as the harness's own configured default (opencodeDefault) — is always a
 * mistake (a poisoned setting, a copy-pasted config). It is IGNORED, not returned: falling
 * through to the harness's own default/undefined instead of leaking the alias downstream,
 * where it would either error (grok/codex reject it) or silently corrupt a config file
 * (opencode.json would get "sonnet" written into it as if it were a real model id).
 */
export function resolveSpawnModel(input: {
  harness: string;
  config: { model?: unknown; role?: unknown; agentType?: unknown } | null | undefined;
  opencodeDefault?: string;
}): string | undefined {
  if (input.harness === 'claude-code') return modelFor(input.config as never);
  const explicitRaw = typeof input.config?.model === 'string' && input.config.model.trim() ? input.config.model.trim() : undefined;
  const explicit = explicitRaw && !isClaudeTierAlias(explicitRaw) ? explicitRaw : undefined;
  if (explicit) return explicit;
  if (input.harness === 'opencode') {
    const def = input.opencodeDefault;
    return def && !isClaudeTierAlias(def) ? def : undefined;
  }
  return undefined;
}
