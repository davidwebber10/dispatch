import type { ProviderName, TerminalType } from '../api/types';
import { HARNESSES } from '../../../core/src/providers/catalog';
export { HARNESSES, defaultModeFor } from '../../../core/src/providers/catalog';
export type { Harness } from '../../../core/src/providers/catalog';

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
