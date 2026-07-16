import type { SessionProvider, SecretsMcpInjection, StatusHooksInjection } from './types.js';

// Codex `-c` overrides are global options and must precede the subcommand.
// Returns [] when Doppler isn't connected.
function mcpArgs(secretsMcp?: SecretsMcpInjection): string[] {
  return secretsMcp?.codexArgs ?? [];
}

// `-c notify=[...]` registers a program Codex runs on `agent-turn-complete`.
// Like mcpArgs, these are global `-c` overrides and must precede the subcommand.
function hookArgs(statusHooks?: StatusHooksInjection): string[] {
  return statusHooks?.codexNotifyArgs ?? [];
}

// Pins the model for a codex thread. `--model <slug>` (e.g. 'gpt-5.6-sol') is a
// global option → like the -c overrides it must precede any subcommand (`resume`).
// Omitted → codex uses its configured default model.
function modelArgs(model?: string): string[] {
  return model ? ['--model', model] : [];
}

export const codexProvider: SessionProvider = {
  name: 'codex',
  displayName: 'Codex',
  statusStrategy: 'pty-timing',
  buildNewCommand({ prompt, secretsMcp, statusHooks, model }) {
    const args: string[] = [...mcpArgs(secretsMcp), ...hookArgs(statusHooks), ...modelArgs(model)];
    if (prompt) args.push(prompt);
    return { command: 'codex', args };
  },

  buildResumeCommand({ externalSessionId, secretsMcp, statusHooks, model }) {
    return { command: 'codex', args: [...mcpArgs(secretsMcp), ...hookArgs(statusHooks), ...modelArgs(model), 'resume', externalSessionId] };
  },

  buildStatusHooks({ serverUrl, terminalId, codexHelperPath }) {
    // Codex `notify` runs a program on turn completion, appending the event JSON
    // as the final argv arg. The helper forwards it to the events route, which
    // marks the thread idle and captures the thread-id on the first turn.
    const url = `${serverUrl}/api/events/codex/${terminalId}`;
    const notify = JSON.stringify(['node', codexHelperPath, url]);
    return { codexArgs: ['-c', `notify=${notify}`] };
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
