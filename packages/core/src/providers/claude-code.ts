import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SessionProvider } from './types.js';

export const claudeCodeProvider: SessionProvider = {
  name: 'claude-code',
  displayName: 'Claude Code',
  statusStrategy: 'hooks',

  buildNewCommand({ prompt }) {
    const args: string[] = ['--dangerously-skip-permissions'];
    if (prompt) args.push(prompt);
    return { command: 'claude', args };
  },

  buildResumeCommand({ externalSessionId }) {
    return { command: 'claude', args: ['--dangerously-skip-permissions', '-r', externalSessionId] };
  },

  buildRunnerCommand({ prompt }) {
    // Headless autonomous run with STRUCTURED output:
    //   --print                       run the agentic loop and EXIT when complete
    //                                 (process-exit is our completion fallback).
    //   --output-format stream-json   emit newline-delimited JSON events (init,
    //                                 assistant text/tool_use/TodoWrite, usage,
    //                                 and a final `result` with cost/tokens) that
    //                                 the RunStreamParser turns into live steps
    //                                 and persisted run telemetry.
    //   --verbose                     required for stream-json with --print.
    //   --dangerously-skip-permissions  run tools without interactive approval.
    // The prompt is passed positionally and submitted at launch.
    return {
      command: 'claude',
      args: ['--dangerously-skip-permissions', '--verbose', '--output-format', 'stream-json', '--print', prompt],
    };
  },

  buildHooksConfig({ serverUrl, sessionId }) {
    const hook = {
      type: 'http',
      url: `${serverUrl}/api/hooks/terminal/${sessionId}`,
    };
    return {
      hooks: {
        Stop: [{ hooks: [hook] }],
        UserPromptSubmit: [{ hooks: [hook] }],
        Notification: [{ matcher: 'permission_prompt|idle_prompt', hooks: [hook] }],
      },
    };
  },

  async captureSessionId({ workDir, spawnTime, deadlineMs }) {
    // Claude Code writes session transcripts to:
    //   ~/.claude/projects/<workdir-with-slashes-replaced-by-dashes>/<uuid>.jsonl
    // The filename (without extension) is the session UUID, so we watch for the
    // first jsonl file created after spawnTime.
    const encoded = workDir.replace(/\//g, '-');
    const projectDir = path.join(os.homedir(), '.claude', 'projects', encoded);
    const deadline = spawnTime + deadlineMs;
    const minBirth = spawnTime - 2000; // small slack for clock skew / fs timing

    while (Date.now() < deadline) {
      try {
        const entries = await fs.promises.readdir(projectDir).catch(() => [] as string[]);
        const jsonls = entries.filter((f) => f.endsWith('.jsonl'));
        const stats = await Promise.all(
          jsonls.map(async (name) => {
            const s = await fs.promises.stat(path.join(projectDir, name));
            return { name, birth: s.birthtimeMs || s.ctimeMs };
          }),
        );
        const newest = stats
          .filter((s) => s.birth >= minBirth)
          .sort((a, b) => b.birth - a.birth)[0];
        if (newest) return newest.name.replace(/\.jsonl$/, '');
      } catch {
        // Swallow and retry
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  },
};
