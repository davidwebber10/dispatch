// packages/core/src/structured/model-log.ts
// One box log line per started process: the model the thread asked for and the model the harness
// reports it runs (Codex: the thread/start or thread/resume answer; Claude Code: the first init frame).
// "Which model answered?" is then a log query, not a guess from what the model says about itself.
import { boxLog } from '../os/box-log.js';

const CLAUDE_ALIAS = /^(opus|sonnet|haiku|fable)$/;

/**
 * True when the reported id is the requested one. A Claude tier alias (`sonnet`) matches every id of
 * its family (`claude-sonnet-4-5-20250929`); a Claude id with a context suffix (`[1m]`) matches without it.
 * No request (the harness default) always matches: there is nothing to compare.
 */
export function modelMatches(requested: string | null, reported: string | null): boolean {
  if (!requested || !reported) return true;
  if (requested === reported) return true;
  const bare = (m: string) => m.replace(/\[\w+\]$/, '');
  if (bare(requested) === bare(reported)) return true;
  if (CLAUDE_ALIAS.test(requested)) return new RegExp(`^claude-${requested}-`).test(reported);
  return false;
}

/** `thread.model`: info when the harness runs what was asked (or nothing was asked), warn when it does not. */
export function logThreadModel(terminalId: string, harness: string, requested: string | null, reported: string | null, extra: Record<string, unknown> = {}): void {
  const match = modelMatches(requested, reported);
  boxLog('thread.model', { thread: terminalId, harness, requested, reported, match, ...extra }, match ? 'info' : 'warn');
}
