import type { SessionProvider } from './types.js';

export const codexProvider: SessionProvider = {
  name: 'codex',
  displayName: 'Codex',
  statusStrategy: 'pty-timing',
  buildNewCommand({ prompt }) {
    const args: string[] = [];
    if (prompt) args.push(prompt);
    return { command: 'codex', args };
  },

  buildResumeCommand({ externalSessionId }) {
    return { command: 'codex', args: ['resume', externalSessionId] };
  },

  buildRunnerCommand({ prompt }) {
    // `codex exec` runs non-interactively and EXITS when the task is complete
    // (the process-exit is our run-completion signal).
    //   --dangerously-bypass-approvals-and-sandbox
    //                       run fully autonomously with no approval prompts,
    //                       mirroring Claude's --dangerously-skip-permissions.
    //   --skip-git-repo-check
    //                       allow running in working dirs that aren't git repos.
    // The prompt is passed positionally as the initial instructions.
    return {
      command: 'codex',
      args: ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', prompt],
    };
  },
};
