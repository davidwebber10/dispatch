/**
 * The one `claude -p` command line builder for Endless Chat turns AND compactions. Both use the
 * same system prompt and fixed-context switches. Turns load the user's own tools; compactions
 * are isolated from them (COMPACTION_ISOLATION_ARGS). The prompt cache is per model, so a
 * compaction shares a prefix only with other compactions, never with a turn. The switches come
 * from the Task 1 probe (docs/superpowers/plans/2026-10-13-endless-chat-probe-results.md,
 * "Chosen set").
 */
export const TURN_MODEL = 'opus';
export const SUMMARY_MODEL = 'haiku';
/** Controller ruling: 'high' (median 5,940 ms in probe 1b), not the slower 'max'. */
export const SUMMARY_EFFORT = 'high';

export const FIXED_CONTEXT_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
  CLAUDE_CODE_DISABLE_ORG_MEMORY: '1',
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
};

/** Compactions also hide skills: they never use them, and Haiku has its own cache anyway. */
export const COMPACTION_ENV: Record<string, string> = { ...FIXED_CONTEXT_ENV, CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' };

export const FIXED_CONTEXT_SETTINGS = JSON.stringify({ autoMemoryEnabled: false, includeGitInstructions: false, disableAllHooks: true });

/** Last on the command line: `--disallowedTools` takes a list and must not swallow other flags. */
export const FIXED_CONTEXT_ARGS: readonly string[] = [
  '--no-session-persistence',
  '--disallowedTools', 'AskUserQuestion',
];

/**
 * User decision (2026-10-13, option B): TURNS load the user's own MCP servers, claude.ai
 * connectors, plugins and skills, so these isolation switches apply to COMPACTIONS ONLY.
 * The prompt cache is per model, so compactions share a prefix only with other compactions.
 * Cost: adding, removing or (re)authenticating a user server changes the turn tool list and
 * misses the cache once.
 */
export const COMPACTION_ISOLATION_ARGS: readonly string[] = [
  '--setting-sources', 'project',
  '--strict-mcp-config',
  '--disable-slash-commands',
];

export function endlessClaudeArgs(o: { model: string; effort?: string; systemPrompt: string; mcpConfigPath: string; userTools: boolean }): string[] {
  return [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'default',
    '--permission-prompt-tool', 'stdio',
    '--model', o.model,
    ...(o.effort ? ['--effort', o.effort] : []),
    '--system-prompt', o.systemPrompt,
    '--mcp-config', o.mcpConfigPath,
    '--settings', FIXED_CONTEXT_SETTINGS,
    ...(o.userTools ? [] : COMPACTION_ISOLATION_ARGS),
    ...FIXED_CONTEXT_ARGS,
  ];
}
