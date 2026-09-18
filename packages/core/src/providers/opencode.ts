import { DEFAULT_TELEMETRY, acpTurnCost, acpCostCounter } from './telemetry.js';
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
 * Model ids are OpenCode-namespaced OpenRouter ids (`openrouter/~z-ai/glm-latest`). The list
 * the New Thread picker offers is a per-user setting (settings/harness-settings.ts) seeded
 * from OPENCODE_DEFAULT_MODELS below; DEFAULT_MODEL covers a thread created with no pick.
 *
 * OpenRouter's family aliases carry a `~` prefix (`~anthropic/claude-opus-latest`) and
 * always resolve to the family's current flagship, so the defaults never fall a version
 * behind; the families without an alias (Qwen, MiniMax, Llama, Mistral) are pinned to their
 * current top id. Verified against https://openrouter.ai/api/v1/models on 2026-09-18 — the
 * un-prefixed `anthropic/claude-opus-latest` form from before is a 404 there now.
 */
export interface OpencodeModel { label: string; model: string }

export const OPENCODE_DEFAULT_MODELS: readonly OpencodeModel[] = [
  { label: 'Claude Opus', model: 'openrouter/~anthropic/claude-opus-latest' },
  { label: 'Claude Fable', model: 'openrouter/~anthropic/claude-fable-latest' },
  { label: 'Claude Sonnet', model: 'openrouter/~anthropic/claude-sonnet-latest' },
  { label: 'GPT Sol', model: 'openrouter/~openai/gpt-sol-latest' },
  { label: 'GPT Terra', model: 'openrouter/~openai/gpt-terra-latest' },
  { label: 'GPT Luna', model: 'openrouter/~openai/gpt-luna-latest' },
  { label: 'GPT Astra', model: 'openrouter/~openai/gpt-astra-latest' },
  { label: 'Gemini Pro', model: 'openrouter/~google/gemini-pro-latest' },
  { label: 'Gemini Flash', model: 'openrouter/~google/gemini-flash-latest' },
  { label: 'Grok', model: 'openrouter/~x-ai/grok-latest' },
  { label: 'GLM', model: 'openrouter/~z-ai/glm-latest' },
  { label: 'GLM Flash', model: 'openrouter/~z-ai/glm-flash-latest' },
  { label: 'Kimi', model: 'openrouter/~moonshotai/kimi-latest' },
  { label: 'DeepSeek Pro', model: 'openrouter/~deepseek/deepseek-pro-latest' },
  { label: 'DeepSeek Flash', model: 'openrouter/~deepseek/deepseek-flash-latest' },
  { label: 'Qwen3.8 Max', model: 'openrouter/qwen/qwen3.8-max-0902' },
  { label: 'MiniMax M3', model: 'openrouter/minimax/minimax-m3' },
  { label: 'Llama 4 Maverick', model: 'openrouter/meta-llama/llama-4-maverick' },
  { label: 'Mistral Medium 3.5', model: 'openrouter/mistralai/mistral-medium-3-5' },
];

/** The daemon-side fallback for a thread created with no model pick: the cheap open flagship. */
export const OPENCODE_DEFAULT_MODEL = 'openrouter/~z-ai/glm-latest';

export const opencodeProvider: SessionProvider = {
  name: 'opencode',
  structured: { protocol: 'acp', dialect: 'opencode', disabledBy: 'DISPATCH_OPENCODE_PRETTY' },
  telemetry: { ...DEFAULT_TELEMETRY, reportedCost: acpTurnCost, costCounter: acpCostCounter },
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
