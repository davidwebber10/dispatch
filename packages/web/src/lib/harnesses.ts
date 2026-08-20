import type { ProviderName, TerminalType } from '../api/types';

/**
 * The single list of harnesses, mirroring core's `providers/agent-types.ts`.
 *
 * The web package keeps its own copy because it does not import from the daemon — but it is
 * one copy, not six. Adding Grok previously meant editing the same list in four inline
 * literals in `ProjectCard` alone, and missing one made every Grok thread invisible in the
 * sidebar while running perfectly well.
 *
 * `HARNESSES` is the ordered source for the New Thread picker; the type lists derive from it,
 * so a new harness is one entry here.
 */
export interface Harness {
  /** The picker's own id. */
  id: 'claude' | 'codex' | 'grok' | 'opencode' | 'terminal';
  label: string;
  /** The wire `type` sent to POST /terminals. */
  type: TerminalType;
  /** Which detected CLI backs it, or null for the plain shell (always available). */
  provider: ProviderName | null;
  /**
   * The modes this harness can run, in display order. `cli` is the raw terminal (PTY),
   * `pretty` the structured chat transport. Grok is pretty-only: its TUI never rendered
   * well in Dispatch (mobile paging, alt-screen churn), so the PTY option is gone for new
   * Grok threads — existing PTY threads keep working.
   */
  modes: ReadonlyArray<'cli' | 'pretty'>;
  /** Models offered for it. `null` means "let the CLI choose". */
  models: { label: string; model: string | null }[];
}

export const HARNESSES: Harness[] = [
  {
    id: 'claude', label: 'Claude Code', type: 'claude-code', provider: 'claude', modes: ['cli', 'pretty'],
    models: [
      { label: 'Default', model: null },
      { label: 'Fable', model: 'fable' },
      { label: 'Opus', model: 'opus' },
      { label: 'Sonnet', model: 'sonnet' },
      { label: 'Haiku', model: 'haiku' },
    ],
  },
  {
    id: 'codex', label: 'Codex', type: 'codex', provider: 'codex', modes: ['cli', 'pretty'],
    models: [
      { label: 'Default', model: null },
      { label: '5.6 Sol', model: 'gpt-5.6-sol' },
      { label: '5.6 Terra', model: 'gpt-5.6-terra' },
      { label: '5.6 Luna', model: 'gpt-5.6-luna' },
    ],
  },
  {
    // Pretty-ONLY since the ACP transport landed (grok agent stdio → GrokStructuredSessionManager).
    id: 'grok', label: 'Grok', type: 'grok', provider: 'grok', modes: ['pretty'],
    models: [
      { label: 'Default', model: null },
      { label: 'Grok 4.5', model: 'grok-4.5' },
    ],
  },
  {
    // Pretty-ONLY, like Grok, and the only harness with no bundled model: it runs
    // models through OpenRouter (`opencode acp`, same ACP transport as Grok) under
    // the user's OpenCode/OpenRouter credential. The list spans frontier proprietary
    // families (Claude, GPT, Gemini, Grok) and open-weights flagships (GLM, Kimi,
    // DeepSeek, Qwen, MiniMax, Llama, Mistral). Every family that exposes an
    // OpenRouter "-latest" alias uses it, so the picker always resolves to the
    // current flagship and never falls a version behind; the few without an alias
    // (Qwen, MiniMax, Llama, Mistral) are pinned to their current top id. All ids
    // verified against OpenRouter's live catalog.
    id: 'opencode', label: 'OpenCode', type: 'opencode', provider: 'opencode', modes: ['pretty'],
    models: [
      { label: 'Claude Opus', model: 'openrouter/anthropic/claude-opus-latest' },
      { label: 'Claude Fable', model: 'openrouter/anthropic/claude-fable-latest' },
      { label: 'GPT', model: 'openrouter/openai/gpt-latest' },
      { label: 'Gemini Pro', model: 'openrouter/google/gemini-pro-latest' },
      { label: 'Gemini Flash', model: 'openrouter/google/gemini-flash-latest' },
      { label: 'Grok', model: 'openrouter/x-ai/grok-latest' },
      { label: 'GLM', model: 'openrouter/z-ai/glm-latest' },
      { label: 'Kimi', model: 'openrouter/moonshotai/kimi-latest' },
      { label: 'DeepSeek V4', model: 'openrouter/deepseek/deepseek-v4-flash-latest' },
      { label: 'Qwen3.8 Max', model: 'openrouter/qwen/qwen3.8-max' },
      { label: 'MiniMax M3', model: 'openrouter/minimax/minimax-m3' },
      { label: 'Llama 4 Maverick', model: 'openrouter/meta-llama/llama-4-maverick' },
      { label: 'Mistral Large', model: 'openrouter/mistralai/mistral-large' },
    ],
  },
  { id: 'terminal', label: 'Terminal', type: 'shell', provider: null, modes: ['cli'], models: [] },
];

/** Wire types for the agent CLIs — everything except the plain shell. */
export const AGENT_TYPES: TerminalType[] = HARNESSES.filter((h) => h.provider !== null).map((h) => h.type);

/** Everything the THREADS list owns: the agents, plus the plain shell. */
export const THREAD_TYPES: TerminalType[] = HARNESSES.map((h) => h.type);

/** The install command per CLI, shown beside the Install button. Mirrors core's INSTALL_COMMANDS. */
export const INSTALL_COMMAND: Record<ProviderName, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  grok: 'curl -fsSL https://x.ai/cli/install.sh | bash',
  opencode: 'npm install -g opencode-ai',
};

/**
 * The PLAIN login command per CLI. Mirrors core's LOGIN_COMMANDS.
 *
 * Not the bare TUI: `claude` and `grok` on their own open a full-screen UI that renders the
 * sign-in link as an unclickable region and never prints it — a dead end on a phone.
 */
export const LOGIN_COMMAND: Record<ProviderName, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
  grok: 'grok login',
  opencode: 'opencode auth login',
};
