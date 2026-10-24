import { isClaudeTierAlias } from '../overseer/spawn-model.js';
import { CLAUDE_EFFORT_LEVELS, type ClaudeEffort } from './cc-sessions.js';

/**
 * Fold the model and effort a Claude thread last RAN with (read from its transcript, see
 * readSessionSettings) into its saved config, so a relaunch (CLI <-> Pretty switch, daemon
 * restart, update) keeps what the owner chose with `/model` and `/effort` inside the thread.
 * Returns true when it changed `config`.
 *
 * Only a plain user thread is adopted: a thread with a role or an agent type gets its model from
 * Dispatch policy (coordinator tiers, agent-type tiers), and the transcript must not override it.
 * A saved tier alias ('opus') is kept while the transcript's model is that family
 * ('claude-opus-5-5'), so a thread the owner never changed keeps following the alias.
 */
export function adoptTranscriptSettings(
  config: Record<string, any>,
  seen: { model?: string; effort?: ClaudeEffort } | null,
): boolean {
  if (!seen || config.role || config.agentType) return false;
  let changed = false;
  if (seen.model) {
    const saved = typeof config.model === 'string' ? config.model.trim() : '';
    const sameFamily = isClaudeTierAlias(saved) && seen.model.startsWith(`claude-${saved}-`);
    if (saved !== seen.model && !sameFamily) { config.model = seen.model; changed = true; }
  }
  if (seen.effort && config.effort !== seen.effort) { config.effort = seen.effort; changed = true; }
  return changed;
}

/** The saved effort level, when it is one the CLI accepts; undefined otherwise. */
export function effortFor(config: Record<string, any> | null | undefined): ClaudeEffort | undefined {
  const e = config?.effort;
  return (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(e) ? e : undefined;
}
