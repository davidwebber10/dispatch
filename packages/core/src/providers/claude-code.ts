import fs from 'fs';
import path from 'path';
import type { SessionProvider, SecretsMcpInjection, StatusHooksInjection } from './types.js';
import { platform } from '../platform/index.js';

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

// Appends a standing instruction (e.g. "use Doppler for secrets") to the system
// prompt so the agent just knows it, without touching the user's prompt.
function systemPromptArgs(secretsMcp?: SecretsMcpInjection): string[] {
  return secretsMcp?.systemPrompt ? ['--append-system-prompt', secretsMcp.systemPrompt] : [];
}

export const claudeCodeProvider: SessionProvider = {
  name: 'claude-code',
  displayName: 'Claude Code',
  statusStrategy: 'hooks',

  buildNewCommand({ prompt, secretsMcp, statusHooks }) {
    const args: string[] = ['--dangerously-skip-permissions', ...mcpArgs(secretsMcp), ...systemPromptArgs(secretsMcp), ...hookArgs(statusHooks)];
    if (prompt) args.push(prompt);
    return { command: 'claude', args };
  },

  buildResumeCommand({ externalSessionId, secretsMcp, statusHooks }) {
    return { command: 'claude', args: ['--dangerously-skip-permissions', ...mcpArgs(secretsMcp), ...systemPromptArgs(secretsMcp), ...hookArgs(statusHooks), '-r', externalSessionId] };
  },

  // Branch = resume the source session but fork it to a NEW session id (the
  // original transcript is left untouched). `captureSessionId` then records the
  // forked id as this terminal's external_id so future relaunches resume it.
  buildBranchCommand({ sourceSessionId, secretsMcp, statusHooks }) {
    return { command: 'claude', args: ['--dangerously-skip-permissions', ...mcpArgs(secretsMcp), ...systemPromptArgs(secretsMcp), ...hookArgs(statusHooks), '-r', sourceSessionId, '--fork-session'] };
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

  buildStructuredCommand({ workDir, secretsMcp, appendSystemPrompt, resumeSessionId, model }: { workDir: string; secretsMcp?: SecretsMcpInjection; appendSystemPrompt?: string; resumeSessionId?: string; model?: string }) {
    // The spike-verified stream-json control protocol. Parity permissions come from
    // the StructuredSessionManager's auto-allow loop, NOT --dangerously-skip-permissions.
    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      // Emit Anthropic streaming-protocol `stream_event`s (message_start,
      // content_block_start/delta/stop, …) IN ADDITION to the whole
      // assistant/user/result events, so the View can render tokens incrementally.
      '--include-partial-messages',
      '--permission-mode', 'default',
      '--permission-prompt-tool', 'stdio',
      ...mcpArgs(secretsMcp),
      ...systemPromptArgs(secretsMcp),
    ];
    // Overseer persona (coordinator / typed agent) — additive, on top of any
    // secrets system prompt above; --append-system-prompt is repeatable.
    if (appendSystemPrompt) args.push('--append-system-prompt', appendSystemPrompt);
    // Resume an existing claude conversation (revive after a daemon restart). `-r <id>`
    // continues the same session id (no fork), so the thread's external_id stays stable.
    if (resumeSessionId) args.push('-r', resumeSessionId);
    // Pin the model tier for this thread (per-agent-type default or explicit override).
    // Omitted → the CLI's own default model.
    if (model) args.push('--model', model);
    return { command: 'claude', args };
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
    const projectDir = platform.claudeProjectDir(workDir);
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
