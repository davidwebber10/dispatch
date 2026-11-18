import { claudeMeasurements } from '../analytics/normalize.js';
import { normalizeClaude } from '../status/events.js';
import { DEFAULT_TELEMETRY } from './telemetry.js';
import fs from 'fs';
import path from 'path';
import type { SessionProvider, SecretsMcpInjection, StatusHooksInjection } from './types.js';
import { platform } from '../platform/index.js';
import { autoMemorySettingsArg } from '../overseer/memory-scope.js';
import { appendSystemPromptArgs } from './claude-prompt-file.js';

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
// prompt so the agent just knows it, without touching the user's prompt. A private
// file when the installed Claude supports it (see claude-prompt-file.ts).
function systemPromptArgs(secretsMcp?: SecretsMcpInjection): string[] {
  return appendSystemPromptArgs([secretsMcp?.systemPrompt]);
}

// Pins the model tier for an interactive (PTY) thread. `--model` accepts an alias
// ('fable', 'opus', 'sonnet', 'haiku') or a full model id; omitted → the CLI's
// default model. Mirrors buildStructuredCommand's `--model` handling.
function modelArgs(model?: string): string[] {
  return model ? ['--model', model] : [];
}

// Pins the effort level (low|medium|high|xhigh|max) so a relaunch keeps what `/effort` set in
// the thread. Omitted → the CLI's own per-model default.
function effortArgs(effort?: string): string[] {
  return effort ? ['--effort', effort] : [];
}

/**
 * The watcher's adoption decision, pure for testability. Exactly one transcript born in
 * the window is attributable to our spawn; two or more means another session (usually the
 * user's own `claude` in the same project dir) started concurrently and "newest" proves
 * nothing — adopting it cross-wired a Dispatch thread onto the user's conversation. On
 * 'ambiguous' the caller stops polling entirely (more polling can't disambiguate) and
 * leaves capture to the status-hook path, which reports the id from inside the session.
 */
export function pickBornSession(
  candidates: { name: string; birth: number }[],
  minBirth: number,
): { id: string } | 'ambiguous' | null {
  const born = candidates.filter((c) => c.birth >= minBirth);
  if (born.length === 0) return null;
  if (born.length > 1) return 'ambiguous';
  return { id: born[0].name.replace(/\.jsonl$/, '') };
}

/** How long Dispatch lets an MCP server take to connect when a Claude thread starts. */
export const MCP_STARTUP_TIMEOUT_MS = 30_000;
/** Ten years: effectively forever, and far above the CLI's default of 30. */
export const TRANSCRIPT_RETENTION_DAYS = 3650;

/**
 * What Dispatch sets for every Claude thread it starts, on top of the user's own settings:
 *  - env.MCP_TIMEOUT: a server that never connects waits at most this long (DISPATCH_MCP_TIMEOUT_MS
 *    on the daemon changes it). Dispatch's value wins over the user's settings.json: the user's file is
 *    one value for every use of Claude, while a Dispatch thread has nobody watching it.
 *  - cleanupPeriodDays: long-lived threads keep their transcripts (the CLI's default deletes at 30 days).
 *    Any claude run can do the cleanup, so the daemon also writes this to the user's settings.json at boot
 *    (claude-retention.ts); this copy covers the threads Dispatch starts.
 */
export function dispatchClaudeSettings(env: NodeJS.ProcessEnv = process.env): { env: { MCP_TIMEOUT: string }; cleanupPeriodDays: number } {
  const n = Number(env.DISPATCH_MCP_TIMEOUT_MS);
  return { env: { MCP_TIMEOUT: String(Number.isFinite(n) && n >= 1000 ? Math.floor(n) : MCP_STARTUP_TIMEOUT_MS) }, cleanupPeriodDays: TRANSCRIPT_RETENTION_DAYS };
}

