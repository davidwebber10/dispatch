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
  id: 'claude' | 'codex' | 'grok' | 'terminal';
  label: string;
  /** The wire `type` sent to POST /terminals. */
  type: TerminalType;
  /** Which detected CLI backs it, or null for the plain shell (always available). */
  provider: ProviderName | null;
  /** Whether this harness can run the structured "Pretty" transport. */
  pretty: boolean;
  /** Models offered for it. `null` means "let the CLI choose". */
  models: { label: string; model: string | null }[];
}

export const HARNESSES: Harness[] = [
  {
    id: 'claude', label: 'Claude Code', type: 'claude-code', provider: 'claude', pretty: true,
    models: [
      { label: 'Default', model: null },
      { label: 'Fable', model: 'fable' },
      { label: 'Opus', model: 'opus' },
      { label: 'Sonnet', model: 'sonnet' },
      { label: 'Haiku', model: 'haiku' },
    ],
  },
  {
    id: 'codex', label: 'Codex', type: 'codex', provider: 'codex', pretty: true,
    models: [
      { label: 'Default', model: null },
      { label: '5.6 Sol', model: 'gpt-5.6-sol' },
      { label: '5.6 Terra', model: 'gpt-5.6-terra' },
      { label: '5.6 Luna', model: 'gpt-5.6-luna' },
    ],
  },
  {
    // Pretty since the ACP transport landed (grok agent stdio → GrokStructuredSessionManager).
    id: 'grok', label: 'Grok', type: 'grok', provider: 'grok', pretty: true,
    models: [
      { label: 'Default', model: null },
      { label: 'Grok 4.5', model: 'grok-4.5' },
    ],
  },
  { id: 'terminal', label: 'Terminal', type: 'shell', provider: null, pretty: false, models: [] },
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
};
