/**
 * Switches off Claude Code's `agent_summary` side query in every thread Dispatch starts.
 *
 * Since 2.1.232, every ~30 s and for each background agent, Claude Code re-sends that agent's
 * whole transcript to its own model (usually Opus) to get a 3-5 word status for the agents
 * panel. The answer never reaches the conversation, and measurements put it at 16-26 % of all
 * Claude Code spend (anthropics/claude-code#86879). No setting or env var turns it off.
 *
 * The fix is a Bun `--preload` (no-agent-summary.preload.js, vendored from the Flamerix gist)
 * that hands back an inert handle for the one timer whose callback carries the summarizer's
 * anchor strings. Claude Code reads `BUN_OPTIONS`, so the preload rides in the spawn env that
 * PTY and structured threads share. The hook installs only inside Claude Code itself; any other
 * Bun a thread starts loads it and does nothing. If an update renames the anchors, the hook
 * matches nothing and the summaries silently come back (fail-open), never a broken thread.
 *
 * Settings → Harnesses → Claude Code → "Skip agent status summaries" (on by default) decides
 * whether the spawn env carries the preload; the file itself is always written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_PATH = fileURLToPath(new URL('./no-agent-summary.preload.js', import.meta.url));

/** Where the preload is written, for a given data dir. */
export function agentSummaryHookPath(dataDir: string): string {
  return path.join(dataDir, 'preload', 'no-agent-summary.js');
}

/**
 * Write the preload into the data dir and return its absolute path, or null when the file cannot
 * be written (threads then run unhooked, as before).
 */
export function installAgentSummaryHook(dataDir: string, sourcePath: string = SOURCE_PATH): string | null {
  const target = agentSummaryHookPath(dataDir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(sourcePath, target);
    return target;
  } catch {
    return null;
  }
}

/**
 * Add `--preload=<hook>` to a BUN_OPTIONS value, once. The `=` form matters: BUN_OPTIONS reaches
 * every `bun` a thread runs, and with a space `bun install` reads the path as its script.
 */
export function withAgentSummaryPreload(bunOptions: string | undefined, hookPath: string | null): string | undefined {
  if (!hookPath) return bunOptions;
  const flag = `--preload=${hookPath}`;
  const parts = (bunOptions ?? '').split(/\s+/).filter(Boolean);
  if (parts.includes(flag)) return parts.join(' ');
  return [...parts, flag].join(' ');
}
