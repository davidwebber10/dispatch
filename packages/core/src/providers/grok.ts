import type { SessionProvider } from './types.js';

/**
 * Run Grok fully autonomously. This is Grok's analogue of Claude's
 * `--dangerously-skip-permissions` and Codex's `--dangerously-bypass-approvals-and-sandbox`:
 * a Dispatch thread is an autonomous agent, not an interactive session that should stop to
 * ask. Verified against `grok --help` on Grok 1.0.3 — the permission modes are
 * `default | acceptEdits | auto | dontAsk | bypassPermissions | plan`.
 *
 * Note there is NO `--yolo` flag, despite what several third-party guides claim. The
 * closest documented sibling is `--always-approve` (auto-approve each tool execution);
 * `bypassPermissions` skips the permission layer outright, which is the stronger and more
 * direct match for what the other two providers do.
 */
const FULL_PERMISSIONS = ['--permission-mode', 'bypassPermissions'];

/**
 * Pins the model for a Grok thread. `-m/--model <MODEL>` takes a model id
 * (e.g. `grok-4.5`); omitted → the CLI's configured default. `grok models` prints the
 * list an authenticated install can actually reach.
 */
function modelArgs(model?: string): string[] {
  return model ? ['--model', model] : [];
}

/**
 * xAI's Grok Build CLI (`grok`), installed by `curl -fsSL https://x.ai/cli/install.sh | bash`.
 *
 * Two capabilities the other providers have are deliberately absent here, rather than
 * guessed at:
 *
 * - **No `buildStructuredCommand`.** Grok does have a bidirectional stdio channel
 *   (`grok agent stdio`, speaking ACP), so a "Pretty" transport is possible in principle —
 *   but it needs its own manager translating ACP into the Claude-shaped event stream the
 *   ChatView consumes, exactly as CodexStructuredSessionManager does for the app-server
 *   protocol. That is its own project. Until then Grok threads are CLI (PTY) only, and the
 *   New Thread modal renders Pretty disabled for Grok.
 * - **No `buildStatusHooks` / `captureSessionId`.** Grok exposes no `notify`-style
 *   completion hook, so status falls back to `pty-timing`. Nothing captures an external
 *   session id either, so resume-by-id is not offered for Grok yet — `grok sessions list`
 *   could back that later, but it prints human text with no JSON output flag.
 *
 * Doppler's secrets MCP is not injected: Grok configures MCP through `grok mcp`, not
 * through argv, so there is no per-spawn injection point of the shape SecretsMcpInjection
 * describes.
 */
export const grokProvider: SessionProvider = {
  name: 'grok',
  displayName: 'Grok',
  statusStrategy: 'pty-timing',

  buildNewCommand({ prompt, model }) {
    const args = [...FULL_PERMISSIONS, ...modelArgs(model)];
    // The initial prompt is positional: `grok "fix the bug"`.
    if (prompt) args.push(prompt);
    return { command: 'grok', args };
  },

  buildResumeCommand({ externalSessionId, model }) {
    // `-r/--resume <SESSION_ID_OR_TITLE>` resumes in place. A resumed thread must run as
    // autonomously as a fresh one, so it carries the same permission mode.
    return { command: 'grok', args: [...FULL_PERMISSIONS, ...modelArgs(model), '--resume', externalSessionId] };
  },

  buildRunnerCommand({ prompt }) {
    // `-p/--single <PROMPT>` runs one turn, prints to stdout and EXITS — the process exit
    // is the run-completion signal, mirroring `codex exec`.
    //
    // Output stays `plain` on purpose. Grok's `streaming-json` emits ACP session updates,
    // which RunStreamParser cannot parse (it knows Claude's stream-json and Codex's event
    // JSON). A plain transcript is honest; live step parsing waits for a parser.
    return { command: 'grok', args: [...FULL_PERMISSIONS, '--single', prompt] };
  },
};
