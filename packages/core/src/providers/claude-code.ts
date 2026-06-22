import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SessionProvider, SecretsMcpInjection, StatusHooksInjection } from './types.js';

// Additive --mcp-config (no --strict-mcp-config, so the user's other MCP servers
// still load). Returns [] when Doppler isn't connected.
function mcpArgs(secretsMcp?: SecretsMcpInjection): string[] {
  return secretsMcp?.claudeConfigPath ? ['--mcp-config', secretsMcp.claudeConfigPath] : [];
}

// Layers a generated settings file (lifecycle hooks) on top of the user's own
// settings. `--settings` is additive, so the user's config still applies.
function hookArgs(statusHooks?: StatusHooksInjection): string[] {
  return statusHooks?.claudeSettingsPath ? ['--settings', statusHooks.claudeSettingsPath] : [];
}

export const claudeCodeProvider: SessionProvider = {
  name: 'claude-code',
  displayName: 'Claude Code',
  statusStrategy: 'hooks',

  buildNewCommand({ prompt, secretsMcp, statusHooks }) {
    const args: string[] = ['--dangerously-skip-permissions', ...mcpArgs(secretsMcp), ...hookArgs(statusHooks)];
    if (prompt) args.push(prompt);
    return { command: 'claude', args };
  },

  buildResumeCommand({ externalSessionId, secretsMcp, statusHooks }) {
    return { command: 'claude', args: ['--dangerously-skip-permissions', ...mcpArgs(secretsMcp), ...hookArgs(statusHooks), '-r', externalSessionId] };
  },

  buildRunnerCommand({ prompt, secretsMcp }) {
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
      args: ['--dangerously-skip-permissions', ...mcpArgs(secretsMcp), '--verbose', '--output-format', 'stream-json', '--print', prompt],
    };
  },

  buildStatusHooks({ serverUrl, terminalId }) {
    // HTTP hooks POST each lifecycle event's payload to the events route, which
    // normalizes it (status + activity) and captures session_id on the first hit.
    // `*` matchers fire for every tool; the un-matched events fire once each.
    const hook = { type: 'http', url: `${serverUrl}/api/events/claude/${terminalId}` };
    const always = [{ hooks: [hook] }];
    const everyTool = [{ matcher: '*', hooks: [hook] }];
    return {
      claudeSettings: {
        hooks: {
          SessionStart: always,
          UserPromptSubmit: always,
          PreToolUse: everyTool,
          PostToolUse: everyTool,
          Notification: always,
          Stop: always,
          SessionEnd: always,
        },
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
