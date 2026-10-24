import { CLAUDE_EFFORT_LEVELS, type ClaudeEffort } from './cc-sessions.js';

const FAMILY_RE = /^claude-(opus|sonnet|haiku|fable)-[^[]*$/;

/**
 * Fold the model and effort a Claude thread last RAN with (read from its transcript, see
 * readSessionSettings) into its saved config, so a relaunch (CLI <-> Pretty switch, daemon
 * restart, update) keeps what the owner chose with `/model` and `/effort` inside the thread.
 * Returns true when it changed `config`.
 *
 * Only a plain user thread is adopted: a thread with a role or an agent type gets its model from
 * Dispatch policy (coordinator tiers, agent-type tiers), and the transcript must not override it.
 *
 * Model: saved as the tier alias of its family ('claude-opus-5-5' -> 'opus'), so a thread keeps
 * its family but still gets new versions; a full id (a 1M variant, an unknown family) is saved as
 * is. A saved alias is kept while the transcript model is that family. Known limit: an older
 * version picked inside a family the thread already saved by alias is not kept.
 *
 * Effort: the CLI writes `effort` on every turn, so the bare value is just the model's default
 * and pinning it would freeze threads nobody touched. It is saved only when the transcript shows
 * it changed (`effortChanged`), or once saved, to follow later changes.
 */
export function adoptTranscriptSettings(
  config: Record<string, any>,
  seen: { model?: string; effort?: ClaudeEffort; effortChanged?: boolean } | null,
): boolean {
  if (!seen || config.role || config.agentType) return false;
  let changed = false;
  if (seen.model) {
    const saved = typeof config.model === 'string' ? config.model.trim() : '';
    const family = FAMILY_RE.exec(seen.model)?.[1];
    const target = family ?? seen.model;
    if (saved !== target && saved !== seen.model) { config.model = target; changed = true; }
  }
  if (seen.effort && (seen.effortChanged || config.effort !== undefined) && config.effort !== seen.effort) {
    config.effort = seen.effort; changed = true;
  }
  return changed;
}

/** The saved effort level, when it is one the CLI accepts; undefined otherwise. */
export function effortFor(config: Record<string, any> | null | undefined): ClaudeEffort | undefined {
  const e = config?.effort;
  return (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(e) ? e : undefined;
}
