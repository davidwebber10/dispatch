/**
 * The single list of harnesses Dispatch drives.
 *
 * This module exists because adding a provider used to mean editing the same list in six
 * unrelated places, and missing one failed silently every time: Grok threads spawned and ran
 * but were filtered out of the sidebar; Grok got no peer tools because one eligibility check
 * still said `claude-code || codex`; Grok's MCP servers were registered but its system prompt
 * was dropped. Three separate bugs, one cause.
 *
 * Everything that needs to reason about "which harnesses exist" derives from here. It has NO
 * imports on purpose, so any layer — db, routes, providers, sessions — can use it without
 * risking an import cycle.
 *
 * A test asserts these match the provider registry's own keys, so adding a provider to the
 * registry and forgetting this list fails loudly instead of quietly.
 */

/** Wire types for the agent CLIs. These are the `type` values on a terminal row. */
export const AGENT_TYPES = ['claude-code', 'codex', 'grok'] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

/** Everything the THREADS list owns: the agents, plus the plain shell. */
export const THREAD_TYPES = [...AGENT_TYPES, 'shell'] as const;
export type TerminalType = (typeof THREAD_TYPES)[number];

/** Non-PTY tabs, which live alongside threads but spawn no process. */
export const TAB_ONLY_TYPES = ['browser', 'notes', 'file'] as const;

/**
 * Wire type → the CLI binary that backs it.
 *
 * The two names differ (`claude-code` the harness, `claude` the executable), and that gap is
 * exactly where install/sign-in detection has to line up with spawning.
 */
export const AGENT_CLI: Record<AgentType, 'claude' | 'codex' | 'grok'> = {
  'claude-code': 'claude',
  codex: 'codex',
  grok: 'grok',
};

/** True for a harness that runs an agent CLI — i.e. anything but the plain shell. */
export function isAgentType(type: string): type is AgentType {
  return (AGENT_TYPES as readonly string[]).includes(type);
}

/** True for anything the THREADS list owns, agents and shell alike. */
export function isThreadType(type: string): type is TerminalType {
  return (THREAD_TYPES as readonly string[]).includes(type);
}
