import type { SessionProvider, SecretsMcpInjection } from './types.js';

// Codex `-c` overrides are global options and must precede the subcommand.
// Returns [] when Doppler isn't connected.
function mcpArgs(secretsMcp?: SecretsMcpInjection): string[] {
  return secretsMcp?.codexArgs ?? [];
}

export const codexProvider: SessionProvider = {
  name: 'codex',
  displayName: 'Codex',
  statusStrategy: 'pty-timing',
  buildNewCommand({ prompt, secretsMcp }) {
    const args: string[] = [...mcpArgs(secretsMcp)];
    if (prompt) args.push(prompt);
    return { command: 'codex', args };
  },

  buildResumeCommand({ externalSessionId, secretsMcp }) {
    return { command: 'codex', args: [...mcpArgs(secretsMcp), 'resume', externalSessionId] };
  },

  buildRunnerCommand({ prompt, secretsMcp }) {
    // `codex exec` runs non-interactively and EXITS when the task is complete
    // (the process-exit is our run-completion fallback).
    //   --json              emit newline-delimited JSON events (thread/turn/item +
    //                       a final turn.completed with token usage) that the
    //                       RunStreamParser turns into live steps + telemetry.
    //   --dangerously-bypass-approvals-and-sandbox
    //                       run fully autonomously with no approval prompts,
    //                       mirroring Claude's --dangerously-skip-permissions.
    //   --skip-git-repo-check
    //                       allow running in working dirs that aren't git repos.
    // -c overrides (Doppler MCP) precede the `exec` subcommand. Prompt is positional.
    return {
      command: 'codex',
      args: [...mcpArgs(secretsMcp), 'exec', '--json', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', prompt],
    };
  },
};
