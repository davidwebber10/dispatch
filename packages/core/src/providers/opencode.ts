import type { SessionProvider } from './types.js';

/**
 * OpenCode (`opencode`, npm `opencode-ai`) — the OpenRouter harness. Dispatch drives it
 * Pretty-ONLY: `opencode acp` speaks ACP (JSON-RPC over stdio), the same protocol as
 * `grok agent stdio`, so GrokStructuredSessionManager/GrokTranslator drive it unchanged.
 * There is no PTY flavor on purpose (buildNewCommand/buildResumeCommand are absent, and
 * sessions/service.ts defaults new opencode threads to transport 'structured', exactly
 * like grok) — the TUI would add a third transport surface for zero gain.
 *
 * Everything thread-specific rides a per-thread config file (model, permission mode, the
 * system prompt via `instructions`, MCP servers), pointed at by the OPENCODE_CONFIG env
 * var — verified live: a config-file model wins over the global default, and `opencode acp`
 * takes no per-run flags for any of these. The file is written by spawnStructured
 * (sessions/service.ts), NOT here: provider builders are pure argv construction.
 *
 * Auth is OpenCode's own credential store (`opencode auth login` →
 * ~/.local/share/opencode/auth.json). The OpenRouter key lives THERE, never in argv, env
 * blocks, or this repo — verified live that a prompt authenticates from the store alone.
 *
 * Model ids are OpenCode-namespaced OpenRouter ids (`openrouter/z-ai/glm-latest`). The web's
 * picker (lib/harnesses.ts) offers the curated open-weights list; DEFAULT_MODEL covers a
 * thread created with no pick.
 */
export const OPENCODE_DEFAULT_MODEL = 'openrouter/z-ai/glm-latest';

export const opencodeProvider: SessionProvider = {
  name: 'opencode',
  displayName: 'OpenCode',
  // No status hooks: the structured manager's own turn boundaries drive status, same as
  // the grok Pretty flow (hook-reported Stop events on top would double-report).
  statusStrategy: 'hooks',

  buildStructuredCommand() {
    // Model, permissions, instructions, and MCP servers all ride the OPENCODE_CONFIG file
    // (see spawnStructured); resume rides OUT-OF-BAND (`session/load`, via
    // StructuredSpawnOpts.resumeId) — so the argv is just the ACP server itself.
    return { command: 'opencode', args: ['acp'] };
  },

  // The PTY builders exist only to satisfy SessionProvider — they are unreachable:
  // createTerminal stamps every opencode row transport:'structured' unconditionally, so
  // spawnTerminal's PTY path can never select this provider. Throwing (not returning a
  // TUI command) keeps that invariant loud if a future code path breaks it.
  buildNewCommand() {
    throw new Error('OpenCode is Pretty-only — no PTY transport');
  },
  buildResumeCommand() {
    throw new Error('OpenCode is Pretty-only — no PTY transport');
  },
  buildRunnerCommand() {
    throw new Error('OpenCode has no headless runner');
  },
};