export const claudeCodeProvider: SessionProvider = {
  name: 'claude-code',
  structured: { protocol: 'claude-json' },
  telemetry: { ...DEFAULT_TELEMETRY, normalizeUsage: claudeMeasurements, hookNames: ['claude', 'claude-code'], normalizeHook: normalizeClaude, ptyCapture: 'claude-transcript' },
  displayName: 'Claude Code',
  statusStrategy: 'hooks',

  buildNewCommand({ prompt, secretsMcp, statusHooks, model, effort }) {
    const args: string[] = ['--dangerously-skip-permissions', ...mcpArgs(secretsMcp), ...systemPromptArgs(secretsMcp), ...hookArgs(statusHooks), ...modelArgs(model), ...effortArgs(effort)];
    if (prompt) args.push(prompt);
    return { command: 'claude', args };
  },

  buildResumeCommand({ externalSessionId, secretsMcp, statusHooks, model, effort }) {
    return { command: 'claude', args: ['--dangerously-skip-permissions', ...mcpArgs(secretsMcp), ...systemPromptArgs(secretsMcp), ...hookArgs(statusHooks), ...modelArgs(model), ...effortArgs(effort), '-r', externalSessionId] };
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

  buildStructuredCommand({ workDir, secretsMcp, appendSystemPrompt, resumeSessionId, model, effort, disallowedTools, autoMemoryDirectory, smartApprovals }: { workDir: string; secretsMcp?: SecretsMcpInjection; appendSystemPrompt?: string; resumeSessionId?: string; model?: string; effort?: string; disallowedTools?: string[]; autoMemoryDirectory?: string; /** Smart approvals (os/approvals.ts): auto mode, plus the inline `ask` rules settings when there are rules. */ smartApprovals?: { settings: string | null } }) {
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
      // Smart approvals: Claude's own classifier decides (auto mode); the manager surfaces every
      // can_use_tool that still arrives. Otherwise `default`, answered by the manager's membrane.
      '--permission-mode', smartApprovals ? 'auto' : 'default',
      '--permission-prompt-tool', 'stdio',
      ...mcpArgs(secretsMcp),
      // The secrets/roster note, then the Overseer persona (coordinator / typed agent):
      // one private file when the installed Claude supports it, else two text flags.
      ...appendSystemPromptArgs([secretsMcp?.systemPrompt, appendSystemPrompt]),
    ];
    // Resume an existing claude conversation (revive after a daemon restart). `-r <id>`
    // continues the same session id (no fork), so the thread's external_id stays stable.
    if (resumeSessionId) args.push('-r', resumeSessionId);
    // Pin the model tier for this thread (per-agent-type default or explicit override).
    // Omitted → the CLI's own default model.
    if (model) args.push('--model', model);
    args.push(...effortArgs(effort));
    // Strip tools from the model's toolset entirely (exact-name match; unknown names are
    // ignored by the CLI). Used for coordinator threads, whose native-orchestration tools
    // (Agent/Task/Workflow) are auto-approved by the CLI and thus unreachable by the
    // can_use_tool membrane — see COORDINATOR_DISALLOWED_TOOLS in overseer/coordinator-policy.ts.
    if (disallowedTools?.length) args.push('--disallowedTools', ...disallowedTools);
    // The overseer's own memory folder (overseer memory scope spec 2026-10-07, Unit 1): the
    // session loads only that folder's MEMORY.md, not the project folder that the user's own
    // threads share. Inline JSON settings are additive, like the hooks file of a PTY thread.
    // The smart `ask` rules (os/approvals.ts claudeSmartAskRules): additive inline settings.
    // ONE inline settings object (the CLI may keep only the last --settings flag): Dispatch's own floor
    // (MCP startup timeout, transcript retention) merged with the memory folder and the smart rules.
    // Inline settings outrank the user's settings.json, so the MCP timeout holds even where that file
    // sets it very high (a dead server held a thread for MCP_TIMEOUT=300000, five minutes).
    const inline: Record<string, unknown> = { ...dispatchClaudeSettings() };
    if (autoMemoryDirectory) Object.assign(inline, JSON.parse(autoMemorySettingsArg(autoMemoryDirectory)));
    if (smartApprovals?.settings) Object.assign(inline, JSON.parse(smartApprovals.settings));
    args.push('--settings', JSON.stringify(inline));
    return { command: 'claude', args };
  },

  buildStatusHooks({ serverUrl, terminalId, keyed }) {
    // HTTP hooks POST each lifecycle event's payload to the events route, which
    // normalizes it (status + activity) and captures session_id on the first hit.
    // `*` matchers fire for every tool; the un-matched events fire once each.
    // A keyed thread sends its key from its own environment: Claude expands ${DISPATCH_AUTH} in the
    // header, and only for the variables in allowedEnvVars (verified by the delivery probe). The
    // daemon writes this URL and DISPATCH_API from the same bound address, so the key only ever goes
    // to the daemon's own URL.
    const hook = {
      type: 'http',
      url: `${serverUrl}/api/events/claude/${terminalId}`,
      ...(keyed ? { headers: { Authorization: 'Bearer ${DISPATCH_AUTH}' }, allowedEnvVars: ['DISPATCH_AUTH'] } : {}),
    };
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
          // A turn that dies on an API error fires StopFailure, not Stop. Without it the thread stays "working".
          StopFailure: always,
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
        const pick = pickBornSession(stats, minBirth);
        if (pick === 'ambiguous') return null; // a concurrent session appeared — hooks own capture now
        if (pick) return pick.id;
      } catch {
        // Swallow and retry
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  },
};
